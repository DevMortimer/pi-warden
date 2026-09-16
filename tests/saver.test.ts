import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextLedger, formatLedger } from "../src/saver.js";

test("the ledger counts candidates, compressions, token-turns, and first recalls only", () => {
  const ledger = new ContextLedger();
  assert.match(formatLedger(ledger.snapshot()), /no tool output large enough/);
  ledger.candidate();
  ledger.candidate();
  ledger.record("/tmp/pi-warden-output-a/output.txt", 40_000);
  ledger.turnEnd();
  ledger.turnEnd();
  ledger.record("/tmp/pi-warden-output-b/output.txt", 8_000);
  ledger.turnEnd();
  assert.equal(ledger.noteAccess(JSON.stringify({ path: "/tmp/pi-warden-output-a/output.txt" })), "/tmp/pi-warden-output-a/output.txt");
  assert.equal(ledger.noteAccess("cat /tmp/pi-warden-output-a/output.txt | tail"), "/tmp/pi-warden-output-a/output.txt", "a second access is reported but not counted twice");
  assert.equal(ledger.noteAccess(JSON.stringify({ path: "/tmp/unrelated.txt" })), undefined);
  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot, { large: 2, compressed: 2, bytesSaved: 48_000, turns: 3, tokenTurnsSaved: 10_000 + 10_000 + 12_000, recalls: 1 });
  assert.match(formatLedger(snapshot), /2 large outputs, 2 compressed, 46\.9 KB removed \(~12000 tokens\), ~32000 token-turns spared over 3 turns, 1 recall of the full output \(50%\)/);
  ledger.reset();
  assert.deepEqual(ledger.snapshot(), { large: 0, compressed: 0, bytesSaved: 0, turns: 0, tokenTurnsSaved: 0, recalls: 0 });
});
