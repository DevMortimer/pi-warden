import { isAbsolute, resolve as resolvePath } from "node:path";
import { commandOf } from "./tools.js";
import { shellWrites } from "./shell-writes.js";

/**
 * Call-waste notes. Each tool call re-reads the whole conversation, so the number of calls drives the cost of a run.
 * Four patterns of work that spends calls for nothing earn one advisory sentence, attached to the tool result that
 * triggers it: the result already goes to the model, so the note costs no extra call. A note never blocks a call,
 * never changes a hold, never spends the steer budget, and makes no model or TypeSafe request.
 *
 * The detectors and their thresholds come from a measurement over existing sessions; see the guards documentation.
 */

/** Calls of recent history a detector may look at, and the smallest run of page reads worth naming. */
export const WASTE_WINDOW = 10;
const MIN_READS = 3;
const SMALL_READ_LINES = 100;
/** A read that starts no more than this many lines past the furthest line already asked for is adjacent to it. */
const ADJACENT_GAP = 20;

export const WASTE_TIP = "Tool calls are expensive: each one re-reads the whole conversation. Read files in large ranges or whole, not a few lines at a time. Run a check once without a pipe and search its output rather than re-running it. Wait for slow work with one blocking command, not repeated sleeps.";

export interface WasteConfig {
  enabled: boolean;
  tip: boolean;
  every: number;
  sleep: boolean;
  paging: boolean;
  search: boolean;
  recheck: boolean;
}

export type WasteDetector = "sleep" | "paging" | "search" | "recheck";

/** What a detector needs from one finished tool call: its name, input, working directory, failure flag, and result text. */
export interface WasteCall {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  failed: boolean;
  result: string;
}

export interface WasteNudge {
  detector: WasteDetector;
  /** The file, check, or wait count the note names, for the trace line. */
  subject: string;
  text: string;
}

const DETECTORS: readonly WasteDetector[] = ["sleep", "paging", "search", "recheck"];

/** `appendSystemPrompt` is the host's own append slot, so the tip lands after the prompt instead of replacing it. */
export function withWasteTip(current: string | undefined, tip = WASTE_TIP): string {
  const base = (current ?? "").trim();
  if (base.includes(tip)) return base;
  return base ? `${base}\n\n${tip}` : tip;
}

// ── shell text ───────────────────────────────────────────────────────────────

interface Segment {
  text: string;
  /** The top-level operator that preceded this segment, or undefined for the first one. */
  sep: string | undefined;
  /** Where the segment starts in the command text. */
  start: number;
}

/** Index of the `)` matching the `(` at `open`, skipping quoted text; the command length when there is no match. */
function matchingParen(command: string, open: number): number {
  let depth = 0;
  for (let index = open; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\\") { index++; continue; }
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return command.length;
}

/** Split at top-level `|`, `&&`, `||`, `;`, `&`, and newlines; pipes inside quotes or `$( … )` stay put. */
function shellSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  let sep: string | undefined;
  let quote: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "\\") { index++; continue; }
    if (char === "`") { const end = command.indexOf("`", index + 1); index = end === -1 ? command.length : end; continue; }
    if (char === "$" && command[index + 1] === "(") { index = matchingParen(command, index + 1); continue; }
    let operator: string | undefined;
    if (char === "\n") operator = "\n";
    else if (char === ";") operator = ";";
    else if (char === "&") operator = command[index + 1] === "&" ? "&&" : "&";
    else if (char === "|") operator = command[index + 1] === "|" ? "||" : "|";
    if (operator === undefined) continue;
    segments.push({ text: command.slice(start, index), sep, start });
    index += operator.length - 1;
    start = index + 1;
    sep = operator;
  }
  segments.push({ text: command.slice(start), sep, start });
  return segments;
}

/** Words of one already-split segment, unquoted; no expansion. */
function words(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') { current += text[++index] ?? ""; continue; }
      if (char === quote) { quote = undefined; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "\\") { current += text[++index] ?? ""; continue; }
    if (char === " " || char === "\t" || char === "\n") {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

const CD_PREFIX = /^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*&&\s*/;

/** The command with a leading `cd DIR &&` removed, and DIR when there was one. */
function stripCd(command: string): { command: string; dir?: string } {
  const match = CD_PREFIX.exec(command);
  if (!match) return { command };
  const dir = match[0].replace(/^\s*cd\s+/, "").replace(/\s*&&\s*$/, "").trim().replace(/^['"]|['"]$/g, "");
  return { command: command.slice(match[0].length), dir };
}

function absolute(cwd: string, dir: string | undefined, path: string): string {
  return isAbsolute(path) ? path : resolvePath(cwd, dir ?? ".", path);
}

/** A path carried by a call, resolved the way a shell would from the call's working directory. */
function resolveTarget(call: WasteCall, dir: string | undefined, raw: string): string {
  return absolute(call.cwd, dir, raw.replace(/^~(?=\/|$)/, "."));
}

// ── writes ───────────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(["write", "edit", "edit_lines", "apply_patch", "multiedit"]);
const PATH_WRITERS = new Set(["cp", "mv", "rm", "ln", "install", "touch", "truncate", "tee", "patch", "rsync"]);

/** Paths written from one bash segment: redirect targets, `tee`, and the path-writing verbs. */
function bashWriteTargets(segment: string): string[] {
  const out: string[] = [];
  for (const match of segment.matchAll(/(?:^|\s)\d*>>?\s*('([^']*)'|"([^"]*)"|([^\s;&|]+))/g)) {
    const target = match[2] ?? match[3] ?? match[4];
    if (target) out.push(target);
  }
  const toks = words(segment);
  const head = toks[0];
  if (!head) return out;
  if ((head === "sed" || head === "gsed") && toks.some(token => token === "-i" || token.startsWith("--in-place"))) {
    const candidate = toks.at(-1);
    if (candidate && !candidate.startsWith("-")) out.push(candidate);
    return out;
  }
  if (!PATH_WRITERS.has(head.replace(/^(?:sudo|command|env|xargs)$/, ""))) return out;
  for (const token of toks.slice(1)) if (!token.startsWith("-")) out.push(token);
  return out;
}

/** Every path this call writes, resolved; empty when it writes nothing. */
export function writtenPaths(call: WasteCall): string[] {
  const input = call.input;
  if (WRITE_TOOLS.has(call.tool)) {
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
    return path ? [absolute(call.cwd, undefined, path)] : [];
  }
  if (call.tool === "bash" && typeof input.command !== "string") return [];
  const view = commandOf(call.tool, input);
  if (!view || !view.shell) return [];
  const { command, dir } = stripCd(view.command);
  const out = shellWrites(command).writes.map(write => resolveTarget(call, dir, write.path));
  for (const segment of shellSegments(command)) {
    for (const target of bashWriteTargets(segment.text)) out.push(resolveTarget(call, dir, target));
  }
  return [...new Set(out)];
}

// ── D1 sleep polling ─────────────────────────────────────────────────────────

const SLEEP_ONLY = /^sleep\s+(\d+(?:\.\d+)?)$/;
const SLEEP_THEN = /^sleep\s+(\d+(?:\.\d+)?)\s*(?:;|&&)\s*([\s\S]+)$/;
const LOOP_KEYWORD = /(?:^|[\s;&|()])(?:while|until|for)\b/;
/** Longest follow-up still read as one status command rather than a chain of work. */
const STATUS_LIMIT = 200;

/**
 * A poll: `sleep N`, optionally after `cd DIR &&`, optionally followed by `;`/`&&` and one short status command, which
 * may be piped (`sleep 5; curl -s URL | jq .x`). A loop that sleeps, and a follow-up of two or more commands, wait for
 * something real and are not polls.
 */
export function isSleepPoll(command: string): boolean {
  const text = stripCd(command).command.trim();
  if (!text || LOOP_KEYWORD.test(text)) return false;
  if (SLEEP_ONLY.test(text)) return true;
  const match = SLEEP_THEN.exec(text);
  if (!match) return false;
  const status = match[2]!.trim();
  if (!status || status.length > STATUS_LIMIT) return false;
  return shellSegments(status).every(segment => segment.sep === undefined || segment.sep === "|");
}

/** Fires on the 2nd poll of the last `WASTE_WINDOW` calls. */
export function sleepNudge(window: readonly WasteCall[]): WasteNudge | undefined {
  const current = window.at(-1);
  if (!current) return undefined;
  const view = commandOf(current.tool, current.input);
  if (!view || !view.shell || !isSleepPoll(view.command)) return undefined;
  const polls = window.filter(call => {
    const seen = commandOf(call.tool, call.input);
    return Boolean(seen?.shell && isSleepPoll(seen.command));
  }).length;
  if (polls < 2) return undefined;
  return {
    detector: "sleep",
    subject: `${polls} waits in ${window.length} calls`,
    text: `You have waited ${polls} times in the last ${window.length} calls. Wait once instead: one sleep long enough, or a blocking command such as \`gh pr checks --watch\`.`,
  };
}

// ── D2-A paging ──────────────────────────────────────────────────────────────

interface RangeRead {
  file: string;
  /** The path as the agent wrote it, for the note. */
  path: string;
  /** Line numbers, absent for a read whose start is unknowable (`tail -n`). */
  start?: number;
  end?: number;
}

const SED_RANGE = /^(\d+),(\d+)p$/;
const AWK_RANGE = /NR\s*>=\s*(\d+)\s*&&\s*NR\s*<=\s*(\d+)/;

function lineCount(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (const char of text) if (char === "\n") lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** The last word that is not a flag: the file in `sed -n '1,5p' FILE`, `head -n 20 FILE`, `awk … FILE`. */
function fileWord(rest: readonly string[]): string | undefined {
  for (let index = rest.length - 1; index >= 0; index--) {
    const token = rest[index]!;
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

/** A range read of one file: a `read` with offset or limit, `sed -n 'a,bp'`, `head`/`tail -n N`, or `awk 'NR>=a && NR<=b'`. */
export function rangeRead(call: WasteCall): RangeRead | undefined {
  const input = call.input;
  if (call.tool === "read") {
    const path = typeof input.path === "string" ? input.path : undefined;
    if (!path) return undefined;
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    if (offset === undefined && limit === undefined) return undefined;
    const start = offset ?? 1;
    const lines = limit ?? lineCount(call.result);
    if (lines < 1 || lines > SMALL_READ_LINES) return undefined;
    return { file: absolute(call.cwd, undefined, path), path, start, end: start + lines - 1 };
  }
  const view = commandOf(call.tool, input);
  // A program's own reads (`python -c`, a heredoc, an interpreter) are not reads of the agent; only a lone shell read command is.
  if (!view || !view.shell || /<</.test(view.command)) return undefined;
  const { command, dir } = stripCd(view.command);
  const segments = shellSegments(command);
  if (segments.length !== 1) return undefined;
  const toks = words(segments[0]!.text);
  const head = toks[0];
  if (!head) return undefined;
  const rest = toks.slice(1);
  const file = fileWord(rest);
  if (!file) return undefined;
  const resolved = { file: resolveTarget(call, dir, file), path: file };
  if (head === "sed" || head === "gsed") {
    if (!rest.includes("-n") && !rest.some(token => token.startsWith("--quiet") || token.startsWith("--silent"))) return undefined;
    const script = rest.map(token => SED_RANGE.exec(token)).find(Boolean);
    if (!script) return undefined;
    return { ...resolved, start: Number(script[1]), end: Number(script[2]) };
  }
  if (head === "head" || head === "tail") {
    let count: number | undefined;
    for (let index = 0; index < rest.length; index++) {
      const token = rest[index]!;
      if (token === "-n") { count = Number(rest[index + 1]); break; }
      if (/^-\d+$/.test(token)) { count = Number(token.slice(1)); break; }
      if (/^--lines=\d+$/.test(token)) { count = Number(token.slice(8)); break; }
    }
    if (count === undefined || !Number.isFinite(count) || count < 1 || count > SMALL_READ_LINES) return undefined;
    return head === "head" ? { ...resolved, start: 1, end: count } : resolved;
  }
  if (head === "awk" || head === "gawk") {
    const script = rest.map(token => AWK_RANGE.exec(token)).find(Boolean);
    if (!script) return undefined;
    return { ...resolved, start: Number(script[1]), end: Number(script[2]) };
  }
  return undefined;
}

/** Every read starts at or before the furthest line already asked for, plus the gap. An unknown range is not adjacent. */
function allAdjacent(reads: readonly RangeRead[]): boolean {
  if (reads.some(read => read.start === undefined || read.end === undefined)) return false;
  const sorted = [...reads].sort((a, b) => a.start! - b.start!);
  let furthest = sorted[0]!.end!;
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]!.start! > furthest + ADJACENT_GAP) return false;
    furthest = Math.max(furthest, sorted[index]!.end!);
  }
  return true;
}

/** Fires on the 3rd adjacent range read of one file in the last `WASTE_WINDOW` calls with no write to it between. */
export function pagingNudge(window: readonly WasteCall[]): WasteNudge | undefined {
  const current = window.at(-1);
  if (!current) return undefined;
  const trigger = rangeRead(current);
  if (!trigger) return undefined;
  const reads: RangeRead[] = [];
  let first = -1;
  let last = -1;
  window.forEach((call, index) => {
    const read = rangeRead(call);
    if (!read || read.file !== trigger.file) return;
    if (first === -1) first = index;
    last = index;
    reads.push(read);
  });
  if (reads.length < MIN_READS || !allAdjacent(reads)) return undefined;
  if (window.slice(first + 1, last).some(call => writtenPaths(call).includes(trigger.file))) return undefined;
  const lo = Math.min(...reads.map(read => read.start!));
  const hi = Math.max(...reads.map(read => read.end!));
  return {
    detector: "paging",
    subject: trigger.path,
    text: `You read ${trigger.path} in ${reads.length} calls and the parts run from line ${lo} to ${hi} without a gap. One \`read\` with offset=${lo}, limit=${hi - lo + 1} returns the same lines.`,
  };
}

// ── D2-B repeated search ─────────────────────────────────────────────────────

interface SearchRead {
  file: string;
  path: string;
  pattern: string;
}

/** Flags that take the next word, so it is not read as the pattern or the file. */
const VALUE_FLAGS = new Set(["-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C", "--include", "--exclude", "--label", "-t", "--type"]);

/** `grep`/`rg` on one named file: pattern, file, and no recursion and no glob. */
export function searchRead(call: WasteCall): SearchRead | undefined {
  const view = commandOf(call.tool, call.input);
  if (!view || !view.shell) return undefined;
  const { command, dir } = stripCd(view.command);
  const first = shellSegments(command)[0];
  if (!first) return undefined;
  const toks = words(first.text);
  const head = toks[0];
  if (head !== "grep" && head !== "rg") return undefined;
  let pattern: string | undefined;
  const operands: string[] = [];
  for (let index = 1; index < toks.length; index++) {
    const token = toks[index]!;
    if (token === "-e" || token === "--regexp") { pattern = toks[++index]; continue; }
    if (VALUE_FLAGS.has(token)) { index++; continue; }
    if (token.startsWith("-")) {
      if (/[rR]/.test(token) || token === "--recursive" || token === "--dereference-recursive") return undefined;
      continue;
    }
    operands.push(token);
  }
  const flagged = pattern !== undefined;
  const file = flagged ? operands[0] : operands[1];
  if (!flagged) pattern = operands[0];
  if (!pattern || !file || operands.length !== (flagged ? 1 : 2)) return undefined;
  if (/[*?[\]{}]/.test(file)) return undefined;
  return { file: resolveTarget(call, dir, file), path: file, pattern };
}

/** Identical patterns, one contained in the other, or a shared `-E` alternative. */
export function patternsOverlap(left: string, right: string): boolean {
  const one = left.trim();
  const two = right.trim();
  if (!one || !two) return false;
  if (one === two) return true;
  if (one.includes(two) || two.includes(one)) return true;
  const alternatives = (pattern: string) => new Set(pattern.split("|").map(part => part.trim()).filter(Boolean));
  const seen = alternatives(two);
  for (const alternative of alternatives(one)) if (seen.has(alternative)) return true;
  return false;
}

/** Fires on the 3rd search of one file in the last `WASTE_WINDOW` calls, two of them overlapping, with no write between. */
export function searchNudge(window: readonly WasteCall[]): WasteNudge | undefined {
  const current = window.at(-1);
  if (!current) return undefined;
  const trigger = searchRead(current);
  if (!trigger) return undefined;
  const searches: Array<{ index: number; search: SearchRead }> = [];
  window.forEach((call, index) => {
    const search = searchRead(call);
    if (search && search.file === trigger.file) searches.push({ index, search });
  });
  if (searches.length < MIN_READS) return undefined;
  const overlapping = searches.some((left, index) => searches.slice(index + 1).some(right => patternsOverlap(left.search.pattern, right.search.pattern)));
  if (!overlapping) return undefined;
  const first = searches[0]!.index;
  const last = searches.at(-1)!.index;
  if (window.slice(first + 1, last).some(call => writtenPaths(call).includes(trigger.file))) return undefined;
  return {
    detector: "search",
    subject: trigger.path,
    text: `You searched ${trigger.path} ${searches.length} times with the same or an overlapping pattern. The earlier hits are still in your results; reuse them, or widen the search once.`,
  };
}

// ── D3-C check re-run with filters ───────────────────────────────────────────

const CHECK_HEAD = /^(?:npm\s+(?:test|run\s+(?:check|test|lint|build|typecheck))|npx\s+tsc|tsc|eslint|vitest|jest|pytest|ruff|mypy|cargo\s+(?:test|check|build)|go\s+(?:test|build|vet)|make\s+(?:check|test|lint)|flutter\s+(?:test|analyze)|dart\s+analyze|(?:bun|pnpm|uv)\s+(?:run\s+)?(?:check|test|lint|build|typecheck|tsc|eslint|vitest|jest|pytest|ruff|mypy))(?=\s|$)/;
const REDIRECT_TAIL = /\s*(?:\d?>&\d+|\d?>>?|&>>?|&>)\s*(?:'[^']*'|"[^"]*"|\S*)$/;
const FILTER_HEADS = /^(?:tail|head|grep|rg)\b/;
const FAIL_SIGNAL = /fail [1-9]|FAIL|error TS|[1-9][0-9]* failed|Error:/;

interface CheckRun {
  /** Runner and target, with everything after the first top-level pipe or redirect dropped. */
  key: string;
  /** Everything after the first top-level pipe, or undefined when the run is unpiped. */
  filter?: string;
  /** True when the command threw its own output away in a pipe (`| tail`, `| head`, `| grep`, `| rg`). */
  cut: boolean;
}

/** Trailing redirects carry no part of the check, so they are not part of its key. */
function stripRedirects(text: string): string {
  let value = text.trim();
  for (let guard = 0; guard < 4; guard++) {
    const next = value.replace(REDIRECT_TAIL, "").trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

export function checkRun(call: WasteCall): CheckRun | undefined {
  const view = commandOf(call.tool, call.input);
  if (!view || !view.shell) return undefined;
  const { command } = stripCd(view.command);
  const segments = shellSegments(command);
  const head = segments[0];
  if (!head) return undefined;
  const lead = stripRedirects(head.text);
  if (!CHECK_HEAD.test(lead)) return undefined;
  const piped = segments.find(segment => segment.sep === "|");
  return {
    key: lead.replace(/\s+/g, " "),
    ...(piped ? { filter: command.slice(piped.start).trim() } : {}),
    cut: segments.some(segment => segment.sep === "|" && FILTER_HEADS.test(segment.text.trim())),
  };
}

/**
 * Fires when the same check runs again within `WASTE_WINDOW` calls and the two runs sliced the output differently: the
 * earlier run was cut by a pipe, showed no failure, and nothing wrote a file in between. A run whose result already
 * showed a failure is a failure to chase, not waste, and a re-run without a pipe has already taken the advice.
 */
export function recheckNudge(window: readonly WasteCall[]): WasteNudge | undefined {
  const current = window.at(-1);
  if (!current) return undefined;
  const trigger = checkRun(current);
  if (!trigger || trigger.filter === undefined) return undefined;
  let earlierIndex = -1;
  for (let index = window.length - 2; index >= 0; index--) {
    const run = checkRun(window[index]!);
    if (run && run.key === trigger.key) { earlierIndex = index; break; }
  }
  if (earlierIndex < 0) return undefined;
  const earlier = window[earlierIndex]!;
  const earlierRun = checkRun(earlier)!;
  if (!earlierRun.cut || earlierRun.filter === trigger.filter) return undefined;
  if (earlier.failed || FAIL_SIGNAL.test(earlier.result)) return undefined;
  if (window.slice(earlierIndex + 1, window.length - 1).some(call => writtenPaths(call).length > 0)) return undefined;
  const runs = window.filter(call => checkRun(call)?.key === trigger.key).length;
  return {
    detector: "recheck",
    subject: trigger.key,
    text: `You ran ${trigger.key} ${runs} times and filtered the output each time. Run it once without a pipe; the full output arrives, or is saved to a file you can search.`,
  };
}

const DETECT: Record<WasteDetector, (window: readonly WasteCall[]) => WasteNudge | undefined> = {
  sleep: sleepNudge,
  paging: pagingNudge,
  search: searchNudge,
  recheck: recheckNudge,
};

/**
 * Recent tool calls of one session, with the rate limit: one note per detector per `every` calls. A detector sees the
 * last `WASTE_WINDOW` calls including the one that just finished, and at most one note rides any single result.
 */
export class WasteTracker {
  private readonly calls: WasteCall[] = [];
  private seen = 0;
  private readonly lastFired = new Map<WasteDetector, number>();

  /** Records a finished call and returns the note to attach to its result, if any. */
  record(call: WasteCall, config: WasteConfig): WasteNudge | undefined {
    this.calls.push(call);
    this.seen++;
    if (this.calls.length > WASTE_WINDOW) this.calls.splice(0, this.calls.length - WASTE_WINDOW);
    if (!config.enabled) return undefined;
    for (const detector of DETECTORS) {
      if (!config[detector]) continue;
      const nudge = DETECT[detector](this.calls);
      if (!nudge) continue;
      const fired = this.lastFired.get(detector);
      if (fired !== undefined && this.seen - fired < config.every) continue;
      this.lastFired.set(detector, this.seen);
      return nudge;
    }
    return undefined;
  }

  reset(): void {
    this.calls.length = 0;
    this.seen = 0;
    this.lastFired.clear();
  }
}
