import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { infraReason } from "../eval/batch.mjs";
import { createStallWatch, progressCount } from "../eval/stall.mjs";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "eval-ab.mjs");

const assistant = { message: { role: "assistant", stopReason: "stop" } };
const toolResult = { message: { role: "toolResult" } };
const user = { message: { role: "user" } };

test("stall rule: only assistant messages and tool results count as progress", () => {
  assert.equal(progressCount([]), 0);
  assert.equal(progressCount([user, { type: "session" }, assistant, toolResult, user, assistant]), 3);
});

test("stall rule: a watch fires when the progress count has not grown for the limit, and a new message restarts the clock", () => {
  const watch = createStallWatch({ stallMs: 15 * 60_000, now: 0, count: 2 });
  assert.equal(watch.check(2, 14 * 60_000), false, "14 minutes without progress is not a stall");
  assert.equal(watch.check(3, 14 * 60_000 + 1), false, "a new message restarts the clock");
  assert.equal(watch.check(3, 29 * 60_000), false, "14 minutes after the new message");
  assert.equal(watch.check(3, 29 * 60_000 + 1), true, "15 minutes after the new message is a stall");
});

test("stall rule: a turn of a continued session starts from the messages the earlier turns left", () => {
  const watch = createStallWatch({ stallMs: 1000, now: 0, count: 7 });
  assert.equal(watch.check(7, 999), false);
  assert.equal(watch.check(7, 1000), true, "old messages are not progress of this turn");
});

test("stall rule: a stalled run is an infrastructure failure, even when the log holds a good assistant message", () => {
  const reason = infraReason([assistant], { stalled: true, timedOut: false, code: null });
  assert.match(String(reason), /^stalled: no new assistant message or tool result/);
  assert.equal(infraReason([assistant], { stalled: false }), null);
});

/** A fake `pi` that writes one assistant message, then hangs, or keeps making progress. */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const agentDir = process.env.PI_CODING_AGENT_DIR;
const warden = args.some((a, i) => args[i - 1] === "-e" && a.endsWith(path.join("extensions", "index.js")));
const line = (role) => JSON.stringify({ type: "message", message: Object.assign({ role, timestamp: Date.now() }, role === "assistant" ? { content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } } : {}) }) + "\\n";
fs.mkdirSync(sessionDir, { recursive: true });
fs.appendFileSync(path.join(sessionDir, "s.jsonl"), line("assistant"));
fs.appendFileSync(path.join(process.env.PI_FAKE_STATE, "starts.log"), "start\\n");
if (process.env.PI_FAKE_MODE === "hang") {
  if (warden) {
    // A ledger write cut short by the kill: the stall must not read as a Jev failure.
    fs.mkdirSync(path.join(agentDir, "pi-typesafe"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "pi-typesafe", "usage.json"), "{not json");
  }
  setTimeout(() => {}, 60000);
} else {
  // Slow but alive: a message or a tool result every 0.4 s, for longer than the stall limit.
  let n = 0;
  const tick = setInterval(() => {
    fs.appendFileSync(path.join(sessionDir, "s.jsonl"), line(n % 2 ? "assistant" : "toolResult"));
    if (++n === 6) { clearInterval(tick); }
  }, 400);
}
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eval-stall-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "pi"), FAKE_PI);
  chmodSync(join(bin, "pi"), 0o755);
  const out = join(root, "report");
  const go = (args: string[], mode: string) =>
    spawnSync("node", [SCRIPT, "--tasks", "t1-redact", "--model", "fake/model", "--retry-delays", "0,0", "--concurrency", "1", "--repeats", "1", "--stall-min", "0.03", "--timeout-min", "5", "--out", out, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PI_FAKE_STATE: state, PI_FAKE_MODE: mode },
    });
  const read = () => JSON.parse(readFileSync(join(out, "runs.json"), "utf8"));
  const starts = () => (existsSync(join(state, "starts.log")) ? readFileSync(join(state, "starts.log"), "utf8").trim().split("\n").length : 0);
  return { root, go, read, starts };
}

test("stall rule: a pi process that stops making progress is killed, re-run twice, then recorded as an infrastructure failure that excludes its block and stops nothing", () => {
  const f = fixture();
  try {
    const run = f.go([], "hang");
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const doc = f.read();
    assert.equal(doc.stoppedBy, undefined, "a stalled warden run with a cut-short ledger is not a Jev failure");
    assert.equal(doc.runs.length, 3);
    for (const r of doc.runs) {
      assert.match(r.infraError, /^stalled: no new assistant message or tool result/);
      assert.equal(r.excludedBlock, true);
      assert.equal(r.timedOut, undefined, "a stall is not a task timeout");
    }
    assert.equal(f.starts(), 9, "3 cells x (1 run + 2 re-runs)");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("stall rule: a run that keeps adding messages and tool results is not killed, even when it outlasts the stall limit", () => {
  const f = fixture();
  try {
    const run = f.go(["--max-runs", "1"], "slow");
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const doc = f.read();
    assert.equal(doc.runs.length, 1);
    assert.equal(doc.runs[0].infraError, undefined);
    assert.ok(doc.runs[0].seconds >= 2, "the run lasted longer than the 1.8 s stall limit");
    assert.equal(f.starts(), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
