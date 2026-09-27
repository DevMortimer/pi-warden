import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userConfigPath } from "./config.js";
import type { RuleOutcome, RuleScore, RulesVerdict } from "./rules.js";

/**
 * Local record of the rules guard's verdicts. After each verdict from Jev, one JSON line per scored rule goes to one
 * file per project under pi-warden's data folder, so a report can say how often each rule was judged, how often it
 * fired, and how often a fired rule was fixed on a later edit. The record holds the judgment only: the rule name, the
 * score, and the outcome, never the written content and never the rule text. Nothing here is sent anywhere.
 *
 * One file per project, keyed by a hash of the working directory, so the project path itself is not stored in clear.
 * The file keeps the newest `RULES_LOG_MAX_RECORDS` records; past that the oldest are dropped (trim, not rotate).
 * A write failure is silent to the agent and is reported once through the `onFailure` callback (fail open).
 */

/** Records kept per project file; the oldest are trimmed first. */
export const RULES_LOG_MAX_RECORDS = 5000;

export interface RuleRecord {
  /** ISO timestamp of the judgment. */
  at: string;
  /** Session id as a file-name-safe value. */
  session: string;
  /** Project-relative path the judgment was about. */
  path: string;
  /** Tool that triggered the judgment. */
  tool: string;
  /** Rule id. */
  id: string;
  /** Rule name (heading). Never the rule body. */
  name: string;
  outcome: RuleOutcome;
  /** P(violation) from Jev. */
  violation: number;
  /** `rules.threshold` in force at the time. */
  threshold: number;
  /** `violation` at or above the threshold. */
  finding: boolean;
  /** True when this judgment clears an earlier finding of the same rule on the same path in the same session. */
  cleared?: true;
}

/** One judgment within a verdict, after clear detection. */
export interface RuleObservation {
  id: string;
  name: string;
  outcome: RuleOutcome;
  violation: number;
  finding: boolean;
  cleared: boolean;
}

const isRuleRecord = (value: unknown): value is RuleRecord => {
  const record = value as RuleRecord;
  return typeof value === "object" && value !== null
    && typeof record.at === "string"
    && typeof record.session === "string"
    && typeof record.path === "string"
    && typeof record.tool === "string"
    && typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.outcome === "string"
    && typeof record.violation === "number"
    && typeof record.threshold === "number"
    && typeof record.finding === "boolean";
};

/** The log file for a project: the working directory's hash keeps two projects apart without naming either. */
export function rulesLogPath(cwd: string): string {
  const project = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(dirname(userConfigPath()), "rules", `${project}.jsonl`);
}

/** Keep the newest `max` lines, dropping the oldest. */
export function trimRecords(lines: readonly string[], max: number = RULES_LOG_MAX_RECORDS): string[] {
  const kept = lines.filter(line => line.trim());
  return kept.length <= max ? kept : kept.slice(kept.length - max);
}

/**
 * Per-session memory of the last judgment per rule and path, so a score below the threshold right after a finding is
 * a clear. A second finding resets the entry, so `flag → flag` is not a clear, and a different path has its own entry.
 */
export class RuleClearTracker {
  private readonly lastFinding = new Map<string, boolean>();

  observe(path: string, scores: readonly RuleScore[], threshold: number): RuleObservation[] {
    return scores.map(score => {
      const key = `${path}\u0000${score.id}`;
      const wasFinding = this.lastFinding.get(key) === true;
      const finding = score.violation >= threshold;
      const cleared = wasFinding && !finding;
      this.lastFinding.set(key, finding);
      return { id: score.id, name: score.name, outcome: score.outcome, violation: score.violation, finding, cleared };
    });
  }

  reset(): void {
    this.lastFinding.clear();
  }
}

async function lineCount(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const line of text.split("\n")) if (line.trim()) count++;
  return count;
}

export interface RulesLogOptions {
  /** Override the file path (tests). */
  path?: string;
  /** Records kept before trimming (tests). */
  maxRecords?: number;
  /** Called once with a message when a write fails; the failure never reaches the agent. */
  onFailure?: (message: string) => void;
}

/** Appends rules verdicts to this project's log, one write at a time, and trims the file when it grows past the cap. */
export class RulesLog {
  readonly path: string;
  private readonly tracker = new RuleClearTracker();
  private readonly maxRecords: number;
  private readonly onFailure: ((message: string) => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private failure: string | undefined;
  private reported = false;
  /** Lines in the file, read once on the first append and tracked after that. */
  private lines = -1;

  constructor(cwd: string, private readonly session: string, options: RulesLogOptions = {}) {
    this.path = options.path ?? rulesLogPath(cwd);
    this.maxRecords = Math.max(1, options.maxRecords ?? RULES_LOG_MAX_RECORDS);
    this.onFailure = options.onFailure;
  }

  /**
   * Records one Jev verdict and returns its judgments, so the caller can trace the ones that cleared an earlier
   * finding. Batches the whole verdict into one write; never throws.
   */
  record(verdict: RulesVerdict, threshold: number, at: number = Date.now()): RuleObservation[] {
    if (!verdict.scores?.length) return [];
    const observations = this.tracker.observe(verdict.path, verdict.scores, threshold);
    const records: RuleRecord[] = observations.map(observation => ({
      at: new Date(at).toISOString(),
      session: this.session,
      path: verdict.path,
      tool: verdict.tool,
      id: observation.id,
      name: observation.name,
      outcome: observation.outcome,
      violation: observation.violation,
      threshold,
      finding: observation.finding,
      ...(observation.cleared ? { cleared: true as const } : {}),
    }));
    this.append(records.map(record => JSON.stringify(record)));
    return observations;
  }

  /** The last write error, if the most recent append failed. */
  get lastFailure(): string | undefined {
    return this.failure;
  }

  /** Resolves when the writes queued so far are on disk or the log has stopped. */
  flush(): Promise<void> {
    return this.queue;
  }

  private append(lines: readonly string[]): void {
    if (!lines.length) return;
    this.queue = this.queue.then(() => this.write(lines)).catch(error => this.fail(error));
  }

  private async write(lines: readonly string[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (this.lines < 0) this.lines = await lineCount(this.path);
    await appendFile(this.path, `${lines.join("\n")}\n`, { mode: 0o600 });
    this.lines += lines.length;
    if (this.lines > this.maxRecords) await this.trim();
  }

  private async trim(): Promise<void> {
    const text = await readFile(this.path, "utf8");
    const kept = trimRecords(text.split("\n"), this.maxRecords);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${kept.join("\n")}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    this.lines = kept.length;
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error);
    if (this.reported) return;
    this.reported = true;
    try {
      this.onFailure?.(`warden: rules log ${this.path} could not be written (${this.failure}); rules verdicts are not recorded this session.`);
    } catch (reportError) {
      console.warn("pi-warden: rules log failure could not be reported:", reportError);
    }
  }
}

/** Reads this project's records; a missing file is an empty log and a torn line is skipped. */
export async function readRulesLog(path: string): Promise<RuleRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: RuleRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRuleRecord(value)) records.push(value);
    } catch {
      // A torn final line from an interrupted write is skipped.
    }
  }
  return records;
}
