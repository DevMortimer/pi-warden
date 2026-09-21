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
  /** Human-readable description. */
  description: string;
  /** True when Pi marks the skill as user-invoked only. */
  userOnly: boolean;
  /** Full skill metadata, present for kind=skill. */
  skill?: Skill;
}

/** The result of one assessment. */
export interface AssessmentResult {
  /** The disposition chosen by the shared question. */
  disposition: Disposition;
  /** The selected candidate, if any. */
  selected: Candidate | null;
  /** P(useful now) = P(level ≥ related) + P(level = directly_useful). */
  usefulness: number;
  /** Question hash for deduplication. */
  questionHash: string;
  /** Time spent on this assessment (ms). */
  elapsedMs: number;
  /** Why no selection was made, if applicable. */
  skipReason?: SkipReason | undefined;
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
  | "origin_unknown";

/** Score levels for the usefulness question. */
export const SCORE_LEVELS = ["not_useful", "related", "direct_useful", "prerequisite"] as const;
export type ScoreLevel = (typeof SCORE_LEVELS)[number];

/* ─── Question builder ──────────────────────────────────────────────── */

/**
 * Build the assessment questions for a single candidate.
 * Returns a Questions object plus the shared disposition question.
 */
export function buildAssessmentQuestions(
  candidates: Candidate[],
  task: string,
  recentContext: string,
  activeSkills: string[],
  suppliedSkills: string[],
): { questions: Questions; dispositionKey: string } {
  const questions: Questions = {};

  // Shared disposition question
  const dispositionKey = "conscience_disposition";
  questions[dispositionKey] = choice(
    `Task: ${task}\nContext: ${recentContext}\nActive skills: ${activeSkills.join(", ") || "none"}\nSupplied skills: ${suppliedSkills.join(", ") || "none"}\n\nDisposition of the current request:`,
    {
      advance: "A useful next step can be taken now.",
      awaiting_user: "The assistant has already asked for information and must wait.",
      no_gap: "The request is satisfied with no useful missing step.",
      unclear: "Insufficient evidence to determine the next step.",
    },
  );

  // Per-candidate usefulness Score questions
  for (const candidate of candidates) {
    const key = `conscience_${candidate.kind}_${candidate.id}`;
    const exclusionNote = candidate.userOnly ? " (user-invoked only)" : "";
    questions[key] = score(
      `Task: ${task}\nContext: ${recentContext}\nActive skills: ${activeSkills.join(", ") || "none"}\nSupplied skills: ${suppliedSkills.join(", ") || "none"}\n\nCandidate: ${candidate.id} (${candidate.kind}${exclusionNote})\nDescription: ${candidate.description}`,
      [
        "No useful contribution to the current request, or conflicts with the supplied constraints.",
        "Related to the subject, but already covered, premature, or unable to resolve the current need.",
        "Addresses a concrete unmet need at the current step without displacing the active workflow.",
        "Supplies a missing prerequisite or directly applicable documented method needed for the current step.",
      ],
    );
  }

  return { questions, dispositionKey };
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

/** Filter candidates by eligibility rules. */
export function eligibleCandidates(
  skills: Skill[],
  tools: { name: string; description: string }[],
  config: ConscienceConfig,
  activeSkills: string[],
  suppliedSkills: string[],
): Candidate[] {
  const candidates: Candidate[] = [];

  if (config.skills.mode !== "off") {
    for (const skill of skills) {
      if (isExcluded(skill.name, config.skills.exclude)) continue;
      // disableModelInvocation skills are never automatic candidates (spec §3 rule 4)
      if (skill.disableModelInvocation) continue;
      // Already supplied: skip
      if (suppliedSkills.includes(skill.name)) continue;
      candidates.push({
        kind: "skill",
        id: skill.name,
        description: skill.description,
        userOnly: skill.disableModelInvocation,
        skill,
      });
    }
  }

  if (config.tools.enabled) {
    for (const tool of tools) {
      if (isExcluded(tool.name, config.tools.exclude)) continue;
      candidates.push({
        kind: "tool",
        id: tool.name,
        description: tool.description,
        userOnly: false,
      });
    }
  }

  return candidates;
}

/* ─── Conscience module ─────────────────────────────────────────────── */

export interface Judge {
  evaluate(request: { state: unknown; questions: Questions }, options?: { timeoutMs?: number }): Promise<{ answers: Record<string, unknown> }>;
}

export interface ConscienceDeps {
  judge: Judge | undefined;
  config: ConscienceConfig;
  /** Current wall-clock time (ms). Injected for testability. */
  now?: () => number;
}

/**
 * Run one assessment for the given prompt revision.
 * Pre-measurement: returns trace-only results. No steers, no auto-loading.
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
  const { config, judge } = deps;

  if (!config.enabled) {
    return { disposition: "no_gap", selected: null, usefulness: 0, questionHash: "", elapsedMs: 0, skipReason: "disabled" };
  }
  if (!judge) {
    return { disposition: "no_gap", selected: null, usefulness: 0, questionHash: "", elapsedMs: 0, skipReason: "no_consent" };
  }

  const candidates = eligibleCandidates(skills, tools, config, activeSkills, suppliedSkills);
  if (candidates.length === 0) {
    return { disposition: "no_gap", selected: null, usefulness: 0, questionHash: "", elapsedMs: 0, skipReason: "no_match" };
  }

  const { questions, dispositionKey } = buildAssessmentQuestions(candidates, prompt, recentContext, activeSkills, suppliedSkills);
  const hash = questionHash(questions);

  const deadline = start + Math.min(config.timeoutMs, 5000);
  const remaining = deadline - (deps.now?.() ?? Date.now());
  if (remaining <= 0) {
    return { disposition: "unclear", selected: null, usefulness: 0, questionHash: hash, elapsedMs: 0, skipReason: "timeout" };
  }

  let answers: Record<string, unknown>;
  try {
    const result = await Promise.race([
      judge.evaluate({ state: { prompt, recentContext }, questions }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), remaining)),
    ]);
    answers = result.answers;
  } catch {
    return { disposition: "unclear", selected: null, usefulness: 0, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, skipReason: "error" };
  }

  // Extract disposition
  const dispAnswer = answers[dispositionKey] as { response?: string } | undefined;
  const disposition: Disposition = (dispAnswer?.response as Disposition) ?? "unclear";

  if (disposition !== "advance") {
    const skipReason: SkipReason | undefined = disposition === "awaiting_user" ? "awaiting_user" : undefined;
    const result: AssessmentResult = { disposition, selected: null, usefulness: 0, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start };
    if (skipReason) result.skipReason = skipReason;
    return result;
  }

  // Score each candidate and compute P(useful now) = P(related) + P(directly_useful)
  type ScoredCandidate = { candidate: Candidate; usefulness: number; level: number };
  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const key = `conscience_${candidate.kind}_${candidate.id}`;
    const answer = answers[key] as { response?: string; probabilities?: Record<string, number> } | undefined;
    if (!answer?.probabilities) continue;
    const probs = answer.probabilities;
    const pRelated = probs.related ?? 0;
    const pDirect = probs.directly_useful ?? 0;
    const pUseful = pRelated + pDirect;
    const level = SCORE_LEVELS.indexOf((answer.response as ScoreLevel) ?? "not_useful");
    scored.push({ candidate, usefulness: pUseful, level });
  }

  if (scored.length === 0) {
    return { disposition, selected: null, usefulness: 0, questionHash: hash, elapsedMs: (deps.now?.() ?? Date.now()) - start, skipReason: "no_match" };
  }

  // Rank by usefulness probability, then expected Score level; break ties by skill-before-tool and stable id
  scored.sort((a, b) => {
    if (b.usefulness !== a.usefulness) return b.usefulness - a.usefulness;
    if (b.level !== a.level) return b.level - a.level;
    if (a.candidate.kind !== b.candidate.kind) return a.candidate.kind === "skill" ? -1 : 1;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  const best = scored[0]!;
  return {
    disposition,
    selected: best.candidate,
    usefulness: best.usefulness,
    questionHash: hash,
    elapsedMs: (deps.now?.() ?? Date.now()) - start,
  };
}
