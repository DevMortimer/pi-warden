#!/usr/bin/env node
/**
 * eval-timing.mjs — timings of an A/B batch folder, never outcomes.
 *
 * For a batch run with the cheapestinference extension and PI_CHEAPEST_QUEUE_DEBUG=1, each
 * run's pi-stderr.log holds the extension's queue lines: `waiting` (the request asks for the
 * one generation slot), `acquired` (it holds the slot), `released` (the response is done).
 * Per call: queue wait = acquired - waiting; generation time = released - acquired. This
 * prints, per run, its wall seconds and the calls' waits and generation times, then per
 * run kind the longest and mean run, and runs per hour from the batch's wall time.
 *
 * Usage: node scripts/eval-timing.mjs BATCH_FOLDER [--wall SECONDS]
 *   --wall  the batch's wall-clock seconds (runs per hour = runs / wall); without it the
 *           span from the first run's start to the last run's end is used.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { wall: { type: "string" } } });
const dir = resolve(positionals[0] ?? "");
const doc = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8"));

const LINE = /^\[cheapest-inference queue (\d+) (\d+)\] (waiting|acquired|released)\b/;

/** The calls in one run's stderr: per pi process, waiting -> acquired -> released. */
export function queueCalls(stderr) {
  const open = new Map();
  const calls = [];
  for (const raw of stderr.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, pid, at, kind] = m;
    const t = Number(at);
    if (kind === "waiting") open.set(pid, { waitingAt: t });
    else if (kind === "acquired" && open.has(pid)) open.get(pid).acquiredAt = t;
    else if (kind === "released" && open.get(pid)?.acquiredAt !== undefined) {
      const c = open.get(pid);
      calls.push({ waitMs: c.acquiredAt - c.waitingAt, generationMs: t - c.acquiredAt });
      open.delete(pid);
    }
  }
  return calls;
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const max = (xs) => (xs.length ? Math.max(...xs) : 0);
const s1 = (ms) => (ms / 1000).toFixed(1);

const rows = [];
for (const run of doc.runs) {
  if (run.skipped) continue;
  const log = join(dir, "runs", `${run.task}-${run.cell}-r${run.repeat}`, "pi-stderr.log");
  const calls = existsSync(log) ? queueCalls(readFileSync(log, "utf8")) : [];
  const kind = run.turns ? "multi-turn" : "single-shot";
  rows.push({
    run, kind, calls,
    turnSeconds: (run.turns ?? []).map((t) => t.seconds),
    infra: run.infraError ? String(run.infraError).slice(0, 40) : null,
  });
}

console.log(`# Timings of ${doc.args?.model ?? "batch"} (concurrency from the log; no outcomes)\n`);
console.log("| Run | Kind | Wall s | Calls | Queue wait mean/max s | Generation mean/max s | Slot-held s |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.run.task.localeCompare(b.run.task) || a.run.cell.localeCompare(b.run.cell))) {
  const w = r.calls.map((c) => c.waitMs), g = r.calls.map((c) => c.generationMs);
  console.log(`| ${r.run.task} ${r.run.cell} r${r.run.repeat}${r.infra ? ` (infra: ${r.infra})` : ""} | ${r.kind} | ${r.run.seconds} | ${r.calls.length} | ${s1(mean(w))} / ${s1(max(w))} | ${s1(mean(g))} / ${s1(max(g))} | ${s1(g.reduce((s, x) => s + x, 0))} |`);
}

const starts = doc.runs.filter((r) => r.startedAt).map((r) => Date.parse(r.startedAt));
const ends = doc.runs.filter((r) => r.startedAt).map((r) => Date.parse(r.startedAt) + r.seconds * 1000);
const wall = values.wall ? Number(values.wall) : (Math.max(...ends) - Math.min(...starts)) / 1000;
console.log(`\nRuns: ${rows.length}; batch wall ${Math.round(wall)} s; runs per hour ${(rows.length / (wall / 3600)).toFixed(1)}.`);
for (const kind of ["single-shot", "multi-turn"]) {
  const k = rows.filter((r) => r.kind === kind);
  if (!k.length) continue;
  const secs = k.map((r) => r.run.seconds);
  const calls = k.flatMap((r) => r.calls);
  const line = `${kind}: ${k.length} runs, wall mean ${mean(secs).toFixed(0)} s, longest ${max(secs)} s; ${calls.length} calls, queue wait mean ${s1(mean(calls.map((c) => c.waitMs)))} s (max ${s1(max(calls.map((c) => c.waitMs)))}), generation mean ${s1(mean(calls.map((c) => c.generationMs)))} s (max ${s1(max(calls.map((c) => c.generationMs)))})`;
  console.log(line);
  if (kind === "multi-turn") {
    const turns = k.flatMap((r) => r.turnSeconds);
    console.log(`multi-turn turns: ${turns.length}, mean ${mean(turns).toFixed(0)} s, longest ${max(turns)} s; turns per run mean ${(turns.length / k.length).toFixed(1)}`);
  }
}
const allCalls = rows.flatMap((r) => r.calls);
console.log(`Slot-held total ${s1(allCalls.reduce((s, c) => s + c.generationMs, 0))} s of ${Math.round(wall)} s wall (${((allCalls.reduce((s, c) => s + c.generationMs, 0) / 1000 / wall) * 100).toFixed(0)}% busy).`);
