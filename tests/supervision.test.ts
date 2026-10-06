import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
// @ts-expect-error calibration fixtures are an executable JavaScript module
import { cases, fixtureVersion } from "../scripts/supervision-cases.mjs";
// @ts-expect-error the calibration runner is an executable JavaScript module
import { calibrate, calibrationCeilingUsd, canRequestCalibration, requestReserveUsd } from "../scripts/supervision-calibrate.mjs";
import { supervisionPolicy, supervisionQuestions } from "../src/supervision.js";
import { buildSupervisionRequest, evaluateSupervision, validateSupervisionRequest } from "../src/supervision.js";
import type { RedactedSupervisionMetrics } from "../src/supervision.js";

const metrics: RedactedSupervisionMetrics = {
  rootId: "root-1", role: "worker", lifecycle: "active", reason: null, continuationPlan: null,
  observedCostUsd: 0.2, observerCostUsd: 0, softLimitUsd: 1, hardLimitUsd: 2, descendantCount: 1,
  progress: { materialProgressCount: 1, readsSinceProgress: 2, writesSinceProgress: 0, repeatedOperationCount: 0, equivalentErrorCount: 0, lastOperationSignature: "a".repeat(64), lastProgressAgeMs: 100 },
  mcp: { state: "unknown", capabilityCount: null },
};
const envelope = (m: unknown = metrics) => ({ version: 1, metrics: m });
const ids = ["is_repeating_without_progress", "is_failure_loop", "is_reading_beyond_reasonable_discovery", "has_material_progress", "is_safe_to_resume_after_failure"];
const probabilities = [0.1, 0.2, 0.3, 0.9, 0.1];
function stub(p = probabilities) {
  const requests: unknown[] = [];
  return { requests, judge: { async evaluate(request: unknown) {
    requests.push(request);
    return { model: "jev-1.13.0", elapsedMs: 1, usage: { input_tokens: 100, output_tokens: 0 }, answers: Object.fromEntries(ids.map((id, i) => [id, { type: "noul", noul: p[i] }])) } as never;
  } } };
}
const options = (judge: ReturnType<typeof stub>["judge"]) => ({ judge, backend: "typesafe" as const, timeoutMs: 1000, now: () => 1000, price: () => 0.042 });

test("synthetic fixtures are bounded redacted v1 evidence and cover each judgment", () => {
  assert.equal(fixtureVersion, "synthetic-v1");
  assert.equal(cases.length, 12);
  assert.deepEqual(new Set(cases.map((row: { expected: string }) => row.expected)), new Set(["healthy", "loop", "no_progress", "safe_to_resume", "unavailable"]));
  for (const row of cases) {
    assert.deepEqual(validateSupervisionRequest(envelope(row.metrics)), envelope(row.metrics));
    assert.equal(row.metrics.rootId, "synthetic-guardian");
    assert.deepEqual(Object.keys(row), ["expected", "metrics"]);
  }
});

test("calibration policy pins questions and keeps a reserve for the later live smoke", () => {
  const hash = createHash("sha256").update(JSON.stringify(supervisionQuestions)).digest("hex");
  assert.equal(hash, "bbf5b1e20d38e54949d1c633bd0b2cb4490be385325531c2249a989f4a39ca66");
  assert.equal(supervisionPolicy.questionHash, hash);
  assert.equal(supervisionPolicy.enforcement, "trace_only");
  assert.equal(supervisionPolicy.model, "jev-1.13.0");
  assert.equal(supervisionPolicy.probabilityThreshold, 0.90);
  assert.equal(supervisionPolicy.confidenceThreshold, 0.80);
  assert.equal(calibrationCeilingUsd, 0.08);
  assert.equal(requestReserveUsd, 0.006);
  assert.equal(canRequestCalibration(0.073, 0.006), true);
  assert.equal(canRequestCalibration(0.075, 0.006), false);
  assert.equal(canRequestCalibration(0.08, 0), false);
  assert.equal(canRequestCalibration(NaN), false);
});

test("offline calibration batches one request per row without logging submitted metrics", async () => {
  const lines: string[] = [];
  const { judge, requests } = stub();
  const report = await calibrate({ judge, rows: cases.slice(0, 2), print: (line: string) => lines.push(line) });
  assert.equal(report.requests, 2);
  assert.equal(requests.length, 2);
  assert.equal(report.inputTokens, 200);
  assert.ok(lines.every(line => !line.includes("synthetic-guardian") && !line.includes("rootId") && !line.includes("state")));
  await assert.rejects(calibrate({ judge, rows: [...cases, cases[0]], print: () => {} }), /twelve requests/);
  assert.equal(requests.length, 2);
});

test("only exact bounded redacted v1 metrics pass validation", () => {
  assert.deepEqual(validateSupervisionRequest(envelope()), envelope());
  for (const extra of ["prompt", "path", "command", "error", "source", "credential"]) {
    assert.equal(validateSupervisionRequest(envelope({ ...metrics, [extra]: "private" })), undefined);
  }
  for (const bad of [
    { ...envelope(), secret: "private" }, envelope({ ...metrics, rootId: "/tmp/private" }),
    envelope({ ...metrics, role: "private" }), envelope({ ...metrics, lifecycle: "running" }),
    envelope({ ...metrics, reason: "unknown" }), envelope({ ...metrics, continuationPlan: "unknown" }),
    envelope({ ...metrics, observedCostUsd: Infinity }), envelope({ ...metrics, hardLimitUsd: 1_000_001 }),
    envelope({ ...metrics, descendantCount: 1_000_000_001 }),
    envelope({ ...metrics, progress: { ...metrics.progress, readsSinceProgress: -1 } }),
    envelope({ ...metrics, progress: { ...metrics.progress, lastProgressAgeMs: 120_001 } }),
    envelope({ ...metrics, progress: { ...metrics.progress, lastOperationSignature: "raw-command" } }),
    envelope({ ...metrics, progress: { ...metrics.progress, path: "/tmp/private" } }),
    envelope({ ...metrics, mcp: { ...metrics.mcp, state: "bad" } }),
    envelope({ ...metrics, mcp: { ...metrics.mcp, credential: "private" } }),
  ]) assert.equal(validateSupervisionRequest(bad), undefined);
});

test("one request has exactly five pinned Noul questions and only redacted state", () => {
  const request = buildSupervisionRequest(metrics);
  assert.deepEqual(Object.keys(request.questions), ids);
  assert.deepEqual(request.state, metrics);
  for (const question of Object.values(request.questions)) assert.equal(question.type, "noul");
  assert.match(request.questions.is_failure_loop.instructions as string, /evidence/i);
});

test("one ask maps healthy and charges input tokens at injected backend price", async () => {
  const { judge, requests } = stub();
  assert.deepEqual(await evaluateSupervision(metrics, options(judge)), { rootId: "root-1", kind: "healthy", probability: 0.7, confidence: 0.3999999999999999, evaluatedAt: 1000, costUsd: 0.000004 });
  assert.equal(requests.length, 1);
});

test("failure gate has priority; active anomaly priority is failure loop, repetition, reading, inverse progress", async () => {
  for (const [m, p, kind, probability] of [
    [{ ...metrics, lifecycle: "paused", reason: "provider_failure", continuationPlan: "retry_interrupted_turn_once" }, [0.99, 0.99, 0.99, 0.01, 0.95], "safe_to_resume", 0.95],
    [{ ...metrics, progress: { ...metrics.progress, equivalentErrorCount: 3, repeatedOperationCount: 6 } }, [0.93, 0.93, 0.1, 0.9, 0.1], "loop", 0.93],
    [{ ...metrics, progress: { ...metrics.progress, repeatedOperationCount: 6 } }, [0.91, 0.1, 0.9, 0.9, 0.1], "loop", 0.91],
    [{ ...metrics, progress: { ...metrics.progress, readsSinceProgress: 20 } }, [0.1, 0.1, 0.91, 0.09, 0.1], "no_progress", 0.91],
    [metrics, [0.1, 0.1, 0.2, 0.04, 0.1], "no_progress", 0.96],
    [{ ...metrics, progress: { ...metrics.progress!, equivalentErrorCount: 3, repeatedOperationCount: 6, readsSinceProgress: 20 } }, [0.9, 0.9, 0.9, 0.1, 0.1], "loop", 0.9],
  ] as const) {
    const result = await evaluateSupervision(m, options(stub([...p]).judge));
    assert.equal(result?.kind, kind); assert.equal(result?.probability, probability);
    assert.equal(result?.confidence, Math.abs(2 * probability - 1));
  }
});

test("malformed, unavailable and judge failures never become healthy", async () => {
  const { judge } = stub();
  assert.equal(await evaluateSupervision({ ...metrics, prompt: "private" }, options(judge)), undefined);
  assert.equal(await evaluateSupervision({ ...metrics, mcp: { state: "unknown", capabilityCount: 1, source: "private" } }, options(judge)), undefined);
  for (const response of [undefined, { ok: false }, { answers: {} }, { answers: Object.fromEntries(ids.map(id => [id, { type: "noul", noul: NaN }])), usage: { input_tokens: 1 }, model: "jev-test" }]) {
    const failing = { evaluate: async () => response as never };
    assert.equal(await evaluateSupervision(metrics, options(failing)), undefined);
  }
  assert.equal(await evaluateSupervision(metrics, options({ evaluate: async () => { throw new Error("offline"); } })), undefined);
});
