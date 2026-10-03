import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonedJevRequests, jevCheck, jevFailure } from "../eval/jev-stop.mjs";

/** An agent dir with a usage ledger and a trace dir the way a run leaves them. */
function runDirs(ledger: Record<string, number> | null, trace: object[] = []) {
  const root = mkdtempSync(join(tmpdir(), "eval-jev-stop-"));
  const agentDir = join(root, "agent-dir");
  const traceDir = join(root, "trace");
  mkdirSync(join(agentDir, "pi-typesafe"), { recursive: true });
  mkdirSync(traceDir);
  if (ledger) writeFileSync(join(agentDir, "pi-typesafe", "usage.json"), JSON.stringify({ days: { "2026-10-01": ledger } }));
  if (trace.length) writeFileSync(join(traceDir, "s.jsonl"), trace.map((r) => JSON.stringify(r)).join("\n"));
  return { root, agentDir, traceDir };
}

test("a run whose judgments all succeeded has no Jev failure", () => {
  const d = runDirs({ requestsStarted: 6, requestsSucceeded: 6, requestsFailed: 0 }, [{ v: 1, kind: "session", judgments: "on" }]);
  try {
    assert.equal(jevFailure(d), null);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("a failed request in the ledger (HTTP 402, a timeout, any error) is a Jev failure", () => {
  const d = runDirs({ requestsStarted: 3, requestsSucceeded: 2, requestsFailed: 1 });
  try {
    assert.match(jevFailure(d) ?? "", /1 Jev request\(s\) failed/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("a request that started and never finished is abandoned, not a failure, when nothing fell back", () => {
  const d = runDirs({ requestsStarted: 3, requestsSucceeded: 2, requestsFailed: 0 }, [{ v: 1, kind: "session", judgments: "on" }]);
  try {
    assert.equal(jevFailure(d), null);
    assert.equal(abandonedJevRequests(d.agentDir), 1);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("a request in flight does not hide a failed one: the failure still stops the batch", () => {
  const d = runDirs({ requestsStarted: 4, requestsSucceeded: 2, requestsFailed: 1 });
  try {
    assert.match(jevFailure(d) ?? "", /^1 Jev request\(s\) failed$/);
    assert.equal(abandonedJevRequests(d.agentDir), 1);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("judgments going off for a spend-cap stop show in the trace even though the ledger counts nothing", () => {
  const d = runDirs({ requestsStarted: 2, requestsSucceeded: 2, requestsFailed: 0 }, [
    { v: 1, kind: "session", judgments: "on" },
    { v: 1, kind: "judgments", judgments: "off:budget" },
  ]);
  try {
    assert.match(jevFailure(d) ?? "", /judgments went off \(off:budget\)/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("an unreadable ledger is a Jev failure, not a pass, unless the run's process was killed at the timeout", () => {
  const d = runDirs(null);
  try {
    writeFileSync(join(d.agentDir, "pi-typesafe", "usage.json"), "{not json");
    assert.match(jevFailure(d) ?? "", /ledger is unreadable/);
    assert.equal(jevFailure({ ...d, killed: true }), null);
    assert.equal(abandonedJevRequests(d.agentDir), 0);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

// The cancelled trace sample (preregistration Corrections 2): one failed request, `aborted`, on a sampled call.

const RUN = { startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:30:00.000Z" };
const SESSION = { v: 1, kind: "session", judgments: "on" };
const jevEntry = (offTask: boolean) => ({ v: 1, kind: "entry", guard: "action", line: "warden · action · bash · allow", details: ["ran: ls", `jev: irreversible 0.03${offTask ? " · off-task 0.10 · expected step (0.90)" : ""}`] });
const entries = (...offTask: boolean[]) => offTask.map(jevEntry);
const aborted = { code: "aborted", message: "TypeSafe request cancelled", at: "2026-10-01T10:12:41.389Z" };

/** A run dir with a ledger, an auth-state file, and a trace; `failure` null leaves no auth-state file. */
function sampledRun(ledger: Record<string, number>, failure: object | null, trace: object[]) {
  const d = runDirs(ledger, trace);
  if (failure) writeFileSync(join(d.agentDir, "pi-typesafe", "auth-state.json"), JSON.stringify({ version: 1, lastFailure: failure }));
  return d;
}
const T12 = { requestsStarted: 9, requestsSucceeded: 8, requestsFailed: 1 };

function check(d: ReturnType<typeof runDirs>, extra: object = {}) {
  try {
    return jevCheck({ ...d, ...RUN, ...extra });
  } finally { rmSync(d.root, { recursive: true, force: true }); }
}

test("a cancelled trace sample does not stop the batch and the run records cancelledTraceSamples 1", () => {
  const d = sampledRun(T12, aborted, [SESSION, ...entries(false, false, true)]);
  assert.deepEqual(check(d), { failure: null, cancelledTraceSamples: 1 });
});

test("the same failure with an answered sample on the sampled call (off-task present) stops the batch", () => {
  const d = sampledRun(T12, aborted, [SESSION, ...entries(true, false, false)]);
  assert.deepEqual(check(d), { failure: "1 Jev request(s) failed", cancelledTraceSamples: 0 });
});

test("two failed requests stop the batch even when the sampled call has no off-task answer", () => {
  const d = sampledRun({ requestsStarted: 9, requestsSucceeded: 7, requestsFailed: 2 }, aborted, [SESSION, ...entries(false, false)]);
  assert.match(check(d).failure ?? "", /2 Jev request\(s\) failed/);
});

for (const code of ["timeout", "http", "budget"]) {
  test(`a failure with code ${code} stops the batch`, () => {
    const d = sampledRun(T12, { ...aborted, code }, [SESSION, ...entries(false, false)]);
    assert.match(check(d).failure ?? "", /1 Jev request\(s\) failed/);
  });
}

test("a failed request with no lastFailure stops the batch", () => {
  const d = sampledRun(T12, null, [SESSION, ...entries(false, false)]);
  assert.match(check(d).failure ?? "", /1 Jev request\(s\) failed/);
});

test("a lastFailure outside the run, or a run with no start time, stops the batch", () => {
  const old = sampledRun(T12, { ...aborted, at: "2026-09-30T10:12:41.389Z" }, [SESSION, ...entries(false)]);
  assert.match(check(old).failure ?? "", /1 Jev request\(s\) failed/);
  const unknown = sampledRun(T12, aborted, [SESSION, ...entries(false)]);
  assert.match(check(unknown, { startedAt: undefined }).failure ?? "", /1 Jev request\(s\) failed/);
});

test("an entry that shows a failed Jev request stops the batch", () => {
  for (const failedEntry of [
    { v: 1, kind: "entry", guard: "action", line: "warden · action · bash · typesafe error", details: ["typesafe: TypeSafe request cancelled", "why: TypeSafe unavailable; allowed by failOpen"] },
    { v: 1, kind: "entry", guard: "rules", line: "warden · rules · turn start · nothing appended", details: ["trigger: before_agent_start", "error: request failed"] },
    { v: 1, kind: "entry", guard: "conscience", line: "error: timeout", details: ["skipReason: error"] },
  ]) {
    const d = sampledRun(T12, aborted, [SESSION, ...entries(false, false), failedEntry]);
    assert.match(check(d).failure ?? "", /1 Jev request\(s\) failed/);
  }
});

test("judgments going off stop the batch even with a cancelled sample", () => {
  const d = sampledRun(T12, aborted, [SESSION, ...entries(false), { v: 1, kind: "judgments", judgments: "off:budget" }]);
  assert.match(check(d).failure ?? "", /judgments went off/);
});

test("the sampled calls are the 1st, 21st, 41st judged call: an unanswered 2nd or 22nd stops, an unanswered 21st does not", () => {
  const answered = Array.from({ length: 41 }, () => true);
  const withGap = (index: number) => answered.map((value, i) => (i === index ? false : value));
  assert.equal(check(sampledRun(T12, aborted, [SESSION, ...entries(...withGap(20))])).cancelledTraceSamples, 1);
  assert.equal(check(sampledRun(T12, aborted, [SESSION, ...entries(...withGap(21))])).cancelledTraceSamples, 0);
  assert.equal(check(sampledRun(T12, aborted, [SESSION, ...entries(...withGap(1))])).cancelledTraceSamples, 0);
});

test("a multi-turn run numbers the judged entries again in each pi process", () => {
  // Process 1 answers its sample; process 2 starts counting again and its first judged entry has no off-task answer.
  const d = sampledRun(T12, aborted, [SESSION, ...entries(true, false, false), SESSION, ...entries(false, false)]);
  assert.deepEqual(check(d), { failure: null, cancelledTraceSamples: 1 });
  // Every process answered its own first sample: nothing is unanswered, so the failure stays unexplained and stops.
  const flat = sampledRun(T12, aborted, [SESSION, ...entries(true, false, false), SESSION, ...entries(true, false)]);
  assert.equal(check(flat).cancelledTraceSamples, 0);
});

test("jevFailure without run times keeps the old behavior for a failed request", () => {
  const d = sampledRun(T12, aborted, [SESSION, ...entries(false)]);
  try {
    assert.match(jevFailure(d) ?? "", /1 Jev request\(s\) failed/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});
