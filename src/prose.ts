import { noul, TypeSafeIntegrationError } from "pi-typesafe";
import type { ProseConfig } from "./config.js";
import type { Judge } from "./guard.js";
import { redact } from "./redact.js";

export type ProseSymptom = "wordy" | "cliches" | "jargon";
export const PROSE_SYMPTOMS: readonly ProseSymptom[] = ["wordy", "cliches", "jargon"];

export const proseQuestions = {
  wordy: noul("Is `reply` longer than its content requires: a preamble, restating the request, summarising what it just said, or filler sentences that add no information?", {
    true: "Yes: it opens with what it is about to do, repeats the question, ends with a summary of the same points, or pads with sentences that could be removed without losing anything.",
    false: "No: each sentence carries information the reader needs; length matches the substance.",
  }),
  cliches: noul("Does `reply` use assistant clichés or filler phrasing: \"Great question\", \"Certainly!\", \"I hope this helps\", \"it's worth noting\", \"delve\", \"let me know if\", unrequested bullet lists of caveats, or emoji headings?", {
    true: "Yes: one or more such phrases or patterns are present.",
    false: "No: the wording is direct and specific to the subject.",
  }),
  jargon: noul("Would a reader described by `audience` struggle with `reply` because of unexplained technical terms or assumed background?", {
    true: "Yes: terms, acronyms, or concepts appear without explanation that this audience would not know.",
    false: "No: the reply matches what this audience can follow, or the audience is technical.",
  }),
};

export const PROSE_LABELS: Record<ProseSymptom, string> = {
  wordy: "longer than the content needs (preamble, restating, summarising, filler)",
  cliches: "assistant clichés or filler phrasing",
  jargon: "unexplained technical terms for the configured audience",
};

const AUDIENCES: Record<string, string> = {
  technical: "a software developer who knows this codebase and its tools",
  plain: "a non-programmer who owns the product and reads the reply as a status update",
};

/** Map the two built-in audience names to descriptions Jev can judge against; anything else is used as written. */
export function describeAudience(audience: string): string {
  return AUDIENCES[audience.toLowerCase()] ?? audience;
}

export interface ProseVerdict {
  scores?: Record<ProseSymptom, number>;
  /** Symptoms at or above the threshold for this reply, strongest first. */
  flagged: ProseSymptom[];
  /** Set by the caller when a nudge was sent. */
  nudged?: boolean;
  model?: string;
  elapsedMs?: number;
  error?: string;
}

export function buildProseRequest(task: string | undefined, reply: string, audience: string) {
  return {
    state: {
      task: task?.trim() ? (task.trim().length > 1000 ? `${task.trim().slice(0, 1000)}…` : task.trim()) : "(no user request recorded in this session)",
      audience: describeAudience(audience),
      reply: redact(reply.length > 2500 ? `${reply.slice(0, 2500)}…` : reply),
    },
    questions: proseQuestions,
  };
}

export interface ProseOptions {
  config: ProseConfig;
  judge: Judge;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export async function evaluateProse(task: string | undefined, reply: string, options: ProseOptions): Promise<ProseVerdict> {
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const result = await options.judge.evaluate(buildProseRequest(task, reply, options.config.audience), { signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    const scores: Record<ProseSymptom, number> = { wordy: result.answers.wordy.noul, cliches: result.answers.cliches.noul, jargon: result.answers.jargon.noul };
    const flagged = PROSE_SYMPTOMS.filter(symptom => scores[symptom] >= options.config.threshold).sort((a, b) => scores[b] - scores[a]);
    return { scores, flagged, model: result.model, elapsedMs: result.elapsedMs };
  } catch (error) {
    return { flagged: [], error: error instanceof TypeSafeIntegrationError ? error.message : "TypeSafe request failed." };
  }
}

/**
 * Remembers the last three replies' symptoms. A nudge needs a symptom in `trend` of them, so one long answer to a long
 * question is not punished, and after a nudge the next two replies are given time to change.
 */
export class ProseTrend {
  private readonly history: ProseSymptom[][] = [];
  private cooldown = 0;
  readonly counts: Record<ProseSymptom, number> = { wordy: 0, cliches: 0, jargon: 0 };

  record(flagged: readonly ProseSymptom[]): void {
    this.history.push([...flagged]);
    if (this.history.length > 3) this.history.shift();
    for (const symptom of flagged) this.counts[symptom]++;
    if (this.cooldown > 0) this.cooldown--;
  }

  /** Symptoms that crossed the trend requirement, or an empty list during cool-down. */
  due(trend: number): ProseSymptom[] {
    if (this.cooldown > 0) return [];
    return PROSE_SYMPTOMS.filter(symptom => this.history.filter(set => set.includes(symptom)).length >= trend);
  }

  markNudged(): void {
    this.cooldown = 2;
  }

  reset(): void {
    this.history.length = 0;
    this.cooldown = 0;
    for (const symptom of PROSE_SYMPTOMS) this.counts[symptom] = 0;
  }
}

/** Queued for the next user prompt, so it shapes the next reply without spending a turn. */
export function proseNudge(symptoms: readonly ProseSymptom[], audience: string, counts: Record<ProseSymptom, number>): string {
  const parts = symptoms.map(symptom => `${PROSE_LABELS[symptom]}${counts[symptom] >= 3 ? ` (${counts[symptom]} replies this session)` : ""}`);
  const fixes: string[] = [];
  if (symptoms.includes("wordy")) fixes.push("lead with the answer, cut preambles and closing summaries, and stop when the information is complete");
  if (symptoms.includes("cliches")) fixes.push("drop filler phrases and unrequested caveat lists");
  if (symptoms.includes("jargon")) fixes.push(`write for ${describeAudience(audience)}: explain or replace technical terms`);
  const standing = symptoms.some(symptom => counts[symptom] >= 3) ? " Treat this as a standing rule for the rest of the session." : "";
  return `pi-warden: your recent replies read as ${parts.join("; ")}. From the next reply on, ${fixes.join("; ")}.${standing}`;
}
