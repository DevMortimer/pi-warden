/**
 * Compaction evidence appendix. Deterministic, pure, no Jev request.
 *
 * After Pi fires `session_compact`, the extension builds a snapshot from session memory and passes it to
 * `compactAppendix`. The returned text is sent as one custom message so the agent does not retry approaches that
 * already failed, knows whether its last passing check still covers the code, and can prefer saved paths over
 * re-running commands.
 */
import type { RunEvidence } from "./done.js";
import { redact } from "./redact.js";

const MAX_CHARS = 2000;
const MAX_FAILED = 5;
const FAILED_ENTRY_CHARS = 160;
const FAILED_CALL_CHARS = 70;
const SAVED_KEEP_WHEN_OVER = 3;
const TASK_CHARS_WHEN_OVER = 300;

export interface SavedOutput {
  /** Undefined when the recorder did not say; the appendix then prints only what it knows. */
  tool: string | undefined;
  path: string;
  /** Uncompressed size in bytes. */
  bytes: number | undefined;
}

export interface CheckEntry {
  command: string;
  passed: boolean;
  /** Short label: "current run", "run 2", or "current run, #3". */
  when: string;
}

export interface HeldEntry {
  tool: string;
  /** Redacted preview of the call (command, path, or input); ≤120 chars. */
  preview: string;
  outcome: string;
}

export interface FailedAttempt {
  /** Redacted call view. */
  call: string;
  /** Last meaningful line of the failed output; empty when the output had none. */
  error: string;
}

/** Whether the code as it stands was covered by a passing check. */
export type Verification =
  | { kind: "passed"; command: string; changedSince: boolean }
  | { kind: "none-passed" };

export interface StuckState {
  failures: number;
  /** Tool results in the attempt window the failures were counted in. */
  window: number;
}

export interface CompactSnapshot {
  savedOutputs: readonly SavedOutput[];
  /** Capped at 5 in the hook before this is called. */
  checks: readonly CheckEntry[];
  /** Capped at 10 in the hook before this is called. */
  holds: readonly HeldEntry[];
  /** Distinct failed calls, oldest first, at most 5. */
  failedAttempts: readonly FailedAttempt[];
  verification: Verification | undefined;
  stuck: StuckState | undefined;
  activeTask: string | undefined;
  /** The session's open loops, already formatted and capped by `formatOpenLoops`; absent or empty when none is open. */
  openLoops?: string;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

type SectionName = "failed" | "verification" | "loops" | "checks" | "stuck" | "holds" | "saved" | "task";

/** Every section in appendix order; `warden_recall` prints some of the same strings, so the two never disagree. */
function renderSections(snapshot: CompactSnapshot): Array<[SectionName, string]> {
  const sections: Array<[SectionName, string]> = [];
  const push = (name: SectionName, text: string) => sections.push([name, text]);

  if (snapshot.failedAttempts.length) {
    const items = snapshot.failedAttempts.map(attempt => {
      const call = clip(redact(attempt.call), FAILED_CALL_CHARS);
      const error = redact(attempt.error);
      const entry = error ? `${call} → ${clip(error, FAILED_ENTRY_CHARS - call.length - 3)}` : call;
      return `- ${entry}`;
    }).join("\n");
    push("failed", `### Tried and failed\nDo not retry these unchanged.\n${items}`);
  }

  if (snapshot.verification) {
    const v = snapshot.verification;
    const line = v.kind === "passed"
      ? `- last passing check: ${redact(v.command)}; code changed since last passing check: ${v.changedSince ? "yes" : "no"}`
      : "- no check has passed yet; code was changed";
    push("verification", `### Verification\n${line}`);
  }

  if (snapshot.openLoops) {
    push("loops", `### Open loops\nPromised earlier in this session and not done yet; close each with warden_loops done or drop.\n${snapshot.openLoops}`);
  }

  if (snapshot.checks.length) {
    const items = snapshot.checks
      .map(c => `- ${c.passed ? "✓" : "✗"} ${c.when}: ${redact(c.command)}`)
      .join("\n");
    push("checks", `### Last checks\n${items}`);
  }

  if (snapshot.stuck) {
    push("stuck", `### Stuck state\n- failures: ${snapshot.stuck.failures} of the last ${snapshot.stuck.window} tool results`);
  }

  if (snapshot.holds.length) {
    const items = snapshot.holds
      .map(h => `- ${redact(h.tool)}: ${redact(h.outcome)}${h.preview ? ` (${redact(h.preview)})` : ""}`)
      .join("\n");
    push("holds", `### Held actions\n${items}`);
  }

  if (snapshot.savedOutputs.length) {
    const items = snapshot.savedOutputs
      .map(item => `- ${item.tool ? `${redact(item.tool)} → ` : ""}${redact(item.path)}${item.bytes === undefined ? "" : ` (${item.bytes} bytes)`}`)
      .join("\n");
    push("saved", `### Saved full outputs\n${items}`);
  }

  if (snapshot.activeTask) {
    push("task", `### Active task\n${redact(snapshot.activeTask)}`);
  }
  return sections;
}

function render(snapshot: CompactSnapshot): string {
  const sections = renderSections(snapshot).map(([, text]) => text);
  if (sections.length === 0) return "";

  return [
    "=== PI-WARDEN COMPACT EVIDENCE ===",
    "Evidence warden kept across compaction. Prefer the saved-output paths below over re-running commands that produced them.",
    "",
    sections.join("\n\n"),
    "=== END PI-WARDEN COMPACT EVIDENCE ===",
  ].join("\n");
}

/**
 * Lower-value content goes first when the appendix is over the cap. Failed attempts, the verification line, and the
 * open loops (at most 600 characters) are never reduced here; they come first in the text, so the final cut reaches
 * them last.
 */
const REDUCERS: ReadonlyArray<(s: CompactSnapshot) => CompactSnapshot> = [
  s => ({ ...s, savedOutputs: s.savedOutputs.slice(-SAVED_KEEP_WHEN_OVER) }),
  s => ({ ...s, holds: [] }),
  s => ({ ...s, activeTask: s.activeTask && clip(s.activeTask, TASK_CHARS_WHEN_OVER) }),
  s => ({ ...s, stuck: undefined }),
  s => ({ ...s, checks: s.checks.slice(-2) }),
  s => ({ ...s, savedOutputs: [] }),
  s => ({ ...s, activeTask: undefined }),
  s => ({ ...s, checks: [] }),
];

/** Returns empty string for an empty snapshot. Capped at 2 000 chars. */
export function compactAppendix(snapshot: CompactSnapshot): string {
  let appendix = render(snapshot);
  for (const reduce of REDUCERS) {
    if (appendix.length <= MAX_CHARS) return appendix;
    snapshot = reduce(snapshot);
    appendix = render(snapshot);
  }
  if (appendix.length <= MAX_CHARS) return appendix;
  const marker = "\n… [truncated]";
  return appendix.slice(0, MAX_CHARS - marker.length) + marker;
}

/**
 * `warden_recall`: what was already tried in this session, from the same snapshot and the same section text as the
 * compaction appendix: the failed attempts with their error lines, the last passing check with whether the code
 * changed since, and the saved-output paths. Capped like the appendix.
 */
export function recallText(snapshot: CompactSnapshot): string {
  const kept = renderSections(snapshot).filter(([name]) => name === "failed" || name === "verification" || name === "saved").map(([, text]) => text);
  const text = kept.length ? kept.join("\n\n") : "Nothing recorded yet in this session: no failed attempt, no check, and no saved output.";
  if (text.length <= MAX_CHARS) return text;
  const marker = "\n… [truncated]";
  return text.slice(0, MAX_CHARS - marker.length) + marker;
}

const ERROR_LINE = /\b(?:error|errors|fail(?:ed|ure|s)?|exception|cannot|can't|could not|not found|no such|denied|refused|invalid|unexpected|missing|undefined|timed? ?out|abort(?:ed)?|panic|fatal|traceback)\b|✗|✖|✘/i;
/** Runner tallies ("Found 1 error.", "3 failing") say that something failed, not what; an earlier line says what. */
const SUMMARY_LINE = /^(?:found \d+ errors?\b|\d+ (?:failing|failed|errors?)\b|tests?:\s|ℹ fail \d+|npm (?:err!|error) (?:code|errno|a complete log|command failed|lifecycle)|error: command failed|command failed with exit code)/i;

/** The line of a failed output most likely to name the error: the last specific error line, else the last line. */
export function errorLine(output: string): string {
  const lines = output
    .replace(/^\[\d+ earlier chars\] …/, "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !/^[-=─—*_~.`]+$/.test(line));
  for (let index = lines.length - 1; index >= 0; index--) {
    if (ERROR_LINE.test(lines[index]!) && !SUMMARY_LINE.test(lines[index]!)) return lines[index]!;
  }
  return lines.at(-1) ?? "";
}

/** Distinct failed calls, the latest occurrence of each, oldest first; at most `MAX_FAILED`. */
export function distinctFailures(attempts: ReadonlyArray<{ key: string; call: string; failed: boolean; output: string }>): FailedAttempt[] {
  const latest = new Map<string, FailedAttempt>();
  for (const attempt of attempts) {
    if (!attempt.failed) continue;
    latest.delete(attempt.key);
    latest.set(attempt.key, { call: attempt.call, error: errorLine(attempt.output) });
  }
  return [...latest.values()].slice(-MAX_FAILED);
}

/** Undefined when no check passed and no code changed: there is nothing to say. */
export function verificationOf(evidence: Pick<RunEvidence, "mutations" | "checks" | "checksBeforeMutation">): Verification | undefined {
  let lastPass = evidence.checks.length - 1;
  while (lastPass >= 0 && !evidence.checks[lastPass]!.passed) lastPass--;
  if (lastPass >= 0) {
    return { kind: "passed", command: evidence.checks[lastPass]!.call, changedSince: (evidence.checksBeforeMutation ?? -1) > lastPass };
  }
  return evidence.mutations > 0 ? { kind: "none-passed" } : undefined;
}

/**
 * Build a `CompactSnapshot` from the extension's session-scoped state. All string values are redacted; saved-output
 * paths are local and allowed.
 */
export function buildCompactSnapshot(options: {
  savedOutputs: Array<{ tool: string | undefined; path: string; bytes: number | undefined }>;
  checks: Array<{ command: string; passed: boolean; runIndex: number; indexInRun: number }>;
  holds: Array<{ tool: string; preview: string; outcome: string }>;
  /** The stuck guard's attempt window, oldest first. */
  attempts?: ReadonlyArray<{ key: string; call: string; failed: boolean; output: string }>;
  evidence?: Pick<RunEvidence, "mutations" | "checks" | "checksBeforeMutation">;
  activeTask: string | undefined;
  runs: number;
  openLoops?: string;
}): CompactSnapshot {
  const savedOutputs: SavedOutput[] = options.savedOutputs.map(o => ({
    tool: o.tool,
    path: o.path,
    bytes: o.bytes,
  }));

  const maxChecks = 5;
  const checks: CheckEntry[] = options.checks.slice(-maxChecks).map(c => ({
    command: c.command,
    passed: c.passed,
    when: options.runs <= 1 ? "current run" : `run ${c.runIndex}${c.indexInRun > 0 ? `, #${c.indexInRun + 1}` : ""}`,
  }));

  const maxHolds = 10;
  const holds: HeldEntry[] = options.holds.slice(-maxHolds).map(h => ({
    tool: h.tool,
    preview: h.preview,
    outcome: h.outcome,
  }));

  const attempts = options.attempts ?? [];
  const failures = attempts.filter(attempt => attempt.failed).length;
  const stuck: StuckState | undefined = failures > 0 ? { failures, window: attempts.length } : undefined;

  const activeTask = options.activeTask ? redact(options.activeTask) : undefined;

  return {
    savedOutputs,
    checks,
    holds,
    failedAttempts: distinctFailures(attempts),
    verification: options.evidence ? verificationOf(options.evidence) : undefined,
    stuck,
    activeTask,
    ...(options.openLoops ? { openLoops: options.openLoops } : {}),
  };
}
