/**
 * Conscience load mode: read skill files from disk and supply their text
 * to the model. Spec section 5, rules 1-10.
 */
import { openSync, readSync, closeSync, lstatSync, fstatSync, realpathSync } from "node:fs";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ConscienceConfig } from "./config.js";
import type { PatternHit } from "./guard.js";
import { matchPathRules } from "./guard.js";
import { findSecrets } from "./redact.js";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type LoadSkipReason =
  | "load_denied"
  | "load_too_large"
  | "load_changed"
  | "load_failed"
  | "metadata_unsafe"
  | "already_supplied"
  | "no_policy"
  | "not_eligible"
  | "headroom_unknown";

export interface LoadResult {
  body: string | null;
  skillName: string;
  advertisedPath: string;
  resolvedPath: string;
  relativeRef: string;
  skipReason?: LoadSkipReason;
  bytesLoaded: number;
}

export interface ConsciencePolicy {
  questionHash: string;
  model: string;
  recommendThreshold: number;
  advanceThreshold: number;
  loadThreshold: number;
}

/**
 * Beta policy measured on 2026-09-22 (126 labelled rows + pooled tool precision 74/83): shipped
 * off by default; `conscience.enabled: true` is the one switch. The questionHash pins the question
 * wording — any wording change must re-measure before this constant may ship again.
 */
export const CONSCIENCE_BETA_POLICY: ConsciencePolicy = {
  questionHash: "fb2d35042f667b3c",
  model: "jev-1.13.0",
  recommendThreshold: 0.80,
  advanceThreshold: 0.70,
  loadThreshold: 1.0,
};

// Pi loads an extension through its own transpile cache, so src/load.ts exists as one module
// instance inside the extension and another inside tests; module-level state would split. The
// active policy is therefore parked on globalThis under a registered symbol, which both instances read.
const POLICY_SLOT = Symbol.for("pi-warden.consciencePolicy");
const policySlot = globalThis as typeof globalThis & { [POLICY_SLOT]?: ConsciencePolicy | null };

export function setActivePolicy(policy: ConsciencePolicy | null): void {
  policySlot[POLICY_SLOT] = policy;
}

/** Cache of file identities at candidate selection time (Rule 4 cross-call detection). */
let fileIdentityCache = new Map<string, FileIdentity>();

/** Record a file's lstat identity at selection time (before judge). */
export function recordFileIdentity(skillName: string, filePath: string): void {
  try {
    const st = lstatSync(filePath);
    fileIdentityCache.set(skillName, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, isSymlink: st.isSymbolicLink(), symlinkTarget: undefined });
  } catch {
    fileIdentityCache.delete(skillName);
  }
}

/** Clear the identity cache (called on new prompt). */
export function clearFileIdentityCache(): void {
  fileIdentityCache.clear();
}

export function getActivePolicy(): ConsciencePolicy | null {
  return policySlot[POLICY_SLOT] ?? null;
}

export function policyMatches(questionHash: string, model: string): boolean {
  const activePolicy = getActivePolicy();
  if (!activePolicy) return false;
  return activePolicy.questionHash === questionHash && activePolicy.model === model;
}

/**
 * Rule 3: run the proposed read through matchPathRules on both
 * the advertised and the resolved path.
 */
function checkPathRules(
  skill: Skill,
  resolvedPath: string,
  pathRules: readonly import("./config.js").PathRule[] | undefined,
  exemptRules: string[],
): { blocked: boolean; notice?: string } {
  if (!pathRules || pathRules.length === 0) return { blocked: false };

  const exempt = new Set(exemptRules);
  const hitsAdvertised = matchPathRules("read", { path: skill.filePath }, undefined, pathRules, exempt);
  const hitsResolved = matchPathRules("read", { path: resolvedPath }, undefined, pathRules, exempt);
  const allHits = [...hitsAdvertised, ...hitsResolved];

  for (const hit of allHits) {
    if (hit.severity === "deny" || hit.severity === "destructive") {
      return { blocked: true };
    }
  }

  const noticeHits = allHits.filter(h => h.severity === "sensitive" || h.severity === "risky");
  if (noticeHits.length > 0) {
    return { blocked: false, notice: noticeHits.map(h => h.label).join("; ") };
  }

  return { blocked: false };
}

/**
 * Rule 4: atomic file identity across the read.
 * lstat the path, open the fd, fstat the fd, compare device/inode/size/mtime.
 * After read, fstat again and compare. Symlink is fine when target is unchanged.
 */
interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isSymlink: boolean;
  symlinkTarget: string | undefined;
}

function captureIdentity(path: string): FileIdentity | null {
  try {
    const st = lstatSync(path);
    const isSymlink = st.isSymbolicLink();
    let symlinkTarget: string | undefined;
    if (isSymlink) {
      try { symlinkTarget = realpathSync(path); } catch { return null; }
    }
    // Use the resolved file's stat for comparison
    const fst = isSymlink ? fstatSync(openSync(path, "r")) : st;
    return { dev: fst.dev, ino: fst.ino, size: fst.size, mtimeMs: fst.mtimeMs, isSymlink, symlinkTarget };
  } catch {
    return null;
  }
}

function identitiesMatch(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Rule 7: credential and safety check.
 */
function checkBodySafety(body: string): { safe: boolean; reason?: string } {
  const secrets = findSecrets(body);
  if (secrets.length > 0) return { safe: false, reason: "credentials detected" };
  const pathMatch = body.match(/(?:^|\s)\/[\w.~\-/]+(?:\s|$)/);
  if (pathMatch) return { safe: false, reason: "absolute path in body" };
  return { safe: true };
}

/**
 * Rule 9: context-window headroom.
 * Load only when body bytes fit under 80% of the model window.
 * If window is unknown or images present, recommend instead.
 */
function checkHeadroom(
  bodyBytes: number,
  contextWindow: number | null,
  hasImages: boolean,
): { ok: boolean; reason?: string } {
  if (contextWindow === null || contextWindow <= 0 || hasImages) {
    return { ok: false, reason: "headroom_unknown" };
  }
  // Conservative: 1 token ≈ 4 bytes, reserve 20%
  const availableBytes = Math.floor(contextWindow * 4 * 0.8);
  if (bodyBytes > availableBytes) {
    return { ok: false, reason: "load_too_large" };
  }
  return { ok: true };
}

/**
 * Rules 1-10: load a skill body from disk.
 */
export function loadSkillBody(
  skill: Skill,
  config: ConscienceConfig,
  opts: {
    pathRules?: readonly import("./config.js").PathRule[];
    exemptRules: string[];
    loadedBytes: number;
    remainingMs: number;
    consentGiven: boolean;
    projectTrusted: boolean;
    catalogName: string;
    catalogDescription: string;
    userInvoked: boolean;
    /** From ctx.getContextUsage()?.contextWindow, or null if unknown. */
    contextWindow: number | null;
    /** Whether images are in the current context. */
    hasImages: boolean;
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

  // Rule 5: size bounds
  const remainingBytes = config.maxLoadedBytes - opts.loadedBytes;
  if (remainingBytes <= 0) return { ...base, body: null, skipReason: "load_too_large", bytesLoaded: 0 };
  const effectiveMax = Math.min(config.maxSkillBytes, remainingBytes);

  if (opts.remainingMs <= 0) return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };

  // Rule 4: cross-call identity check (file replaced between selection and load)
  // Uses lstat metadata (not realpath-resolved) so symlink retargeting is not detected.
  const cachedIdentity = fileIdentityCache.get(skill.name);
  if (cachedIdentity) {
    try {
      const currentStat = lstatSync(skill.filePath);
      // Skip detection when both are symlinks (retargeting is detected by within-call checks)
      const bothSymlinks = cachedIdentity.isSymlink && currentStat.isSymbolicLink();
      if (!bothSymlinks && (
        currentStat.dev !== cachedIdentity.dev || currentStat.ino !== cachedIdentity.ino ||
        currentStat.size !== cachedIdentity.size || currentStat.mtimeMs !== cachedIdentity.mtimeMs
      )) {
        fileIdentityCache.delete(skill.name);
        return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
      }
    } catch {
      return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };
    }
  }
  // Rule 4: capture pre-open identity
  const preIdentity = captureIdentity(skill.filePath);
  if (!preIdentity) return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };

  // Open the file descriptor
  let fd: number;
  try {
    fd = openSync(skill.filePath, "r");
  } catch {
    return { ...base, body: null, skipReason: "load_failed", bytesLoaded: 0 };
  }

  try {
    // Rule 4: fstat the fd and compare with pre-open identity
    const fdStat = fstatSync(fd);
    const fdIdentity: FileIdentity = {
      dev: fdStat.dev, ino: fdStat.ino, size: fdStat.size, mtimeMs: fdStat.mtimeMs,
      isSymlink: preIdentity.isSymlink, symlinkTarget: preIdentity.symlinkTarget,
    };
    if (!identitiesMatch(preIdentity, fdIdentity)) {
      return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
    }

    // Rule 5: bounded read
    const buf = Buffer.alloc(effectiveMax);
    const bytesRead = readSync(fd, buf, 0, effectiveMax, 0);
    if (bytesRead >= effectiveMax) {
      return { ...base, body: null, skipReason: "load_too_large", bytesLoaded: 0 };
    }

    // Rule 4: post-read fstat and compare
    const postStat = fstatSync(fd);
    if (postStat.size !== fdStat.size || postStat.mtimeMs !== fdStat.mtimeMs) {
      return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
    }

    const raw = buf.toString("utf-8", 0, bytesRead);

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

    // Rule 6 continued: invalidate on metadata change
    if (parsedName && parsedName !== opts.catalogName) return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
    if (parsedDescription && parsedDescription !== opts.catalogDescription) return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };
    if (parsedUserOnly === true && !skill.disableModelInvocation) return { ...base, body: null, skipReason: "load_changed", bytesLoaded: 0 };

    // Rule 7: credential and safety check
    const safety = checkBodySafety(body);
    if (!safety.safe) return { ...base, body: null, skipReason: "metadata_unsafe", bytesLoaded: 0 };

    // Rule 9: context-window headroom
    const headroom = checkHeadroom(new TextEncoder().encode(body).byteLength, opts.contextWindow, opts.hasImages);
    if (!headroom.ok) return { ...base, body: null, skipReason: headroom.reason as LoadSkipReason, bytesLoaded: 0 };

    const bytesLoaded = new TextEncoder().encode(body).byteLength;
    // Record lstat identity for future cross-call detection (uses fd stat for consistency)
    try {
      const st = lstatSync(skill.filePath);
      fileIdentityCache.set(skill.name, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, isSymlink: st.isSymbolicLink(), symlinkTarget: undefined });
    } catch { fileIdentityCache.delete(skill.name); }
    return { ...base, body, bytesLoaded };
  } finally {
    closeSync(fd);
  }
}

/**
 * Rule 8: build the custom message with complete body, identity, and relative-reference.
 */
export function buildLoadMessage(result: LoadResult): string {
  return `Skill: ${result.skillName}\n\n${result.body}\n\n${result.relativeRef}`;
}
