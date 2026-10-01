/**
 * The scheduling rules of the A/B batch (eval/preregistration.md), apart from the
 * runs themselves so tests can drive them with a stub:
 *
 *   - Blocks: the queue is repeat by repeat, task by task; one task x repeat is a
 *     block of its cells, in an order shuffled by a seeded generator, and a block's
 *     runs are dispatched one after another, so paired runs start minutes apart and
 *     share a price window and the machine's load.
 *   - Resume: a run already recorded (task, cell, repeat) is not repeated.
 *   - Infrastructure failures: a run whose agent model API failed is re-run after 1
 *     and then 5 minutes; if it still fails it is recorded with `infraError` and its
 *     whole block leaves the metrics. Five final failures in a row stop the batch.
 *   - The batch-wide Jev dollar cap: at the cap no new run starts.
 */

/** Seed of the registered batches; `--seed` overrides it. */
export const DEFAULT_SEED = 20261001;

/** Pause before the first and second re-run of an infrastructure failure, in milliseconds. */
export const RETRY_DELAYS_MS = [60_000, 300_000];

/** Final infrastructure failures in a row that stop the batch. */
export const INFRA_STREAK_LIMIT = 5;

/** The share of a model's blocks that may be excluded before its result is inconclusive. */
export const EXCLUSION_LIMIT = 0.1;

/** A small seeded generator (mulberry32): the same seed gives the same sequence on every machine. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: a block's own seed from the batch seed, its task, and its repeat. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The cells of one block in a seeded random order (Fisher-Yates); independent of every other block. */
export function shuffledCells(cells, seed, taskId, repeat) {
  const random = seededRandom(hash32(`${seed}:${repeat}:${taskId}`));
  const out = [...cells];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every block of the batch: repeat by repeat, within a repeat task by task. */
export function blockOrder({ taskIds, cells, repeats, seed }) {
  const blocks = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of taskIds) blocks.push({ task, repeat, cells: shuffledCells(cells, seed, task, repeat) });
  }
  return blocks;
}

/** The first `count` runs of the batch order, as blocks (the last block may be partial). */
export function firstRuns(blocks, count) {
  const out = [];
  let left = count;
  for (const block of blocks) {
    if (left <= 0) break;
    out.push({ ...block, cells: block.cells.slice(0, left) });
    left -= block.cells.length;
  }
  return out;
}

export const runKey = (run) => `${run.task}|${run.cell}|${run.repeat}`;

/**
 * Why a run failed for a reason outside the task, or null. The session log shows an
 * assistant message that stopped on an error (a rate limit, an overload, a 5xx), or
 * pi exited before any assistant message. A timeout is the agent not finishing and
 * stays a task outcome.
 */
export function infraReason(events, { timedOut = false, code = null, err = "" } = {}) {
  const assistants = events.filter((e) => e.message?.role === "assistant");
  const failed = assistants.find((e) => e.message.stopReason === "error");
  if (failed) return `agent model API error: ${String(failed.message.errorMessage ?? "stopReason error").replace(/\s+/g, " ").slice(0, 200)}`;
  if (assistants.length === 0 && !timedOut) {
    return `pi exited (code ${code}) before any assistant message${err.trim() ? `: ${err.trim().replace(/\s+/g, " ").slice(-160)}` : ""}`;
  }
  return null;
}

/** Sets `excludedBlock` on every run in a block that holds an infrastructure failure, and clears it elsewhere. */
export function markExclusions(runs) {
  const bad = new Set(runs.filter((r) => r.infraError).map((r) => `${r.task}|${r.repeat}`));
  for (const run of runs) {
    if (bad.has(`${run.task}|${run.repeat}`)) run.excludedBlock = true;
    else delete run.excludedBlock;
  }
  return runs;
}

/** The runs that count for the metrics: no infrastructure failure, and not in a block that has one. */
export const metricRuns = (runs) => markExclusions(runs).filter((r) => !r.excludedBlock);

/** Infrastructure counts per cell and the excluded share of the batch's blocks. */
export function infraCounts(runs, plannedBlocks) {
  markExclusions(runs);
  const perCell = {};
  for (const run of runs) {
    const c = (perCell[run.cell] ??= { runs: 0, infraErrors: 0, retriedOk: 0, excludedRuns: 0 });
    c.runs++;
    if (run.infraError) c.infraErrors++;
    else if ((run.attempts ?? 1) > 1) c.retriedOk++;
    if (run.excludedBlock) c.excludedRuns++;
  }
  const excluded = new Set(runs.filter((r) => r.infraError).map((r) => `${r.task}|${r.repeat}`)).size;
  const share = plannedBlocks ? excluded / plannedBlocks : 0;
  return { perCell, excludedBlocks: excluded, plannedBlocks, share, inconclusive: share > EXCLUSION_LIMIT };
}

/** The report section for infrastructure failures and block exclusions. */
export function infraSection(runs, plannedBlocks) {
  const counts = infraCounts(runs, plannedBlocks);
  const md = ["## Infrastructure failures and excluded blocks", ""];
  md.push("A run is an infrastructure failure when its session log shows an agent-model API error or pi exited before any assistant message; it is re-run twice (after 1 and 5 minutes), and one that still fails leaves its whole block out of the metrics above. A timeout is a task outcome.");
  md.push("");
  md.push("| Cell | Runs recorded | Infrastructure failures | Re-run and then fine | Runs excluded with their block |");
  md.push("| --- | --- | --- | --- | --- |");
  for (const [cell, c] of Object.entries(counts.perCell)) md.push(`| ${cell} | ${c.runs} | ${c.infraErrors} | ${c.retriedOk} | ${c.excludedRuns} |`);
  md.push("");
  md.push(`Excluded blocks: ${counts.excludedBlocks} of ${counts.plannedBlocks} (${(counts.share * 100).toFixed(1)}%). ${counts.inconclusive ? `More than ${EXCLUSION_LIMIT * 100}% of the blocks are excluded: this model's result is INCONCLUSIVE.` : `At most ${EXCLUSION_LIMIT * 100}% of the blocks are excluded.`}`);
  for (const run of runs.filter((r) => r.infraError)) md.push(`- ${run.task} ${run.cell} r${run.repeat}: ${run.infraError}`);
  md.push("");
  return md;
}

/**
 * Runs the blocks at `concurrency`. One worker takes one block and runs its cells one
 * after another. `execute(run, attempt)` does one attempt and returns
 * `{ record, infra, jevError, jevUsd, aborted }`: `record` the scored run (null for an
 * infrastructure failure), `infra` a reason or null, `jevError` a reason when a Jev
 * judgment failed, `jevUsd` the attempt's Jev dollars (an attempt that is re-run
 * still spent them), `aborted` when an interrupt cut the attempt short.
 *
 * `state` is the batch document: `{ runs, jevUsd, stops }`. It is changed in place and
 * `persist(state)` is called after every change, so a crash loses at most the runs in flight.
 * The returned `stop` is null, or `{ kind, ... }` with kind `jev-error`, `jev-cap`,
 * `infra` (5 final failures in a row), or `interrupt`. A caller that passes its own
 * `control` object can set `control.stop = { kind: "interrupt" }` to end the batch
 * (its `sleep` should wake early).
 */
export async function runBatch({
  blocks, state, execute, persist = () => {}, concurrency = 1, jevUsdCap = null, total = 0,
  retryDelaysMs = RETRY_DELAYS_MS, streakLimit = INFRA_STREAK_LIMIT, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
  control = { stop: null, streak: [] },
}) {
  const done = new Set(state.runs.map(runKey));
  const stopWith = (stop) => { control.stop ??= stop; };
  let cursor = 0;

  const attemptRun = async (run) => {
    const reasons = [];
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelaysMs[attempt - 1]);
        // A stop other than the Jev cap (which lets runs in flight finish) ends the retries too.
        if (control.stop && control.stop.kind !== "jev-cap") return;
      }
      const result = await execute(run, attempt);
      state.jevUsd = Math.round((state.jevUsd + (result.jevUsd ?? 0)) * 1e6) / 1e6;
      if (result.aborted) { stopWith({ kind: "interrupt" }); return; }
      if (control.stop?.kind === "interrupt") return;
      if (result.jevError) {
        stopWith({ kind: "jev-error", task: run.task, cell: run.cell, repeat: run.repeat, reason: result.jevError });
        persist(state);
        log(`[${state.runs.length}/${total}] ${run.task} ${run.cell} r${run.repeat} ... JEV ERROR, not counted: ${result.jevError}. The batch stops.`);
        return;
      }
      if (!result.infra) {
        control.streak = [];
        const record = { ...result.record, ...(attempt > 0 ? { attempts: attempt + 1, infraRetries: reasons } : {}) };
        state.runs.push(record);
        done.add(runKey(record));
        persist(state);
        log(`[${state.runs.length}/${total}] ${run.task} ${run.cell} r${run.repeat} ... ${result.summary ?? "done"}`);
        return;
      }
      reasons.push(result.infra);
      log(`${run.task} ${run.cell} r${run.repeat} ... infrastructure failure, attempt ${attempt + 1} of ${retryDelaysMs.length + 1}: ${result.infra}`);
    }
    // Still failing after the re-runs: a recorded infrastructure failure, unless the batch is already stopping on an outage.
    if (control.stop?.kind === "infra") return;
    const failed = { task: run.task, family: run.family, cell: run.cell, repeat: run.repeat, infraError: reasons.at(-1), attempts: reasons.length, infraRetries: reasons.slice(0, -1) };
    state.runs.push(failed);
    done.add(runKey(failed));
    control.streak.push(failed);
    if (control.streak.length >= streakLimit) {
      // The runs of the streak are the outage, not results: they leave runs.json and run again on resume.
      const dropped = control.streak.map((r) => ({ task: r.task, cell: r.cell, repeat: r.repeat, reason: r.infraError }));
      for (const r of control.streak) { state.runs.splice(state.runs.indexOf(r), 1); done.delete(runKey(r)); }
      stopWith({ kind: "infra", reason: `${streakLimit} infrastructure failures in a row`, failures: dropped });
    }
    persist(state);
  };

  const worker = async () => {
    while (!control.stop) {
      const block = blocks[cursor++];
      if (!block) return;
      for (const cell of block.cells) {
        if (control.stop) return;
        const run = { task: block.task, cell, repeat: block.repeat, family: block.family };
        if (done.has(runKey(run))) continue;
        if (jevUsdCap !== null && state.jevUsd >= jevUsdCap) {
          stopWith({ kind: "jev-cap", reason: `Jev spend $${state.jevUsd.toFixed(4)} reached the cap of $${jevUsdCap}` });
          return;
        }
        await attemptRun(run);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, blocks.length || 1)) }, worker));
  if (control.stop && control.stop.kind !== "interrupt") {
    state.stops = [...(state.stops ?? []), control.stop];
    persist(state);
  }
  return { stop: control.stop };
}
