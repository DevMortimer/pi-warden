import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readRulesLog, RuleClearTracker, RulesLog, rulesLogPath, RULES_LOG_MAX_RECORDS, trimRecords } from "../src/rules-log.js";
import type { RuleRecord } from "../src/rules-log.js";
import { buildRulesReport, compareRows, formatRulesReport, NEVER_FIRES_MIN } from "../src/rules-report.js";
import type { RuleReportRow } from "../src/rules-report.js";
import type { RuleOutcome, RuleScore, RulesVerdict } from "../src/rules.js";

const NOW = Date.parse("2026-01-20T12:00:00.000Z");
let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "pi-warden-rules-log-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const score = (id: string, name: string, violation: number): RuleScore[] => {
  const outcome: RuleOutcome = violation >= 0.7 ? "violation" : "compliant";
  return [{ id, name, outcome, violation }];
};

const verdict = (path: string, scores: RuleScore[]): RulesVerdict => ({
  source: "typesafe", path, tool: "write", sources: ["pi-warden.md"], asked: scores.length, aggregate: false, scores, findings: [],
});

const record = (over: Partial<RuleRecord>): RuleRecord => ({
  at: new Date(NOW).toISOString(), session: "s1", path: "src/a.ts", tool: "write",
  id: "r", name: "Rule", outcome: "compliant", violation: 0.1, threshold: 0.7, finding: false,
  ...over,
});

test("a record holds the judgment only, never the written content or the rule body", async () => {
  const path = join(dir, "shape.jsonl");
  const log = new RulesLog(dir, "s1", { path });
  log.record(verdict("src/a.ts", score("no-stubs", "No partial implementations", 0.91)), 0.7, NOW);
  await log.flush();
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text.trim()) as RuleRecord;
  assert.deepEqual(Object.keys(parsed).sort(), ["at", "finding", "id", "name", "outcome", "path", "session", "threshold", "tool", "violation"]);
  assert.equal(parsed.name, "No partial implementations");
  assert.equal(parsed.outcome, "violation");
  assert.equal(parsed.violation, 0.91);
  assert.equal(parsed.threshold, 0.7);
  assert.equal(parsed.finding, true);
  assert.equal(text.includes("content"), false, "the written content is never stored");
});

test("the log file is keyed by a hash of the project path, not the path in clear", () => {
  const a = rulesLogPath("/work/one");
  const b = rulesLogPath("/work/two");
  assert.equal(rulesLogPath("/work/one"), a, "the same project keeps the same file");
  assert.notEqual(a, b);
  assert.equal(a.includes("/work/one"), false);
  assert.equal(a.endsWith(".jsonl"), true);
});

test("flag then fix on the same path is cleared once, and the clear is recorded", async () => {
  const path = join(dir, "cleared.jsonl");
  const log = new RulesLog(dir, "s1", { path });
  const flag = log.record(verdict("src/a.ts", score("no-stubs", "No partial implementations", 0.91)), 0.7, NOW);
  assert.deepEqual(flag.map(item => item.cleared), [false]);
  const fix = log.record(verdict("src/a.ts", score("no-stubs", "No partial implementations", 0.12)), 0.7, NOW + 1000);
  assert.deepEqual(fix.map(item => item.cleared), [true]);
  await log.flush();
  const records = await readRulesLog(path);
  assert.deepEqual(records.map(item => item.cleared === true), [false, true]);
});

test("flag then flag again is not a clear, and a different path is not a clear", () => {
  const tracker = new RuleClearTracker();
  const first = tracker.observe("src/a.ts", score("no-stubs", "No stubs", 0.9)!, 0.7);
  const second = tracker.observe("src/a.ts", score("no-stubs", "No stubs", 0.8)!, 0.7);
  assert.deepEqual([...first, ...second].map(item => item.cleared), [false, false]);
  const other = tracker.observe("src/b.ts", score("no-stubs", "No stubs", 0.1)!, 0.7);
  assert.deepEqual(other.map(item => item.cleared), [false], "a clear on another path does not count");
  const back = tracker.observe("src/a.ts", score("no-stubs", "No stubs", 0.1)!, 0.7);
  assert.deepEqual(back.map(item => item.cleared), [true]);
});

test("the log keeps the newest records when it grows past the cap", async () => {
  const path = join(dir, "bound.jsonl");
  const log = new RulesLog(dir, "s1", { path, maxRecords: 3 });
  for (let index = 1; index <= 5; index++) {
    log.record(verdict("src/a.ts", score(`rule-${index}`, `Rule ${index}`, index / 10)), 0.7, NOW + index);
  }
  await log.flush();
  const records = await readRulesLog(path);
  assert.deepEqual(records.map(item => item.id), ["rule-3", "rule-4", "rule-5"]);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 3);
  assert.equal(trimRecords(["a", "b", "c", "d"], 2).join(""), "cd");
  assert.ok(RULES_LOG_MAX_RECORDS >= 3);
});

test("the report gives each rule its judged, fired, cleared, and mean, and flags the noisy, undecided, and dead ones", () => {
  const records: RuleRecord[] = [
    // A: 20 judgments, none fired.
    ...Array.from({ length: NEVER_FIRES_MIN }, (_, index) => record({ id: "a", name: "Never fires", at: new Date(NOW - index * 1000).toISOString(), violation: 0.05 })),
    // B: 5 judgments, 4 fired (80%).
    ...Array.from({ length: 5 }, (_, index) => record({ id: "b", name: "Fires on everything", at: new Date(NOW - index * 1000).toISOString(), violation: index === 0 ? 0.1 : 0.9, finding: index !== 0 })),
    // C: 6 judgments, 4 in (0.3, 0.5).
    ...Array.from({ length: 6 }, (_, index) => record({ id: "c", name: "Undecided", at: new Date(NOW - index * 1000).toISOString(), violation: index < 4 ? 0.4 : 0.8 })),
    // D: an ordinary rule, one firing cleared later.
    record({ id: "d", name: "Ordinary", violation: 0.2, finding: false }),
  ];
  const report = buildRulesReport(records, { days: 30, now: NOW + 1000, currentRules: [{ id: "e", name: "Unheard" }] });
  const byId = Object.fromEntries(report.rows.map(row => [row.id, row]));
  assert.equal(byId.a!.judged, NEVER_FIRES_MIN);
  assert.equal(byId.a!.fired, 0);
  assert.deepEqual(byId.a!.flags, ["never fires"]);
  assert.deepEqual(byId.b!.flags, ["fires on everything"]);
  assert.equal(Math.round(byId.b!.firedRate * 100), 80);
  assert.deepEqual(byId.c!.flags, ["undecided"]);
  assert.deepEqual(report.rows.map(row => row.id), ["b", "c", "a", "d"], "worst first");
  assert.deepEqual(report.unheard, [{ id: "e", name: "Unheard" }]);
});

test("a cleared fix counts and the mean violation is the average of the window", () => {
  const records: RuleRecord[] = [
    record({ id: "x", name: "X", violation: 0.9, finding: true }),
    record({ id: "x", name: "X", violation: 0.1, finding: false, cleared: true }),
  ];
  const report = buildRulesReport(records, { days: 30, now: NOW + 1000 });
  assert.equal(report.rows[0]!.judged, 2);
  assert.equal(report.rows[0]!.fired, 1);
  assert.equal(report.rows[0]!.cleared, 1);
  assert.equal(Number(report.rows[0]!.meanViolation.toFixed(2)), 0.5);
});

test("the report ignores records outside the window and handles an empty log", () => {
  const old = record({ id: "a", name: "A", at: new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString() });
  const report = buildRulesReport([old], { days: 30, now: NOW });
  assert.equal(report.rows.length, 0);
  assert.match(formatRulesReport(report), /^Rules report: no judgments in the last 30 days\./);
  const empty = formatRulesReport(buildRulesReport([], { days: 7, now: NOW }));
  assert.match(empty, /last 7 days/);
  assert.match(empty, /Local log only; nothing is sent\./);
});

test("the sample report reads in short lines with one row per flagged rule", () => {
  const records: RuleRecord[] = [
    ...Array.from({ length: 12 }, (_, index) => record({ id: "partial", name: "No partial implementations", at: new Date(NOW - index * 1000).toISOString(), violation: index < 8 ? 0.85 : 0.2, finding: index < 8 })),
    ...Array.from({ length: NEVER_FIRES_MIN }, (_, index) => record({ id: "secrets", name: "No hardcoded secrets", at: new Date(NOW - index * 1000).toISOString(), violation: 0.04 })),
    ...Array.from({ length: 6 }, (_, index) => record({ id: "catch", name: "Errors are not swallowed", at: new Date(NOW - index * 1000).toISOString(), violation: 0.4 })),
    record({ id: "stdout", name: "Source modules do not write to stdout", violation: 0.9, finding: true, cleared: true }),
  ];
  const text = formatRulesReport(buildRulesReport(records, { days: 30, now: NOW + 1000, currentRules: [{ id: "hermetic", name: "Tests stay hermetic" }] }));
  assert.match(text, /No partial implementations .* fires on everything/);
  assert.match(text, /Errors are not swallowed .* undecided/);
  assert.match(text, /No hardcoded secrets .* never fires/);
  assert.match(text, /No records \(1\): Tests stay hermetic\./);
  assert.ok(text.split("\n").every(line => line.length <= 120), "every line stays short");
});

test("row order is stable for equal flags", () => {
  const row = (id: string, fired: number, judged: number, flags: RuleReportRow["flags"] = []): RuleReportRow => ({
    id, name: id, judged, fired, firedRate: fired / judged, cleared: 0, meanViolation: 0.5, flags,
  });
  const rows = [row("z", 1, 4), row("a", 3, 4), row("b", 2, 4)];
  rows.sort(compareRows);
  assert.deepEqual(rows.map(item => item.id), ["a", "b", "z"]);
});

test("a missing log file reads as no records", async () => {
  assert.deepEqual(await readRulesLog(join(dir, "does-not-exist.jsonl")), []);
});
