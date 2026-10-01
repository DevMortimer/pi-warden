#!/usr/bin/env node
/**
 * eval/power.mjs — the power calculation behind the pre-registration
 * (eval/preregistration.md), computed from the committed reports.
 *
 * Every run in the A/B batches is paired: the same task x repeat executes in each
 * cell of one model, so comparisons are paired differences within a model. This
 * script reads the committed runs.json files and prints, for each registered model,
 * the paired runs per cell each primary metric needs:
 *
 *   violations per run   detect a -50% rate (two rates compared inside the pair)
 *   success rate         non-inferiority, margin 5 percentage points
 *   dollars per run      detect a -20% mean, compared as a ratio within the model
 *                        (tokens are the dollars proxy: the earlier reports record
 *                        no dollars, and cost is linear in tokens)
 *
 * Models (eval/preregistration.md): A = `deepseek/deepseek-flash`, B =
 * `claude-bridge/claude-sonnet-5-5`. A's planning inputs come from its own earlier
 * runs (the two deepseek v3 batches). B has no earlier runs, so B's rows plan at
 * the pooled v3 baselines and at A's token variance. Per-run tokens, seconds, and
 * dollars per run type are measured in the smoke runs.
 *
 * Method, one-sided alpha 0.05 and power 0.80 (z_a = 1.645, z_b = 0.842) throughout:
 *   paired binary (violations, success):  n = (z_a + z_b)^2 (q - d^2) / d^2
 *     d = the difference in rates to detect, q = the expected rate of pairs whose
 *     two cells disagree. q is the observed discordance scaled by the planned sum
 *     of rates over the observed one (the pairs disagree exactly when one cell
 *     violates, the disjoint-events pattern the earlier reports show).
 *   paired mean (dollars):  n = ((z_a + z_b) s_d / delta)^2
 *     s_d = the standard deviation of within-pair token differences, delta = 0.20
 *     of the mean per-run tokens.
 *
 * Usage: node eval/power.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_PRICE, PRICES } from "./config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(ROOT, "eval", "reports");

const Z_A = 1.6448536269514722; // one-sided 0.05
const Z_B = 0.8416212335729143; // power 0.80

const runsOf = (name) => JSON.parse(readFileSync(join(REPORTS, name, "runs.json"), "utf8")).runs;

// ---- earlier reports: paired violation and success indicators ----------------

// The four v3 batches: 15 tasks x 2 cells x (3 + 2 + 3 + 2) repeats = 150 pairs.
const V3_A = ["2026-09-18T00-22-deepseek-v4.1-flash-15x2x3", "2026-09-18T00-42-deepseek-v4.1-flash-15x2x3"];
const V3_B_PLANNING = ["2026-09-18T00-23-glm-5.3-flash-15x2x2", "2026-09-18T00-42-glm-5.3-flash-15x2x2"];
// Token pairs and token means: the weak-suite batches (they ran model A).
const WEAK = ["2026-09-25-weak-model-bench", "2026-09-26-waste-nudges", "2026-09-26-waste-tip-5x"];
// Smoke runs: measured per-run tokens and seconds per run type. A: single-shot t1 in
// both A smoke reports, and the 5-turn arc t17 from the first. B: single-shot t1 (B has
// no multi-turn run; its multi-turn and decay rows scale its single-shot mean by A's ratios).
const SMOKE_A = ["2026-09-30-thesis-pipeline-smoke", "2026-10-01-thesis-v3-smoke-a"];
const SMOKE_B = ["2026-10-01-thesis-v3-smoke-b"];

const TRAP_FAMILIES = new Set(["rules", "project-only", "decay", "multi-turn"]);

function pairsOf(batches) {
  const out = [];
  for (const batch of batches) {
    const byKey = new Map();
    for (const run of runsOf(batch)) {
      const key = `${run.task}\u0000${run.repeat}`;
      if (!byKey.has(key)) byKey.set(key, {});
      byKey.get(key)[run.cell] = run;
    }
    for (const [key, cells] of byKey) {
      if (cells.control && cells.warden) out.push({ batch, key, control: cells.control, warden: cells.warden });
    }
  }
  return out;
}

const violates = (r) => ((r.violations ?? []).length > 0 ? 1 : 0);
const succeeds = (r) => (r.testsFail === 0 && r.buildOk !== false && !r.timedOut ? 1 : 0);

function binaryStats(subset) {
  let cViol = 0, wViol = 0, discord = 0, cOk = 0, wOk = 0, sDiscord = 0;
  for (const p of subset) {
    const a = violates(p.control), b = violates(p.warden);
    cViol += a; wViol += b;
    if (a !== b) discord++;
    const x = succeeds(p.control), y = succeeds(p.warden);
    cOk += x; wOk += y;
    if (x !== y) sDiscord++;
  }
  const n = subset.length;
  return {
    n, cViol, wViol, cOk, wOk, sDiscord,
    pViolC: cViol / n, pViolW: wViol / n, pOkC: cOk / n, qViol: discord / n, qOk: sDiscord / n,
  };
}

const pairsA = pairsOf(V3_A);
const pairsPooled = pairsOf([...V3_A, ...V3_B_PLANNING]);
const trapA = binaryStats(pairsA.filter((p) => TRAP_FAMILIES.has(p.control.family)));
const allA = binaryStats(pairsA);
const allPooled = binaryStats(pairsPooled);

/** Paired binary n: detect a difference d with expected discordance q. */
const nBinary = (d, q) => Math.ceil(((Z_A + Z_B) ** 2 * (q - d * d)) / (d * d));
/** Paired mean n: detect delta with within-pair sd sD. */
const nMean = (sD, delta) => Math.ceil(((Z_A + Z_B) * (sD / delta)) ** 2);

/**
 * Runs needed per cell to detect a -50% violation rate from planned baseline p1.
 * Expected discordance q is the observed discordance scaled by the planned sum of
 * rates over the observed one (disjoint-events pattern).
 */
function violationNeed(subset, p1) {
  const p2 = p1 / 2;
  const q = subset.qViol * ((p1 + p2) / (subset.pViolC + subset.pViolW || 1));
  return nBinary(p1 - p2, q);
}

// ---- earlier reports: token variance (the dollars proxy) --------------------

const tokenPairs = [];
let tokenSum = 0, tokenRuns = 0;
for (const batch of WEAK) {
  const byKey = new Map();
  for (const run of runsOf(batch)) {
    const tokens = run.waste?.totalTokens;
    if (typeof tokens !== "number") continue;
    tokenSum += tokens;
    tokenRuns++;
    const key = `${run.task}\u0000${run.repeat}`;
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[run.cell] = tokens;
  }
  for (const cells of byKey.values()) {
    if (Object.keys(cells).length === 2) tokenPairs.push(Object.values(cells)[0] - Object.values(cells)[1]);
  }
}
const meanTokens = tokenSum / tokenRuns;
const meanDiff = tokenPairs.reduce((s, x) => s + x, 0) / tokenPairs.length;
const sdDiff = Math.sqrt(tokenPairs.reduce((s, x) => s + (x - meanDiff) ** 2, 0) / (tokenPairs.length - 1));

// ---- the power rows, per model ---------------------------------------------

// The planned task mix: 14 trap-capable of 20 tasks, so a whole-batch baseline is
// the trap families' rate times that share (the no-trap families showed zero).
const PLANNED_TRAP_SHARE = 14 / 20;
const MARGIN = 0.05;

const needsA = {
  violAll: violationNeed(allA, trapA.pViolC * PLANNED_TRAP_SHARE),
  violTrap: violationNeed(trapA, trapA.pViolC),
  success: Math.ceil(((Z_A + Z_B) ** 2 * allA.qOk) / MARGIN ** 2),
  success2x: Math.ceil(((Z_A + Z_B) ** 2 * (2 * allA.qOk)) / MARGIN ** 2),
  dollars: nMean(sdDiff, 0.2 * meanTokens),
};
const needsB = {
  violAll: violationNeed(allPooled, binaryStats(pairsPooled.filter((p) => TRAP_FAMILIES.has(p.control.family))).pViolC * PLANNED_TRAP_SHARE),
  violTrap: violationNeed(binaryStats(pairsPooled.filter((p) => TRAP_FAMILIES.has(p.control.family))), binaryStats(pairsPooled.filter((p) => TRAP_FAMILIES.has(p.control.family))).pViolC),
  success: Math.ceil(((Z_A + Z_B) ** 2 * allPooled.qOk) / MARGIN ** 2),
  success2x: Math.ceil(((Z_A + Z_B) ** 2 * (2 * allPooled.qOk)) / MARGIN ** 2),
  dollars: nMean(sdDiff, 0.2 * meanTokens),
};

// ---- smoke measurements: per-run tokens and dollars per run type ------------

const PARTS = ["input", "output", "cacheRead", "cacheWrite"];
function smokeMeans(names, multiTurn) {
  const rows = names.flatMap(runsOf).filter((r) => Boolean(r.turns) === multiTurn && r.cost);
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return {
    runs: rows.length,
    tokens: mean((r) => r.cost.tokens.totalTokens),
    parts: Object.fromEntries(PARTS.map((k) => [k, mean((r) => r.cost.tokens[k])])),
    seconds: mean((r) => r.seconds),
    jevRequests: mean((r) => r.cost.jev.requests),
    jevInputTokens: mean((r) => r.cost.jev.inputTokens),
  };
}
const singleA = smokeMeans(SMOKE_A, false);
const multiA = smokeMeans(SMOKE_A, true); // 5-turn arc
const singleB = smokeMeans(SMOKE_B, false);
const DECAY_TURNS = 12, MULTI_TURNS = 5;
const multiRatio = multiA.tokens / singleA.tokens;
const decayRatio = multiRatio * (DECAY_TURNS / MULTI_TURNS);
const scale = (single, ratio) => ({
  tokens: single.tokens * ratio, seconds: single.seconds * ratio,
  parts: Object.fromEntries(PARTS.map((k) => [k, single.parts[k] * ratio])),
  jevRequests: single.jevRequests * ratio, jevInputTokens: single.jevInputTokens * ratio,
});
const multiB = scale(singleB, multiRatio);
const decayA = scale(singleA, decayRatio);
const decayB = scale(singleB, decayRatio);
// A's multi-turn seconds are measured, not scaled; the decay arc scales them linearly in turns.
multiB.seconds = multiA.seconds * (singleB.seconds / singleA.seconds);
decayA.seconds = multiA.seconds * (DECAY_TURNS / MULTI_TURNS);
decayB.seconds = multiB.seconds * (DECAY_TURNS / MULTI_TURNS);

/** Agent dollars for one run's mean tokens at a rate set (USD per 1M tokens). */
const usdAt = (parts, rates) => PARTS.reduce((s, k) => s + parts[k] * rates[k], 0) / 1e6;
const RATES_A = { peak: PRICES["deepseek/deepseek-flash"].peak, offPeak: PRICES["deepseek/deepseek-flash"]["off-peak"] };
const RATES_B = PRICES["claude-bridge/claude-sonnet-5-5"].flat;

// ---- proposed batch per model and its cost ---------------------------------

const TASKS = 20, CELLS = 3, SINGLE_TASKS = 15, MULTI_TASKS = 4; // t1-t15 single-shot, t17-t20 multi-turn, t16 the decay arc
const repeatsFor = (need) => Math.ceil(need / TASKS);

// A run's wall-clock is its pi seconds plus the runner's own setup and scoring (project copy,
// git, `npm test`, evidence copy), about 6 s in the 12-run parallel measurement.
const RUNNER_OVERHEAD_SECONDS = 6;

function batchCost(repeats, single, multi, decay, rates) {
  const counts = { single: SINGLE_TASKS * repeats * CELLS, multi: MULTI_TASKS * repeats * CELLS, decay: repeats * CELLS };
  const tokens = counts.single * single.tokens + counts.multi * multi.tokens + counts.decay * decay.tokens;
  const usds = Object.fromEntries(Object.entries(rates).map(([name, r]) => [name,
    counts.single * usdAt(single.parts, r) + counts.multi * usdAt(multi.parts, r) + counts.decay * usdAt(decay.parts, r)]));
  const runSeconds = counts.single * (single.seconds + RUNNER_OVERHEAD_SECONDS) + counts.multi * (multi.seconds + RUNNER_OVERHEAD_SECONDS) + counts.decay * (decay.seconds + RUNNER_OVERHEAD_SECONDS);
  const jev = counts.single * single.jevRequests + counts.multi * multi.jevRequests + counts.decay * decay.jevRequests;
  const jevIn = counts.single * single.jevInputTokens + counts.multi * multi.jevInputTokens + counts.decay * decay.jevInputTokens;
  // The per-run Jev means already average over the three cells (only the warden cell asks),
  // so these totals are the batch's Jev spend as-is.
  const jevUsd = jevIn * JEV_PRICE.inputUsdPerMTok / 1e6;
  return { runs: counts.single + counts.multi + counts.decay, tokens, usds, jevUsd, jev, jevIn, runSeconds };
}

const bindingA = Math.max(needsA.violAll, needsA.violTrap, needsA.success, needsA.success2x, needsA.dollars);
const bindingB = Math.max(needsB.violAll, needsB.violTrap, needsB.success, needsB.success2x, needsB.dollars);
const repeatsA = repeatsFor(bindingA);
const repeatsB = repeatsFor(bindingB);
const batchA = batchCost(repeatsA, singleA, multiA, decayA, RATES_A);
const batchB = batchCost(repeatsB, singleB, multiB, decayB, { flat: RATES_B });

// ---- output ----------------------------------------------------------------

const fmt = (x) => Math.round(x).toLocaleString("en-US");
const usd = (x) => `$${x < 1 ? x.toFixed(3) : x.toFixed(0)}`;
const hours = (seconds) => `${(seconds / 3600).toFixed(1)} h`;
const out = [];
out.push("# Power calculation (eval/power.mjs)");
out.push("");
out.push(`Sources: ${V3_A.length + V3_B_PLANNING.length} v3 batches, ${fmt(pairsPooled.length)} paired runs`);
out.push(`(${fmt(pairsA.length)} of them model A's own), ${WEAK.length} token batches (${fmt(tokenPairs.length)}`);
out.push("paired token differences), and the smoke runs (measured per-run tokens and seconds).");
out.push("One-sided alpha 0.05, power 0.80. Runs are paired within a model; dollars are");
out.push("compared as a ratio within a model (B's dollars are list-price equivalents).");
out.push("");
out.push(`Model A (\`deepseek/deepseek-flash\`), its own ${fmt(allA.n)} paired runs: violations`);
out.push(`${allA.cViol}/${fmt(allA.n)} control runs vs ${allA.wViol}/${fmt(allA.n)} warden runs; success`);
out.push(`${allA.cOk}/${fmt(allA.n)} vs ${allA.wOk}/${fmt(allA.n)}.`);
out.push(`Model B (\`claude-bridge/claude-sonnet-5-5\`) has no earlier runs; its rows plan at the`);
out.push(`pooled ${fmt(allPooled.n)} pairs (violations ${allPooled.cViol}/${fmt(allPooled.n)} vs ${allPooled.wViol}/${fmt(allPooled.n)}, success`);
out.push(`${allPooled.cOk}/${fmt(allPooled.n)} vs ${allPooled.wOk}/${fmt(allPooled.n)}).`);
out.push(`Token variance (dollars proxy): mean ${fmt(meanTokens)} tokens per run, sd of within-pair`);
out.push(`differences ${fmt(sdDiff)}; paired runs per cell for dollars below use it for both models.`);
out.push("");
out.push("| Model | Metric | Baseline | Paired runs per cell |");
out.push("| --- | --- | --- | --- |");
const trapPA = trapA.pViolC * PLANNED_TRAP_SHARE;
const trapPooled = binaryStats(pairsPooled.filter((p) => TRAP_FAMILIES.has(p.control.family))).pViolC * PLANNED_TRAP_SHARE;
out.push(`| A | violations per run, -50% (planned task mix) | ${(trapPA * 100).toFixed(2)}% -> ${(trapPA / 2 * 100).toFixed(2)}% (A's own runs) | ${fmt(needsA.violAll)} |`);
out.push(`| A | violations per run, -50% (trap-capable runs) | ${(trapA.pViolC * 100).toFixed(2)}% -> ${(trapA.pViolC / 2 * 100).toFixed(2)}% (A's own runs) | ${fmt(needsA.violTrap)} |`);
out.push(`| A | success rate, non-inferiority margin 5 points | ${(allA.pOkC * 100).toFixed(1)}% baseline, discordance ${(allA.qOk * 100).toFixed(1)}% | ${fmt(needsA.success)} |`);
out.push(`| A | success rate, same at 2x observed discordance | sensitivity | ${fmt(needsA.success2x)} |`);
out.push(`| A | dollars per run, -20% | sd of pair differences ${fmt(sdDiff)} vs mean ${fmt(meanTokens)} | ${fmt(needsA.dollars)} |`);
out.push(`| B | violations per run, -50% (planned task mix) | ${(trapPooled * 100).toFixed(2)}% -> ${(trapPooled / 2 * 100).toFixed(2)}% (pooled; B has no runs) | ${fmt(needsB.violAll)} |`);
out.push(`| B | violations per run, -50% (trap-capable runs) | ${(binaryStats(pairsPooled.filter((p) => TRAP_FAMILIES.has(p.control.family))).pViolC * 100).toFixed(2)}% -> ${(binaryStats(pairsPooled.filter((p) => TRAP_FAMILIES.has(p.control.family))).pViolC / 2 * 100).toFixed(2)}% (pooled) | ${fmt(needsB.violTrap)} |`);
out.push(`| B | success rate, non-inferiority margin 5 points | ${(allPooled.pOkC * 100).toFixed(1)}% baseline, discordance ${(allPooled.qOk * 100).toFixed(1)}% (pooled) | ${fmt(needsB.success)} |`);
out.push(`| B | success rate, same at 2x observed discordance | sensitivity | ${fmt(needsB.success2x)} |`);
out.push(`| B | dollars per run, -20% (list-price equivalent) | A's token variance (B has no paired runs) | ${fmt(needsB.dollars)} |`);
out.push("");
out.push("Proposed batch per model, sized at each model's binding metric:");
out.push("");
out.push("| Model | Batch | Runs | Paired runs per cell | Est. total tokens | Est. total dollars | of which Jev |");
out.push("| --- | --- | --- | --- | --- | --- | --- |");
out.push(`| A | ${TASKS} tasks x ${repeatsA} repeats x ${CELLS} cells | ${fmt(batchA.runs)} | ${fmt(TASKS * repeatsA)} | ${fmt(batchA.tokens)} | ${usd(batchA.usds.offPeak + batchA.jevUsd)} off-peak to ${usd(batchA.usds.peak + batchA.jevUsd)} peak (billed) | ${usd(batchA.jevUsd)} |`);
out.push(`| B | ${TASKS} tasks x ${repeatsB} repeats x ${CELLS} cells | ${fmt(batchB.runs)} | ${fmt(TASKS * repeatsB)} | ${fmt(batchB.tokens)} | ${usd(batchB.usds.flat + batchB.jevUsd)} (list-price equivalent) | ${usd(batchB.jevUsd)} |`);
out.push("");
out.push("Measured per-run means (smoke runs, over 3 cells). A dollars at the peak rate; off-peak is half:");
out.push("");
out.push("| Run type | A tokens | A dollars (peak) | A seconds | B tokens | B dollars (list-price equivalent) | B seconds |");
out.push("| --- | --- | --- | --- | --- | --- | --- |");
const row = (label, a, b, tagA, tagB) => out.push(`| ${label} | ${fmt(a.tokens)}${tagA} | ${usd(usdAt(a.parts, RATES_A.peak))}${tagA} | ${fmt(a.seconds)}${tagA} | ${fmt(b.tokens)}${tagB} | ${usd(usdAt(b.parts, RATES_B))}${tagB} | ${fmt(b.seconds)}${tagB} |`);
row("single-shot", singleA, singleB, "", "");
row("multi-turn (5 turns)", multiA, multiB, "", " (scaled)");
row("decay arc (12 turns)", decayA, decayB, " (scaled)", " (scaled)");
out.push("");
out.push("Scaled rows use A's measured multi-turn/single-shot token ratio");
out.push(`(${multiRatio.toFixed(2)}), linear in turns for the 12-turn arc. B has no multi-turn run:`);
out.push("its multi-turn and decay rows scale its single-shot mean the same way.");
out.push("");
out.push("Wall-clock of each batch (run seconds plus a 6 s runner overhead per run, divided by the concurrency):");
out.push("");
out.push("| Model | Concurrency | Wall-clock |");
out.push("| --- | --- | --- |");
for (const c of [6, 10, 12]) out.push(`| A | ${c} | ${hours(batchA.runSeconds / c)} |`);
for (const c of [6, 10]) out.push(`| B | ${c} | ${hours(batchB.runSeconds / c)} |`);
out.push("");
out.push("The violation rows rest on 6 events across 150 pairs (A: 1 event), so the");
out.push("discordance rate is uncertain; at 3x observed discordance the violation needs");
out.push("roughly triple and a null result on (b) is inconclusive, not refuted.");
console.log(out.join("\n"));
