import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { applyProjectOverrides, applyUserOverrides, defaultConfig, loadConfig } from "../src/config.js";
import { buildStuckEvidence, EVIDENCE_LIMIT, editDiff, failureSignature, normaliseFailureText, parseFailure } from "../src/evidence.js";
import type { EvidenceRun, StuckEvidence } from "../src/evidence.js";
import type { Judge } from "../src/guard.js";
import { buildStuckRequest, evaluateStuck, makeAttempt, AttemptWindow } from "../src/stuck.js";

const text = (value: string) => [{ type: "text", text: value }];
const bash = (command: string, output: string, failed = true) => makeAttempt("bash", { command }, text(output), failed);
const edit = (path: string, oldText: string, newText: string) => makeAttempt("edit", { path, edits: [{ oldText, newText }] }, text("ok"), false);
const runsOf = (evidence: StuckEvidence | undefined): EvidenceRun[] => {
  assert.ok(evidence, "evidence");
  return evidence.runs;
};

test("buildStuckRequest without evidence is exactly the state the guard sent before", () => {
  const attempts = [bash("npm test", "not ok 1 - alpha\n  error: boom", true), edit("src/a.ts", "const x = 1;", "const x = 2;")];
  const request = buildStuckRequest(attempts, "fix the tests", { evidence: false });
  assert.deepEqual(request.state, {
    task: "fix the tests",
    attempts: attempts.map((attempt, index) => ({ n: index + 1, tool: attempt.tool, call: attempt.call, outcome: attempt.failed ? "failed" : "ok", output: attempt.output })),
  });
  assert.equal("evidence" in request.state, false);
  assert.deepEqual(Object.keys(request.state), ["task", "attempts"]);
  // The shipped default is on, and asking for it explicitly gives the same state.
  assert.deepEqual(buildStuckRequest(attempts, "fix the tests").state, buildStuckRequest(attempts, "fix the tests", { evidence: true }).state);
  assert.ok(buildStuckRequest(attempts, "fix the tests").state.evidence);
});

const SAMPLES: Array<[string, string, string]> = [
  ["tap", `TAP version 13\n# Subtest: week start\nnot ok 1 - weekStart maps Sunday to the previous Monday\n  ---\n  duration_ms: 3.1\n  location: '/home/dev/proj/src/week.test.js:8:3'\n  error: |-\n    expected 2024-03-03 to equal 2024-03-04\n  code: 'ERR_ASSERTION'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n`, "weekStart maps Sunday to the previous Monday"],
  ["jest", `FAIL src/cart.test.ts\n  ● cart › applies the bulk discount at 10 items\n\n    expect(received).toBe(expected)\n\n    Expected: 90\n    Received: 100\n\n      at Object.<anonymous> (src/cart.test.ts:42:5)\n\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 1 total\n`, "cart › applies the bulk discount at 10 items"],
  ["vitest", ` FAIL  src/slug.test.ts > slugify > strips diacritics\nAssertionError: expected 'cafe' to be 'café'\n\n ❯ src/slug.test.ts:12:20\n\n      Tests  1 failed | 3 passed\n`, "src/slug.test.ts > slugify > strips diacritics"],
  ["pytest", `=================== short test summary info ====================\nFAILED tests/test_invoice.py::test_invoice_due_date - AssertionError: assert '2024-02-01' == '2024-03-01'\n================= 1 failed, 3 passed in 0.42s =================\n`, "tests/test_invoice.py::test_invoice_due_date"],
  ["cargo", `running 3 tests\ntest tests::split_remainder ... FAILED\n\ntest result: FAILED. 2 passed; 1 failed; finished in 0.03s\n\n---- tests::split_remainder stdout ----\nthread 'tests::split_remainder' panicked at src/lib.rs:88:9:\ncalled \`Option::unwrap()\` on a \`None\` value\nnote: run with \`RUST_BACKTRACE=1\`\n`, "tests::split_remainder"],
  ["go", `--- FAIL: TestNormalizeSKU (0.00s)\n    --- FAIL: TestNormalizeSKU/whitespace (0.00s)\n        sku_test.go:44: got "AB", want "A B"\nFAIL\nFAIL\texample.com/inv\t0.012s\n`, "TestNormalizeSKU/whitespace"],
  ["test-script", `FAIL split-spaces: got 2 tokens, want 3\nFAIL empty-input: got 1 token, want 0\n1 passed, 2 failed\n`, "split-spaces"],
  ["playwright", `  1) [chromium] › tests/checkout.spec.ts:8:5 › checkout › completes checkout ──────\n\n    Error: expect(received).toHaveText(expected)\n\n    Expected string: "Order placed"\n    Received string: "Order failed"\n\n      at tests/checkout.spec.ts:14:5\n\n  1 failed\n  1 passed (2.4s)\n`, "[chromium] tests/checkout.spec.ts:8:5 › checkout › completes checkout"],
];

test("the parser names the failing test in one sample of each runner format", () => {
  for (const [format, output, name] of SAMPLES) {
    const parsed = parseFailure(output);
    assert.equal(parsed.format, format, `${format}: ${JSON.stringify(parsed)}`);
    assert.ok(parsed.failing.includes(name), `${format}: ${JSON.stringify(parsed.failing)}`);
  }
});

test("tsc, eslint and a Lisp condition are parsed too", () => {
  const tsc = parseFailure("src/order.ts(42,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n");
  assert.equal(tsc.format, "tsc");
  assert.equal(tsc.errors[0], "TS2345 src/order.ts: Argument of type 'string' is not assignable to parameter of type 'number'.");
  assert.equal(tsc.location, "src/order.ts:42:5");
  const eslint = parseFailure("/home/dev/proj/src/retry.js\n  12:7  error  'attempt' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n");
  assert.equal(eslint.format, "eslint");
  assert.ok(eslint.errors[0]?.includes("no-unused-vars"), JSON.stringify(eslint.errors));
  const lisp = parseFailure("Unhandled SIMPLE-ERROR in thread main:\n  Couldn't load \"src/util.lisp\"\n");
  assert.equal(lisp.format, "lisp-condition");
  assert.match(lisp.errors[0] ?? "", /Couldn't load/);
});

test("an output no parser knows falls back to the head and tail of the run", () => {
  const output = `${"step ".repeat(200)}\nthe widget exploded in an unexpected way\n${"more ".repeat(200)}`;
  assert.equal(parseFailure("just some words\nand more words").format, "unparsed");
  const evidence = buildStuckEvidence([bash("./run-thing", output), bash("./run-thing", output)]);
  assert.deepEqual(evidence.runs.map(run => run.parser), [undefined, undefined]);
  for (const run of evidence.runs) {
    assert.match(run.output_head_tail ?? "", /^step step/);
    assert.match(run.output_head_tail ?? "", /more more$/);
    assert.match(run.output_head_tail ?? "", /middle chars/);
    assert.equal((run.output_head_tail ?? "").length < output.length, true);
  }
});

test("a changed failure is a different signature, and the digest counts both", () => {
  const first = "not ok 1 - alpha\n  error: expected 1 to equal 2\nnot ok 2 - beta\n  error: boom\n";
  const second = "not ok 1 - alpha\n  error: expected 1 to equal 3\nnot ok 2 - beta\n  error: boom\n";
  const evidence = buildStuckEvidence([bash("npm test", first), bash("npm test", second)]);
  assert.equal(evidence.digest.failed_runs, 2);
  assert.equal(evidence.digest.distinct_failures, 2);
  assert.equal(evidence.digest.latest_failure_seen_before, false);
  assert.deepEqual(runsOf(evidence).map(run => run.same_failure_as_run), [null, null]);
});

test("line numbers, timestamps, temp paths and ordering are noise, not a changed failure", () => {
  assert.equal(normaliseFailureText("at src/a.test.js:8:3 in 812ms (12345)"), "at src/a.test.js:# in #t (#)");
  assert.equal(normaliseFailureText("/tmp/proj/x.log"), "<tmp>");
  assert.equal(normaliseFailureText("2026-09-26T10:00:01 build"), "<time> build");
  const outputs = [
    "not ok 1 - alpha\n  error: expected 1 to equal 2\n  location: '/home/dev/proj/src/a.test.js:8:3'\nnot ok 2 - beta\n  error: boom\n",
    "not ok 1 - beta\n  error: boom\n  location: '/home/dev/proj/src/b.test.js:9:4'\nnot ok 2 - alpha\n  error: expected 1 to equal 2\n  location: '/home/dev/proj/src/b.test.js:31:7'\n",
    "not ok 1 - alpha\n  error: expected 1 to equal 2\n  location: '/tmp/pytest-of-dev/pytest-91/a.test.js:19:2'\n  duration_ms: 812.4\nnot ok 2 - beta\n  error: boom\n  location: '/tmp/pytest-of-dev/pytest-91/a.test.js:44:1'\n",
  ];
  const signatures = outputs.map(output => failureSignature(parseFailure(output), output));
  assert.equal(new Set(signatures).size, 1);
  const evidence = buildStuckEvidence(outputs.map(output => bash("npm test", output)));
  assert.equal(evidence.digest.failed_runs, 3);
  assert.equal(evidence.digest.distinct_failures, 1);
  assert.equal(evidence.digest.latest_failure_seen_before, true);
  assert.deepEqual(runsOf(evidence).map(run => run.same_failure_as_run), [null, 1, 1]);
  assert.deepEqual(evidence.digest.same_command_runs, [2, 3]);
});

test("a token in an output or a diff never reaches the state", () => {
  const secret = "sk-live0123456789abcdefXYZ";
  const attempts = [
    bash(`API_KEY=${secret} ./deploy.sh`, `Error: token ${secret} rejected\n  at /home/dev/deploy.js:4:9\n`, true),
    makeAttempt("edit", { path: "src/keys.ts", edits: [{ oldText: "const key = 1;", newText: `const key = "${secret}";` }] }, text("ok"), false),
    bash(`API_KEY=${secret} ./deploy.sh`, `Error: token ${secret} rejected\n  at /home/dev/deploy.js:9:2\n`, true),
  ];
  const state = buildStuckRequest(attempts, "rotate the deploy key").state;
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));
  assert.match(JSON.stringify(state), /\[redacted\]/);
});

test("the evidence object holds its size cap by dropping the oldest runs first", () => {
  const huge = (n: number) => `${`filler ${n} `.repeat(4000)}\nthe widget exploded\n`;
  const attempts = Array.from({ length: 12 }, (unused, index) => bash(`npm test -- ${index}`, huge(index)));
  const evidence = buildStuckEvidence(attempts);
  const bytes = Buffer.byteLength(JSON.stringify(evidence));
  assert.ok(bytes <= EVIDENCE_LIMIT, `${bytes} bytes`);
  assert.ok(evidence.runs.length < 12, `runs ${evidence.runs.length}`);
  assert.equal(evidence.runs.at(-1)?.n, 12, "the newest run stays");
  assert.equal(evidence.runs[0]!.n > 1, true, "the oldest runs went first");
  assert.equal(evidence.digest.failed_runs, evidence.runs.length, "the digest counts what is left");
  assert.equal(evidence.digest.same_command_runs.length, 0, "no dropped run is referenced");
});

test("over the cap with one run left, the oldest edits go", () => {
  const oneRun = bash("npm test", "the widget exploded\n");
  const edits = Array.from({ length: 6 }, (unused, index) => edit(`src/file-${index}.ts`, `${"old\n".repeat(400)}`, `${"new\n".repeat(400)}`));
  const evidence = buildStuckEvidence([oneRun, ...edits]);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= EVIDENCE_LIMIT);
  assert.equal(evidence.runs.length, 1);
  assert.equal(evidence.edits.at(-1)?.n, 7, "the newest edit stays");
  assert.ok(evidence.edits.length < 6, `edits ${evidence.edits.length}`);
});

test("editDiff reports the path, the line counts and a capped diff", () => {
  const diff = editDiff("edit", { path: "src/a.ts", edits: [{ oldText: "one\ntwo\nthree", newText: "one\nTWO\nthree" }] });
  assert.equal(diff.path, "src/a.ts");
  assert.deepEqual(diff.removedLines, ["two"]);
  assert.deepEqual(diff.addedLines, ["TWO"]);
  assert.equal(diff.diff, "-two\n+TWO");
  const write = editDiff("write", { path: "src/b.ts", content: "line" });
  assert.deepEqual([write.added, write.removed], [1, 0]);
  assert.equal(write.diff, "+line");
  const long = editDiff("write", { path: "src/c.ts", content: Array.from({ length: 400 }, unused => "x".repeat(20)).join("\n") });
  assert.ok(long.diff.length < 700 && long.diff.endsWith("[diff capped]"), long.diff.length.toString());
  const attempt = edit("src/a.ts", "one\ntwo", "one\nTWO");
  assert.deepEqual(attempt.change, { path: "src/a.ts", added: 1, removed: 1, diff: "-two\n+TWO" });
  assert.equal(makeAttempt("bash", { command: "ls" }, text("ok"), false).change, undefined);
});

test("stuck.evidence is a boolean, defaults on, and is settable from the user and the project file", async () => {
  assert.equal(defaultConfig().stuck.evidence, true);
  assert.equal(applyUserOverrides(defaultConfig(), { stuck: { evidence: false } }).stuck.evidence, false);
  assert.equal(applyProjectOverrides(defaultConfig(), { stuck: { evidence: false } }).stuck.evidence, false);
  assert.equal(applyUserOverrides(defaultConfig(), { stuck: { evidence: "no" } }).stuck.evidence, true, "junk leaves the default");

  const temporary = await mkdtemp(join(tmpdir(), "pi-warden-evidence-"));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(temporary, "agent");
    const project = join(temporary, "project");
    await mkdir(join(agentDir, "pi-warden"), { recursive: true });
    await mkdir(join(project, ".pi"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(join(agentDir, "pi-warden", "config.json"), JSON.stringify({ stuck: { evidence: false } }));
    assert.equal(loadConfig().stuck.evidence, false, "the user file turns it off");
    await writeFile(join(project, ".pi", "pi-warden.json"), JSON.stringify({ stuck: { evidence: false } }));
    await rm(join(agentDir, "pi-warden", "config.json"));
    assert.equal(loadConfig({ cwd: project, projectTrusted: true }).stuck.evidence, false, "the project file turns it off");
    assert.equal(loadConfig({ cwd: project, projectTrusted: false }).stuck.evidence, true, "an untrusted project file is ignored");
  } finally {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("evaluateStuck sends the evidence the config asks for", async () => {
  const requests: Array<{ state: Record<string, unknown> }> = [];
  const judge: Judge = {
    async evaluate(request) {
      requests.push(request as unknown as { state: Record<string, unknown> });
      return {
        model: "jev-test", elapsedMs: 9, usage: { input_tokens: 10, output_tokens: 0 },
        answers: {
          same_strategy: { type: "noul", noul: 0.9 },
          approach_change: { type: "score", score: 1, confidence: 0.7, probabilities: { "0": 0, "1": 0, "2": 0 } },
          progress: { type: "noul", noul: 0.1 },
        },
      } as never;
    },
  };
  const base = defaultConfig().stuck;
  for (const [evidence, expected] of [[true, true], [false, false]] as const) {
    requests.length = 0;
    const window = new AttemptWindow(base.window);
    for (let index = 0; index < 3; index++) window.push(bash("npm test", `not ok 1 - alpha ${index}\n  error: boom\n`, true));
    const verdict = await evaluateStuck(window, "fix the tests", { config: { ...base, evidence }, judge, timeoutMs: 1000 });
    assert.equal(verdict.stuck, true);
    assert.equal("evidence" in requests[0]!.state, expected, `evidence ${evidence}`);
    if (expected) assert.equal((requests[0]!.state.evidence as StuckEvidence).digest.failed_runs, 3);
  }
});
