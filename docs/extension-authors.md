# For extension authors

Every guard is a plain function you can call with any object that has pi-typesafe's `evaluate` method as the judge. The library has no dependency on Pi's runtime, so it is safe to use in tests.

```ts
import { evaluateAction, evaluateRules, RuleStore, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const judge = createTypeSafe();
const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge },   // omit judge for pattern checks only
);
verdict.level;      // "allow" | "warn" | "confirm"  (confirm = hold in steer mode)
verdict.reasons;    // ["destructive: git force push", "irreversible 0.91"]

const set = new RuleStore().load(process.cwd(), defaultConfig().rules);
const rules = await evaluateRules("write", { path: "src/a.ts", content: "console.log(1)" }, { cwd: process.cwd(), config: defaultConfig().rules, set, judge, timeoutMs: 5000 });
rules.findings;     // [{ id: "no-console-statements", name, violation: 0.97, body }]
```

What spans calls in a session lives in `ActionGuard` (hold, reply, retry approval, sibling batching) and `RulesGuard` (rule cache, sibling prejudging, repeat counts, sensitive-path notes).

Also exported: `matchPatterns`, `isReadOnlyCommand`, `stripDataText`, `describeAction`, `parseRules`, `matchGlob`, `redact`, `syntheticish`, `partitionSecrets`, `formatVerdict`, the question sets, the stuck detector, the runaway guard, the notifier, the done-check, the subagent triage (`newReports`, `triageReport`, `WakePolicy`), and the config helpers.

For the Jev client itself (`createTypeSafe`, `choice`, `score`, `noul`, the key store, the login prompt) see [pi-typesafe](https://github.com/DevMortimer/pi-typesafe#for-extension-authors).
