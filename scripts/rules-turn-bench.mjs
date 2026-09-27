// End-of-run rules bench: labelled turn cases and shell-change cases, each sent to the real judge exactly as the
// extension sends it. Billable unless --dry-run: one request per case. Build first (npm run build).
// Run: npm run eval:rules-turn -- --dry-run
//      npm run eval:rules-turn -- --split all --budget 60
import { createTypeSafe } from "pi-typesafe";
import { defaultConfig, evaluateTurnRules, evaluateTurnRun, parseRules, RuleStore, snapshotTree } from "../dist/index.js";
import { main } from "../eval/rules-bench/turn.mjs";

try {
  await main(process.argv.slice(2), {
    lib: { defaultConfig, evaluateTurnRules, evaluateTurnRun, parseRules, RuleStore, snapshotTree },
    createJudge: options => createTypeSafe(options),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
