# Rules bench: catch rate and false alarms at several cutoffs

Date: 2026-09-26. Judge: `jev-1.13.0` for all 153 answers. pi-warden 0.68.0; `src/` unchanged.

## Question

The rules guard raises a finding when a rule's `violation` probability reaches `config.rules.threshold` (0.7). Where
does that cutoff sit between violations the guard misses and false alarms it raises, per rule, and what would the
planned lower "please double-check" tier (0.5 to 0.7) add in recall and in false alarms? The numbers are the input for
that change; nothing here tunes the guard.

## Method

- 153 labelled cases (`eval/rules-bench/cases.json`): nine per rule, four clear violations, three compliant near-misses
  and two cases where the rule does not apply. 94 `write` cases and 59 `edit` cases, 17 of them a multi-edit. 17 fixture
  rules (`eval/rules-bench/rules.md`): the nine from `scripts/rules-cases.mjs` plus eight more, three of them harder
  rules taken from the project's own documentation style (*errors never reach the user raw*, *no new dependency without
  need*, *no partial implementations*). Seven rules carry a `paths:` line.
- Each case is sent with `evaluateRules(tool, input, options)` exactly as the extension calls it, one request per case,
  with the fixture rules installed as `pi-warden.md` in a temp copy of `eval/rules-bench/project/` (the same approach
  `scripts/rules-cases.mjs` uses). Path scoping runs first, so 14 cases where the target rule is not asked at all (a
  scoped rule on another language or file type) are counted apart and excluded from recall and false alarms. The answer
  for the target rule is scored; the other answers are saved but not scored.
- The split is fixed in the case files: **tune** 102 cases, **holdout** 51, stratified by rule and by label. No
  threshold or wording change may be tuned against holdout.
- Scored with `eval/rules-bench/score.mjs`: recall, false-alarm rate, precision and counts at cutoffs 0.3, 0.4, 0.5,
  0.6, 0.7, 0.8 and 0.9; AUC per rule; the rules whose clean cases sit in the 0.3 to 0.5 band; and the two-tier view.

## Run

| Item | Value |
|---|---|
| Command | `npm run eval:rules -- --split all --budget 200 --concurrency 4` |
| Dry run | `npm run eval:rules -- --dry-run`: 153 cases, 153 requests planned, 0 sent |
| Wall time | 11.4 s (runner), concurrency 4 |
| Requests | 153 sent of a 200 budget, 0 failed, 0 retried; judge `jev-1.13.0` |
| Usage (`getUsage()`) | 153 started, 153 succeeded, 706,163 input tokens, 112,716 output tokens, est. $0.0297 |
| Latency | 280 ms p50, 432 ms p95, 543 ms max per request |
| Files | `results.json` (every raw `RuleScore`, the case metadata, the scored tables), `requests.jsonl` (case, split, tool, path, latency, outcome; no state content) |
| Re-scoring | `npm run eval:rules -- --rescore eval/reports/2026-09-26-rules-bench` spends nothing |

## Tables

all: 153 cases (68 violation, 85 clean: 51 near-miss, 34 not applicable); asked about the target rule 139, not asked 14

| cutoff | tp | fp | tn | fn | recall | false alarm | precision |
|---|---|---|---|---|---|---|---|
| 0.3 | 65 | 6 | 65 | 3 | 0.956 | 0.085 | 0.915 |
| 0.4 | 65 | 5 | 66 | 3 | 0.956 | 0.070 | 0.929 |
| 0.5 | 64 | 4 | 67 | 4 | 0.941 | 0.056 | 0.941 |
| 0.6 | 63 | 2 | 69 | 5 | 0.926 | 0.028 | 0.969 |
| 0.7 | 61 | 2 | 69 | 7 | 0.897 | 0.028 | 0.968 |
| 0.8 | 58 | 2 | 69 | 10 | 0.853 | 0.028 | 0.967 |
| 0.9 | 52 | 0 | 71 | 16 | 0.765 | 0.000 | 1.000 |

all two-tier: raise at >= 0.7, double-check at 0.5 to 0.7

| tier | violations flagged | clean flagged | recall | false alarm |
|---|---|---|---|---|
| >= 0.7 (raise) | 61 | 2 | 0.897 | 0.028 |
| 0.5–0.7 (double-check) | 3 | 2 | 0.044 added | 0.028 added |
| >= 0.5 (either) | 64 | 4 | 0.941 | 0.056 |

The lower tier adds 3 violations (0.044 of all violations) and 2 false alarms (0.028 of all clean cases). 4 violations stay below 0.5.

all per rule (case counts, AUC over the asked cases, recall and false alarm at both cutoffs, clean cases in the 0.3–0.5 band)

| rule | cases | asked | not asked | v | clean | AUC | recall@0.7 | FA@0.7 | recall@0.5 | FA@0.5 | lower tier t/f | clean in band |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| boolean-names-start-with-is-has-should-can | 9 | 9 | 0 | 4 | 5 | 0.900 | 1.000 | 0.400 | 1.000 | 0.400 | 0/0 | 0 (thin) |
| errors-never-reach-the-user-raw | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| every-exported-function-documents-its-return-value | 9 | 7 | 2 | 4 | 3 | 1.000 | 0.750 | 0.000 | 1.000 | 0.000 | 1/0 | 0 (thin) |
| exported-functions-must-have-explicit-return-types | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| javascript-uses-const-or-let | 9 | 7 | 2 | 4 | 3 | 1.000 | 0.750 | 0.000 | 0.750 | 0.000 | 0/0 | 0 (thin) |
| markdown-carries-no-placeholder-text | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 1 (thin) |
| never-clip-user-visible-text | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.200 | 0/1 | 1 (thin) |
| no-console-statements | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-empty-catch-blocks | 9 | 9 | 0 | 4 | 5 | 1.000 | 0.750 | 0.000 | 0.750 | 0.000 | 0/0 | 0 (thin) |
| no-explicit-any-type | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-hardcoded-credentials | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-new-dependency-without-need | 9 | 9 | 0 | 4 | 5 | 0.900 | 0.250 | 0.000 | 0.500 | 0.000 | 1/0 | 0 (thin) |
| no-partial-implementations | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-except-clauses-name-their-exception | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-functions-do-not-use-mutable-default-arguments | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| switch-statements-must-have-a-default-case | 9 | 9 | 0 | 4 | 5 | 1.000 | 0.750 | 0.000 | 1.000 | 0.200 | 1/1 | 0 (thin) |
| todo-comments-need-a-reference | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |

Rules with more than half of their asked clean cases in 0.3–0.5 (all): none

tune: 102 cases (51 violation, 51 clean: 34 near-miss, 17 not applicable); asked about the target rule 95, not asked 7

| cutoff | tp | fp | tn | fn | recall | false alarm | precision |
|---|---|---|---|---|---|---|---|
| 0.3 | 49 | 3 | 41 | 2 | 0.961 | 0.068 | 0.942 |
| 0.4 | 49 | 3 | 41 | 2 | 0.961 | 0.068 | 0.942 |
| 0.5 | 48 | 2 | 42 | 3 | 0.941 | 0.045 | 0.960 |
| 0.6 | 47 | 1 | 43 | 4 | 0.922 | 0.023 | 0.979 |
| 0.7 | 45 | 1 | 43 | 6 | 0.882 | 0.023 | 0.978 |
| 0.8 | 42 | 1 | 43 | 9 | 0.824 | 0.023 | 0.977 |
| 0.9 | 39 | 0 | 44 | 12 | 0.765 | 0.000 | 1.000 |

tune two-tier: raise at >= 0.7, double-check at 0.5 to 0.7

| tier | violations flagged | clean flagged | recall | false alarm |
|---|---|---|---|---|
| >= 0.7 (raise) | 45 | 1 | 0.882 | 0.023 |
| 0.5–0.7 (double-check) | 3 | 1 | 0.059 added | 0.023 added |
| >= 0.5 (either) | 48 | 2 | 0.941 | 0.045 |

The lower tier adds 3 violations (0.059 of all violations) and 1 false alarms (0.023 of all clean cases). 3 violations stay below 0.5.

tune per rule (case counts, AUC over the asked cases, recall and false alarm at both cutoffs, clean cases in the 0.3–0.5 band)

| rule | cases | asked | not asked | v | clean | AUC | recall@0.7 | FA@0.7 | recall@0.5 | FA@0.5 | lower tier t/f | clean in band |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| boolean-names-start-with-is-has-should-can | 6 | 6 | 0 | 3 | 3 | 0.889 | 1.000 | 0.333 | 1.000 | 0.333 | 0/0 | 0 (thin) |
| errors-never-reach-the-user-raw | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| every-exported-function-documents-its-return-value | 6 | 5 | 1 | 3 | 2 | 1.000 | 0.667 | 0.000 | 1.000 | 0.000 | 1/0 | 0 (thin) |
| exported-functions-must-have-explicit-return-types | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| javascript-uses-const-or-let | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| markdown-carries-no-placeholder-text | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 1 (thin) |
| never-clip-user-visible-text | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.333 | 0/1 | 0 (thin) |
| no-console-statements | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-empty-catch-blocks | 6 | 6 | 0 | 3 | 3 | 1.000 | 0.667 | 0.000 | 0.667 | 0.000 | 0/0 | 0 (thin) |
| no-explicit-any-type | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-hardcoded-credentials | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-new-dependency-without-need | 6 | 6 | 0 | 3 | 3 | 1.000 | 0.000 | 0.000 | 0.333 | 0.000 | 1/0 | 0 (thin) |
| no-partial-implementations | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-except-clauses-name-their-exception | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-functions-do-not-use-mutable-default-arguments | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| switch-statements-must-have-a-default-case | 6 | 6 | 0 | 3 | 3 | 1.000 | 0.667 | 0.000 | 1.000 | 0.000 | 1/0 | 0 (thin) |
| todo-comments-need-a-reference | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |

Rules with more than half of their asked clean cases in 0.3–0.5 (tune): none

holdout: 51 cases (17 violation, 34 clean: 17 near-miss, 17 not applicable); asked about the target rule 44, not asked 7

| cutoff | tp | fp | tn | fn | recall | false alarm | precision |
|---|---|---|---|---|---|---|---|
| 0.3 | 16 | 3 | 24 | 1 | 0.941 | 0.111 | 0.842 |
| 0.4 | 16 | 2 | 25 | 1 | 0.941 | 0.074 | 0.889 |
| 0.5 | 16 | 2 | 25 | 1 | 0.941 | 0.074 | 0.889 |
| 0.6 | 16 | 1 | 26 | 1 | 0.941 | 0.037 | 0.941 |
| 0.7 | 16 | 1 | 26 | 1 | 0.941 | 0.037 | 0.941 |
| 0.8 | 16 | 1 | 26 | 1 | 0.941 | 0.037 | 0.941 |
| 0.9 | 13 | 0 | 27 | 4 | 0.765 | 0.000 | 1.000 |

holdout two-tier: raise at >= 0.7, double-check at 0.5 to 0.7

| tier | violations flagged | clean flagged | recall | false alarm |
|---|---|---|---|---|
| >= 0.7 (raise) | 16 | 1 | 0.941 | 0.037 |
| 0.5–0.7 (double-check) | 0 | 1 | 0.000 added | 0.037 added |
| >= 0.5 (either) | 16 | 2 | 0.941 | 0.074 |

The lower tier adds 0 violations (0.000 of all violations) and 1 false alarms (0.037 of all clean cases). 1 violations stay below 0.5.

holdout per rule (case counts, AUC over the asked cases, recall and false alarm at both cutoffs, clean cases in the 0.3–0.5 band)

| rule | cases | asked | not asked | v | clean | AUC | recall@0.7 | FA@0.7 | recall@0.5 | FA@0.5 | lower tier t/f | clean in band |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| boolean-names-start-with-is-has-should-can | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.500 | 1.000 | 0.500 | 0/0 | 0 (thin) |
| errors-never-reach-the-user-raw | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| every-exported-function-documents-its-return-value | 3 | 2 | 1 | 1 | 1 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| exported-functions-must-have-explicit-return-types | 3 | 2 | 1 | 1 | 1 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| javascript-uses-const-or-let | 3 | 2 | 1 | 1 | 1 | 1.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0/0 | 0 (thin) |
| markdown-carries-no-placeholder-text | 3 | 2 | 1 | 1 | 1 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| never-clip-user-visible-text | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 1 (thin) |
| no-console-statements | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-empty-catch-blocks | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-explicit-any-type | 3 | 2 | 1 | 1 | 1 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-hardcoded-credentials | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-new-dependency-without-need | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-partial-implementations | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-except-clauses-name-their-exception | 3 | 2 | 1 | 1 | 1 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-functions-do-not-use-mutable-default-arguments | 3 | 2 | 1 | 1 | 1 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| switch-statements-must-have-a-default-case | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.500 | 0/1 | 0 (thin) |
| todo-comments-need-a-reference | 3 | 3 | 0 | 1 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |

Rules with more than half of their asked clean cases in 0.3–0.5 (holdout): none


## What this says

- **The shipped cutoff is conservative and close to the knee.** At 0.7 the guard catches 61 of 68 violations (0.897),
  raises 2 false alarms in 71 clean cases (0.028) and reaches precision 0.968. At 0.5 it catches 64 (0.941) with 4
  false alarms (0.056) and precision 0.941. At 0.6 it already catches 63 (0.926) with 2 false alarms (0.028).
- **The judge's own verdict is right more often than the threshold.** All 68 violation cases got the `violation`
  outcome (the argmax); only the probability was below 0.7 in 7 of them. So threshold tuning is a clean lever: no case
  is missed because the judge prefers another outcome, except the ones below 0.5.
- **The planned lower tier is worth about 4 points of recall for about 3 points of false alarms.** A double-check tier
  at 0.5 to 0.7 adds 3 of 68 violations (+0.044 recall) and 2 of 71 false alarms (+0.028), taking the totals to 0.941
  and 0.056. Two of the three added catches are cases the judge itself called violations with low confidence: a Python
  `match` with no wildcard case (0.60, the rule says "switch") and a JSDoc `@returns` removed from an exported
  function in `src/` (0.58). The third is a dependency entry added to `package.json` (0.64). The two added false alarms
  sit at 0.54 and 0.56. The holdout set adds nothing at the lower tier: no holdout violation scores between 0.5 and 0.7.
- **Four violations never reach 0.5, and they are not all the same problem.** Two are judge misses: a catch block whose
  body is only a comment (0.46, called `compliant`) and a new `var line = ...` added inside a file that already has a
  `var started` at the top (0.26, called `compliant`; the state does show the new `var`, and the comparable case in a
  file without a pre-existing `var` is caught at 1.00, so the pre-existing violation suppresses the new one). Two are
  state misses: a `package.json` write adding an unused `lodash` entry (0.12) and a source file importing `date-fns`
  (0.21) both came back `insufficient_context`, because the changed file alone cannot show whether the project's code
  needs the package.
- **One rule is not judgeable from the changed content: `no-new-dependency-without-need`.** It catches 1 of 4
  violations at every cutoff (only the `package.json` edit, at 0.64). A rule whose evidence lives outside the changed
  file cannot be enforced by this guard's state as it stands; it needs the manifest in the request, or it does not
  belong in the rules file. `no-partial-implementations`, the other hard rule added for this bench, is caught 4 of 4 at
  1.00.
- **The false alarms at 0.7 come from one rule.** `boolean-names-start-with-is/has/should/can` flags 2 of its 5 clean
  cases (0.83 and 0.89), and no other rule flags more than one clean case at 0.7. Both cases are the labels a reader is
  most likely to dispute (see below); if both labels are rejected, false alarms at 0.7 are 0 of 71 and the rule is
  clean at every cutoff.
- **No rule trips the badly-worded test.** No rule has more than half of its clean cases in the 0.3 to 0.5 band. Only
  two clean cases in the whole set score there: a Markdown rule on a real CLI placeholder in angle brackets (0.45) and
  the message-clipping rule on a slice of a log identifier (0.34). Both are cases where a reader can argue the label,
  and both are worth a wording pass rather than a threshold change.
- **13 of 17 rules catch every violation at 0.7**; the four below that are `no-new-dependency-without-need` (0.250),
  and `every-exported-function-documents-its-return-value`, `javascript-uses-const-or-let` and
  `no-empty-catch-blocks` (0.750 each).
- **The holdout set does not expose a bigger failure than the tune set.** At 0.7, holdout recall is 0.941 against 0.882
  on tune, and holdout false alarms are 0.037 against 0.023, so the tune labels are not visibly easier than the held-out
  ones. With one violation per rule in holdout, this is a weak check, not a strong one.
- **Side observation, the edit locator.** The steer names the edit Jev points at. Of the 17 multi-edit cases, 16
  produced a finding and the locator named an edit in all 16; 14 of 17 named the edit that carries the violation. Twice
  it named the harmless edit instead (`errors-never-reach-the-user-raw`, `no-partial-implementations`), which would send
  the agent to the wrong line in the steer.

## Labels that a reader may dispute

These move the numbers, so they are stated plainly.

- `r04-02` (violation, missed at 0.46): the catch body holds only a comment. The fixture rule says "must not be empty";
  the project's own prose in `pi-warden.md` adds "or one whose body is only a comment". Judged against the fixture text
  alone, the `compliant` answer is defensible, so this miss is a wording gap in the bench's rule text rather than a
  guard failure. Without this case, recall at 0.7 is 60 of 67 (0.896).
- `r08-06` (clean, flagged at 0.83) and `r08-08` (clean, flagged at 0.89): a property `active: string` and a JSON data
  field `"active": true`. The rule speaks of "a boolean variable or property", so a string property and a data field are
  outside it; a reader who thinks the rule means "names that read as booleans" would call both violations.
- `r15-04` (violation, missed at 0.26) is not a label uncertainty: the edit writes a new `var` and the state shows it.

## Limits

- One answer per case, no repeats: run-to-run spread is not measured, and a single answer per cut point is thin at the
  per-rule level. Each rule's holdout column rests on one violation and two clean cases, so AUC there needs a class of
  at least two and is often only 0 or 1.
- The author wrote the labels and the reasons, and the numbers depend on them; the disputed labels above are the known
  ones.
- The fixture rules are not the project's own `pi-warden.md`. Two of the three hard rules added for this bench
  (`no-new-dependency-without-need`, and to a lesser extent `errors-never-reach-the-user-raw`) are the ones that need
  context the guard's state does not carry, so their numbers read as "this rule cannot be checked this way", not as "the
  judge is weak here".
- A case the guard never asks about cannot raise a false alarm: the 14 scoped-rule cases outside their paths are
  excluded from the rates and reported as `not asked` in the tables.

## Reproduce

```
npm run build
npm run eval:rules -- --dry-run
npm run eval:rules -- --split all --budget 200 --concurrency 4
```
