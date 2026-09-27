import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Judge } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import type { RulesConfig } from "../src/config.js";
import { parseRules, RuleStore } from "../src/rules.js";
import type { RuleSet, RulesVerdict } from "../src/rules.js";
import {
  collectAuditFiles, flaggedAuditFiles, formatBench, formatRulesAudit, formatRulesAuditFiles, formatRulesAuditRows,
  parseBenchArgs, parseRulesAuditArgs, percentile, ruleAuditRows, rulesAuditMarkdown, runBench, runRulesAudit,
} from "../src/rules-audit.js";
import type { BenchUsage, RulesAuditFileResult, RulesAuditOutcome } from "../src/rules-audit.js";

let cwd: string;
let set: RuleSet;
const config = (overrides: Partial<RulesConfig> = {}): RulesConfig => ({ ...defaultConfig().rules, ...overrides });

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-warden-rules-audit-"));
  await mkdir(join(cwd, "src", "sub"), { recursive: true });
  await mkdir(join(cwd, "src", "secret"), { recursive: true });
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, "pi-warden.md"), [
    "# No console statements",
    "Code must not contain `console.log`.",
    "",
    "# Return types on exports",
    "paths: src/**/*.ts",
    "Every exported function must declare its return type.",
    "",
    "# Docs stay calm",
    "paths: docs/**",
    "Documentation must stay factual.",
  ].join("\n"));
  await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(cwd, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(join(cwd, "src", "c.ts"), "export const c = 3;\n");
  await writeFile(join(cwd, "src", "sub", "d.ts"), "export const d = 4;\n");
  await writeFile(join(cwd, "src", "secret", "keys.ts"), "export const key = \"k\";\n");
  await writeFile(join(cwd, "src", "a.test.ts"), "export const t = 1;\n");
  await writeFile(join(cwd, "docs", "example.js"), "module.exports = 1;\n");
  set = new RuleStore().load(cwd, config())!;
  assert.ok(set && set.rules.length === 3, "fixture rules load");
});
after(async () => { await rm(cwd, { recursive: true, force: true }); });

/**
 * Answers `rule_<id>` questions with the given P(violation); unnamed rules are clean. Records every request and runs
 * `wrap` around each evaluation so a test can hold the answer and watch the concurrency.
 */
function stubJudge(violations: Record<string, number>, options: { wrap?: () => Promise<void> } = {}): Judge & { requests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> } {
  const judge = {
    requests: [] as Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }>,
    async evaluate(request: unknown) {
      const body = request as { state: Record<string, unknown>; questions: Record<string, unknown> };
      judge.requests.push(body);
      await options.wrap?.();
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) {
        const violation = violations[id.replace(/^rule_/, "")] ?? 0.05;
        answers[id] = { type: "choice", choice: violation >= 0.5 ? "violation" : "compliant", confidence: 0.9, probabilities: { compliant: 1 - violation - 0.02, violation, not_applicable: 0.01, insufficient_context: 0.01 } };
      }
      return { model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 }, answers } as never;
    },
  };
  return judge;
}

// ---------------------------------------------------------------------------
// Discovery, the cap, skip and exclude

test("collectAuditFiles: source files under the paths, capped in sorted order with the leftovers counted", () => {
  const guarded = config({ exclude: ["src/secret/**"], skip: ["**/*.test.ts"] });
  const plan = collectAuditFiles(cwd, ["src"], set, guarded, 2);
  assert.deepEqual(plan.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(plan.matched, 4);
  assert.equal(plan.leftOut, 2);
  assert.deepEqual(plan.missing, []);
  const full = collectAuditFiles(cwd, ["."], set, guarded, 50);
  assert.deepEqual(full.files, ["docs/example.js", "src/a.ts", "src/b.ts", "src/c.ts", "src/sub/d.ts"]);
  assert.equal(full.leftOut, 0);
  const missing = collectAuditFiles(cwd, ["src", "nowhere.ts"], set, guarded, 50);
  assert.deepEqual(missing.missing, ["nowhere.ts"]);
  assert.equal(missing.matched, 4);
});

test("collectAuditFiles: rules.exclude and rules.skip keep files out of the audit", () => {
  const plain = collectAuditFiles(cwd, ["src"], set, config(), 50);
  assert.deepEqual(plain.files, ["src/a.test.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/secret/keys.ts", "src/sub/d.ts"]);
  const filtered = collectAuditFiles(cwd, ["src"], set, config({ exclude: ["src/secret/**"], skip: ["**/*.test.ts"] }), 50);
  assert.deepEqual(filtered.files, ["src/a.ts", "src/b.ts", "src/c.ts", "src/sub/d.ts"]);
  assert.equal(filtered.matched, 4);
});

test("collectAuditFiles: a file needs at least one rule whose paths match it", () => {
  const scopedOnly: RuleSet = { sources: ["rules.md"], rules: parseRules("# Return types on exports\npaths: src/**/*.ts\nEvery exported function must declare its return type."), alwaysDropped: 0 };
  const plan = collectAuditFiles(cwd, ["docs", "src"], scopedOnly, config({ exclude: ["src/secret/**"], skip: ["**/*.test.ts"] }), 50);
  assert.deepEqual(plan.files, ["src/a.ts", "src/b.ts", "src/c.ts", "src/sub/d.ts"], "docs has no rule that applies to it");
});

test("collectAuditFiles: gitignored files are not audited", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-warden-rules-audit-git-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, ".gitignore"), "gen/\n");
    await mkdir(join(repo, "gen"), { recursive: true });
    await writeFile(join(repo, "gen", "hook.ts"), "export const h = 1;\n");
    await writeFile(join(repo, "kept.ts"), "export const k = 1;\n");
    await writeFile(join(repo, "pi-warden.md"), "# Use const\nPrefer const.\n");
    const repoSet = new RuleStore().load(repo, config())!;
    const plan = collectAuditFiles(repo, ["."], repoSet, config(), 50);
    assert.deepEqual(plan.files, ["kept.ts"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Arguments

test("parseRulesAuditArgs and parseBenchArgs: defaults, flags, and usage errors", () => {
  assert.deepEqual(parseRulesAuditArgs([]), { paths: ["."], max: 50, yes: false });
  assert.deepEqual(parseRulesAuditArgs(["src", "tests", "--max", "15", "--yes"]), { paths: ["src", "tests"], max: 15, yes: true });
  assert.match(parseRulesAuditArgs(["--max"]).error ?? "", /--max needs a positive integer/);
  assert.match(parseRulesAuditArgs(["--max", "0"]).error ?? "", /--max needs a positive integer/);
  assert.match(parseRulesAuditArgs(["--nope"]).error ?? "", /Unknown option --nope/);
  assert.deepEqual(parseBenchArgs([]), { runs: 10 });
  assert.deepEqual(parseBenchArgs(["--runs", "3"]), { runs: 3 });
  assert.match(parseBenchArgs(["--runs", "x"]).error ?? "", /--runs needs a positive integer/);
  assert.match(parseBenchArgs(["--fast"]).error ?? "", /Unknown option --fast/);
});

// ---------------------------------------------------------------------------
// The confirm dialog, --yes, and the no-key path

test("runRulesAudit: the confirm dialog names the file count and what leaves the machine; declining sends nothing", async () => {
  const guarded = config({ exclude: ["src/secret/**"], skip: ["**/*.test.ts"] });
  const judge = stubJudge({ "no-console-statements": 0.9 });
  const shown: Array<{ title: string; body: string }> = [];
  const declined = await runRulesAudit({
    cwd, paths: ["src"], max: 50, yes: false, config: guarded, set, judge, timeoutMs: 1000, destination: "api.example.test",
    confirm: (title, body) => { shown.push({ title, body }); return false; },
  });
  assert.equal(declined.status, "cancelled");
  assert.equal(judge.requests.length, 0, "a decline sends nothing");
  assert.equal(shown.length, 1);
  assert.match(shown[0]!.title, /^Send 4 files to api\.example\.test for a rules audit\?$/);
  assert.match(shown[0]!.body, /redacted sample of each file \(up to 6000 characters per file\)/);
  assert.match(shown[0]!.body, /Nothing is written to the rules log\./);

  const accepted = await runRulesAudit({
    cwd, paths: ["src"], max: 50, yes: false, config: guarded, set, judge, timeoutMs: 1000, destination: "api.example.test",
    confirm: () => true,
  });
  assert.equal(accepted.status, "done");
  assert.equal(judge.requests.length, 4, "one write request per file");
  assert.deepEqual(judge.requests.map(request => request.state.path).sort(), ["src/a.ts", "src/b.ts", "src/c.ts", "src/sub/d.ts"]);
  for (const request of judge.requests) {
    assert.ok(typeof request.state.content === "string", "each file is judged as a write");
    assert.ok("rule_no-console-statements" in request.questions);
    assert.ok("rule_return-types-on-exports" in request.questions);
    assert.ok(!("rule_docs-stay-calm" in request.questions), "path-scoped rules stay out of other files");
  }
});

test("runRulesAudit: --yes skips the dialog, a headless run without --yes sends nothing", async () => {
  const guarded = config({ exclude: ["src/secret/**"], skip: ["**/*.test.ts"] });
  const judge = stubJudge({});
  const accepted = await runRulesAudit({
    cwd, paths: ["src"], max: 1, yes: true, config: guarded, set, judge, timeoutMs: 1000, destination: "api.example.test",
    confirm: () => { throw new Error("--yes must not open a dialog"); },
  });
  assert.equal(accepted.status, "done");
  if (accepted.status !== "done") return;
  assert.equal(accepted.outcome.leftOut, 3, "the cap is reported");
  assert.equal(judge.requests.length, 1);

  const headless = await runRulesAudit({
    cwd, paths: ["src"], max: 50, yes: false, config: guarded, set, judge, timeoutMs: 1000, destination: "api.example.test",
  });
  assert.equal(headless.status, "needs-yes");
  if (headless.status !== "needs-yes") return;
  assert.equal(headless.files, 4);
  assert.equal(judge.requests.length, 1, "without a dialog and without --yes nothing is sent");
});

test("runRulesAudit: with no judge it says so and sends nothing, before any dialog", async () => {
  const result = await runRulesAudit({
    cwd, paths: ["src"], max: 50, yes: false, config: config(), set, judge: undefined, timeoutMs: 1000, destination: "api.example.test",
    confirm: () => { throw new Error("no judge must not open a dialog"); },
  });
  assert.equal(result.status, "no-judge");
  const noRules = await runRulesAudit({
    cwd, paths: ["src"], max: 50, yes: true, config: config(), set: undefined, judge: stubJudge({}), timeoutMs: 1000, destination: "api.example.test",
  });
  assert.equal(noRules.status, "no-files");
  if (noRules.status !== "no-files") return;
  assert.match(noRules.reason, /no rules file/);
});

test("runRulesAudit: at most four requests are in flight at once", async () => {
  const many = await mkdtemp(join(tmpdir(), "pi-warden-rules-audit-many-"));
  try {
    for (let index = 0; index < 8; index++) await writeFile(join(many, `f${index}.ts`), `export const v${index} = ${index};\n`);
    await writeFile(join(many, "pi-warden.md"), "# Use const\nPrefer const.\n");
    const manySet = new RuleStore().load(many, config())!;
    let active = 0;
    let peak = 0;
    const judge = stubJudge({}, {
      wrap: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
      },
    });
    const result = await runRulesAudit({ cwd: many, paths: ["."], max: 50, yes: true, config: config(), set: manySet, judge, timeoutMs: 1000, destination: "api.example.test" });
    assert.equal(result.status, "done");
    assert.equal(judge.requests.length, 8);
    assert.equal(peak, 4);
  } finally {
    await rm(many, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Table and list formatting

const finding = (id: string, name: string, violation: number) => ({ id, name, outcome: "violation" as const, violation, body: "" });
const clean = (id: string, name: string, violation: number) => ({ id, name, outcome: "compliant" as const, violation, body: "" });
const result = (path: string, findings: ReturnType<typeof finding>[] = [], soft: ReturnType<typeof finding>[] = [], scores: Array<ReturnType<typeof finding> | ReturnType<typeof clean>> = []): RulesAuditFileResult => ({
  path,
  verdict: {
    source: "typesafe", path, tool: "write", sources: ["pi-warden.md"], asked: 2, aggregate: false,
    scores: [...findings, ...soft, ...scores].map(item => ({ id: item.id, name: item.name, outcome: item.outcome, violation: item.violation })),
    findings,
    ...(soft.length ? { softFindings: soft } : {}),
  } satisfies RulesVerdict,
});

test("ruleAuditRows: one row per rule with files judged, files flagged, and the mean, flagged rows first", () => {
  const rows = ruleAuditRows([
    result("src/a.ts", [finding("no-console-statements", "No console statements", 0.91)]),
    result("src/b.ts", [finding("no-console-statements", "No console statements", 0.72), finding("errors-swallowed", "Errors are not swallowed", 0.80)]),
    result("src/c.ts", [], [], [clean("no-console-statements", "No console statements", 0.05)]),
  ]);
  assert.deepEqual(rows.map(row => [row.id, row.judged, row.flagged, Number(row.mean.toFixed(2))]), [
    ["no-console-statements", 3, 2, 0.56],
    ["errors-swallowed", 1, 1, 0.80],
  ]);
});

test("formatRulesAuditRows and formatRulesAuditFiles: the table and the worst-first file list in short lines", () => {
  const results = [
    result("src/b.ts", [finding("errors-swallowed", "Errors are not swallowed", 0.80)]),
    result("src/a.ts", [finding("no-console-statements", "No console statements", 0.91), finding("errors-swallowed", "Errors are not swallowed", 0.72)], [finding("comments-why", "Comments explain why, not what", 0.55)]),
  ];
  const table = formatRulesAuditRows(ruleAuditRows(results)).split("\n");
  assert.match(table[0]!, /^rule\s+judged\s+flagged\s+mean$/);
  assert.match(table[1]!, /^errors-swallowed\s+2\s+2\s+0\.76$/);
  assert.match(table[2]!, /^no-console-statements\s+1\s+1\s+0\.91$/);
  assert.match(table[3]!, /^comments-why\s+1\s+0\s+0\.55$/);
  assert.ok(table.every(line => line.length <= 70), "short terminal lines");

  const list = formatRulesAuditFiles(results);
  assert.deepEqual(list.split("\n"), [
    "src/a.ts",
    "  No console statements 0.91",
    "  Errors are not swallowed 0.72",
    "  Comments explain why, not what 0.55 (double-check)",
    "src/b.ts",
    "  Errors are not swallowed 0.80",
  ]);
  assert.equal(formatRulesAuditFiles([result("src/c.ts")]), "no file flagged");
  assert.deepEqual(flaggedAuditFiles(results).map(entry => entry.path), ["src/a.ts", "src/b.ts"], "most findings first");
});

test("formatRulesAudit: summary, table, file list, and where the Markdown copy went", () => {
  const results = [
    result("src/a.ts", [finding("no-console-statements", "No console statements", 0.91)]),
    result("src/b.ts", [], [], [clean("no-console-statements", "No console statements", 0.05)]),
    result("src/c.ts", [], [], [clean("no-console-statements", "No console statements", 0.05)]),
  ];
  const outcome: RulesAuditOutcome = {
    paths: ["src"], max: 2, selected: 3, judged: 3, leftOut: 1, missing: ["nowhere.ts"], unreadable: ["src/empty.ts"], errors: ["src/boom.ts"],
    results, rows: ruleAuditRows(results), flagged: 1, sources: ["pi-warden.md"], rules: 1, aggregate: false,
    reportPath: ".pi-warden/rules-audit.md", elapsedMs: 12,
  };
  const lines = formatRulesAudit(outcome).split("\n");
  assert.equal(lines[0], "Rules audit: 3 files judged as new writes against pi-warden.md (1 rule in play); 1 left out at the --max 2 cap; 1 of 3 flagged.");
  assert.match(lines[1]!, /^rule\s+judged\s+flagged\s+mean$/);
  assert.match(lines[2]!, /^no-console-statements\s+3\s+1\s+0\.34$/);
  assert.equal(lines[3], "flagged files, worst first:");
  assert.deepEqual(lines.slice(4, 6), ["src/a.ts", "  No console statements 0.91"]);
  assert.equal(lines[6], "not found in the project: nowhere.ts.");
  assert.equal(lines[7], "not judged (unreadable or empty): src/empty.ts.");
  assert.equal(lines[8], "judgment failed for 1 file: src/boom.ts.");
  assert.equal(lines[9], "Markdown copy: .pi-warden/rules-audit.md. Nothing was recorded in the rules log.");
});

test("runRulesAudit writes the Markdown copy to .pi-warden/rules-audit.md and touches no rules log", async () => {
  const judge = stubJudge({ "no-console-statements": 0.95 });
  const outcome = await runRulesAudit({ cwd, paths: ["src"], max: 50, yes: true, config: config({ exclude: ["src/secret/**"], skip: ["**/*.test.ts"] }), set, judge, timeoutMs: 1000, destination: "api.example.test" });
  assert.equal(outcome.status, "done");
  const markdown = await readFile(join(cwd, ".pi-warden", "rules-audit.md"), "utf8");
  assert.match(markdown, /^# Rules audit\n/);
  assert.match(markdown, /- Judged: 4 of 4 selected files as new writes \(0 left out at the --max 50 cap\)/);
  assert.match(markdown, /## By rule\n\n\| rule \| judged \| flagged \| mean \|/);
  assert.match(markdown, /\| `no-console-statements` \| 4 \| 4 \| 0\.95 \|/);
  assert.match(markdown, /## Flagged files, worst first/);
  assert.match(markdown, /- `src\/a\.ts` — No console statements 0\.95/);
  assert.match(markdown, /Nothing was recorded in the rules log\.\n$/);
  assert.ok(!markdown.includes(cwd), "the copy carries no machine paths");
});

test("rulesAuditMarkdown: a clean run still writes a copy with no flagged files", () => {
  const outcome: RulesAuditOutcome = {
    paths: ["."], max: 50, selected: 1, judged: 1, leftOut: 0, missing: [], unreadable: [], errors: [],
    results: [result("src/a.ts")], rows: [], flagged: 0, sources: ["pi-warden.md"], rules: 0, aggregate: false,
    reportPath: ".pi-warden/rules-audit.md", elapsedMs: 1,
  };
  const markdown = rulesAuditMarkdown(outcome, new Date("2026-10-01T00:00:00Z"));
  assert.match(markdown, /- Date: 2026-10-01T00:00:00\.000Z/);
  assert.match(markdown, /- no file flagged/);
});

// ---------------------------------------------------------------------------
// Bench statistics

test("percentile: nearest rank over a sorted list", () => {
  const values = Array.from({ length: 10 }, (_, index) => index + 1);
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), 0);
});

test("runBench: p50 and p95 latency from fake timings, and requests, tokens, and cost from getUsage", async () => {
  const timings = [40, 10, 30, 20];
  let clock = 0;
  let run = 0;
  const usage: BenchUsage = { requestsStarted: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  const judge: Judge = {
    async evaluate() {
      clock += timings[run++]!;
      usage.requestsStarted += 1;
      usage.inputTokens += 100;
      usage.estimatedUsd += 0.001;
      return { model: "jev-test", elapsedMs: 5, answers: {
        "rule_no-console-statements": { type: "choice", choice: "compliant", confidence: 0.9, probabilities: { compliant: 0.95, violation: 0.04, not_applicable: 0.005, insufficient_context: 0.005 } },
        "rule_return-types-on-exports": { type: "choice", choice: "compliant", confidence: 0.9, probabilities: { compliant: 0.95, violation: 0.04, not_applicable: 0.005, insufficient_context: 0.005 } },
      } } as never;
    },
  };
  const result = await runBench({
    runs: 4, cwd, config: config(), set, judge, getUsage: () => ({ ...usage }), timeoutMs: 1000, now: () => clock,
  });
  assert.equal(result.status, "done");
  if (result.status !== "done") return;
  assert.equal(result.p50, 20);
  assert.equal(result.p95, 40);
  assert.equal(result.requests, 4);
  assert.equal(result.asked, 2);
  assert.equal(result.meanInputTokens, 100);
  assert.equal(result.costPerCheck, 0.001);
  assert.equal(result.costPer100, 0.1);
  const text = formatBench(result);
  assert.match(text, /^Bench: 4 checks of one built-in sample file against the active rules \(2 rules per check\)\.$/m);
  assert.match(text, /The sample is built in and no project content is sent, so no confirmation was needed\./);
  assert.match(text, /Latency: p50 20 ms, p95 40 ms; requests 4\./);
  assert.match(text, /Input tokens per check: 100 \(mean\)\./);
  assert.match(text, /Estimated cost per check: \$0\.001000; per 100 edits: \$0\.100000\./);
});

test("runBench: with no judge it says so and sends nothing", async () => {
  const result = await runBench({
    runs: 10, cwd, config: config(), set, judge: undefined,
    getUsage: () => { throw new Error("no usage without a judge"); }, timeoutMs: 1000,
  });
  assert.equal(result.status, "no-judge");
});

test("runBench: a sample the rules keep out is reported and never sent", async () => {
  const judge = stubJudge({});
  const excluded = await runBench({ runs: 2, cwd, config: config({ exclude: ["src/**"] }), set, judge, timeoutMs: 1000 });
  assert.equal(excluded.status, "skipped");
  if (excluded.status !== "skipped") return;
  assert.match(excluded.reason, /rules\.exclude/);
  const skipped = await runBench({ runs: 2, cwd, config: config({ skip: ["**/warden-bench-sample.ts"] }), set, judge, timeoutMs: 1000 });
  assert.equal(skipped.status, "skipped");
  if (skipped.status !== "skipped") return;
  assert.match(skipped.reason, /rules\.skip/);
  assert.equal(judge.requests.length, 0);
});
