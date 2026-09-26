import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareEvaluationRequest } from "pi-typesafe";
import * as lib from "../src/index.js";
import { buildArms, fileType } from "../eval/judge-bench/arms.mjs";
import { loadCases, type BenchCase } from "../eval/judge-bench/cases.mjs";
import { parseFailure, signature } from "../eval/judge-bench/parse.mjs";
import { main } from "../eval/judge-bench/run.mjs";
import { predict, signTest } from "../eval/judge-bench/score.mjs";

const cases = loadCases();
const byId = (id: string) => {
  const c = cases.find(x => x.id === id);
  assert.ok(c, `case ${id}`);
  return c;
};
/** The n-th failed output of a case (0-based). */
const failedOutput = (id: string, n = 0) => {
  const output = byId(id).calls.filter(call => call.failed)[n]?.output;
  assert.ok(output, `failed output ${n} of ${id}`);
  return output;
};

test("judge bench: every fixture loads, has a label, a reason, and a known source", () => {
  assert.equal(cases.length, 80);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) {
    const labels = c.guard === "stuck" ? ["stuck", "progressing"] : ["done", "not_done"];
    assert.ok(labels.includes(c.label), `${c.id} label ${c.label}`);
    assert.ok(c.why.trim().length > 10, `${c.id} why`);
    assert.ok(c.task.trim(), `${c.id} task`);
    assert.ok(c.category, `${c.id} category`);
    assert.ok(["real-tool", "authored"].includes(c.source), `${c.id} source`);
    if (c.guard === "stuck") assert.ok(c.calls.filter(call => call.failed).length >= 3, `${c.id} reaches the guard's three failures`);
    else assert.ok(c.final?.trim(), `${c.id} final message`);
  }
  for (const guard of ["stuck", "done"] as const) {
    const subset = cases.filter(c => c.guard === guard);
    const positive = subset.filter(c => c.label === (guard === "stuck" ? "stuck" : "not_done")).length;
    assert.equal(subset.length, 40);
    assert.equal(positive, 20);
  }
});

test("judge bench: fixtures carry no machine paths", () => {
  for (const c of cases) {
    const text = JSON.stringify(c);
    assert.doesNotMatch(text, /\/Users\/|\/var\/folders\/|\/private\/|[A-Z]:\\\\Users/, c.id);
  }
});

test("judge bench: every arm builds a valid request with the guard's own questions", () => {
  for (const c of cases) {
    const arms = buildArms(lib, c);
    const questions = c.guard === "stuck" ? lib.stuckQuestions : lib.doneQuestions;
    for (const arm of ["A", "B", "C"] as const) {
      const request = arms[arm];
      assert.equal(request.questions, questions, `${c.id} ${arm} questions`);
      assert.doesNotThrow(() => prepareEvaluationRequest(JSON.parse(JSON.stringify(request))), `${c.id} ${arm} valid`);
    }
    assert.ok("evidence" in arms.C.state, `${c.id} C has evidence`);
    if (c.guard === "stuck") {
      const attempts = c.calls.slice(-12).map(call => lib.makeAttempt(call.tool, call.input, [{ type: "text", text: call.output }], call.failed));
      assert.deepEqual(arms.A.state, lib.buildStuckRequest(attempts, lib.redact(c.task)).state, `${c.id} A is the real builder's state`);
    }
  }
});

test("judge bench: arm A for done is buildDoneRequest over the recorded evidence", () => {
  const c = byId("d34");
  const evidence = lib.emptyEvidence();
  for (const call of c.calls) lib.recordOutcome(evidence, lib.classifyToolResult(call.tool, call.input, call.failed, call.output), call.input, call.tool);
  assert.deepEqual(buildArms(lib, c).A.state, lib.buildDoneRequest(c.task, c.final ?? "", evidence).state);
});

test("judge bench: every string in every arm is redacted", () => {
  const secret = "sk-live0123456789abcdefXYZ";
  const leaky: BenchCase[] = [
    { id: "x1", guard: "stuck", label: "stuck", category: "test", format: "script", source: "authored", why: "redaction check", task: `deploy with api_key=${secret}`, calls: Array.from({ length: 3 }, () => ({ tool: "bash", failed: true, input: { command: `API_KEY=${secret} ./deploy.sh` }, output: `Error: token ${secret} rejected\n` })) },
    { id: "x2", guard: "done", label: "not_done", category: "test", format: "none", source: "authored", why: "redaction check", task: `rotate ${secret}`, final: `Rotated ${secret}.`, calls: [{ tool: "edit", failed: false, input: { path: "src/keys.ts", oldText: "a", newText: `const key = "${secret}";` }, output: "ok" }, { tool: "bash", failed: true, input: { command: "npm test" }, output: `FAIL key ${secret}\n` }] },
  ];
  for (const c of leaky) {
    const arms = buildArms(lib, c);
    for (const arm of ["A", "B", "C"] as const) assert.doesNotMatch(JSON.stringify(arms[arm].state), new RegExp(secret), `${c.id} ${arm}`);
  }
});

test("judge bench: the parser finds the failing test in one sample of each runner format", () => {
  const samples: Array<[string, string, number, string]> = [
    ["tap", "s01", 0, "weekStart maps Sunday to the previous Monday"],
    ["jest", "s02", 0, "cart › applies the bulk discount at 10 items"],
    ["vitest", "s03", 0, "src/slug.test.ts > slugify > strips diacritics"],
    ["pytest", "s10", 2, "tests/test_invoice.py::test_invoice_due_date"],
    ["cargo", "s19", 1, "tests::split_remainder"],
    ["go", "s18", 1, "TestNormalizeSKU/whitespace"],
    ["playwright", "s29", 0, "[chromium] tests/checkout.spec.ts:8:5 › checkout › completes checkout"],
    ["test-script", "s04", 1, "split-spaces"],
  ];
  for (const [format, id, n, name] of samples) {
    const parsed = parseFailure(failedOutput(id, n));
    assert.equal(parsed.format, format, id);
    assert.ok(parsed.failing.includes(name), `${id}: ${JSON.stringify(parsed.failing)}`);
  }
});

test("judge bench: the parser names the error for compilers, linters and scripts", () => {
  const tsc = parseFailure(failedOutput("s05", 1));
  assert.equal(tsc.format, "tsc");
  assert.match(tsc.errors[0] ?? "", /^TS2345 src\/order\.ts:/);
  const eslint = parseFailure(failedOutput("s11", 2));
  assert.equal(eslint.format, "eslint");
  assert.ok(eslint.errors.some(e => e.includes("no-unused-vars")));
  const python = parseFailure(failedOutput("s13", 0));
  assert.equal(python.format, "python-traceback");
  assert.equal(python.errors[0], "KeyError: 'user_id'");
  const node = parseFailure(failedOutput("s31", 0));
  assert.equal(node.format, "node-error");
  assert.match(node.errors[0] ?? "", /ENOENT/);
  const lisp = parseFailure(failedOutput("s16", 0));
  assert.equal(lisp.format, "lisp-condition");
  assert.match(lisp.errors[0] ?? "", /Couldn't load "src\/util\.lisp"/);
});

test("judge bench: an unknown format falls back to head and tail in arm C", () => {
  const output = `${"step ".repeat(200)}\nthe widget exploded in an unexpected way\n${"more ".repeat(200)}`;
  assert.equal(parseFailure("just some words\nand more words").format, "unparsed");
  const c: BenchCase = { id: "x3", guard: "stuck", label: "stuck", category: "test", format: "unknown", source: "authored", why: "fallback check", task: "t", calls: Array.from({ length: 3 }, () => ({ tool: "bash", failed: true, input: { command: "./run-thing" }, output })) };
  const runs = (buildArms(lib, c).C.state.evidence as { runs: Array<Record<string, unknown>> }).runs;
  assert.equal(runs.length, 3);
  for (const run of runs) {
    assert.equal(typeof run.output_head_tail, "string");
    assert.equal(run.parser, undefined);
  }
});

test("judge bench: failure signatures ignore line numbers, times, temp paths and order", () => {
  for (const id of ["s33", "s34", "s35", "s36", "s37", "s38", "s39", "s40"]) {
    const outputs = byId(id).calls.filter(call => call.failed).map(call => call.output);
    const sigs = new Set(outputs.map(o => signature(parseFailure(o), o)));
    assert.equal(sigs.size, 1, id);
  }
  const progress = byId("s09").calls.filter(call => call.failed).map(call => signature(parseFailure(call.output), call.output));
  assert.equal(new Set(progress).size, 3);
});

test("judge bench: file types for the done evidence", () => {
  assert.equal(fileType("README.md"), "doc");
  assert.equal(fileType("docs/releases/1.8.0.md"), "doc");
  assert.equal(fileType(".github/workflows/ci.yml"), "config");
  assert.equal(fileType("Makefile"), "config");
  assert.equal(fileType("src/retry.test.ts"), "test");
  assert.equal(fileType("inv/sku_test.go"), "test");
  assert.equal(fileType("src/client/retry.rs"), "code");
});

test("judge bench: scoring applies the guards' thresholds and gate", () => {
  const t = { sameStrategy: 0.7, claimsDone: 0.7, applies: 0.5 };
  assert.equal(predict({ guard: "stuck" }, { same_strategy: 0.71 }, {}, t).flag, true);
  assert.equal(predict({ guard: "stuck" }, { same_strategy: 0.69 }, {}, t).flag, false);
  assert.equal(predict({ guard: "stuck" }, { same_strategy: 0.1 }, { codeDecided: "exact-repeat" }, t).flag, true);
  const answers = { claims_done: 0.9, verification_applies: 0.8, outcome: "complete" };
  assert.equal(predict({ guard: "done" }, answers, { reached: true }, t).flag, true);
  assert.equal(predict({ guard: "done" }, answers, { reached: false }, t).flag, false);
  assert.equal(predict({ guard: "done" }, { ...answers, outcome: "blocked" }, { reached: true }, t).flag, false);
  assert.equal(predict({ guard: "done" }, { ...answers, verification_applies: 0.4 }, { reached: true }, t).flag, false);
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(6, 0), 0.03125);
  assert.equal(signTest(3, 3), 1);
});

test("judge bench: --dry-run lists the plan and sends nothing", async () => {
  const lines: string[] = [];
  let judges = 0;
  let asks = 0;
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches++;
    throw new Error("network use in a dry run");
  }) as typeof fetch;
  try {
    const result = await main(["--dry-run", "--repeats", "3", "--budget", "900"], {
      lib,
      createJudge: () => { judges++; throw new Error("judge created in a dry run"); },
      ask: async () => { asks++; throw new Error("request in a dry run"); },
      log: line => lines.push(line),
    });
    assert.equal(result.sent, 0);
    assert.equal(result.planned, 720);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(judges, 0);
  assert.equal(asks, 0);
  assert.equal(fetches, 0);
  const text = lines.join("\n");
  assert.match(text, /^s01 stuck progressing test-changes tap real-tool {2}A \d+B {2}B \d+B {2}C \d+B$/m);
  assert.match(text, /requests planned: 720 \(80 cases x 3 arms x 3 repeats\); budget 900/);
  assert.match(text, /dry run: 0 requests sent/);
});
