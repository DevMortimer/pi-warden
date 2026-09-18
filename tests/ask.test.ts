/** The judgment seam warden depends on: pi-typesafe's `ask` (src/jev.ts was a duplicate). These tests pin the
 * contract the guards are written against: one signal for the per-guard timeout and the caller's abort, and a
 * failure that carries no upstream text. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ask, noul, TypeSafeIntegrationError } from "pi-typesafe";
import type { Judge } from "pi-typesafe";

const request = { state: { text: "hello" }, questions: { fine: noul("Is `text` fine?") } };
const answer = { model: "jev-test", answers: { fine: { type: "noul" as const, noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 0 }, elapsedMs: 7 };

test("a successful evaluation comes back with answers, model, and elapsed time; the timeout is merged with the caller's signal", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const judge: Judge = { async evaluate(_request, options) { seen.push(options?.signal); return answer as never; } };
  const controller = new AbortController();
  const result = await ask(judge, request, { timeoutMs: 1000, signal: controller.signal });
  assert.ok(result.ok);
  assert.equal(result.answers.fine.noul, 0.9);
  assert.equal(result.model, "jev-test");
  assert.equal(result.elapsedMs, 7);
  assert.ok(seen[0] instanceof AbortSignal && !seen[0].aborted, "one signal covers both the timeout and the caller's abort");
  controller.abort();
  assert.ok(seen[0].aborted, "the caller's abort reaches the request");

  const plain = await ask(judge, request, { timeoutMs: 1000 });
  assert.ok(plain.ok);
  assert.ok(seen[1] instanceof AbortSignal, "a timeout signal is passed even without a caller signal");
});

test("integration errors keep their message and code; anything else gets a fixed message and no upstream text", async () => {
  const budget = await ask({ async evaluate() { throw new TypeSafeIntegrationError("budget", "TypeSafe request limit reached (1 attempts)."); } }, request, { timeoutMs: 1000 });
  assert.deepEqual(budget, { ok: false, error: "TypeSafe request limit reached (1 attempts).", errorCode: "budget" });

  const timeout = await ask({ async evaluate() { throw new TypeSafeIntegrationError("timeout", "TypeSafe did not answer in time."); } }, request, { timeoutMs: 1000 });
  assert.ok(!timeout.ok);
  assert.equal(timeout.errorCode, "timeout");

  const unknown = await ask({ async evaluate() { throw new Error("upstream body must not leak"); } }, request, { timeoutMs: 1000 });
  assert.deepEqual(unknown, { ok: false, error: "TypeSafe request failed." });

  const thrown = await ask({ async evaluate() { throw "upstream body must not leak"; } }, request, { timeoutMs: 1000 });
  assert.deepEqual(thrown, { ok: false, error: "TypeSafe request failed." });
});
