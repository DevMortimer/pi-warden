import type { DoneVerdict } from "./done.js";
import type { Verdict } from "./guard.js";
import type { Attempt, StuckVerdict } from "./stuck.js";

export type GuardName = "action" | "stuck" | "done";

export interface TraceEntry {
  at: number;
  guard: GuardName;
  /** The widget line for this event. */
  line: string;
  /** Redacted details: what was inspected, what Jev answered, what the agent was told. */
  details: string[];
}

/** Session memory of guard decisions; the widget shows the latest line per guard, the panel shows the history. */
export class Trace {
  private readonly items: TraceEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limit = 100) {}

  push(entry: TraceEntry): void {
    this.items.push(entry);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    for (const listener of this.listeners) listener();
  }

  entries(): readonly TraceEntry[] {
    return this.items;
  }

  clear(): void {
    this.items.length = 0;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
const percent = (value: number) => value.toFixed(2);

export function actionDetails(verdict: Verdict, extra: { mode?: string; told?: string } = {}): string[] {
  const { summary, judgment } = verdict;
  const lines: string[] = [];
  if (summary.command !== undefined) lines.push(`ran: ${clip(summary.command.replace(/\s+/g, " "), 300)}`);
  if (summary.path !== undefined) lines.push(`${summary.tool} ${summary.path}${summary.location === "outside_project" ? " (outside the project)" : ""}${summary.exists === false ? " (new file)" : ""}${summary.bytes !== undefined ? ` · ${summary.bytes} bytes` : ""}${summary.editCount !== undefined ? ` · ${summary.editCount} edit${summary.editCount === 1 ? "" : "s"}` : ""}`);
  if (summary.input !== undefined) lines.push(`input: ${clip(summary.input, 300)}`);
  if (verdict.patterns.length) lines.push(`patterns: ${verdict.patterns.map(hit => `${hit.id} (${hit.severity})`).join(", ")}`);
  if (judgment) {
    lines.push(`jev: irreversible ${percent(judgment.irreversible)} · off-task ${percent(judgment.offTask)} · ${judgment.scope.replace(/_/g, " ")} (${percent(judgment.scopeConfidence)})${judgment.approved !== undefined ? ` · approved ${percent(judgment.approved)}` : ""} · ${judgment.model} · ${judgment.elapsedMs} ms`);
  }
  if (verdict.slop) lines.push(`slop: quality ${verdict.slop.quality.toFixed(2)}/2 · placeholder ${percent(verdict.slop.placeholder)}${verdict.slopReasons?.length ? ` → ${verdict.slopReasons.join("; ")}` : ""}`);
  if (verdict.reasons.length) lines.push(`why: ${verdict.reasons.join("; ")}`);
  if (verdict.error) lines.push(`typesafe: ${verdict.error}`);
  if (extra.mode && verdict.level === "confirm") lines.push(`mode: ${extra.mode}`);
  if (extra.told) lines.push(`agent told: ${clip(extra.told, 400)}`);
  return lines;
}

export function stuckDetails(verdict: StuckVerdict, attempts: readonly Attempt[], told?: string): string[] {
  const lines = attempts.map((attempt, index) => `${index + 1}. ${attempt.failed ? "✗" : "✓"} ${clip(attempt.call.replace(/\s+/g, " "), 120)}${attempt.failed && attempt.output ? ` → ${clip(attempt.output.replace(/\s+/g, " "), 120)}` : ""}`);
  if (verdict.judgment) lines.push(`jev: same strategy ${percent(verdict.judgment.sameStrategy)} · approach change ${verdict.judgment.approachChange.toFixed(2)}/2 · progress ${percent(verdict.judgment.progress)} · ${verdict.judgment.model} · ${verdict.judgment.elapsedMs} ms`);
  if (verdict.reasons.length) lines.push(`why: ${verdict.reasons.join("; ")}`);
  if (verdict.error) lines.push(`typesafe: ${verdict.error}`);
  if (told) lines.push(`agent told: ${clip(told, 400)}`);
  return lines;
}

export function doneDetails(verdict: DoneVerdict, finalMessage: string, told?: string): string[] {
  const lines = [`final message: ${clip(finalMessage.replace(/\s+/g, " "), 300)}`];
  lines.push(`evidence: ${verdict.evidence.mutations} code change${verdict.evidence.mutations === 1 ? "" : "s"}${verdict.evidence.checks.length ? `; checks: ${verdict.evidence.checks.map(check => `${clip(check.call, 60)} → ${check.passed ? "passed" : "failed"}`).join(", ")}` : "; no checks ran"}`);
  if (verdict.judgment) lines.push(`jev: claims done ${percent(verdict.judgment.claimsDone)} · claims verified ${percent(verdict.judgment.claimsVerified)} · checks apply ${percent(verdict.judgment.verificationApplies)} · ${verdict.judgment.outcome} · ${verdict.judgment.model} · ${verdict.judgment.elapsedMs} ms`);
  if (verdict.reasons.length) lines.push(`why: ${verdict.reasons.join("; ")}`);
  if (verdict.error) lines.push(`typesafe: ${verdict.error}`);
  if (told) lines.push(`agent told: ${clip(told, 400)}`);
  return lines;
}
