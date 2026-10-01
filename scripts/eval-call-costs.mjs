#!/usr/bin/env node
/**
 * eval-call-costs.mjs — every model call of a report folder, priced by its own
 * timestamp (eval/cost.mjs), as Markdown: the run, the call's UTC time, its price
 * window, its four token counts, and its dollars. A time-priced model's calls can be
 * compared with the provider's usage page line by line; a flat-priced model's runs
 * show their tokens and list-price dollars.
 *
 * Usage: node scripts/eval-call-costs.mjs eval/reports/<folder> [--write]
 *   --write saves the table as <folder>/calls.md instead of printing it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callCosts } from "../eval/cost.mjs";
import { PRICES } from "../eval/config.mjs";
import { readSessionEvents } from "../eval/verify.mjs";

const dir = resolve(process.argv[2] ?? ".");
const { runs, args } = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8"));
const model = args.model;
const usd = (x) => (x === null ? "-" : `$${x.toFixed(6)}`);

const out = [`# Per-call cost: \`${model}\``, ""];
out.push(`Each call is priced at the rate of its own UTC timestamp (\`eval/config.mjs\`; sources: ${PRICES[model]?.source ?? "none"}).`, "");
out.push("| Run | Call time (UTC) | Window | Input | Output | Cache read | Cache write | Dollars |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
const totals = [];
for (const run of runs.filter((r) => r.cost)) {
  const sessions = join(dir, "runs", `${run.task}-${run.cell}-r${run.repeat}`, "sessions");
  if (!existsSync(sessions)) continue;
  const calls = callCosts(readSessionEvents(sessions), model);
  for (const c of calls) out.push(`| ${run.task} ${run.cell} r${run.repeat} | ${c.atIso} | ${c.window} | ${c.input} | ${c.output} | ${c.cacheRead} | ${c.cacheWrite} | ${usd(c.usd)} |`);
  const sum = (f) => calls.reduce((s, c) => s + f(c), 0);
  totals.push(`| ${run.task} ${run.cell} r${run.repeat} | ${calls.length} | ${sum((c) => c.input)} | ${sum((c) => c.output)} | ${sum((c) => c.cacheRead)} | ${sum((c) => c.cacheWrite)} | ${sum((c) => c.totalTokens)} | ${usd(sum((c) => c.usd))} | ${run.cost.jev.requests} | ${run.cost.jev.inputTokens} |`);
}
out.push("", "Per run:", "", "| Run | Calls | Input | Output | Cache read | Cache write | Total tokens | Agent dollars | Jev requests | Jev input tokens |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...totals);
if (process.argv.includes("--write")) writeFileSync(join(dir, "calls.md"), out.join("\n") + "\n");
else console.log(out.join("\n"));
