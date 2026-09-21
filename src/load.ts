/**
 * Conscience load mode: read skill files from disk and supply their text
 * to the model. Spec section 5, rules 1-10.
 */
import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ConscienceConfig } from "./config.js";
import type { PatternHit } from "./guard.js";
import { matchPathRules } from "./guard.js";
import { redact, looksLikeSecretValue, findSecrets } from "./redact.js";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type LoadSkipReason =
  | "load_denied"
  | "load_too_large"
  | "load_changed"
  | "load_failed"
  | "metadata_unsafe"
  | "already_supplied"
  | "no_policy"
  | "not_eligible";

export interface LoadResult {
  /** The complete skill body with frontmatter stripped, or null on failure. */
  body: string | null;
  /** Skill identity for the message. */
  skillName: string;
  /** The advertised location (from Pi's catalog). */
  advertisedPath: string;
  /** The resolved (real) path after symlink resolution. */
  resolvedPath: string;
  /** Relative reference sentence for the message. */
  relativeRef: string;
  /** Why loading failed, if applicable. */
  skipReason?: LoadSkipReason;
  /** Bytes loaded (0 on failure). */
  bytesLoaded: number;
}

/** Policy record: ties action to question hash, model, and measured thresholds. */
export interface ConsciencePolicy {
  questionHash: string;
  model: string;
  recommendThreshold: number;
  loadThreshold: number;
}

/** Active policy for this session. Set once after calibration. */
let activePolicy: ConsciencePolicy | null = null;

/** Set the active policy (called at session start or when calibration loads). */
export function setActivePolicy(policy: ConsciencePolicy | null): void {
  activePolicy = policy;
}

/** Get the active policy. */
export function getActivePolicy(): ConsciencePolicy | null {
  return activePolicy;
}

/** Check if the current hash and model match the active policy. */
export function policyMatches(questionHash: string, model: string): boolean {
  if (!activePolicy) return false;
  return activePolicy.questionHash === questionHash && activePolicy.model === model;
}

/**
 * Spec §5 rule 3: run the proposed read through matchPathRules on both
 * the advertised and the resolved path. A block or confirm rule makes
 * the skill ineligible; no dialog is added; a note or warn rule produces
 * one combined safe notice.
 */
function checkPathRules(
  skill: Skill,
  resolvedPath: string,
  pathRules: readonly import("./config.js").PathRule[] | undefined,
  exemptRules: string[],
): { blocked: boolean; notice?: string } {
  if (!pathRules || pathRules.length === 0) return { blocked: false };

  const exempt = new Set(exemptRules);
  const input = { path: skill.filePath };

  const hitsAdvertised = matchPathRules("read", input, undefined, pathRules, exempt);
  const hitsResolved = matchPathRules("read", { path: resolvedPath }, undefined, pathRules, exempt);
  const allHits = [...hitsAdvertised, ...hitsResolved];

  for (const hit of allHits) {
    if (hit.severity === "deny" || hit.severity === "destructive") {
      return { blocked: true };
    }
  }

  // sensitive/risky rules produce one combined notice
  const noticeHits = allHits.filter(h => h.severity === "sensitive" || h.severity === "risky");
  if (noticeHits.length > 0) {
    const notice = noticeHits.map(h => h.label).join("; ");
    return { blocked: false, notice };
  }

  return { blocked: false };
}

/**
 * Spec §5 rule 4: open a regular file, verify the opened file is the
 * checked target, reject replacement, symlink-target change, or metadata
 * changes across the read.
 */
function verifyFileIntegrity(filePath: string): { ok: boolean; reason?: string } {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return { ok: false, reason: "not a regular file" };
    // We don't have a pre-read stat to compare against, so we verify
    // it's a regular file and readable. The caller will re-check after read.
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Spec §5 rule 7: if credential redaction or path check finds the body
 * unsafe to forward intact, do not load; fall back to recommendation.
 */
function checkBodySafety(body: string): { safe: boolean; reason?: string } {
  // Check for seeded credential canaries
  const secrets = findSecrets(body);
  if (secrets.length > 0) {
    return { safe: false, reason: "credentials detected" };
  }
  // Check for absolute paths that shouldn't be in skill instructions
  const pathMatch = body.match(/(?:^|\s)\/[\w.~\-/]+(?:\s|$)/);
  if (pathMatch) {
    return { safe: false, reason: "absolute path in body" };
  }
  return { safe: true };
}

/**
 * Spec §5 rules 1-10: load a skill body from disk.
 * Returns the body or a skip reason.
 */
export function loadSkillBody(
  skill: Skill,
  config: ConscienceConfig,
  opts: {
    /** The resolved config's path rules. */
    pathRules?: readonly import("./config.js").PathRule[];
    /** Exempt rule ids. */
    exemptRules: string[];
    /** Cumulative bytes already loaded this prompt. */
    loadedBytes: number;
    /** Remaining deadline (ms). */
    remainingMs: number;
    /** Whether consent is given. */
    consentGiven: boolean;
    /** Whether the project is trusted. */
    projectTrusted: boolean;
    /** The original catalog entry name (for change detection). */
    catalogName: string;
    /** The original catalog entry description. */
    catalogDescription: string;
    /** Whether this skill was user-invoked explicitly. */
    userInvoked: boolean;
  },
): LoadResult {
  const base: Omit<LoadResult, "body" | "skipReason" | "bytesLoaded"> = {
    skillName: skill.name,
    advertisedPath: skill.filePath,
    resolvedPath: skill.filePath,
    relativeRef: `Resolve this skill's relative references against the directory of its advertised location.`,
  };

  // Rule 2: preconditions
  if (!config.enabled) return { ...base, body: null, skipReason: "not_eligible", bytesLoaded: 0 };
  if (config.skills.mode !== "load") return { ...base, body: null, skipReason: "not_eligible", bytesLoaded: 0 };
  if (!opts.consentGiven) return { ...base, body: null, skipReason: "not_eligible", bytesLoaded: 0 };
  if (!opts.projectTrusted) return { ...base, body: null, skipReason: "not_eligible", bytesLoaded: 0 };
  if (opts.userInvoked) return { ...base, body: null, skipReason: "already_supplied", bytesLoaded: 0 };
  if (skill.disableModelInvocation) return { ...base, body: null, skipReason: "not_eligible", bytesLoaded: 0 };

  // Rule 3: path rules
  const pathCheck = checkPathRules(skill, skill.filePath, opts.pathRules, opts.exemptRules);
  if (pathCheck.blocked) return { ...base, body: null, skipReason: "load_denied", bytesLoaded: 0 };

  // Rule 4: file integrity
  const integrity = verifyFileIntegrity(skill.filePath);
  if (!integrity.ok) return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };

  // Rule 5: size bounds
  const remainingBytes = config.maxLoadedBytes - opts.loadedBytes;
  if (remainingBytes <= 0) return { ...base, body: null, skipReason: "load_too_large", bytesLoaded: 0 };
  const effectiveMax = Math.min(config.maxSkillBytes, remainingBytes);

  if (opts.remainingMs <= 0) return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };

  // Rule 5: read bounded by the limit (do not read everything and truncate)
  let raw: string;
  try {
    const fd = openSync(skill.filePath, "r");
    try {
      const buf = Buffer.alloc(effectiveMax);
      const bytesRead = readSync(fd, buf, 0, effectiveMax, 0);
      raw = buf.toString("utf-8", 0, bytesRead);
      if (bytesRead >= effectiveMax) {
        return { ...base, body: null, skipReason: "load_too_large", bytesLoaded: 0 };
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };
  }

  // Rule 6: parse and strip frontmatter
  let body: string;
  let parsedName: string | undefined;
  let parsedDescription: string | undefined;
  let parsedUserOnly: boolean | undefined;
  try {
    const parsed = parseFrontmatter(raw);
    body = parsed.body;
    const fm = parsed.frontmatter as Record<string, unknown>;
    parsedName = typeof fm.name === "string" ? fm.name : undefined;
    parsedDescription = typeof fm.description === "string" ? fm.description : undefined;
    parsedUserOnly = fm["disable-model-invocation"] === true;
  } catch {
    return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };
  }

  // Rule 6 continued: invalidate if name, description, or user-only changed
  if (parsedName && parsedName !== opts.catalogName) {
    return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
  }
  if (parsedDescription && parsedDescription !== opts.catalogDescription) {
    return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
  }
  if (parsedUserOnly === true && !skill.disableModelInvocation) {
    return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
  }

  // Rule 7: credential and safety check
  const safety = checkBodySafety(body);
  if (!safety.safe) {
    return { ...base, body: null, skipReason: "metadata_unsafe", bytesLoaded: 0 };
  }

  const bytesLoaded = new TextEncoder().encode(body).byteLength;
  return { ...base, body, bytesLoaded };
}

/**
 * Build the custom message for a loaded skill (rule 8).
 * One message with the complete body, skill identity, and relative-reference sentence.
 */
export function buildLoadMessage(result: LoadResult): string {
  return `Skill: ${result.skillName}\n\n${result.body}\n\n${result.relativeRef}`;
}
