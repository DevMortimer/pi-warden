import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevFailure } from "../eval/jev-stop.mjs";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "eval-ab.mjs");

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

test("a request that started and never finished is a Jev failure", () => {
  const d = runDirs({ requestsStarted: 3, requestsSucceeded: 2, requestsFailed: 0 });
  try {
    assert.match(jevFailure(d) ?? "", /1 Jev request\(s\) started and never finished/);
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

test("an unreadable ledger is a Jev failure, not a pass", () => {
  const d = runDirs(null);
  try {
    writeFileSync(join(d.agentDir, "pi-typesafe", "usage.json"), "{not json");
    assert.match(jevFailure(d) ?? "", /ledger is unreadable/);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
});

/**
 * A fake `pi` on PATH: in a run that loads pi-warden (`-e .../extensions/index.js`) it
 * writes the Jev ledger or trace the mode names, as if the judge had answered or failed.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const warden = args.some((a, i) => args[i - 1] === "-e" && a.endsWith(path.join("extensions", "index.js")));
if (warden) {
  const ledger = { ok: [2, 2, 0], http402: [2, 1, 1], budget: [0, 0, 0] }[process.env.PI_FAKE_JEV || "ok"];
  const dir = path.join(process.env.PI_CODING_AGENT_DIR, "pi-typesafe");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ days: { "2026-10-01": { requestsStarted: ledger[0], requestsSucceeded: ledger[1], requestsFailed: ledger[2], inputTokens: 100, outputTokens: 10 } } }));
  if (process.env.PI_FAKE_JEV === "budget" && process.env.PI_WARDEN_TRACE_DIR) {
    fs.mkdirSync(process.env.PI_WARDEN_TRACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_WARDEN_TRACE_DIR, "s.jsonl"), JSON.stringify({ v: 1, kind: "judgments", judgments: "off:budget" }) + "\\n");
  }
}
`;

function batch(mode: string, extra: string[]) {
  const root = mkdtempSync(join(tmpdir(), "eval-jev-batch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), FAKE_PI);
  chmodSync(join(bin, "pi"), 0o755);
  const out = join(root, "report");
  const run = spawnSync("node", [SCRIPT, "--tasks", "t1-redact", "--model", "fake/model", "--out", out, ...extra], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PI_FAKE_JEV: mode },
  });
  const runs = existsSync(join(out, "runs.json")) ? JSON.parse(readFileSync(join(out, "runs.json"), "utf8")) : null;
  return { root, run, runs, report: existsSync(join(out, "report.md")) };
}

test("a fake HTTP 402 in a warden run stops the batch, and that run is not counted", () => {
  const b = batch("http402", ["--repeats", "2", "--concurrency", "1"]);
  try {
    assert.equal(b.run.status, 3, b.run.stdout + b.run.stderr);
    assert.match(b.run.stdout, /t1-redact warden r1 \.\.\. JEV ERROR, not counted: 1 Jev request\(s\) failed/);
    assert.match(b.run.stderr, /BATCH STOPPED/);
    const counted = b.runs.runs.map((r: { cell: string; repeat: number }) => `${r.cell} r${r.repeat}`);
    // Queue order is control r1,r2, warden-offline r1,r2, warden r1,r2: the failed warden r1 is not counted and warden r2 never starts.
    assert.deepEqual(counted, ["control r1", "control r2", "warden-offline r1", "warden-offline r2"]);
    assert.deepEqual(b.runs.stoppedBy, { task: "t1-redact", cell: "warden", repeat: 1, reason: "1 Jev request(s) failed" });
    assert.equal(b.report, true);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test("a fake spend-cap stop (judgments off for budget) stops the batch the same way", () => {
  const b = batch("budget", ["--repeats", "1", "--concurrency", "1"]);
  try {
    assert.equal(b.run.status, 3, b.run.stdout + b.run.stderr);
    assert.match(b.runs.stoppedBy.reason, /judgments went off \(off:budget\)/);
    assert.equal(b.runs.runs.some((r: { cell: string }) => r.cell === "warden"), false);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test("a warden run whose judgments all succeed is counted and the batch finishes", () => {
  const b = batch("ok", ["--repeats", "1", "--concurrency", "3"]);
  try {
    assert.equal(b.run.status, 0, b.run.stdout + b.run.stderr);
    assert.equal(b.runs.stoppedBy, undefined);
    assert.equal(b.runs.runs.length, 3);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});
