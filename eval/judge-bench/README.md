# Judge bench

Labelled cases for the stuck and done guards, each sent to the real judge in three request states. The bench measures
what the judge gets to see; it does not change a guard.

```
npm run build
npm run eval:judge -- --dry-run                      # list cases and requests, send nothing
npm run eval:judge -- --repeats 3 --budget 900       # 80 cases x 3 arms x 3 repeats = 720 requests
npm run eval:judge -- --rescore eval/reports/<dir>   # re-score saved answers after a label fix
```

Options: `--repeats N` (default 1), `--concurrency N` (default 4), `--budget N` (hard cap on requests, also passed to
the TypeSafe client as `maxRequests`), `--seed N` (arm and case order), `--timeout MS` (per request, default 20000),
`--out DIR` (default `eval/reports/<date>-judge-bench`). Failed requests are retried once inside the budget.

## Cases

`cases.json` holds one line per case: `id`, `guard`, `label`, `category`, `format`, `source`, `why`, `task` (and
`errorAt` for stuck cases: where the error sits in a long log). `traces/<id>.trace` holds the tool calls in order, and
for done cases the final message (format in `trace.mjs`).

- **stuck** (40): 20 *progressing* (the failing test changes, the error changes, fewer tests fail, information
  gathering before a targeted edit, and progress that today's 400-char tail already shows) and 20 *stuck* (cosmetic
  edits, flags, reworded commands, and traps where only line numbers, timestamps, temp paths or ordering change).
- **done** (40): 20 *done* (a code change with a passing check after the last edit, doc-only and config-comment
  changes, questions) and 20 *not done* (no check, a failing check, a passing check that does not cover the changed
  files, a claim that contradicts the check, and docs mixed with one code change).

`source: real-tool` traces come from `capture.mjs`, which builds tiny throwaway projects in a temp dir, applies the
edits for real and runs node test (TAP), tsc, cargo, go, sbcl via make, and Python and Node scripts. Temp and home paths
are rewritten to `/home/dev/<project>` or `/tmp`. `source: authored` traces are written by hand in the tool's own output
format, for runners not installed where the bench was built (jest, vitest, pytest, eslint, Playwright) and for cases
with no tool output.

## Arms

All arms carry the guard's own `questions` object (`stuckQuestions`, `doneQuestions`).

- **A**: the real builders from the package (`makeAttempt` + `buildStuckRequest`; `classifyToolResult` +
  `recordOutcome` + `buildDoneRequest`).
- **B**: A with larger raw slices. stuck: head 400 + tail 400 of each output. done: plus the last 1500 chars of each
  check that ran after the last edit.
- **C**: A plus `evidence`. stuck: per failing run the parsed failing tests, errors, location and summary, and which
  earlier run failed the same way; per edit the path and a diff capped at 600 chars; a digest. done: changed files with
  type (code, test, doc, config), +/− lines, symbols and a comment-only flag; checks after the last edit with the
  parsed failure or pass summary; which changed code files the check output names.

`parse.mjs` is generic: it knows common runner shapes and falls back to an error line (`generic`) or to head+tail of
the output (`unparsed`). Its failure signature ignores durations, clock times, temp paths, thread ids, line:column
positions and ordering; other digits stay. Every string in every arm passes through `redact()`.

## Scoring

`score.mjs` applies the guards' own rules: stuck when the window is decided in code or `same_strategy >= 0.7`
(`config.stuck.sameStrategy`); not done when the run reaches the judge (`needsDoneCheck`), `claims_done >= 0.7`
(`config.done.claimsDone`), `outcome` is not `blocked`, and `verification_applies >= 0.5` (`APPLIES_THRESHOLD` in
`src/done.ts`). A done case with a passing check after the last edit never reaches the judge, so no arm can flag it.
The report gives accuracy, precision and recall for the positive class, Brier, agreement across repeats, bytes and
latency, the same per category, and an exact sign test of C and B against A over cases (majority verdict).

The request log (`requests.jsonl`) holds arm, bytes, latency and outcome per request, never state content.
