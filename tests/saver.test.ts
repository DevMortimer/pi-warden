import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextLedger, formatLedger } from "../src/saver.js";

test("the ledger counts candidates, compressions, token-turns, and first recalls only", () => {
  const ledger = new ContextLedger();
  assert.match(formatLedger(ledger.snapshot()), /no tool output large enough/);
  ledger.candidate();
  ledger.candidate();
  ledger.record("/tmp/pi-warden-output-a/output.txt", 40_000, { tool: "bash", bytes: 50_000 });
  ledger.turnEnd();
  ledger.turnEnd();
  ledger.record("/tmp/pi-warden-output-b/output.txt", 8_000, { tool: "bash", bytes: 50_000 });
  ledger.turnEnd();
  assert.equal(ledger.noteAccess(JSON.stringify({ path: "/tmp/pi-warden-output-a/output.txt" })), "/tmp/pi-warden-output-a/output.txt");
  assert.equal(ledger.noteAccess("cat /tmp/pi-warden-output-a/output.txt | tail", "scoped"), "/tmp/pi-warden-output-a/output.txt", "a second access is reported but not counted twice");
  assert.equal(ledger.noteAccess(JSON.stringify({ path: "/tmp/unrelated.txt" })), undefined);
  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot, { large: 2, compressed: 2, duplicates: 0, bytesSaved: 48_000, turns: 3, tokenTurnsSaved: 10_000 + 10_000 + 12_000, recalls: 1, recallsFull: 1 });
  assert.match(formatLedger(snapshot), /2 large outputs, 2 compressed, 0 duplicates dropped, 46\.9 KB removed \(~12000 tokens\), ~32000 token-turns spared over 3 turns, 1 recall of the full output \(50%; 1 whole-file, 0 scoped\)/);
  ledger.reset();
  assert.deepEqual(ledger.snapshot(), { large: 0, compressed: 0, duplicates: 0, bytesSaved: 0, turns: 0, tokenTurnsSaved: 0, recalls: 0, recallsFull: 0 });
});

test("duplicates are remembered by content key, keep the first stored copy, and count separately from compressions", () => {
  const ledger = new ContextLedger();
  assert.equal(ledger.duplicateOf("k1"), undefined);
  ledger.remember("k1", "bash");
  assert.deepEqual(ledger.duplicateOf("k1"), { tool: "bash" });
  ledger.remember("k1", "bash", "/tmp/pi-warden-output-c/output.txt");
  ledger.remember("k1", "read", undefined);
  assert.deepEqual(ledger.duplicateOf("k1"), { tool: "bash", path: "/tmp/pi-warden-output-c/output.txt" }, "a later copy without a file does not discard the stored path");
  ledger.duplicate(30_000);
  assert.equal(ledger.storedPathIn("rg -n 'x' /tmp/pi-warden-output-c/output.txt"), "/tmp/pi-warden-output-c/output.txt");
  assert.equal(ledger.noteAccess("rg -n 'x' /tmp/pi-warden-output-c/output.txt", "scoped"), undefined, "a duplicate-only copy is not a compression recall");
  ledger.noteAccess("anything", "scoped");
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.duplicates, 1);
  assert.equal(snapshot.compressed, 0);
  assert.equal(snapshot.bytesSaved, 30_000);
  assert.match(formatLedger(snapshot), /0 large outputs, 0 compressed, 1 duplicate dropped, 29\.3 KB removed/);
  ledger.record("C:\\Temp\\pi-warden-output-d\\output.txt", 1_000, { tool: "bash", bytes: 50_000 });
  assert.equal(ledger.storedPathIn(JSON.stringify({ path: "C:\\Temp\\pi-warden-output-d\\output.txt" })), "C:\\Temp\\pi-warden-output-d\\output.txt", "a Windows path matches in its JSON form");
  ledger.noteAccess(JSON.stringify({ command: "findstr /n /c:\"x\" C:\\Temp\\pi-warden-output-d\\output.txt" }), "scoped");
  assert.deepEqual([ledger.snapshot().recalls, ledger.snapshot().recallsFull], [1, 0]);
  assert.match(formatLedger(ledger.snapshot()), /1 recall of the full output \(100%; 0 whole-file, 1 scoped\)/);
});
