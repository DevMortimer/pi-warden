# Rules bench: catch rate and false alarms at several cutoffs

Date: 2026-09-26. Judge: `jev-1.13.0` for all 153 answers. pi-warden 0.68.0; `src/` unchanged.

## Question

The rules guard raises a finding when a rule's `violation` probability reaches `config.rules.threshold` (0.7). Where
does that cutoff sit between violations the guard misses and false alarms it raises, per rule, and what would the
planned lower "please double-check" tier (0.5 to 0.7) add in recall and in false alarms? The numbers are the input for
that change; nothing here tunes the guard.

This report holds the second run of the bench. The first run (same cases, 153 requests) used a shorter wording of the
`no-empty-catch-blocks` rule that left out the project's own "or one whose body is only a comment" clause; the rule
text was corrected to match `pi-warden.md` and the bench was run again. The rule change moves one case (see
*Labels that a reader may dispute*) and nothing else in the bench.

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
| Command | `npm run eval:rules -- --split all --budget 160 --concurrency 4` |
| Dry run | `npm run eval:rules -- --dry-run`: 153 cases, 153 requests planned, 0 sent |
| Wall time | 11.9 s (runner), concurrency 4 |
| Requests | 153 sent of a 160 budget, 0 failed, 0 retried; judge `jev-1.13.0` |
| Usage (`getUsage()`) | 153 started, 153 succeeded, 708,917 input tokens, 112,710 output tokens, est. $0.0298 |
| Latency | 284 ms p50, 453 ms p95, 636 ms max per request |
| Files | `results.json` (every raw `RuleScore`, the case metadata, the scored tables), `requests.jsonl` (case, split, tool, path, latency, outcome; no state content) |
| Re-scoring | `npm run eval:rules -- --rescore eval/reports/2026-09-26-rules-bench` spends nothing |

## Tables

all: 153 cases (68 violation, 85 clean: 51 near-miss, 34 not applicable); asked about the target rule 139, not asked 14

| cutoff | tp | fp | tn | fn | recall | false alarm | precision |
|---|---|---|---|---|---|---|---|
| 0.3 | 66 | 7 | 64 | 2 | 0.971 | 0.099 | 0.904 |
| 0.4 | 65 | 4 | 67 | 3 | 0.956 | 0.056 | 0.942 |
| 0.5 | 65 | 4 | 67 | 3 | 0.956 | 0.056 | 0.942 |
| 0.6 | 64 | 3 | 68 | 4 | 0.941 | 0.042 | 0.955 |
| 0.7 | 62 | 2 | 69 | 6 | 0.912 | 0.028 | 0.969 |
| 0.8 | 59 | 2 | 69 | 9 | 0.868 | 0.028 | 0.967 |
| 0.9 | 50 | 0 | 71 | 18 | 0.735 | 0.000 | 1.000 |

all two-tier: raise at >= 0.7, double-check at 0.5 to 0.7

| tier | violations flagged | clean flagged | recall | false alarm |
|---|---|---|---|---|
| >= 0.7 (raise) | 62 | 2 | 0.912 | 0.028 |
| 0.5–0.7 (double-check) | 3 | 2 | 0.044 added | 0.028 added |
| >= 0.5 (either) | 65 | 4 | 0.956 | 0.056 |

The lower tier adds 3 violations (0.044 of all violations) and 2 false alarms (0.028 of all clean cases). 3 violations stay below 0.5.

all per rule (case counts, AUC over the asked cases, recall and false alarm at both cutoffs, clean cases in the 0.3–0.5 band)

| rule | cases | asked | not asked | v | clean | AUC | recall@0.7 | FA@0.7 | recall@0.5 | FA@0.5 | lower tier t/f | clean in band |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| boolean-names-start-with-is-has-should-can | 9 | 9 | 0 | 4 | 5 | 0.900 | 1.000 | 0.400 | 1.000 | 0.400 | 0/0 | 1 (thin) |
| errors-never-reach-the-user-raw | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| every-exported-function-documents-its-return-value | 9 | 7 | 2 | 4 | 3 | 1.000 | 0.750 | 0.000 | 1.000 | 0.000 | 1/0 | 0 (thin) |
| exported-functions-must-have-explicit-return-types | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| javascript-uses-const-or-let | 9 | 7 | 2 | 4 | 3 | 1.000 | 0.750 | 0.000 | 0.750 | 0.000 | 0/0 | 0 (thin) |
| markdown-carries-no-placeholder-text | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 1 (thin) |
| never-clip-user-visible-text | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.200 | 0/1 | 1 (thin) |
| no-console-statements | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-empty-catch-blocks | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-explicit-any-type | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-hardcoded-credentials | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-new-dependency-without-need | 9 | 9 | 0 | 4 | 5 | 0.925 | 0.250 | 0.000 | 0.500 | 0.000 | 1/0 | 0 (thin) |
| no-partial-implementations | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-except-clauses-name-their-exception | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| python-functions-do-not-use-mutable-default-arguments | 9 | 7 | 2 | 4 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| switch-statements-must-have-a-default-case | 9 | 9 | 0 | 4 | 5 | 0.950 | 0.750 | 0.000 | 1.000 | 0.200 | 1/1 | 0 (thin) |
| todo-comments-need-a-reference | 9 | 9 | 0 | 4 | 5 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |

Rules with more than half of their asked clean cases in 0.3–0.5 (all): none

tune: 102 cases (51 violation, 51 clean: 34 near-miss, 17 not applicable); asked about the target rule 95, not asked 7

| cutoff | tp | fp | tn | fn | recall | false alarm | precision |
|---|---|---|---|---|---|---|---|
| 0.3 | 49 | 4 | 40 | 2 | 0.961 | 0.091 | 0.925 |
| 0.4 | 49 | 2 | 42 | 2 | 0.961 | 0.045 | 0.961 |
| 0.5 | 49 | 2 | 42 | 2 | 0.961 | 0.045 | 0.961 |
| 0.6 | 48 | 1 | 43 | 3 | 0.941 | 0.023 | 0.980 |
| 0.7 | 46 | 1 | 43 | 5 | 0.902 | 0.023 | 0.979 |
| 0.8 | 44 | 1 | 43 | 7 | 0.863 | 0.023 | 0.978 |
| 0.9 | 38 | 0 | 44 | 13 | 0.745 | 0.000 | 1.000 |

tune two-tier: raise at >= 0.7, double-check at 0.5 to 0.7

| tier | violations flagged | clean flagged | recall | false alarm |
|---|---|---|---|---|
| >= 0.7 (raise) | 46 | 1 | 0.902 | 0.023 |
| 0.5–0.7 (double-check) | 3 | 1 | 0.059 added | 0.023 added |
| >= 0.5 (either) | 49 | 2 | 0.961 | 0.045 |

The lower tier adds 3 violations (0.059 of all violations) and 1 false alarms (0.023 of all clean cases). 2 violations stay below 0.5.

tune per rule (case counts, AUC over the asked cases, recall and false alarm at both cutoffs, clean cases in the 0.3–0.5 band)

| rule | cases | asked | not asked | v | clean | AUC | recall@0.7 | FA@0.7 | recall@0.5 | FA@0.5 | lower tier t/f | clean in band |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| boolean-names-start-with-is-has-should-can | 6 | 6 | 0 | 3 | 3 | 0.889 | 1.000 | 0.333 | 1.000 | 0.333 | 0/0 | 1 (thin) |
| errors-never-reach-the-user-raw | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| every-exported-function-documents-its-return-value | 6 | 5 | 1 | 3 | 2 | 1.000 | 0.667 | 0.000 | 1.000 | 0.000 | 1/0 | 0 (thin) |
| exported-functions-must-have-explicit-return-types | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| javascript-uses-const-or-let | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| markdown-carries-no-placeholder-text | 6 | 5 | 1 | 3 | 2 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 1 (thin) |
| never-clip-user-visible-text | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.333 | 0/1 | 0 (thin) |
| no-console-statements | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
| no-empty-catch-blocks | 6 | 6 | 0 | 3 | 3 | 1.000 | 1.000 | 0.000 | 1.000 | 0.000 | 0/0 | 0 (thin) |
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
| 0.3 | 17 | 3 | 24 | 0 | 1.000 | 0.111 | 0.850 |
| 0.4 | 16 | 2 | 25 | 1 | 0.941 | 0.074 | 0.889 |
| 0.5 | 16 | 2 | 25 | 1 | 0.941 | 0.074 | 0.889 |
| 0.6 | 16 | 2 | 25 | 1 | 0.941 | 0.074 | 0.889 |
| 0.7 | 16 | 1 | 26 | 1 | 0.941 | 0.037 | 0.941 |
| 0.8 | 15 | 1 | 26 | 2 | 0.882 | 0.037 | 0.938 |
| 0.9 | 12 | 0 | 27 | 5 | 0.706 | 0.000 | 1.000 |

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

- **The shipped cutoff trades 3 caught violations against the judge's own answer for 2 false alarms.** At 0.7 the guard
  catches 62 of 68 violations (0.912), raises 2 false alarms in 71 clean cases (0.028) and reaches precision 0.969. At
  0.5 it catches 65 (0.956) with 4 false alarms (0.056) and precision 0.942. At 0.6 it catches 64 (0.941) with 3 false
  alarms (0.042).
- **A cutoff at 0.5 reproduces the judge's argmax exactly.** 65 of the 68 violation cases carry the `violation` outcome
  and 4 of the 71 clean cases do, which are precisely the counts at the 0.5 cutoff. The 0.7 cutoff leaves 3 of the
  judge's own violations unsteered. The 3 exceptions among the violation cases are 2 `insufficient_context` answers and
  1 `compliant` answer, so a threshold change cannot reach them.
- **The planned lower tier is worth about 4 points of recall for about 3 points of false alarms.** A double-check tier
  at 0.5 to 0.7 adds 3 of 68 violations (+0.044 recall) and 2 of 71 false alarms (+0.028), taking the totals to 0.956
  and 0.056. Two of the three added catches are cases the judge itself called violations with low confidence: a Python
  `match` with no wildcard case (0.56, the rule says "switch") and a JSDoc `@returns` removed from an exported function
  in `src/` (0.69). The third is a dependency entry added to `package.json` (0.65). The two added false alarms sit at
  0.52 and 0.60. The holdout set adds nothing at the lower tier: no holdout violation scores between 0.5 and 0.7.
- **Three violations never reach 0.5, and they are not all the same problem.** One is a judge miss: a new
  `var line = ...` added inside a file that already has a `var started` at the top (0.35, called `compliant`). The state
  does show the new `var`, and the comparable case in a file without a pre-existing `var` is caught at 1.00, so a
  pre-existing violation of the rule suppresses a new one. The other two are state misses: a `package.json` write adding
  an unused `lodash` entry (0.15) and a source file importing `date-fns` (0.22) both came back `insufficient_context`,
  because the changed file alone cannot show whether the project's code needs the package.
- **One rule is not judgeable from the changed content: `no-new-dependency-without-need`.** It catches 1 of 4
  violations at every cutoff (only the `package.json` edit, at 0.65). A rule whose evidence lives outside the changed
  file cannot be enforced by this guard's state as it stands; it needs the manifest in the request, or it does not
  belong in the rules file. `no-partial-implementations`, the other hard rule added for this bench, is caught 4 of 4 at
  1.00.
- **The false alarms at 0.7 come from one rule.** `boolean-names-start-with-is/has/should/can` flags 2 of its 5 clean
  cases (0.81 and 0.84), and no other rule flags a clean case at 0.7. Both cases are the labels a reader is most likely
  to dispute (see below); if both labels are rejected, false alarms at 0.7 are 0 of 71 and the rule is clean at every
  cutoff.
- **No rule trips the badly-worded test.** No rule has more than half of its clean cases in the 0.3 to 0.5 band. Three
  clean cases in the whole set score there: the boolean rule on a non-boolean property (0.35), the message-clipping rule
  on a slice of a log identifier (0.33), and the Markdown rule on a real CLI placeholder in angle brackets (0.36). Each
  is worth a wording pass rather than a threshold change.
- **13 of 17 rules catch every violation at 0.7.** The four below that are `no-new-dependency-without-need` (1 of 4),
  and `switch-statements-must-have-a-default-case`, `every-exported-function-documents-its-return-value` and
  `javascript-uses-const-or-let` (3 of 4 each).
- **The holdout set does not expose a bigger failure than the tune set.** At 0.7, holdout recall is 0.941 against 0.902
  on tune, and holdout false alarms are 0.037 against 0.023, so the tune labels are not visibly easier than the held-out
  ones. With one violation per rule in holdout, this is a weak check, not a strong one.
- **Side observation, the edit locator.** The steer names the edit Jev points at. Of the 17 multi-edit cases, 16
  produced a finding and the locator named an edit in all 16; 14 of 17 named the edit that carries the violation. Twice
  it named the harmless edit instead (`errors-never-reach-the-user-raw`, `no-partial-implementations`), which would send
  the agent to the wrong line in the steer.

## Labels that a reader may dispute

These move the numbers, so they are stated plainly.

- `r08-06` (clean, flagged at 0.81) and `r08-08` (clean, flagged at 0.84): a property `active: string` and a JSON data
  field `"active": true`. The rule speaks of "a boolean variable or property", so a string property and a data field are
  outside it; a reader who thinks the rule means "names that read as booleans" would call both violations. These are the
  only false alarms at 0.7 and are left as they are.
- `r15-04` (violation, missed at 0.35) is not a label uncertainty: the edit writes a new `var` and the state shows it.
- `r04-02` (the first run's dispute) is resolved: the fixture rule now carries the project's own "or one whose body is
  only a comment" clause, so the case is a plain violation. It scores 0.97, `no-empty-catch-blocks` catches 4 of 4 at
  0.7, and this alone moves overall recall at 0.7 from 0.897 to 0.912. The rule text matters as much as the label.

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
npm run eval:rules -- --split all --budget 160 --concurrency 4
```
