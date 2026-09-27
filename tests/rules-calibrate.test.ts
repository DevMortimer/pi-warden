import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultConfig } from "../src/config.js";
import type { RulesConfig } from "../src/config.js";
import { parseRules } from "../src/rules.js";
import type { Judge } from "pi-typesafe";
import type { RuleSet } from "../src/rules.js";
import {
  buildTunePrompt, calibrate, calibrateGate, calibrationNotice, changeSkipReason, collectHistory, editViews,
  formatCalibration, parseHistory, planCalibration, tuneRequest, tuneTargets,
} from "../src/rules-calibrate.js";
import type { Calibration, HistoryCommit, HistoryFile } from "../src/rules-calibrate.js";
import { readRulesLog, RulesLog } from "../src/rules-log.js";
import { buildRulesReport } from "../src/rules-report.js";
import type { RuleCheck, RulesCheckResult } from "../src/rules-lint.js";

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "pi-warden-calibrate-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const rulesConfig = (overrides: Partial<RulesConfig> = {}): RulesConfig => ({ ...defaultConfig().rules, ...overrides });

function ruleSet(markdown: string): RuleSet {
  return { sources: ["pi-warden.md"], rules: parseRules(markdown), alwaysDropped: 0 };
}

/** Answers every `rule_<id>` question with the violation P for that rule and file; unnamed rules are clean. */
function stubJudge(violation: (ruleId: string, path: string) => number): Judge & { requests: Array<{ state: { path: string }; questions: Record<string, unknown> }> } {
  const judge = {
    requests: [] as Array<{ state: { path: string }; questions: Record<string, unknown> }>,
    async evaluate(request: unknown) {
      const body = request as { state: { path: string }; questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
      judge.requests.push(body);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(body.questions)) {
        if (id === "which_edit") {
          const keys = Object.keys(question.criteria);
          answers[id] = { type: "choice", choice: keys[0], confidence: 0.7, probabilities: Object.fromEntries(keys.map(key => [key, key === keys[0] ? 0.7 : 0.3 / Math.max(1, keys.length - 1)])) };
          continue;
        }
        const score = violation(id.replace(/^rule_/, ""), body.state.path);
        answers[id] = {
          type: "choice",
          choice: score >= 0.5 ? "violation" : "compliant",
          confidence: 0.9,
          probabilities: { compliant: 1 - score - 0.02, violation: score, not_applicable: 0.01, insufficient_context: 0.01 },
        };
      }
      return { model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 }, answers } as never;
    },
  };
  return judge;
}

const hunk = (over: Partial<{ oldText: string; newText: string; before: string; after: string; start: number; count: number }> = {}) => ({
  oldText: "old line", newText: "new line", before: "ctx\nold line\nctx", after: "ctx\nnew line\nctx", start: 2, count: 1, ...over,
});

const commitOf = (files: Array<{ path: string; hunks: ReturnType<typeof hunk>[]; after?: string; binary?: boolean }>): HistoryCommit => ({
  hash: "c0ffee01deadbeef", at: "2026-01-01T00:00:00.000Z",
  files: files.map(file => ({ binary: false, ...file })),
});

// ---------------------------------------------------------------------------
// Hunk extraction

const LOG = [
  "\x01aaaa1111bbbb2222cccc3333dddd4444eeee5555\x022026-01-02T03:04:05Z",
  "",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "-const c = 3;",
  "+const b = 20;",
  "+const c = 30;",
  "+const d = 40;",
  " const e = 5;",
  "diff --git a/logo.png b/logo.png",
  "index 3333333..4444444 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "\x019999888877776666555544443333222211110000\x022026-01-01T00:00:00Z",
  "",
  "diff --git a/my file.ts b/my file.ts",
  "index 1111111..2222222 100644",
  "--- \"a/my file.ts\"",
  "+++ \"b/my file.ts\"",
  "@@ -10,2 +10,1 @@",
  " keep",
  "-drop",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 5555555..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-first",
  "-second",
  "",
].join("\n");

test("parseHistory: each hunk is one oldText/newText pair with the diff's before and after images, binary files are marked", () => {
  const [first, second] = parseHistory(LOG);
  assert.equal(first!.hash, "aaaa1111bbbb2222cccc3333dddd4444eeee5555");
  assert.equal(first!.at, "2026-01-02T03:04:05Z");
  assert.deepEqual(first!.files.map(file => file.path), ["src/app.ts", "logo.png"]);
  const app = first!.files[0]!;
  assert.equal(app.binary, false);
  assert.equal(app.hunks.length, 1);
  assert.equal(app.hunks[0]!.oldText, "const b = 2;\nconst c = 3;");
  assert.equal(app.hunks[0]!.newText, "const b = 20;\nconst c = 30;\nconst d = 40;");
  assert.equal(app.hunks[0]!.before, "const a = 1;\nconst b = 2;\nconst c = 3;\nconst e = 5;");
  assert.equal(app.hunks[0]!.after, "const a = 1;\nconst b = 20;\nconst c = 30;\nconst d = 40;\nconst e = 5;");
  assert.equal(app.hunks[0]!.start, 1);
  assert.equal(app.hunks[0]!.count, 5);
  assert.equal(first!.files[1]!.binary, true, "a binary patch carries no lines");
  assert.equal(first!.files[1]!.hunks.length, 0);

  assert.equal(second!.hash, "9999888877776666555544443333222211110000");
  assert.deepEqual(second!.files.map(file => file.path), ["my file.ts", "gone.txt"], "quoted paths and the deleted file's a-side are kept");
  assert.equal(second!.files[0]!.hunks[0]!.oldText, "drop");
  assert.equal(second!.files[0]!.hunks[0]!.newText, "", "a pure removal writes nothing");
  assert.equal(second!.files[1]!.hunks[0]!.newText, "");
});

test("parseHistory: a change line that looks like a file header stays content", () => {
  const log = ["\x01ffff\x022026-01-01T00:00:00Z", "", "diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -1,1 +1,2 @@", "--- old quote", "+++ new quote", ""].join("\n");
  const [commit] = parseHistory(log);
  const file = commit!.files[0]!;
  assert.equal(file.path, "x.md", "the +++ inside the hunk does not become the path");
  assert.equal(file.hunks[0]!.oldText, "-- old quote");
  assert.equal(file.hunks[0]!.newText, "++ new quote");
});

// ---------------------------------------------------------------------------
// collectHistory on a temporary git repo

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function makeRepo(name: string): Promise<string> {
  const repo = join(dir, name);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  return repo;
}

async function commit(repo: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), content);
    git(repo, "add", "-f", path);
  }
  git(repo, "commit", "-q", "-m", message);
}

test("collectHistory: the file after the commit is the context, one commit back each time, read-only", async () => {
  const repo = await makeRepo("history");
  await commit(repo, { "src/app.ts": "line1\nline2\nline3\nline4\nline5\nline6\n" }, "first");
  await commit(repo, { "src/app.ts": "line1\nline2\nCHANGED\nline4\nline5\nline6\n" }, "second");
  const history = collectHistory(repo, 20);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.files[0]!.after, "line1\nline2\nCHANGED\nline4\nline5\nline6\n", "newest commit first, with its own file state");
  assert.equal(history[1]!.files[0]!.after, "line1\nline2\nline3\nline4\nline5\nline6\n", "the older commit keeps its own file state");
  assert.equal(history[1]!.files[0]!.hunks[0]!.newText, "line1\nline2\nline3\nline4\nline5\nline6");
  const edits = editViews(history[0]!.files[0]!);
  assert.equal(edits.edits.length, 1);
  assert.match(edits.edits[0]!.after!, /CHANGED/);
  assert.match(edits.edits[0]!.before!, /line3/);
  assert.equal(edits.edits[0]!.newText, "CHANGED");
});

test("editViews: the file after the commit gives a wide window around the change, beyond the diff's three context lines", () => {
  const lines = Array.from({ length: 30 }, (_value, index) => `line ${index + 1}`);
  const after = [...lines.slice(0, 14), "INSERTED", ...lines.slice(14)].join("\n");
  const file: HistoryFile = {
    path: "src/wide.ts", binary: false, after,
    hunks: [{ oldText: "", newText: "INSERTED", before: "line 15", after: "line 15\nINSERTED\nline 16", start: 15, count: 1 }],
  };
  const { edits } = editViews(file);
  assert.match(edits[0]!.after!, /line 10/, "the window reaches past the diff context");
  assert.match(edits[0]!.after!, /line 20/);
  assert.match(edits[0]!.before!, /line 10/);
  assert.doesNotMatch(edits[0]!.before!, /INSERTED/);
});

// ---------------------------------------------------------------------------
// The skip rules and the cap

test("changeSkipReason: binary, generated, and empty changes are skipped before any request", () => {
  assert.equal(changeSkipReason({ path: "a.png", binary: true, hunks: [hunk()] }), "binary file");
  assert.equal(changeSkipReason({ path: "src/x.ts", binary: false, hunks: [] }), "no content change");
  assert.equal(changeSkipReason({ path: "dist/bundle.js", binary: false, hunks: [hunk()] }), "generated file");
  assert.equal(changeSkipReason({ path: "package-lock.json", binary: false, hunks: [hunk()] }), "generated file");
  assert.equal(changeSkipReason({ path: "src/schema.generated.ts", binary: false, hunks: [hunk()] }), "generated file");
  assert.equal(changeSkipReason({ path: "src/gen.ts", binary: false, hunks: [hunk({ newText: "// Code generated by tool. DO NOT EDIT.\nexport const x = 1;" })] }), "generated file", "the standard marker counts even outside a generated path");
  assert.equal(changeSkipReason({ path: "src/x.ts", binary: false, hunks: [hunk()] }), undefined);
});

test("planCalibration: binary, generated, ignored, rules.exclude and rules.skip files are skipped with their reasons", async () => {
  const repo = await makeRepo("skips");
  await commit(repo, {
    "good.ts": "export const n = 1;\nsecond line\n",
    "dist/bundle.js": "var x=1;\n",
    "gen.ts": "// Code generated by tool. DO NOT EDIT.\nexport const y = 1;\n",
    "secrets/token.txt": "value\n",
    "tests/a.test.ts": "test();\n",
  }, "first");
  await writeFile(join(repo, ".gitignore"), "ignored.log\n");
  await commit(repo, { "ignored.log": "log\n" }, "second");
  await commit(repo, { "good.ts": "export const n = 1;\n" }, "removal only");
  const config = rulesConfig({ exclude: ["secrets/**"], skip: ["tests/**"] });
  const plan = planCalibration(collectHistory(repo, 10), { set: ruleSet("# Only rule\nMust hold.\n"), config, cwd: repo, maxRequests: 40 });
  assert.deepEqual(plan.samples.map(sample => sample.path), ["good.ts"]);
  assert.deepEqual(Object.fromEntries(plan.skipped.map(skip => [skip.path, skip.reason])), {
    "good.ts": "nothing written in this change",
    "ignored.log": "gitignored by the project",
    "dist/bundle.js": "generated file",
    "gen.ts": "generated file",
    "secrets/token.txt": "excluded from Jev by rules.exclude (secrets/**)",
    "tests/a.test.ts": "rules do not apply by rules.skip (tests/**)",
  });
  assert.equal(plan.requests, 1);
});

test("planCalibration and calibrate: the cap keeps the newest samples and the rest are reported, not sent", async () => {
  const history: HistoryCommit[] = [{
    hash: "c1", at: "2026-01-01T00:00:00.000Z",
    files: [1, 2, 3].map(n => ({ path: `f${n}.ts`, binary: false, hunks: [hunk({ newText: `new ${n}` })] })),
  }];
  const set = ruleSet("# Only rule\nMust hold.\n");
  const config = rulesConfig();
  const plan = planCalibration(history, { set, config, cwd: dir, maxRequests: 2 });
  assert.equal(plan.requests, 2);
  assert.equal(plan.dropped.length, 1);
  assert.deepEqual(plan.samples.map(sample => sample.path), ["f1.ts", "f2.ts"]);
  const judge = stubJudge(() => 0.05);
  const result = await calibrate(history, { set, config, cwd: dir, maxRequests: 2, judge, timeoutMs: 1000 });
  assert.equal(judge.requests.length, 2, "the cap is the number of requests");
  assert.equal(result.dropped, 1);
  assert.equal(result.requests, 2);
});

test("calibrate: with no judge nothing is sent and nothing is scored", async () => {
  const history: HistoryCommit[] = [commitOf([{ path: "f.ts", hunks: [hunk()] }])];
  const result = await calibrate(history, { set: ruleSet("# Only rule\nMust hold.\n"), config: rulesConfig(), cwd: dir, maxRequests: 5, judge: undefined, timeoutMs: 1000 });
  assert.equal(result.requests, 0);
  assert.equal(result.records.length, 0);
  assert.equal(result.rows.length, 0);
});

// ---------------------------------------------------------------------------
// The confirm and --yes paths

test("calibrateGate: a UI confirms, a headless run needs --yes, and --yes stands in for the dialog", () => {
  assert.deepEqual(calibrateGate({ hasUI: true, yes: false }), { kind: "confirm" });
  assert.deepEqual(calibrateGate({ hasUI: true, yes: true }), { kind: "send" });
  assert.deepEqual(calibrateGate({ hasUI: false, yes: true }), { kind: "send" });
  const refused = calibrateGate({ hasUI: false, yes: false });
  assert.equal(refused.kind, "refuse");
  assert.match((refused as { reason: string }).reason, /explicit --yes/);
});

test("calibrationNotice: the dialog names the request count and shows the diffs redacted", () => {
  const history: HistoryCommit[] = [commitOf([
    { path: "src/app.ts", hunks: [hunk({ newText: "password: hunter2secret", after: "top\npassword: hunter2secret\nbottom" })] },
    { path: "src/other.ts", hunks: [hunk({ newText: "other change" })] },
    { path: "src/third.ts", hunks: [hunk({ newText: "third change" })] },
    { path: "src/fourth.ts", hunks: [hunk({ newText: "fourth change" })] },
  ])];
  const plan = planCalibration(history, { set: ruleSet("# Only rule\nMust hold.\n"), config: rulesConfig(), cwd: dir, maxRequests: 3 });
  const notice = calibrationNotice(plan);
  assert.match(notice, /3 requests will go to the judgment backend/);
  assert.match(notice, /src\/app\.ts/);
  assert.match(notice, /password: \[redacted\]/);
  assert.equal(notice.includes("hunter2secret"), false, "the diff is redacted before it is shown");
  assert.match(notice, /1 further change stays inside the --max cap and is not sent\./);
});

// ---------------------------------------------------------------------------
// Report flags and order

const FLAGS_MD = ["# Hot rule", "Runs hot.", "", "# Cold rule", "Runs cold.", "", "# Mid rule", "Runs mid.", "", "# Py rule", "paths: **/*.py", "Runs on Python."].join("\n");

test("calibrate: one line per rule, worst first, with the /warden report flags; rules no file reached are listed apart", async () => {
  const files = Array.from({ length: 21 }, (_value, index) => ({
    path: `f${String(index + 1).padStart(2, "0")}.ts`,
    binary: false,
    hunks: [hunk({ newText: `change ${index + 1}` })],
  }));
  const history: HistoryCommit[] = [{ hash: "c1", at: "2026-01-01T00:00:00.000Z", files }];
  const judge = stubJudge((ruleId, path) => {
    if (ruleId === "hot-rule") return 0.95;
    if (ruleId === "cold-rule") return 0.05;
    return Number(path.slice(1, 3)) <= 11 ? 0.4 : 0.75;
  });
  const result = await calibrate(history, { set: ruleSet(FLAGS_MD), config: rulesConfig(), cwd: dir, maxRequests: 40, judge, timeoutMs: 1000 });
  assert.deepEqual(result.rows.map(row => row.id), ["hot-rule", "mid-rule", "cold-rule"], "worst first: noisy, then undecided, then dead");
  const [hot, mid, cold] = result.rows;
  assert.deepEqual(hot!.flags, ["fires on everything"]);
  assert.equal(hot!.applied, 21);
  assert.equal(hot!.fired, 21);
  assert.ok(Math.abs(hot!.meanViolation - 0.95) < 1e-9, `mean ${hot!.meanViolation}`);
  assert.deepEqual(mid!.flags, ["undecided"]);
  assert.equal(mid!.fired, 10);
  assert.deepEqual(cold!.flags, ["never fires"]);
  assert.equal(cold!.applied, 21);
  assert.equal(cold!.fired, 0);
  assert.deepEqual(result.neverApplied, [{ id: "py-rule", name: "Py rule" }]);

  const text = formatCalibration(result);
  const lines = text.split("\n");
  assert.equal(lines[0], "Rules calibrate: 21 requests, 1 commit.");
  assert.equal(lines[1], "Worst first:");
  assert.equal(lines[2], "1. Hot rule · 21 applied · 21 fired 100% · mean 0.95 · fires on everything");
  assert.equal(lines[4], "3. Cold rule · 21 applied · 0 fired 0% · mean 0.05 · never fires");
  assert.match(lines[5]!, /Never applied to any file in the sample \(1\): Py rule\./);
});

test("calibrate: a rule's own threshold is the cutoff that decides its fire", async () => {
  const md = ["# Strict rule", "threshold: 0.9", "Must be strict.", "", "# Normal rule", "Must be normal."].join("\n");
  const history: HistoryCommit[] = [commitOf([{ path: "f.ts", hunks: [hunk()] }])];
  const judge = stubJudge(ruleId => ruleId === "strict-rule" ? 0.85 : 0.8);
  const result = await calibrate(history, { set: ruleSet(md), config: rulesConfig(), cwd: dir, maxRequests: 5, judge, timeoutMs: 1000 });
  const strict = result.records.find(record => record.id === "strict-rule")!;
  const normal = result.records.find(record => record.id === "normal-rule")!;
  assert.equal(strict.threshold, 0.9);
  assert.equal(strict.finding, false, "0.85 is under the rule's own 0.9 cutoff");
  assert.equal(normal.threshold, 0.7);
  assert.equal(normal.finding, true);
  assert.deepEqual(result.rows.map(row => [row.id, row.fired]), [["normal-rule", 1], ["strict-rule", 0]]);
});

// ---------------------------------------------------------------------------
// The source: "calibrate" records

test("calibrate: every score is recorded with source calibrate, and the report counts live records apart", async () => {
  const repo = await makeRepo("records");
  await commit(repo, { "a.ts": "const a = 1;\n" }, "first");
  const judge = stubJudge(ruleId => ruleId === "hot-rule" ? 0.95 : 0.05);
  const result = await calibrate(collectHistory(repo, 5), { set: ruleSet(FLAGS_MD), config: rulesConfig(), cwd: repo, maxRequests: 10, judge, timeoutMs: 1000, session: "s1" });
  assert.ok(result.records.length >= 3);
  assert.equal(result.records.every(record => record.source === "calibrate"), true);
  assert.equal(result.records.every(record => record.tool === "edit" && record.session === "s1"), true);

  const path = join(dir, "records-log.jsonl");
  const log = new RulesLog(dir, "s1", { path });
  log.appendRecords(result.records);
  await log.flush();
  const stored = await readRulesLog(path);
  assert.equal(stored.length, result.records.length);
  assert.equal(stored.every(record => record.source === "calibrate"), true, "the source field survives the log round trip");
  assert.equal(stored.every(record => !("content" in record) && !("body" in record)), true, "no content and no rule body is stored");

  const window = { now: Date.parse("2026-01-02T00:00:00.000Z"), days: 30 };
  const live = buildRulesReport(stored, { ...window, source: "live", currentRules: [{ id: "hot-rule", name: "Hot rule" }] });
  assert.equal(live.rows.length, 0, "replays are not counted as live verdicts");
  assert.deepEqual(live.unheard.map(rule => rule.id), ["hot-rule"]);
  const replays = buildRulesReport(stored, { ...window, source: "calibrate" });
  assert.equal(replays.rows.length, result.rows.length, "and they can be read on their own");
});

// ---------------------------------------------------------------------------
// The tune prompt

function checkResult(flagged: RuleCheck[]): RulesCheckResult {
  return { source: "typesafe", sources: ["pi-warden.md"], checked: flagged.length, notChecked: 0, unanswered: 0, results: flagged, attention: flagged, requests: 1, failedRequests: 0 };
}

const flaggedCheck: RuleCheck = { id: "cold-rule", name: "Cold rule", judgeability: "needs_other_files", judgeabilityScore: 0.8, mechanical: 0.05, needsAttention: true };

test("tuneTargets: flagged rules from the latest calibrate and from the rules check arrive with both reasons", async () => {
  const history: HistoryCommit[] = [{
    hash: "c1", at: "2026-01-01T00:00:00.000Z",
    files: Array.from({ length: 21 }, (_value, index) => ({ path: `f${String(index + 1).padStart(2, "0")}.ts`, binary: false, hunks: [hunk({ newText: `change ${index}` })] })),
  }];
  const judge = stubJudge(ruleId => ruleId === "hot-rule" ? 0.95 : ruleId === "cold-rule" ? 0.05 : 0.4);
  const calibration = await calibrate(history, { set: ruleSet(FLAGS_MD), config: rulesConfig(), cwd: dir, maxRequests: 40, judge, timeoutMs: 1000 });
  const targets = tuneTargets({ calibration, check: checkResult([flaggedCheck]), rules: parseRules(FLAGS_MD) });
  const cold = targets.find(target => target.id === "cold-rule")!;
  assert.equal(cold.reasons.length, 2, "flagged by both sources, one entry with both reasons");
  assert.match(cold.reasons[0]!, /never fires in the latest calibrate: 21 applied, 0 fired \(0%\), mean 0\.05/);
  assert.match(cold.reasons[1]!, /flagged by the rules check: needs another file to judge \(0\.80\)/);
  assert.equal(targets.some(target => target.id === "py-rule"), false, "a rule the sample never reached is not flagged");
});

test("buildTunePrompt: each flagged rule with its reason and current text, asking for a rewrite judgeable from one changed file", () => {
  const prompt = buildTunePrompt([{ id: "hot-rule", name: "Hot rule", body: "Runs hot.", reasons: ["flagged fires on everything in the latest calibrate: 21 applied, 21 fired (100%), mean 0.95"] }]);
  assert.match(prompt, /Rewrite the flagged project rules in `pi-warden\.md` with your file tools/);
  assert.match(prompt, /## Hot rule \(hot-rule\)/);
  assert.match(prompt, /Flagged: flagged fires on everything in the latest calibrate: 21 applied, 21 fired \(100%\), mean 0\.95\./);
  assert.match(prompt, /Current text:\nRuns hot\./);
  assert.match(prompt, /judgeable from the content of one changed file alone/);
  assert.match(prompt, /keep or add a `paths:` line/);
});

test("tuneRequest: with nothing flagged it says so and returns no prompt, so nothing is sent", () => {
  const rules = parseRules(FLAGS_MD);
  const untouched: Calibration = { rows: [], neverApplied: [], requests: 1, failed: 0, skipped: [], dropped: 0, records: [], commits: 1 };
  const noneYet = tuneRequest({ rules });
  assert.equal("prompt" in noneYet, false);
  assert.match((noneYet as { reason: string }).reason, /run \/warden rules calibrate or \/warden rules check first/);
  const clean = tuneRequest({ calibration: untouched, check: checkResult([]), rules });
  assert.equal("prompt" in clean, false);
  assert.match((clean as { reason: string }).reason, /no rule that needs a rewrite/);
  const noRules = tuneRequest({ rules: [] });
  assert.match((noRules as { reason: string }).reason, /no separate rules/);
  const sent = tuneRequest({ check: checkResult([flaggedCheck]), rules });
  assert.equal("reason" in sent, false);
  assert.match((sent as { prompt: string }).prompt, /## Cold rule/);
});
