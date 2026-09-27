# End-of-run rules: the turn question and the shell-changed-file path

Date: 2026-09-27. Judge: `jev-1.13.0` for every request. pi-warden 0.71.0 plus the changes in this branch.

## Question

Two new judgments ship with this branch, and both are measured before they ship. (1) A `when: turn` rule is judged once
at the end of an agent run against the whole diff the run made and the user's task — for rules one edit cannot answer:
the change adds more than the task asked for, a new abstraction with a single use, logic duplicated across files. (2) A
file a shell command changed in ways the per-edit guard cannot see (`sed -i`, a generator's output) is judged at the
end of the run with the same per-edit question and the file's diff as the edit. This report measures both: can the
judge separate a violating whole-run diff from a compliant near-miss, and does the file-diff-as-edit path catch an
in-place change that breaks an edit rule and leave a clean generated file alone?

## Method

- 42 labelled cases (`eval/rules-bench/turn-cases.mjs`). 36 turn cases: six `when: turn` rules
  (`eval/rules-bench/turn-rules.md`) × six cases each, three violations and three compliant near-misses per rule, each
  case a task plus a diff touching at least two files. Split 18 tune / 18 holdout, with both labels in both splits for
  every rule. Six shell-change cases: three `sed -i`-style in-place edits that break an edit rule and three generated
  files that break none, split 3 tune / 3 holdout, each a set of starting files plus one command.
- Turn cases go through `evaluateTurnRules(task, diff, rules)` exactly as the extension calls it: one request with the
  task and the whole diff. Shell cases go through the production `evaluateTurnRun` on a temporary git repository:
  snapshot, run the command, judge each changed file no per-edit check saw. The scorer sweeps the cutoffs 0.5, 0.6,
  0.7, and 0.8 over the saved probabilities; the shipped cutoff is `rules.threshold` (0.7).
- Tune ran twice (21 requests each). The first tune run's case `t02-01` replaced an existing single-use helper with a
  new one and imported the new helper in a second file; its 0.56 was a fair read of a case that did not cleanly match
  its label. The case was rewritten on the tune split to introduce the helper cleanly (one call site, no second
  reference) and the second tune run caught it at 1.00. Holdout ran once, inside the final `--split all` run.

## Requests

| Run | Cases | Requests | Cost | Backs the report |
| --- | --- | --- | --- | --- |
| Tune 1 (before the case fix) | 21 | 21 | $0.0027 | no (superseded by tune 2) |
| Tune 2 (after the case fix) | 21 | 21 | $0.0027 | the case fix |
| Final, all splits (`--split all`) | 42 | 42 | $0.0055 | yes |

**Total: 84 requests**, 0 failed. The question wording was never changed, so no run is superseded for wording.

## Turn question, tune and holdout at every cutoff

Recall and false alarms from the final run (`final/results.json`):

| split | cases | recall 0.5 | recall 0.6 | recall 0.7 | recall 0.8 | false alarms 0.5 | 0.6 | 0.7 | 0.8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tune | 18 (12 v / 6 c) | 1.000 (12/12) | 1.000 | 1.000 | 1.000 | 0.000 (0/6) | 0.000 | 0.000 | 0.000 |
| holdout | 18 (6 v / 12 c) | 1.000 (6/6) | 1.000 | 1.000 | 1.000 | 0.000 (0/12) | 0.000 | 0.000 | 0.000 |
| all | 36 (18 v / 18 c) | 1.000 (18/18) | 1.000 | 1.000 | 1.000 | 0.000 (0/18) | 0.000 | 0.000 | 0.000 |

Per-rule scores in the final run (three violations then three near-misses per rule):

| rule | violation scores | near-miss scores |
| --- | --- | --- |
| the-change-stays-inside-the-task | 0.98 1.00 1.00 | 0.05 0.36 0.04 |
| no-abstraction-with-a-single-use | 0.99 0.99 0.91 | 0.01 0.00 0.00 |
| no-logic-duplicated-across-files | 1.00 0.99 0.99 | 0.00 0.00 0.00 |
| no-speculative-work | 0.99 0.95 0.90 | 0.00 0.00 0.00 |
| one-concern-per-change | 0.91 0.98 0.83 | 0.00 0.00 0.00 |
| the-change-updates-what-it-invalidates | 0.99 0.98 0.90 | 0.01 0.06 0.03 |

Violations run 0.83 to 1.00, near-misses 0.00 to 0.36; every cutoff from 0.5 to 0.8 separates the set, so the shipped
0.7 needs no turn-specific value.

## Shell-changed files, at every cutoff

| split | cases | recall 0.5 | 0.6 | 0.7 | 0.8 | false alarms 0.5 | 0.6 | 0.7 | 0.8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tune | 3 (2 v / 1 c) | 1.000 (2/2) | 1.000 | 1.000 | 1.000 | 0.000 (0/1) | 0.000 | 0.000 | 0.000 |
| holdout | 3 (1 v / 2 c) | 1.000 (1/1) | 1.000 | 1.000 | 1.000 | 0.000 (0/2) | 0.000 | 0.000 | 0.000 |
| all | 6 (3 v / 3 c) | 1.000 (3/3) | 1.000 | 1.000 | 1.000 | 0.000 (0/3) | 0.000 | 0.000 | 0.000 |

The three violating `sed -i` changes score 1.00, 1.00, 0.96 against the edit rule they break (a `console.log` inserted
by an in-place edit, a bare `TODO` inserted by an in-place edit, a `catch` body emptied by deletions). The three
generated files (`node gen.js > file`) score 0.00 against the rule they keep: the generated output is judged as the
edit it never got from a `write`, and clean content is left alone.

## A sample end-of-run steer

One run, one steer — the turn finding and the file finding in a single message, through the done-check's delivery
(`deliverAs: "followUp", triggerTurn: true`), produced by the production `turnSteer`:

> pi-warden: the changes this run made violate a project rule: "The change stays inside the task" (0.93): The diff must
> contain only what the user's task asked for; the change to app.js (made by a command, not an edit) violates a project
> rule: "No console statements" (0.88): Code must not contain `console.log` calls. Use the logger. Review the run's
> diff and fix the violations before you finish.

## What these numbers do and do not say

- The set is small and hand-built, and most cases are clear-cut; the separation at 0.8 says the question reads these
  diffs cleanly, not that real runs will land at 1.000. The muddled `t02-01` case moved from 0.56 to 1.00 when the case
  was made to match its label, which is the honest reminder: the judge reads what is in the diff.
- Near-misses sit closest to the cutoff for task scope (0.36) and the invalidation rule (0.06), the two rules whose
  violations are omissions or judgement calls; those are where a real false alarm would come from.
- Not measured here: diffs past `rules.maxChars` (the caps name what they cut), deleted files, binary files, and runs
  with more changed files than the report's cases show. The per-file pass judges every changed file the per-edit guard
  missed, one request per file.
