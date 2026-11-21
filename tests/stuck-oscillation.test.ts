import assert from "node:assert/strict";
import { test } from "node:test";
import type { Judge } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import type { StuckGuardConfig } from "../src/config.js";
import { AttemptWindow, evaluateStuck, makeAttempt, stuckNudge } from "../src/stuck.js";
import { stuckTokens } from "../src/widget.js";

const stuckConfig = (overrides: Partial<StuckGuardConfig> = {}): StuckGuardConfig => ({ ...defaultConfig().stuck, ...overrides });

const neverCalledJudge: Judge = {
  async evaluate() {
    throw new Error("Jev judge must not be called for deterministic trajectory oscillations");
  },
};

test("AttemptWindow detects exact A -> B -> A edit revert with 0 Jev calls and fires once per (path, stateHash)", async () => {
  const config = stuckConfig();
  const window = new AttemptWindow(config.window);

  window.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), false);

  window.push(makeAttempt("read", { path: "src/bar.ts" }, [{ type: "text", text: "export const y = 1;" }], false));
  window.push(makeAttempt("bash", { command: "echo checking" }, [{ type: "text", text: "checking" }], false));

  // Revert back to x = 1 (A -> B -> A).
  window.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: "const x = 2;", newText: "const x = 1;" }] }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), true);

  const verdict = await evaluateStuck(window, "fix x", { config, judge: neverCalledJudge, timeoutMs: 1000 });
  assert.equal(verdict.stuck, true);
  assert.equal(verdict.source, "repeat");
  assert.equal(verdict.oscillation, "revert");
  assert.match(verdict.reasons[0]!, /reverted the file to an earlier state.*A → B → A/i);
  assert.match(stuckNudge(verdict), /toggling/i);
  assert.match(stuckTokens(verdict).flags ?? "", /revert/i);

  // Changing to a third state C then reverting to A again does not spam the same (path, A) state.
  window.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 3;" }] }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), false);
  window.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: "const x = 3;", newText: "const x = 1;" }] }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), false);
});

test("AttemptWindow detects A -> B -> A write revert via content hash and ignores A -> A without intermediate state", async () => {
  const config = stuckConfig();
  const window = new AttemptWindow(config.window);

  window.push(makeAttempt("write", { path: "src/a.ts", content: "state A" }, [{ type: "text", text: "ok" }], false));
  // Repeating A immediately without distinct B is not an A -> B -> A revert.
  window.push(makeAttempt("write", { path: "src/a.ts", content: "state A" }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), false);

  window.push(makeAttempt("write", { path: "src/a.ts", content: "state B" }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), false);

  window.push(makeAttempt("write", { path: "src/a.ts", content: "state A" }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), true);
  const verdict = await evaluateStuck(window, "write a", { config, judge: neverCalledJudge, timeoutMs: 1000 });
  assert.equal(verdict.stuck, true);
  assert.equal(verdict.oscillation, "revert");

  // Respects editRevert: false toggle.
  const disabled = stuckConfig({ editRevert: false });
  const w2 = new AttemptWindow(disabled.window);
  w2.push(makeAttempt("write", { path: "src/a.ts", content: "state A" }, [], false));
  w2.push(makeAttempt("write", { path: "src/a.ts", content: "state B" }, [], false));
  w2.push(makeAttempt("write", { path: "src/a.ts", content: "state A" }, [], false));
  assert.equal(w2.shouldJudge(disabled), false);
});

test("AttemptWindow detects 6 unverified edits to a single file as thrash, and resets streak on passing check", async () => {
  const config = stuckConfig({ fileThrashThreshold: 6 });
  const window = new AttemptWindow(config.window);

  for (let i = 1; i <= 5; i++) {
    window.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: `v${i - 1}`, newText: `v${i}` }] }, [{ type: "text", text: "ok" }], false));
    assert.equal(window.shouldJudge(config), false, `edit ${i} should not trigger thrash`);
  }

  // 6th unverified edit triggers thrash.
  window.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: "v5", newText: "v6" }] }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), true);
  const verdict = await evaluateStuck(window, "edit foo", { config, judge: neverCalledJudge, timeoutMs: 1000 });
  assert.equal(verdict.stuck, true);
  assert.equal(verdict.source, "repeat");
  assert.equal(verdict.oscillation, "thrash");
  assert.match(verdict.reasons[0]!, /6 edits to src\/foo\.ts without a passing check/);
  assert.match(stuckNudge(verdict), /verify|test|build|read/i);
  assert.match(stuckTokens(verdict).flags ?? "", /thrash/i);

  // 7th edit does not re-fire until another 6 unverified edits accumulate.
  window.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: "v6", newText: "v7" }] }, [{ type: "text", text: "ok" }], false));
  assert.equal(window.shouldJudge(config), false);

  // Passing check resets streak: 3 edits + passing npm test + 3 edits does not fire.
  const w2 = new AttemptWindow(config.window);
  for (let i = 1; i <= 3; i++) {
    w2.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: `a${i - 1}`, newText: `a${i}` }] }, [{ type: "text", text: "ok" }], false));
  }
  w2.push(makeAttempt("bash", { command: "npm test" }, [{ type: "text", text: "tests 3\npass 3\nfail 0" }], false));
  for (let i = 4; i <= 6; i++) {
    w2.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: `a${i - 1}`, newText: `a${i}` }] }, [{ type: "text", text: "ok" }], false));
    assert.equal(w2.shouldJudge(config), false, `edit ${i} after passing check should not trigger thrash`);
  }

  // Threshold 0 disables single-file thrash detection.
  const disabled = stuckConfig({ fileThrashThreshold: 0 });
  const w3 = new AttemptWindow(disabled.window);
  for (let i = 1; i <= 8; i++) {
    w3.push(makeAttempt("edit", { path: "src/foo.ts", edits: [{ oldText: `b${i - 1}`, newText: `b${i}` }] }, [{ type: "text", text: "ok" }], false));
    assert.equal(w3.shouldJudge(disabled), false);
  }
});

test("AttemptWindow detects long-horizon (>12 calls) failure-signature cycle while keeping bounded waits exempt", async () => {
  const config = stuckConfig({ window: 12, minFailures: 3, longCycleThreshold: 4 });
  const window = new AttemptWindow(config.window);

  const pushNoise = (round: number) => {
    for (let i = 0; i < 15; i++) {
      window.push(makeAttempt("read", { path: `src/file-${round}-${i}.ts` }, [{ type: "text", text: `content ${round}-${i}` }], false));
    }
  };

  for (let round = 1; round <= 3; round++) {
    window.push(makeAttempt("bash", { command: "npm test" }, [{ type: "text", text: "Error: expected 2 to equal 3" }], true));
    assert.equal(window.shouldJudge(config), false, `failure ${round} separated by 15 calls should not fire yet`);
    pushNoise(round);
  }

  // 4th recurrence: earlier 3 failures were evicted from the 12-attempt sliding window, so exactRepeats() === 1.
  window.push(makeAttempt("bash", { command: "npm test" }, [{ type: "text", text: "Error: expected 2 to equal 3" }], true));
  assert.equal(window.exactRepeats(), 1, "earlier failures were evicted from the 12-attempt window");
  assert.equal(window.shouldJudge(config), true);

  const verdict = await evaluateStuck(window, "fix tests", { config, judge: neverCalledJudge, timeoutMs: 1000 });
  assert.equal(verdict.stuck, true);
  assert.equal(verdict.source, "repeat");
  assert.equal(verdict.oscillation, "cycle");
  assert.match(verdict.reasons[0]!, /same failure recurred 4 times across this run/);
  assert.match(stuckNudge(verdict), /hypothesis/i);
  assert.match(stuckTokens(verdict).flags ?? "", /cycle/i);

  // Bounded wait commands remain exempt even across 4+ failures spaced apart.
  const waitWindow = new AttemptWindow(config.window);
  for (let round = 1; round <= 5; round++) {
    waitWindow.push(makeAttempt("bash", { command: "gh run watch 123" }, [{ type: "text", text: "timed out" }], true));
    assert.equal(waitWindow.shouldJudge(config), false);
    for (let i = 0; i < 13; i++) {
      waitWindow.push(makeAttempt("read", { path: `src/w-${round}-${i}.ts` }, [{ type: "text", text: "ok" }], false));
    }
  }
});
