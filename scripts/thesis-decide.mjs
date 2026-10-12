#!/usr/bin/env node
/**
 * The decision table of one model's A/B thesis run (`eval/preregistration.md`, "Decision rules",
 * Corrections 7). Reads one model's `runs.json`, or a `--metrics` file it wrote earlier, and
 * prints the four rules and the model decision.
 *
 *   node scripts/thesis-decide.mjs <runs.json> --label A --blocks 120
 *     prints the decision table as Markdown.
 *   node scripts/thesis-decide.mjs <runs.json> --label A --blocks 120 --json
 *     prints the same as JSON.
 *   node scripts/thesis-decide.mjs <metrics.json> --label A --blocks 120
 *     reads a metrics file (the rows `--metrics` writes: task, family, repeat, cell, s, v, c)
 *     and prints the same table; the first line says the input was a metrics file.
 *   node scripts/thesis-decide.mjs <runs.json> --label A --blocks 120 --metrics FILE
 *     writes the per-run values of the analysis set (task, family, repeat, cell, s, v, c)
 *     to FILE and prints no table.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { metricsRows, runsFromMetrics, thesisDecide } from "../eval/decide.mjs";

function usage(message) {
  console.error(message);
  console.error("usage: node scripts/thesis-decide.mjs <runs.json> --label A|B --blocks N [--json] [--metrics FILE]");
  process.exit(2);
}

function parseArgs(argv) {
  const cli = { positionals: [], json: false, metrics: null, label: null, blocks: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") cli.json = true;
    else if (arg === "--metrics") cli.metrics = argv[++i];
    else if (arg === "--label") cli.label = argv[++i];
    else if (arg === "--blocks") cli.blocks = Number(argv[++i]);
    else cli.positionals.push(arg);
  }
  return cli;
}

const cli = parseArgs(process.argv.slice(2));
const runsPath = cli.positionals[0];
const label = cli.label ?? cli.positionals[1];
const blocks = cli.blocks ?? (cli.positionals[2] !== undefined ? Number(cli.positionals[2]) : null);
if (!runsPath) usage("a runs.json is required");
if (label !== "A" && label !== "B") usage("--label must be A or B");
if (!Number.isInteger(blocks) || blocks <= 0) usage("--blocks must be a positive integer");

const data = JSON.parse(readFileSync(runsPath, "utf8"));
const isMetrics = Array.isArray(data) && data.every((row) => row && typeof row.s === "number" && typeof row.v === "number" && "c" in row && !("outcome" in row));
const runs = isMetrics ? runsFromMetrics(data) : Array.isArray(data) ? data : data.runs;
if (!Array.isArray(runs)) usage(`${runsPath} has no runs array`);

const thesis = thesisDecide({ runs, plannedBlocks: blocks });

if (cli.metrics) {
  writeFileSync(cli.metrics, `${JSON.stringify(metricsRows(runs), null, 2)}\n`);
  process.exit(0);
}

const n = (value, digits = 4) => (value === undefined || value === null || Number.isNaN(value) ? "n/a" : Number(value).toFixed(digits));
const point = (value) => (value === undefined || value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)} pts`);

if (cli.json) {
  console.log(JSON.stringify({ label, blocks, ...thesis }, null, 2));
  process.exit(0);
}

const { a, b, c, d } = thesis.rules;
const md = [];
md.push(`# Thesis decision, model ${label}${isMetrics ? " (from a metrics file: the analysis set only; excluded blocks are not in it)" : ""}`);
md.push("");
md.push(`Planned blocks: ${thesis.plannedBlocks}; excluded blocks after the re-run pass: ${thesis.excludedBlocks} (${(thesis.share * 100).toFixed(1)}%). Pairs: warden vs control ${thesis.pairs.control}; warden vs warden-offline ${thesis.pairs.offline}.`);
md.push("");
md.push("| Rule | Comparison | Estimate | Lower | Upper | p | Decision |");
md.push("| --- | --- | --- | --- | --- | --- | --- |");
md.push(`| (a) success difference | warden - control | ${point(a.estimate)} | ${n(a.lower)} | ${n(a.upper)} | | ${a.decision} |`);
md.push(`| (b) violation rate ratio | warden / control | ${n(b.rateRatio)} | ${n(b.lower)} | | ${n(b.p, 4)} | ${b.decision} |`);
md.push(`| (c) cost ratio | warden / control | ${n(c.estimate)} | ${n(c.lower)} | ${n(c.upper)} | | ${c.decision} |`);
md.push(`| (d) success branch | warden - warden-offline | ${point(d.success.estimate)} | ${n(d.success.lower)} | ${n(d.success.upper)} | | |`);
md.push(`| (d) violation branch | warden / warden-offline | ${n(d.violation.rateRatio)} | ${n(d.violation.lower)} | | ${n(d.violation.p, 4)} | |`);
md.push(`| (d) Jev increment | warden vs warden-offline | | | | | ${d.decision} |`);
md.push("");
md.push(`Model: ${thesis.model}.`);
md.push("");
md.push(`(b) pairs: n11 ${b.n11}, n10 ${b.n10}, n01 ${b.n01}, D ${b.D}. (c) pairs used ${c.pairs}, left out for a missing dollar value ${c.leftOut}.`);
md.push(`Secondary (b) on the trap-capable tasks (${thesis.secondary.pairs} pairs): ${thesis.secondary.bTrap.decision}.`);
md.push(`Sensitivity, not deciding: Wald (a) [${n(thesis.sensitivity.waldA.lower)}, ${n(thesis.sensitivity.waldA.upper)}], Wald (d) [${n(thesis.sensitivity.waldD.lower)}, ${n(thesis.sensitivity.waldD.upper)}], delta-method log ratio (c) [${n(thesis.sensitivity.deltaC.lower)}, ${n(thesis.sensitivity.deltaC.upper)}].`);
console.log(md.join("\n"));
