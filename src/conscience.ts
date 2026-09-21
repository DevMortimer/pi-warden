/**
 * Conscience module: broad-consideration coach that recommends or loads
 * skills and tools before the agent acts.
 *
 * Pre-measurement: all selections are trace-only. No steers, no auto-loading.
 */
import type { Skill } from "@earendil-works/pi-coding-agent";
import { choice, noul, score } from "pi-typesafe";
import type { Questions } from "pi-typesafe";
import { createHash } from "node:crypto";
import type { ConscienceConfig } from "./config.js";

/* ─── Types ─────────────────────────────────────────────────────────── */

export type Disposition = "advance" | "awaiting_user" | "no_gap" | "unclear";

/** One candidate for assessment: a skill or a tool. */
export interface Candidate {
  /** "skill" or "tool". */
  kind: "skill" | "tool";
  /** Stable id: skill name or tool name. */
  id: string;
  /** Human-readable description (sanitized: no absolute paths or URLs). */
  description: string;
  /** True when this candidate belongs to a category that was truncated (catalog incomplete). */
  incomplete?: boolean;
  /** Full skill metadata, present for kind=skill. */
  skill?: Skill;
}

/** The result of one assessment. */
export interface AssessmentResult {
  /** The disposition chosen by the shared question. */
  disposition: Disposition;
  /** The selected candidate, if any. */
  selected: Candidate | null;
  /** P(useful now) = P(direct_useful) + P(prerequisite). */
  usefulness: number;
  /** P(advance) from the disposition answer. */
  pAdvance: number;
  /** Question hash for deduplication. */
  questionHash: string;
  /** Time spent on this assessment (ms). */
  elapsedMs: number;
  /** Why no selection was made, if applicable. */
  skipReason?: SkipReason | undefined;
  /** Error category when skipReason is "error": timeout, network, configuration, auth, or other. */
  errorCategory?: string | undefined;
  /** Number of judge requests issued for this assessment. */
  requestCount: number;
}

export type SkipReason =
  | "disabled"
  | "no_consent"
  | "no_match"
  | "already_supplied"
  | "awaiting_user"
  | "timeout"
  | "error"
  | "stale"
  | "catalog_unavailable"
  | "catalog_limit"
  | "metadata_unsafe"
  | "budget"
  | "explicit_skill"
  | "origin_unknown"
  | "below_threshold";

/** Score levels for the usefulness question. Levels are ordered from least to most useful. */
export const SCORE_LEVELS = [
  "No useful contribution to the current request, or conflicts with the supplied constraints.",
  "Related to the subject, but already covered, premature, or unable to resolve the current need.",
  "Addresses a concrete unmet need at the current step without displacing the active workflow.",
  "Supplies a missing prerequisite or directly applicable documented method needed for the current step.",
] as const;

/* ─── Envelope limits (spec §3 "Bounded assessment envelope") ──────── */

/** Max eligible entries per category. */
const MAX_ELIGIBLE = 256;
/** Max UTF-8 bytes per candidate description. */
const MAX_DESC_BYTES = 8192;
/** Max questions per single judge request (including the shared disposition question). */
const MAX_QUESTIONS_PER_REQUEST = 32;

/* ─── Path/URL sanitizer (spec §6) ─────────────────────────────────── */

/** Strip absolute paths and URLs from a description to avoid leaking local structure. */
export function sanitizeDescription(text: string): string {
  // Remove absolute paths: /foo/bar, ~/foo, ~user/foo
  let result = text.replace(/(?:^|\s)\/[\w.~\-/]+(?:\s|$)/g, " ");
  result = result.replace(/~\/[\w.~\-/]+/g, "[path]");
  result = result.replace(/~\w+\/[\w.~\-/]+/g, "[path]");
  // Remove URLs: http(s)://... and bare domain.tld/path
  result = result.replace(/https?:\/\/[\w.~\-/]+/g, "[url]");
  return result.trim();
}

/* ─── Opaque ID mapping ─────────────────────────────────────────────── */

/** Opaque IDs: c1, c2, ... in stable order. */
export function opaqueId(index: number): string {
  return `c${index + 1}`;
}

/** Map candidates to opaque IDs, returning a stable ordered list. */
export function assignOpaqueIds(candidates: Candidate[]): Array<{ opaqueId: string; candidate: Candidate }> {
  return candidates.map((c, i) => ({ opaqueId: opaqueId(i), candidate: c }));
}

/* ─── Question builder ──────────────────────────────────────────────── */

/**
 * Build assessment questions for a batch of candidates.
 * State carries structured data; each question names its candidate field.
 * Returns questions, the disposition key, and the opaqueId→candidate map.
 */
export function buildBatchQuestions(
  batch: Array<{ opaqueId: string; candidate: Candidate }>,
  task: string,
  recentContext: string,
  activeSkills: string[],
  suppliedSkills: string[],
): { questions: Questions; dispositionKey: string; idMap: Map<string, Candidate> } {
  const questions: Questions = {};
  const idMap = new Map<string, Candidate>();

  // Shared disposition question
  const dispositionKey = "conscience_disposition";
  questions[dispositionKey] = choice(
    "Disposition of the current request.",
    {
      advance: "A useful next step can be taken now.",
      awaiting_user: "The assistant has already asked for information and must wait.",
      no_gap: "The request is satisfied with no useful missing step.",
      unclear: "Insufficient evidence to determine the next step.",
    },
  );

  // Per-candidate Score questions
  for (const { opaqueId, candidate } of batch) {
    idMap.set(opaqueId, candidate);
    questions[opaqueId] = score(
      `Judge candidates.${opaqueId} against task and context.`,
      [...SCORE_LEVELS],
    );
  }

  return { questions, dispositionKey, idMap };
}

/**
 * Build the full state object for the judge request (spec §3 state contract).
 */
export function buildState(
  task: string,
  recentContext: string,
  activeSkills: string[],
  suppliedSkills: string[],
  batch: Array<{ opaqueId: string; candidate: Candidate }>,
): Record<string, unknown> {
  const candidates: Record<string, unknown> = {};
  for (const { opaqueId, candidate } of batch) {
    candidates[opaqueId] = {
      kind: candidate.kind,
      name: candidate.id,
      description: candidate.description,
    };
  }
  return {
    task: sanitizeDescription(task),
    context: sanitizeDescription(recentContext),
    active_skills: activeSkills,
    supplied_skills: suppliedSkills,
    candidates,
  };
}

/**
 * Compute a deterministic hash of the assessment questions for deduplication.
 * Recursively sorts all object keys for canonical form.
 */
export function questionHash(questions: Questions): string {
  const sorted = JSON.parse(JSON.stringify(questions, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  }));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

/* ─── Candidate eligibility ─────────────────────────────────────────── */

/** Check if a candidate is excluded by the config's exclude list. */
function isExcluded(id: string, exclude: string[]): boolean {
  for (const pattern of exclude) {
    if (pattern === "*") return true;
    if (pattern.endsWith("*") && id.startsWith(pattern.slice(0, -1))) return true;
    if (pattern === id) return true;
  }
  return false;
}

/** Filter candidates by eligibility rules, capped at MAX_ELIGIBLE per category. */
export function eligibleCandidates(
  skills: Skill[],
  tools: { name: string; description: string }[],
  config: ConscienceConfig,
  activeSkills: string[],
  suppliedSkills: string[],
): { candidates: Candidate[]; skillOverflow: boolean; toolOverflow: boolean } {
  const candidates: Candidate[] = [];
  let skillOverflow = false;
  let toolOverflow = false;

  if (config.skills.mode !== "off") {
    let count = 0;
    for (const skill of skills) {
      if (isExcluded(skill.name, config.skills.exclude)) continue;
      // disableModelInvocation skills are never automatic candidates (spec §3 rule 4)
      if (skill.disableModelInvocation) continue;
      // Already supplied: skip
      if (suppliedSkills.includes(skill.name)) continue;
      if (count >= MAX_ELIGIBLE) { skillOverflow = true; break; }
      candidates.push({
        kind: "skill",
        id: skill.name,
        description: sanitizeDescription(skill.description),
        skill,
      });
      count++;
    }
  }

  if (config.tools.enabled) {
    let count = 0;
    for (const tool of tools) {
      if (isExcluded(tool.name, config.tools.exclude)) continue;
      if (count >= MAX_ELIGIBLE) { toolOverflow = true; break; }
      candidates.push({
        kind: "tool",
        id: tool.name,
        description: sanitizeDescription(tool.description),
      });
      count++;
    }
  }

  return { candidates, skillOverflow, toolOverflow };
}

/* ─── Description cap ───────────────────────────────────────────────── */

/** Cap a candidate description to MAX_DESC_BYTES UTF-8. Returns the candidate with overflow flag. */
function capDescription(candidate: Candidate): { candidate: Candidate; overLimit: boolean } {
  const bytes = new TextEncoder().encode(candidate.description).byteLength;
  if (bytes <= MAX_DESC_BYTES) return { candidate, overLimit: false };
  // Truncate by UTF-8 characters, not bytes, to avoid splitting multi-byte chars
  const chars = [...candidate.description];
  let truncated = "";
  let byteCount = 0;
  for (const ch of chars) {
    const chBytes = new TextEncoder().encode(ch).byteLength;
    if (byteCount + chBytes > MAX_DESC_BYTES - 3) break;
    truncated += ch;
    byteCount += chBytes;
  }
  return { candidate: { ...candidate, description: truncated + "..." }, overLimit: true };
}

/* ─── Error classification ──────────────────────────────────────────── */

/** Classify an assessment error into a safe category (spec §6: never exception bodies). */
function classifyError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code);
    if (code === "timeout") return "timeout";
    if (code === "http" || code === "connection" || code === "response" || code === "network") return "network";
    if (code === "configuration" || code === "validation") return "configuration";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out/i.test(msg)) return "timeout";
  if (/auth|key|credential|401|403/i.test(msg)) return "auth";
  if (/network|fetch|connect|ECONNREFUSED|ENOTFOUND/i.test(msg)) return "network";
  return "other";
}

/* ─── Conscience module ─────────────────────────────────────────────── */

export interface Judge {
  evaluate(request: { state: unknown; questions: Questions }, options?: { timeoutMs?: number }): Promise<{ answers: Record<string, unknown> }>;
}

export interface ConscienceDeps {
  judge: Judge | undefined;
  config: ConscienceConfig;
  /** Shared timeout from WardenConfig. The effective deadline is min(conscience.timeoutMs, sharedTimeoutMs). */
  sharedTimeoutMs: number;
  /** Current wall-clock time (ms). Injected for testability. */
  now?: () => number;
}

/**
 * Parse a Choice answer from pi-typesafe.
 * Shape: { choice: string, confidence: number, probabilities: Record<string, number> }
 */
function parseChoiceAnswer(answer: unknown): { label: string; pAdvance: number } | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const a = answer as Record<string, unknown>;
  if (typeof a.choice !== "string") return undefined;
  const probs = a.probabilities as Record<string, number> | undefined;
  return {
    label: a.choice,
    pAdvance: typeof probs?.advance === "number" ? probs.advance : 0,
  };
}

/**
 * Parse a Score answer from pi-typesafe.
 * Shape: { score: number, confidence: number, legend: Record<number, string>, probabilities: Record<number, number> }
 * Probabilities are keyed by numeric index (0, 1, 2, 3).
 */
function parseScoreAnswer(answer: unknown): { level: number; probabilities: number[] } | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const a = answer as Record<string, unknown>;
  if (typeof a.score !== "number") return undefined;
  const probs = a.probabilities as Record<string, number> | undefined;
  if (!probs) return undefined;
  // Build an array of probabilities keyed by index
  const p: number[] = [];
  for (let i = 0; i < SCORE_LEVELS.length; i++) {
    p.push(typeof probs[String(i)] === "number" ? probs[String(i)] as number : 0);
  }
  return { level: Math.round(a.score), probabilities: p };
}

/**
 * Run assessment for the given prompt revision.
 * Pre-measurement: returns trace-only results. No steers, no auto-loading.
 * Issues sequential requests: skills first, then tools in the remaining envelope.
 */
export async function assess(
  prompt: string,
  recentContext: string,
  skills: Skill[],
  tools: { name: string; description: string }[],
  activeSkills: string[],
  suppliedSkills: string[],
  deps: ConscienceDeps,
): Promise<AssessmentResult> {
  const start = deps.now?.() ?? Date.now();
  const { config, judge, sharedTimeoutMs } = deps;

  if (!config.enabled) {
    return { disposition: "no_gap", selected: null, usefulness: 0, pAdvance: 0, questionHash: "", elapsedMs: 0, requestCount: 0, skipReason: "disabled" };
  }
  if (!judge) {
    return { disposition: "no_gap", selected: null, usefulness: 0, pAdvance: 0, questionHash: "", elapsedMs: 0, requestCount: 0, skipReason: "no_consent" };
  }

  const { candidates, skillOverflow, toolOverflow } = eligibleCandidates(skills, tools, config, activeSkills, suppliedSkills);
  if (candidates.length === 0) {
    return { disposition: "no_gap", selected: null, usefulness: 0, pAdvance: 0, questionHash: "", elapsedMs: 0, requestCount: 0, skipReason: "no_match" };
  }

  // Split into skills and tools for sequential assessment
  const skillCandidates = candidates.filter(c => c.kind === "skill");
  const toolCandidates = candidates.filter(c => c.kind === "tool");

  // Cap descriptions
  const cappedSkills = skillCandidates.map(c => capDescription(c));
  const cappedTools = toolCandidates.map(c => capDescription(c));

  const effectiveTimeout = Math.min(config.timeoutMs, sharedTimeoutMs);
  const deadline = start + effectiveTimeout;
  let requestCount = 0;

  // Disposition result (shared across batches)
  let disposition: Disposition = "unclear";
  let pAdvance = 0;
  let hash = "";

  // Track best candidate across batches
  type ScoredCandidate = { candidate: Candidate; usefulness: number; level: number };
  let bestScored: ScoredCandidate | null = null;

  // Process skills first, then tools
  const batches = [
    { items: cappedSkills, overflow: skillOverflow, categoryOverflowReason: "catalog_limit" as const },
    { items: cappedTools, overflow: toolOverflow, categoryOverflowReason: "catalog_limit" as const },
  ];

  // Track if we have a complete skill assessment (for tool catalog to proceed)
  let skillAssessmentComplete = false;

  for (const batch of batches) {
    if (batch.items.length === 0 && !batch.overflow) continue;

    // Pack into requests of at most MAX_QUESTIONS_PER_REQUEST (including disposition)
    const maxCandidatesPerRequest = MAX_QUESTIONS_PER_REQUEST - 1; // -1 for disposition
    const chunks: Array<typeof batch.items> = [];
    for (let i = 0; i < batch.items.length; i += maxCandidatesPerRequest) {
      chunks.push(batch.items.slice(i, i + maxCandidatesPerRequest));
    }

    for (const chunk of chunks) {
      const opaqueBatch = assignOpaqueIds(chunk.map(e => e.candidate));
      const { questions, dispositionKey, idMap } = buildBatchQuestions(
        opaqueBatch, prompt, recentContext, activeSkills, suppliedSkills,
      );
      hash = questionHash(questions);
      const state = buildState(prompt, recentContext, activeSkills, suppliedSkills, opaqueBatch);

      const remaining = deadline - (deps.now?.() ?? Date.now());
      if (remaining <= 0) {
        return { disposition: "unclear", selected: null, usefulness: 0, pAdvance: 0, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, requestCount, skipReason: "timeout" };
      }

      let answers: Record<string, unknown>;
      try {
        const result = await Promise.race([
          judge.evaluate({ state, questions }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), remaining)),
        ]);
        answers = result.answers;
        requestCount++;
      } catch (err) {
        return { disposition: "unclear", selected: null, usefulness: 0, pAdvance: 0, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, requestCount, skipReason: "error", errorCategory: classifyError(err) };
      }

      // Parse disposition (only from first batch that returns it)
      if (disposition === "unclear") {
        const dispRaw = parseChoiceAnswer(answers[dispositionKey]);
        if (dispRaw) {
          disposition = dispRaw.label as Disposition;
          pAdvance = dispRaw.pAdvance;
        }
      }

      // If disposition is not advance, stop assessing
      if (disposition !== "advance") continue;

      // Score each candidate in this chunk
      for (const { opaqueId, candidate } of opaqueBatch) {
        const answer = parseScoreAnswer(answers[opaqueId]);
        if (!answer) continue;

        // P(useful now) = P(level 2: directly_useful) + P(level 3: prerequisite)
        const pUseful = (answer.probabilities[2] ?? 0) + (answer.probabilities[3] ?? 0);

        if (!bestScored || pUseful > bestScored.usefulness ||
            (pUseful === bestScored.usefulness && answer.level > bestScored.level) ||
            (pUseful === bestScored.usefulness && answer.level === bestScored.level &&
             (candidate.kind === "skill" && bestScored.candidate.kind !== "skill" ||
              (candidate.kind === bestScored.candidate.kind && candidate.id < bestScored.candidate.id)))) {
          bestScored = { candidate, usefulness: pUseful, level: answer.level };
        }
      }
    }

    if (batch.items.length > 0 || batch.overflow) {
      skillAssessmentComplete = true;
    }

    // If skills had catalog_limit, do not proceed to tools with partial results
    if (batch.overflow && batch.categoryOverflowReason === "catalog_limit") {
      // Per spec: "if a required batch for a category fails or times out, discard that category's selection"
      // But catalog_limit means the category is incomplete, not failed. Selection may use the other category.
      // Record catalog_limit but continue to tools.
    }
  }

  // Return disposition result
  if (disposition !== "advance") {
    const skipReason: SkipReason | undefined = disposition === "awaiting_user" ? "awaiting_user" : undefined;
    const result: AssessmentResult = { disposition, selected: null, usefulness: 0, pAdvance, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, requestCount };
    if (skipReason) result.skipReason = skipReason;
    return result;
  }

  // No candidate scored
  if (!bestScored) {
    const skipReason: SkipReason = skillOverflow ? "catalog_limit" : "no_match";
    return { disposition, selected: null, usefulness: 0, pAdvance, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, requestCount, skipReason };
  }

  // Threshold gate: both P(useful now) and P(advance) must pass
  const passesUsefulness = bestScored.usefulness >= config.recommendThreshold;
  const passesAdvance = pAdvance >= config.recommendThreshold;
  if (!passesUsefulness || !passesAdvance) {
    return { disposition, selected: null, usefulness: bestScored.usefulness, pAdvance, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, requestCount, skipReason: "below_threshold" };
  }

  // Catalog completeness gate: do not select from an incomplete category
  if (bestScored.candidate.kind === "skill" && skillOverflow) {
    return { disposition, selected: null, usefulness: bestScored.usefulness, pAdvance, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, requestCount, skipReason: "catalog_limit" };
  }

  return {
    disposition,
    selected: bestScored.candidate,
    usefulness: bestScored.usefulness,
    pAdvance,
    questionHash: hash,
    elapsedMs: (deps.now?.() ?? Date.now()) - start,
    requestCount,
  };
}
