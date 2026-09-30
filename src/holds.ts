import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { userConfigPath } from "./config.js";
import type { WardenMode } from "./config.js";
import { defaultHostDirs } from "./host-dirs.js";
import type { ActionSummary, Level, PreviousAction, ScopeLabel, Verdict } from "./guard.js";

/**
 * Hold feedback loop. Every hold is a prediction ("this call should not run as it stands") and every allowed call the
 * opposite one; what the user does next labels them, so hold precision can be measured on real sessions instead of the
 * synthetic cases the thresholds came from:
 *
 * - **approved**: the user's reply released the hold (steer mode) or the confirm dialog allowed it. False positive.
 * - **declined**: the confirm dialog refused it. True positive.
 * - **replanned**: after the user replied, the agent ran a different call that changes something instead. True positive.
 * - **abandoned**: the run after the user's reply ended with neither: the hold was never released and nothing else ran. True positive.
 * - **regretted**: the user's next message tells the agent to stop, undo, or not do an allowed call. False negative.
 * - **accepted**: the user's next message was checked and does not regret the allowed calls of the last turn.
 *
 * Approval, decline, re-plan, and abandon are code only. Regret is one question that rides the first action request under the
 * new prompt (no extra request); offline a stop-word heuristic stands in. Calls the guard skipped as read-only are not
 * recorded: they could never have been held. Records are redacted for the log: tool, pattern ids, scores, level,
 * outcome, never the command or path. The in-memory summary serves the regret question and stays in memory.
 */
export type CallOutcome = "pending" | "approved" | "declined" | "replanned" | "abandoned" | "regretted" | "accepted";
export type OutcomeVia = "retry" | "dialog" | "next prompt" | "jev" | "text" | "deny";

export interface CallScores {
  irreversible: number;
  offTask: number;
  scope: ScopeLabel;
  mutates?: number;
  approved?: number;
  intentMismatch?: number;
  visible?: number;
  securityRisk?: number;
  largeOutput?: number;
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
  /** Length of the agent's stated plan sent with the call; 0 means the agent said nothing before calling. Decides whether declared intent (layer 2) is worth building. */
  planChars: number;
  scores?: CallScores;
  outcome: CallOutcome;
  outcomeAt?: number;
  outcomeVia?: OutcomeVia;
  /** P(regret) from the question that labelled this call, when Jev answered it. */
  regret?: number;
  /** Redacted excerpt of the call (command, path, or input); ≤120 chars. For auditing off-task and intent-mismatch. */
  callExcerpt?: string;
}

export interface HoldSnapshot {
  holds: number;
  approved: number;
  declined: number;
  replanned: number;
  /** Holds whose run after the reply ended with neither a release nor another mutating call. */
  abandoned: number;
  /** Holds without a label yet: the user has not replied, or the turn after the reply is still running. */
  awaiting: number;
  allowed: number;
  regretted: number;
  accepted: number;
  /** Labelled holds: approved + declined + replanned. The precision denominator. */
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

/** Observability-only records (rules verdicts) that never join regret labelling. */
interface Untracked {
  record: CallRecord;
  path?: string;
}

const REGRET_THRESHOLD = 0.7;

/** Tools that change a file whatever the judge says; used to read a following call as a re-plan. */
const MUTATING_TOOLS = new Set(["write", "edit", "edit_lines", "apply_patch", "multiedit"]);

/**
 * Whether a call can change something: a tool that writes a file, or one Jev scored as mutating. The
 * `replanned` label reads it: a mutating call after the user's reply means the agent went another way.
 */
export function mutatingCall(verdict: Verdict): boolean {
  if (MUTATING_TOOLS.has(verdict.summary.tool)) return true;
  return (verdict.judgment?.mutates ?? 0) >= 0.5;
}

function scoresOf(verdict: Verdict): CallScores | undefined {
  const { judgment } = verdict;
  if (!judgment) return undefined;
  const scores: CallScores = { irreversible: judgment.irreversible, offTask: judgment.offTask, scope: judgment.scope };
  if (judgment.mutates !== undefined) scores.mutates = judgment.mutates;
  if (judgment.approved !== undefined) scores.approved = judgment.approved;
  if (judgment.intentMismatch !== undefined) scores.intentMismatch = judgment.intentMismatch;
  if (judgment.visible !== undefined) scores.visible = judgment.visible;
  if (judgment.securityRisk !== undefined) scores.securityRisk = judgment.securityRisk;
  if (judgment.largeOutput !== undefined) scores.largeOutput = judgment.largeOutput;
  return scores;
}

export class HoldLedger {
  private readonly tracked: Tracked[] = [];
  private readonly untracked: Untracked[] = [];
  private nextId = 1;

  /** One inspected call. `outcome` is set at once when the confirm dialog decided; a steer-mode hold starts pending. */
  record(verdict: Verdict, options: { held: boolean; mode: WardenMode; outcome?: CallOutcome | undefined; via?: OutcomeVia | undefined; at?: number; task?: string; plan?: string; contextSummary?: string; agentReason?: string }): CallRecord {
    const at = options.at ?? Date.now();
    const { summary } = verdict;
    const record: CallRecord = {
      id: this.nextId++,
      at,
      tool: summary.tool,
      level: verdict.level,
      source: verdict.source,
      mode: options.mode,
      held: options.held,
      patterns: verdict.patterns.map(hit => hit.id),
      reasons: [...verdict.reasons],
      planChars: verdict.plan?.length ?? 0,
      outcome: options.outcome ?? "pending",
    };
    // Call excerpt for auditing: tool + path only (commands never reach the log).
    if (summary.path) record.callExcerpt = `${summary.tool} ${summary.path}`;
    else if (summary.tool) record.callExcerpt = summary.tool;
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
   * A call that changes something ran after the user replied: the agent went another way instead of running the held
   * call, which is a re-plan. The released hold is already labelled `approved` by then (the action guard sets
   * `approvedByUser` on it), so a hold still pending here was not the one the reply released.
   */
  replanned(at = Date.now()): CallRecord[] {
    return this.pendingSteerHolds()
      .filter(item => item.prompts >= 1)
      .map(item => this.label(item, "replanned", "next prompt", at));
  }

  /**
   * A new user prompt. Every pending record has seen one more prompt. A hold is settled by the reply and the run it
   * starts: `approved` when that run retries it, `replanned` when it runs something else that changes something, and
   * `abandoned` at the end of that run when it does neither.
   */
  promptArrived(): void {
    for (const item of this.tracked) if (item.record.outcome === "pending") item.prompts++;
  }

  /**
   * The run ended. A steer hold whose reply has arrived and whose run ended without a release or a re-plan is
   * `abandoned`: nothing came of it. A hold from the run that just ended waits, because the reply that can release it
   * has not arrived yet.
   */
  runEnded(at = Date.now()): CallRecord[] {
    return this.pendingSteerHolds()
      .filter(item => item.prompts >= 1)
      .map(item => this.label(item, "abandoned", "next prompt", at));
  }

  /** Holds of steer mode still waiting for the user's reply and the call that settles them. */
  private pendingSteerHolds(): Tracked[] {
    return this.tracked.filter(item => item.record.held && item.record.outcome === "pending" && item.record.mode === "steer");
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
    return [...this.tracked.map(item => item.record), ...this.untracked.map(item => item.record)];
  }

  /**
   * Observability for the rules guard: its verdicts never act, so they do not join the regret labelling, but they
   * land in the hold log (tool "rules") with the per-rule violation probabilities so eval runs can diagnose misses.
   */
  recordRules(input: { source: Verdict["source"]; path?: string; findings: readonly { name: string; violation: number }[]; error?: string }): CallRecord {
    const at = Date.now();
    const record: CallRecord = {
      id: this.nextId++,
      at,
      tool: "rules",
      level: input.findings.length ? "warn" : "allow",
      source: input.source,
      mode: "steer",
      held: false,
      patterns: input.findings.map(f => f.name),
      reasons: input.findings.map(f => `${f.name} ${f.violation.toFixed(2)}`),
      planChars: 0,
      outcome: "accepted",
      outcomeAt: at,
    };
    if (input.error) record.reasons.push(`error: ${input.error}`);
    this.untracked.push({ record, ...(input.path ? { path: input.path } : {}) });
    return record;
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
      holds: holds.length, approved, declined, replanned, abandoned: count(holds, "abandoned"),
      awaiting: count(holds, "pending"),
      allowed: allowed.length, regretted: count(allowed, "regretted"), accepted: count(allowed, "accepted"),
      labels, precision: labels ? (declined + replanned) / labels : undefined,
    };
  }

  reset(): void {
    this.tracked.length = 0;
    // Rules verdicts ride the same log; without this, one session's diagnostics inflate the next session's counts.
    this.untracked.length = 0;
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
    case "declined": return record.outcomeVia === "deny"
      ? "outcome: blocked by a deny rule; the call never ran"
      : "outcome: declined by the user in the confirm dialog; the hold stood";
    case "replanned": return "outcome: never approved after the user replied and replaced by another call that changes something; the hold stood";
    case "abandoned": return "outcome: the run after the user replied neither released the hold nor replaced it; nothing came of it";
    case "regretted": return `outcome: the user's next message regrets this call${record.regret !== undefined ? ` (${record.regret.toFixed(2)})` : ""}; it should have been held`;
    case "accepted": return `outcome: the user's next message does not regret this call${record.regret !== undefined ? ` (${record.regret.toFixed(2)})` : ""}`;
    default: return "outcome: pending";
  }
}

/** One line for /warden status. */
export function formatHolds(snapshot: HoldSnapshot, logPath?: string): string {
  if (snapshot.holds === 0 && snapshot.allowed === 0) return "Holds: no guarded call judged yet this session.";
  const parts = [`${snapshot.holds} hold${snapshot.holds === 1 ? "" : "s"}`];
  if (snapshot.holds) parts.push(`${snapshot.approved} approved by you, ${snapshot.declined} declined, ${snapshot.replanned} re-planned, ${snapshot.abandoned} abandoned, ${snapshot.awaiting} awaiting your reply`);
  parts.push(snapshot.precision === undefined ? "precision not yet measurable" : `precision ${Math.round(snapshot.precision * 100)}% over ${snapshot.labels} label${snapshot.labels === 1 ? "" : "s"}`);
  parts.push(`${snapshot.allowed} allowed (${snapshot.regretted} regretted by you, ${snapshot.accepted} accepted)`);
  return `Holds: ${parts.join("; ")}.${logPath ? ` Log: ${logPath}.` : ""}`;
}

/** The session id as a file name part: no separators or dots, so it cannot leave the directory it is joined to. */
export function sessionFileId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || String(process.pid);
}

/** Per-session file beside the user config: `<agent dir>/pi-warden/holds/<date>-<session>.jsonl`. */
export function holdLogPath(sessionId: string, at = new Date(), dirs = defaultHostDirs()): string {
  const day = at.toISOString().slice(0, 10);
  return join(dirname(userConfigPath(dirs)), "holds", `${day}-${sessionFileId(sessionId)}.jsonl`);
}

/**
 * Rewrites the session's records as JSON lines, owner-only, one write at a time so outcomes never interleave. The
 * rewrite goes through a rename: a reader during an in-place rewrite could get a line cut short.
 */
export class HoldLog {
  private queue: Promise<void> = Promise.resolve();
  private failure: string | undefined;

  constructor(readonly path: string) {}

  save(records: readonly CallRecord[]): Promise<void> {
    const text = records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
    this.queue = this.queue.then(async () => {
      await writeFileAtomic(this.path, text);
      this.failure = undefined;
    }).catch(error => { this.failure = error instanceof Error ? error.message : String(error); });
    return this.queue;
  }

  /** The last write error, if the most recent save failed. */
  get lastFailure(): string | undefined {
    return this.failure;
  }
}
