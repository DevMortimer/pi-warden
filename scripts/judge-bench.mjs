// Judge bench: labelled stuck and done cases, each sent in three request states (A today, B more raw, C structured)
// to the real TypeSafe judge. Billable unless --dry-run: cases x 3 arms x --repeats requests, capped by --budget.
// Build first (npm run build). See eval/judge-bench/README.md.
// Run: npm run eval:judge -- --dry-run
//      npm run eval:judge -- --repeats 3 --budget 900
import { ask, createTypeSafe } from "pi-typesafe";
import * as lib from "../dist/index.js";
import { main } from "../eval/judge-bench/run.mjs";

try {
  await main(process.argv.slice(2), { lib, ask, createJudge: options => createTypeSafe(options) });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
