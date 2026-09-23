import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeSafeIntegrationError } from "pi-typesafe";
import { cooldownFailureKind, JudgeCooldown } from "../src/judge-cooldown.js";

const settings = { failuresBeforeCooldown: 3, cooldownMs: 1000 };

function clock() {
  let now = 0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("transient failures start the cooldown only at the threshold", () => {
  const time = clock();
  const cooldown = new JudgeCooldown(time.now);
  assert.equal(cooldown.failure("timeout", settings), undefined);
  assert.equal(cooldown.failure("network", settings), undefined);
  assert.equal(cooldown.active(), false);
  assert.deepEqual(cooldown.failure("other", settings), { type: "started", kind: "other", ms: 1000 });
  assert.equal(cooldown.active(), true);
  time.advance(1000);
  assert.equal(cooldown.active(), false, "the window closes after cooldownMs");
});

test("auth and configuration failures start the cooldown at once", () => {
  for (const kind of ["auth", "configuration"] as const) {
    const cooldown = new JudgeCooldown(clock().now);
    assert.deepEqual(cooldown.failure(kind, settings), { type: "started", kind, ms: 1000 });
  }
});

test("a success resets the count, and announces recovery only after a window", () => {
  const cooldown = new JudgeCooldown(clock().now);
  cooldown.failure("timeout", settings);
  cooldown.failure("timeout", settings);
  assert.equal(cooldown.success(), undefined, "nothing to announce: the judge was never paused");
  cooldown.failure("timeout", settings);
  cooldown.failure("timeout", settings);
  assert.equal(cooldown.active(), false, "the count restarted");
});

test("failures inside the window and a failed probe after it add no second notice", () => {
  const time = clock();
  const cooldown = new JudgeCooldown(time.now);
  cooldown.failure("auth", settings);
  assert.equal(cooldown.failure("timeout", settings), undefined, "an in-flight request finishing late");
  time.advance(1000);
  assert.equal(cooldown.failure("timeout", settings), undefined, "the probe failed; the user was already told");
  assert.equal(cooldown.active(), true, "and the window is open again");
  time.advance(1000);
  assert.deepEqual(cooldown.success(), { type: "recovered" });
  assert.equal(cooldown.success(), undefined, "recovery is announced once");
});

test("a deadline counts as a timeout, a user's cancel and the budget do not count", () => {
  const aborted = new TypeSafeIntegrationError("aborted", "cancelled");
  const deadline = new AbortController();
  deadline.abort(new DOMException("deadline", "TimeoutError"));
  const cancel = new AbortController();
  cancel.abort();
  assert.equal(cooldownFailureKind(aborted, deadline.signal), "timeout");
  assert.equal(cooldownFailureKind(aborted, cancel.signal), undefined);
  assert.equal(cooldownFailureKind(aborted), undefined);
  assert.equal(cooldownFailureKind(new TypeSafeIntegrationError("budget", "limit")), undefined);
});

test("a 401 or 403 is an auth failure; other HTTP errors are network", () => {
  assert.equal(cooldownFailureKind(new TypeSafeIntegrationError("http", "denied", 401)), "auth");
  assert.equal(cooldownFailureKind(new TypeSafeIntegrationError("http", "denied", 403)), "auth");
  assert.equal(cooldownFailureKind(new TypeSafeIntegrationError("http", "unavailable", 503)), "network");
  assert.equal(cooldownFailureKind(new TypeSafeIntegrationError("timeout", "slow")), "timeout");
  assert.equal(cooldownFailureKind(new TypeSafeIntegrationError("validation", "bad request")), "configuration");
});
