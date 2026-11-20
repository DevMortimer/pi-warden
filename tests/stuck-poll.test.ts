import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import type { Judge } from "../src/guard.js";
import { AttemptWindow, evaluateStuck, makeAttempt, stuckNudge } from "../src/stuck.js";

const text = (value: string) => [{ type: "text", text: value }];

const spyJudge = (): Judge & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    async evaluate(request) {
      calls.push(request);
      return {
        model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 },
        answers: {
          same_strategy: { type: "noul", noul: 0.95 },
          approach_change: { type: "score", score: 0, confidence: 0.9, probabilities: { "0": 0.9, "1": 0.05, "2": 0.05 } },
          progress: { type: "noul", noul: 0.05 },
        },
      } as never;
    },
  };
};

const stuckConfig = defaultConfig().stuck;

test("bounded job wait commands mark poll and do not trigger repeat-stuck notices across repeated slices", async () => {
  const commands = [
    "runner job wait run-42 --timeout 8",
    "./runner job wait run-42 --timeout 10",
    "/usr/local/bin/runner job wait run-42 --timeout 10",
    "MODE=ci runner job wait run-42 --timeout 8",
    "cd /tmp/work && runner job wait run-42 --timeout 8",
    "runner job show run-42",
    "runner job status run-42",
    "gh run watch 42",
    "gh pr checks 42 --watch",
    "kubectl wait --for=condition=ready pod/web",
  ];

  for (const command of commands) {
    const window = new AttemptWindow(stuckConfig.window);
    const judge = spyJudge();
    for (let i = 0; i < 5; i++) {
      const attempt = makeAttempt("bash", { command }, text("running"), false);
      assert.equal(attempt.poll, true, `${command} should set poll: true`);
      window.push(attempt);
      assert.equal(window.quickRepeat(), undefined, `${command} slice ${i + 1} should not quick-repeat`);
    }
    assert.equal(window.successRepeats(), 0, `${command} should not count toward successRepeats`);
    assert.equal(window.churnCount(), 0, `${command} should not count toward churnCount`);
    assert.equal(window.shouldJudge(stuckConfig), false, `${command} should not trigger judgment`);
    const verdict = await evaluateStuck(window, "wait for build", { config: stuckConfig, judge, timeoutMs: 1000 });
    assert.equal(verdict.stuck, false, `${command} should not be flagged stuck`);
    assert.deepEqual(verdict.reasons, []);
    assert.equal(judge.calls.length, 0, `${command} should not call judge`);
  }
});

test("bounded job wait slices with timeout exit codes, unreported status, or changing output never trigger stuck", async () => {
  const command = "runner job wait run-42 --timeout 8";

  // Non-zero exit (e.g. exit 124 on slice timeout) reported as failed: true.
  const timedOut = new AttemptWindow(stuckConfig.window);
  const judgeFail = spyJudge();
  for (let i = 0; i < 5; i++) {
    timedOut.push(makeAttempt("bash", { command }, text("still running"), true));
    assert.equal(timedOut.quickRepeat(), undefined);
  }
  assert.equal(timedOut.failures(), 0, "timed-out bounded waits do not count as failures");
  assert.equal(timedOut.exactRepeats(), 0, "timed-out bounded waits do not count as exactRepeats");
  assert.equal(timedOut.churnCount(), 0);
  assert.equal(timedOut.shouldJudge(stuckConfig), false);
  const failVerdict = await evaluateStuck(timedOut, "wait for build", { config: stuckConfig, judge: judgeFail, timeoutMs: 1000 });
  assert.equal(failVerdict.stuck, false);
  assert.equal(judgeFail.calls.length, 0);

  // Unreported exit status (failed: undefined) with changing progress output.
  const unreported = new AttemptWindow(stuckConfig.window);
  const judgeUnreported = spyJudge();
  for (let i = 0; i < 6; i++) {
    unreported.push(makeAttempt("bash", { command }, text(`still running: step ${i + 1} of 6`), undefined));
    assert.equal(unreported.quickRepeat(), undefined);
  }
  assert.equal(unreported.successRepeats(), 0);
  assert.equal(unreported.churnCount(), 0);
  assert.equal(unreported.shouldJudge(stuckConfig), false);
  const unreportedVerdict = await evaluateStuck(unreported, "wait for build", { config: stuckConfig, judge: judgeUnreported, timeoutMs: 1000 });
  assert.equal(unreportedVerdict.stuck, false);
  assert.equal(judgeUnreported.calls.length, 0);

  // Prior real failures followed by a bounded wait slice should not judge on the wait slice.
  const mixed = new AttemptWindow(stuckConfig.window);
  const judgeMixed = spyJudge();
  mixed.push(makeAttempt("bash", { command: "npm test" }, text("error 1"), true));
  mixed.push(makeAttempt("bash", { command: "npm test -- --verbose" }, text("error 2"), true));
  mixed.push(makeAttempt("bash", { command: "npx tsc" }, text("error 3"), true));
  mixed.push(makeAttempt("bash", { command }, text("still running"), true));
  assert.equal(mixed.failures(), 3, "bounded wait is excluded from failure count");
  assert.equal(mixed.shouldJudge(stuckConfig), false, "bounded wait as latest call does not trigger judgment");
  const mixedVerdict = await evaluateStuck(mixed, "fix tests", { config: stuckConfig, judge: judgeMixed, timeoutMs: 1000 });
  assert.equal(mixedVerdict.stuck, false);
  assert.equal(judgeMixed.calls.length, 0);
});

test("negative controls: repeated non-poll commands, writes, and non-watch checks still fire 3x repeat-stuck", async () => {
  // Plain non-poll shell command repeated 3x with identical output.
  const plain = new AttemptWindow(stuckConfig.window);
  for (let i = 0; i < 3; i++) {
    const attempt = makeAttempt("bash", { command: "echo hi" }, text("hi"), false);
    assert.equal(attempt.poll, false);
    plain.push(attempt);
  }
  assert.equal(plain.successRepeats(), 3);
  assert.equal(plain.shouldJudge(stuckConfig), true);
  const plainVerdict = await evaluateStuck(plain, "check output", { config: stuckConfig, timeoutMs: 1000 });
  assert.equal(plainVerdict.stuck, true);
  assert.equal(plainVerdict.successRepeat, true);
  assert.match(stuckNudge(plainVerdict), /^pi-warden: the same call succeeded 3 times with the same output\./);

  // A write tool whose path happens to contain "job wait" is still not a bounded wait.
  const writes = new AttemptWindow(stuckConfig.window);
  for (let i = 0; i < 3; i++) {
    const attempt = makeAttempt("write", { path: "docs/job wait.md", content: "same" }, text("ok"), false);
    assert.equal(attempt.poll, false);
    writes.push(attempt);
  }
  assert.equal(writes.successRepeats(), 3);
  assert.equal(writes.shouldJudge(stuckConfig), true);
  const writeVerdict = await evaluateStuck(writes, "write docs", { config: stuckConfig, timeoutMs: 1000 });
  assert.equal(writeVerdict.stuck, true);
  assert.equal(writeVerdict.successRepeat, true);

  // gh pr checks without --watch still triggers successRepeat after 3 identical outputs.
  const checks = new AttemptWindow(stuckConfig.window);
  for (let i = 0; i < 3; i++) {
    checks.push(makeAttempt("bash", { command: "gh pr checks 42" }, text("all checks passed"), false));
  }
  assert.equal(checks.successRepeats(), 3);
  const checksVerdict = await evaluateStuck(checks, "watch PR", { config: stuckConfig, timeoutMs: 1000 });
  assert.equal(checksVerdict.stuck, true);
  assert.equal(checksVerdict.successRepeat, true);
});
