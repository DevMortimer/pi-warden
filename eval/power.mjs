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
 * `claude-bridge/claude-opus-4-8`. A's planning inputs come from its own earlier
 * runs (the two deepseek v3 batches); B has no earlier runs, so B's rows plan at
 * the pooled v3 baselines and at A's token variance until B's own variance arrives
 * with the batch. Per-run tokens per run type are measured in the two smoke runs.
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
// Smoke runs: measured per-run tokens per run type. A: single-shot t1 + 5-turn arc t17.
// B: single-shot t1 (its multi-turn and decay runs are scaled from A's ratios).
const SMOKE_A = "2026-09-30-thesis-pipeline-smoke";
const SMOKE_B = "2026-09-30-thesis-pipeline-smoke-b";

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

function smokeMeans(name, multiTurn) {
  const rows = runsOf(name).filter((r) => Boolean(r.turns) === multiTurn && r.cost);
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return {
    runs: rows.length,
    tokens: mean((r) => r.cost.tokens.totalTokens),
    usd: rows.every((r) => typeof r.cost.usd === "number") ? mean((r) => r.cost.usd) : null,
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
const scale = (single, ratio) => ({ tokens: single.tokens * ratio, usd: single.usd === null ? null : single.usd * ratio, jevRequests: single.jevRequests * ratio, jevInputTokens: single.jevInputTokens * ratio });
const multiB = scale(singleB, multiRatio);
const decayA = scale(singleA, decayRatio);
const decayB = scale(singleB, decayRatio);

// ---- proposed batch per model and its cost ---------------------------------

const TASKS = 20, CELLS = 3, SINGLE_TASKS = 15, MULTI_TASKS = 4; // t1-t15 single-shot, t17-t20 multi-turn, t16 the decay arc
const repeatsFor = (need) => Math.ceil(need / TASKS);

function batchCost(repeats, single, multi, decay) {
  const counts = { single: SINGLE_TASKS * repeats * CELLS, multi: MULTI_TASKS * repeats * CELLS, decay: repeats * CELLS };
  const tokens = counts.single * single.tokens + counts.multi * multi.tokens + counts.decay * decay.tokens;
  const usd = single.usd === null ? null
    : counts.single * single.usd + counts.multi * multi.usd + counts.decay * decay.usd;
  const jev = counts.single * single.jevRequests + counts.multi * multi.jevRequests + counts.decay * decay.jevRequests;
  const jevIn = counts.single * single.jevInputTokens + counts.multi * multi.jevInputTokens + counts.decay * decay.jevInputTokens;
  // The per-run Jev means already average over the three cells (only the warden cell asks),
  // so these totals are the batch's Jev spend as-is.
  const jevUsd = jevIn * 0.042 / 1e6;
  return { runs: counts.single + counts.multi + counts.decay, tokens, usd, jevUsd, jev, jevIn };
}

const bindingA = Math.max(needsA.violAll, needsA.violTrap, needsA.success, needsA.success2x, needsA.dollars);
const bindingB = Math.max(needsB.violAll, needsB.violTrap, needsB.success, needsB.success2x, needsB.dollars);
const repeatsA = repeatsFor(bindingA);
const repeatsB = repeatsFor(bindingB);
const batchA = batchCost(repeatsA, singleA, multiA, decayA);
const batchB = batchCost(repeatsB, singleB, multiB, decayB);

// ---- output ----------------------------------------------------------------

const fmt = (x) => Math.round(x).toLocaleString("en-US");
const usd = (x) => (x === null ? "-" : `$${x < 1 ? x.toFixed(3) : x.toFixed(0)}`);
const out = [];
out.push("# Power calculation (eval/power.mjs)");
out.push("");
out.push(`Sources: ${V3_A.length + V3_B_PLANNING.length} v3 batches, ${fmt(pairsPooled.length)} paired runs`);
out.push(`(${fmt(pairsA.length)} of them model A's own), ${WEAK.length} token batches (${fmt(tokenPairs.length)}`);
out.push("paired token differences), and the two smoke runs (measured per-run tokens).");
out.push("One-sided alpha 0.05, power 0.80. Runs are paired within a model; dollars are");
out.push("compared as a ratio within a model (B's dollars are list-price equivalents).");
out.push("");
out.push(`Model A (\`deepseek/deepseek-flash\`), its own ${fmt(allA.n)} paired runs: violations`);
out.push(`${allA.cViol}/${fmt(allA.n)} control runs vs ${allA.wViol}/${fmt(allA.n)} warden runs; success`);
out.push(`${allA.cOk}/${fmt(allA.n)} vs ${allA.wOk}/${fmt(allA.n)}.`);
out.push(`Model B (\`claude-bridge/claude-opus-4-8\`) has no earlier runs; its rows plan at the`);
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
out.push(`| B | dollars per run, -20% (list-price equivalent) | A's token variance (B's arrives with the batch) | ${fmt(needsB.dollars)} |`);
out.push("");
out.push("Proposed batch per model, sized at each model's binding metric:");
out.push("");
out.push("| Model | Batch | Runs | Paired runs per cell | Est. total tokens | Est. total dollars | of which Jev |");
out.push("| --- | --- | --- | --- | --- | --- | --- |");
out.push(`| A | ${TASKS} tasks x ${repeatsA} repeats x ${CELLS} cells | ${fmt(batchA.runs)} | ${fmt(TASKS * repeatsA)} | ${fmt(batchA.tokens)} | ${usd(batchA.usd === null ? null : batchA.usd + batchA.jevUsd)} (billed) | ${usd(batchA.jevUsd)} |`);
out.push(`| B | ${TASKS} tasks x ${repeatsB} repeats x ${CELLS} cells | ${fmt(batchB.runs)} | ${fmt(TASKS * repeatsB)} | ${fmt(batchB.tokens)} | ${usd(batchB.usd === null ? null : batchB.usd + batchB.jevUsd)} (list-price equivalent) | ${usd(batchB.jevUsd)} |`);
out.push("");
out.push("Measured per-run totals (smoke runs, mean over 3 cells):");
out.push("");
out.push("| Run type | A tokens | A dollars (billed) | B tokens | B dollars (list-price equivalent) |");
out.push("| --- | --- | --- | --- | --- |");
out.push(`| single-shot | ${fmt(singleA.tokens)} | ${usd(singleA.usd)} | ${fmt(singleB.tokens)} | ${usd(singleB.usd)} |`);
out.push(`| multi-turn (5 turns) | ${fmt(multiA.tokens)} | ${usd(multiA.usd)} | ${fmt(multiB.tokens)} (scaled) | ${usd(multiB.usd)} (scaled) |`);
out.push(`| decay arc (12 turns) | ${fmt(decayA.tokens)} (scaled) | ${usd(decayA.usd)} (scaled) | ${fmt(decayB.tokens)} (scaled) | ${usd(decayB.usd)} (scaled) |`);
out.push("");
out.push("Scaled rows use A's measured multi-turn/single-shot token ratio");
out.push(`(${multiRatio.toFixed(2)}), linear in turns for the 12-turn arc. B's multi-turn and decay`);
out.push("rows scale its single-shot mean the same way; B's own ratios arrive with the batch.");
out.push("The violation rows rest on 6 events across 150 pairs (A: 1 event), so the");
out.push("discordance rate is uncertain; at 3x observed discordance the violation needs");
out.push("roughly triple and a null result on (b) is inconclusive, not refuted.");
console.log(out.join("\n"));
