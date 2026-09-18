> **Before you run this: ask the user which model to use.** A batch is 60-150 headless
> sessions; each one sends the fixture, the rules, and every guarded call to a model,
> so a full run consumes hundreds of thousands of tokens and real money. Pass `--model
> <provider/model>` explicitly and get the user's agreement on the model and the number
> of runs first. `--dry-run` lists the planned runs without spending anything, and
> `--max-runs N` caps them. The runner refuses to start without an explicit `--model`
> unless you also pass `--yes`.

# A/B benchmark

Measures whether pi-warden improves the code an agent produces, against the honest
null hypothesis: the same rules handed to the model as prose.

- `fixture/`: a zero-dependency repo. `AGENTS.md` carries ten rules as prose;
  `pi-warden.md` carries the same ten for the warden cell. It also ships the traps
  themselves: a `scripts/build.mjs` + manifest that can be made to fail, a
  `scripts/deploy.sh` that writes a local release marker, dead code under
  `experiments/`, and endpoint values in `src/config.js` only.
- `tasks.mjs`: fifteen single-shot tasks and one decay arc, each with a `family`:
  `rules` (the original five), `project-only` (rules no model can know from training),
  `verification` (the reply's claims vs the checks the runner runs), `blast-radius`
  (a commit, push, deploy, or delete that rule 10 reserves for an explicit request),
  and `decay` (a twelve-turn arc, run with `--turns`).
- `check.mjs`: mechanical rule checker over the agent's diff. Shares no code with the
  guard on purpose: no Jev verdict can influence a score.
- `verify.mjs`: claim and action scorers. Claims come from the final assistant message
  in the run's session log and are compared with the runner's own `npm test` /
  `npm run build` result (a claim naming a test file is judged against that file).
  Actions come from the tool calls, parsed per command segment, plus the run's git
  state: commits, merges, deletions, and whether `origin/main` advanced.
- `env.mjs`: the environment a run may see. Credential-named variables whose value
  pi-warden itself would flag are dropped, so an environment dump cannot reach a model
  (`.local/shift-2026-09-18-eval-env-leak.md`).
- `reports/`: committed `report.md` + `runs.json` per run batch. Per-run evidence
  (session logs, tool output) stays local: it is heavy and never needed to reproduce.

Run: `npm run eval:ab -- --repeats 3 --concurrency 6 --model <provider/model>`. Each run
gets its own temp project, its own local bare `origin`, and its own
`PI_CODING_AGENT_DIR` seeded with your provider credentials and exactly one extension
(pi-warden, in the warden cell), so the two cells differ by that extension alone.
Runs are independent, so they run several at a time; `--concurrency` sets how many pi
processes are in flight. Use `--keep` to leave the temp dirs for inspection and
`--turns N` to chain a decay arc into one session.

Interpretation rules: quote the report folder next to every claim; quote the offending
sentence for a false claim; a negative stays in the table; a claim that does not
survive a re-run on your model gets rewritten.
