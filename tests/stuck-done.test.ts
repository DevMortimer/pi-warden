import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeSafeIntegrationError } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import { buildDoneRequest, classifyToolResult, doneNudge, emptyEvidence, evaluateDone, finalAssistantText, formatDone, needsDoneCheck, recordOutcome } from "../src/done.js";
import type { Judge } from "../src/guard.js";
import { AttemptWindow, buildStuckRequest, evaluateStuck, formatStuck, makeAttempt, resultFailed, stuckNudge } from "../src/stuck.js";

const text = (value: string) => [{ type: "text", text: value }];
const stuckJudge = (sameStrategy: number, approachChange: number, progress: number) => {
  const calls: unknown[] = [];
  const judge: Judge & { calls: unknown[] } = {
    calls,
    async evaluate(request) {
      calls.push(request);
      return {
        model: "jev-test", elapsedMs: 9, usage: { input_tokens: 10, output_tokens: 0 },
        answers: {
          same_strategy: { type: "noul", noul: sameStrategy },
          approach_change: { type: "score", score: approachChange, confidence: 0.7, probabilities: { "0": 0, "1": 0, "2": 0 } },
          progress: { type: "noul", noul: progress },
        },
      } as never;
    },
  };
  return judge;
};
const doneJudge = (claimsDone: number, claimsVerified: number, outcome: string, applies = 0.9) => {
  const calls: unknown[] = [];
  const judge: Judge & { calls: unknown[] } = {
    calls,
    async evaluate(request) {
      calls.push(request);
      return {
        model: "jev-test", elapsedMs: 9, usage: { input_tokens: 10, output_tokens: 0 },
        answers: {
          claims_done: { type: "noul", noul: claimsDone },
          claims_verified: { type: "noul", noul: claimsVerified },
          verification_applies: { type: "noul", noul: applies },
          outcome: { type: "choice", choice: outcome, confidence: 0.8, probabilities: { [outcome]: 0.8 } },
        },
      } as never;
    },
  };
  return judge;
};
const failing: Judge = { async evaluate() { throw new TypeSafeIntegrationError("timeout", "synthetic timeout"); } };
const stuckConfig = defaultConfig().stuck;

test("makeAttempt keys the exact call, redacts, and keeps the output tail", () => {
  const long = `${"x".repeat(1000)}Error: ENOENT no such file TOKEN=sk-live-0123456789abcdef`;
  const attempt = makeAttempt("bash", { command: "npm test" }, text(long), true);
  assert.equal(attempt.tool, "bash");
  assert.equal(attempt.call, "npm test");
  assert.ok(attempt.output.length <= 440);
  assert.match(attempt.output, /ENOENT/);
  assert.ok(!attempt.output.includes("sk-live"));
  assert.equal(makeAttempt("bash", { command: "npm test" }, [], true).key, attempt.key);
  assert.notEqual(makeAttempt("bash", { command: "npm test -- --watch" }, [], true).key, attempt.key);
  assert.equal(makeAttempt("edit", { path: "src/a.ts", edits: [] }, [], false).call, "edit src/a.ts");
  assert.equal(resultFailed(false, { exitCode: 1 }), true);
  assert.equal(resultFailed(false, { exitCode: 0 }), false);
  assert.equal(resultFailed(true, undefined), true);
  assert.equal(resultFailed(false, undefined, text("```shell\nnpm test\n```\n\n1 failing\n\nCommand exited with code 1")), true, "context-mode reports the exit code inline");
  assert.equal(resultFailed(false, undefined, text("30 passing\n")), false);
  assert.equal(makeAttempt("ctx_batch_execute", { commands: [{ label: "a", command: "npm test" }, { label: "b", command: "git diff" }] }, [], false).call, "npm test\ngit diff");
});

test("AttemptWindow trims, counts failures and exact repeats, and honours the cool-down", () => {
  const window = new AttemptWindow(3);
  for (let index = 0; index < 5; index++) window.push(makeAttempt("bash", { command: `cmd ${index}` }, text("boom"), index % 2 === 0));
  assert.equal(window.attempts.length, 3);
  assert.equal(window.failures(), 2);
  assert.equal(window.exactRepeats(), 1);
  assert.equal(window.shouldJudge(stuckConfig), false, "2 failures < minFailures 3");

  const repeats = new AttemptWindow(12);
  for (let index = 0; index < 3; index++) repeats.push(makeAttempt("bash", { command: "npm test" }, text("fail"), true));
  assert.equal(repeats.exactRepeats(), 3);
  assert.equal(repeats.shouldJudge(stuckConfig), true);
  repeats.markJudged();
  repeats.push(makeAttempt("bash", { command: "npm test" }, text("fail"), true));
  assert.equal(repeats.shouldJudge(stuckConfig), false, "cool-down: 1 result since the last check");
  repeats.push(makeAttempt("bash", { command: "npm test" }, text("fail"), true));
  repeats.push(makeAttempt("bash", { command: "npm test" }, text("fail"), true));
  assert.equal(repeats.shouldJudge(stuckConfig), true);
  repeats.push(makeAttempt("bash", { command: "ls" }, text("ok"), false));
  assert.equal(repeats.shouldJudge(stuckConfig), false, "latest result succeeded");
  repeats.reset();
  assert.equal(repeats.attempts.length, 0);
});

test("evaluateStuck decides exact repeats in code and asks Jev otherwise", async () => {
  const window = new AttemptWindow(12);
  for (let index = 0; index < 3; index++) window.push(makeAttempt("bash", { command: "npm test" }, text("1 failing"), true));
  const j = stuckJudge(0.9, 0, 0.1);
  const repeat = await evaluateStuck(window, "fix tests", { config: stuckConfig, judge: j, timeoutMs: 1000 });
  assert.equal(repeat.stuck, true);
  assert.equal(repeat.source, "repeat");
  assert.equal(j.calls.length, 0, "no network for exact repeats");
  assert.match(stuckNudge(repeat), /failed 3 times with the same output/);

  const progressing = new AttemptWindow(12);
  progressing.push(makeAttempt("bash", { command: "npm test" }, text("3 failing (412 ms)"), true));
  progressing.push(makeAttempt("bash", { command: "npm test" }, text("2 failing (398 ms)"), true));
  progressing.push(makeAttempt("bash", { command: "npm test" }, text("1 failing (401 ms)"), true));
  assert.equal(progressing.exactRepeats(), 1, "same command, different output: the normal fix-and-rerun loop");
  const timing = new AttemptWindow(12);
  timing.push(makeAttempt("bash", { command: "npm test" }, text("1 failing (412 ms)"), true));
  timing.push(makeAttempt("bash", { command: "npm test" }, text("1 failing (398 ms)"), true));
  assert.equal(timing.exactRepeats(), 2, "only digits differ: still the same output");
  assert.match(formatStuck(repeat), /exact repeat · stuck$/);

  const varied = new AttemptWindow(12);
  varied.push(makeAttempt("bash", { command: "npm test" }, text("1 failing"), true));
  varied.push(makeAttempt("bash", { command: "npm test -- --verbose" }, text("1 failing"), true));
  varied.push(makeAttempt("bash", { command: "npx jest tests/a.test.ts" }, text("1 failing"), true));
  const stuck = await evaluateStuck(varied, "fix tests", { config: stuckConfig, judge: stuckJudge(0.85, 1, 0.1), timeoutMs: 1000 });
  assert.equal(stuck.stuck, true);
  assert.equal(stuck.source, "typesafe");
  assert.match(stuck.reasons[0] ?? "", /3 failures with the same strategy \(0\.85\)/);
  assert.match(stuckNudge(stuck), /new hypothesis/);

  const fine = await evaluateStuck(varied, "fix tests", { config: stuckConfig, judge: stuckJudge(0.2, 2, 0.8), timeoutMs: 1000 });
  assert.equal(fine.stuck, false);
  assert.deepEqual(fine.reasons, []);

  const offline = await evaluateStuck(varied, "fix tests", { config: stuckConfig, timeoutMs: 1000 });
  assert.equal(offline.stuck, false);
  assert.equal(offline.source, "repeat");

  const errored = await evaluateStuck(varied, "fix tests", { config: stuckConfig, judge: failing, timeoutMs: 1000 });
  assert.equal(errored.stuck, false);
  assert.equal(errored.source, "error");
  assert.match(errored.error ?? "", /synthetic timeout/);
});

test("buildStuckRequest sends numbered attempts with outcomes and a task", () => {
  const window = new AttemptWindow(12);
  window.push(makeAttempt("bash", { command: "npm test" }, text("boom"), true));
  window.push(makeAttempt("edit", { path: "a.ts", edits: [] }, text("ok"), false));
  const request = buildStuckRequest(window.attempts, "fix it");
  assert.equal(request.state.task, "fix it");
  assert.deepEqual(request.state.attempts, [
    { n: 1, tool: "bash", call: "npm test", outcome: "failed", output: "boom" },
    { n: 2, tool: "edit", call: "edit a.ts", outcome: "ok", output: "ok" },
  ]);
  assert.deepEqual(Object.keys(request.questions).sort(), ["approach_change", "progress", "same_strategy"]);
});

test("classifyToolResult separates reads, mutations, and checks", () => {
  assert.equal(classifyToolResult("read", { path: "a" }, false), "read");
  assert.equal(classifyToolResult("write", { path: "a", content: "" }, false), "mutation");
  assert.equal(classifyToolResult("edit", { path: "a", edits: [] }, false), "mutation");
  assert.equal(classifyToolResult("bash", { command: "git status" }, false), "read");
  assert.equal(classifyToolResult("bash", { command: "npm install ajv" }, false), "unknown", "shell side effects are not code changes");
  assert.equal(classifyToolResult("bash", { command: "rm -rf /tmp/demo" }, false), "unknown");
  assert.equal(classifyToolResult("bash", { command: "npm test" }, false), "check-pass");
  assert.equal(classifyToolResult("bash", { command: "npm test" }, true), "check-fail");
  assert.equal(classifyToolResult("bash", { command: "npx tsc --noEmit && npm run lint" }, false), "check-pass");
  assert.equal(classifyToolResult("bash", { command: "cargo test" }, false), "check-pass");
  assert.equal(classifyToolResult("bash", { command: "pytest -q" }, true), "check-fail");
  assert.equal(classifyToolResult("ctx_execute", { language: "shell", code: "cd app && npm test 2>&1 | tail -5" }, false), "check-pass", "context-mode shell runs count");
  assert.equal(classifyToolResult("ctx_execute", { language: "javascript", code: "console.log(require('fs').readdirSync('.'))" }, false), "unknown", "non-shell code is neither read nor check");
  assert.equal(classifyToolResult("ctx_batch_execute", { commands: [{ label: "t", command: "pytest -q" }, { label: "s", command: "git status" }] }, true), "check-fail");
  assert.equal(classifyToolResult("ctx_execute", { language: "shell", code: "ls -la && git log -3" }, false), "read");
  assert.equal(classifyToolResult("mcp_something", { query: "x" }, false), "unknown");
  const viaCtx = emptyEvidence();
  recordOutcome(viaCtx, "check-pass", { language: "shell", code: "npm test" }, "ctx_execute");
  assert.deepEqual(viaCtx.checks, [{ call: "npm test", passed: true }]);
});

test("evidence gates the done-check", () => {
  const evidence = emptyEvidence();
  assert.equal(needsDoneCheck(evidence), false, "no changes, nothing to verify");
  recordOutcome(evidence, "mutation", { path: "a.ts" });
  assert.equal(needsDoneCheck(evidence), true);
  recordOutcome(evidence, "check-fail", { command: "npm test" });
  assert.equal(needsDoneCheck(evidence), true, "a failed check is not verification");
  recordOutcome(evidence, "check-pass", { command: "npm test" });
  assert.equal(needsDoneCheck(evidence), false);
  assert.deepEqual(evidence.checks.map(check => check.passed), [false, true]);
});

test("finalAssistantText takes the last assistant message only when it stopped normally with text", () => {
  const messages = [
    { role: "user", content: "fix it" },
    { role: "assistant", content: [{ type: "text", text: "Done, all fixed." }], stopReason: "stop" },
    { role: "toolResult", content: [] },
  ];
  assert.equal(finalAssistantText(messages), "Done, all fixed.");
  assert.equal(finalAssistantText([{ role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse" }]), undefined);
  assert.equal(finalAssistantText([{ role: "assistant", content: "aborted", stopReason: "aborted" }]), undefined);
  assert.equal(finalAssistantText([{ role: "user", content: "hi" }]), undefined);
  assert.equal(finalAssistantText([{ role: "assistant", content: "plain string" }]), "plain string");
});

test("evaluateDone flags unverified completion claims and false verification claims", async () => {
  const evidence = emptyEvidence();
  recordOutcome(evidence, "mutation", {});
  recordOutcome(evidence, "mutation", {});
  const config = defaultConfig().done;

  const unverified = await evaluateDone("fix the parser bug", "Fixed the parser bug in src/parser.ts.", evidence, { config, judge: doneJudge(0.9, 0.1, "complete"), timeoutMs: 1000 });
  assert.equal(unverified.unverified, true);
  assert.equal(unverified.falseClaim, false);
  assert.match(unverified.reasons[0] ?? "", /reports completion \(0\.90\) after 2 file changes with no test, build, or lint run/);
  assert.match(doneNudge(unverified), /Run the project's tests, build, or lint/);
  assert.match(formatDone(unverified), /2 changes · 0\/0 checks passed .* unverified$/);

  const lie = await evaluateDone("fix it", "Fixed and all tests pass.", evidence, { config, judge: doneJudge(0.95, 0.9, "complete"), timeoutMs: 1000 });
  assert.equal(lie.falseClaim, true);
  assert.match(lie.reasons[1] ?? "", /claims checks passed \(0\.90\) but none ran/);
  assert.match(formatDone(lie), /false claim$/);

  const blocked = await evaluateDone("fix it", "I could not reproduce it; which Node version do you use?", evidence, { config, judge: doneJudge(0.8, 0.0, "blocked"), timeoutMs: 1000 });
  assert.equal(blocked.unverified, false, "a blocker or question is not a completion claim");

  const partial = await evaluateDone("fix it", "Changed the regex; still need to handle the empty case.", evidence, { config, judge: doneJudge(0.3, 0.0, "partial"), timeoutMs: 1000 });
  assert.equal(partial.unverified, false);

  const prose = await evaluateDone("rewrite the README intro", "Rewrote the intro.", evidence, { config, judge: doneJudge(0.95, 0.0, "complete", 0.1), timeoutMs: 1000 });
  assert.equal(prose.unverified, false, "checks do not apply to prose work");

  const failedCheck = emptyEvidence();
  recordOutcome(failedCheck, "mutation", {});
  recordOutcome(failedCheck, "check-fail", { command: "npm test" });
  const afterFailure = await evaluateDone("fix it", "Done.", failedCheck, { config, judge: doneJudge(0.9, 0.1, "complete"), timeoutMs: 1000 });
  assert.match(afterFailure.reasons[0] ?? "", /1 failed check and no passing one/);
  assert.match(doneNudge(afterFailure), /The last check that ran failed: npm test/);

  const errored = await evaluateDone("fix it", "Done.", evidence, { config, judge: failing, timeoutMs: 1000 });
  assert.equal(errored.unverified, false);
  assert.match(errored.error ?? "", /synthetic timeout/);

  const request = buildDoneRequest("fix it", "Done. TOKEN=sk-live-0123456789abcdef", evidence);
  assert.ok(!request.state.final_message.includes("sk-live"));
  assert.deepEqual(request.state.run, { file_changes: 2, checks_run: [] });
});
