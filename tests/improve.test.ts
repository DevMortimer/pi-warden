import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  backupRulesFile, computeCounts, countLines, countRepeatedRequests, countRepeats, formatCounts, formatDiff, formatEmpty,
  formatHeld, formatScan, formatUnknownRules, gatherSessions, IMPROVE_MAX_DAYS, IMPROVE_DEFAULT_DAYS, improveRequest,
  measuredCitations, parseImproveArgs, QuietWindow, readSession, ruleNames, summariseRulesChange, QUIET_MAX_MS,
} from "../src/improve.js";
import type { ImproveCounts, SessionReading } from "../src/improve.js";
import type { RuleRecord } from "../src/rules-log.js";

const NOW = Date.parse("2026-01-05T00:00:00.000Z");
const CWD = "/scratch/project";

// ── builders ────────────────────────────────────────────────────────────────

interface Entry { type?: string; timestamp?: string; message?: Record<string, unknown>; cwd?: string; toolCallId?: string }

function sessionFile(cwd: string, entries: Entry[], at = "2026-01-04T10:00:00.000Z"): Buffer {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: at, cwd }),
    JSON.stringify({ type: "session_info", id: "i1", timestamp: at, name: "drive" }),
    ...entries.map(entry => JSON.stringify(entry)),
  ];
  return Buffer.from(`${lines.join("\n")}\n`);
}

function user(text: string, at = "2026-01-04T10:01:00.000Z"): Entry {
  return { type: "message", timestamp: at, message: { role: "user", content: text } };
}

function assistant(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, totalTokens?: number): Entry {
  return {
    type: "message",
    timestamp: "2026-01-04T10:02:00.000Z",
    message: {
      role: "assistant",
      content: calls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
      ...(totalTokens === undefined ? {} : { usage: { input: totalTokens - 10, output: 10, totalTokens } }),
    },
  };
}

function result(id: string, text: string, isError = false): Entry {
  return { type: "message", timestamp: "2026-01-04T10:03:00.000Z", message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError } };
}

function reading(path: string, calls: SessionReading["calls"], requests: string[] = []): SessionReading {
  return { path, session: "s1", turns: requests.length, toolCalls: calls.length, wholeFileReads: 0, calls, requests };
}

function ruleRecord(over: Partial<RuleRecord>): RuleRecord {
  return {
    at: "2026-01-04T10:00:00.000Z", session: "s1", path: "src/a.ts", tool: "write", id: "small-commits", name: "Small commits",
    outcome: "violation", violation: 0.9, threshold: 0.7, finding: true, ...over,
  };
}

const RULES = [
  "# Project rules",
  "",
  "## Small commits",
  "Keep each commit to one change.",
  "",
  "## Explain every command",
  "Say why before a command runs.",
  "",
].join("\n");

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-warden-improve-"));
});

after(() => rm(dir, { recursive: true, force: true }));

// ── the window argument ─────────────────────────────────────────────────────

test("window: 0, -1, 4.2, abc and 91 are each refused in one line, and 4 means four days", () => {
  assert.deepEqual(parseImproveArgs(""), { days: IMPROVE_DEFAULT_DAYS });
  assert.deepEqual(parseImproveArgs("4"), { days: 4 });
  assert.deepEqual(parseImproveArgs("1"), { days: 1 });
  for (const value of ["0", "-1", "4.2", "abc", "91", String(IMPROVE_MAX_DAYS + 1)]) {
    const parsed = parseImproveArgs(value);
    assert.ok("error" in parsed, `${value} must be refused`);
    assert.equal(parsed.error.split("\n").length, 1, `${value} is refused in one line`);
    assert.match(parsed.error, /Nothing was read/);
  }
  assert.match((parseImproveArgs("900") as { error: string }).error, new RegExp(`above the ${IMPROVE_MAX_DAYS}-day cap`));
});

// ── one session's counts ────────────────────────────────────────────────────

test("reading cost: turns, tool calls, whole-file reads and peak context come from the session file, not from a guess", () => {
  const data = sessionFile(CWD, [
    user("first turn"),
    assistant([
      { id: "a", name: "read", arguments: { path: "src/a.ts" } },
      { id: "b", name: "read", arguments: { path: "src/b.ts", offset: 1, limit: 20 } },
      { id: "c", name: "bash", arguments: { command: "ls" } },
    ], 21000),
    result("a", "file text"),
    user("second turn"),
    assistant([{ id: "d", name: "grep", arguments: { pattern: "x", path: "src/a.ts" } }], 32000),
  ]);
  const read = readSession(data, `${CWD}/2026-01-04T10-00-00-000Z_s1.jsonl`, CWD);
  assert.equal(read.session, "s1");
  assert.equal(read.turns, 2);
  assert.equal(read.toolCalls, 4);
  assert.equal(read.wholeFileReads, 1, "only the read with no offset and no limit covered a whole file");
  assert.equal(read.peakContext, 32000);
  assert.deepEqual(read.requests, ["first turn", "second turn"]);
  assert.equal(read.calls[0]!.result, "file text", "the tool result is matched to its call by id");
});

test("a session file with no recorded usage reports peak context as unavailable, never as zero", () => {
  const read = readSession(sessionFile(CWD, [user("one"), assistant([{ id: "a", name: "ls", arguments: {} }])]), join(CWD, "x_s2.jsonl"), CWD);
  assert.equal(read.peakContext, undefined);
  const counts = computeCounts({ days: 1, now: NOW, readings: [read], skipped: [], ruleRecords: [], holds: [], currentRules: [] });
  assert.equal(countLines(counts).find(line => line.label === "peak context")!.value, "unavailable");
});

test("gathering skips a session file from another project and one that does not parse, and reports the bytes it read", async () => {
  const sessions = await mkdtemp(join(dir, "sessions-"));
  const ours = sessionFile(CWD, [user("hello")]);
  const other = sessionFile("/scratch/other", [user("hello")]);
  const torn = Buffer.from('{"type":"session","cwd":"/scratch/project"}\nnot json\n{"type":"message","message":{"role":"user","content":"hi"}}\n');
  await writeFile(join(sessions, "2026-01-04T10-00-00-000Z_ours.jsonl"), ours);
  await writeFile(join(sessions, "2026-01-04T10-00-00-000Z_other.jsonl"), other);
  await writeFile(join(sessions, "2026-01-04T10-00-00-000Z_torn.jsonl"), torn);
  const gather = await gatherSessions({ dir: sessions, cwd: CWD, days: 30, now: NOW });
  assert.equal(gather.readings.length, 2, "our session and the torn one with one readable line are read");
  assert.deepEqual(gather.skipped.map(skip => skip.reason), ["another project (/scratch/other)"]);
  assert.equal(gather.bytes, ours.byteLength + other.byteLength + torn.byteLength, "the scan reports every byte it read, skipped files included");
});

test("gathering counts a file whose entries are all unreadable as skipped, so an empty file is never a finding", async () => {
  const sessions = await mkdtemp(join(dir, "empty-"));
  await writeFile(join(sessions, "2026-01-04T10-00-00-000Z_none.jsonl"), sessionFile(CWD, []));
  const gather = await gatherSessions({ dir: sessions, cwd: CWD, days: 30, now: NOW });
  assert.equal(gather.readings.length, 0);
  assert.equal(gather.skipped.length, 1);
  assert.match(gather.skipped[0]!.reason, /no readable entries/);
});

// ── repeated work ───────────────────────────────────────────────────────────

test("repeats: a page-through is counted by the guard's own paging detector, one flagged call per read past the third", () => {
  const pageThrough = (file: string, count: number) => [1, 21, 41, 61].slice(0, count)
    .map(start => ({ tool: "read", input: { path: file, offset: start, limit: 20 }, cwd: CWD, failed: false, result: "" }));
  const repeats = countRepeats([reading("a.jsonl", pageThrough("src/big.ts", 3))]);
  assert.equal(repeats.byDetector.paging, 1, "the third adjacent read is the first flagged one");
  assert.equal(repeats.total, 1);
  assert.deepEqual(repeats.sessions.paging, ["a.jsonl"]);
  assert.equal(countRepeats([reading("a.jsonl", pageThrough("src/big.ts", 2))]).total, 0, "two reads are not a page-through");
  assert.equal(countRepeats([reading("a.jsonl", pageThrough("src/big.ts", 4))]).byDetector.paging, 2);
});

test("repeats: the same request typed twice is counted; a different request is not", () => {
  const first = reading("a.jsonl", [], ["run the unit tests with coverage"]);
  const again = reading("b.jsonl", [], ["please run the unit tests with coverage"]);
  const other = reading("c.jsonl", [], ["write the changelog entry"]);
  assert.equal(countRepeatedRequests([first, again, other]), 1);
  assert.equal(countRepeatedRequests([first, other]), 0);
});

test("count labels: a call a waste detector flagged and a request typed twice are two different lines", () => {
  const calls = [1, 21, 41].map(start => ({ tool: "read", input: { path: "src/big.ts", offset: start, limit: 20 }, cwd: CWD, failed: false, result: "" }));
  const counts = countsFor({ readings: [reading("a.jsonl", calls)] });
  const labels = countLines(counts).map(line => line.label);
  assert.ok(labels.includes("calls flagged as repeats"));
  assert.ok(labels.includes("requests typed twice"));
  const text = formatCounts(counts);
  assert.match(text, /calls flagged as repeats: 1/, "the detector count says what it counts");
  assert.match(text, /requests typed twice: 0/, "the user's typed requests are their own line");
  assert.doesNotMatch(text, /repeated calls:/, "the old label that mixed the two is gone");
});

// ── nothing to learn ────────────────────────────────────────────────────────

const emptyCounts = (): ImproveCounts => computeCounts({ days: 7, now: NOW, readings: [], skipped: [], ruleRecords: [], holds: [], currentRules: [] });

function countsFor(options: { records?: RuleRecord[]; readings?: SessionReading[]; holds?: Array<{ kind: string }>; rules?: Array<{ id: string; name: string }> } = {}): ImproveCounts {
  return computeCounts({
    days: 7, now: NOW,
    readings: options.readings ?? [reading("2026-01-04T10-00-00-000Z_s1.jsonl", [], ["fix the bug"])],
    skipped: [], ruleRecords: options.records ?? [], holds: options.holds ?? [], currentRules: options.rules ?? [],
  });
}

test("no records: the pass says there is nothing to learn from yet and starts no model turn", () => {
  const counts = emptyCounts();
  assert.equal(counts.sessions, 0);
  assert.match(formatEmpty(7), /no recorded sessions in the last 7 days/);
  const request = improveRequest({ days: 7, counts, countsText: formatCounts(counts), read: [], skipped: [], rulesText: RULES, file: "pi-warden.md" });
  assert.ok("reason" in request, "no session and no rules record means no prompt");
  assert.match(request.reason, /Nothing to learn from yet/);
});

test("zero judgments: the pass says nothing is known about the rules, never that they held", () => {
  const counts = countsFor({});
  const line = formatUnknownRules(counts);
  assert.equal(counts.refusals.judged, 0);
  assert.match(line, /The rules guard judged nothing for this project in the last 7 days/);
  assert.match(line, /nothing is known about the rules/);
  assert.doesNotMatch(line, /held/i);
  assert.match(line, /1 turn/);
  assert.match(line, /0 calls flagged as repeats/);
  assert.match(line, /0 holds/);
});

test("judged rules and no fire: the pass says the rules held, with the counts that show it", () => {
  const records = [
    ruleRecord({ finding: false, outcome: "compliant", violation: 0.1 }),
    ruleRecord({ at: "2026-01-04T11:00:00.000Z", finding: false, outcome: "compliant", violation: 0.1 }),
  ];
  const counts = countsFor({ records, rules: [{ id: "small-commits", name: "Small commits" }] });
  assert.equal(counts.refusals.judged, 2);
  assert.equal(counts.refusals.fired, 0);
  const line = formatHeld(counts, 1);
  assert.match(line, /The rules held in the last 7 days/);
  assert.match(line, /1 rule judged 2 times, 0 fired/);
  assert.match(line, /nothing to change in pi-warden\.md/);
});

// ── the prompt the model gets ───────────────────────────────────────────────

function supportedCounts(): { counts: ImproveCounts; records: RuleRecord[] } {
  const records = [
    ruleRecord({ path: "src/a.ts" }), ruleRecord({ path: "src/a.ts" }), ruleRecord({ path: "src/b.ts" }),
    ruleRecord({ id: "explain-every-command", name: "Explain every command", finding: false, violation: 0.1, outcome: "compliant", path: "src/c.ts" }),
  ];
  const counts = countsFor({ records, rules: [{ id: "small-commits", name: "Small commits" }, { id: "explain-every-command", name: "Explain every command" }] });
  return { counts, records };
}

test("prompt: the model is told the window, every printed count, the files read and skipped, the rules text, and the rules of the edit", () => {
  const { counts } = supportedCounts();
  const request = improveRequest({
    days: 7, counts, countsText: formatCounts(counts),
    read: ["/scratch/project/sessions/a.jsonl"], skipped: [{ path: "/scratch/project/sessions/b.jsonl", reason: "another project (/scratch/other)" }],
    rulesText: RULES, file: "pi-warden.md",
  });
  assert.ok("prompt" in request);
  const prompt = request.prompt;
  assert.match(prompt, /last 7 days/, "the window is named");
  for (const line of countLines(counts)) assert.ok(prompt.includes(`${line.label}: ${line.value}`), `${line.label} is printed to the model`);
  assert.ok(prompt.includes("/scratch/project/sessions/a.jsonl"), "a session file read is named");
  assert.ok(prompt.includes("/scratch/project/sessions/b.jsonl (another project (/scratch/other))"), "a skipped file and its reason are named");
  assert.ok(prompt.includes("## Small commits") && prompt.includes("Keep each commit to one change."), "the rules file text is carried");
  assert.match(prompt, /Change a rule only for a count printed above/);
  assert.match(prompt, /Measured YYYY-MM-DD/);
  assert.match(prompt, /session file it came from/);
  assert.match(prompt, /the rules held/);
  assert.match(prompt, /judged nothing/);
  assert.match(prompt, /at most 3 rule changes/);
  assert.match(prompt, /Do not add a second section/i, "the model is told a second run must not duplicate a rule");
  assert.match(prompt, /Hand-over bound/);
  assert.match(prompt, /Do not scan directories/);
  assert.match(prompt, /calls flagged as repeats/);
  assert.match(prompt, /requests typed twice/);
});

// ── the summary after the turn ──────────────────────────────────────────────

test("summary: an added, a changed and a removed rule are each named, and each added or changed rule names the count it cites", () => {
  const { counts } = supportedCounts();
  const after = RULES
    .replace("Keep each commit to one change.", "Keep each commit to one change.\n\nMeasured 2026-01-05: 3 of 4 judgments against \"Small commits\" in the last 7 days were violations.")
    .replace("## Explain every command\nSay why before a command runs.\n", "")
    + "## Read a file in one call\nRead one file with one call.\n\nMeasured 2026-01-05: 1 request typed twice in the last 7 days.\n";
  assert.deepEqual(ruleNames(after), ["Project rules", "Small commits", "Read a file in one call"]);
  const summary = summariseRulesChange(RULES, after, counts);
  assert.deepEqual(summary.changed, ["Small commits"]);
  assert.deepEqual(summary.added, ["Read a file in one call"]);
  assert.deepEqual(summary.removed, ["Explain every command"]);
  assert.deepEqual(summary.uncited, [], "both cited a number the pass printed");
  assert.ok(summary.lines.some(line => line.startsWith("~ changed \"Small commits\"") && /rules fired 3/.test(line)), "the changed rule names the count it cited");
  assert.ok(summary.lines.some(line => line.startsWith("+ added \"Read a file in one call\"") && / 1$/.test(line)), "the added rule names the count it cited");
  assert.ok(summary.lines.includes("- removed \"Explain every command\""));
  assert.equal(summary.lines.filter(line => line.includes("Project rules")).length, 0, "the title heading does not count as a changed rule");
});

test("summary: a changed rule with no Measured line is named and its edit stays in the file", () => {
  const { counts } = supportedCounts();
  const after = RULES.replace("Say why before a command runs.", "Say why before a command runs, in one sentence.");
  const summary = summariseRulesChange(RULES, after, counts);
  assert.deepEqual(summary.changed, ["Explain every command"]);
  assert.deepEqual(summary.uncited, ["Explain every command"]);
  assert.match(summary.lines[0]!, /no Measured line with a number this pass printed/);
  assert.ok(after.includes("in one sentence"), "the pass names the rule; it does not revert the model's edit");
});

test("citation: a Measured line's date and its window phrase are not counts, and only printed numbers count", () => {
  const { counts } = supportedCounts();
  assert.deepEqual(measuredCitations("## R\nMeasured 2026-01-05: 3 of 4 judgments, in the last 7 days.", counts), [3, 4], "printed numbers count and the window's 7 does not");
  assert.deepEqual(measuredCitations("## R\nMeasured 2026-01-05: 9999 judgments in the last 7 days.", counts), [], "a number the pass did not print is no citation");
  const after = RULES.replace("Say why before a command runs.", "Say why before a command runs.\n\nMeasured 2026-01-05: 9999 judgments in the last 7 days.");
  assert.deepEqual(summariseRulesChange(RULES, after, counts).uncited, ["Explain every command"]);
});

test("citation: a session path or a session id in the Measured line is where the count came from, not a count", () => {
  const counts = countsFor({ holds: [{ kind: "a" }, { kind: "b" }] });
  const line = "Measured 2026-01-05: holds 2 (/scratch/sessions/147791_01a159a7-aec7-7699-a919-5fd9f43eff66.jsonl).";
  assert.deepEqual(measuredCitations(`## R\n${line}`, counts), [2], "the path's digits and the id's digits are not citations");
  assert.deepEqual(measuredCitations("## R\nMeasured 2026-01-05: 2 holds in 99f9c9d9-aec7-7699-a919-5fd9f43eff66.", counts), [2]);
});

// ── the scan line and the diff ──────────────────────────────────────────────

test("scan line: the pass prints the time, files and bytes it measured, not a budget it missed", () => {
  const line = formatScan({ days: 7, read: 2, found: 3, skipped: 1, bytes: 1_572_864, elapsedMs: 441.4 });
  assert.match(line, /last 7 days/);
  assert.match(line, /2 of 3 session files read/);
  assert.match(line, /1 skipped/);
  assert.match(line, /1\.5 MB/);
  assert.match(line, /441 ms/);
  assert.doesNotMatch(line, /budget/i);
});

test("diff: the screen shows only the lines the model changed", () => {
  const after = RULES.replace("Keep each commit to one change.", "Keep each commit to one change, and say what it does.");
  const diff = formatDiff(RULES, after);
  assert.equal(diff.split("\n").filter(line => line.startsWith("+ ")).length, 1);
  assert.equal(diff.split("\n").filter(line => line.startsWith("- ")).length, 1);
});

// ── the backup before the turn ──────────────────────────────────────────────

test("backup: the rules file is copied beside itself before the turn, and the file itself is left for the model", async () => {
  const file = join(await mkdtemp(join(dir, "backup-")), "pi-warden.md");
  await writeFile(file, RULES);
  const first = await backupRulesFile(file, RULES, NOW);
  assert.ok(first.path, "a backup path is returned");
  assert.match(first.path, /\.bak-2026-01-05T00-00-00-000Z$/);
  assert.equal(await readFile(first.path, "utf8"), RULES, "the backup holds the file as it was");
  assert.equal(await readFile(file, "utf8"), RULES, "the pass does not write the rules file; the model does");
  const second = await backupRulesFile(file, RULES, NOW + 1000);
  assert.ok(second.path && second.path !== first.path, "a second run takes its own timestamped backup");
  const names = await readdir(join(file, ".."));
  assert.equal(names.length, 3, "the file and the two backups, and nothing else");
});

// ── the quiet window ────────────────────────────────────────────────────────

test("quiet: a window armed by one session is dead for another session and dead after its expiry", () => {
  const quiet = new QuietWindow();
  const armed = quiet.arm("session-a", 60_000, NOW);
  assert.equal(quiet.active("session-a", NOW + 1000), true);
  assert.equal(quiet.active("session-b", NOW + 1000), false, "another session keeps judging");
  assert.equal(quiet.active(undefined, NOW + 1000), false);
  assert.equal(quiet.statusLine("session-b", NOW + 1000), undefined, "another session does not see the window");
  assert.ok(quiet.statusLine("session-a", NOW + 1000));
  assert.equal(quiet.active("session-a", armed.until), false, "the window is ignored at its expiry");
  assert.equal(quiet.statusLine("session-a", armed.until + 1), undefined);
});

test("quiet: the window is capped at fifteen minutes, and a zero setting arms nothing", () => {
  const quiet = new QuietWindow();
  assert.equal(quiet.arm("s", 60_000_000, NOW).ms, QUIET_MAX_MS);
  assert.equal(quiet.active("s", NOW + QUIET_MAX_MS + 1), false);
  const off = quiet.arm("s", 0, NOW);
  assert.equal(off.ms, 0);
  assert.equal(quiet.active("s", NOW + 1), false, "improve.quietMs 0 leaves the rules judge on");
});

test("quiet: a disarm leaves no window behind, so a second /warden improve is not refused", () => {
  const quiet = new QuietWindow();
  quiet.arm("session-a", 600_000, NOW);
  assert.ok(quiet.statusLine("session-a", NOW));
  quiet.disarm();
  assert.equal(quiet.statusLine("session-a", NOW), undefined);
  assert.equal(quiet.active("session-a", NOW), false);
});
