/**
 * Compaction evidence appendix. Deterministic, pure, no Jev request.
 *
 * When Pi fires `session_before_compact`, the extension builds a snapshot from session memory and passes it to
 * `compactAppendix`. The returned text is appended to `customInstructions` so the summarizer carries the evidence
 * verbatim into the compressed summary.
 */
import { redact } from "./redact.js";

const MAX_CHARS = 2000;

export interface SavedOutput {
  tool: string;
  path: string;
  /** Uncompressed size in bytes. */
  bytes: number;
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

export interface StuckState {
  failures: number;
  sameStrategyScore: number | undefined;
  currentCallFamily: string | undefined;
}

export interface CompactSnapshot {
  savedOutputs: readonly SavedOutput[];
  /** Capped at 5 in the hook before this is called. */
  checks: readonly CheckEntry[];
  /** Capped at 10 in the hook before this is called. */
  holds: readonly HeldEntry[];
  stuck: StuckState | undefined;
  activeTask: string | undefined;
}

/** Returns empty string for an empty snapshot. Capped at 2 000 chars. */
export function compactAppendix(snapshot: CompactSnapshot): string {
  const sections: string[] = [];

  if (snapshot.savedOutputs.length) {
    const items = snapshot.savedOutputs
      .map(item => `- ${redact(item.tool)} → ${redact(item.path)} (${item.bytes} bytes)`)
      .join("\n");
    sections.push(`### Saved full outputs\n${items}`);
  }

  if (snapshot.checks.length) {
    const items = snapshot.checks
      .map(c => `- ${c.passed ? "✓" : "✗"} ${c.when}: ${redact(c.command)}`)
      .join("\n");
    sections.push(`### Last checks\n${items}`);
  }

  if (snapshot.holds.length) {
    const items = snapshot.holds
      .map(h => `- ${redact(h.tool)}: ${redact(h.outcome)}${h.preview ? ` (${redact(h.preview)})` : ""}`)
      .join("\n");
    sections.push(`### Held actions\n${items}`);
  }

  if (snapshot.stuck) {
    const s = snapshot.stuck;
    const family = s.currentCallFamily ? `; family: ${redact(s.currentCallFamily)}` : "";
    const score = s.sameStrategyScore !== undefined ? `; same-strategy: ${s.sameStrategyScore.toFixed(2)}` : "";
    sections.push(`### Stuck state\n- failures: ${s.failures}${score}${family}`);
  }

  if (snapshot.activeTask) {
    sections.push(`### Active task\n${redact(snapshot.activeTask)}`);
  }

  if (sections.length === 0) return "";

  const body = sections.join("\n\n");
  const appendix = [
    "=== PI-WARDEN COMPACT EVIDENCE ===",
    "Instruct the summarizer: carry this section into the summary unchanged.",
    "",
    body,
    "=== END PI-WARDEN COMPACT EVIDENCE ===",
  ].join("\n");

  const marker = "\n… [truncated]";
  if (appendix.length <= MAX_CHARS) return appendix;
  return appendix.slice(0, MAX_CHARS - marker.length) + marker;
}

/**
 * Build a `CompactSnapshot` from the extension's session-scoped state. All string values are redacted; saved-output
 * paths are local and allowed.
 */
export function buildCompactSnapshot(options: {
  savedOutputs: Array<{ tool: string; path: string; bytes: number }>;
  checks: Array<{ command: string; passed: boolean; runIndex: number; indexInRun: number }>;
  holds: Array<{ tool: string; preview: string; outcome: string }>;
  stuck: { failures: number; sameStrategyScore: number | undefined; currentCallFamily: string | undefined } | undefined;
  activeTask: string | undefined;
  runs: number;
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

  const stuck: StuckState | undefined = options.stuck ? {
    failures: options.stuck.failures,
    sameStrategyScore: options.stuck.sameStrategyScore,
    currentCallFamily: options.stuck.currentCallFamily,
  } : undefined;

  const activeTask = options.activeTask ? redact(options.activeTask) : undefined;

  return { savedOutputs, checks, holds, stuck, activeTask };
}
