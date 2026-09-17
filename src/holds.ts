import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userConfigPath } from "./config.js";
import type { WardenMode } from "./config.js";
import type { ActionSummary, Level, PreviousAction, ScopeLabel, Verdict } from "./guard.js";

/**
 * Hold feedback loop. Every hold is a prediction ("this call should not run as it stands") and every allowed call the
 * opposite one; what the user does next labels them, so hold precision can be measured on real sessions instead of the
 * synthetic cases the thresholds came from:
 *
 * - **approved**: the user's reply released the hold (steer mode) or the confirm dialog allowed it. False positive.
 * - **declined**: the confirm dialog refused it. True positive.
 * - **replanned**: the user replied, the following turn ended, and nobody approved the call. True positive.
 * - **regretted**: the user's next message tells the agent to stop, undo, or not do an allowed call. False negative.
 * - **accepted**: the user's next message was checked and does not regret the allowed calls of the last turn.
 *
 * Approval, decline, and re-plan are code only. Regret is one question that rides the first action request under the
 * new prompt (no extra request); offline a stop-word heuristic stands in. Calls the guard skipped as read-only are not
 * recorded: they could never have been held. Records are redacted for the log: tool, pattern ids, scores, level,
 * outcome, never the command or path. The in-memory summary serves the regret question and stays in memory.
 */
export type CallOutcome = "pending" | "approved" | "declined" | "replanned" | "regretted" | "accepted";
export type OutcomeVia = "retry" | "dialog" | "next prompt" | "jev" | "text";

export interface CallScores {
  irreversible: number;
  offTask: number;
  scope: ScopeLabel;
  mutates?: number;
  approved?: number;
  securityRisk?: number;
}

export interface CallRecord {
  /** Sequence number within the session; the regret question names candidates by it. */
  id: number;
  at: number;
  tool: string;
  level: Level;
  source: Verdict["source"];
  mode: WardenMode;
  held: boolean;
  patterns: string[];
  /** Reason labels as shown to the user; they name patterns and scores, never the command. */
  reasons: string[];
  scores?: CallScores;
  outcome: CallOutcome;
  outcomeAt?: number;
  outcomeVia?: OutcomeVia;
  /** P(regret) from the question that labelled this call, when Jev answered it. */
  regret?: number;
}

export interface HoldSnapshot {
  holds: number;
  approved: number;
  declined: number;
  replanned: number;
  /** Holds without a label yet: the user has not replied, or the turn after the reply is still running. */
  awaiting: number;
  allowed: number;
  regretted: number;
  accepted: number;
  /** Labelled holds: approved + declined + replanned. */
  labels: number;
  /** (declined + replanned) / labels; undefined without labels. */
  precision: number | undefined;
}

interface Tracked {
  record: CallRecord;
  summary: ActionSummary;
  /** User prompts that have arrived since the call. */
  prompts: number;
}

const REGRET_THRESHOLD = 0.7;

function scoresOf(verdict: Verdict): CallScores | undefined {
  const { judgment } = verdict;
  if (!judgment) return undefined;
  const scores: CallScores = { irreversible: judgment.irreversible, offTask: judgment.offTask, scope: judgment.scope };
  if (judgment.mutates !== undefined) scores.mutates = judgment.mutates;
  if (judgment.approved !== undefined) scores.approved = judgment.approved;
  if (judgment.securityRisk !== undefined) scores.securityRisk = judgment.securityRisk;
  return scores;
}

export class HoldLedger {
  private readonly tracked: Tracked[] = [];
  private nextId = 1;

  /** One inspected call. `outcome` is set at once when the confirm dialog decided; a steer-mode hold starts pending. */
  record(verdict: Verdict, options: { held: boolean; mode: WardenMode; outcome?: CallOutcome | undefined; via?: OutcomeVia | undefined; at?: number }): CallRecord {
    const at = options.at ?? Date.now();
    const record: CallRecord = {
      id: this.nextId++,
      at,
      tool: verdict.summary.tool,
      level: verdict.level,
      source: verdict.source,
      mode: options.mode,
      held: options.held,
      patterns: verdict.patterns.map(hit => hit.id),
      reasons: [...verdict.reasons],
      outcome: options.outcome ?? "pending",
    };
    const scores = scoresOf(verdict);
    if (scores) record.scores = scores;
    if (options.outcome && options.outcome !== "pending") { record.outcomeAt = at; if (options.via) record.outcomeVia = options.via; }
    this.tracked.push({ record, summary: verdict.summary, prompts: 0 });
    return record;
  }

  /**
   * The user's reply released a hold: the pending hold of the same tool is the false positive, the latest one when the
   * tools differ (the retry rarely repeats the held call byte for byte, and a hold can be released through another tool).
   */
  approved(tool: string, via: OutcomeVia = "retry", at = Date.now()): CallRecord | undefined {
    const pending = this.tracked.filter(item => item.record.held && item.record.outcome === "pending");
    const match = pending.filter(item => item.record.tool === tool).at(-1) ?? pending.at(-1);
    if (!match) return undefined;
    return this.label(match, "approved", via, at);
  }

  /**
   * A new user prompt. Every pending record has seen one more prompt. A hold still pending after the prompt that could
   * have approved it (the reply) and the turn that followed is a re-plan: the agent found another way or the user said no.
   */
  promptArrived(at = Date.now()): CallRecord[] {
    const changed: CallRecord[] = [];
    for (const item of this.tracked) {
      if (item.record.outcome !== "pending") continue;
      item.prompts++;
      if (item.record.held && item.prompts >= 2) changed.push(this.label(item, "replanned", "next prompt", at));
    }
    return changed;
  }

  /** Allowed calls of the turn the user just replied to, oldest first: the calls the reply could regret. */
  candidates(): PreviousAction[] {
    return this.tracked
      .filter(item => !item.record.held && item.record.outcome === "pending" && item.prompts === 1)
      .map(item => ({
        id: `a${item.record.id}`,
        tool: item.summary.tool,
        ...(item.summary.command !== undefined ? { command: clip(item.summary.command, 300) } : {}),
        ...(item.summary.path !== undefined ? { path: item.summary.path } : {}),
      }));
  }

  /**
   * The reply was read. With regret, the located call (or the latest candidate) is the miss and the rest are accepted;
   * without it, every candidate is accepted. Returns the records that changed.
   */
  regret(result: { regretted: boolean; target?: string | undefined; probability?: number | undefined; via: OutcomeVia }, at = Date.now()): CallRecord[] {
    const candidates = this.tracked.filter(item => !item.record.held && item.record.outcome === "pending" && item.prompts === 1);
    if (!candidates.length) return [];
    const target = result.regretted ? candidates.find(item => `a${item.record.id}` === result.target) ?? candidates.at(-1) : undefined;
    return candidates.map(item => {
      const record = this.label(item, item === target ? "regretted" : "accepted", result.via, at);
      if (result.probability !== undefined) record.regret = result.probability;
      return record;
    });
  }

  records(): readonly CallRecord[] {
    return this.tracked.map(item => item.record);
  }

  snapshot(): HoldSnapshot {
    const records = this.records();
    const holds = records.filter(record => record.held);
    const allowed = records.filter(record => !record.held);
    const count = (list: readonly CallRecord[], outcome: CallOutcome) => list.filter(record => record.outcome === outcome).length;
    const approved = count(holds, "approved");
    const declined = count(holds, "declined");
    const replanned = count(holds, "replanned");
    const labels = approved + declined + replanned;
    return {
      holds: holds.length, approved, declined, replanned, awaiting: count(holds, "pending"),
      allowed: allowed.length, regretted: count(allowed, "regretted"), accepted: count(allowed, "accepted"),
      labels, precision: labels ? (declined + replanned) / labels : undefined,
    };
  }

  reset(): void {
    this.tracked.length = 0;
    this.nextId = 1;
  }

  private label(item: Tracked, outcome: CallOutcome, via: OutcomeVia, at: number): CallRecord {
    item.record.outcome = outcome;
    item.record.outcomeAt = at;
    item.record.outcomeVia = via;
    return item.record;
  }
}

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

/** Whether P(regret) from the question counts as regret. */
export function regretsAt(probability: number): boolean {
  return probability >= REGRET_THRESHOLD;
}

/** Offline stand-in for the regret question: the reply opens by stopping, undoing, or forbidding what was just done. */
export function textRegrets(prompt: string | undefined): boolean {
  const text = (prompt ?? "").trim();
  if (!text) return false;
  const opening = text.slice(0, 160);
  return /^(?:wait(?! (?:for|until|till)\b)|stop\b|nope\b|hold on\b|don[’']t\b|do not\b|undo\b|revert\b|roll ?back\b|why did you\b|you (?:shouldn[’']t|should not) have\b|that (?:was|is) (?:wrong|not what)\b|no[,.!])/i.test(opening)
    || /\b(?:undo|revert|roll ?back) (?:that|this|it|the last|those|what you)\b/i.test(opening)
    || /\b(?:don[’']t|do not|never) (?:do|run|touch|push|delete|remove|commit) that\b/i.test(opening);
}

/** One line for the trace entry of a call whose outcome landed. */
export function outcomeNote(record: CallRecord): string {
  switch (record.outcome) {
    case "approved": return `outcome: approved by the user (${record.outcomeVia === "dialog" ? "confirm dialog" : "released on retry"}); the hold was a false positive`;
    case "declined": return "outcome: declined by the user in the confirm dialog; the hold stood";
    case "replanned": return "outcome: never approved after the user replied; the agent re-planned, the hold stood";
    case "regretted": return `outcome: the user's next message regrets this call${record.regret !== undefined ? ` (${record.regret.toFixed(2)})` : ""}; it should have been held`;
    case "accepted": return `outcome: the user's next message does not regret this call${record.regret !== undefined ? ` (${record.regret.toFixed(2)})` : ""}`;
    default: return "outcome: pending";
  }
}

/** One line for /warden status. */
export function formatHolds(snapshot: HoldSnapshot, logPath?: string): string {
  if (snapshot.holds === 0 && snapshot.allowed === 0) return "Holds: no guarded call judged yet this session.";
  const parts = [`${snapshot.holds} hold${snapshot.holds === 1 ? "" : "s"}`];
  if (snapshot.holds) parts.push(`${snapshot.approved} approved by you, ${snapshot.declined} declined, ${snapshot.replanned} re-planned, ${snapshot.awaiting} awaiting your reply`);
  parts.push(snapshot.precision === undefined ? "precision not yet measurable" : `precision ${Math.round(snapshot.precision * 100)}% over ${snapshot.labels} label${snapshot.labels === 1 ? "" : "s"}`);
  parts.push(`${snapshot.allowed} allowed (${snapshot.regretted} regretted by you, ${snapshot.accepted} accepted)`);
  return `Holds: ${parts.join("; ")}.${logPath ? ` Log: ${logPath}.` : ""}`;
}

/** Per-session file beside the user config: `<agent dir>/pi-warden/holds/<date>-<session>.jsonl`. */
export function holdLogPath(sessionId: string, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || String(process.pid);
  return join(dirname(userConfigPath()), "holds", `${day}-${safe}.jsonl`);
}

/** Rewrites the session's records as JSON lines, owner-only, one write at a time so outcomes never interleave. */
export class HoldLog {
  private queue: Promise<void> = Promise.resolve();
  private failure: string | undefined;

  constructor(readonly path: string) {}

  save(records: readonly CallRecord[]): Promise<void> {
    const text = records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path, text, { mode: 0o600 });
      this.failure = undefined;
    }).catch(error => { this.failure = error instanceof Error ? error.message : String(error); });
    return this.queue;
  }

  /** The last write error, if the most recent save failed. */
  get lastFailure(): string | undefined {
    return this.failure;
  }
}
