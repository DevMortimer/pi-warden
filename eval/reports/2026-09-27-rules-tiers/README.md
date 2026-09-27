# Rules tiers: per-rule cutoffs, severity, and an opt-in soft tier

Date: 2026-09-27. Judge: `jev-1.13.0` for every request. pi-warden 0.70.2 plus the changes in this branch.

## Question

The rules guard raised a finding when a rule's `violation` probability reached `config.rules.threshold` (0.7) for every
rule. Three questions: does a rule do better with its own cutoff and its own severity, does an opt-in lower
"please double-check" tier earn its place, and can the question wording be changed so that new text breaking a rule
again in a file where it was already broken is caught while a violation left as it was is not?

## Method

- 161 labelled cases (`eval/rules-bench/cases.json`): the previous 153, plus eight. Six add a new violation of a rule
  the file already breaks (four `tune`, two `holdout`); two touch only a line next to an old violation without adding
  one (one `tune`, one `holdout`). 94 `write` cases and 67 `edit` cases, 17 of them multi-edit. 17 fixture rules
  (`eval/rules-bench/rules.md`); three now carry header lines: `severity: high` on *no hardcoded credentials*,
  `severity: low` on *markdown carries no placeholder text*, and `threshold: 0.9` on *boolean names start with
  is/has/should/can*.
- Split **tune** 107 / **holdout** 54, fixed in the case files. The tune set was used while iterating; the holdout set
  was run once, at the end.
- Each case is sent with `evaluateRules(tool, input, options)` exactly as the extension calls it, one request per
  case, fixture rules installed as `pi-warden.md` in a temp copy of `eval/rules-bench/project/`. Path-scoped cases
  where the target rule is not asked (14 of 161) are counted apart and excluded from recall and false alarms.
- The scorer (`eval/rules-bench/score.mjs`) now also reads the fixture's `threshold:`/`severity:` headers and reports
  each rule at its own cutoff with the soft band under it, plus the soft tier per split.

## Requests

| Run | Command | Cases | Requests | Cost |
|---|---|---|---|---|
| Before (tune) | `--split tune --budget 120` | 107 | 107 | $0.023 |
| Tune check | `--split tune --budget 120` | 107 | 107 | $0.023 |
| Holdout + after | `--split all --budget 170` | 161 | 161 | $0.035 |
| Before (holdout/all) | re-scored `eval/reports/2026-09-26-rules-bench/` | 153 | 0 | $0 |

**Requests spent: 375 of a 400 cap.** 0 failed, 0 retried, 0 rescored. The scorer is offline.

## Before and after at 0.7

Shared case sets (the 153 cases both runs contain), asked cases only:

| split | cases | asked | before recall | after recall | before false alarm | after false alarm |
|---|---|---|---|---|---|---|
| tune | 102 | 95 | 0.902 (46/51) | 0.882 (45/51) | 0.023 (1/44) | 0.023 (1/44) |
| holdout | 51 | 44 | 0.941 (16/17) | 0.941 (16/17) | 0.037 (1/27) | 0.037 (1/27) |
| all | 153 | 139 | 0.912 (62/68) | 0.897 (61/68) | 0.028 (2/71) | 0.028 (2/71) |

The full run on the 161-case set (147 asked: 74 violation, 73 clean) after the change:

| split | cases | asked | recall | false alarm | precision |
|---|---|---|---|---|---|
| tune | 107 | 100 | 0.891 (49/55) | 0.022 (1/45) | 0.980 |
| holdout | 54 | 47 | 0.947 (18/19) | 0.036 (1/28) | 0.947 |
| all | 161 | 147 | 0.905 (67/74) | 0.027 (2/73) | 0.971 |

Before, from the earlier report (`eval/reports/2026-09-26-rules-bench/`, 153 cases, 139 asked): tune 0.902 / 0.023,
holdout 0.941 / 0.037, all 0.912 / 0.028.

## With and without `softThreshold: 0.5`

The fixed two-tier view (flag at 0.7, double-check between 0.5 and 0.7), before and after:

| split | tier | before | after |
|---|---|---|---|
| tune | raise 0.7 | 46 caught, 1 false alarm (0.902 / 0.023) | 49 caught, 1 false alarm (0.891 / 0.022) |
| tune | 0.5–0.7 adds | +3 caught, +1 false alarm | +4 caught, +1 false alarm |
| tune | either | 0.961 / 0.045 | 0.964 / 0.044 |
| holdout | raise 0.7 | 16 caught, 1 false alarm (0.941 / 0.037) | 18 caught, 1 false alarm (0.947 / 0.036) |
| holdout | 0.5–0.7 adds | +0 caught, +1 false alarm | +0 caught, +1 false alarm |
| holdout | either | 0.941 / 0.074 | 0.947 / 0.071 |
| all | raise 0.7 | 62 caught, 2 false alarms (0.912 / 0.028) | 67 caught, 2 false alarms (0.905 / 0.027) |
| all | 0.5–0.7 adds | +3 caught, +2 false alarms | +4 caught, +2 false alarms |
| all | either | 0.956 / 0.056 | 0.959 / 0.055 |

The per-rule soft tier (each rule's own cutoff, soft from 0.5 to that cutoff) after the change: all adds 5 catches and
4 false alarms (0.5 to 0.9 is wider than 0.5 to 0.7 for the boolean rule), tune adds 5 and 2, holdout adds 0 and 2.
The tier stays off by default (`rules.softThreshold: 0`); the numbers here are what `0.5` would buy.

## Per-rule cutoff: the boolean-name rule at `threshold: 0.9`

| rule | cases | asked | v | clean | recall@0.7 | FA@0.7 | cutoff | recall@cutoff | FA@cutoff | soft band |
|---|---|---|---|---|---|---|---|---|---|---|
| boolean-names-start-with-is-has-should-can | 9 | 9 | 4 | 5 | 1.000 | 0.400 | 0.9 | 0.750 | 0.000 | +1 violation, +2 clean |
| no-hardcoded-credentials (`severity: high`) | 9 | 9 | 4 | 5 | 1.000 | 0.000 | 0.7 | 1.000 | 0.000 | – |
| markdown-carries-no-placeholder-text (`severity: low`) | 9 | 7 | 4 | 3 | 1.000 | 0.000 | 0.7 | 1.000 | 0.000 | – |

Every false alarm at 0.7 in both runs comes from the boolean-name rule. Raising its cutoff to 0.9 removes two of the
five false alarms and costs one of its four catches. This is the case for a per-rule cutoff: the trade is a choice per
rule, not a new global default.

## The question wording

Changed sentence in `FRAME` (`src/rules.ts`), and the matching sentence in the aggregate question:

- Before: "…and a violation already in `before` is not introduced by this edit."
- After: "…A violation that `before` already contained and the edit leaves unchanged is not introduced by this edit,
  but new text `after` adds that breaks the same rule again is a violation even though `before` broke the rule already."

Scores on the new "new violation in a file that already has one" cases (before = pre-change build, after = the final
`--split all` run):

| case | rule | split | before | after |
|---|---|---|---|---|
| r02-10 | no-explicit-any-type | tune | 0.92 | 0.88 |
| r04-10 | no-empty-catch-blocks | tune | 0.96 | 0.97 |
| r10-10 | never-clip-user-visible-text | tune | 0.93 | 0.95 |
| r15-10 | javascript-uses-const-or-let | tune | 0.81 | 0.71 |
| r03-10 | todo-comments-need-a-reference | holdout | (not run) | 0.93 |
| r13-10 | python-except-clauses-name-their-exception | holdout | (not run) | 0.79 |
| r10-11 | never-clip-user-visible-text (clean) | tune | 0.13 | 0.14 |
| r15-11 | javascript-uses-const-or-let (clean) | holdout | (not run) | 0.04 |

The known miss stayed a miss: case `r15-04` (a new `var` in `src/logger.js`, which already declares one) scored **0.35
before and 0.26 after**, both below the cutoff. The wording change did not fix it. Holdout recall and false-alarm rate
over the 51 shared cases are unchanged (0.941 and 0.037), which is the condition set for keeping the change; the tune
shared set lost one catch (0.902 to 0.882). Read as a judgment call: the change is holdout-neutral and its stated
target is not fixed.

## Features measured offline

- A per-rule `threshold:` replaces `rules.threshold` for that rule; a per-rule `severity:` orders findings (high,
  normal, low, then score) in the verdict and the steer, and does not change whether a rule fires.
- `rules.softThreshold` is off by default and adds one short sentence to the same steer; a soft-only verdict is that
  sentence alone. Soft findings never hold, count against the steer budget as any steer does, and are recorded in the
  rules log with `soft: true` and the rule's own cutoff.
- Header parsing, a bad header value, a repeated header, the severity order, the soft tier, and the `shape.ts` fallback
  are covered by offline tests (fake judge).

Sample steer with one high, one normal, and one soft finding:

```
pi-warden: the content just written to src/auth.ts violates project rules: "No hardcoded credentials" (0.94): Source
code must not contain hardcoded passwords, API keys, or tokens; these come from configuration; "Exported functions must
have explicit return types" (0.80): Every exported function must declare its return type explicitly. Fix it in your
next edit. Also check whether "Boolean names start with is/has/should/can" applies here (0.62).
```

## What this says

- **The soft tier is off by default and the numbers say why.** At 0.5 it adds catches and false alarms together; on
  holdout it adds one false alarm and no catch. As an opt-in it is a per-project choice.
- **One rule owns every false alarm.** The boolean-name rule scores 0.400 false alarms at 0.7 and 0.000 at 0.9; a
  single `threshold: 0.9` header fixes it while keeping three of four catches. The same band at 0.5 catches the fourth
  but flags two clean cases, which is what the soft tier is for.
- **The wording change is holdout-neutral and does not fix the known miss.** It is kept because the holdout set did not
  move down, but the miss deserves another look: the two-edit shape (`r15-04`) may be the cause more than the wording.

## Limits

- One run per configuration. Judge variance between runs is real: the tune set scored 0.909 in the tune-only run and
  0.891 in the `all` run on the same code, a swing of one case; the shared-set difference of one catch is inside that
  spread.
- The holdout set is small (19 violations, 28 asked clean in the end), so a per-rule holdout column is coarse.
- The pre-change numbers for `tune` come from a run with the new cases and the old build; the pre-change numbers for
  `holdout` and `all` come from the earlier 153-case report, re-scored. The eight new cases have no "before" outside
  the tune set.
