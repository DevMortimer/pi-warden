// Rules bench: labelled cases for the rules guard, each sent to the real judge exactly as the extension sends it,
// with the fixture rules installed in a temp project. Billable unless --dry-run: one request per case.
// Build first (npm run build). See eval/rules-bench/README.md.
// Run: npm run eval:rules -- --dry-run
//      npm run eval:rules -- --split all --budget 200
import { createTypeSafe } from "pi-typesafe";
import { defaultConfig, describeTarget, evaluateRules, RuleStore, rulesFor, skipReason } from "../dist/index.js";
import { main } from "../eval/rules-bench/run.mjs";

try {
  await main(process.argv.slice(2), { lib: { defaultConfig, describeTarget, evaluateRules, RuleStore, rulesFor, skipReason }, createJudge: options => createTypeSafe(options) });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
