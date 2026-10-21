/**
 * `/warden improve`: one project-local pass over this project's own sessions. The code measures — session files read
 * and skipped, turns, tool calls, whole-file reads, peak context, repeats, requests typed twice, rule judgments and
 * holds — and hands those counts to the session's own model, which reads the cited sessions and edits `pi-warden.md`
 * with its own tools. The code keeps the facts: the counts, the backup taken before the turn, the diff afterwards, and
 * the check that each changed rule's `Measured …` line cites a number the pass printed. The judgement is the model's,
 * so the code never writes a rule itself. No Jev request is made: the turn runs on the session's own model.
 *
 * The quiet window is the one timed thing here. It is held in this session's own extension instance, carries the
 * arming session id and its expiry, and every guard asks it with its own session id, so a window armed by one session
 * never silences another. It expires by the clock: no timer, no state on disk, and no path that leaves a judge muted.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { userConfigPath } from "./config.js";
import type { HostDirs } from "./host-dirs.js";
import { defaultHostDirs } from "./host-dirs.js";
import { isHumanTyped, jaccard, projectSessionFiles, SIMILARITY, tokens } from "./prefs.js";
import { redact } from "./redact.js";
import { buildRulesReport } from "./rules-report.js";
import type { RuleFlag, RuleReportRow } from "./rules-report.js";
import { readRulesLog, rulesLogPath } from "./rules-log.js";
import type { RuleRecord } from "./rules-log.js";
import type { WasteCall } from "./waste.js";
import { pagingNudge, recheckNudge, searchNudge, sleepNudge } from "./waste.js";

/** The window `/warden improve` reads when no number is given, and the most it accepts. */
export const IMPROVE_DEFAULT_DAYS = 7;
export const IMPROVE_MAX_DAYS = 90;
/** The most rule changes the model is asked for in one pass. */
export const IMPROVE_MAX_CHANGES = 3;
/** The default quiet window and the cap on it: ten minutes, never more than fifteen. */
export const QUIET_DEFAULT_MS = 600_000;
export const QUIET_MAX_MS = 900_000;
/** Kept from the tool result for the waste detectors: enough for a failure line and a line count. */
const RESULT_KEEP = 4000;
/** A repeated request is compared on its content words, redacted and capped before that. */
const REQUEST_KEEP = 200;

const DAY_MS = 86_400_000;

/** A window in days: a plain positive integer, refused in one line otherwise. */
export type ImproveArgs = { days: number } | { error: string };

export function parseImproveArgs(text: string): ImproveArgs {
  const value = text.trim();
  if (!value) return { days: IMPROVE_DEFAULT_DAYS };
  if (!/^\d+$/.test(value)) {
    return { error: `warden: "${value.slice(0, 20)}" is not a whole number of days; use /warden improve 1 to ${IMPROVE_MAX_DAYS}. Nothing was read.` };
  }
  const days = Number(value);
  if (days < 1) return { error: `warden: the window is at least 1 day, so there is something to read. Nothing was read.` };
  if (days > IMPROVE_MAX_DAYS) return { error: `warden: ${value} days is above the ${IMPROVE_MAX_DAYS}-day cap. Nothing was read.` };
  return { days };
}

// ── the quiet window ─────────────────────────────────────────────────────────

/**
 * The rules judge's quiet window of one session. A guard reads it with its own session id, so a window armed by
 * another session is not this session's and changes nothing here. Expiry is the clock: once `until` has passed the
 * window is dead for every reader, whatever path left it armed.
 */
export class QuietWindow {
  private session: string | undefined;
  private until = 0;

  /** Arms (or re-arms) the window for one session; the cap and the one-second floor are applied here. */
  arm(session: string, ms: number, now = Date.now()): { until: number; ms: number } {
    if (!(ms > 0)) {
      this.disarm();
      return { until: 0, ms: 0 };
    }
    const capped = Math.min(Math.max(1_000, Math.trunc(ms)), QUIET_MAX_MS);
    this.session = session;
    this.until = now + capped;
    return { until: this.until, ms: capped };
  }

  /** Ends the window now; every exit path of a pass that did not write takes it. */
  disarm(): void {
    this.session = undefined;
    this.until = 0;
  }

  /** True only for the arming session, and only before the expiry. */
  active(session: string | undefined, now = Date.now()): boolean {
    return session !== undefined && session === this.session && this.until > now;
  }

  get expiresAt(): number {
    return this.until;
  }

  get armedBy(): string | undefined {
    return this.session;
  }

  /** One line for `/warden status` and the status line; undefined when the window is dead or not this session's. */
  statusLine(session: string | undefined, now = Date.now()): string | undefined {
    if (!this.active(session, now)) return undefined;
    const left = Math.max(1, Math.ceil((this.until - now) / 1000));
    const at = new Date(this.until).toISOString().slice(11, 16);
    return `rules judge quiet until ${at} (${Math.ceil(left / 60)} min left), armed by this session`;
  }
}

// ── reading this project's sessions ──────────────────────────────────────────

/** What one session file says about reading cost and repeated work. */
export interface SessionReading {
  path: string;
  /** The Pi session id, taken from the file name. */
  session: string;
  turns: number;
  toolCalls: number;
  wholeFileReads: number;
  /** The largest `usage.totalTokens` any assistant message recorded; undefined when the file records none. */
  peakContext?: number;
  /** The calls of this session, in order, with the result text the waste detectors read. */
  calls: WasteCall[];
  /** Redacted texts a person typed, for the repeated-request count. */
  requests: string[];
}

export function sessionIdOf(file: string): string {
  const name = basename(file).replace(/\.jsonl$/, "");
  const cut = name.lastIndexOf("_");
  return cut >= 0 ? name.slice(cut + 1) : name;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

/**
 * One session file's counts, from the entries Pi writes: a `session` header with the cwd, `message` entries with role
 * `user` (a turn), `assistant` (with `usage.totalTokens` and `toolCall` content parts), and `toolResult` entries that
 * carry the output of the call with the same id. A line that does not parse is skipped, never guessed at.
 */
export function readSession(data: Buffer, path: string, cwd: string): SessionReading {
  const reading: SessionReading = { path, session: sessionIdOf(path), turns: 0, toolCalls: 0, wholeFileReads: 0, calls: [], requests: [] };
  const pending: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const results = new Map<string, { text: string; failed: boolean }>();
  for (const line of data.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown; usage?: { totalTokens?: unknown } } };
    try {
      entry = JSON.parse(line);
    } catch {
      // A torn last line in a session that is still being written: the complete lines still count.
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role === "user") {
      reading.turns++;
      const text = contentText(entry.message.content);
      if (isHumanTyped(text)) reading.requests.push(redact(text.replace(/\s+/g, " ").trim()).slice(0, REQUEST_KEEP));
      continue;
    }
    if (role === "assistant") {
      const total = entry.message.usage?.totalTokens;
      if (typeof total === "number" && Number.isFinite(total)) reading.peakContext = Math.max(reading.peakContext ?? 0, total);
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (call.type !== "toolCall" || typeof call.name !== "string") continue;
        const input = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
        reading.toolCalls++;
        if (call.name === "read" && input.offset === undefined && input.limit === undefined) reading.wholeFileReads++;
        pending.push({ id: typeof call.id === "string" ? call.id : `#${reading.toolCalls}`, name: call.name, input });
      }
      continue;
    }
    if (role === "toolResult") {
      const id = (entry.message as { toolCallId?: unknown }).toolCallId;
      if (typeof id !== "string") continue;
      results.set(id, { text: contentText(entry.message.content).slice(0, RESULT_KEEP), failed: (entry.message as { isError?: unknown }).isError === true });
    }
  }
  reading.calls = pending.map(call => {
    const result = results.get(call.id);
    return { tool: call.name, input: call.input, cwd, failed: result?.failed ?? false, result: result?.text ?? "" };
  });
  return reading;
}

export interface SkippedSession {
  path: string;
  reason: string;
}

export interface SessionGather {
  readings: SessionReading[];
  skipped: SkippedSession[];
  /** Session files found inside the window, before the session cap. */
  found: number;
  directories: number;
  /** Bytes read from the session files that were read, so the pass reports what the scan cost, not a budget. */
  bytes: number;
}

/**
 * Reads every session file of this project inside the window. A file outside this project's session directories is
 * never listed; a file whose header names another cwd, or whose entries do not parse, is skipped and counted.
 */
export async function gatherSessions(options: {
  dir: string;
  cwd: string;
  exclude?: string | undefined;
  days: number;
  now?: number;
  maxSessions?: number;
}): Promise<SessionGather> {
  const now = options.now ?? Date.now();
  const oldest = now - options.days * DAY_MS;
  const { files, directories } = await projectSessionFiles({ dir: options.dir, cwd: options.cwd, exclude: options.exclude, oldest });
  const readings: SessionReading[] = [];
  const skipped: SkippedSession[] = [];
  let bytes = 0;
  for (const file of files.slice(0, options.maxSessions ?? files.length)) {
    const data = await readFile(file.path).catch(() => undefined);
    if (!data) {
      skipped.push({ path: file.path, reason: "unreadable" });
      continue;
    }
    bytes += data.byteLength;
    const header = firstEntry(data);
    if (header && typeof header.cwd === "string" && header.cwd !== options.cwd) {
      skipped.push({ path: file.path, reason: `another project (${header.cwd})` });
      continue;
    }
    const headerCwd = typeof header?.cwd === "string" ? header.cwd : options.cwd;
    const reading = data.toString("utf8").trim() ? readSession(data, file.path, headerCwd) : undefined;
    if (!reading || (reading.turns === 0 && reading.toolCalls === 0)) {
      skipped.push({ path: file.path, reason: "no readable entries" });
      continue;
    }
    readings.push(reading);
  }
  return { readings, skipped, found: files.length, directories, bytes };
}

/** The `session` header of a session file, when it parses. */
function firstEntry(data: Buffer): { type?: unknown; cwd?: unknown } | undefined {
  const line = data.toString("utf8").split("\n", 1)[0] ?? "";
  try {
    const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    return entry.type === "session" ? entry : undefined;
  } catch {
    return undefined;
  }
}

// ── the three counts ─────────────────────────────────────────────────────────

export interface RepeatCounts {
  /** Calls a waste detector flagged: the same check, search, paging range, or wait sent twice. */
  total: number;
  byDetector: Record<"paging" | "search" | "recheck" | "sleep", number>;
  /** The session files each detector fired in, for the evidence line. */
  sessions: Record<"paging" | "search" | "recheck" | "sleep", string[]>;
}

export interface RefusalCounts {
  /** Holds recorded in the window, by kind: the pattern that held the call, or the tool. */
  holds: number;
  byKind: Array<{ kind: string; count: number }>;
  /** Rule judgments in the window. */
  judged: number;
  fired: number;
  cleared: number;
  byRule: RuleReportRow[];
  unheard: Array<{ id: string; name: string }>;
}

export interface ImproveCounts {
  days: number;
  since: number;
  until: number;
  sessions: number;
  skipped: number;
  turns: number;
  toolCalls: number;
  wholeFileReads: number;
  peakContext?: number;
  repeats: RepeatCounts;
  /** Requests a person typed that repeat an earlier one in the window. */
  repeatedRequests: number;
  refusals: RefusalCounts;
}

const DETECTORS = { paging: pagingNudge, search: searchNudge, recheck: recheckNudge, sleep: sleepNudge } as const;
/** The detector's own window: the last calls a repeat is judged over, the same span the guard uses. */
const WASTE_WINDOW = 10;

export function countRepeats(readings: readonly SessionReading[]): RepeatCounts {
  const counts: RepeatCounts = { total: 0, byDetector: { paging: 0, search: 0, recheck: 0, sleep: 0 }, sessions: { paging: [], search: [], recheck: [], sleep: [] } };
  for (const reading of readings) {
    for (let index = 0; index < reading.calls.length; index++) {
      const window = reading.calls.slice(Math.max(0, index - WASTE_WINDOW + 1), index + 1);
      for (const [name, detect] of Object.entries(DETECTORS) as Array<[keyof RepeatCounts["byDetector"], (calls: readonly WasteCall[]) => unknown]>) {
        if (!detect(window)) continue;
        counts.byDetector[name]++;
        counts.total++;
        if (!counts.sessions[name].includes(reading.path)) counts.sessions[name].push(reading.path);
      }
    }
  }
  return counts;
}

export function countRepeatedRequests(readings: readonly SessionReading[], similarity = SIMILARITY): number {
  let repeats = 0;
  const seen: string[][] = [];
  for (const reading of readings) {
    for (const request of reading.requests) {
      const words = tokens(request);
      if (!words.length) continue;
      if (seen.some(earlier => jaccard(earlier, words) >= similarity)) repeats++;
      seen.push(words);
    }
  }
  return repeats;
}

export interface ImproveInput {
  days: number;
  now: number;
  readings: readonly SessionReading[];
  skipped: readonly SkippedSession[];
  ruleRecords: readonly RuleRecord[];
  holds: ReadonlyArray<{ kind: string }>;
  currentRules: ReadonlyArray<{ id: string; name: string }>;
}

export function computeCounts(input: ImproveInput): ImproveCounts {
  const report = buildRulesReport(input.ruleRecords, { days: input.days, now: input.now, currentRules: input.currentRules, source: "live" });
  const byKind = new Map<string, number>();
  for (const hold of input.holds) byKind.set(hold.kind, (byKind.get(hold.kind) ?? 0) + 1);
  return {
    days: input.days,
    since: input.now - input.days * DAY_MS,
    until: input.now,
    sessions: input.readings.length,
    skipped: input.skipped.length,
    turns: input.readings.reduce((sum, reading) => sum + reading.turns, 0),
    toolCalls: input.readings.reduce((sum, reading) => sum + reading.toolCalls, 0),
    wholeFileReads: input.readings.reduce((sum, reading) => sum + reading.wholeFileReads, 0),
    ...(input.readings.some(reading => reading.peakContext !== undefined)
      ? { peakContext: Math.max(...input.readings.map(reading => reading.peakContext ?? 0)) }
      : {}),
    repeats: countRepeats(input.readings),
    repeatedRequests: countRepeatedRequests(input.readings),
    refusals: {
      holds: input.holds.length,
      byKind: [...byKind].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      judged: report.records,
      fired: report.rows.reduce((sum, row) => sum + row.fired, 0),
      cleared: report.rows.reduce((sum, row) => sum + row.cleared, 0),
      byRule: report.rows,
      unheard: report.unheard,
    },
  };
}

/** Every number the pass prints, as the list the cited-number check validates against. */
export function countLines(counts: ImproveCounts): Array<{ label: string; value: number | string }> {
  return [
    { label: "session files read", value: counts.sessions },
    { label: "session files skipped", value: counts.skipped },
    { label: "turns", value: counts.turns },
    { label: "tool calls", value: counts.toolCalls },
    { label: "whole-file reads", value: counts.wholeFileReads },
    { label: "peak context", value: counts.peakContext === undefined ? "unavailable" : counts.peakContext },
    { label: "calls flagged as repeats", value: counts.repeats.total },
    { label: "requests typed twice", value: counts.repeatedRequests },
    { label: "rule judgments", value: counts.refusals.judged },
    { label: "rules fired", value: counts.refusals.fired },
    { label: "cleared on a later edit", value: counts.refusals.cleared },
    { label: "holds", value: counts.refusals.holds },
  ];
}

/** The numbers a proposal may cite: those the count list prints as values. */
export function citedNumbers(counts: ImproveCounts): Set<number> {
  return new Set(countLines(counts).map(line => line.value).filter((value): value is number => typeof value === "number"));
}

export function formatCounts(counts: ImproveCounts): string {
  const lines = countLines(counts).map(line => `${line.label}: ${line.value}`
    + (line.label === "tool calls" && counts.turns ? ` (${(counts.toolCalls / counts.turns).toFixed(1)} per turn)` : ""));
  const perRule = counts.refusals.byRule
    .filter(row => row.judged > 0)
    .slice(0, 6)
    .map(row => `${row.name} ${row.fired}/${row.judged}${row.flags.length ? ` (${row.flags.join(", ")})` : ""}`);
  if (perRule.length) lines.push(`per rule: ${perRule.join("; ")}`);
  const detectors = (Object.entries(counts.repeats.byDetector) as Array<[string, number]>).filter(([, count]) => count > 0);
  if (detectors.length) lines.push(`repeats by kind: ${detectors.map(([kind, count]) => `${kind} ${count}`).join(", ")}`);
  if (counts.refusals.byKind.length) lines.push(`holds by kind: ${counts.refusals.byKind.slice(0, 6).map(hold => `${hold.kind} ${hold.count}`).join(", ")}`);
  return lines.join("\n");
}

// ── the rule sections, the model's prompt, and the summary after the turn ────

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** The lines of one rule: its heading through the line before the next heading, at any level. */
export function ruleSection(rulesText: string, name: string): { start: number; end: number } | undefined {
  const lines = rulesText.split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    const match = HEADING.exec(lines[index]!);
    if (!match) continue;
    if (start < 0) {
      if (match[2] !== name) continue;
      start = index;
      continue;
    }
    return { start, end: index };
  }
  return start < 0 ? undefined : { start, end: lines.length };
}

/** The heading names of a rules file, in file order. */
export function ruleNames(rulesText: string): string[] {
  return rulesText.split("\n").flatMap(line => {
    const match = HEADING.exec(line);
    return match ? [match[2]!] : [];
  });
}

/** A `Measured …` line, with the date taken out: only what follows the date can cite a printed count. */
const MEASURED = /^Measured \d{4}-\d{2}-\d{2}:\s*(.+)$/;
/** The window phrase carries the day count, not a measured number: `in the last 7 days` is never a citation. */
const WINDOW_PHRASE = /\bin the last \d+ days?\b/gi;
/** A path, a timestamp or a session id names where a count came from; its digits are not a count. */
const PATH_TOKEN = /\S*\/\S*/g;
const ISO_STAMP = /\b\d{4}-\d{2}-\d{2}T[\d:.+-]*Z?\b/g;
const ID_TOKEN = /\b(?=[0-9a-f-]*\d)[0-9a-f]{8,}(?:-[0-9a-f]+)+\b/gi;

/**
 * The prompt the session model gets. It carries the window, every printed count, the paths of the session files read
 * and skipped, and the rules file; it states the hand-over bound, the citation rule and the second-run rule in it. It
 * starts no turn itself: the command sends it through the same path `rules tune` uses.
 */
export interface ImproveRequestOptions {
  days: number;
  counts: ImproveCounts;
  /** The count lines exactly as the pass prints them, so the model cannot see a number the user does not. */
  countsText: string;
  read: readonly string[];
  skipped: readonly SkippedSession[];
  /** The rules file text as the pass read it. */
  rulesText: string;
  /** The rules file name, relative to the project root. */
  file: string;
}

export function improveRequest(options: ImproveRequestOptions): { prompt: string } | { reason: string } {
  if (!options.counts.sessions) return { reason: formatEmpty(options.days) };
  const read = options.read.join("\n") || "none";
  const skipped = options.skipped.length ? options.skipped.map(skip => `${skip.path} (${skip.reason})`).join("\n") : "none";
  return {
    prompt: [
      `pi-warden improve: make this project's rules better from the last ${options.days} day${options.days === 1 ? "" : "s"} of its own sessions.`,
      "",
      "The counts below were measured by pi-warden from this project's session files, rules log and hold log. They are the only facts a rule change may rest on.",
      "",
      options.countsText,
      "",
      `Session files read (${options.read.length}):`,
      read,
      "",
      `Session files skipped (${options.skipped.length}):`,
      skipped,
      "",
      `The rules file, ${options.file}, holds this now:`,
      `----- ${options.file} -----`,
      options.rulesText.replace(/\s*$/, ""),
      `----- end ${options.file} -----`,
      "",
      "What to do:",
      "- Read the session files listed above that bear on a count you mean to change, and judge what actually went wrong in them.",
      `- Change a rule only for a count printed above. For every rule you add or change, write a \`Measured YYYY-MM-DD: …\` line inside that rule's section that names the count (its label and value) and the session file it came from.`,
      `- If nothing printed above supports a change, say what the counts show and change nothing. When rule judgments is above 0, say the rules held; when it is 0, say the rules guard judged nothing, so nothing is known about the rules.`,
      `- Edit ${options.file} in place with your own tools (edit or write). Do not change any other file. A timestamped backup already sits beside it.`,
      `- Make at most ${IMPROVE_MAX_CHANGES} rule changes. Change a rule in place; do not add a second section with a heading the file already has, and if a rule already carries a \`Measured …\` line, replace that line instead of adding another, so a second run does not duplicate one.`,
      "- Hand-over bound: you get these counts, the session file paths above, the rules file text, and at most one short excerpt per finding. Do not scan directories or read session files that are not listed; stop before the list ends only if a file is unreadable, and say which files you did not read.",
      "- When you are done, reply with one line per rule you added, changed or removed, with the count you cited.",
    ].join("\n"),
  };
}

/** The labels a printed count carries, for a number the model cited. */
function labelsForNumber(counts: ImproveCounts, value: number): string {
  return countLines(counts).filter(line => line.value === value).map(line => line.label).join(" / ");
}

/** The printed counts a rule's `Measured …` lines cite; the date and the window phrase are not citations. */
export function measuredCitations(section: string, counts: ImproveCounts): number[] {
  const printed = citedNumbers(counts);
  const bodies = section.split("\n").map(line => MEASURED.exec(line.trim())?.[1]).filter((body): body is string => body !== undefined);
  const found = new Set<number>();
  for (const body of bodies) {
    const text = body.replace(WINDOW_PHRASE, " ").replace(PATH_TOKEN, " ").replace(ISO_STAMP, " ").replace(ID_TOKEN, " ");
    for (const match of text.matchAll(/\d+/g)) {
      const value = Number(match[0]);
      if (printed.has(value)) found.add(value);
    }
  }
  return [...found];
}

export interface RulesChangeSummary {
  added: string[];
  changed: string[];
  removed: string[];
  /** Added or changed rules whose `Measured …` line cites no number this pass printed; the edit is named, not reverted. */
  uncited: string[];
  /** One line per rule for the screen. */
  lines: string[];
}

/**
 * What the model changed, rule by rule, and whether each added or changed rule cites a printed count. Read-only: a
 * rule with no citation is named for the user; its edit stays in the file.
 */
export function summariseRulesChange(before: string, after: string, counts: ImproveCounts): RulesChangeSummary {
  const beforeNames = new Set(ruleNames(before));
  const afterNames = ruleNames(after);
  const sectionOf = (text: string, name: string) => {
    const span = ruleSection(text, name);
    return span ? text.split("\n").slice(span.start, span.end).join("\n") : "";
  };
  const summary: RulesChangeSummary = { added: [], changed: [], removed: [], uncited: [], lines: [] };
  for (const name of afterNames) {
    const previous = beforeNames.has(name);
    if (previous && sectionOf(before, name) === sectionOf(after, name)) continue;
    const kind = previous ? "changed" : "added";
    (previous ? summary.changed : summary.added).push(name);
    const cites = measuredCitations(sectionOf(after, name), counts);
    if (!cites.length) {
      summary.uncited.push(name);
      summary.lines.push(`${previous ? "~" : "+"} ${kind} "${name}" — no Measured line with a number this pass printed`);
      continue;
    }
    summary.lines.push(`${previous ? "~" : "+"} ${kind} "${name}" — cites ${cites.map(value => `${labelsForNumber(counts, value)} ${value}`).join(", ")}`);
  }
  for (const name of beforeNames) {
    if (afterNames.includes(name)) continue;
    summary.removed.push(name);
    summary.lines.push(`- removed "${name}"`);
  }
  return summary;
}

/** The closing sentence when the guard judged rules in the window and the model changed nothing. */
export function formatHeld(counts: ImproveCounts, rules: number): string {
  return `The rules held in the last ${counts.days} day${counts.days === 1 ? "" : "s"}: ${rules} rule${rules === 1 ? "" : "s"} judged ${counts.refusals.judged} time${counts.refusals.judged === 1 ? "" : "s"}, ${counts.refusals.fired} fired, ${counts.refusals.cleared} cleared on a later edit; ${counts.repeats.total} calls flagged as repeats, ${counts.repeatedRequests} requests typed twice in ${counts.sessions} session${counts.sessions === 1 ? "" : "s"}; nothing to change in pi-warden.md.`;
}

/**
 * The closing sentence when the guard judged nothing. That is not the rules holding: no judgment was made, so it says
 * nothing about the rules, and the counts that do exist are named instead.
 */
export function formatUnknownRules(counts: ImproveCounts): string {
  return `The rules guard judged nothing for this project in the last ${counts.days} day${counts.days === 1 ? "" : "s"}, so nothing is known about the rules. The sessions still measured ${counts.turns} turn${counts.turns === 1 ? "" : "s"}, ${counts.toolCalls} tool call${counts.toolCalls === 1 ? "" : "s"}, ${counts.repeats.total} calls flagged as repeats, ${counts.repeatedRequests} requests typed twice and ${counts.refusals.holds} hold${counts.refusals.holds === 1 ? "" : "s"}.`;
}

export function formatEmpty(days: number): string {
  return `Nothing to learn from yet: this project has no recorded sessions in the last ${days} day${days === 1 ? "" : "s"}.`;
}

/** A byte count as the head line shows it. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The head line: what the scan actually cost in time, files and bytes. It prints no budget, because a budget the pass
 * misses is a claim it did not keep.
 */
export function formatScan(options: { days: number; read: number; found: number; skipped: number; bytes: number; elapsedMs: number }): string {
  const files = options.found > options.read ? `${options.read} of ${options.found} session files read` : `${options.read} session file${options.read === 1 ? "" : "s"} read`;
  return `pi-warden improve: last ${options.days} day${options.days === 1 ? "" : "s"}, ${files}, ${options.skipped} skipped, ${formatBytes(options.bytes)} in ${Math.round(options.elapsedMs)} ms.`;
}

// ── the diff and the write ───────────────────────────────────────────────────

/** One hunk of a line diff: the lines removed and added at one place, with the line number on each side. */
export interface DiffHunk {
  at: number;
  removed: string[];
  added: string[];
}

/** Line-level hunks between two texts, longest common subsequence, so the screen and the file agree. */
export function diffLines(before: string, after: string): DiffHunk[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i]![j] = left[i] === right[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  let current: DiffHunk | undefined;
  const open = (at: number) => {
    current ??= { at, removed: [], added: [] };
    return current;
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      if (current) { hunks.push(current); current = undefined; }
      i++;
      j++;
      continue;
    }
    if (j < right.length && (i >= left.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      open(i + 1).added.push(right[j]!);
      j++;
      continue;
    }
    open(i + 1).removed.push(left[i]!);
    i++;
  }
  if (current) hunks.push(current);
  return hunks;
}

/** The diff as the screen shows it: context kept to one line either side, the rest elided. */
export function formatDiff(before: string, after: string, context = 1): string {
  const hunks = diffLines(before, after);
  if (!hunks.length) return "no change";
  const left = before.split("\n");
  const out: string[] = [];
  let shown = -2;
  for (const hunk of hunks) {
    if (hunk.at - shown > context + 2) out.push(`@@ line ${hunk.at}`);
    else for (let index = Math.max(shown + 1, hunk.at - context); index < hunk.at - 1; index++) out.push(`  ${left[index] ?? ""}`);
    for (const line of hunk.removed) out.push(`- ${line}`);
    for (const line of hunk.added) out.push(`+ ${line}`);
    shown = hunk.at - 1;
  }
  return out.join("\n");
}

/** The backup path beside the file: the file name, the UTC time, and `.bak`. */
export function backupPathFor(file: string, now = Date.now()): string {
  return `${file}.bak-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
}

export interface BackupResult {
  path?: string;
  error?: string;
}

/**
 * Copies the rules file to a timestamped name beside it before the model's turn, through a temporary name and a rename.
 * The rules file itself is untouched: the model edits it, and the pass compares against this copy afterwards.
 */
export async function backupRulesFile(file: string, before: string, now = Date.now()): Promise<BackupResult> {
  const path = backupPathFor(file, now);
  try {
    await writeFileAtomic(path, before);
  } catch (error) {
    return { error: `warden: the backup of ${file} could not be written (${error instanceof Error ? error.message : String(error)}); the model's turn was not started.` };
  }
  return { path };
}

// ── the hold logs ────────────────────────────────────────────────────────────

/**
 * The holds recorded in the window for the given sessions, by kind. The hold log is one file per session, named
 * `<date>-<session>.jsonl`, so the window is read from the file name and the project from the session ids.
 */
export async function readHolds(options: {
  sessions: readonly string[];
  days: number;
  now?: number;
  dirs?: HostDirs;
}): Promise<Array<{ kind: string; at: number; session: string }>> {
  const dirs = options.dirs ?? defaultHostDirs();
  const dir = join(dirname(userConfigPath(dirs)), "holds");
  const names = await readdir(dir).catch(() => [] as string[]);
  const since = (options.now ?? Date.now()) - options.days * DAY_MS;
  const wanted = new Set(options.sessions);
  const holds: Array<{ kind: string; at: number; session: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const session = name.replace(/\.jsonl$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    if (!wanted.has(session)) continue;
    const text = await readFile(join(dir, name), "utf8").catch(() => undefined);
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record: { at?: unknown; tool?: unknown; patterns?: unknown; held?: unknown };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record.at !== "number" || record.at < since || record.held !== true) continue;
      const patterns = Array.isArray(record.patterns) ? record.patterns.filter((value): value is string => typeof value === "string") : [];
      holds.push({ kind: patterns[0] ?? (typeof record.tool === "string" ? record.tool : "hold"), at: record.at, session });
    }
  }
  return holds;
}

// ── the whole pass ───────────────────────────────────────────────────────────

export function rulesLogFile(cwd: string, dirs: HostDirs = defaultHostDirs()): string {
  return rulesLogPath(cwd, dirs);
}

/** The project's rules log and hold records, read once; a missing file is an empty log. */
export async function readRecords(cwd: string, dirs: HostDirs, readings: readonly SessionReading[], days: number, now: number) {
  const logPath = rulesLogPath(cwd, dirs);
  const records = await readRulesLog(logPath);
  const holds = await readHolds({ sessions: readings.map(reading => reading.session), days, now, dirs });
  return { logPath, records, holds };
}
