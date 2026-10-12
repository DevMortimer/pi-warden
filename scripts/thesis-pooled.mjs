#!/usr/bin/env node
/**
 * The pooled view of the A/B thesis claims, across models, post hoc.
 *
 * The registration applies each rule per model and never pools them. This script pools the two
 * models' paired runs to describe what the run can say about the thesis question, and decides
 * nothing: every number it prints is post hoc. The registered decisions stay in
 * `scripts/thesis-decide.mjs`.
 *
 *   node scripts/thesis-pooled.mjs <file>:<label> <file>:<label> ...
 *     reads each `runs.json` or metrics file with its label and prints the pooled comparisons,
 *     the hallucination proxy, and the token summary as Markdown.
 *   node scripts/thesis-pooled.mjs <file>:<label> ... --json
 *     prints the same as JSON.
 *
 * Example:
 *   node scripts/thesis-pooled.mjs eval/reports/2026-10-10-thesis-v4/model-a-metrics.json:A \
 *     eval/reports/2026-10-10-thesis-v4/model-b-metrics.json:B
 */

import { readFileSync } from "node:fs";
import { metricRuns } from "../eval/batch.mjs";
import { metricsRows, poolComparisons, runsFromMetrics, tokenSummary } from "../eval/decide.mjs";

const CELL_ORDER = ["control", "warden-offline", "warden"];
const COMPARISONS = [["warden", "control"], ["warden-offline", "control"], ["warden", "warden-offline"]];

function usage(message) {
  console.error(message);
  console.error("usage: node scripts/thesis-pooled.mjs <file>:<label> [<file>:<label> ...] [--json]");
  process.exit(2);
}

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const specs = argv.filter((arg) => arg !== "--json");
if (!specs.length) usage("at least one <file>:<label> is required");

const models = specs.map((spec) => {
  const at = spec.lastIndexOf(":");
  if (at <= 0 || at === spec.length - 1) usage(`${spec} is not <file>:<label>`);
  const file = spec.slice(0, at);
  const label = spec.slice(at + 1);
  const data = JSON.parse(readFileSync(file, "utf8"));
  const isMetrics = Array.isArray(data) && data.every((row) => row && typeof row.s === "number" && typeof row.v === "number" && "c" in row && !("outcome" in row));
  const runs = isMetrics ? runsFromMetrics(data) : metricRuns(Array.isArray(data) ? data : data.runs);
  if (!Array.isArray(runs)) usage(`${file} has no runs array`);
  return { label, runs };
});

const comparisons = COMPARISONS.map(([x, y]) => poolComparisons(models, x, y));
const tokens = tokenSummary(models);

// The hallucination proxy per cell, from the same rows `--metrics` writes. Only the combined
// flag is read, so a metrics file and its runs.json give the same counts.
const rows = models.flatMap((m) => metricsRows(m.runs));
const hallucination = {};
for (const cell of CELL_ORDER) {
  const cellRows = rows.filter((r) => r.cell === cell);
  hallucination[cell] = { runs: cellRows.length, runsWithHallucination: cellRows.filter((r) => r.h === 1).length };
}

const result = {
  models: models.map((m) => m.label),
  comparisons,
  hallucination,
  tokens,
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const n = (value) => (value === undefined || value === null || Number.isNaN(value) ? "n/a" : Number(value).toFixed(4));
const pts = (value) => (value === undefined || value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)} pts`);
const count = (value) => (value === null || value === undefined ? "n/a" : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ","));

const md = [];
md.push("# Pooled across models, post hoc: not registered, decides nothing");
md.push("");
md.push(`Models: ${result.models.join(", ")}. ${comparisons[0].pairs} pooled pairs per comparison.`);
md.push("");
md.push("## Pooled comparisons");
md.push("");
md.push("| Comparison | Runs with a violation (X / Y) | Rate ratio | Lower bound | p | Success estimate | Success lower | Success upper |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const c of comparisons) {
  md.push(`| ${c.x} vs ${c.y} | ${c.violations.x} / ${c.violations.y} | ${n(c.rateRatio)} | ${n(c.lower)} | ${n(c.p)} | ${pts(c.success.estimate)} | ${pts(c.success.lower)} | ${pts(c.success.upper)} |`);
}
md.push("");
md.push("Rate ratio and lower bound: warden over control (or over warden-offline). Success estimate and bounds are in points.");
md.push("");
md.push("## Hallucination proxy");
md.push("");
md.push("| Cell | Runs | Runs with a hallucination |");
md.push("| --- | --- | --- |");
for (const cell of CELL_ORDER) {
  md.push(`| ${cell} | ${hallucination[cell].runs} | ${hallucination[cell].runsWithHallucination} |`);
}
md.push("");
md.push("A run counts as a hallucination when a done claim has no passing check behind it or a claim the checks contradict.");
md.push("");
md.push("## Tokens");
md.push("");
md.push(`| Cell | Runs | Median | 90th percentile | Over ${count(tokens.threshold)} |`);
md.push("| --- | --- | --- | --- | --- |");
for (const cell of CELL_ORDER) {
  const c = tokens.cells[cell];
  md.push(`| ${cell} | ${c.runs} | ${count(c.median)} | ${count(c.p90)} | ${c.over} |`);
}
md.push("");
md.push("| Token pair | Pairs | Warden used fewer | Geometric-mean ratio (warden / control) |");
md.push("| --- | --- | --- | --- |");
md.push(`| Pooled | ${tokens.pairs.pooled.n} | ${tokens.pairs.pooled.fewer} | ${n(tokens.pairs.pooled.ratio)} |`);
for (const m of tokens.pairs.byModel) {
  md.push(`| ${m.label} | ${m.n} | ${m.fewer} | ${n(m.ratio)} |`);
}
console.log(md.join("\n"));
