import { createHash } from "node:crypto";
import { noul, score, TypeSafeIntegrationError } from "pi-typesafe";
import type { StuckGuardConfig } from "./config.js";
import type { Judge } from "./guard.js";
import { redact } from "./redact.js";

/** One remembered tool result. `key` identifies the exact call; `call` is the redacted view that may leave the machine. */
export interface Attempt {
  tool: string;
  key: string;
  /** Hash of the normalised output, so identical failures can be told from a changed error. */
  outputKey: string;
  call: string;
  failed: boolean;
  /** Tail of the tool output, redacted, where the error usually is. */
  output: string;
}

export interface StuckJudgment {
  sameStrategy: number;
  /** 0 identical … 2 meaningfully different. */
  approachChange: number;
  progress: number;
  model: string;
  elapsedMs: number;
}

export interface StuckVerdict {
  stuck: boolean;
  source: "repeat" | "typesafe" | "error";
  failures: number;
  reasons: string[];
  judgment?: StuckJudgment;
  error?: string;
}

const CALL_LIMIT = 300;
const OUTPUT_LIMIT = 400;

function head(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more chars]`;
}
function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `[${text.length - limit} earlier chars] …${text.slice(-limit)}`;
}

/** Text content of a tool result, without images. */
export function resultText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text as string).join("\n");
}

/** Non-zero exit codes count as failures even when the tool did not flag an error. */
export function resultFailed(isError: boolean, details: unknown): boolean {
  if (isError) return true;
  const exitCode = details && typeof details === "object" ? (details as { exitCode?: unknown }).exitCode : undefined;
  return typeof exitCode === "number" && exitCode !== 0;
}

/** Durations, timestamps, PIDs, and addresses change between identical runs; counts and line numbers stay. */
function normaliseOutput(text: string): string {
  return text
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|µs|us|ns)\b/g, "#t")
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/\d{5,}/g, "#")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g, "#date");
}

export function makeAttempt(tool: string, input: Record<string, unknown>, content: ReadonlyArray<{ type: string; text?: string }>, failed: boolean): Attempt {
  const call = typeof input.command === "string" ? input.command
    : typeof input.path === "string" ? `${tool} ${input.path}`
    : JSON.stringify(input);
  const text = resultText(content).trim();
  return {
    tool,
    key: createHash("sha1").update(tool).update("\0").update(JSON.stringify(input)).digest("hex"),
    outputKey: createHash("sha1").update(normaliseOutput(text)).digest("hex"),
    call: redact(head(call, CALL_LIMIT)),
    failed,
    output: redact(tail(text, OUTPUT_LIMIT)),
  };
}

/** Rolling memory of tool results for the current user prompt. */
export class AttemptWindow {
  readonly attempts: Attempt[] = [];
  private sinceJudgment = Number.MAX_SAFE_INTEGER;

  constructor(private readonly limit: number) {}

  push(attempt: Attempt): void {
    this.attempts.push(attempt);
    if (this.attempts.length > this.limit) this.attempts.splice(0, this.attempts.length - this.limit);
    if (this.sinceJudgment !== Number.MAX_SAFE_INTEGER) this.sinceJudgment++;
  }

  reset(): void {
    this.attempts.length = 0;
    this.sinceJudgment = Number.MAX_SAFE_INTEGER;
  }

  markJudged(): void {
    this.sinceJudgment = 0;
  }

  failures(): number {
    return this.attempts.filter(attempt => attempt.failed).length;
  }

  /** How many failed attempts repeat the latest attempt's exact call with the same output. A changed error is progress, not a repeat. */
  exactRepeats(): number {
    const latest = this.attempts.at(-1);
    if (!latest?.failed) return 0;
    return this.attempts.filter(attempt => attempt.failed && attempt.key === latest.key && attempt.outputKey === latest.outputKey).length;
  }

  /** Latest result failed, enough failures accumulated, and the cool-down since the last check has passed. */
  shouldJudge(config: StuckGuardConfig): boolean {
    const latest = this.attempts.at(-1);
    return Boolean(latest?.failed) && this.failures() >= config.minFailures && this.sinceJudgment >= config.cooldown;
  }
}

export const stuckQuestions = {
  same_strategy: noul(
    "Do the failed entries in `attempts` repeat the same strategy with only superficial variation, instead of trying a different approach to the failure?",
    {
      true: "Yes: the same command or edit is retried, or only flags, paths, names, or wording change while the underlying idea stays the same.",
      false: "No: later attempts use a different tool, test a new hypothesis, gather new information first, or act on what the earlier output said.",
    },
  ),
  approach_change: score("How much did the approach change across `attempts`?", [
    "Identical or near-identical retries",
    "Cosmetic changes: different flags, paths, or wording, same underlying idea",
    "Meaningfully different: a new hypothesis, tool, or information-gathering step",
  ]),
  progress: noul("Do the later entries in `attempts` show progress toward resolving the failure seen in the earlier ones, such as a different error, a partial success, or new information?"),
};

export function buildStuckRequest(attempts: readonly Attempt[], task: string | undefined) {
  return {
    state: {
      task: task?.trim() ? head(task.trim(), 1500) : "(no user request recorded in this session)",
      attempts: attempts.map((attempt, index) => ({ n: index + 1, tool: attempt.tool, call: attempt.call, outcome: attempt.failed ? "failed" : "ok", output: attempt.output })),
    },
    questions: stuckQuestions,
  };
}

export interface StuckOptions {
  config: StuckGuardConfig;
  judge?: Judge | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** Exact repeats are decided in code; otherwise one Jev request judges the sequence. */
export async function evaluateStuck(window: AttemptWindow, task: string | undefined, options: StuckOptions): Promise<StuckVerdict> {
  const failures = window.failures();
  const repeats = window.exactRepeats();
  if (repeats >= options.config.minFailures) {
    return { stuck: true, source: "repeat", failures, reasons: [`the same call failed ${repeats} times with the same output`] };
  }
  if (!options.judge) return { stuck: false, source: "repeat", failures, reasons: [] };
  window.markJudged();
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const result = await options.judge.evaluate(buildStuckRequest(window.attempts, task), { signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    const judgment: StuckJudgment = {
      sameStrategy: result.answers.same_strategy.noul,
      approachChange: result.answers.approach_change.score,
      progress: result.answers.progress.noul,
      model: result.model,
      elapsedMs: result.elapsedMs,
    };
    const stuck = judgment.sameStrategy >= options.config.sameStrategy;
    const reasons = stuck
      ? [`${failures} failures with the same strategy (${judgment.sameStrategy.toFixed(2)}), approach change ${judgment.approachChange.toFixed(1)}/2, progress ${judgment.progress.toFixed(2)}`]
      : [];
    return { stuck, source: "typesafe", failures, reasons, judgment };
  } catch (error) {
    return { stuck: false, source: "error", failures, reasons: [], error: error instanceof TypeSafeIntegrationError ? error.message : "TypeSafe request failed." };
  }
}

/** Steering text for the agent. Names the pattern and asks for a change of method, not another retry. */
export function stuckNudge(verdict: StuckVerdict): string {
  return `pi-warden: ${verdict.reasons.join("; ")}. Stop retrying. Re-read the last error output carefully, state a new hypothesis about the cause, and either gather the missing information (read the relevant file, check versions or paths) or try a different method. If two different methods have failed, report the blocker to the user with the exact error instead of trying again.`;
}

export function formatStuck(verdict: StuckVerdict): string {
  const parts = [`warden · stuck · ${verdict.failures} failures`];
  if (verdict.judgment) parts.push(`same strategy ${verdict.judgment.sameStrategy.toFixed(2)}`, `change ${verdict.judgment.approachChange.toFixed(1)}/2`, `progress ${verdict.judgment.progress.toFixed(2)}`);
  if (verdict.source === "repeat" && verdict.stuck) parts.push("exact repeat");
  if (verdict.source === "error") parts.push("typesafe error");
  parts.push(verdict.stuck ? "stuck" : "ok");
  return parts.join(" · ");
}
