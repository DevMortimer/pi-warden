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
import type { JudgmentsOffReason } from "./backend.js";
import type { ConscienceConfig } from "./config.js";
import { redact } from "./redact.js";
import { SPINE_GOAL_LIMIT, SPINE_HISTORY_LIMIT, SPINE_HISTORY_TURNS } from "./shape.js";
import type { TaskSpine } from "./shape.js";
import { fileContentHash, toolSourceHash } from "./hashing.js";

/* ─── Types ─────────────────────────────────────────────────────────── */

export type Disposition = "advance" | "awaiting_user" | "no_gap" | "unclear";

/** Capability roles the session model assigns to index entries. */
export type CapabilityRole = "research" | "evidence" | "execution" | "delegation" | "review" | "conversation";

/** Minimal index entry shape used by the conscience; full validation lives in index-cmd. */
export interface IndexEntry {
  kind: "skill" | "tool";
  name: string;
  scope: "global" | "project";
  sourceHash: string;
  role: CapabilityRole;
  lead: string;
  useWhen: string[];
  notWhen: string[];
  inputs: string;
  examples: string[];
  thin: boolean;
  truncated?: boolean;
  _location?: string;
}

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
  /** Capability role, present when the candidate has an index entry. */
  role?: CapabilityRole;
  /** Index entry when the candidate has a matching entry; bare description is the fallback. */
  indexEntry?: IndexEntry;
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
  | "no_key"
  | "key_rejected"
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

/** Strip absolute paths, URLs, and credentials from a description. */
export function sanitizeDescription(text: string): string {
  // Remove credentials: tokens, keys, secrets
  let result = text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[credential]");
  result = result.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[credential]");
  result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[credential]");
  result = result.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[credential]");
  result = result.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[credential]");
  result = result.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[credential]");
  result = result.replace(/(?:TOKEN|SECRET|KEY|PASSWORD)\s*[=:]\s*['"]?[\w\-./]{8,}/gi, "[credential]");
  // Remove absolute paths: /foo/bar, ~/foo, ~user/foo
  result = result.replace(/(?:^|\s)\/[\w.~\-/]+(?:\s|$)/g, " ");
  result = result.replace(/~\/[\w.~\-/]+/g, "[path]");
  result = result.replace(/~\w+\/[\w.~\-/]+/g, "[path]");
  // Remove URLs
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
    `Disposition of the current request. A message that reports status, shares context, or narrates what the user is doing elsewhere, without asking the agent to do anything, is no_gap; select nothing on it.`,
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
      `Judge candidates.${opaqueId} against what the user is asking the agent to do now in task, not against the subjects the prompt mentions in passing; a candidate that matches words in the prompt but does not serve the actual request belongs at the lowest level. When the request needs information the repository cannot supply, a research-role candidate serves the request; when the request is about the repository's own code or behaviour, an evidence-role candidate does.`,
      [...SCORE_LEVELS],
    );
  }

  return { questions, dispositionKey, idMap };
}

/**
 * Build the full state object for the judge request (spec §3 state contract).
 * `spine`, when given, carries the task spine — the thread's goal and earlier user turns — beside `task`;
 * scope context only, it never authorizes anything and it is not part of any question.
 */
export function buildState(
  task: string,
  recentContext: string,
  activeSkills: string[],
  suppliedSkills: string[],
  batch: Array<{ opaqueId: string; candidate: Candidate }>,
  spine?: TaskSpine | undefined,
): Record<string, unknown> {
  const candidates: Record<string, unknown> = {};
  for (const { opaqueId, candidate } of batch) {
    const entry = candidate.indexEntry;
    candidates[opaqueId] = entry
      ? { kind: candidate.kind, name: candidate.id, lead: entry.lead, useWhen: entry.useWhen, examples: entry.examples }
      : { kind: candidate.kind, name: candidate.id, description: candidate.description, unindexed: true };
  }
  return {
    task: sanitizeDescription(redact(task)),
    context: sanitizeDescription(redact(recentContext)),
    // The spine's `task` is deliberately not repeated here: the `task` field above already carries it.
    // Same per-field limits as the action request, for a spine built outside taskSpine.
    ...(spine ? { spine: {
      goal: sanitizeDescription(redact(spine.goal)).slice(0, SPINE_GOAL_LIMIT),
      task_history: spine.history.slice(0, SPINE_HISTORY_TURNS).map(turn => sanitizeDescription(redact(turn)).slice(0, SPINE_HISTORY_LIMIT)),
    } } : {}),
    active_skills: activeSkills,
    supplied_skills: suppliedSkills,
    candidates,
  };
}

/**
 * Compute a deterministic hash of the assessment questions for deduplication.
 * Recursively sorts all object keys for canonical form.
 *
 * Opaque candidate ids (c1, c2, …) are positional, not semantic: which batch a prompt happens to
 * produce must not change the hash the activation gate compares. A conscience question set
 * (recognised by the `conscience_disposition` key) is therefore hashed as the disposition question
 * plus one canonical candidate question, keyed `c1` — every candidate question carries the same
 * wording by design (per-candidate state lives in the request state, not the question text), so any
 * one of them is the canonical representative.
 *
 * Why the hash was constant before this change: each assessment issues several requests (one per
 * batch), each with its own question keys, and `assess` kept only the hash of whichever batch wrote
 * `state_.hash` last. Every recorded replay row showed `fb2d35042f667b3c` only because those final
 * batches happened to serialize identically — an accident of batch order, not a guarantee.
 */
export function questionHash(questions: Questions): string {
  if ((questions as Record<string, unknown>).conscience_disposition) {
    const firstCandidate = Object.entries(questions).find(([key]) => /^c\d+$/.test(key));
    questions = {
      conscience_disposition: questions.conscience_disposition,
      ...(firstCandidate ? { [firstCandidate[0]]: firstCandidate[1] } : {}),
    } as Questions;
  }
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

/**
 * Name parts that mark a tool as destructive. A recommendation to run such a tool is never worth the risk
 * of the agent calling it on a prompt that only mentioned the subject.
 */
const DESTRUCTIVE_MARKERS = new Set(["delete", "drop", "destroy", "remove", "purge", "wipe", "reset", "truncate"]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * True when a marker is a whole word or `_`-separated part of the name, or the first word of the description.
 * Only the leading verb of a description counts: a description that mentions removal in passing
 * ("edit files; remove text") does not make a tool destructive.
 */
export function isDestructiveTool(name: string, ...descriptions: Array<string | undefined>): boolean {
  if (words(name).some(w => DESTRUCTIVE_MARKERS.has(w))) return true;
  return descriptions.some(d => d !== undefined && DESTRUCTIVE_MARKERS.has(words(d)[0] ?? ""));
}

/**
 * Tools that only run on one platform. A recommendation to use one elsewhere costs the agent a turn to find out
 * it is missing, and it then answers about the tool instead of the task.
 */
export const PLATFORM_BOUND_TOOLS: Readonly<Record<string, NodeJS.Platform>> = {
  powershell: "win32",
  pwsh: "win32",
  cmd: "win32",
};

const PLATFORM_ONLY_DESCRIPTIONS: Array<{ platform: NodeJS.Platform; pattern: RegExp }> = [
  { platform: "win32", pattern: /\bwindows[- ]only\b|\bonly (?:on|for) windows\b/i },
  { platform: "darwin", pattern: /\b(?:macos|mac os|os x)[- ]only\b|\bonly (?:on|for) (?:macos|mac os|os x)\b/i },
];

/** True when the tool name or a description binds the tool to a platform other than `platform`. */
export function isPlatformIneligibleTool(
  name: string,
  platform: NodeJS.Platform,
  ...descriptions: Array<string | undefined>
): boolean {
  const bound = PLATFORM_BOUND_TOOLS[name.toLowerCase()];
  if (bound !== undefined && bound !== platform) return true;
  return PLATFORM_ONLY_DESCRIPTIONS.some(({ platform: only, pattern }) =>
    only !== platform && descriptions.some(d => d !== undefined && pattern.test(d)));
}

/** Filter candidates by eligibility rules, capped at MAX_ELIGIBLE per category. Attaches index entries when available. */
export function eligibleCandidates(
  skills: Skill[],
  tools: { name: string; description: string }[],
  config: ConscienceConfig,
  activeSkills: string[],
  suppliedSkills: string[],
  globalIndex?: { entries: IndexEntry[] } | undefined,
  projectIndex?: { entries: IndexEntry[] } | undefined,
  platform: NodeJS.Platform = process.platform,
): { candidates: Candidate[]; skillOverflow: boolean; toolOverflow: boolean } {
  const candidates: Candidate[] = [];
  let skillOverflow = false;
  let toolOverflow = false;

  const findEntry = (name: string, sourceHash: string): IndexEntry | undefined => {
    const search = (index: { entries: IndexEntry[] } | undefined): IndexEntry | undefined => {
      if (!index) return undefined;
      return index.entries.find(e => e.name === name && e.sourceHash === sourceHash);
    };
    return search(projectIndex) ?? search(globalIndex);
  };

  if (config.skills.mode !== "off") {
    let count = 0;
    for (const skill of skills) {
      if (isExcluded(skill.name, config.skills.exclude)) continue;
      // disableModelInvocation skills are never automatic candidates (spec §3 rule 4)
      if (skill.disableModelInvocation) continue;
      // Already supplied: skip
      if (suppliedSkills.includes(skill.name)) continue;
      if (count >= MAX_ELIGIBLE) { skillOverflow = true; break; }
      const sourceHash = skill.filePath ? fileContentHash(skill.filePath) : "missing";
      const entry = findEntry(skill.name, sourceHash);
      candidates.push({
        kind: "skill",
        id: skill.name,
        description: sanitizeDescription(skill.description),
        skill,
        ...(entry ? { role: entry.role, indexEntry: entry } : {}),
      });
      count++;
    }
  }

  if (config.tools.enabled) {
    let count = 0;
    for (const tool of tools) {
      if (isExcluded(tool.name, config.tools.exclude)) continue;
      // Core tools the agent uses on nearly every turn: a recommendation to use one tells it nothing new.
      if (config.skipTools.includes(tool.name)) continue;
      const sourceHash = toolSourceHash(tool.name, tool.description);
      const entry = findEntry(tool.name, sourceHash);
      if (isDestructiveTool(tool.name, tool.description, entry?.lead)) continue;
      if (isPlatformIneligibleTool(tool.name, platform, tool.description, entry?.lead)) continue;
      if (count >= MAX_ELIGIBLE) { toolOverflow = true; break; }
      candidates.push({
        kind: "tool",
        id: tool.name,
        description: sanitizeDescription(tool.description),
        ...(entry ? { role: entry.role, indexEntry: entry } : {}),
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
  /** Why `judge` is undefined, as the extension computed it; the skip reason. `no_consent` when not given. */
  judgmentsOff?: JudgmentsOffReason | undefined;
  config: ConscienceConfig;
  /** Shared timeout from WardenConfig. The effective deadline is min(conscience.timeoutMs, sharedTimeoutMs). */
  sharedTimeoutMs: number;
  /** Current wall-clock time (ms). Injected for testability. */
  now?: () => number;
  /** Pre-loaded global index, if any. */
  globalIndex?: { entries: IndexEntry[] } | undefined;
  /** Pre-loaded project index, if any. */
  projectIndex?: { entries: IndexEntry[] } | undefined;
  /** Platform the agent's tools run on. Injected for testability; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
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
 * Issues concurrent requests (up to four in flight), skills first, shared deadline.
 */
export async function assess(
  prompt: string,
  recentContext: string,
  skills: Skill[],
  tools: { name: string; description: string }[],
  activeSkills: string[],
  suppliedSkills: string[],
  deps: ConscienceDeps,
  spine?: TaskSpine | undefined,
): Promise<AssessmentResult> {
  const start = deps.now?.() ?? Date.now();
  const { config, judge, sharedTimeoutMs } = deps;

  if (!config.enabled) {
    return { disposition: "no_gap", selected: null, usefulness: 0, pAdvance: 0, questionHash: "", elapsedMs: 0, requestCount: 0, skipReason: "disabled" };
  }
  if (!judge) {
    return { disposition: "no_gap", selected: null, usefulness: 0, pAdvance: 0, questionHash: "", elapsedMs: 0, requestCount: 0, skipReason: deps.judgmentsOff ?? "no_consent" };
  }

  const { candidates, skillOverflow, toolOverflow } = eligibleCandidates(skills, tools, config, activeSkills, suppliedSkills, deps.globalIndex, deps.projectIndex, deps.platform);
  if (candidates.length === 0) {
    return { disposition: "no_gap", selected: null, usefulness: 0, pAdvance: 0, questionHash: "", elapsedMs: 0, requestCount: 0, skipReason: "no_match" };
  }

  const effectiveTimeout = Math.min(config.timeoutMs, sharedTimeoutMs);
  const deadline = start + effectiveTimeout;

  const MAX_IN_FLIGHT = 4;

  // Skill chunks are built first so the semaphore fills with skill requests before
  // any tool request gets a slot — a slow tool batch cannot starve the skill result.
  type Category = "skill" | "tool";
  interface ChunkWork {
    category: Category;
    items: Array<{ candidate: Candidate; capped: { candidate: Candidate; overLimit: boolean } }>;
    overflow: boolean;
  }
  const categoryMeta: Array<{ category: Category; overflow: boolean }> = [
    { category: "skill", overflow: skillOverflow },
    { category: "tool", overflow: toolOverflow },
  ];
  const cappedByCategory: Record<Category, Array<{ candidate: Candidate; capped: { candidate: Candidate; overLimit: boolean } }>> = {
    skill: candidates.filter(c => c.kind === "skill").map(c => ({ candidate: c, capped: capDescription(c) })),
    tool: candidates.filter(c => c.kind === "tool").map(c => ({ candidate: c, capped: capDescription(c) })),
  };
  const maxCandidatesPerRequest = MAX_QUESTIONS_PER_REQUEST - 1; // -1 for disposition
  const workQueue: ChunkWork[] = [];
  for (const meta of categoryMeta) {
    const items = cappedByCategory[meta.category];
    if (items.length === 0 && !meta.overflow) continue;
    for (let i = 0; i < items.length; i += maxCandidatesPerRequest) {
      workQueue.push({ category: meta.category, items: items.slice(i, i + maxCandidatesPerRequest), overflow: false });
    }
    if (items.length === 0 && meta.overflow) {
      workQueue.push({ category: meta.category, items: [], overflow: true });
    }
  }

  // Per-category tracking: a category whose every batch fails or times out is discarded.
  const categoryCompleted: Record<Category, boolean> = { skill: false, tool: false };
  const categoryFailed: Record<Category, boolean> = { skill: false, tool: false };
  const judgeError: { value: { message: string; category: string } | null } = { value: null };

  type ScoredCandidate = { candidate: Candidate; usefulness: number; level: number };
  const state_ = { disposition: "unclear" as Disposition, pAdvance: 0, hash: "", requestCount: 0, bestScored: null as ScoredCandidate | null };

  // Execute chunks with at most MAX_IN_FLIGHT concurrent judge calls.
  // Each chunk races its own evaluate against the shared deadline.
  // A settled chunk (success or error) frees its slot for the next waiting chunk.
  let nextIdx = 0;
  const inFlight: Promise<void>[] = [];

  function launchNext(): void {
    while (inFlight.length < MAX_IN_FLIGHT && nextIdx < workQueue.length) {
      const work = workQueue[nextIdx]!;
      nextIdx++;
      const p = runChunk(work).finally(() => {
        const pos = inFlight.indexOf(p);
        if (pos !== -1) inFlight.splice(pos, 1);
        launchNext();
      });
      inFlight.push(p);
    }
  }

  async function runChunk(work: ChunkWork): Promise<void> {
    if (work.items.length === 0) {
      if (work.overflow) categoryCompleted[work.category] = true;
      return;
    }

    const opaqueBatch = assignOpaqueIds(work.items.map(e => e.capped.candidate));
    const { questions, dispositionKey } = buildBatchQuestions(
      opaqueBatch, prompt, recentContext, activeSkills, suppliedSkills,
    );
    state_.hash = questionHash(questions);
    const state = buildState(prompt, recentContext, activeSkills, suppliedSkills, opaqueBatch, spine);

    const remaining = deadline - (deps.now?.() ?? Date.now());
    if (remaining <= 0) {
      categoryFailed[work.category] = true;
      return;
    }

    let answers: Record<string, unknown>;
    const j = judge!;
    try {
      const result = await Promise.race([
        j.evaluate({ state, questions }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), remaining)),
      ]);
      answers = result.answers;
      state_.requestCount++;
    } catch (err) {
      categoryFailed[work.category] = true;
      judgeError.value = { message: err instanceof Error ? err.message : String(err), category: classifyError(err) };
      return;
    }

    categoryCompleted[work.category] = true;

    if (state_.disposition === "unclear") {
      const dispRaw = parseChoiceAnswer(answers[dispositionKey]);
      if (dispRaw) {
        state_.disposition = dispRaw.label as Disposition;
        state_.pAdvance = dispRaw.pAdvance;
      }
    }

    if (state_.disposition !== "advance") return;

    for (const { opaqueId, candidate } of opaqueBatch) {
      const answer = parseScoreAnswer(answers[opaqueId]);
      if (!answer) continue;

      const pUseful = (answer.probabilities[2] ?? 0) + (answer.probabilities[3] ?? 0);

      if (!state_.bestScored || pUseful > state_.bestScored.usefulness ||
          (pUseful === state_.bestScored.usefulness && answer.level > state_.bestScored.level) ||
          (pUseful === state_.bestScored.usefulness && answer.level === state_.bestScored.level &&
           (candidate.kind === "skill" && state_.bestScored.candidate.kind !== "skill" ||
            (candidate.kind === state_.bestScored.candidate.kind && candidate.id < state_.bestScored.candidate.id)))) {
        state_.bestScored = { candidate, usefulness: pUseful, level: answer.level };
      }
    }
  }

  launchNext();
  await Promise.all(inFlight);

  const elapsedMs = (deps.now?.() ?? Date.now()) - start;
  const { disposition, pAdvance, hash, requestCount, bestScored } = state_;

  const skillUsable = categoryCompleted.skill && !categoryFailed.skill;
  const toolUsable = categoryCompleted.tool && !categoryFailed.tool;

  // When every category failed, the judge is broken — surface the error, not no_match.
  if (!skillUsable && !toolUsable && judgeError.value) {
    return { disposition: "unclear", selected: null, usefulness: 0, pAdvance: 0, questionHash: state_.hash, elapsedMs, requestCount: state_.requestCount, skipReason: "error", errorCategory: judgeError.value.category };
  }

  if (disposition !== "advance") {
    const skipReason: SkipReason | undefined = disposition === "awaiting_user" ? "awaiting_user" : undefined;
    const result: AssessmentResult = { disposition, selected: null, usefulness: 0, pAdvance, questionHash: hash, elapsedMs, requestCount };
    if (skipReason) result.skipReason = skipReason;
    return result;
  }

  if (!bestScored) {
    const skipReason: SkipReason = skillOverflow ? "catalog_limit" : "no_match";
    return { disposition, selected: null, usefulness: 0, pAdvance, questionHash: hash, elapsedMs, requestCount, skipReason };
  }

  if (bestScored.candidate.kind === "skill" && !skillUsable) {
    return { disposition, selected: null, usefulness: 0, pAdvance, questionHash: hash, elapsedMs, requestCount, skipReason: "no_match" };
  }
  if (bestScored.candidate.kind === "tool" && !toolUsable) {
    return { disposition, selected: null, usefulness: 0, pAdvance, questionHash: hash, elapsedMs, requestCount, skipReason: "no_match" };
  }

  const passesUsefulness = bestScored.usefulness >= config.recommendThreshold;
  const passesAdvance = pAdvance >= config.advanceThreshold;
  if (!passesUsefulness || !passesAdvance) {
    return { disposition, selected: null, usefulness: bestScored.usefulness, pAdvance, questionHash: hash, elapsedMs, requestCount, skipReason: "below_threshold" };
  }

  if (bestScored.candidate.kind === "skill" && skillOverflow) {
    return { disposition, selected: null, usefulness: bestScored.usefulness, pAdvance, questionHash: hash, elapsedMs, requestCount, skipReason: "catalog_limit" };
  }

  return {
    disposition,
    selected: bestScored.candidate,
    usefulness: bestScored.usefulness,
    pAdvance,
    questionHash: hash,
    elapsedMs,
    requestCount,
  };
}
