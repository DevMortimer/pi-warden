import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { TypeSafeIntegrationError } from "pi-typesafe";
// @ts-expect-error calibration fixtures are an executable JavaScript module
import { cases, developmentCases, holdoutCases, fixtureVersion } from "../scripts/supervision-cases.mjs";
// @ts-expect-error the calibration runner is an executable JavaScript module
import { calibrate, canRequestCalibration, requestReserveUsd, runCeilingUsd, activationCriteria } from "../scripts/supervision-calibrate.mjs";
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
const rawAnswers = (p: number[]) => Object.fromEntries(ids.map((id, i) => [id, { type: "noul", noul: p[i]! }]));
const answerValues = (p: number[]) => Object.fromEntries(ids.map((id, i) => [id, p[i]!]));
function stub(p = probabilities, model = "jev-1.13.0") {
  const requests: unknown[] = [];
  return { requests, judge: { async evaluate(request: unknown) {
    requests.push(request);
    return { model, elapsedMs: 1, usage: { input_tokens: 100, output_tokens: 0 }, answers: rawAnswers(p) } as never;
  } } };
}
const options = (judge: ReturnType<typeof stub>["judge"]) => ({ judge, backend: "typesafe" as const, timeoutMs: 1000, now: () => 1000, price: () => 0.042 });

test("synthetic fixtures are bounded redacted v1 evidence and cover each judgment", () => {
  assert.equal(fixtureVersion, "synthetic-v2");
  assert.equal(cases.length, 30);
  assert.equal(developmentCases.length, 15);
  assert.equal(holdoutCases.length, 15);
  assert.deepEqual(cases, [...developmentCases, ...holdoutCases]);
  for (const split of [developmentCases, holdoutCases]) {
    for (const label of ["healthy", "loop", "no_progress", "safe_to_resume", "unavailable"])
      assert.equal(split.filter((row: { expected: string }) => row.expected === label).length, 3);
  }
  assert.deepEqual(new Set(cases.map((row: { expected: string }) => row.expected)), new Set(["healthy", "loop", "no_progress", "safe_to_resume", "unavailable"]));
  for (const row of cases) {
    assert.deepEqual(validateSupervisionRequest(envelope(row.metrics)), envelope(row.metrics));
    assert.equal(row.metrics.rootId, "synthetic-guardian");
    assert.deepEqual(Object.keys(row), ["expected", "metrics"]);
  }
});

test("calibration pins the questions and keeps a per-run reserve and ceiling", () => {
  const hash = createHash("sha256").update(JSON.stringify(supervisionQuestions)).digest("hex");
  assert.equal(hash, "3fe9064f0de2f6e96373a1942dcba524c0ceb66bb1c9ebd5a98b86f281e11d5e");
  assert.equal(supervisionPolicy.questionHash, hash);
  assert.equal(supervisionPolicy.model, "jev-1.13.0");
  assert.equal(supervisionPolicy.probabilityThreshold, 0.90);
  assert.equal("confidenceThreshold" in supervisionPolicy, false);
  assert.equal("enforcement" in supervisionPolicy, false);
  assert.equal(runCeilingUsd, 0.05);
  assert.equal(requestReserveUsd, 0.0003);
  assert.deepEqual(activationCriteria, { anomalyPrecision: 0.90, anomalyRecall: 0.70, falseSafeResume: 0, safeResumePrecision: 1 });
  assert.equal(canRequestCalibration(0.0497), true);
  assert.equal(canRequestCalibration(0.04971), false);
  assert.equal(canRequestCalibration(0.05, 0), false);
  assert.equal(canRequestCalibration(NaN), false);
});

test("offline calibration batches one request per row and prints each row's five probabilities", async () => {
  const lines: string[] = [];
  const { judge, requests } = stub();
  const report = await calibrate({ judge, rows: cases.slice(0, 2), print: (line: string) => lines.push(line) });
  assert.equal(report.requests, 2);
  assert.equal(requests.length, 2);
  assert.equal(report.inputTokens, 200);
  assert.equal(report.holdout, null);
  assert.ok(lines.some(line => line.includes("distribution development healthy")));
  assert.ok(lines.some(line => line.includes("row 0 development expected=healthy") && ids.every(id => line.includes(`${id}=`))));
  assert.ok(lines.every(line => !line.includes("synthetic-guardian") && !line.includes("rootId") && !line.includes("state")));
  await assert.rejects(calibrate({ judge, rows: [...cases, cases[0]], print: () => {} }), /thirty requests/);
  assert.equal(requests.length, 2);
});

test("full offline v2 run chooses the threshold on development and re-checks it on holdout", async () => {
  const report = await calibrate({ judge: stub().judge, print: () => {} });
  assert.equal(report.requests, 30);
  assert.equal(report.rows.length, 30);
  assert.ok(report.selectedThreshold >= 0.5 && report.selectedThreshold <= 0.99);
  assert.ok(report.holdout);
  assert.ok(report.results.every((result: { answers: Record<string, number> }) => Object.keys(result.answers).length === 5));
  assert.equal(report.passes, false);
});

test("unsafe paused retries and unavailable MCP cannot count as safe resume in calibration", async () => {
  const unsafe = cases.filter((row: { expected: string }) => row.expected === "unavailable");
  const report = await calibrate({ judge: stub([0.1, 0.1, 0.1, 0.9, 0.99]).judge, rows: unsafe, print: () => {} });
  assert.equal(report.development.falseSafeResume, unsafe.length);
  assert.equal(report.development.safeResumePrecision, 0);
  assert.equal(report.passes, false);
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

test("one request has exactly five pinned Noul questions and never sends rootId", () => {
  const request = buildSupervisionRequest(metrics);
  assert.deepEqual(Object.keys(request.questions), ids);
  assert.equal("rootId" in (request.state as Record<string, unknown>), false);
  const { rootId: _root, ...sent } = metrics;
  assert.deepEqual(request.state as Record<string, unknown>, sent);
  for (const question of Object.values(request.questions)) assert.equal(question.type, "noul");
  assert.match(request.questions.is_failure_loop.instructions as string, /evidence/i);
  assert.match(request.questions.is_repeating_without_progress.instructions as string, /6 or more/);
  assert.match(request.questions.is_failure_loop.instructions as string, /3 or more/);
  assert.match(request.questions.is_reading_beyond_reasonable_discovery.instructions as string, /20 or more/);
  assert.match(request.questions.is_safe_to_resume_after_failure.instructions as string, /unavailable/);
});

test("one ask maps healthy, records five answers, and charges input tokens at the injected backend price", async () => {
  const { judge, requests } = stub();
  const outcome = await evaluateSupervision(metrics, options(judge));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { rootId: "root-1", kind: "healthy", probability: 0.7, confidence: 0.3999999999999999, answers: answerValues(probabilities), model: "jev-1.13.0", evaluatedAt: 1000, costUsd: 0.000004 });
  assert.equal(requests.length, 1);
});

test("an answer from a model other than jev-1.13.0 is recorded", async () => {
  const outcome = await evaluateSupervision(metrics, options(stub(probabilities, "jev-9.9.9").judge));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.model, "jev-9.9.9");
});

test("failure gate has priority; active anomaly priority is failure loop, repetition, reading, inverse progress", async () => {
  for (const [m, p, kind, probability] of [
    [{ ...metrics, lifecycle: "paused", reason: "provider_failure", continuationPlan: "retry_interrupted_turn_once" }, [0.99, 0.99, 0.99, 0.01, 0.95], "safe_to_resume", 0.95],
    [{ ...metrics, progress: { ...metrics.progress, equivalentErrorCount: 3, repeatedOperationCount: 6 } }, [0.93, 0.93, 0.1, 0.9, 0.1], "loop", 0.93],
    [{ ...metrics, progress: { ...metrics.progress, repeatedOperationCount: 6 } }, [0.91, 0.1, 0.9, 0.9, 0.1], "loop", 0.91],
    [{ ...metrics, progress: { ...metrics.progress, readsSinceProgress: 20 } }, [0.1, 0.1, 0.91, 0.09, 0.1], "no_progress", 0.91],
    [{ ...metrics, progress: { ...metrics.progress!, lastProgressAgeMs: 60_000 } }, [0.1, 0.1, 0.2, 0.04, 0.1], "no_progress", 0.96],
    [metrics, [0.1, 0.1, 0.2, 0.04, 0.1], "healthy", 0.8],
    [{ ...metrics, progress: { ...metrics.progress!, materialProgressCount: 0, lastProgressAgeMs: null }, observedCostUsd: 0.5 }, [0.1, 0.1, 0.2, 0.04, 0.1], "no_progress", 0.96],
    [{ ...metrics, progress: { ...metrics.progress!, materialProgressCount: 0, lastProgressAgeMs: 59_999 }, observedCostUsd: 0.499 }, [0.1, 0.1, 0.2, 0.04, 0.1], "healthy", 0.8],
    [{ ...metrics, progress: { ...metrics.progress!, equivalentErrorCount: 3, repeatedOperationCount: 6, readsSinceProgress: 20 } }, [0.9, 0.9, 0.9, 0.1, 0.1], "loop", 0.9],
  ] as const) {
    const outcome = await evaluateSupervision(m, options(stub([...p]).judge));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.kind, kind); assert.equal(outcome.result.probability, probability);
    assert.equal(outcome.result.confidence, Math.abs(2 * probability - 1));
  }
});

test("malformed, unavailable and judge failures return a reason, never a healthy result", async () => {
  const { judge } = stub();
  const invalid = await evaluateSupervision({ ...metrics, prompt: "private" }, options(judge));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok === false && invalid.reason, "invalid metrics");
  const nested = await evaluateSupervision({ ...metrics, mcp: { state: "unknown", capabilityCount: 1, source: "private" } }, options(judge));
  assert.equal(nested.ok, false);
  for (const response of [undefined, { ok: false }, { answers: {} }]) {
    const failing = { evaluate: async () => response as never };
    const outcome = await evaluateSupervision(metrics, options(failing));
    assert.equal(outcome.ok, false);
    assert.ok(outcome.ok === false && outcome.reason.length > 0);
  }
  const thrown = await evaluateSupervision(metrics, options({ evaluate: async () => { throw new Error("offline"); } }));
  assert.equal(thrown.ok, false);
  assert.equal(thrown.ok === false ? thrown.reason : "", "judge error: TypeSafe request failed.");
  const judged = await evaluateSupervision(metrics, options({ evaluate: async () => { throw new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 503.", 503); } }));
  assert.equal(judged.ok, false);
  assert.equal(judged.ok === false ? judged.reason : "", "judge error: TypeSafe returned HTTP 503. (http)");
  const caught = await evaluateSupervision(metrics, { ...options(judge), now: () => { throw new Error("clock"); } });
  assert.equal(caught.ok, false);
  assert.match(caught.ok === false ? caught.reason : "", /judge request failed: clock/);
});
