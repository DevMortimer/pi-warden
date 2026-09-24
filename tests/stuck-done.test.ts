import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeSafeIntegrationError } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import { buildDoneRequest, classifyToolResult, doneNudge, emptyEvidence, evaluateDone, finalAssistantText, formatDone, freshChecks, isUiFile, isVisualCheck, needsDoneCheck, recordOutcome, recordUi } from "../src/done.js";
import type { Judge } from "../src/guard.js";
import { AttemptWindow, buildStuckRequest, evaluateStuck, formatStuck, makeAttempt, quickRepeatNudge, resultFailed, stuckDiff, stuckNudge } from "../src/stuck.js";

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

  const polling = new AttemptWindow(12);
  const poll = { command: "sleep 5 && gh pr checks 2673" };
  for (let index = 0; index < 2; index++) polling.push(makeAttempt("bash", poll, text("all checks passed"), false));
  assert.equal(polling.successRepeats(), 2);
  assert.equal(polling.shouldJudge(stuckConfig), false, "2 successful repeats < minFailures 3");
  polling.push(makeAttempt("bash", poll, text("all checks passed"), false));
  assert.equal(polling.successRepeats(), 3);
  assert.equal(polling.shouldJudge(stuckConfig), true, "a successful poll that keeps printing the same answer is judged");
  polling.push(makeAttempt("bash", poll, text("3 of 4 checks passed"), false));
  assert.equal(polling.successRepeats(), 1, "a changed answer is progress, not a repeat");
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

  const pollWindow = new AttemptWindow(12);
  for (let index = 0; index < 3; index++) pollWindow.push(makeAttempt("bash", { command: "sleep 5 && gh pr checks 2673" }, text("all checks passed"), false));
  const pollJudge = stuckJudge(0, 0, 0);
  const pollVerdict = await evaluateStuck(pollWindow, "watch the PR", { config: stuckConfig, judge: pollJudge, timeoutMs: 1000 });
  assert.equal(pollVerdict.stuck, true, "the same call succeeding with the same output is a repeat, decided in code");
  assert.equal(pollVerdict.source, "repeat");
  assert.equal(pollVerdict.successRepeat, true);
  assert.equal(pollJudge.calls.length, 0, "no network for successful repeats either");
  assert.match(pollVerdict.reasons[0] ?? "", /succeeded 3 times with the same output/);
  assert.match(stuckNudge(pollVerdict), /Stop re-running it/, "the nudge says to use the answer, not to debug a failure");
  assert.match(formatStuck(pollVerdict), /successful repeat \u00b7 stuck$/);

  const errored = await evaluateStuck(varied, "fix tests", { config: stuckConfig, judge: failing, timeoutMs: 1000 });
  assert.equal(errored.stuck, false);
  assert.equal(errored.source, "error");
  assert.match(errored.error ?? "", /synthetic timeout/);
});

test("churnCount detects repeated calls to the same target with changing output", () => {
  const window = new AttemptWindow(12);
  // Same command, different output each time — churn, not an exact repeat.
  const poll = { command: "gh pr checks 2673" };
  window.push(makeAttempt("bash", poll, text("1 of 4 checks passed"), false));
  window.push(makeAttempt("bash", poll, text("2 of 4 checks passed"), false));
  window.push(makeAttempt("bash", poll, text("3 of 4 checks passed"), false));
  assert.equal(window.churnCount(), 3, "three calls to the same target count as churn");
  assert.equal(window.exactRepeats(), 0, "different output each time is not an exact repeat");
  assert.equal(window.successRepeats(), 1, "different output each time: only the latest matches itself");
  const churnConfig = { ...stuckConfig, churnThreshold: 3 };
  assert.equal(window.shouldJudge(churnConfig), true, "churn threshold met triggers judgment");
  // Output stabilises — churn stops, success repeat takes over.
  window.push(makeAttempt("bash", poll, text("3 of 4 checks passed"), false));
  assert.equal(window.churnCount(), 4, "fourth call to the same target still counts");
  assert.equal(window.successRepeats(), 2, "last two are identical: success repeat");
  // Different target resets churn.
  window.push(makeAttempt("bash", { command: "ls" }, text("ok"), false));
  assert.equal(window.churnCount(), 1, "different target: only the latest call counts");
});

test("evaluateStuck returns a churn verdict when the same target is called enough times", async () => {
  const window = new AttemptWindow(12);
  const poll = { command: "gh pr checks 2673" };
  for (let i = 0; i < 5; i++) window.push(makeAttempt("bash", poll, text(`${i + 1} of 4 checks passed`), false));
  const churnConfig = { ...stuckConfig, churnThreshold: 5 };
  const verdict = await evaluateStuck(window, "watch the PR", { config: churnConfig, timeoutMs: 1000 });
  assert.equal(verdict.stuck, true, "churn should produce a stuck verdict");
  assert.equal(verdict.source, "repeat", "churn is decided in code, not by Jev");
  assert.equal(verdict.churn, true, "the churn flag is set");
  assert.match(verdict.reasons[0] ?? "", /5 times with changing output/, "the reason names the call count");
  assert.match(stuckNudge(verdict), /keeps changing but the target stays the same/, "the nudge tells the agent to act or switch");
  assert.match(formatStuck(verdict), /churn \u00b7 stuck$/, "the widget renders the churn flag");
});

test("quickRepeat fires on the 2nd identical failure with nothing changed between, once per key", async () => {
  const config = defaultConfig().stuck;
  const window = new AttemptWindow(config.window);
  const missing = "ENOENT: no such file or directory, access '/tmp/shot.png'";
  window.push(makeAttempt("read", { path: "/tmp/shot.png" }, text(missing), true));
  assert.equal(window.quickRepeat(), undefined, "a first call is not a repeat");
  window.push(makeAttempt("bash", { command: "ls /tmp" }, text("a.txt"), false));
  window.push(makeAttempt("read", { path: "/tmp/shot.png" }, text(missing), true));
  const repeat = window.quickRepeat();
  assert.ok(repeat);
  assert.equal(repeat.callsAgo, 2);
  assert.equal(quickRepeatNudge(repeat), "pi-warden: you already ran `read /tmp/shot.png`; it failed the same way: ENOENT: no such file or directory, access '/tmp/shot.png'. Change something before running it again.");
  window.push(makeAttempt("read", { path: "/tmp/shot.png" }, text(missing), true));
  assert.equal(window.quickRepeat(), undefined, "fires once per key");
  assert.equal(window.shouldJudge(config), true, "the 3rd identical failure still reaches the stuck check");
  const verdict = await evaluateStuck(window, "look at the screenshot", { config, timeoutMs: 1000 });
  assert.equal(verdict.stuck, true);
  assert.deepEqual(verdict.reasons, ["the same call failed 3 times with the same output"]);
  window.reset();
  window.push(makeAttempt("read", { path: "/tmp/shot.png" }, text(missing), true));
  window.push(makeAttempt("read", { path: "/tmp/shot.png" }, text(missing), true));
  assert.ok(window.quickRepeat(), "a reset window may fire again");
});

test("quickRepeat stays quiet after a change, on a changed error, and for polling", () => {
  const window = new AttemptWindow(12);
  window.push(makeAttempt("bash", { command: "npm test" }, text("1 failing"), true));
  window.push(makeAttempt("edit", { path: "src/a.ts", oldText: "a", newText: "b" }, text("ok"), false));
  window.push(makeAttempt("bash", { command: "npm test" }, text("1 failing"), true));
  assert.equal(window.quickRepeat(), undefined, "an edit between the calls resets the check");
  window.push(makeAttempt("bash", { command: "npx prettier --write src" }, text("done"), false));
  window.push(makeAttempt("bash", { command: "npm test" }, text("1 failing"), true));
  assert.equal(window.quickRepeat(), undefined, "a command that is not read-only may have changed state");
  window.push(makeAttempt("edit", { path: "src/a.ts", oldText: "x", newText: "y" }, text("oldText not found"), true));
  window.push(makeAttempt("bash", { command: "npm test" }, text("1 failing"), true));
  assert.equal(window.quickRepeat(), undefined, "a failed edit is not provably read-only either");
  window.push(makeAttempt("bash", { command: "npm test" }, text("2 failing"), true));
  assert.equal(window.quickRepeat(), undefined, "a changed error is progress");
  window.push(makeAttempt("grep", { pattern: "parse", path: "src" }, text("src/a.ts:1: parse"), false));
  window.push(makeAttempt("ls", { path: "src" }, text("a.ts"), false));
  window.push(makeAttempt("bash", { command: "npm test" }, text("2 failing"), true));
  assert.ok(window.quickRepeat(), "built-in read tools change nothing, so the same failure repeats");

  window.reset();
  window.push(makeAttempt("read", { path: "src/a.ts" }, text("const a = 1;"), false));
  window.push(makeAttempt("mcp", { tool: "chrome_devtools_navigate", args: { url: "http://localhost:3000" } }, text("ok"), false));
  window.push(makeAttempt("read", { path: "src/a.ts" }, text("const a = 1;"), false));
  assert.equal(window.quickRepeat(), undefined, "an MCP call may have changed state");
  window.push(makeAttempt("ctx_execute", { language: "javascript", code: "console.log(1)" }, text("1"), false));
  window.push(makeAttempt("read", { path: "src/a.ts" }, text("const a = 1;"), false));
  assert.equal(window.quickRepeat(), undefined, "a script call may have changed state");

  window.reset();
  window.push(makeAttempt("bash", { command: "sleep 5" }, text(""), false));
  window.push(makeAttempt("bash", { command: "sleep 5" }, text(""), false));
  assert.equal(window.quickRepeat(), undefined, "sleep is waiting, not a repeat");
  window.push(makeAttempt("bash", { command: "git status --short" }, text(" M a.ts"), false));
  window.push(makeAttempt("bash", { command: "git status --short" }, text(" M a.ts"), false));
  assert.equal(window.quickRepeat(), undefined, "status checks are polling");
  window.push(makeAttempt("bash", { command: "gh run watch 42" }, text("failed"), true));
  window.push(makeAttempt("bash", { command: "gh run watch 42" }, text("failed"), true));
  assert.equal(window.quickRepeat(), undefined, "watching a run is polling, even when it reports a failure");
  window.push(makeAttempt("bash", { command: "npm run build" }, text("built"), false));
  window.push(makeAttempt("bash", { command: "npm run build" }, text("built"), false));
  assert.equal(window.quickRepeat(), undefined, "a successful call that is not a read is not flagged");
});

test("quickRepeat flags the same read twice with the same output", () => {
  const window = new AttemptWindow(12);
  const input = { path: "src/config.ts", offset: 40, limit: 20 };
  window.push(makeAttempt("read", input, text("export interface StuckGuardConfig {"), false));
  window.push(makeAttempt("bash", { command: "grep -n repeat src/stuck.ts" }, text("12: repeat"), false));
  window.push(makeAttempt("read", { path: "src/config.ts", offset: 60, limit: 20 }, text("other lines"), false));
  window.push(makeAttempt("read", input, text("export interface StuckGuardConfig {"), false));
  const repeat = window.quickRepeat();
  assert.ok(repeat);
  assert.equal(quickRepeatNudge(repeat), "pi-warden: you already have this output from `read src/config.ts` (3 calls ago); nothing changed since. Use that output instead of running the call again.");

  window.push(makeAttempt("bash", { command: "cat package.json" }, text("{}"), false));
  window.push(makeAttempt("bash", { command: "cat package.json" }, text("{}"), false));
  assert.ok(window.quickRepeat(), "a read-only shell command counts as a read");
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

test("only checks that ran after the latest change verify it", () => {
  const evidence = emptyEvidence();
  recordOutcome(evidence, "mutation", { path: "a.ts" });
  assert.equal(needsDoneCheck(evidence), true);
  recordOutcome(evidence, "check-pass", { command: "npm test" });
  assert.equal(needsDoneCheck(evidence), false);
  recordOutcome(evidence, "mutation", { path: "b.ts" });
  assert.equal(needsDoneCheck(evidence), true, "the pass predates the second change");
  assert.deepEqual(evidence.checks.map(check => check.passed), [true], "history is kept");
  assert.deepEqual(freshChecks(evidence), [], "no check has run on the new change");

  recordOutcome(evidence, "check-fail", { command: "npm test" });
  assert.equal(needsDoneCheck(evidence), true);
  assert.deepEqual(freshChecks(evidence).map(check => check.passed), [false]);
  recordOutcome(evidence, "check-pass", { command: "npm test -- --fix" });
  assert.equal(needsDoneCheck(evidence), false, "a pass after the latest change verifies it");

  const many = emptyEvidence();
  recordOutcome(many, "mutation", {});
  recordOutcome(many, "mutation", {});
  recordOutcome(many, "check-pass", { command: "npm test" });
  assert.equal(needsDoneCheck(many), false, "several changes before one passing check are covered");

  const later = emptyEvidence();
  recordOutcome(later, "check-pass", { command: "npm test" });
  assert.equal(needsDoneCheck(later), false, "checks with no change are not verification work");
  assert.equal(freshChecks(later).length, 1, "without a change every check is current");
});

test("evaluateDone judges the message against checks that cover the latest change", async () => {
  const config = defaultConfig().done;
  const evidence = emptyEvidence();
  recordOutcome(evidence, "mutation", {});
  recordOutcome(evidence, "check-pass", { command: "npm test" });
  recordOutcome(evidence, "mutation", {});
  const verdict = await evaluateDone("fix the parser bug", "Fixed the parser bug.", evidence, { config, judge: doneJudge(0.9, 0.1, "complete"), timeoutMs: 1000 });
  assert.equal(verdict.unverified, true, "the passing run predates the second change");
  assert.match(verdict.reasons[0] ?? "", /after 2 file changes with no test, build, or lint run since the last change/);
  assert.match(doneNudge(verdict), /Run the project's tests, build, or lint/);
  assert.match(formatDone(verdict), /2 changes · 0\/0 checks passed .* unverified$/);
  assert.deepEqual(buildDoneRequest("fix it", "Done.", evidence).state.run, { file_changes: 2, checks_run: [] }, "Jev is shown only the checks that cover the current code");

  recordOutcome(evidence, "check-fail", { command: "npm test" });
  const afterFailure = await evaluateDone("fix it", "Done and all tests pass.", evidence, { config, judge: doneJudge(0.9, 0.9, "complete"), timeoutMs: 1000 });
  assert.equal(afterFailure.unverified, true);
  assert.equal(afterFailure.falseClaim, false, "a fresh failing check is not 'none ran'");
  assert.match(afterFailure.reasons[0] ?? "", /1 failed check and no passing one/);
  assert.match(doneNudge(afterFailure), /The last check that ran failed: npm test/);

  const honest = emptyEvidence();
  recordOutcome(honest, "mutation", {});
  recordOutcome(honest, "check-pass", { command: "npm test" });
  recordOutcome(honest, "mutation", {});
  const staleClaim = await evaluateDone("fix it", "Tests passed before my last edit; I did not rerun them.", honest, { config, judge: doneJudge(0.95, 0.9, "complete"), timeoutMs: 1000 });
  assert.equal(staleClaim.unverified, true, "the pass covers an older version of the code");
  assert.equal(staleClaim.falseClaim, false, "a check ran in this run: stale evidence is unverified, not a false claim");
  assert.equal(staleClaim.reasons.length, 1, "the false-claim reason needs no check anywhere in the run");
  assert.match(staleClaim.reasons[0] ?? "", /no test, build, or lint run since the last change/);
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

test("stuckDiff shows a unified diff for outputs differing in one line", () => {
  const previous = "line1\nline2-old\nline3";
  const current = "line1\nline2-new\nline3";
  const result = stuckDiff(previous, current, { diffLimit: 3000, tailLimit: 1000, fullPath: "/tmp/output.txt" });
  assert.match(result, /stuck-loop diff/);
  assert.match(result, /- line2-old/);
  assert.match(result, /\+ line2-new/);
  assert.match(result, /Full output: \/tmp\/output\.txt/);
});

test("stuckDiff says outputs are identical when byte-identical", () => {
  const same = "same output\nline2";
  const result = stuckDiff(same, same, { diffLimit: 3000, tailLimit: 1000, fullPath: "/tmp/out.txt" });
  assert.match(result, /byte-identical/);
  assert.match(result, /see the full output at \/tmp\/out\.txt/);
  assert.ok(!result.includes("Full output:"), "one-line form does not use the multi-line footer");
});

test("stuckDiff truncates a diff exceeding the cap", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `prev-${i}`);
  const linesNew = Array.from({ length: 200 }, (_, i) => `curr-${i}`);
  const previous = lines.join("\n");
  const current = linesNew.join("\n");
  const result = stuckDiff(previous, current, { diffLimit: 500, tailLimit: 200, fullPath: "/tmp/out.txt" });
  assert.match(result, /\u2026 \[diff truncated\]/);
  assert.match(result, /Full output: \/tmp\/out\.txt/);
  assert.ok(result.length < 2000, `note should be compact; got ${result.length}`);
});

test("lineDiff emits one hunk with context for a single-line difference in 60-line outputs", () => {
  const prev = Array.from({ length: 60 }, (_, i) => `line-${i}`).join("\n");
  const curr = Array.from({ length: 60 }, (_, i) => i === 30 ? "CHANGED" : `line-${i}`).join("\n");
  const result = stuckDiff(prev, curr, { diffLimit: 3000, tailLimit: 1000, fullPath: "/tmp/out.txt" });
  // One hunk header.
  assert.equal((result.match(/^@@ /gm) ?? []).length, 1, "exactly one hunk header");
  // The changed line is present.
  assert.match(result, /- line-30/);
  assert.match(result, /\+ CHANGED/);
  // At most 8 body lines in the hunk: 3 context before + 1 delete + 1 add + 3 context after.
  const hunkBody = result.split("\n").filter(line => line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"));
  assert.ok(hunkBody.length <= 8, `hunk body has ${hunkBody.length} lines, expected at most 8`);
});

test("lineDiff emits two hunks for differences at line 5 and line 50", () => {
  const prev = Array.from({ length: 60 }, (_, i) => `line-${i}`).join("\n");
  const curr = Array.from({ length: 60 }, (_, i) => i === 5 ? "FIRST-CHANGE" : i === 50 ? "SECOND-CHANGE" : `line-${i}`).join("\n");
  const result = stuckDiff(prev, curr, { diffLimit: 3000, tailLimit: 1000, fullPath: "/tmp/out.txt" });
  assert.equal((result.match(/^@@ /gm) ?? []).length, 2, "exactly two hunk headers");
  assert.match(result, /- line-5/);
  assert.match(result, /\+ FIRST-CHANGE/);
  assert.match(result, /- line-50/);
  assert.match(result, /\+ SECOND-CHANGE/);
});

test("isUiFile reads brace alternatives and `!` exclusions; tests of UI code are not UI", () => {
  const globs = defaultConfig().done.uiFiles;
  for (const path of ["web/app.css", "/repo/src/App.tsx", "src/pages/index.astro", "lib/widgets/chip.dart", "site/web/app.js", "public/js/menu.js"]) assert.equal(isUiFile(path, globs), true, path);
  for (const path of ["src/parser.ts", "src/server.js", "README.md", "src/App.test.tsx", "src/row.dom.test.tsx", "test/widgets/chip_test.dart", "tests/web/app.js"]) assert.equal(isUiFile(path, globs), false, path);
});

test("isVisualCheck counts browser, device, screenshot, and image reads, not mentions of them", () => {
  const visual = defaultConfig().done.visualTools;
  const shows = (tool: string, input: Record<string, unknown>, failed = false) => isVisualCheck(tool, input, failed, visual);
  assert.equal(shows("bash", { command: "agent-browser open http://localhost:3000" }), true);
  assert.equal(shows("bash", { command: "cd web && PORT=3000 npx playwright test" }), true);
  assert.equal(shows("bash", { command: "cd app && fvm flutter test integration_test/app_test.dart" }), true);
  assert.equal(shows("bash", { command: "flutter test test/goldens/header_golden_test.dart" }), true);
  assert.equal(shows("bash", { command: "flutter test --update-goldens" }), true);
  assert.equal(shows("bash", { command: "xcrun simctl io booted screenshot /tmp/s.png" }), true);
  assert.equal(shows("bash", { command: "idb screenshot /tmp/s.png" }), true);
  assert.equal(shows("bash", { command: "idb ui tap 10 20" }), true);
  assert.equal(shows("bash", { command: "npx playwright test --screenshot=on" }), true);
  assert.equal(shows("bash", { command: "chrome --headless --screenshot=/tmp/s.png http://localhost" }), true, "a headless-browser screenshot is visual proof");
  assert.equal(shows("bash", { command: "chromium --headless --screenshot http://localhost" }), true);
  assert.equal(shows("bash", { command: "google-chrome --headless=new --screenshot=/tmp/s.png http://localhost" }), true);
  assert.equal(shows("ctx_execute", { language: "shell", code: "agent-browser snapshot -i" }), true);
  assert.equal(shows("read", { path: "/tmp/shot.PNG" }), true);
  assert.equal(shows("mcp__chrome_devtools", { tool: "take_screenshot" }), true);
  assert.equal(shows("mcp", { tool: "navigate_page", args: {} }), true);
  assert.equal(shows("take_snapshot", {}), true);
  assert.equal(shows("bash", { command: "agent-browser open http://localhost:3000" }, true), false, "a failed call showed nothing");
  assert.equal(shows("bash", { command: "gh pr create --title x --body \"see the screenshot\"" }), false, "a PR body is data");
  assert.equal(shows("bash", { command: "git add web/screenshots/header.png" }), false, "a screenshots path is not a screenshot");
  assert.equal(shows("bash", { command: "which chromium; ls ~/.cache/ms-playwright" }), false);
  assert.equal(shows("bash", { command: "npm test" }), false);
  assert.equal(shows("bash", { command: "grep -rn screenshot src" }), false, "a command word counts only after a visual head");
  assert.equal(shows("bash", { command: "chromium --version" }), false, "a browser binary without a screenshot flag shows nothing");
  assert.equal(shows("bash", { command: "google-chrome --headless http://localhost" }), false);
  assert.equal(shows("bash", { command: "idb list-targets" }), false, "idb shows the UI only through screenshot or ui");
  assert.equal(shows("bash", { command: "flutter test test/unit/x_test.dart" }), false, "a unit test shows no UI");
  assert.equal(shows("bash", { command: "cd app && fvm flutter test test/widget_test.dart" }), false, "a widget test is not a golden test");
  assert.equal(shows("read", { path: "web/app.css" }), false);
  assert.equal(shows("mcp__linear", { tool: "list_issues" }), false);
});

test("recordUi keeps the last UI change until a visual check follows it", () => {
  const globs = defaultConfig().done.uiFiles;
  const evidence = emptyEvidence();
  recordUi(evidence, [], true, globs);
  assert.equal(evidence.unseenUi, undefined);
  recordUi(evidence, ["web/app.css"], false, globs);
  recordUi(evidence, ["src/parser.ts"], false, globs);
  assert.equal(evidence.unseenUi, "web/app.css", "a non-UI change does not clear it");
  assert.equal(needsDoneCheck(evidence), true, "no mutation counted, yet the UI change needs proof");
  recordUi(evidence, [], true, globs);
  assert.equal(evidence.unseenUi, undefined);
  assert.equal(needsDoneCheck(evidence), false);
});

test("evaluateDone: a UI change with no visual check is unverified even when tests pass", async () => {
  const config = defaultConfig().done;
  const evidence = emptyEvidence();
  recordOutcome(evidence, "mutation", {});
  recordUi(evidence, ["web/app.css"], false, config.uiFiles);
  recordOutcome(evidence, "check-pass", { command: "npm test" });
  assert.equal(needsDoneCheck(evidence), true);
  const verdict = await evaluateDone("restyle the header", "Done, tests pass.", evidence, { config, judge: doneJudge(0.9, 0.9, "complete", 0.1), timeoutMs: 1000 });
  assert.equal(verdict.unverified, true, "tests do not apply to a style change, the visual check does");
  assert.equal(verdict.falseClaim, false);
  assert.equal(verdict.unseenUi, "web/app.css");
  assert.equal(doneNudge(verdict), "pi-warden: reports completion (0.90) after a UI change with no browser, screenshot, or device check since. You changed `web/app.css` but did not look at the result. Open it in a browser or take a screenshot before calling it done, or say it is unverified.");

  const blocked = await evaluateDone("restyle the header", "Should the header be blue?", evidence, { config, judge: doneJudge(0.9, 0.1, "blocked"), timeoutMs: 1000 });
  assert.equal(blocked.unverified, false, "a question to the user is not a claim");

  const both = emptyEvidence();
  recordOutcome(both, "mutation", {});
  recordUi(both, ["web/app.css"], false, config.uiFiles);
  const neither = await evaluateDone("restyle the header", "Done.", both, { config, judge: doneJudge(0.9, 0.1, "complete"), timeoutMs: 1000 });
  assert.deepEqual(neither.reasons, ["reports completion (0.90) after 1 file change with no test, build, or lint run since the last change", "no browser, screenshot, or device check since the last UI change"]);
  assert.match(doneNudge(neither), /Run the project's tests.*say so explicitly instead of presenting the work as done\. You changed `web\/app\.css`/);
});
