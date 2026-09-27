# Rules bench

Labelled cases for the rules guard, each sent to the real judge in the request the extension builds, with a fixture
`pi-warden.md` installed in a temporary copy of a small project. The bench measures catch rate and false alarms at
several cutoffs, and the two-tier view a lower "please double-check" tier would give. It does not change a guard.

```
npm run build
npm run eval:rules -- --dry-run                     # list cases and counts, send nothing
npm run eval:rules -- --split tune --budget 120     # tune set only, hard cap of 120 requests
npm run eval:rules -- --split all --budget 200      # 153 cases, one request per case
npm run eval:rules -- --rescore eval/reports/<dir>  # re-score saved answers after a label fix
```

Options: `--split tune|holdout|all` (default `all`), `--concurrency N` (default 4), `--budget N` (hard cap passed to the
TypeSafe client as `maxRequests`), `--timeout MS` (per request, default 20000), `--out DIR` (default
`eval/reports/<date>-rules-bench`), `--dry-run`, `--rescore DIR`. Failed cases are retried once inside the budget.
Every request is billable unless `--dry-run`.

## Files

- `rules.md`: 17 rules. The first nine are the rules `scripts/rules-cases.mjs` already uses, extended with a `paths:`
  line where a rule is language scoped. The rest are small rules of the same kind, three of them taken from the
  project's own documentation style and harder to judge: *errors never reach the user raw*, *no new dependency without
  need*, and *no partial implementations*. Seven rules are scoped (TypeScript, JavaScript, Python, Markdown), the rest
  apply to every file. Three rules carry header lines beside `paths:`: `severity: high` on *no hardcoded credentials*,
  `severity: low` on *markdown carries no placeholder text*, and `threshold: 0.9` on *boolean names start with
  is/has/should/can*. The scorer reads those headers and reports each rule at its own cutoff and the soft tier under it.
- `project/`: the seed project the bench copies to a temp dir, with `rules.md` installed as `pi-warden.md`. Edit cases
  use these files as the file on disk, so the guard builds `before` and `after` around the replaced text. The seed
  files hold several pre-existing violations (`src/legacy.ts`, `src/auth.ts`, `src/logger.js`, `src/report.js`,
  `src/messages.js`, `src/level.ts`, `py/legacy.py`, `docs/notes.md`, `package.json`) so a case can check that an edit
  which leaves an earlier violation untouched is not blamed for it.
- `cases.json`: one line per case. `rule` is the single target rule; `label` is `violation` or `clean`; `kind` is one of
  `violation`, `near-miss`, `not-applicable`; `split` is `tune` or `holdout`; `tool` is `write` or `edit`; a multi-edit
  case names the `expectEdit` that carries the violation. `why` states the label in one line.
- `run.mjs`: the runner. `main(argv, deps)` takes pi-warden's API and a judge factory, so a test can drive it with a
  stub judge; `scripts/rules-bench.mjs` wires it to `dist/` and pi-typesafe.
- `score.mjs`: the scorer. Pure functions over the saved answers: no judge, no network.

## The end-of-run bench

`turn-cases.mjs` holds the cases for the questions the end-of-run pass asks, and `turn.mjs` runs them:

```
npm run eval:rules-turn -- --dry-run                     # list cases and counts, send nothing
npm run eval:rules-turn -- --split tune                  # tune set only
npm run eval:rules-turn -- --split all --out DIR         # the full run that backs a report
```

- `turn-rules.md`: six `when: turn` rules (task scope, single-use abstractions, duplication across files,
  speculative work, one concern per change, updating what a change invalidates).
- `turn-cases.mjs`: 36 turn cases (six per rule, three violations and three compliant near-misses, split 18 tune /
  18 holdout), each a task plus a multi-file diff sent through `evaluateTurnRules`; and six shell cases, each a set of
  starting files plus one command (`sed -i`-style in-place edits that break an edit rule, generated files that break
  none) driven through the production `evaluateTurnRun` on a temporary git repository. The loader validates labels,
  splits, target rules, and that every turn diff touches at least two files.
- `turn.mjs`: the runner; `tables` reports recall and false alarms at 0.5, 0.6, 0.7, and 0.8 per split from the saved
  scores, and `--rescore DIR` re-prints them offline. `scripts/rules-turn-bench.mjs` wires it to `dist/`.

## Cases

161 cases: mostly nine per rule (four clear violations, three compliant near-misses, and two cases where the rule does
not apply), plus eight later cases that add a new violation to a file which already breaks the same rule, or touch only
a line next to an old violation. Spread over the shapes the guard sees: 94 `write` cases, 67 `edit` cases, 17 of them a
multi-edit. Near-misses include a `console.log` inside a string, a `TODO` with a ticket, and an edit that leaves an
older violation in the same file unchanged.

The case set is split **tune** (107 cases) and **holdout** (54), stratified by rule and by label, fixed in
`cases.json`. **No threshold change and no rule wording change may be tuned against the holdout set**: tune against
`tune`, and use `holdout` only to confirm a decision already made. Choosing a split at run time is not allowed, and
neither is moving a case between splits to improve a number.

## What the guard is sent

`evaluateRules(tool, input, { cwd, config: config.rules, set, judge, timeoutMs })`, exactly as the extension calls it,
one request per case, with the fixture rules resolved from the temp project's `pi-warden.md`. Path scoping runs first,
so a scoped rule is not asked about a file its `paths` do not match (14 of the 161 cases, counted apart from the
metrics). The request carries one `choice` question per applicable rule (10 to 12 here), plus the edit locator when a
case has several edits. The answer for the target rule is scored; the other answers in the same request are saved but
not scored.

## Scoring

For each split, overall and per rule, at cutoffs 0.3, 0.4, 0.5, 0.6, 0.7, 0.8 and 0.9: caught violations (tp), missed
violations (fn), false alarms (fp), clean cases left alone (tn), recall, false-alarm rate and precision. Also AUC per
rule, and the rules where more than half of their clean cases score in the 0.3 to 0.5 band, which points at a rule
whose wording is unclear rather than at a weak judge. The two-tier view reports the shipped tier (flag at `violation >=
0.7`) next to the planned one (a double-check between 0.5 and 0.7): what the lower tier adds to recall, and how many
false alarms it adds. A per-rule view reads each rule's `threshold:` header (else 0.7) and reports recall and false
alarms at that cutoff plus the soft band from 0.5 up to it, and a second table gives the soft tier overall at those
cutoffs.

`results.json` holds every raw `RuleScore` (outcome and probability per rule), the model, the elapsed time, the case
metadata and the scored tables. `requests.jsonl` holds one line per request with the case id, the split, the tool, the
path, latency and the outcome; no state content.

## Limits

The labels are authored, and a debatable label moves a number. Support is thin where it matters most: the holdout set
has one violation and two clean cases per rule, so a per-rule holdout column is coarse and AUC needs at least one case
of each class. Each case is sent once, so run-to-run spread is not measured. A case the guard never asks about cannot
raise a false alarm, so those cases are excluded from recall and false alarms and reported as `not asked`.
