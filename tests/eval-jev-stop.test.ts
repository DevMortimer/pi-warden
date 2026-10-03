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

// The cancelled trace sample (preregistration Corrections 2 and 3): one failed request, `aborted`, in the moment of a judged call.

const RUN = { startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:30:00.000Z" };
const SESSION = { v: 1, kind: "session", judgments: "on" };
const aborted = { code: "aborted", message: "TypeSafe request cancelled", at: "2026-10-01T10:12:41.389Z" };
const FAILED_AT = Date.parse(aborted.at);
/** An action entry with a `jev:` line, recorded `offsetMs` after `lastFailure.at`; the line has an off-task answer when `offTask`. */
const jevEntry = (offTask: boolean, offsetMs: number) => ({
  v: 1,
  kind: "entry",
  guard: "action",
  at: new Date(FAILED_AT + offsetMs).toISOString(),
  line: "warden · action · bash · allow",
  details: ["ran: ls", `jev: irreversible 0.03${offTask ? " · off-task 0.10 · expected step (0.90)" : ""}`],
});
/** Answered entries, one every 30 s, ending 30 s before `lastFailure.at`: the run's other judged calls. */
const answered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => jevEntry(true, -(n - i + from - 1) * 30_000));

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
const CANCELLED = { failure: null, cancelledTraceSamples: 1 };
const STOPPED = { failure: "1 Jev request(s) failed", cancelledTraceSamples: 0 };

test("a cancelled trace sample in the same millisecond as lastFailure does not stop the batch and records cancelledTraceSamples 1", () => {
  const d = sampledRun(T12, aborted, [SESSION, ...answered(2), jevEntry(false, 0), jevEntry(true, 22_000)]);
  assert.deepEqual(check(d), CANCELLED);
});

test("the nearest entry 600 ms after lastFailure.at, or 1,000 ms away, is the cancelled sample", () => {
  assert.deepEqual(check(sampledRun(T12, aborted, [SESSION, ...answered(2), jevEntry(false, 600)])), CANCELLED);
  assert.deepEqual(check(sampledRun(T12, aborted, [SESSION, ...answered(2), jevEntry(false, -1000)])), CANCELLED);
});

test("the sample on the 2nd entry of its process does not stop the batch", () => {
  const d = sampledRun(T12, aborted, [SESSION, jevEntry(true, -30_000), jevEntry(false, 0), jevEntry(true, 20_000)]);
  assert.deepEqual(check(d), CANCELLED);
});

test("a process whose answered sample is on its 2nd entry does not hide a cancelled sample in another process", () => {
  const shifted = [jevEntry(false, -120_000), jevEntry(true, -90_000), jevEntry(true, -60_000)];
  const d = sampledRun(T12, aborted, [SESSION, jevEntry(true, -240_000), SESSION, ...shifted, SESSION, jevEntry(false, 0), jevEntry(true, 15_000)]);
  assert.deepEqual(check(d), CANCELLED);
});

test("a security output that was not judged beside a cancelled sample does not stop the batch", () => {
  const security = { v: 1, kind: "entry", guard: "security", at: new Date(FAILED_AT - 5000).toISOString(), line: "warden · security · bash", details: ["jev: not judged"] };
  const d = sampledRun(T12, aborted, [SESSION, ...answered(2), security, jevEntry(false, 0)]);
  assert.deepEqual(check(d), CANCELLED);
});

test("the nearest entry has an off-task answer: the sample answered, so the failure stops the batch", () => {
  const d = sampledRun(T12, aborted, [SESSION, jevEntry(false, 1500), jevEntry(true, 0), jevEntry(false, -2500)]);
  assert.deepEqual(check(d), STOPPED);
});

test("two entries equally near, one with an off-task answer, stop the batch", () => {
  const d = sampledRun(T12, aborted, [SESSION, jevEntry(false, -400), jevEntry(true, 400)]);
  assert.deepEqual(check(d), STOPPED);
});

test("no action entry with a jev line within 1,000 ms stops the batch", () => {
  const d = sampledRun(T12, aborted, [SESSION, ...answered(2), jevEntry(false, 1001)]);
  assert.deepEqual(check(d), STOPPED);
  const none = sampledRun(T12, aborted, [SESSION, { v: 1, kind: "entry", guard: "rules", at: aborted.at, line: "warden · rules · ok", details: ["jev: x"] }]);
  assert.deepEqual(check(none), STOPPED);
  assert.deepEqual(check(sampledRun(T12, aborted, [SESSION])), STOPPED);
});

test("two failed requests stop the batch even when the sampled call has no off-task answer", () => {
  const d = sampledRun({ requestsStarted: 9, requestsSucceeded: 7, requestsFailed: 2 }, aborted, [SESSION, jevEntry(false, 0)]);
  assert.match(check(d).failure ?? "", /2 Jev request\(s\) failed/);
});

for (const code of ["timeout", "http", "budget"]) {
  test(`a failure with code ${code} stops the batch`, () => {
    const d = sampledRun(T12, { ...aborted, code }, [SESSION, jevEntry(false, 0)]);
    assert.deepEqual(check(d), STOPPED);
  });
}

test("a failed request with no lastFailure stops the batch", () => {
  const d = sampledRun(T12, null, [SESSION, jevEntry(false, 0)]);
  assert.deepEqual(check(d), STOPPED);
});

test("a lastFailure outside the run, or a run with no start time, stops the batch", () => {
  const outside = { ...aborted, at: "2026-09-30T10:12:41.389Z" };
  const old = sampledRun(T12, outside, [SESSION, { ...jevEntry(false, 0), at: outside.at }]);
  assert.deepEqual(check(old), STOPPED);
  const unknown = sampledRun(T12, aborted, [SESSION, jevEntry(false, 0)]);
  assert.deepEqual(check(unknown, { startedAt: undefined }), STOPPED);
});

test("an entry that shows a failed Jev request (TypeSafe unavailable, an error) stops the batch", () => {
  for (const failedEntry of [
    { v: 1, kind: "entry", guard: "action", line: "warden · action · bash · typesafe error", details: ["typesafe: TypeSafe request cancelled", "why: TypeSafe unavailable; allowed by failOpen"] },
    { v: 1, kind: "entry", guard: "action", line: "warden · action · bash · allow", details: ["why: TypeSafe unavailable; allowed by failOpen"] },
    { v: 1, kind: "entry", guard: "rules", line: "warden · rules · turn start · nothing appended", details: ["trigger: before_agent_start", "error: request failed"] },
    { v: 1, kind: "entry", guard: "conscience", line: "error: timeout", details: ["skipReason: error"] },
  ]) {
    const d = sampledRun(T12, aborted, [SESSION, jevEntry(false, 0), failedEntry]);
    assert.deepEqual(check(d), STOPPED);
  }
});

test("judgments going off stop the batch even with a cancelled sample", () => {
  const d = sampledRun(T12, aborted, [SESSION, jevEntry(false, 0), { v: 1, kind: "judgments", judgments: "off:budget" }]);
  assert.match(check(d).failure ?? "", /judgments went off/);
});

test("jevFailure without run times keeps the old behavior for a failed request", () => {
  const d = sampledRun(T12, aborted, [SESSION, jevEntry(false, 0)]);
  try {
    assert.match(jevFailure(d) ?? "", /1 Jev request\(s\) failed/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});
