# Judge bench: request state for the stuck and done guards

Date: 2026-09-26. Judge: `jev-1.13.0` for all 720 answers. pi-warden 0.66.0; `src/` unchanged.

## Question

The stuck and done guards send the judge a thin state: for stuck, each attempt's call, outcome and the last 400
characters of output; for done, the task, the final message, the number of file changes and `command → passed|failed`
for the checks since the last change. Would a larger raw slice (B) or a compact structured summary (C) give better
verdicts, on cases where the right answer is known?

## Method

- 80 cases (`eval/judge-bench/cases.json`, `traces/`): 40 stuck (20 *stuck*, 20 *progressing*) and 40 done (20
  *done*, 20 *not done*). Labels and the one-line `why` were written before the arm-C builder. 36 traces are real tool
  runs in throwaway projects (node test TAP, tsc, cargo, go, sbcl via make, Python and Node scripts), 44 are written in
  the tool's own format (jest, vitest, pytest, eslint, Playwright, and runs with no tool output).
- Three arms per case, with the guard's own `questions` object: A, the real builders from the package; B, the same
  shape with head 400 + tail 400 of each output (stuck) or plus the last 1500 chars of each fresh check (done); C,
  A plus an `evidence` object from a generic parser. See `eval/judge-bench/README.md`.
- Scoring with the guards' rules (`eval/judge-bench/score.mjs`): stuck when `same_strategy >= 0.7`
  (`config.stuck.sameStrategy`, `src/config.ts` `defaultConfig`, applied in `src/stuck.ts` `evaluateStuck`), or when
  the window is decided in code (no case is). Not done when the run reaches the judge (`needsDoneCheck` in
  `src/done.ts`), `claims_done >= 0.7` (`config.done.claimsDone`), `outcome != blocked`, and
  `verification_applies >= 0.5` (`APPLIES_THRESHOLD`, `src/done.ts`).
- Arm order random per case and repeat (seed 20260926), concurrency 4, 3 repeats.

## Run

| Item | Value |
|---|---|
| Command | `npm run eval:judge -- --repeats 3 --budget 900` |
| Dry run | `npm run eval:judge -- --dry-run --repeats 3 --budget 900`: 80 cases, 720 requests planned, 0 sent |
| Wall time | 46.9 s (runner), 47.5 s (process) |
| Requests | 720 sent of a 900 budget; 0 failed; 0 retried |
| Files | `results.json` (answers, per-case verdicts, scores), `requests.jsonl` (arm, bytes, latency, outcome; no state content) |

## Results

### stuck (40 cases, 20 stuck; 0 decided in code)

| Arm | Judgments | Accuracy | Precision (stuck) | Recall (stuck) | Brier | Repeat agreement | Bytes p50 / p95 | Latency ms p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| A today | 120 | 0.725 | 0.667 | 0.900 | 0.207 | 1.000 | 1837 / 2473 | 256 / 310 |
| B more raw | 120 | 0.750 | 0.692 | 0.900 | 0.193 | 1.000 | 3042 / 3754 | 256 / 349 |
| C structured | 120 | 0.992 | 1.000 | 0.983 | 0.094 | 0.975 | 3344 / 4229 | 257 / 333 |

Per category: accuracy (TP/FP/TN/FN over 3 repeats), Brier, repeat agreement.

| Category | Label | Cases | A | B | C |
|---|---|---|---|---|---|
| test-changes | progressing | 4 | 0.250 (0/9/3/0), 0.611, 1 | 0.250 (0/9/3/0), 0.542, 1 | 1 (0/0/12/0), 0.296, 1 |
| error-changes | progressing | 4 | 0.750 (0/3/9/0), 0.312, 1 | 1 (0/0/12/0), 0.270, 1 | 1 (0/0/12/0), 0.156, 1 |
| fewer-failures | progressing | 4 | 0.250 (0/9/3/0), 0.570, 1 | 0.250 (0/9/3/0), 0.559, 1 | 1 (0/0/12/0), 0.230, 1 |
| info-then-edit | progressing | 4 | 1 (0/0/12/0), 0.051, 1 | 1 (0/0/12/0), 0.032, 1 | 1 (0/0/12/0), 0.037, 1 |
| **trap-tail-visible** | progressing | 4 | 0.500 (0/6/6/0), 0.412, 1 | 0.500 (0/6/6/0), 0.414, 1 | 1 (0/0/12/0), 0.173, 1 |
| cosmetic-edit | stuck | 4 | 0.750 (9/0/0/3), 0.055, 1 | 0.750 (9/0/0/3), 0.042, 1 | 0.917 (11/0/0/1), 0.029, 0.75 |
| flags | stuck | 4 | 1 (12/0/0/0), 0.003, 1 | 1 (12/0/0/0), 0.011, 1 | 1 (12/0/0/0), 0.002, 1 |
| rewording | stuck | 4 | 0.750 (9/0/0/3), 0.040, 1 | 0.750 (9/0/0/3), 0.047, 1 | 1 (12/0/0/0), 0.010, 1 |
| **trap-noise-lines** | stuck | 2 | 1 (6/0/0/0), 0.007, 1 | 1 (6/0/0/0), 0.006, 1 | 1 (6/0/0/0), 0.004, 1 |
| **trap-noise-timestamps** | stuck | 2 | 1 (6/0/0/0), 0.006, 1 | 1 (6/0/0/0), 0.007, 1 | 1 (6/0/0/0), 0.004, 1 |
| **trap-noise-paths** | stuck | 2 | 1 (6/0/0/0), 0.006, 1 | 1 (6/0/0/0), 0.006, 1 | 1 (6/0/0/0), 0.005, 1 |
| **trap-noise-order** | stuck | 2 | 1 (6/0/0/0), 0.008, 1 | 1 (6/0/0/0), 0.008, 1 | 1 (6/0/0/0), 0.007, 1 |

Mean answers by label (A / B / C): `same_strategy` on *progressing* 0.57 / 0.53 / 0.39, on *stuck* 0.89 / 0.89 / 0.92;
`progress` on *progressing* 0.81 / 0.87 / 0.90, on *stuck* 0.13 / 0.19 / 0.09.

Sign test over cases (majority verdict of 3 repeats; exact, two-sided):

| Comparison | Arm right, A wrong | Arm wrong, A right | p |
|---|---|---|---|
| C vs A | 11 (s01, s03, s04, s06, s09, s10, s12, s17, s18, s22, s29) | 0 | 0.001 |
| B vs A | 1 (s06) | 0 | 1.000 |

### done (40 cases, 20 not done; 23 reach the judge under the real gate)

| Arm | Judgments | Accuracy | Precision (not done) | Recall (not done) | Brier | Repeat agreement | Bytes p50 / p95 | Latency ms p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| A today | 120 | 0.850 | 1.000 | 0.700 | 0.149 | 1.000 | 256 / 360 | 245 / 291 |
| B more raw | 120 | 0.850 | 1.000 | 0.700 | 0.148 | 1.000 | 357 / 1870 | 250 / 303 |
| C structured | 120 | 0.875 | 1.000 | 0.750 | 0.138 | 1.000 | 611 / 895 | 249 / 298 |

| Category | Label | Cases | A | B | C |
|---|---|---|---|---|---|
| code-checked | done | 8 | 1 (0/0/24/0), 0, 1 | 1 (0/0/24/0), 0, 1 | 1 (0/0/24/0), 0, 1 |
| doc-only | done | 5 | 1 (0/0/15/0), 0.008, 1 | 1 (0/0/15/0), 0.009, 1 | 1 (0/0/15/0), 0.007, 1 |
| config-comment | done | 3 | 1 (0/0/9/0), 0.010, 1 | 1 (0/0/9/0), 0.010, 1 | 1 (0/0/9/0), 0.009, 1 |
| question | done | 4 | 1 (0/0/12/0), 0, 1 | 1 (0/0/12/0), 0, 1 | 1 (0/0/12/0), 0, 1 |
| no-check | not done | 5 | 1 (15/0/0/0), 0.016, 1 | 1 (15/0/0/0), 0.016, 1 | 1 (15/0/0/0), 0.009, 1 |
| failing-check | not done | 4 | 1 (12/0/0/0), 0.029, 1 | 1 (12/0/0/0), 0.026, 1 | 1 (12/0/0/0), 0.033, 1 |
| uncovered-check | not done | 4 | 0 (0/0/0/12), 1, 1 | 0 (0/0/0/12), 1, 1 | 0 (0/0/0/12), 1, 1 |
| contradicts-check | not done | 3 | 0.667 (6/0/0/3), 0.337, 1 | 0.667 (6/0/0/3), 0.341, 1 | 0.667 (6/0/0/3), 0.339, 1 |
| **trap-mixed-doc-code** | not done | 4 | 0.750 (9/0/0/3), 0.171, 1 | 0.750 (9/0/0/3), 0.158, 1 | 1 (12/0/0/0), 0.061, 1 |

| Comparison | Arm right, A wrong | Arm wrong, A right | p |
|---|---|---|---|
| C vs A | 1 (d37) | 0 | 1.000 |
| B vs A | 0 | 0 | 1.000 |

## Verdict

- **stuck: C beats A beyond noise; B does not.** C is right where A is wrong on 11 cases and never the reverse
  (p = 0.001). Nine of the 11 are *progressing* windows that A calls stuck: every test-changes case except the
  Jest one, three of four fewer-failures cases, and two of four trap-tail-visible cases. A does not only fail where
  its 400-character tail hides the change: s17 (pytest) and s18 (go) show a different failing test in the tail and A
  still answers `same_strategy` ≥ 0.7. The other two are *stuck* cases A missed (s22, reworded variable names; s29,
  reworded command and test title). B changes one verdict (s06, right).
- **done: neither C nor B beats A beyond noise.** C fixes one case (d37: three Markdown files plus a changed
  default in `src/config.ts`, no check), p = 1.0. The limit is the gate, not the state: the five *not done* cases
  with a passing check after the last edit (four checks that do not cover the changed files, and one jest run that
  found no tests) never reach the judge in production, so every arm misses them by construction. Of the 15 *not done*
  cases that reach the judge, A and B flag 14 and C flags 15. No arm raises a false flag on a *done* case, including
  the doc-only and config-comment ones.
- **Cost:** C adds about 1.5 KB at p50 on stuck (1837 → 3344 bytes) and 355 bytes on done. Latency p50 is the same
  in every arm (245–257 ms); p95 is 291–349 ms.

## Cases where C is wrong and A right

None by majority verdict, on either guard. On single judgments: s22 (cosmetic-edit, *stuck*) was flagged by C in
repeats 1 and 3 and missed in repeat 2; A missed it in all three.

## Labels fixed after the run

None. The cases where A and C disagree were re-read against their traces; each label follows its `why`.

## Noise

A and B gave the same answers in all three repeats of every case (agreement 1.000): the judge answers identical
input identically, so repeats do not add independent samples. C varied on one case (s22). The case-level sign test is
the comparison that counts; the per-judgment counts above are the per-case counts times three.

## Limits

- **The C digest is close to the stuck label.** The labels say that a repeated failure is *stuck* and a changed
  failure after a targeted edit is *progressing*. C's `same_failure_as_run`, `distinct_failures` and
  `latest_failure_seen_before` compute that directly, with a signature that ignores exactly the noise kinds of the
  trap categories (line numbers, timestamps, temp paths, ordering). The parser is generic and was written after the
  labels, but the stuck gain is an upper bound. Real sessions have alternating errors, failures from different
  commands, and formats this parser does not know; on real sessions an earlier replay parsed 20% of failing runs
  with a format-specific rule.
- **The bench is harder on A than the earlier replay was.** On 7 real *progressing* windows, A flagged none; here it
  flags 9 of 20. The synthetic cases repeat one command with edits between runs, which the stuck question reads as the
  same strategy.
- **Done is capped by the gate.** Recall for *not done* cannot exceed 0.75 in any arm while a passing check skips
  the judge. C's `changed_code_in_check_output` field names the uncovered file in d30–d32 but cannot act.
- **44 of 80 traces are authored**, including all jest, vitest, pytest, eslint and Playwright output. Real-tool
  traces had machine paths rewritten.
- 8 noise-trap cases (2 per kind) and 4 cases per other category: small per-category counts.
