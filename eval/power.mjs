#!/usr/bin/env node
/**
 * eval/power.mjs — the power calculation behind the pre-registration
 * (eval/preregistration.md), computed from the committed earlier reports.
 *
 * Every run in the A/B batches is paired: the same task x repeat executes in each
 * cell, so comparisons are paired differences. This script reads the committed
 * runs.json files and prints the paired runs per cell each primary metric needs:
 *
 *   violations per run   detect a -50% rate (two rates compared inside the pair)
 *   success rate         non-inferiority, margin 5 percentage points
 *   dollars per run      detect a -20% mean (tokens are the dollars proxy: earlier
 *                        reports record no dollars, and cost is linear in tokens)
 *
 * Method, one-sided alpha 0.05 and power 0.80 (z_a = 1.645, z_b = 0.842) throughout:
 *   paired binary (violations, success):  n = (z_a + z_b)^2 (q - d^2) / d^2
 *     d = the difference in rates to detect, q = the expected rate of pairs whose
 *     two cells disagree. q is scaled from the observed discordance by the planned
 *     rates, and the success row also shows 2x observed discordance as sensitivity.
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
const V3 = [
  "2026-09-18T00-22-deepseek-v4.1-flash-15x2x3",
  "2026-09-18T00-23-glm-5.3-flash-15x2x2",
  "2026-09-18T00-42-deepseek-v4.1-flash-15x2x3",
  "2026-09-18T00-42-glm-5.3-flash-15x2x2",
];
// Token pairs: the weak-suite batches record the waste axis (totalTokens per run).
const WEAK = [
  "2026-09-25-weak-model-bench",
  "2026-09-26-waste-nudges",
  "2026-09-26-waste-tip-5x",
];

const violates = (r) => ((r.violations ?? []).length > 0 ? 1 : 0);
const succeeds = (r) => (r.testsFail === 0 && r.buildOk !== false && !r.timedOut ? 1 : 0);
const TRAP_FAMILIES = new Set(["rules", "project-only", "decay", "multi-turn"]);

const pairs = [];
for (const batch of V3) {
  const byKey = new Map();
  for (const run of runsOf(batch)) {
    const key = `${run.task}\u0000${run.repeat}`;
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[run.cell] = run;
  }
  for (const [key, cells] of byKey) {
    if (!cells.control || !cells.warden) continue;
    pairs.push({ batch, key, control: cells.control, warden: cells.warden });
  }
}

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
    n, cViol, wViol, discord, cOk, wOk, sDiscord,
    pViolC: cViol / n, pViolW: wViol / n,
    pOkC: cOk / n, pOkW: wOk / n,
    qViol: discord / n, qOk: sDiscord / n,
  };
}

const all = binaryStats(pairs);
const trap = binaryStats(pairs.filter((p) => TRAP_FAMILIES.has(p.control.family)));

/** Paired binary n: detect a difference d with expected discordance q. */
const nBinary = (d, q) => Math.ceil(((Z_A + Z_B) ** 2 * (q - d * d)) / (d * d));
/** Paired mean n: detect delta with within-pair sd sD. */
const nMean = (sD, delta) => Math.ceil(((Z_A + Z_B) * (sD / delta)) ** 2);

/**
 * Runs needed per cell to detect a -50% violation rate from planned baseline p1.
 * Expected discordance q is the observed discordance scaled by the planned sum of
 * rates over the observed one (the pairs disagree exactly when one cell violates,
 * the disjoint-events pattern the earlier reports show).
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
    const [a, b] = Object.values(cells);
    if (Object.keys(cells).length === 2) tokenPairs.push(a - b);
  }
}
const meanTokens = tokenSum / tokenRuns;
const meanDiff = tokenPairs.reduce((s, x) => s + x, 0) / tokenPairs.length;
const sdDiff = Math.sqrt(tokenPairs.reduce((s, x) => s + (x - meanDiff) ** 2, 0) / (tokenPairs.length - 1));

// ---- the three power rows ---------------------------------------------------

// (b) violations per run. Planned baseline mixes the trap families' rate with the
// no-trap families' zero by the planned batch's task mix (14 trap of 20 tasks).
const PLANNED_TRAP_SHARE = 14 / 20;
const pPlanC = trap.pViolC * PLANNED_TRAP_SHARE;
const nViolAll = violationNeed(all, pPlanC);
const nViolTrap = violationNeed(trap, trap.pViolC);

// (a) success non-inferiority at the margin; d = 0 at the boundary.
const MARGIN = 0.05;
const nSuccess = Math.ceil(((Z_A + Z_B) ** 2 * all.qOk) / MARGIN ** 2);
const nSuccess2x = Math.ceil(((Z_A + Z_B) ** 2 * (2 * all.qOk)) / MARGIN ** 2);

// (c) dollars per run, -20% of the mean; tokens are the proxy.
const nDollars = nMean(sdDiff, 0.2 * meanTokens);

const fmt = (x) => x.toLocaleString("en-US");
const rows = [
  ["violations per run, -50% (planned task mix)", `planned ${(pPlanC * 100).toFixed(1)}% -> ${(pPlanC / 2 * 100).toFixed(1)}% (observed ${(all.pViolC * 100).toFixed(1)}%)`, fmt(nViolAll)],
  ["violations per run, -50% (trap-capable runs)", `${(trap.pViolC * 100).toFixed(1)}% -> ${(trap.pViolC / 2 * 100).toFixed(1)}% (observed warden ${(trap.pViolW * 100).toFixed(1)}%)`, fmt(nViolTrap)],
  ["success rate, non-inferiority margin 5 points", `${(all.pOkC * 100).toFixed(1)}% baseline, discordance ${(all.qOk * 100).toFixed(1)}%`, fmt(nSuccess)],
  ["success rate, same at 2x observed discordance", "sensitivity", fmt(nSuccess2x)],
  ["dollars per run, -20%", `token sd of pair differences ${fmt(Math.round(sdDiff))} vs mean ${fmt(Math.round(meanTokens))}`, fmt(nDollars)],
];

// ---- proposed batch and its cost --------------------------------------------

const TASKS = 20, REPEATS = 40, CELLS = 3;
const pairedPerCell = TASKS * REPEATS;
const totalRuns = pairedPerCell * CELLS;
const BINDING = Math.max(nViolAll, nViolTrap, nSuccess, nSuccess2x, nDollars);

// Per-run cost estimate: the weak-suite token mean at the price table, over a
// token split measured in Pi session logs (about 40% input, 1% output, 59% cache
// reads). Jev adds ~30 requests x ~4k input tokens to each warden run at $0.042/MTok.
const SPLIT = { input: 0.4, output: 0.01, cacheRead: 0.59, cacheWrite: 0 };
const JEV_PER_WARDEN_RUN = (30 * 4000 * 0.042) / 1e6;
const PRICES = {
  "deepseek/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
function estimateCost(prices) {
  const perMTok = SPLIT.input * prices.input + SPLIT.output * prices.output + SPLIT.cacheRead * prices.cacheRead + SPLIT.cacheWrite * prices.cacheWrite;
  const agent = (meanTokens / 1e6) * perMTok;
  // Cells: control and warden-offline carry no Jev; the warden cell does.
  const total = totalRuns * agent + pairedPerCell * JEV_PER_WARDEN_RUN;
  return { agent, total };
}

const out = [];
out.push("# Power calculation (eval/power.mjs)");
out.push("");
out.push(`Sources: ${V3.length} v3 batches, ${fmt(pairs.length)} paired runs (violations and`);
out.push(`success), ${WEAK.length} weak-suite batches, ${fmt(tokenPairs.length)} paired token`);
out.push("differences (the dollars proxy). One-sided alpha 0.05, power 0.80.");
out.push("");
out.push(`Observed: violations ${(all.cViol)}/${fmt(all.n)} control runs vs ${(all.wViol)}/${fmt(all.n)} warden runs;`);
out.push(`success ${(all.cOk)}/${fmt(all.n)} vs ${(all.wOk)}/${fmt(all.n)}; pair discordance`);
out.push(`violations ${(all.qViol * 100).toFixed(1)}%, success ${(all.qOk * 100).toFixed(1)}%; mean`);
out.push(`${fmt(Math.round(meanTokens))} tokens per run, sd of within-pair differences ${fmt(Math.round(sdDiff))}.`);
out.push("");
out.push("| Metric | Baseline | Paired runs per cell needed |");
out.push("| --- | --- | --- |");
for (const [metric, baseline, n] of rows) out.push(`| ${metric} | ${baseline} | ${n} |`);
out.push("");
out.push(`Binding need: ${fmt(BINDING)} paired runs per cell. Proposed batch: ${TASKS} tasks x`);
out.push(`${REPEATS} repeats x ${CELLS} cells = ${fmt(totalRuns)} runs (${fmt(pairedPerCell)} per cell),`);
out.push(`of which ${fmt(TASKS - 6)} trap-capable tasks x ${REPEATS} = ${fmt((TASKS - 6) * REPEATS)} trap runs per cell.`);
out.push("");
out.push("| Model | Estimated cost per run (agent) | Estimated batch total (agent + Jev) |");
out.push("| --- | --- | --- |");
for (const [model, prices] of Object.entries(PRICES)) {
  const { agent, total } = estimateCost(prices);
  out.push(`| ${model} | $${agent.toFixed(4)} | $${total.toFixed(2)} |`);
}
out.push("");
out.push("Cost estimates use the weak-suite token mean and an observed 40/1/59 token split;");
out.push("the smoke run refines them with measured dollars on the planned tasks.");
console.log(out.join("\n"));
