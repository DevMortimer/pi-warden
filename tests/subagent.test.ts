import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import type { Judge } from "../src/guard.js";
import { formatWake, mentionsTrouble, newReports, reportDigest, reportLabel, triageReport, WakePolicy } from "../src/subagent.js";
import type { SubagentEntry, SubagentReport } from "../src/subagent.js";

const config = (overrides: Partial<ReturnType<typeof defaultConfig>["subagent"]> = {}) => ({ ...defaultConfig().subagent, ...overrides });
const options = (overrides: Partial<Parameters<typeof triageReport>[1]> = {}) => ({ config: config(), timeoutMs: 1000, ...overrides });

/** A judge that answers only the wake question; `calls` counts how often it was asked. */
const judge = (noulValue: number, calls: { count: number } = { count: 0 }): Judge => ({
  async evaluate() {
    calls.count++;
    return { model: "jev-test", elapsedMs: 3, answers: { wake: { type: "noul", noul: noulValue } } } as never;
  },
});

const report = (text: string, overrides: Partial<SubagentReport> = {}): SubagentReport => ({ id: "e1", customType: "subagent-notify", incremental: false, text, ...overrides });
const entry = (id: string, customType: string, content: string): SubagentEntry => ({ id, type: "custom_message", customType, content });

const failure = "Background tasks completed (1): **explorer**\n\n1. explorer\nResult: could not finish; the migration step failed with exit code 1\nParallel handoff: /tmp/handoff.md";
const progress = "Background task progress: **explorer** is still reading src/config.ts (12 files inspected so far)";
const completion = "Background tasks completed (1): **explorer**\n\n1. explorer\nResult: rewrote the parser and ran the test suite; all 12 tests pass";

test("newReports reads only known subagent notify entries, once each, newest last", () => {
  const entries: SubagentEntry[] = [
    { id: "m1", type: "message", content: "ordinary turn" },
    entry("e1", "subagent-incremental-child-notify", progress),
    entry("e2", "subagent-notify", completion),
    entry("e3", "someone-elses-custom-type", "not a report"),
    { id: "e4", type: "custom_message", customType: "subagent-notify", content: "   " },
    entry("e5", "subagent_supervisor_request", "child asks: which branch should I merge into?"),
  ];
  const found = newReports(entries, new Set());
  assert.deepEqual(found.map(item => item.id), ["e1", "e2", "e5"]);
  assert.equal(found[0]!.incremental, true, "an incremental notify is marked as progress");
  assert.equal(found[1]!.incremental, false);
  assert.deepEqual(newReports(entries, new Set(["e1", "e2"])).map(item => item.id), ["e5"], "seen entries are skipped");
  assert.deepEqual(newReports(entries, new Set(), 2).map(item => item.id), ["e2", "e5"], "bounded to the newest reports");
});

test("mentionsTrouble reads trouble in code: failures, blockers, and questions wake-eligible; completions and progress do not", () => {
  for (const text of [failure, "child blocked: needs a decision on the schema", "the child was stopped by the watchdog", "timed out after 900 s", "1 task failed", "asks you to confirm the release"]) assert.ok(mentionsTrouble(text), text);
  for (const text of [completion, progress, "Background tasks completed (2): **a**, **b**\nResult: both wrote their files; nothing to do", "still working: 3 of 9 steps done"]) assert.ok(!mentionsTrouble(text), text);
});

test("triageReport answers the cheap cases offline, asks Jev only about trouble, and stays quiet when it cannot ask", async () => {
  const incremental = await triageReport(report(progress, { incremental: true, customType: "subagent-incremental-child-notify" }), options({ judge: judge(0.99) }));
  assert.equal(incremental.wake, false);
  assert.equal(incremental.source, "offline");
  assert.match(incremental.reason, /incremental/);
  const clean = await triageReport(report(completion), options({ judge: judge(0.99) }));
  assert.equal(clean.wake, false);
  assert.equal(clean.source, "offline");
  assert.match(clean.reason, /no failure/);

  const calls = { count: 0 };
  const asked = await triageReport(report(failure), options({ judge: judge(0.93, calls) }));
  assert.equal(calls.count, 1, "one request for a report that names trouble");
  assert.equal(asked.wake, true);
  assert.equal(asked.source, "jev");
  assert.equal(asked.probability, 0.93);
  assert.equal((await triageReport(report(failure), options({ judge: judge(0.4) }))).wake, false, "below the threshold it stays silent");
  assert.equal((await triageReport(report(failure), options({ judge: judge(0.93), config: config({ wake: false }) }))).wake, false, "wake off keeps the offline layer only");
  assert.equal((await triageReport(report(failure), options({ judge: judge(0.93), config: config({ threshold: 0.95 }) }))).wake, false, "a raised threshold stays conservative");

  const failed = { evaluate: async () => { throw new Error("upstream unavailable"); } } as Judge;
  const error = await triageReport(report(failure), options({ judge: failed }));
  assert.equal(error.wake, false, "a failed judgment keeps the user uninterrupted; the report is in context anyway");
  assert.equal(error.source, "error");
  const noJudge = await triageReport(report(failure), options());
  assert.equal(noJudge.wake, false);
  assert.equal(noJudge.source, "offline");
});

test("a report reaches Jev bounded and redacted, and the wake names the report without repeating it", () => {
  const long = `${"padding line\n".repeat(400)}TOKEN=sk-synthetic-0123456789abcdef\nResult: the child failed`;
  const digest = reportDigest(long);
  assert.ok(digest.length < long.length);
  assert.match(digest, /\[unsampled middle\]/);
  assert.match(digest, /Result: the child failed$/, "the tail keeps the status line");
  assert.ok(!digest.includes("sk-synthetic"), "credentials are redacted before anything leaves the machine");
  const label = reportLabel(report(`explorer failed: ${"header words ".repeat(30)}\nsecond line of the report`));
  assert.equal(label.length, 161, "one clipped line, not the report");
  const wake = formatWake([label, "explorer failed: exit code 1"]);
  assert.match(wake, /^pi-warden: 2 subagent reports need you:/);
  assert.match(wake, /explorer failed: header words/);
  assert.ok(!wake.includes("second line of the report"), "only the pointer line is copied, never the report");
  assert.match(wake, /The full reports are already in your context; this is only a pointer\.$/);
  assert.match(formatWake(["one line"]), /^pi-warden: one subagent report needs you:/);
});

test("WakePolicy sends one batched wake per window and holds the rest until the next flush", () => {
  const policy = new WakePolicy(60_000);
  assert.deepEqual(policy.offer("first", 1_000), ["first"]);
  assert.equal(policy.offer("second", 1_001), undefined, "inside the window nothing is sent");
  assert.equal(policy.waiting(), 1, "the second report waits");
  assert.deepEqual(policy.offer("third", 60_999), undefined);
  assert.deepEqual(policy.offer("fourth", 61_000), ["second", "third", "fourth"], "the next window carries the whole batch");
  assert.equal(policy.waiting(), 0);
  assert.equal(policy.flush(61_001), undefined, "an empty batch sends nothing");
  policy.reset();
  assert.equal(policy.waiting(), 0);
  assert.deepEqual(policy.offer("after reset", 1), ["after reset"], "a new session wakes at once");
});
