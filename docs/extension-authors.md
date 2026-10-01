# For extension authors

Every guard is a plain function you can call with any object that has pi-typesafe's `evaluate` method as the judge. The library has no dependency on Pi's runtime, so it is safe to use in tests. Calls go through pi-typesafe's `ask`, so timeouts, aborts, and error shapes are pi-typesafe's contract.

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

## What semver covers

From 1.0, semver covers exactly these exports of the package root (`pi-warden`), together with the types of their parameters and results:

- Action guard: `evaluateAction`, `ActionGuard`, `describeAction`, `matchPatterns`, `isReadOnlyCommand`, `stripDataText`, `formatVerdict`, and the question sets `questions`, `intentQuestion`, `visibleQuestion`, `slopQuestions`, `approvalQuestion`, `securityQuestion`, `regretQuestions`, and the approval step for a held call: `settleApproval`, `askApproval`, `buildApprovalRequest`, `replyApprovalQuestion`, `describeAsked`, `APPROVAL_THRESHOLD`. `replyApprovalQuestion` holds both questions of the approval request, `approved` and `reply_points_at_action`; a call is released only when both reach `APPROVAL_THRESHOLD`, and `askApproval` returns both scores (`approved`, `pointsAtAction`; also `Judgment.pointsAtAction`). `ActionGuard` and `evaluateAction` with `retryAfterHold` both call `settleApproval`; the field `asked` of `Conversation` and of `ActionInput` is the agent's words the user's reply answers: the text of every assistant message of the turn before it, in order, last 3,000 characters.
- Rules: `evaluateRules`, `RuleStore`, `RulesGuard`, `parseRules`, `matchGlob`.
- Redaction: `redact`, `syntheticish`, `partitionSecrets`.
- Stuck detector: `AttemptWindow`, `makeAttempt`, `evaluateStuck`.
- Done-check: `emptyEvidence`, `classifyToolResult`, `recordOutcome`, `needsDoneCheck`, `evaluateDone`.
- Runaway guard: `RunawayMonitor`.
- Notifier: `detectNotifier`, `sendNotification`.
- Subagent triage: `newReports`, `triageReport`, `WakePolicy`.
- Config helpers: `defaultConfig`, `loadConfig`, `applyUserOverrides`, `applyProjectOverrides`, `userConfigPath`, `projectConfigPath`.

Every other export of `pi-warden`, and every export of `pi-warden/extension`, is internal: it may change or go away in any release.

For the Jev client itself (`createTypeSafe`, `ask`, `choice`, `score`, `noul`, `authState`, `describeAuth`, `getSpend`, the key store, the login prompt, `pi-typesafe/calibrate`) see [pi-typesafe](https://github.com/DevMortimer/pi-typesafe#for-extension-authors).
