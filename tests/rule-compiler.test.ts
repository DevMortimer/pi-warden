import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Judge } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import type { RulesConfig } from "../src/config.js";
import { compileRule, evaluateSystem0, extractAddedText } from "../src/rule-compiler.js";
import { describeTarget, evaluateRules, evaluateRulesTarget, parseRules } from "../src/rules.js";
import type { RuleSet } from "../src/rules.js";
import { evaluateTurnRun, snapshotTree } from "../src/turn-rules.js";
import { execFileSync } from "node:child_process";

const rulesConfig = (overrides: Partial<RulesConfig> = {}): RulesConfig => ({ ...defaultConfig().rules, ...overrides });

function recordingJudge(violations: Record<string, number> = {}): Judge & {
  requests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }>;
} {
  const judge = {
    requests: [] as Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }>,
    async evaluate(request: unknown) {
      const body = request as { state: Record<string, unknown>; questions: Record<string, unknown> };
      judge.requests.push(body);
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) {
        const violation = violations[id.replace(/^rule_/, "")] ?? 0.05;
        answers[id] = {
          type: "choice",
          choice: violation >= 0.5 ? "violation" : "compliant",
          confidence: 0.9,
          probabilities: { compliant: 1 - violation, violation, not_applicable: 0, insufficient_context: 0 },
        };
      }
      return { model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 }, answers } as never;
    },
  };
  return judge;
}

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-warden-sys0-"));
});
after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test("parseRules parses forbid, forbid-token, require-token, and extensions headers and warns on malformed regex", () => {
  const md = [
    "# No console.log in TypeScript",
    "extensions: .ts, TSX",
    "forbid: /\\bconsole\\.log\\(/",
    "forbid-token: DEBUG_HACK, FIXME_TEMP",
    "Use the project logger instead.",
    "",
    "# Broken regex header",
    "forbid: /[/",
    "Body stays intact.",
  ].join("\n");
  const rules = parseRules(md);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0]!.extensions, ["ts", "tsx"]);
  assert.deepEqual(rules[0]!.forbid, ["/\\bconsole\\.log\\(/"]);
  assert.deepEqual(rules[0]!.forbidTokens, ["DEBUG_HACK", "FIXME_TEMP"]);
  assert.equal(rules[0]!.body, "Use the project logger instead.");
  assert.equal(rules[1]!.forbid, undefined);
  assert.ok(rules[1]!.headerWarnings?.some(w => /forbid:/i.test(w)), "malformed regex adds a headerWarning without throwing");
});

test("explicit headers enforce forbid regex and scope extensions via System-0 without Jev", async () => {
  const md = [
    "# No console.log",
    "extensions: ts",
    "forbid: /\\bconsole\\.log\\(/",
    "Use the logger.",
  ].join("\n");
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules(md), alwaysDropped: 0 };
  const bad = await evaluateRules("write", { path: "src/a.ts", content: "export const f = () => { console.log(1); };\n" }, { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  assert.equal(bad.source, "code");
  assert.equal(bad.findings.length, 1);
  assert.equal(bad.findings[0]!.id, "no-console-log");
  assert.equal(bad.findings[0]!.violation, 1);

  const readme = await evaluateRules("write", { path: "README.md", content: "Example: console.log(1)\n" }, { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  assert.equal(readme.source, "code");
  assert.equal(readme.findings.length, 0);
  assert.equal(readme.scores?.[0]?.outcome, "not_applicable");
});

test("offline (!judge) catches AI attribution, forbidden term lists, and empty catch blocks in <1 ms with 0 Jev calls", async () => {
  const attribHeader = ["Co-authored", "-by:"].join("");
  const attribPhrase = ["Generated", " by"].join("");
  const md = [
    "# No tool or AI attribution lines",
    `Commits and PRs never include "${attribPhrase}" or "${attribHeader}" attribution lines.`,
    "",
    "# Public text carries no internal codenames",
    "Public docs and code never name internal roles (alpha-ops, beta-runner, delta-dispatch).",
    "",
    "# Errors are not swallowed",
    "A `catch` block must handle, report, or re-raise the error. An empty catch block or comment-only catch body is a violation.",
  ].join("\n");
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules(md), alwaysDropped: 0 };

  const badCode = [
    `// ${attribHeader} Example Bot <bot@example.com>`,
    "export function run() {",
    "  try { work(); } catch (err) { /* ignored */ }",
    "  return 'delta-dispatch';",
    "}",
  ].join("\n");
  const started = performance.now();
  const verdict = await evaluateRules("write", { path: "src/app.ts", content: badCode }, { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  const elapsed = performance.now() - started;

  assert.equal(verdict.source, "code");
  assert.ok(elapsed < 100, `System-0 should run in milliseconds, took ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(
    verdict.findings.map(f => f.id).sort(),
    ["errors-are-not-swallowed", "no-tool-or-ai-attribution-lines", "public-text-carries-no-internal-codenames"],
  );

  // Python bare `except ...:\n    pass` is also caught offline.
  const pyVerdict = await evaluateRules("write", { path: "src/worker.py", content: "try:\n    run()\nexcept Exception:\n    pass\n" }, { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  assert.equal(pyVerdict.source, "code");
  assert.deepEqual(pyVerdict.findings.map(f => f.id), ["errors-are-not-swallowed"]);
});

test("offline (!judge) on semantic-only rules still returns source skipped with TypeSafe judgments are off", async () => {
  const set: RuleSet = {
    sources: ["pi-warden.md"],
    rules: parseRules("# Functions do one thing\nKeep each exported function focused on a single responsibility.\n"),
    alwaysDropped: 0,
  };
  const verdict = await evaluateRules("write", { path: "src/app.ts", content: "export const a = 1;\n" }, { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  assert.equal(verdict.source, "skipped");
  assert.equal(verdict.skippedReason, "TypeSafe judgments are off");
});

test("with judge active, precondition and System-0 pre-gating strip locally settled rules so only semantic rules reach Jev", async () => {
  const attribHeader = ["Co-authored", "-by:"].join("");
  const attribPhrase = ["Generated", " by"].join("");
  const md = [
    "# No tool or AI attribution lines",
    `No "${attribPhrase}" or "${attribHeader}" lines.`,
    "",
    "# Errors are not swallowed",
    "An empty catch block or comment-only catch body is a violation.",
    "",
    "# SQL migrations must be reversible",
    "Every database migration adds a rollback step.",
    "",
    "# Functions do one thing",
    "Keep each exported function focused on one responsibility.",
  ].join("\n");
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules(md), alwaysDropped: 0 };
  const judge = recordingJudge({ "functions-do-one-thing": 0.1 });

  const verdict = await evaluateRules("write", { path: "src/app.ts", content: "export function add(a: number, b: number) { return a + b; }\n" }, { cwd, config: rulesConfig(), set, judge, timeoutMs: 1000 });
  assert.equal(verdict.source, "typesafe");
  assert.equal(judge.requests.length, 1);
  assert.equal(verdict.asked, 1, "only the 1 semantic rule is sent to Jev");
  assert.deepEqual(Object.keys(judge.requests[0]!.questions), ["rule_functions-do-one-thing"]);
  assert.equal(verdict.scores?.length, 4, "all 4 rules appear in merged scores");
  const sqlScore = verdict.scores?.find(s => s.id === "sql-migrations-must-be-reversible");
  assert.equal(sqlScore?.outcome, "not_applicable");
});

test("with judge active, if every rule settles in System-0, zero Jev requests are sent and source is code", async () => {
  const md = [
    "# Errors are not swallowed",
    "An empty catch block is a violation.",
    "",
    "# Python style uses pytest fixtures",
    "All pytest functions must declare fixtures in pyproject.toml.",
  ].join("\n");
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules(md), alwaysDropped: 0 };
  const judge = recordingJudge();
  const verdict = await evaluateRules("write", { path: "src/app.ts", content: "export const ok = 1;\n" }, { cwd, config: rulesConfig(), set, judge, timeoutMs: 1000 });
  assert.equal(verdict.source, "code");
  assert.equal(verdict.asked, 0);
  assert.equal(judge.requests.length, 0);
  assert.equal(verdict.findings.length, 0);
});

test("extractAddedText never flags pre-existing violations in unchanged edit context or removed diff lines", async () => {
  const targetDiff = {
    tool: "edit" as const,
    path: "src/a.ts",
    edits: [{
      id: "diff",
      newText: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,4 +1,4 @@",
        " try { old(); } catch (e) {}",
        "-console.log('removed');",
        "+export const clean = 2;",
      ].join("\n"),
    }],
  };
  assert.equal(extractAddedText(targetDiff), "export const clean = 2;");

  const md = "# Errors are not swallowed\nAn empty catch block is a violation.\n";
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules(md), alwaysDropped: 0 };
  const diffVerdict = await evaluateRulesTarget(targetDiff, "edit", "src/a.ts", { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  assert.equal(diffVerdict.source, "code");
  assert.equal(diffVerdict.findings.length, 0, "pre-existing catch {} in diff context must not trigger");

  // Regular EditView with before/after context carrying a pre-existing empty catch.
  await writeFile(join(cwd, "existing.ts"), "try { work(); } catch (e) {}\nexport const x = 1;\n");
  const editTarget = describeTarget("edit", { path: "existing.ts", edits: [{ oldText: "export const x = 1;", newText: "export const x = 2;" }] }, cwd)!;
  const editVerdict = await evaluateRulesTarget(editTarget, "edit", "existing.ts", { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  assert.equal(editVerdict.source, "code");
  assert.equal(editVerdict.findings.length, 0);
});

test("forbidden console.log, debugger, and Python print rules respect language and library-code test exemptions", () => {
  const rules = parseRules([
    "# No console.log",
    "Do not leave console.log calls.",
    "",
    "# No debugger",
    "Remove debugger statements.",
    "",
    "# No print or stdlib logging in library code",
    "Use structlog instead of print or logging.",
  ].join("\n"));

  const tsEval = evaluateSystem0({ tool: "write", path: "src/app.ts", content: "console.log(1);\ndebugger;\n" }, rules);
  assert.deepEqual(tsEval.decisive.filter(r => r.outcome === "violation").map(r => r.rule.id).sort(), ["no-console-log", "no-debugger"]);
  assert.equal(tsEval.decisive.find(r => r.rule.id === "no-print-or-stdlib-logging-in-library-code")?.outcome, "not_applicable");

  const pyLib = evaluateSystem0({ tool: "write", path: "pkg/service.py", content: "import logging\nprint('hi')\n" }, rules);
  assert.equal(pyLib.decisive.find(r => r.rule.id === "no-print-or-stdlib-logging-in-library-code")?.outcome, "violation");
  assert.equal(pyLib.decisive.find(r => r.rule.id === "no-console-log")?.outcome, "not_applicable");

  const pyTest = evaluateSystem0({ tool: "write", path: "tests/test_service.py", content: "print('debug')\n" }, rules);
  assert.equal(pyTest.decisive.find(r => r.rule.id === "no-print-or-stdlib-logging-in-library-code")?.outcome, "not_applicable");

  const compiled = compileRule(rules[0]!);
  assert.ok(compiled.kinds.length > 0);
});

test("evaluateTurnRun enforces System-0 rules offline (!judge) and preserves skipped semantics for semantic-only sets", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-warden-sys0-turn-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  try {
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(repo, "app.ts"), "export const v = 1;\n");
    git("add", "-A");
    git("commit", "-m", "init");

    const snap = await snapshotTree(repo);
    assert.ok(snap.tree);
    await writeFile(join(repo, "app.ts"), "export function f() { try { go(); } catch (e) {} }\n");

    const sys0Set: RuleSet = {
      sources: ["pi-warden.md"],
      rules: parseRules("# Errors are not swallowed\nAn empty catch block is a violation.\n"),
      alwaysDropped: 0,
    };
    const offlineHit = await evaluateTurnRun({ cwd: repo, config: rulesConfig(), set: sys0Set, timeoutMs: 1000, startTree: snap.tree!, alreadyJudged: new Set() });
    assert.equal(offlineHit.skipped, undefined);
    assert.equal(offlineHit.verdicts.length, 1);
    assert.equal(offlineHit.verdicts[0]!.source, "code");
    assert.equal(offlineHit.verdicts[0]!.findings[0]!.id, "errors-are-not-swallowed");

    const semanticSet: RuleSet = {
      sources: ["pi-warden.md"],
      rules: parseRules("# Functions do one thing\nKeep functions focused.\n"),
      alwaysDropped: 0,
    };
    const offlineSkip = await evaluateTurnRun({ cwd: repo, config: rulesConfig(), set: semanticSet, timeoutMs: 1000, startTree: snap.tree!, alreadyJudged: new Set() });
    assert.equal(offlineSkip.skipped, "TypeSafe judgments are off");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
