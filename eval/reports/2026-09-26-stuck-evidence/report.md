# Judge bench: the stuck guard's structured evidence, shipped

Date: 2026-09-26. Judge: `jev-1.13.0` for all 240 answers. pi-warden 0.66.1 with the stuck evidence section from this
branch (shipped as 0.67.0). Same 80 labelled cases (`eval/judge-bench/`) as the
[previous run](../2026-09-26-judge-bench/report.md).

## Question

Would the stuck guard judge better if it sent a compact structured `evidence` section instead of only each attempt's
call, outcome and 400-character output tail? The previous run measured the idea as an arm that lived in the bench
(`eval/reports/2026-09-26-judge-bench/`: accuracy 0.725 → 0.992, 11 wins to 0, p = 0.001). This run ships it: the
builder and parser now live in `src/evidence.ts` and every stuck state in the bench comes from the real guard.

## Method

- The three arms are the shipped guard, not a bench copy:
  - **A** — `buildStuckRequest` as it ships, with `stuck.evidence` on (the new default): today's task, attempts and
    output tails, plus the `evidence` object.
  - **B** — A with larger raw slices (head 400 + tail 400 of every output), to test whether more raw text adds
    anything on top of the structured state.
  - **C** — the same builder with `stuck.evidence: false`, which is exactly the state the guard sent before this
    change. C is the committed baseline under another name: its state bytes (p50 1837, p95 2473) reproduce the
    committed run's arm A (p50 1837, p95 2473) byte for byte.
- Offline parity check before spending a request: for all 40 stuck cases, the evidence the shipped builder produces is
  identical to the committed arm-C builder's evidence, except for one added digest key (`same_command_runs`). Same
  runs, same parsed failures, same edits, same counts.
- Scoring unchanged (`eval/judge-bench/score.mjs`): stuck when the window is decided in code or `same_strategy >= 0.7`
  (`src/config.ts`). Questions, thresholds and the gate are untouched.
- One repeat, arm and case order shuffled with seed 20260926.

## Run

| Item | Value |
|---|---|
| Command | `npm run eval:judge -- --repeats 1 --budget 300 --out eval/reports/2026-09-26-stuck-evidence` |
| Dry run | `npm run eval:judge -- --dry-run`: 80 cases, 240 requests planned, 0 sent |
| Requests | 240 sent of a 300 budget (80 cases x 3 arms x 1 repeat); 0 failed; 0 retried |
| Wall time | 15.8 s |
| Files | `results.json` (answers, per-case verdicts, scores), `requests.jsonl` (arm, bytes, latency, outcome; no state content) |

## Results

### stuck (40 cases, 20 stuck; 0 decided in code)

| Arm | State | Judgments | Accuracy | Precision (stuck) | Recall (stuck) | Brier | Bytes p50 / p95 | Latency ms p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| A | shipped, evidence on | 40 | **1.000** | 1.000 | 1.000 | 0.101 | 3367 / 4255 | 258 / 346 |
| B | A + larger raw slices | 40 | 1.000 | 1.000 | 1.000 | 0.090 | 4476 / 5521 | 257 / 324 |
| C | shipped, evidence off (baseline) | 40 | 0.725 | 0.667 | 0.900 | 0.207 | 1837 / 2473 | 248 / 305 |
| — | committed baseline (`2026-09-26-judge-bench`, arm A) | 120 | 0.725 | 0.667 | 0.900 | 0.207 | 1837 / 2473 | 256 / 310 |

Per category (accuracy, TP/FP/TN/FN, Brier). `trap-*` rows are bolded.

| Category | Label | Cases | A (after) | C (before) |
|---|---|---|---|---|
| test-changes | progressing | 4 | 1 (0/0/4/0), 0.321 | 0.250 (0/3/1/0), 0.615 |
| error-changes | progressing | 4 | 1 (0/0/4/0), 0.168 | 0.750 (0/1/3/0), 0.311 |
| fewer-failures | progressing | 4 | 1 (0/0/4/0), 0.247 | 0.250 (0/3/1/0), 0.574 |
| info-then-edit | progressing | 4 | 1 (0/0/4/0), 0.050 | 1 (0/0/4/0), 0.053 |
| **trap-tail-visible** | progressing | 4 | **1 (0/0/4/0), 0.179** | **0.500 (0/2/2/0), 0.409** |
| cosmetic-edit | stuck | 4 | 1 (4/0/0/0), 0.027 | 0.750 (3/0/0/1), 0.053 |
| flags | stuck | 4 | 1 (4/0/0/0), 0.002 | 1 (4/0/0/0), 0.003 |
| rewording | stuck | 4 | 1 (4/0/0/0), 0.010 | 0.750 (3/0/0/1), 0.034 |
| **trap-noise-lines** | stuck | 2 | **1 (2/0/0/0), 0.004** | **1 (2/0/0/0), 0.008** |
| **trap-noise-timestamps** | stuck | 2 | **1 (2/0/0/0), 0.005** | **1 (2/0/0/0), 0.006** |
| **trap-noise-paths** | stuck | 2 | **1 (2/0/0/0), 0.004** | **1 (2/0/0/0), 0.006** |
| **trap-noise-order** | stuck | 2 | **1 (2/0/0/0), 0.007** | **1 (2/0/0/0), 0.008** |

Trap rows, before and after: the four noise traps (line numbers, timestamps, temp paths, ordering) are 1.00 in every
arm, before and after; `trap-tail-visible` goes 0.500 → 1.000, which is the one category the old state loses and the
new state wins.

Sign test over cases (exact, two-sided):

| Comparison | Arm right, A wrong | Arm wrong, A right | p |
|---|---|---|---|
| C vs A | 0 | 11 (s01, s03, s04, s06, s09, s10, s12, s17, s18, s22, s29) | 0.001 |

The 11 cases where the shipped state is right and the baseline wrong are the same 11 the previous run found, on the
same case ids: nine progressing windows the old state called stuck (three of four test-changes cases, three of four
fewer-failures cases, one error-changes case, and two of four trap-tail-visible cases where a changed failing test
was still read as a retry) and two stuck windows it missed (s22, cosmetic-edit with reworded variables; s29, a
reworded command and test title). B changes nothing on top of A (0 wins, 0 losses).

### done (40 cases, 20 not done; 23 reach the judge)

Unchanged by this work, and it reproduces the committed run: A 0.850 (0.149 Brier, 256/360 bytes, 246/353 ms),
B 0.850, C 0.875 (0.138 Brier, 611/895 bytes, 241/278 ms).

## The evidence object for one case, as sent

`s01` (`progressing`, `test-changes`, TAP, real tool run). The state is 4255 bytes, of which the evidence is 1984;
every string is redacted, and the fixture project's paths are synthetic.

```json
{
 "runs": [
  { "n": 2, "outcome": "failed", "parser": "tap",
    "failing_tests": ["weekStart maps Sunday to the previous Monday"],
    "errors": ["Expected values to be strictly equal: + '2026-09-28' - '2026-09-21'"],
    "location": "/home/dev/calendar/test/cal.test.js:14:1", "summary": "1 of 58 tests failed",
    "same_failure_as_run": null, "exit_code": 1 },
  { "n": 5, "outcome": "failed", "parser": "tap",
    "failing_tests": ["monthName rejects index 12"],
    "errors": ["Missing expected exception (RangeError)."],
    "location": "/home/dev/calendar/test/cal.test.js:14:1", "summary": "1 of 59 tests failed",
    "same_failure_as_run": null, "exit_code": 1 },
  { "n": 8, "outcome": "failed", "parser": "tap",
    "failing_tests": ["parseIso rejects month 13"],
    "errors": ["Missing expected exception (RangeError)."],
    "location": "/home/dev/calendar/test/cal.test.js:14:1", "summary": "1 of 60 tests failed",
    "same_failure_as_run": null, "exit_code": 1 }
 ],
 "edits": [
  { "n": 1, "path": "test/cal.test.js", "added_lines": 3, "removed_lines": 0,
    "diff": "+test(\"weekStart maps Sunday to the previous Monday\", () => {\n+  assert.equal(isoDate(weekStart(parseIso(\"2026-09-27\"))), \"2026-09-21\");\n+});" },
  { "n": 3, "path": "src/cal.js", "added_lines": 1, "removed_lines": 1,
    "diff": "-  return addDays(date, 1 - day);\n+  return addDays(date, -((day + 6) % 7));" },
  { "n": 4, "path": "test/cal.test.js", "added_lines": 3, "removed_lines": 0,
    "diff": "+test(\"monthName rejects index 12\", () => {\n+  assert.throws(() => monthName(12), RangeError);\n+});" },
  { "n": 6, "path": "src/cal.js", "added_lines": 1, "removed_lines": 0,
    "diff": "+  if (!Number.isInteger(index) || index < 0 || index > 11) throw new RangeError(`month index ${index}`);" },
  { "n": 7, "path": "test/cal.test.js", "added_lines": 3, "removed_lines": 0,
    "diff": "+test(\"parseIso rejects month 13\", () => {\n+  assert.throws(() => parseIso(\"2026-13-01\"), RangeError);\n+});" }
 ],
 "digest": {
  "failed_runs": 3, "distinct_failures": 3, "same_command_runs": [5, 8],
  "latest_failure_seen_before": false, "edits_between_failed_runs": 4,
  "information_calls_between_failed_runs": 0
 }
}
```

## Verdict

- **Shipped.** The stuck guard's structured evidence holds: accuracy 1.000 on the 40 stuck cases against 0.725 for the
  state it replaces, with the same 11-case, 0-loss sign test (p = 0.001) the design arm predicted, and the four noise
  traps at 1.00. Cost at p50 is +1.5 KB per stuck state and no measurable latency change (258 ms against 248 ms
  before, against 256 ms in the committed baseline).
- **More raw text still adds nothing.** B, which keeps the evidence and doubles the raw slices, changes no verdict.
- **Limits.** The digest counts what a label rule also counts ("a changed failure is progress"), so the accuracy is an
  upper bound, exactly as in the previous run; and the 11 recovered cases are the ones the previous run named. One
  judgment per case (single repeat) means the case-level sign test is over cases, not repeats. The `same_command_runs`
  digest key is not in the design arm; it is the only difference from the measured builder, and it changed nothing
  here (it is present in all 40 stuck cases, so it carries almost no information).
- **Unrelated finding.** The stuck `task` field is the user's last prompt as written, with no `redact()` applied. That
  is the state as it was before this change and it is unchanged here — the bench passes a pre-redacted task — but the
  field is not redacted by the guard itself.

## Files

`results.json` (answers, per-case verdicts, scores), `requests.jsonl` (arm, bytes, latency, outcome per request; no
state content). Reproduce: `npm run build && npm run eval:judge -- --repeats 1 --budget 300 --out eval/reports/<dir>`.
