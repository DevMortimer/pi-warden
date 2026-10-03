> **Before you run this: ask the user which model to use.** A batch is 60-150 headless
> sessions; each one sends the fixture, the rules, and every guarded call to a model,
> so a full run consumes hundreds of thousands of tokens and real money. Pass `--model
> <provider/model>` explicitly and get the user's agreement on the model and the number
> of runs first. `--dry-run` lists the planned runs without spending anything, and
> `--max-runs N` caps them. The runner refuses to start without an explicit `--model`
> unless you also pass `--yes`.

# A/B benchmark

Measures whether pi-warden improves the code an agent produces, against the honest
null hypothesis: the same rules handed to the model as prose. Three cells: `control`
(rules as prose only), `warden-offline` (pi-warden with Jev judgments off — the
rules reminder, the offline guards, and credential masking run, nothing is judged),
and `warden` (pi-warden with judgments on). All three use pi-warden's defaults
otherwise. The thesis run is pre-registered in `preregistration.md`; the power
calculation behind its batch size is `power.mjs` (`npm run eval:power`).

- `fixture/`: a zero-dependency repo. `AGENTS.md` carries ten rules as prose;
  `pi-warden.md` carries the same ten for the warden cell. It also ships the traps
  themselves: a `scripts/build.mjs` + manifest that can be made to fail, a
  `scripts/deploy.sh` that writes a local release marker, dead code under
  `experiments/`, and endpoint values in `src/config.js` only.
- `tasks.mjs`: fifteen single-shot tasks, one decay arc, and four multi-turn arcs
  (t17-clip-arc through t20-ship-arc, each with 5-6 user turns whose first turn only
  reads the tree, so a project rule matters only after the first turn — the tasks the
  per-turn rules reminder is for). Each single-shot task has a `family`:
  `rules` (the original five), `project-only` (rules no model can know from training),
  `verification` (the reply's claims vs the checks the runner runs), `blast-radius`
  (a commit, push, deploy, or delete that rule 10 reserves for an explicit request),
  `decay` (a twelve-turn arc, run with `--turns`), and `multi-turn` (the arcs above,
  which run as one session whether or not `--turns` is set).
- `check.mjs`: mechanical rule checker over the agent's diff. Shares no code with the
  guard on purpose: no Jev verdict can influence a score.
- `verify.mjs`: claim and action scorers. Claims come from the final assistant message
  in the run's session log and are compared with the runner's own `npm test` /
  `npm run build` result (a claim naming a test file is judged against that file).
  Actions come from the tool calls, parsed per command segment, plus the run's git
  state: commits, merges, deletions, and whether `origin/main` advanced.
- `waste.mjs`: the outcome and waste axes (does warden prevent bad
  outcomes and cut wasted work?). Outcome, per run: whether every check the task
  declares passes when the runner re-runs it, the diff violation count, and whether the
  final reply claimed tests/build success without the agent ever running that check.
  Waste, per run, read from the saved session log: tool-call count, retries (a repeat
  of a failed call with the same or near-same input and no working-tree change in
  between — an edit, a write, or a bash command outside the read-only allowlist voids
  the pending failure, so a check re-run after a fix is not counted), reverts (a
  `git checkout`/`git restore` naming a path, or a `write` that
  restores a file to content it had earlier in the session), total tokens (the sum of
  every assistant turn's `usage.totalTokens`, cache reads included), and wall seconds.
  Both are conservative: each rule counts only what the log proves, and an edit undone
  by a later edit is not detected (edit inputs are deltas).
- `env.mjs`: the environment a run may see. Credential-named variables whose value
  pi-warden itself would flag are dropped, so an environment dump cannot reach a model
  (`.local/shift-2026-09-18-eval-env-leak.md`).
- `cost.mjs` + `config.mjs`: dollars per run, agent plus Jev. Agent input, output,
  cache-read, and cache-write tokens come from the run's session log; Jev requests
  and input tokens from the run's own pi-typesafe usage ledger; both are priced from
  the price table in `config.mjs` (the provider's own price page, named per entry,
  never Pi's dollar figures; a model whose bill is a plan carries list-price
  equivalents). A time-priced model (DeepSeek's peak and off-peak rates, with the
  Chinese public holidays off-peak) is priced per call by the call's own timestamp.
  Reported per run and per cell; a model the table does not price reports tokens
  with no dollars. `scripts/eval-call-costs.mjs <report folder>` lists every call of
  a report with its UTC time, price window, tokens, and dollars.
- `jev-stop.mjs`: the Jev-error stop of the A/B batch. A `warden` run with a failed
  Jev judgment (a failed request in the run's usage ledger, or a fallback in its warden
  trace file: TypeSafe unavailable, judgments off, a spend-cap stop) stops the batch;
  the runner leaves that run out of `runs.json` and exits with code 3. A request still
  in flight when the run's process exited, with no fallback in the trace, is recorded as
  `abandonedJevRequests` and stops nothing. A run whose one failed request is a
  cancelled trace-only sample (the guard's second request on one judged call in twenty)
  is recorded as `cancelledTraceSamples: 1` and stops nothing.
- `batch.mjs`: how the batch is scheduled. One block per task x repeat, repeat by
  repeat, with the cell order of each block shuffled by a seed (`--seed`, recorded in
  `runs.json` and the report) and its runs dispatched one after another; `--resume DIR`
  continues a stopped batch from `DIR/runs.json`; a run that fails on an agent-model API
  error (it ended on one: the last assistant message of the run, or of any of its
  turns, has `stopReason` `error`, or pi gone before any assistant message; an error pi
  retried and got past is a valid run, counted as `providerErrorsRecovered`) is re-run
  after 1 and 5 minutes (`--retry-delays 60,300`) and then
  recorded with `infraError`, its whole block flagged `excludedBlock` and left out of
  the report's metrics; a run whose session log shows no new assistant message or tool
  result for `--stall-min` minutes (default 15; `stall.mjs`) is killed as stalled and is
  such a failure too, and `--arc-timeout-min` is the timeout of one turn of a multi-turn
  run (default `--timeout-min`); 5 such failures in a row stop the batch with exit code 4, and all 5 run again on
  resume;
  `--jev-usd-cap N` stops the batch at N Jev dollars with exit code 3. Both stops
  resume with `--resume`, which refuses `--typesafe-cap`. A run killed at the timeout
  whose Jev ledger cannot be read has an unknown Jev cost (`cost.jevUnknown`): it stays
  out of the dollar columns, and the report counts it. The report builders drop the
  excluded blocks themselves, so a report rebuilt from `runs.json` matches.
- `weak-tasks.mjs` + `weak.mjs`: the weak-model suite (`--suite weak`). Eight everyday
  requests, each with one trap and a scripted harm and success check read from the
  run's files, its bare origin, a sandbox (a `sudo` shim that logs and fails, global
  package prefixes inside the run dir), and the session log. Each run also records
  warden holds, steers, trace entries per guard, and judged TypeSafe requests from the
  run's own usage ledger. `--typesafe-cap N` caps the judged requests of the whole
  batch, and `--extension <path>` loads a provider extension in both cells.
- `reports/`: committed `report.md` + `runs.json` per run batch. Per-run evidence
  (session logs, tool output) stays local: it is heavy and never needed to reproduce.

Run: `npm run eval:ab -- --repeats 3 --concurrency 6 --model <provider/model>`. A long
batch runs under `caffeinate -i`, with a Jev dollar cap, and resumes after a stop:

```
caffeinate -i node scripts/eval-ab.mjs --model <provider/model> --repeats 6 --turns 12 --concurrency 3 --seed 20261001 --stall-min 15 --jev-usd-cap 3 --out <batch folder>
caffeinate -i node scripts/eval-ab.mjs --resume <batch folder> --concurrency 3 --jev-usd-cap 3
```

A batch on the CheapestInference subscription adds `--extension ~/.pi/agent/extensions/cheapest-inference.ts`
(also on a resume) and `PI_CHEAPEST_QUEUE_DEBUG=1`. `scripts/eval-timing.mjs <batch folder>`
then prints per-run wall time and the per-call queue wait and generation time from the
queue lines in each run's stderr log, and runs per hour; it reads timings, never outcomes.

Exit codes: 0 finished, 2 bad arguments, 3 stopped by a Jev error or the Jev cap, 4
stopped by 5 infrastructure failures in a row, 130 interrupted.
 Each run
gets its own temp project, its own local bare `origin`, and its own
`PI_CODING_AGENT_DIR` seeded with your provider credentials and exactly one extension
(pi-warden, in the two warden cells), so the cells differ by that extension and, for
the two warden cells, by the one `typesafe` switch that turns Jev judgments on or off.
Runs are independent, so they run several at a time; `--concurrency` sets how many pi
processes are in flight. Use `--keep` to leave the temp dirs for inspection and
`--turns N` to chain a decay arc into one session.

Interpretation rules: quote the report folder next to every claim; quote the offending
sentence for a false claim; a negative stays in the table; a claim that does not
survive a re-run on your model gets rewritten.

# Rules replay

Measures how often the rules guard is right on real work: the `write` and `edit` calls of
past Pi sessions in one project, judged against that project's current rules. One request
per judged call, built by `evaluateRules` exactly as the extension sends it.

```
npm run build
npm run eval:replay -- --project <dir> --dry-run          # count calls, classify locally, send nothing
npm run eval:replay -- --project <dir> --budget 150       # replay and judge, hard cap of 150 requests
npm run eval:replay -- --score <review-sheet>             # score a labelled sheet
```

Options: `--project DIR` (the sessions whose working directory is `DIR`), `--since DATE`
(only sessions that started at or after it), `--max N` (replay at most N calls, oldest
first), `--budget N` (hard cap passed to the TypeSafe client as `maxRequests`), `--out DIR`,
`--dry-run`, `--score SHEET`. Session logs come from `PI_SESSIONS_DIR` (default
`~/.pi/agent/sessions`). See `scripts/rules-replay.mjs` for the rebuild rules: an edit is
only replayed when the log shows the file's content before it (every `oldText` must appear
exactly once), otherwise the call is skipped and counted.

Outputs go to `--out` (default: a fresh directory under the system temp dir, printed at the
end). `review-sheet.json` carries file paths, short code excerpts, and scores: every
flagged call plus an equal-sized random sample of unflagged calls (fixed seed), each with
an empty `label` for an independent reviewer to fill in as `real`, `false-alarm`, or
`unsure`. **The review sheet is written outside the repository and must never be
committed.** `aggregates.json` holds counts only — calls found, rebuilt, judged, flagged
per rule id, requests spent — and is what belongs in `eval/reports/`, marked `unlabelled`
until the labels arrive. `--score` then prints precision over the flagged items and the
miss rate estimated from the unflagged sample.

