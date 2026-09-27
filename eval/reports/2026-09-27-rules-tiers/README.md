# Rules tiers: per-rule cutoffs, severity, and an opt-in soft tier

Date: 2026-09-27. Judge: `jev-1.13.0` for every request. pi-warden 0.70.2 plus the changes in this branch.

## Question

The rules guard raised a finding when a rule's `violation` probability reached `config.rules.threshold` (0.7) for every
rule. Three questions: does a rule do better with its own cutoff and its own severity, does an opt-in lower
"please double-check" tier earn its place, and can the question wording be changed so that new text breaking a rule
again in a file where it was already broken is caught while a violation left as it was is not?

Answer on the third: the wording change was tried, did not fix the known miss, and **was reverted**. Everything below is
the shipped question (main's wording). Case `r15-04` — a new `var` in a file that already declares one — remains a
**known miss**: 0.35 before, 0.39 after, both below the cutoff.

## Method

- 161 labelled cases (`eval/rules-bench/cases.json`): the previous 153, plus eight. Six add a new violation of a rule
  the file already breaks (four `tune`, two `holdout`); two touch only a line next to an old violation without adding
  one (one `tune`, one `holdout`). 94 `write` cases and 67 `edit` cases, 17 of them multi-edit. 17 fixture rules
  (`eval/rules-bench/rules.md`); three carry header lines: `severity: high` on *no hardcoded credentials*,
  `severity: low` on *markdown carries no placeholder text*, and `threshold: 0.9` on *boolean names start with
  is/has/should/can*.
- Split **tune** 107 / **holdout** 54, fixed in the case files. Tune was used while iterating; holdout was run once,
  in the final `--split all` run.
- Each case is sent with `evaluateRules(tool, input, options)` exactly as the extension calls it, one request per
  case, fixture rules installed as `pi-warden.md` in a temp copy of `eval/rules-bench/project/`. Path-scoped cases
  where the target rule is not asked (14 of 161) are counted apart and excluded from recall and false alarms.
- The scorer (`eval/rules-bench/score.mjs`) reads the fixture's `threshold:`/`severity:` headers and reports each rule
  at its own cutoff with the soft band under it, plus the soft tier per split.

## Requests

| Run | Cases | Requests | Cost | Backs the report |
|---|---|---|---|---|
| Before, tune (`--split tune`) | 107 | 107 | $0.023 | yes |
| After, all (`--split all --budget 175`) | 161 | 161 | $0.031 | yes |
| New-case spread probe (8 cases) | 8 | 8 | $0.002 | yes |
| Earlier wording runs, superseded by the revert | 268 | 268 | $0.058 | no |

**Final-report requests: 276. Mission total: 544**, 0 failed, 0 retried. The 268 superseded requests measured a
question-wording change that was reverted; their runs are not kept.

## Before and after at 0.7

Shared case sets (the 153 cases both runs contain), asked cases only:

| split | cases | asked | before recall | after recall | before false alarm | after false alarm |
|---|---|---|---|---|---|---|
| tune | 102 | 95 | 0.902 (46/51) | 0.902 (46/51) | 0.023 (1/44) | 0.023 (1/44) |
| holdout | 51 | 44 | 0.941 (16/17) | 0.941 (16/17) | 0.037 (1/27) | 0.037 (1/27) |
| all | 153 | 139 | 0.912 (62/68) | 0.912 (62/68) | 0.028 (2/71) | 0.028 (2/71) |

The full run on the 161-case set (147 asked: 74 violation, 73 clean) after the change:

| split | cases | asked | recall | false alarm | precision |
|---|---|---|---|---|---|
| tune | 107 | 100 | 0.855 (47/55) | 0.022 (1/45) | 0.979 |
| holdout | 54 | 47 | 0.895 (17/19) | 0.036 (1/28) | 0.944 |
| all | 161 | 147 | 0.865 (64/74) | 0.027 (2/73) | 0.970 |

Before, from the earlier report (`eval/reports/2026-09-26-rules-bench/`, 153 cases, 139 asked): tune 0.902 / 0.023,
holdout 0.941 / 0.037, all 0.912 / 0.028. The shared sets are unmoved; the lower figures on the full 161-case set come
from the eight new cases, several of which score at or below the cutoff (see "The known miss" below).

## With and without `softThreshold: 0.5`

The fixed two-tier view (flag at 0.7, double-check between 0.5 and 0.7), before and after:

| split | tier | before | after |
|---|---|---|---|
| tune | raise 0.7 | 46 caught, 1 false alarm (0.902 / 0.023) | 47 caught, 1 false alarm (0.855 / 0.022) |
| tune | 0.5–0.7 adds | +3 caught, +1 false alarm | +6 caught, +1 false alarm |
| tune | either | 0.961 / 0.045 | 0.964 / 0.044 |
| holdout | raise 0.7 | 16 caught, 1 false alarm (0.941 / 0.037) | 17 caught, 1 false alarm (0.895 / 0.036) |
| holdout | 0.5–0.7 adds | +0 caught, +1 false alarm | +1 caught, +1 false alarm |
| holdout | either | 0.941 / 0.074 | 0.947 / 0.071 |
| all | raise 0.7 | 62 caught, 2 false alarms (0.912 / 0.028) | 64 caught, 2 false alarms (0.865 / 0.027) |
| all | 0.5–0.7 adds | +3 caught, +2 false alarms | +7 caught, +2 false alarms |
| all | either | 0.956 / 0.056 | 0.959 / 0.055 |

The per-rule soft tier (each rule's own cutoff, soft from 0.5 to that cutoff) after the change: all adds 8 catches and
4 false alarms (0.851 at the cutoffs, 0.959 with the soft tier, false alarms 0.000 to 0.055); tune adds 7 and 2;
holdout adds 1 and 2. The tier stays off by default (`rules.softThreshold: 0`); the numbers here are what `0.5` buys.

## Per-rule cutoff: the boolean-name rule at `threshold: 0.9`

| rule | cases | asked | v | clean | recall@0.7 | FA@0.7 | cutoff | recall@cutoff | FA@cutoff | soft band |
|---|---|---|---|---|---|---|---|---|---|---|
| boolean-names-start-with-is-has-should-can | 9 | 9 | 4 | 5 | 1.000 | 0.400 | 0.9 | 0.750 | 0.000 | +1 violation, +2 clean |
| no-hardcoded-credentials (`severity: high`) | 9 | 9 | 4 | 5 | 1.000 | 0.000 | 0.7 | 1.000 | 0.000 | – |
| markdown-carries-no-placeholder-text (`severity: low`) | 9 | 7 | 4 | 3 | 1.000 | 0.000 | 0.7 | 1.000 | 0.000 | – |

Every false alarm at 0.7 in both runs comes from the boolean-name rule. Raising its cutoff to 0.9 removes all its false
alarms and costs one of its four catches (the loss is one tune case; holdout stays 1.000). This is the case for a
per-rule cutoff: the trade is a choice per rule, not a new global default.

## The known miss

The eight new cases in the "new violation in a file that already has one" pattern, shipped wording, two runs each
(before = the pre-change tune baseline, after = the `--split all` run, probe = the 8-case spread probe):

| case | rule | split | before | after | probe |
|---|---|---|---|---|---|
| r02-10 | no-explicit-any-type | tune | 0.92 | 0.69 | 0.74 |
| r04-10 | no-empty-catch-blocks | tune | 0.96 | 0.51 | 0.58 |
| r10-10 | never-clip-user-visible-text | tune | 0.93 | 0.91 | 0.91 |
| r15-10 | javascript-uses-const-or-let | tune | 0.81 | 0.62 | 0.81 |
| r10-11 | never-clip-user-visible-text (clean) | tune | 0.13 | 0.06 | 0.07 |
| r03-10 | todo-comments-need-a-reference | holdout | – | 0.94 | 0.94 |
| r13-10 | python-except-clauses-name-their-exception | holdout | – | 0.58 | 0.53 |
| r15-11 | javascript-uses-const-or-let (clean) | holdout | – | 0.04 | 0.04 |

The known miss itself, case `r15-04` (a new `var` in `src/logger.js`, which already declares one): **0.35 before,
0.39 after** — below the cutoff both times, still missed. The new pattern cases show the same defect, and they are
**unstable**: `r04-10` scores 0.51 to 0.96 across runs of the shipped wording. The judge sometimes reads the new
violation and sometimes attributes it to the old one in the same file. The wording change that was tried (a sentence
saying new text breaking the rule again is a violation) made these cases score high in both of its runs, but it did not
move `r15-04` and it cost a tune catch on the shared 153, so the decision was to revert it. **`r15-04` and the
pattern cases remain an open, measured gap under the shipped question.**

## Features measured offline

- A per-rule `threshold:` replaces `rules.threshold` for that rule; a per-rule `severity:` orders findings (high,
  normal, low, then score) in the verdict and the steer and does not change whether a rule fires.
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
  holdout it adds one false alarm and one catch at per-rule cutoffs. As an opt-in it is a per-project choice.
- **One rule owns every false alarm.** The boolean-name rule scores 0.400 false alarms at 0.7 and 0.000 at 0.9; a
  single `threshold: 0.9` header fixes it while keeping three of four catches. The soft band then asks about the one
  catch it gives up.
- **The pre-existing-violation miss is real and unfixed.** `r15-04` scores 0.35 to 0.39 across runs, and the new cases
  in the same shape swing between 0.51 and 0.96. One tried wording helped those cases but did not fix the target and
  was reverted. This gap needs a different approach than question wording.

## Limits

- One run per configuration. The shared 153 cases stay put run to run, but the new pattern cases swing by up to 0.45
  because the judge is torn between the old and the new violation; the probe was added to show that spread and is not
  part of the split metrics.
- The holdout set is small (19 violations, 28 asked clean in the end), so a per-rule holdout column is coarse.
- The pre-change numbers for `tune` come from a run with the new cases and the old build; the pre-change numbers for
  `holdout` and `all` come from the earlier 153-case report, re-scored. The new cases have no "before" on the holdout
  split.
