import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptResult, BatchRun, BatchState } from "../eval/batch.mjs";
import { blockOrder, firstRuns, infraCounts, infraReason, markExclusions, metricRuns, runBatch, runKey, shuffledCells } from "../eval/batch.mjs";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "eval-ab.mjs");
const CELLS = ["control", "warden-offline", "warden"];
const TASKS = ["ta", "tb", "tc"];

type Run = BatchRun;
type Result = AttemptResult;
type State = BatchState;

const stubRecord = (run: Run): Run => ({ task: run.task, cell: run.cell, repeat: run.repeat });
const ok = async (run: Run): Promise<Result> => ({ record: stubRecord(run), infra: null, jevUsd: 0 });
const instant = async () => {};

function batchOf(repeats: number, seed = 7) {
  return blockOrder({ taskIds: TASKS, cells: CELLS, repeats, seed });
}

// ---- block order and the seed ----------------------------------------------------------------

test("the queue runs repeat by repeat and task by task; each task x repeat is one block of its three cells", () => {
  const blocks = batchOf(3);
  assert.equal(blocks.length, 9);
  assert.deepEqual(blocks.map((b) => `${b.task} r${b.repeat}`), [
    "ta r1", "tb r1", "tc r1", "ta r2", "tb r2", "tc r2", "ta r3", "tb r3", "tc r3",
  ]);
  for (const block of blocks) assert.deepEqual([...block.cells].sort(), [...CELLS].sort());
});

test("the cell order inside a block comes from the seed: the same seed repeats it, another seed changes it, and every cell leads sometimes", () => {
  assert.deepEqual(batchOf(40, 11), batchOf(40, 11));
  assert.notDeepEqual(batchOf(40, 11), batchOf(40, 12));
  // A block's order depends only on the seed, its task, and its repeat: more repeats do not move it.
  assert.deepEqual(shuffledCells(CELLS, 11, "tb", 2), batchOf(5, 11).find((b) => b.task === "tb" && b.repeat === 2)!.cells);
  const first: Record<string, number> = {};
  for (const block of batchOf(60, 11)) first[block.cells[0]!] = (first[block.cells[0]!] ?? 0) + 1;
  for (const cell of CELLS) assert.ok(first[cell]! >= 30 && first[cell]! <= 90, `${cell} leads ${first[cell]} of 180 blocks`);
});

test("a block's runs are dispatched one after another, in the block's order, while blocks overlap", async () => {
  const blocks = batchOf(2);
  const log: string[] = [];
  const open = new Set<string>();
  let blocksOpen = 0;
  let maxBlocksOpen = 0;
  const state: State = { runs: [], jevUsd: 0 };
  await runBatch({
    blocks, state, concurrency: 3,
    execute: async (run: Run) => {
      const block = `${run.task} r${run.repeat}`;
      assert.equal(open.has(block), false, `two runs of ${block} at once`);
      open.add(block);
      if (open.size > blocksOpen) blocksOpen = open.size;
      maxBlocksOpen = Math.max(maxBlocksOpen, open.size);
      log.push(`${block} ${run.cell}`);
      await new Promise((r) => setTimeout(r, 2));
      open.delete(block);
      return ok(run);
    },
  });
  assert.equal(state.runs.length, 18);
  for (const block of blocks) {
    const seen = log.filter((l) => l.startsWith(`${block.task} r${block.repeat} `)).map((l) => l.split(" ")[2]);
    assert.deepEqual(seen, block.cells);
  }
  assert.ok(maxBlocksOpen > 1, "blocks run side by side at concurrency 3");
});

test("--max-runs takes the first runs of the batch order, the last block possibly partial", () => {
  const cut = firstRuns(batchOf(1), 4);
  assert.deepEqual(cut.map((b) => b.cells.length), [3, 1]);
  assert.deepEqual(cut[1]!.cells, batchOf(1)[1]!.cells.slice(0, 1));
});

// ---- resume ----------------------------------------------------------------------------------

test("resume skips every recorded run and adds no duplicate and loses none", async () => {
  const blocks = batchOf(2);
  const control = { stop: null as null | { kind: string }, streak: [] };
  const state: State = { runs: [], jevUsd: 0 };
  const calls: string[] = [];
  // First pass: an interrupt after 7 runs. Runs in flight when it lands are not recorded.
  await runBatch({
    blocks, state, control, concurrency: 1,
    execute: async (run: Run) => {
      calls.push(runKey(run));
      if (calls.length === 8) { control.stop = { kind: "interrupt" }; return { aborted: true, jevUsd: 0 }; }
      return ok(run);
    },
  });
  assert.equal(state.runs.length, 7);
  // Second pass over the persisted document, as `--resume` reads it back from runs.json.
  const reloaded: State = JSON.parse(JSON.stringify(state));
  const second: string[] = [];
  await runBatch({ blocks, state: reloaded, concurrency: 2, execute: async (run: Run) => { second.push(runKey(run)); return ok(run); } });
  assert.equal(second.length, 11, "the interrupted run runs again, the 7 recorded ones do not");
  assert.equal(second.includes(calls[7]!), true);
  assert.equal(second.some((k) => state.runs.map(runKey).includes(k)), false);
  const keys = reloaded.runs.map(runKey);
  assert.equal(new Set(keys).size, keys.length, "no duplicate");
  const expected = blocks.flatMap((b) => b.cells.map((cell) => runKey({ task: b.task, cell, repeat: b.repeat })));
  assert.deepEqual([...keys].sort(), [...expected].sort(), "no run lost");
});

// ---- infrastructure failures -----------------------------------------------------------------

test("an infrastructure failure is re-run after 1 and then 5 minutes, then recorded, and its whole block leaves the metrics", async () => {
  const blocks = batchOf(2);
  const state: State = { runs: [], jevUsd: 0 };
  const delays: number[] = [];
  const attempts: Record<string, number> = {};
  await runBatch({
    blocks, state, concurrency: 1,
    sleep: async (ms: number) => { delays.push(ms); },
    execute: async (run: Run, attempt: number) => {
      attempts[runKey(run)] = attempt + 1;
      if (run.task === "tb" && run.repeat === 1 && run.cell === "warden") return { record: null, infra: "agent model API error: overloaded", jevUsd: 0.001 };
      return ok(run);
    },
  });
  assert.deepEqual(delays, [60_000, 300_000]);
  assert.equal(attempts["tb|warden|1"], 3);
  const failed = state.runs.find((r) => r.infraError)!;
  assert.deepEqual({ task: failed.task, cell: failed.cell, repeat: failed.repeat, attempts: failed.attempts }, { task: "tb", cell: "warden", repeat: 1, attempts: 3 });
  assert.match(String(failed.infraError), /overloaded/);
  assert.equal(state.jevUsd, 0.003, "every attempt's Jev dollars count against the cap");
  // The block of tb r1 (all three cells) is out of the metrics; nothing else is.
  const metrics = metricRuns(state.runs).map((r) => `${r.task} r${r.repeat}`);
  assert.equal(metrics.length, 18 - 3);
  assert.equal(metrics.includes("tb r1"), false);
  assert.equal(state.runs.filter((r) => r.excludedBlock).length, 3);
  const counts = infraCounts(state.runs, blocks.length);
  assert.deepEqual(counts.perCell.warden, { runs: 6, infraErrors: 1, retriedOk: 0, excludedRuns: 1 });
  assert.equal(counts.perCell.control!.excludedRuns, 1);
  assert.equal(counts.excludedBlocks, 1);
});

test("an infrastructure failure that clears on a re-run is a normal run, and the batch has no excluded block", async () => {
  const state: State = { runs: [], jevUsd: 0 };
  const delays: number[] = [];
  await runBatch({
    blocks: batchOf(1), state, sleep: async (ms: number) => { delays.push(ms); },
    execute: async (run: Run, attempt: number) =>
      run.task === "ta" && run.cell === "control" && attempt === 0 ? { record: null, infra: "rate limit", jevUsd: 0 } : ok(run),
  });
  assert.deepEqual(delays, [60_000]);
  assert.equal(state.runs.length, 9);
  const rerun = state.runs.find((r) => r.attempts)!;
  assert.deepEqual([rerun.task, rerun.cell, rerun.attempts, rerun.infraRetries], ["ta", "control", 2, ["rate limit"]]);
  assert.equal(state.runs.some((r) => r.infraError || r.excludedBlock), false);
  assert.equal(infraCounts(state.runs, 3).perCell.control!.retriedOk, 1);
});

test("a model with more than 10% of its blocks excluded is inconclusive", () => {
  const bad = (n: number): Run[] => Array.from({ length: n }, (_, i) => ({ task: `t${i}`, cell: "control", repeat: 1, infraError: "x" }));
  assert.equal(infraCounts(bad(10), 100).inconclusive, false);
  assert.equal(infraCounts(bad(11), 100).inconclusive, true);
});

test("five final infrastructure failures in a row stop the batch with those runs dropped; a success resets the count", async () => {
  // Runs 1-4 fail for good, run 5 works, runs 6-9 fail for good: never 5 in a row.
  const calm: State = { runs: [], jevUsd: 0 };
  const failing = [1, 1, 1, 1, 0, 1, 1, 1, 1];
  const index = new Map<string, number>();
  const byPattern = (fails: (i: number) => boolean) => async (run: Run, attempt: number): Promise<Result> => {
    if (attempt === 0) index.set(runKey(run), index.size);
    return fails(index.get(runKey(run))!) ? { record: null, infra: "5xx", jevUsd: 0 } : ok(run);
  };
  const calmResult = await runBatch({ blocks: batchOf(3), state: calm, sleep: instant, execute: byPattern((i) => Boolean(failing[i])) });
  assert.equal(calmResult.stop, null);
  assert.equal(calm.runs.length, 27);
  assert.equal(calm.runs.filter((r) => r.infraError).length, 8);

  // Every run from the 7th on fails for good: the batch stops at the fifth failure in a row.
  index.clear();
  const down: State = { runs: [], jevUsd: 0 };
  const { stop } = await runBatch({ blocks: batchOf(3), state: down, sleep: instant, execute: byPattern((i) => i >= 6) });
  assert.equal(stop?.kind, "infra");
  assert.equal(stop?.failures?.length, 5);
  assert.equal(down.runs.length, 6);
  assert.equal(down.runs.some((r) => r.infraError), false, "the outage's runs are not results: they run again on resume");
  assert.equal(down.stops?.length, 1);
});

test("an interrupt wakes a batch that waits to re-run, and records nothing for it", async () => {
  const control = { stop: null as null | { kind: string }, streak: [] };
  const state: State = { runs: [], jevUsd: 0 };
  const { stop } = await runBatch({
    blocks: batchOf(1), state, control,
    sleep: async () => { control.stop = { kind: "interrupt" }; },
    execute: async (run: Run) => (run.task === "ta" ? { record: null, infra: "5xx", jevUsd: 0 } : ok(run)),
  });
  assert.equal(stop?.kind, "interrupt");
  assert.equal(state.runs.some((r) => r.task === "ta"), false);
});

test("the session log tells an API error from a task failure: stopReason error, or pi gone before any assistant message; a timeout is neither", () => {
  const assistant = (stopReason: string, extra: object = {}) => ({ message: { role: "assistant", stopReason, ...extra } });
  assert.match(infraReason([assistant("stop"), assistant("error", { errorMessage: "529 overloaded_error" })], {}) ?? "", /agent model API error: 529 overloaded_error/);
  assert.equal(infraReason([assistant("stop")], {}), null);
  assert.equal(infraReason([assistant("toolUse"), assistant("length")], {}), null);
  assert.match(infraReason([{ message: { role: "user" } }], { code: 1, err: "connect ECONNRESET" }) ?? "", /pi exited \(code 1\) before any assistant message: connect ECONNRESET/);
  assert.equal(infraReason([], { timedOut: true, code: null }), null, "a timeout is a task outcome");
});

test("markExclusions keeps no stale flag when a block is clean", () => {
  const runs: Run[] = [{ task: "a", cell: "control", repeat: 1, excludedBlock: true }];
  assert.equal(markExclusions(runs)[0]!.excludedBlock, undefined);
});

// ---- the batch-wide Jev cap ------------------------------------------------------------------

test("at the Jev dollar cap no new run starts, runs in flight finish and count, and resume continues from the spend", async () => {
  const state: State = { runs: [], jevUsd: 0 };
  const run = (usd: number) => async (r: Run): Promise<Result> => ({ record: stubRecord(r), jevUsd: r.cell === "warden" ? usd : 0 });
  const { stop } = await runBatch({ blocks: batchOf(3), state, concurrency: 3, jevUsdCap: 0.05, execute: run(0.03) });
  assert.equal(stop?.kind, "jev-cap");
  // Three workers, each warden run $0.03: the cap is met only after the second finishes, so the third block's run in flight still counts.
  assert.ok(state.jevUsd >= 0.05 && state.jevUsd <= 0.09 + 1e-9, `spent ${state.jevUsd}`);
  const recordedWarden = state.runs.filter((r) => r.cell === "warden").length;
  assert.equal(Math.round(state.jevUsd / 0.03), recordedWarden, "the spend is the sum of the finished runs' dollars");
  assert.ok(state.runs.length < 27, "later runs never started");
  // Resume with the spend carried over and a higher cap finishes the rest without a duplicate.
  const before = state.runs.length;
  const resumed = await runBatch({ blocks: batchOf(3), state, concurrency: 3, jevUsdCap: 1, execute: run(0.03) });
  assert.equal(resumed.stop, null);
  assert.equal(state.runs.length, 27);
  assert.equal(new Set(state.runs.map(runKey)).size, 27);
  assert.ok(state.runs.length > before);
});

test("a cap already met by earlier spend starts nothing", async () => {
  const state: State = { runs: [], jevUsd: 8 };
  let started = 0;
  const { stop } = await runBatch({ blocks: batchOf(1), state, jevUsdCap: 8, execute: async (r: Run) => { started++; return ok(r); } });
  assert.equal(stop?.kind, "jev-cap");
  assert.equal(started, 0);
});

// ---- the whole script, with a fake pi --------------------------------------------------------

/**
 * A fake `pi` on PATH. It writes the session log a run leaves (an assistant message) and,
 * by mode: fails like an API error or like a crash before any message (`PI_FAKE_INFRA`, the
 * number of failing attempts in `PI_FAKE_INFRA_FAILS`, for the cell `PI_FAKE_INFRA_CELL`),
 * leaves a Jev ledger in a warden run, and interrupts its parent at its Nth start. The failing
 * attempts are counted per cell over the whole batch, across resumes.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const warden = args.some((a, i) => args[i - 1] === "-e" && a.endsWith(path.join("extensions", "index.js")));
const agentDir = process.env.PI_CODING_AGENT_DIR;
let cell = "control";
if (warden) cell = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-warden", "config.json"), "utf8")).typesafe ? "warden" : "warden-offline";
const state = process.env.PI_FAKE_STATE;
const bump = (name) => {
  const file = path.join(state, name);
  const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 1;
  fs.writeFileSync(file, String(n));
  return n;
};
const started = bump("started");
fs.appendFileSync(path.join(state, "starts.log"), cell + " " + Date.now() + "\\n");
const message = (stopReason, extra) => JSON.stringify({ type: "message", message: Object.assign({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, timestamp: 1790000000000 }, extra) }) + "\\n";
const target = process.env.PI_FAKE_INFRA && (!process.env.PI_FAKE_INFRA_CELL || process.env.PI_FAKE_INFRA_CELL === cell);
const failsLeft = target ? Number(process.env.PI_FAKE_INFRA_FAILS || 0) - (bump("fail-" + cell) - 1) : 0;
fs.mkdirSync(sessionDir, { recursive: true });
if (process.env.PI_FAKE_INTERRUPT_AT && started === Number(process.env.PI_FAKE_INTERRUPT_AT)) {
  process.kill(process.ppid, "SIGINT");
  setTimeout(() => {}, 30000);
} else if (target && failsLeft > 0) {
  if (process.env.PI_FAKE_INFRA === "error") fs.writeFileSync(path.join(sessionDir, "s.jsonl"), message("error", { errorMessage: "529 overloaded_error" }));
  else process.stderr.write("connect ECONNRESET\\n");
  process.exit(process.env.PI_FAKE_INFRA === "error" ? 0 : 1);
} else {
  fs.writeFileSync(path.join(sessionDir, "s.jsonl"), message("stop"));
  if (warden && cell === "warden") {
    const mode = process.env.PI_FAKE_JEV || "ok";
    const ledger = { ok: [2, 2, 0], inflight: [3, 2, 0], http402: [2, 1, 1], budget: [0, 0, 0] }[mode];
    const dir = path.join(agentDir, "pi-typesafe");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ days: { "2026-10-01": { requestsStarted: ledger[0], requestsSucceeded: ledger[1], requestsFailed: ledger[2], inputTokens: Number(process.env.PI_FAKE_JEV_TOKENS || 100), outputTokens: 10 } } }));
    if (process.env.PI_WARDEN_TRACE_DIR) {
      fs.mkdirSync(process.env.PI_WARDEN_TRACE_DIR, { recursive: true });
      const line = mode === "budget" ? { v: 1, kind: "judgments", judgments: "off:budget" } : { v: 1, kind: "session", judgments: "on" };
      fs.writeFileSync(path.join(process.env.PI_WARDEN_TRACE_DIR, "s.jsonl"), JSON.stringify(line) + "\\n");
    }
  }
}
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eval-batch-"));
  const bin = join(root, "bin");
  const stateDir = join(root, "fake-state");
  mkdirSync(bin);
  mkdirSync(stateDir);
  writeFileSync(join(bin, "pi"), FAKE_PI);
  chmodSync(join(bin, "pi"), 0o755);
  const out = join(root, "report");
  const env = (extra: Record<string, string>) => ({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PI_FAKE_STATE: stateDir, ...extra });
  const read = () => (existsSync(join(out, "runs.json")) ? JSON.parse(readFileSync(join(out, "runs.json"), "utf8")) : null);
  const starts = () => (existsSync(join(stateDir, "starts.log")) ? readFileSync(join(stateDir, "starts.log"), "utf8").trim().split("\n") : []);
  const go = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync("node", [SCRIPT, "--tasks", "t1-redact", "--model", "fake/model", "--retry-delays", "0,0", ...args], { encoding: "utf8", env: env(extra) });
  return { root, out, env, read, starts, go };
}

const keyOf = (r: { task: string; cell: string; repeat: number }) => `${r.cell} r${r.repeat}`;

test("a stopped batch resumes from its runs.json: the same seed and order, no duplicate, no lost run", async () => {
  const f = fixture();
  try {
    // Interrupted at the start of the 4th pi process: three runs are recorded, the fourth was cut short.
    const first = f.go(["--repeats", "2", "--concurrency", "1", "--seed", "5", "--out", f.out], { PI_FAKE_INTERRUPT_AT: "4" });
    assert.equal(first.status, 130, first.stdout + first.stderr);
    const partial = f.read();
    assert.equal(partial.seed, 5);
    assert.equal(partial.runs.length, 3);
    const order = blockOrder({ taskIds: ["t1-redact"], cells: CELLS, repeats: 2, seed: 5 });
    assert.deepEqual(partial.runs.map(keyOf).sort(), order[0]!.cells.map((c: string) => `${c} r1`).sort());

    const second = f.go(["--resume", f.out, "--concurrency", "1"]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /resuming: 3 recorded, 3 to run/);
    const final = f.read();
    assert.equal(final.seed, 5);
    assert.equal(final.runs.length, 6);
    assert.equal(new Set(final.runs.map(keyOf)).size, 6, "no duplicate");
    assert.deepEqual(final.runs.map(keyOf).sort(), order.flatMap((b: { repeats?: number; cells: string[]; repeat: number }) => b.cells.map((c) => `${c} r${b.repeat}`)).sort(), "no lost run");
    // The first three runs are untouched: the resume added only the rest.
    for (const run of partial.runs) assert.equal(final.runs.find((r: { task: string; cell: string; repeat: number }) => keyOf(r) === keyOf(run)).startedAt, run.startedAt);
    // Repeat 2's runs started in the shuffled order of its block.
    const starts = f.starts();
    assert.deepEqual(starts.slice(-3).map((l) => l.split(" ")[0]), order[1]!.cells);
    assert.match(readFileSync(join(f.out, "report.md"), "utf8"), /seed 5/);
    // A resume refuses a flag that would change the plan.
    const wrong = f.go(["--resume", f.out, "--repeats", "3"]);
    assert.equal(wrong.status, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a run that fails on an API error is re-run, then recorded as infraError and its block left out of the report's metrics", () => {
  const f = fixture();
  try {
    const run = f.go(["--repeats", "2", "--concurrency", "1", "--seed", "3", "--out", f.out], { PI_FAKE_INFRA: "error", PI_FAKE_INFRA_FAILS: "99", PI_FAKE_INFRA_CELL: "warden-offline" });
    // Every warden-offline run fails on every attempt: the 2 final failures are not a streak of 5.
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /infrastructure failure, attempt 1 of 3: agent model API error: 529 overloaded_error/);
    const doc = f.read();
    const infra = doc.runs.filter((r: { infraError?: string }) => r.infraError);
    assert.equal(infra.length, 2);
    assert.equal(infra[0].attempts, 3);
    assert.equal(doc.runs.filter((r: { excludedBlock?: boolean }) => r.excludedBlock).length, 6, "both blocks are excluded");
    const report = readFileSync(join(f.out, "report.md"), "utf8");
    assert.match(report, /Excluded blocks: 2 of 2 \(100\.0%\)/);
    assert.match(report, /INCONCLUSIVE/);
    assert.match(report, /\| warden-offline \| 2 \| 2 \| 0 \| 2 \|/);
    assert.match(run.stderr, /inconclusive/);
    // The metric tables carry no run of an excluded block.
    assert.doesNotMatch(report.split("## Infrastructure failures")[0]!, /\| t1-redact \| rules \|/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("pi exiting before any assistant message is an infrastructure failure too, and a re-run that works is counted", () => {
  const f = fixture();
  try {
    const run = f.go(["--repeats", "1", "--concurrency", "1", "--out", f.out], { PI_FAKE_INFRA: "crash", PI_FAKE_INFRA_FAILS: "1", PI_FAKE_INFRA_CELL: "control" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /pi exited \(code 1\) before any assistant message: connect ECONNRESET/);
    const doc = f.read();
    const rerun = doc.runs.find((r: { cell: string }) => r.cell === "control");
    assert.equal(rerun.attempts, 2);
    assert.equal(doc.runs.some((r: { infraError?: string }) => r.infraError), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("five infrastructure failures in a row stop the batch with exit code 4, and a resume runs them again", () => {
  const f = fixture();
  try {
    const run = f.go(["--repeats", "4", "--concurrency", "1", "--out", f.out], { PI_FAKE_INFRA: "crash", PI_FAKE_INFRA_FAILS: "15" });
    assert.equal(run.status, 4, run.stdout + run.stderr);
    assert.match(run.stderr, /5 infrastructure failures in a row/);
    const doc = f.read();
    assert.equal(doc.stoppedBy.kind, "infra");
    assert.equal(doc.stoppedBy.failures.length, 5);
    assert.equal(doc.runs.length, 0, "the outage's runs are not recorded");
    // The API is back: the resume runs the whole batch, its dropped runs included.
    const resumed = f.go(["--resume", f.out, "--concurrency", "2"], { PI_FAKE_INFRA: "crash", PI_FAKE_INFRA_FAILS: "0" });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    const final = f.read();
    assert.equal(final.runs.length, 12);
    assert.equal(new Set(final.runs.map(keyOf)).size, 12);
    assert.equal(final.stoppedBy, undefined);
    assert.equal(final.stops.length, 1, "the earlier stop stays in the history");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a Jev request in flight when the run's process exits, with no fallback in the trace, is recorded and stops nothing", () => {
  const f = fixture();
  try {
    const run = f.go(["--repeats", "1", "--concurrency", "1", "--out", f.out], { PI_FAKE_JEV: "inflight" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const doc = f.read();
    assert.equal(doc.stoppedBy, undefined);
    assert.equal(doc.runs.length, 3);
    const warden = doc.runs.find((r: { cell: string }) => r.cell === "warden");
    assert.equal(warden.abandonedJevRequests, 1);
    assert.equal(doc.runs.find((r: { cell: string }) => r.cell === "warden-offline").abandonedJevRequests, undefined, "the offline cell asks Jev nothing");
    assert.equal(doc.runs.find((r: { cell: string }) => r.cell === "control").abandonedJevRequests, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a fake HTTP 402 in a warden run stops the batch with exit code 3, and that run is not counted", () => {
  const f = fixture();
  try {
    const run = f.go(["--repeats", "2", "--concurrency", "1", "--seed", "4", "--out", f.out], { PI_FAKE_JEV: "http402" });
    assert.equal(run.status, 3, run.stdout + run.stderr);
    assert.match(run.stdout, /t1-redact warden r1 \.\.\. JEV ERROR, not counted: 1 Jev request\(s\) failed/);
    assert.match(run.stderr, /BATCH STOPPED/);
    const doc = f.read();
    assert.deepEqual(doc.stoppedBy, { kind: "jev-error", task: "t1-redact", cell: "warden", repeat: 1, reason: "1 Jev request(s) failed" });
    // Block r1 runs its cells in seeded order and the warden run is dropped; the batch starts nothing after it.
    const order = blockOrder({ taskIds: ["t1-redact"], cells: CELLS, repeats: 2, seed: 4 })[0]!.cells;
    assert.deepEqual(doc.runs.map(keyOf), order.slice(0, order.indexOf("warden")).map((c: string) => `${c} r1`));
    assert.equal(existsSync(join(f.out, "report.md")), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a fallback in the trace still stops the batch, even with a request in flight, and exits with code 3", () => {
  const f = fixture();
  try {
    const run = f.go(["--repeats", "1", "--concurrency", "1", "--out", f.out], { PI_FAKE_JEV: "budget" });
    assert.equal(run.status, 3, run.stdout + run.stderr);
    const doc = f.read();
    assert.equal(doc.stoppedBy.kind, "jev-error");
    assert.match(doc.stoppedBy.reason, /judgments went off \(off:budget\)/);
    assert.equal(doc.runs.some((r: { cell: string }) => r.cell === "warden"), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("--jev-usd-cap stops the batch at the cap with exit code 3, and a resume with a higher cap finishes it", () => {
  const f = fixture();
  try {
    // 1,000,000 Jev input tokens per warden run = $0.042: the second warden run reaches a $0.05 cap.
    const run = f.go(["--repeats", "4", "--concurrency", "1", "--seed", "9", "--jev-usd-cap", "0.05", "--out", f.out], { PI_FAKE_JEV_TOKENS: "1000000" });
    assert.equal(run.status, 3, run.stdout + run.stderr);
    assert.match(run.stderr, /Jev spend \$0\.0840 reached the cap of \$0\.05/);
    const doc = f.read();
    assert.equal(doc.stoppedBy.kind, "jev-cap");
    assert.equal(doc.jevUsd, 0.084);
    assert.equal(doc.runs.filter((r: { cell: string }) => r.cell === "warden").length, 2);
    // The batch stopped between runs: it ended inside a block or at a block edge, and started nothing after the cap.
    assert.ok(doc.runs.length < 12);
    const resumed = f.go(["--resume", f.out, "--concurrency", "1", "--jev-usd-cap", "1"], { PI_FAKE_JEV_TOKENS: "1000000" });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    const final = f.read();
    assert.equal(final.runs.length, 12);
    assert.equal(new Set(final.runs.map(keyOf)).size, 12);
    assert.equal(final.jevUsd, 0.168);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
