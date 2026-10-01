import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonedJevRequests, jevFailure } from "../eval/jev-stop.mjs";

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
