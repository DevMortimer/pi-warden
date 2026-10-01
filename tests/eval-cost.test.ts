import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepseekWindow, priceFor } from "../eval/config.mjs";
import { callCosts, runCost } from "../eval/cost.mjs";

const A = "deepseek/deepseek-flash";
const B = "claude-bridge/claude-sonnet-5-5";
const utc = (iso: string) => Date.parse(iso);

test("DeepSeek peak hours are 01-04 and 06-10 UTC on weekdays", () => {
  // 2026-09-30 is a Wednesday.
  assert.equal(deepseekWindow(utc("2026-09-30T00:59:59Z")), "off-peak");
  assert.equal(deepseekWindow(utc("2026-09-30T01:00:00Z")), "peak");
  assert.equal(deepseekWindow(utc("2026-09-30T03:59:59Z")), "peak");
  assert.equal(deepseekWindow(utc("2026-09-30T04:00:00Z")), "off-peak");
  assert.equal(deepseekWindow(utc("2026-09-30T05:59:59Z")), "off-peak");
  assert.equal(deepseekWindow(utc("2026-09-30T06:00:00Z")), "peak");
  assert.equal(deepseekWindow(utc("2026-09-30T09:59:59Z")), "peak");
  assert.equal(deepseekWindow(utc("2026-09-30T10:00:00Z")), "off-peak");
});

test("weekends are off-peak in full", () => {
  assert.equal(deepseekWindow(utc("2026-09-26T02:00:00Z")), "off-peak"); // Saturday
  assert.equal(deepseekWindow(utc("2026-09-27T07:00:00Z")), "off-peak"); // Sunday
});

test("a Chinese public holiday is off-peak in full, a make-up Saturday stays off-peak, the day after is peak again", () => {
  assert.equal(deepseekWindow(utc("2026-10-01T02:00:00Z")), "off-peak"); // National Day, Thursday
  assert.equal(deepseekWindow(utc("2026-10-07T07:00:00Z")), "off-peak"); // last day off, Wednesday
  assert.equal(deepseekWindow(utc("2026-10-08T07:00:00Z")), "peak"); // Thursday after
  assert.equal(deepseekWindow(utc("2026-02-16T02:00:00Z")), "off-peak"); // Spring Festival, Monday
  assert.equal(deepseekWindow(utc("2026-02-24T02:00:00Z")), "peak"); // Tuesday after
  assert.equal(deepseekWindow(utc("2026-10-10T02:00:00Z")), "off-peak"); // make-up Saturday
});

test("a year without a holiday calendar has no price", () => {
  assert.equal(deepseekWindow(utc("2027-03-03T02:00:00Z")), null);
  assert.equal(priceFor(A, utc("2027-03-03T02:00:00Z")), null);
  assert.equal(priceFor(A, Number.NaN), null);
});

test("A's off-peak rates are half of the peak rates the page lists", () => {
  assert.deepEqual(priceFor(A, utc("2026-09-30T02:00:00Z")), { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0, window: "peak" });
  assert.deepEqual(priceFor(A, utc("2026-09-30T12:00:00Z")), { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0, window: "off-peak" });
});

test("B is flat at Sonnet 5.5's list prices whatever the time", () => {
  const flat = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, window: "flat" };
  assert.deepEqual(priceFor(B, utc("2026-09-30T02:00:00Z")), flat);
  assert.deepEqual(priceFor(B, utc("2030-01-01T00:00:00Z")), flat);
  assert.deepEqual(priceFor(B), flat);
});

const call = (iso: string, usage: Record<string, number>) => ({
  message: { role: "assistant", timestamp: utc(iso), usage: { totalTokens: Object.values(usage).reduce((s, x) => s + x, 0), ...usage } },
});
const events = [
  call("2026-09-30T02:00:00Z", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), // peak: $0.30
  call("2026-09-30T12:00:00Z", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }), // off-peak: 0.15 + 0.6 + 0.003
];

test("each call is priced by its own timestamp", () => {
  const calls = callCosts(events, A);
  assert.deepEqual(calls.map((c) => [c.atIso, c.window, c.usd]), [
    ["2026-09-30T02:00:00.000Z", "peak", 0.3],
    ["2026-09-30T12:00:00.000Z", "off-peak", 0.753],
  ]);
});

test("a run's agent dollars sum its calls and split by window", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-cost-"));
  try {
    mkdirSync(join(dir, "pi-typesafe"));
    writeFileSync(join(dir, "pi-typesafe", "usage.json"), JSON.stringify({ days: { d: { requestsStarted: 2, inputTokens: 1_000_000 } } }));
    const cost = runCost({ events, agentDir: dir, model: A });
    assert.equal(cost.agentUsd, 1.053);
    assert.equal(cost.jevUsd, 0.042);
    assert.equal(cost.usd, 1.095);
    assert.deepEqual(cost.windows, { peak: { calls: 1, usd: 0.3 }, "off-peak": { calls: 1, usd: 0.753 } });
    const flat = runCost({ events, agentDir: dir, model: B });
    assert.equal(flat.agentUsd, 2 + 2 + 10 + 0.2);
    assert.deepEqual(flat.windows, { flat: { calls: 2, usd: 14.2 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call with no timestamp, or an unknown model, leaves the dollars null and the tokens counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-cost-"));
  try {
    const undated = [{ message: { role: "assistant", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } } }];
    const a = runCost({ events: undated, agentDir: dir, model: A });
    assert.equal(a.usd, null);
    assert.equal(a.tokens.totalTokens, 10);
    assert.match(a.reason ?? "", /no price for deepseek\/deepseek-flash at a call without a timestamp/);
    const unknown = runCost({ events, agentDir: dir, model: "x/y" });
    assert.equal(unknown.usd, null);
    assert.match(unknown.reason ?? "", /no price for x\/y/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the subscription models are priced as equivalents: model 1 at DeepSeek's rates by timestamp, model 2 at Xiaomi's MiMo-V2.5 price", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-cost-"));
  try {
    const one = runCost({ events, agentDir: dir, model: "cheapestinference/deepseek-v4.1-flash" });
    assert.equal(one.agentUsd, runCost({ events, agentDir: dir, model: A }).agentUsd, "the same table as A, by each call's timestamp");
    assert.deepEqual(one.windows, { peak: { calls: 1, usd: 0.3 }, "off-peak": { calls: 1, usd: 0.753 } });
    const two = runCost({ events, agentDir: dir, model: "cheapestinference/mimo-v2.5" });
    // 2M input at $0.14, 1M output at $0.28, 1M cache hits at $0.0028.
    assert.equal(two.agentUsd, 0.5628);
    assert.deepEqual(two.windows, { flat: { calls: 2, usd: 0.5628 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
