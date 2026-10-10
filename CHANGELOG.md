# Changelog

Notable changes to pi-warden, newest first. Versions follow semver. The published surface is `dist/` plus `README.md`; changes under `eval/`, `scripts/`, and `docs/` are repo tooling and ride along with the next release.

How to keep this current: add the entry in the same pull request as the change, under `Unreleased`. The release commit renames `Unreleased` to the version it ships and adds its own notes. Entries before 0.10.0 are one-line summaries taken from the release commit headers; the detail for those is in `git log`.

## Unreleased

## 1.5.0

### Added

- The config panel has selectors for mode, judgment backend, widget placement and bar mode, conscience skill mode, and recall tool. Left/right wraps through supported values; Enter saves the chosen field and Esc cancels. Invalid values and custom backends remain intact until a choice is made, and other staged edits keep their existing `s` save behavior. ([Configuration](docs/configuration.md#user-config))

## 1.4.0

### Added

- When the session runs in a [herdr](https://herdr.dev) pane, a warden confirm dialog now reports through herdr's `herdr:blocked` channel while it waits, so the pane's sidebar shows blocked instead of working. Interactive sessions only; no emission on hold-steers or headless runs. ([Guards](docs/guards.md#herdr-pane-state))

## 1.3.1

### Fixed

- The commands that send their own prompt to the agent (`/warden init`, `/warden rules tune`, `/warden audit`, `/warden index`) no longer swallow it. Each set its busy flag before `sendUserMessage`, and the busy-flag guard on the `input` event saw the command's own prompt (which arrives with `source: "extension"`) and answered "handled", so no run ever started and the command reported the file (or report, or index) was never created — every time, deterministically. The guard now waits only for operator input (`interactive`/`rpc`); warden's own prompt passes and, like any user prompt, invalidates in-flight conscience assessments.
- Those commands also no longer report before the run they injected ends. Pi's extension-facing `sendUserMessage` is fire-and-forget, so the `await ctx.waitForIdle()` that followed it could return before the injected run even flipped the session busy — the command reported while the agent was still working, or its status message was steered into the next run instead of recorded. Each command now waits in two phases: first for `before_agent_start` carrying the prompt it sent (30 seconds; on a miss — a preflight failure or another extension handling the input — it clears its flag and reports right away instead of blocking operator input), then for `agent_end` of that run with no cap (pi emits it on an abort too, so Esc still ends the wait), and finally for the host to go idle so the status message is recorded rather than steered.

### Tests

- A real-session e2e runs `/warden init` the way Pi does (the shipped entry in a real agent session with a scripted model): the injected prompt reaches the model, the agent's write call lands, and "pi-warden.md created" is recorded only after the run ended. Two unit tests pin the guard (extension input passes while a flag is set, operator input waits) and the wait (the command does not report before the run starts or ends). The session-test `write` stub now really writes, relative to the session directory, so the e2e can prove the file on disk.
## 1.3.0

### Added

- The cause-check guard (on by default, `cause.enabled`): when the final reply of a run states a likely cause, or asks a person to check something the agent could inspect itself, and no tool result in that run checked it, pi-warden sends the reply back with one follow-up turn: check the cause with its own tools (a query, a log, a file, or a command) and give the evidence, or say plainly that the cause is unverified and why it cannot check it. It is the sibling of the done-check. An offline pre-filter (`causePreFilter`) fires on causal and hand-off wording, so a reply about results or next steps spends no request; the guard asks Jev whether the reply states a cause or hands off a check, whether the run checked it, and, when the project has an earlier unchecked cause inside the window, which earlier cause the reply repeats. The request carries the task, the final message, the last 40 of the run's tool calls, and up to five earlier redacted cause sentences with their keys and dates. Each unchecked cause is stored per project for `cause.windowDays` (default 7) as the redacted sentence that states it; a later reply whose cause Jev matches to an earlier one gets a stronger steer that names the earlier date, and a reply that hands a check to a person gets a steer that says so. When the done-check steers the same reply, the cause-check records its decision in the trace and sends no steer, so one reply gets at most one end-of-run steer. The repeat history lives in a `causes` table in the same owner-only database as the hold log, and every request, stored summary, and trace line passes through `redact()`.

### Docs

- `docs/guards.md` describes the new cause-check; `docs/configuration.md` lists its keys, widget template, and tokens; `docs/data-handling.md` and the consent notice name the cause-check request and its stored repeat history; `README.md` lists the guard next to the done-check.
- `eval/reports/2026-10-07-cause-check/` measures the offline pre-filter on recorded sessions: the totals, the flagged count, and how many of a 20-reply sample were real unchecked causes.

## 1.2.0

### Added

- The action guard reads a script a command runs from disk and applies the same pattern floor and ask gate to its body: `bash FILE`, `./FILE`, `source FILE` and `. FILE`, `npm`/`pnpm`/`yarn`/`bun` scripts from `package.json` (with `preNAME` and `postNAME`), `make TARGET` or the default target, and `node`/`python`/`python3`/`ruby`/`perl`/`deno run FILE`. A body is read only when it resolves, after symlinks, inside the project root or a temp root, as a regular file of at most 64 KB, and one level deep. A body hit keeps the id and severity it has when typed directly and its label names the source (`(via cleanup.sh)`, `(via npm run clean)`); `action.exemptRules` and user `commandRules` apply to it; a body hit makes the ask gate ask with `runs a script with <shape>`; and the body lines that hit ride the request to Jev as `script_lines`, redacted and bounded to five lines and 600 characters.

- `/warden status` shows the build that runs: the pi-warden version, the checkout commit when the package is a git tree, the `dist/extension.js` build time, and the loaded pi-typesafe version. Session start warns once when a `src/` file is newer than the build (`pi-warden runs an old build: run npm run build`) and once when the loaded pi-typesafe version is outside the range in `package.json`.

### Changed

- The done-check nudge names one check command instead of "whatever exists": the last check that passed earlier in this session in this project, else the `check` then `test` script of the project's `package.json` run with the package manager its lock file names (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` or `bun.lock`, else npm), else the same `Makefile` targets; with none of those it keeps the generic ask. The UI nudge names the last local URL a tool result printed this session (`http://localhost:PORT`, `127.0.0.1`, `[::1]`) when there is one.
- Done-check UI proof now counts only what shows the page to the agent: a successful tool result that contains an image, a page text snapshot (`agent-browser snapshot`, `agent-browser get text`, the MCP `take_snapshot` tool), a browser or device test run (`playwright test`, `flutter test` with `integration_test` or golden tests), or a `read` of an image file. A screenshot command that only writes a file (`agent-browser screenshot PATH`, `idb screenshot`, `xcrun simctl io … screenshot`, `chrome --headless --screenshot`), `agent-browser` `open`/`close`/`click`/`fill`/`set`/`wait`/`eval`, and MCP navigation tools no longer count; a saved screenshot counts once something reads it. The `done.visualTools` defaults match, and every config key still works.
- pi-typesafe `^0.9.1` (was `^0.9.0`).
- `npm run check` builds before it tests, so the offline suite exercises a fresh `dist/` (the entry Pi ships) instead of a stale one.

### Fixed

- The done-check counts a shell command as a check only when a check runner starts one of its shell segments, after `cd DIR`, environment assignments, and `timeout`/`time`/`env`/`npx`/`pnpm exec`/`bunx`/`yarn`/`uv run`/`poetry run`/`python -m` wrappers (a wrapper is stripped only when what follows does not start a runner, so `yarn test` and `yarn run lint` are checks). A runner name in an argument (`grep -n jest package.json`, `which eslint`, `npm view vitest version`) no longer counts as a check.
- A check run counts as proof only when it really ran and its output agrees: a failure summary is a failed check even with exit code 0, and a visible failure stays a failed check also with a passing summary; a summary that reports zero tests (`Tests: 0 total`, `[no tests to run]`, and similar) is never a check, unless a line of the output shows tests did run (cargo doc-tests after real results, a package a `go test` filter skipped); and when the shell can hide the exit code of any runner segment (a pipe right after its segment without `set -o pipefail`, or a `||`, `;`, or newline with more commands anywhere after it) the exit code is no proof — with no runner summary the run is not a check at all. Each run that names a runner but does not count gets one trace-only detail with the reason and no command; the reason names the word after the hiding separator only when it is a bare command name.
- The done-check reads more runner summaries as proof: vitest, pytest without the `===` frame (`-q`), mypy, ruff (check, format, and `--fix`), black, prettier, biome, tsc pretty output, eslint, bun, mocha, playwright, flutter, deno, and cargo build, check and clippy; and the generic wrapper failure lines (`make: *** … Error N`, `npm error Lifecycle script … failed`, `npm ERR! code ELIFECYCLE`, pnpm and yarn `Command failed with exit code N`). The generic lines decide only when a runner starts the command, so a failed `npm install` is not a failed check. A failure marker anywhere in the tail wins over a passing one (black and ruff format `N files would be reformatted` beside `N files would be left unchanged.`, any go `FAIL` line, any cargo `test result: FAILED.` after an `ok`, pytest `2 passed, 1 error`, an indented or `pkg:test:`-prefixed vitest summary), a generic failure line overrides a passing summary in the same output, and the `Finished` line proves a `cargo build`, `cargo check` or `cargo clippy` segment only.
- The done-check recognises more runner forms and reports: a runner started by a path (`.venv/bin/pytest`, `node_modules/.bin/tsc`), `python3.12 -m` and `.venv/bin/python -m` followed by a runner or `unittest`, wrappers with options (`timeout -s KILL 60`, `uv run --with httpx`, `npx -y`), package-manager options (`pnpm -C web test`, `npm --prefix web test`, `yarn workspace api test`), `make -C web test`, and `bash -c "npm test"`; the last exit code the agent printed with `echo`/`printf` (`$?`, or `${PIPESTATUS[0]}` after a pipe); a silent runner (`tsc`, `eslint`, `flake8`, `go vet`, `go build`) named in its own segment whose output is empty behind a pipe to `tail`, `head`, `tee`, or `cat`; and a hidden runner is covered only by its own printed exit code, its own silent pass, or a summary verdict. A command is first stripped of data text and a backslash-newline continuation is joined, so a runner word in a commit message or heredoc body is not a check. A bare `npm ci` or `bun ci` installs and does not count, a runner sent to the background with `&` does not count, and a visible failure stays a failed check when another runner's exit code is hidden.
- With pi-typesafe 0.9.1 the usage ledger no longer loses counts when several Pi sessions run at once, so the reported spend and the daily caps count every session.

### Tests

- A new offline session test loads pi-warden the way Pi does (`package.json` → `pi.extensions` → `extensions/index.js` → `dist/extension.js`) into a real agent session with a scripted model, and asserts on the session's messages: a held destructive bash call, a done-check nudge after an unverified completion, and the repeat note after the same failing read twice. It fails with `run npm run build first` when the shipped entry is missing.

### Docs

- `docs/commands.md` describes the `/warden status` build line; `docs/ci-cd.md` states the new `npm run check` order (typecheck, build, offline tests).




## 1.1.2

### Fixed

- The build removes `dist/` outputs whose `src/` source is gone. `tsc` never deletes an output whose source was removed, so stale files from other branches shipped with `1.1.1`: 17 files (`conscience-config`, `conscience-loader`, `conscience-policy`, `conscience-privacy`, `jev`, `laya-download`, `laya-judge`, `tool-recommendation`, each as `.js` and `.d.ts`, plus `extension.js.bak`) that nothing imports. Users need to do nothing.

## 1.1.1

### Fixed

- `scripts/live-smoke.mjs` and `scripts/security-cases.mjs` no longer crash when a verdict has no off-task answer, which is now the usual case: the acting request does not ask `off_task`, only the trace sample does. The missing value prints as `-`.
- The three off-task cases in `scripts/security-cases.mjs` (side comment, take over previous work, new instruction overrides history) pass `traceSample: 1`, so every call asks the off-task question and the cases test its answer again.

## 1.1.0

### Added

- `"typesafeBackend": "liquid"` sends judgments to Liquid AI (api.liquid.ai, key in `LIQUID_API_KEY`, default model `d1:free`) through pi-typesafe 0.9.0. `d1:free` is free but slow (median about 14 seconds a request against the 5-second default `timeoutMs`), and the paid `d1` counts the state once per question, so a 7-question action request costs several times what it costs on Jev; see [docs/configuration.md](docs/configuration.md#liquid-ai-backend).

### Changed

- pi-typesafe `^0.9.0` (was `^0.8.0`).

## 1.0.1

### Fixed

- The run-end rules check no longer judges files that a `git pull` brought in when the pulled commit was made during the run, such as a squash commit from a pull request merged on the hosting service: a commit counts as brought by git when this worktree's HEAD reflog shows that the checkout did not create it, whatever its date. The commit-date rule stays as the fallback when the reflog is off.

## 1.0.0

The first stable release. From 1.0, pi-warden follows semver for the surface the README's Versioning section lists. Coming from 0.74.1, the last release on npm: [docs/upgrading.md](docs/upgrading.md) lists the removed settings, the new defaults, and what project files may still change. The changes since 0.74.1 are in the sections 0.75.0 to 0.90.0 below, and the README's "What it costs" table gives the measured effect of each 1.0 change.

### Added

- `scripts/steer-calibration.mjs`: the blind-label steer measurement (draw the sample from a copy of the hold log, score the labels, gate the slices). `scripts/steer-ask-probe.mjs` measures a candidate question on the same labels, one request per call.
- `should_ask` in `scripts/action-candidates.mjs`: a reworded should-proceed question that asks whether any visible instruction covers the call. Recorded as a candidate only (never acted on); its measurement is blocked on the TypeSafe account balance.
- `eval/reports/2026-10-01-field-usage/`: the field report for 2026-09-16 to 2026-10-01 (1,168 sessions, 53,868 judged actions, 419 holds). It replaces the 2026-09-24 report as the source of the README numbers and the hero image.

### Changed

- `scripts/field-usage.mjs` classifies the steers it did not know: stuck-loop, off-task, security-weakness, open-loop, subagent-report, repeat-note, action-warning, and tool-or-skill reminder messages, and the turn-rules message for a change made by a command. "Other" falls from 239 of 1,834 steers (13.0%) to 10 (0.5%) over 2026-09-16 to 2026-10-01, and from 152 of 473 (32.1%) to 5 (1.1%) over 2026-09-25 to 2026-10-01. The JSON report carries rule counts, not rule names.

### Docs

- `README.md` describes what 1.0 ships: the ask gate, approval on demand, rules at turn start, the local conscience ranking, scratch deletes, credential masking that leaves code values alone, the stricter-only project config, and the hold database (what it keeps, the 90-day prune of allowed rows). A "What it costs" section gives each change's measured effect with its source. A hold no longer reads as needing Jev: the offline floor holds destructive patterns, and Jev adds holds at `irreversible` 0.9 or more. The hero image and the Receipts numbers come from the new field report.
- `docs/guards.md`: the Action guard step for Jev describes the acting request and the trace-only questions as shipped; Calibration records the ask gate and lean request, and three negative results: the working-memory gate (moved here), the hybrid relevance compaction, and the stale-result stubs.
- The off-task and should-proceed steers are documented as trace-only, with what `action.offTask.warn`, `action.offTask.steer`, `action.shouldProceed.threshold` and `action.shouldProceed.steer` really change, and the 2026-09-30 blind-label measurement (no slice passes the ship gate) in `docs/guards.md` and `docs/configuration.md`. `README.md` lists `action.shouldProceed.steer` with the keys outside the semver promise. The guards docs name who labelled those 427 calls: one language model, blind to the scores and strata, on the clipped request, plan, context, and call.
- The claim that 140 intent-mismatch calls were labelled "by hand" is gone: the record (pull request 139) does not say who labelled them. The same for a sample of 14 in the 2026-09-24 field report.
- `docs/data-handling.md`: the conscience row says candidates are ranked on the machine first and what sends nothing; the hold database row says a held call keeps its summary and an allowed call keeps the judge data. `docs/commands.md`: `/warden status` shows the lifetime hold counts. `docs/extension-authors.md`: `verdict.level` includes `"deny"`.
- `docs/upgrading.md`: what changes between 0.74.1 and 1.0 (removed settings, project files that only tighten, new defaults, deprecated names), linked from the README.
- Configuration reference checked against `src/config.ts`: `compaction.maxRequests` default is 12 (was 20), the project-file table lists `action.ask.enabled` and `rulesAtTurnStart.*` as stricter-only, the user-only keys are named, `stuck.diffLimit`, `stuck.tailLimit`, `context.compactAppendix`, and the `PI_WARDEN_DB`, `PI_WARDEN_STEER_STATS`, `PI_WARDEN_INDEX_DIR` variables are documented, and a table that lost its header renders again. The adaptive-steer kind list in the guard docs matches `STEER_KINDS`. The README paired-run count names its four report batches.

## 0.90.0

### Changed

- A config file that still sets `conscience.loadThreshold` or `learning.adaptiveThresholds` (documented in 0.74.1, removed since) now gets one config warning per key, from the user file and from a project file. The warning says the key was removed in 1.0 and is ignored, and what happens now. The key still has no effect. `docs/configuration.md` has a "Removed in 1.0" note.

## 0.89.1

### Added

- A/B benchmark tooling, registration v3 (`eval/preregistration.md`): model B is `claude-bridge/claude-sonnet-5-5`; agent dollars come from the providers' price pages instead of Pi's catalog, each DeepSeek call priced by its own timestamp at the peak or off-peak rate (Chinese public holidays off-peak, from the State Council's 2026 notice) and Sonnet 5.5 at Anthropic's list prices; a failed Jev judgment in a `warden` run stops the batch and the run is not counted (`eval/jev-stop.mjs`, exit code 3); `scripts/eval-call-costs.mjs` lists every call of a report with its price window; `npm run eval:power` adds the wall-clock of each batch. Repo tooling; rides along with the next release.
- A/B batch scheduling (`eval/batch.mjs`, `scripts/eval-ab.mjs`), pre-registration v3 revised before any batch run: the queue runs in blocks (one per task x repeat, repeat by repeat) with the cell order of each block shuffled by a seeded generator (`--seed`) and the block's runs dispatched one after another, so paired runs share a price window and the machine's load; `--resume DIR` continues a stopped batch from its `runs.json`, which is now rewritten after every run; a run that fails on an agent-model API error is re-run after 1 and 5 minutes, then recorded with `infraError` and its whole block left out of the metrics, and 5 such failures in a row stop the batch (exit code 4); a Jev request still in flight when a run's process exits no longer stops the batch (recorded as `abandonedJevRequests`); `--jev-usd-cap N` stops the batch at N Jev dollars (exit code 3); the launch commands run under `caffeinate -i`. Repo tooling; rides along with the next release.
- A/B batch corrections, registration v3 corrected before any batch run: a run is an infrastructure failure only when it ended on the error (its last assistant message, or the last of any turn, stopped on an error, or pi exited before any assistant message); an error pi retried and got past is a valid run, counted as `providerErrorsRecovered`; after an exit-4 stop all 5 runs of the streak run again on resume (an isolated failure stays excluded); a run killed at the timeout with an unreadable Jev ledger has an unknown Jev cost, so it leaves the dollar metric only and the report counts it; `--resume` refuses `--typesafe-cap`; `buildReport` and `buildWeakReport` drop excluded blocks themselves. Repo tooling; rides along with the next release.

## 0.89.0

### Changed

- Approval round 2 replaces the one-question design of 0.88.0. The approval request of a held call carries a second question, `reply_points_at_action` (do the agreeing parts of the reply point at this action, not at another item or question), and the call is released only when both `approved` and `reply_points_at_action` are at least 0.7. `replyApprovalQuestion` holds both questions; `askApproval` also returns `pointsAtAction`, and `Judgment.pointsAtAction` records it. No exported name changed.
- `asked` is the text of every assistant message after the previous user message and before the reply, in order, redacted, last 3,000 characters (before: the newest assistant message, last 1,500). A reply that arrives mid-run follows messages that hold only tool calls, and an explanation can sit earlier in the turn. The approval request now sends up to 3,000 redacted characters of the agent's turn; the consent text (`disclosure`) and `docs/data-handling.md` say so.
- Measured on 30 cases, 17 held-out cases, and 24 recorded holds (runs; `docs/guards.md`): wrong releases fall from 12 to 1 and correct releases from 81 to 78; held approvals rise from 9 to 12. The pre-set rule counted in runs chose the one-question design (3 fewer correct releases, 2 allowed); the owner shipped round 2 because the held-out cases show 1 wrong release against 6 at equal correct releases, and a wrong release costs more than a second "yes".

## 0.88.0

### Added

- Approval on demand. The acting request no longer asks whether the reply approves; a call that is held again under a new user prompt gets one approval request, with the reply and the agent message it answers (`asked`: the newest assistant message before the reply, redacted, its last 1,500 characters). The call is released when `approved` is at least 0.7. Exports: `settleApproval`, `askApproval`, `buildApprovalRequest`, `replyApprovalQuestion`, `describeAsked`, `APPROVAL_THRESHOLD`; `asked` on `Conversation` and `ActionInput`.
- `scripts/approval-cases.mjs`, `scripts/approval-designs.mjs`, and `scripts/approval-replay.mjs` measure the old question, the shipped one, and a second design that was not shipped, on 30 synthetic cases, 17 held-out cases, and recorded holds. `docs/guards.md` has the tables and the rule that chose the design.

### Changed

- `evaluateAction` with `retryAfterHold` takes the same approval step as the Action guard: the acting request does not carry `approved`; when the final verdict is a hold, one approval request follows with `asked` (optional field of the action), and without a judge or when the request fails a reply that reads as approval stands in. Before, it asked the combined question on the acting request and read no agent message. No exported name changed.
- Approval requests fall from 90.0 to 0.7 per 1,000 judged calls (measured on recorded sessions since 2026-09-16). Measured on recorded holds and cases, wrong releases fall from 45 to 12 and correct releases rise from 55 to 81 (runs; `docs/guards.md`).
- The consent text (`disclosure`) and `docs/data-handling.md` say what the approval request sends.

## 0.87.0

### Fixed

- The end-of-run rules check no longer judges changes that git brought in. When HEAD moved during the run (a `git pull`, a merge), a changed file with no uncommitted change at the end, whose content equals its content in a commit the run did not make and that was committed before the run began, is skipped. Edits, uncommitted command changes (`git checkout <old> -- file` included), commits made during the run, and conflicts the agent resolved are still judged. When HEAD does not move, the check adds one `git rev-parse`; after a pull it adds a few git calls, and it saves the per-file diffs of the skipped files.
- The done-check no longer counts a `write` or `edit` whose path lies outside the project root as a code change.
- `/warden test` sends one request. It no longer passes `action.traceSample`, so the first judged call of a process is not also sent with the trace sample, and the headless branch that filtered a sampled verdict is gone.
- A background notice (the turn-start rules reminder, a conscience tip) no longer causes a model call of its own. It waits for `turn_end` and is steered only when the turn ran tool calls and not every result set `terminate`, the one case where Pi's loop makes another call anyway. Otherwise it is dropped and the trace says why, so it never stays in Pi's steering queue for the next run.
- The test "session scratch: a symlink under /tmp pointing outside the temp directory stays held" passes wherever the checkout lives.
- A background notice is no longer dropped on a host that does not send `tool_execution_end`. The turn's tool-call count now comes from `turn_end` (`toolResults`, or the tool calls in the assistant message when that field is absent); `tool_execution_end` is read only for `terminate`, and a batch counts as terminated only when the host reported a result for every call and every result set `terminate`.
- The git-brought filter of the end-of-run rules check no longer swallows a git failure. The failure reaches the run-end trace, which says the filter failed, gives the error message, and says that every changed file was judged.
- The git-brought filter probes at most 20,000 file × commit pairs. With more, only the newest commits that fit are probed and the trace says the filter was cut; the newest commits find almost every match. Measured with 300 files and 1,000 older commits, the run-end diff takes about 0.3 s instead of about 2.3 s.

### Changed

- The consent text (`disclosure`) and `docs/data-handling.md` say what is sent now: earlier messages and the rules file content ride only the sampled request (one judged call in twenty, `action.traceSample`); the rules content rides the acting request only while a rule violation is open; the turn-start rules request is not sent for short continuations and relayed child reports; when the request fails, times out, or no rule passes the threshold, it was already sent and nothing is appended.
- The text of the turn-start rules reminder, the conscience tip, `docs/configuration.md`, and `docs/guards.md` says when a notice is delivered: at the end of a turn whose loop continues, and dropped for a turn with no tool call, a batch where every result ended the run, a failed or aborted turn, and a run that ends first. The trace line no longer says "next tool boundary".
- `docs/configuration.md` and `docs/guards.md` say what the action request carries: earlier messages and the rules content ride only the trace sample (one judged call in twenty, `action.traceSample`), and the rules content rides the acting request only while a violation is open.

### Tests

- A `cd` to the home directory after `then`, `do`, and `eval` still holds the relative `rm -rf` that follows.
- The host test counts the new `tool_execution_end` hook (15 hooks).
- New tests cover a host that sends `turn_end` with tool results and no `tool_execution_end`, the tool-call fallback to the assistant message, a `terminate` result for only some calls, a git failure in the filter (unit and run-end trace), and the probe-limit cut.

## 0.86.1

### Added

- A/B benchmark tooling: a third cell (`warden-offline`, pi-warden with Jev judgments off, so only the offline parts run) beside the prose-only and warden cells; a cost axis that prices each run in dollars — agent input, output, cache-read, and cache-write tokens from the session log at a price table in `eval/config.mjs` (prices from Pi's model catalog, source named there), plus the run's Jev requests and input tokens — reported per run and per cell; four multi-turn tasks (5-6 user turns, a project rule matters only after the first turn) that exercise the turn-start rules reminder; `npm run eval:power`, the power calculation from the earlier reports (violations per run, success non-inferiority, dollars per run) per registered model, with the proposed batches and their estimated cost (billed for one model, list-price equivalent for the plan-based one, plus its token total for quota); and `eval/preregistration.md`, the pre-registration for the 1.0 thesis run. Repo tooling; rides along with the next release.

## 0.86.0

### Added

- The turn-start rules reminder: before the first model call of each new user message, pi-warden starts one request asking which of the project's rules apply to that request (one question per rule, carrying the request, the task spine, and each rule's heading, text, and `paths:` scope), and the ones that pass the threshold reach the agent as one short message at the next tool boundary, at most three, strongest first. The prompt never waits for the answer; nothing earlier in the context moves, so a warm prompt cache is never invalidated. A judgment that is off, fails, or takes longer than two seconds appends nothing and says so in the trace, and a run that ends before the answer arrives drops the reminder with a trace line. A short continuation or a relayed child report sends no request: the two prompts the conscience's local gate also skips, with the reason traced. `rulesAtTurnStart.enabled` (default true) and `rulesAtTurnStart.threshold` (default 0.3) control it; a project file may make it stricter, never turn it off. Measured on 100 real requests from three projects, labelled by one model: 68.9% of the rules named apply, 80 of 100 requests name at least one rule, p50 278 ms and p90 336 ms for the request itself. See [guards.md → Rules at turn start](docs/guards.md#rules-at-turn-start).
- `/warden status` reports the session's turn-start reminder: rules named, requests, failures, and the latency percentiles.

### Changed

- The conscience assessment and the turn-start rules request both run in the background: `before_agent_start` starts them and returns, so a prompt never waits for Jev. The hold falls from the judgment's own latency (p50 254 ms against a 250 ms local mock) to under 1 ms at p90 for both. A passing tip is delivered at the next tool boundary through the steer path, with its existing budget rule and its `agent_end` reminder; a tip or a reminder whose run ended first is dropped and traced. See [guards.md → Turn-start delivery calibration](docs/guards.md#turn-start-delivery-calibration-2026-10-01-background-delivery).
- The turn-start rules request skips the prompts the conscience's local gate skips: offline over 7,633 recorded prompts, 105 short continuations and 785 relayed child reports send no request, so the rate falls from 100 to 88.3 requests per 100 recorded prompts.

### Removed

- `workingMemory.*` from the config: the pruning-at-a-cold-turn-start idea failed its feasibility gate before any of its code was written (200 sampled tool results, one Jev question each: no threshold dropped at least 30% of candidates with at most 10% misses), so no feature sits behind the keys. Every documented key is a promise kept through 1.x, so the inert surface is gone. The measurement stays in [guards.md → Working-memory feasibility](docs/guards.md#working-memory-feasibility-2026-09-30-gate-failed).

### Docs

- `docs/guards.md` (Rules at turn start) describes the background delivery, the tool-boundary rule, the drop trace, the skip, and both measurements; `docs/configuration.md` documents `rulesAtTurnStart.*`; `docs/data-handling.md` lists exactly what the turn-start request sends and when it sends nothing; `docs/commands.md` names the new `/warden status` totals.

## 0.85.0

### Added

- `action.ask` (default on): code decides before the request whether Jev can change anything the agent sees for this call. It asks for a git history or remote write, a delete or a move, a write through a redirect, `tee`, or `sed -i`, a database client, a network write, a publish, a deploy, an infrastructure command, a `gh` write, `ssh`/`scp`/`rsync`, a build or package target that deploys, publishes, or installs, a call nested in a `for`, `do`, or substitution, an interpreter script that names such a shape, and every `write` and `edit`. Every other call is decided by the offline pattern pass and the floor, and the trace says `not asked` with the reason.
- `action.traceSample` (default 0.05): one judged call in twenty still asks the off-task, scope, and should-proceed questions in a second request, so the recorded signal keeps coming. Their answers go through the off-task and should-proceed checks, stay trace-only, and never hold.

### Changed

- The action guard's Jev spend falls on recorded traffic: on the calls pi-warden judged from 2026-09-25 to 2026-09-30, the acting requests fall 51.1% (28,036 to 13,627 plus 717 sampled) and the input tokens per request fall about 42% (measured against the API on 171 sampled calls, 2,288 to 1,327). Together, about 68% fewer input tokens on the action path.
- The gate still asks 96.7% of the calls whose answer changed what the agent saw in that window (327 of 338). The 11 it leaves offline were all `warn`-level, none was held, and the highest irreversible score among them was 0.57, under the 0.9 hold.
- `action.offTask`, `action.shouldProceed.threshold`, and `action.shouldProceed.steer` keep working with the lean request: the sampled call's off-task, scope, and should-proceed answers go through the same checks as before, and `shouldProceed.steer: true` puts `should_proceed` on every acting request the ask gate sends.
- `off_task`, `scope`, and `scopeConfidence` are optional on a judgment and absent from the acting request's answers; a verdict with no off-task answer reads as "no evidence", never as a warning.
- The offline pattern pass and the floor decide a call the gate leaves unasked exactly as they decide one whose request failed: built-in hits warn or hold as they would with `floor: "level"`, so no current hold weakens.

## 0.84.0

### Added

- `conscience.localTopK` (default 31, the most one request holds) and `conscience.localFloor` (default 0.5): the local rank decides how many candidates reach Jev, and a prompt with no candidate above the floor gets no request at all.

### Changed

- The conscience never offers Pi's core tools, a tool whose name or index entry says it deletes, drops, or destroys, a tool the session already called, a skill file the session already read, or a tool the model cannot call by that name in this session.
- A local gate runs before any request. Short continuations, relayed child reports, and a task spine already assessed in this session are skipped with a traced reason; the rest are ranked locally against the request and the task spine, and only the top candidates go to Jev.
- A recommendation tip is the name, one `useWhen` line, and for a skill the file to read, instead of the whole tool description.

## 0.83.0

### Changed

- A `KEY=value` or `KEY: value` hit whose value is a code expression is no longer a credential, so masking no longer rewrites source code in a tool result. A call (`readKeySync(configPath`), an index (`rows[0]`), a member access with or without optional chaining (`output.secretIds`, `opts?.tokens`), a non-null assertion (`match[1]!.split(`), an arrow body (`x => y`), a template literal (`` tag`/\s+/` ``, `` `${x}` ``), and a type name with type arguments (`Record<string`) stay readable; the field case, reading a line as `const tokens = [redacted]).filter(Boolean)`, cannot happen. Token shapes (`sk-`, `ghp_`, `AKIA`, JWTs, PEM blocks, URL passwords, signed-URL parameters) still mask in code. A bracket, a parenthesis, or a word before one inside otherwise opaque characters is still a key: `DB_PASSWORD=<password>(<more>` and `API_KEY=abc[123]DEFghi789` keep their mask, as does a call whose name is plain lowercase or snake_case (`get_config_value(config_key=...`), where a parenthesized password cannot be told apart. Replayed against 1,152 recorded session logs since 2026-09-16 (95,141 tool-result text blocks, all projects): tool results that mask a value fall from 274 to 171, and 17 distinct values stop being masked, every one of them a code fragment from the list above. No value that was masked becomes readable apart from those 17, nothing that was readable becomes masked, and 27 of the 126 values still masked are token-shaped (JWTs, PEM blocks, `sk-` keys, `gh*_` tokens, an `AKIA` key).
- A value that is a stand-in is still traced, not announced, unchanged; only the code-expression class moved from "masked and announced" to "not a credential".

### Fixed

- Credential detection no longer backtracks exponentially, so a tool result can no longer freeze the guard. The code-identifier alternatives in `looksLikeSecretValue` (`src/redact.ts`) wrote a repeated group whose character class could eat the capital that the next iteration needed, so a credential-key assignment carrying a long mixed-case value (about 85 characters of mixed case and digits, as a signed-URL signature produces) took minutes of CPU time: one recorded session result hung the offline replay until the pattern was rewritten. Every pattern in that check is now linear, and the replay's masking cost is unchanged — per masked tool result the median falls from 0.10 ms to 0.08 ms (the p99 rises from 0.99 ms to 1.67 ms, because the remaining results are a smaller set with a larger share of the expensive ones), and across all text blocks the mean is 0.028 ms before and after.

### Docs

- `docs/guards.md` (Security) and `docs/configuration.md` (`security.maskOutput`) name the code expressions that are not credentials. `scripts/credential-replay.mjs` replays session logs against a chosen build (`--files`, `--lib`, `--skip`) and reports the masks a change removes (`--compare`), with the removed values written to a file outside the repository.

## 0.82.0

### Added

- A recursive `rm` whose target is a variable the same command assigns once before it, to a literal value with no `$`, backtick, substitution, or glob (a leading `~` is allowed), is classified by what that value names: `D=/tmp/x && rm -rf "$D"` warns as `rm-temp-subtree`, `rm -rf "$HOME/projects"` holds, and `"$D"/*` stays held as a wildcard. `$HOME` and `$TMPDIR` resolve from the session environment unless the command writes them. A variable a `mktemp` holds resolves to the directory it made, so `cd "$d" && rm -rf build` warns.
- A relative `rm` target after `cd DIR` or `pushd DIR` in the same command resolves against `DIR` — a literal path, `~`, `$HOME`, a `mktemp` variable, or a same-command literal assignment — and is then classified as an absolute target: `cd /tmp/x && rm -rf build` warns, while `cd ~ && rm -rf projects` and `cd /Users && rm -rf someone/projects` hold. A `cd` the guard cannot read (`cd -`, `cd` alone, a substitution, an unknown variable) leaves relative targets as they were read before, and so does a command with no `cd`.
- `PI_WARDEN_SCRATCH_PATHS`: a `:`-separated list of absolute roots the host declares as scratch. A recursive `rm` whose every target is strictly inside one warns (`rm-session-scratch`) instead of holding. A root that is `/`, the home directory, the project root, or a git working tree (it contains `.git`) is ignored, and the session names every ignored entry and its reason once. Environment only, like `PI_WARDEN_HOST_PATHS`.

### Changed

- A recursive `rm` of a variable a `mktemp` earlier in the same command assigned warns as `rm-session-scratch` instead of holding: `d=$(mktemp -d) && … && rm -rf "$d"`, the backtick form, and quoted assignments. A variable that was reassigned before the `rm`, a `mktemp -u`/`--dry-run`, and a template outside a temp root keep the hold.
- A recursive `rm` whose every target is a literal absolute path strictly inside a volatile temp root (`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, and macOS `/var/folders/<x>/<y>/T`) warns under the new classifier id `rm-temp-subtree` (risky) instead of holding. It rests on location, not birth time, so it applies on every platform and needs no session record. A temp root itself, a wildcard directly under one (`/tmp/*`), a `..` segment, `/var/tmp`, a variable, and a command that raises privileges (`sudo`, `doas`, `su`, `pkexec`, `run0`) keep the destructive hold.
- Because a literal path under a volatile temp root now warns by location, a command that copies or extracts data in (`cp`, a plain `tar`, a plain `rsync`, `git clone`, `git archive`) no longer keeps the hold for such a target; it still disables the session-scratch exemption, and the `rm` then reports `rm-temp-subtree`. Birth-time records still decide the hit for any other temp root. A command that moves, links, mounts, or takes data with it keeps the hold itself (see Fixed).
- `/warden test` demonstrates its hold with `rm -rf /var/tmp/pi-warden-demo`; `/tmp` is a warning now.

### Fixed

- Data a command moved in no longer loses the hold. A `mv` or `ln` destination that is equal to, inside, or above an `rm` target keeps every release rule off (`mv ~/projects/app /tmp/old-app && rm -rf /tmp/old-app`, and `ln -s ~/projects/app /tmp/lnk && rm -rf /tmp/lnk/`, where the trailing slash deletes the link's target), and so do `mount`, `hdiutil`, `bindfs`, `rsync --remove-source-files`/`--remove-sent-files`, and `tar --remove-files` anywhere in the command. A `mv` or `ln` word the guard cannot read as a destination — inside a shell sink (`bash -c 'mv …'`, `xargs mv`) or at a statement position of another segment — blocks every release as well. A plain `cp`, `tar`, `rsync`, `git clone`, or `git archive` keeps its source, so such a target still warns as `rm-temp-subtree`.
- The session records every `mv`/`ln` destination it resolved inside a volatile temp root or a declared scratch root, so a later `rm -rf /tmp/old-app` of a path equal to, inside, or above one of them holds even when the birth-time walk cannot tell.
- A `mktemp` variable counts only when nothing else in the command writes the name: a second `NAME=` or `NAME+=`, a bare `export`/`local`/`declare`/`readonly`/`typeset NAME`, `read … NAME`, `for NAME in`, or `unset NAME`, at the top level, in a function body, in a subshell, or in braces. `d=$(mktemp -d); f() { d=~; }; f; rm -rf "$d"` holds again.

- Resolving a variable is an allowlist. A literal assignment, a `mktemp` variable, `$HOME`, or `$TMPDIR` resolves only when every way the command can set a variable is a form the parser reads; `eval`, `source` or `.` as a command, `printf -v`, `read`, `mapfile`, `readarray`, `getopts`, `let`, an arithmetic `((…))`, a `${NAME=…}`/`${NAME:=…}` or `+=` assignment, a declaration builtin with an option, and a function definition anywhere in the command resolve no variable, and the targets classify as they did before the variable rules: `D=/tmp/x; printf -v D %s ~; rm -rf "$D"` and `D=/tmp/x; mapfile -t D < list; rm -rf "$D"` hold again.
- A `cd` or `pushd` after `if`, `then`, `elif`, `else`, `do`, `while`, `until`, `!`, `{`, or `(` moves the directory the guard resolves against, so `if cd ~; then rm -rf projects; fi` and `while cd ~; do rm -rf projects; break; done` hold. `popd`, `cd -`, `eval`, `builtin cd`, `command cd`, `source`, and `.` leave the directory unknown for every later segment, and a relative recursive `rm` after one holds as `rm-recursive-dangerous-target` instead of resolving: `cd /tmp/x && eval cd ~ && rm -rf projects` and `cd ~ && pushd /tmp/x && popd && rm -rf projects` hold.
- Classifying an `rm` target, a `cd` destination, or a `mktemp` template reads the file system only when its literal text starts with a volatile temp root (`/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`, `os.tmpdir()`, `$TMPDIR`) or a declared scratch root. Any other path, `/home/…` and `/net/<host>/…` included, is not temp and is classified with no file-system call, so an attacker-chosen path can no longer start an automount or block the guard.

### Docs

- `docs/guards.md` (Action guard) covers the moved-in block, the `cd` rule, and the literal-variable rule; `docs/commands.md` describes the `/warden test` demo as it now is.
- `docs/guards.md` (Action guard) describes the three scratch sources, the new `rm-temp-subtree` id, and the changed moves-in interaction; `docs/configuration.md` documents `PI_WARDEN_SCRATCH_PATHS` and lists `rm-temp-subtree` among the exemptable `rm` ids.
- `docs/guards.md` (Action guard) describes the variable allowlist, the `cd` keyword and unread-change rules, and the file-system boundary.

## 0.81.0

### Changed

- The hold database stores less per call. Every row now carries the Pi session id (it used to be empty); the task text is stored once per task, in a `hold_tasks` table keyed by its hash, instead of once per call; and a row of a call that was not held keeps the judge data and the agent's plan (the scores, the reasons, and the plan) and drops the summary and the agent reason for the call. A database written by an earlier version is migrated once at startup, inside one transaction, and the pages the migration and the prune free are reclaimed by a VACUUM that runs only when no other session holds the database; when one does, the VACUUM is skipped and the next start tries again, so no session waits for it.
- A record of a call that was not held is pruned after `learning.allowedRetentionDays` (default 90 days); `learning.retentionDays` (default 365) still applies to holds.
- A steer-mode hold is labelled by what happened next: `approved` (your reply released the call), `replanned` (the agent ran a different call that changes something instead), and the new `abandoned` (the run after your reply neither released nor replaced it). The old rule labelled a hold `replanned` two prompts later without looking at what the agent did. `/warden status` counts abandoned holds apart, and the precision line still reports (declined + replanned) over the labelled holds.

### Fixed

- A database an earlier version wrote keeps the columns that version's `INSERT` names (`task`, `input_summary`, `prediction`, `preceding_actions`, `confidence`). They are no longer rebuilt away: they stay on `holds`, always empty, so a Pi session still running the older code — and a downgrade — keeps recording holds against a migrated database instead of failing every guarded call until it restarts. The size win does not change: the task text lands once in `hold_tasks`, and the older layout's text is cleared.
- A row of a call that was not held keeps the judge data: the scores, the reasons, and the agent's plan stay on the row, and its task text lands once in `hold_tasks` with the row pointing at it by hash. Calibration on field traffic reads all four, so only `context_summary` and the agent reason for the call are not written for it.
- At each start, a row an older session wrote after the migration is settled the same way: its task text moves into `hold_tasks`, the older layout's text is cleared, and an allowed row loses its summary and agent reason. A new `hold_meta` table keeps the highest row id already settled, so a start looks only at the rows written after it and changes no page when there are none; a database another session holds skips the step, as it skips the prune, and the next start runs it.

### Docs

- `docs/configuration.md` documents `learning.allowedRetentionDays`.
- `docs/data-handling.md` describes the slim hold database, the one-time migration, and every hold outcome.

## 0.80.0

### Changed

- Rule values are never silently weakened. Every rule kind reads `deny` and `block` as the same value. An unknown `severity` in a command rule, or an unknown `action` in a path or arming rule, used to fall back to the weakest level (`warn`, `note`, or dropping the arming rule); it now applies at `confirm` (a deny-list rule stays `deny`), and a config warning names the rule, the value, and the valid values.
- Arming durations: a number in `arms.for` is milliseconds and a string without a unit is minutes, as before; a string also takes `ms`, `s`, `m`, or `h` with decimals (`"1.5h"`) in every code path. A config warning names a rule that arms for under one second and a string with no unit.
- A project file may make the action guard and security stricter, never weaker. It can no longer set `enabled`, `action.enabled`, or `security.enabled` to `false`, raise `action.irreversible.warn`, `action.irreversible.confirm`, or `security.threshold` above the user's value, remove a tool from `action.tools` (it may add one), or set `action.failOpen` to `true` over the user's `false`. Each ignored value gives one config warning. Other guards stay tunable both ways from a project file.
- Config warnings: a value pi-warden cannot apply as written is shown once when a session starts and again in `/warden status`.
- `action.shouldProceed.hold` is renamed `action.shouldProceed.threshold`; it never held a call. The old name is still read through 1.x and is deprecated.
- An arming rule with no `action` is still ignored, and now gives a config warning naming the rule.
- Removed the settings nothing read: `learning.adaptiveThresholds`, `learning.minHoldsForAdaptive`, `learning.adaptationRate`, and `conscience.loadThreshold`. A config file that still sets them loads as before.

### Fixed

- `learning.retentionDays: 0` keeps every hold record, as documented; it used to become 365.
- The capability index files that `/warden index` writes are owner-only, as documented: the folders are created `0700` and each file is written `0600` through an atomic replace; before, they had the default permissions.

### Docs

- `docs/configuration.md` lists the project-file keys that only get stricter, documents `widget.barMode` and `stuck.churnThreshold`, and the lab profile now turns the security guard off in the user file.
- `docs/commands.md` has a row for `/warden enable` and shows `/warden init [--force]`.
- `docs/data-handling.md` lists `steer-stats.json`, the capability index files, and the migration notice marker.
- `docs/extension-authors.md` names exactly the exports semver covers; every other export is internal.
- `README.md` has a Versioning section that says what semver covers from 1.0.
- `CONTRIBUTING.md` gives the hold threshold as 0.9.

## 0.79.1

### Fixed

- The hold log is now written to a temporary file and renamed into place, so a reader always sees a whole file. Before, a reader during an in-place rewrite could get a line cut short, which made an extension test fail now and then.

### Tests

- `npm test` clears every `PI_*` variable and judge key and gives each test process its own agent directory, so a run in a shell inside Pi no longer writes trace lines or steer stats to the developer's directories; the host test builds into a temporary directory instead of `dist/`, and no test file shares a fixed temporary path.

## 0.79.0

### Changed

- `warden_remember` records a lesson with no user correction or failure before it, for example a fact about the project that later sessions need; the rules for a lesson are unchanged, and it still reaches later sessions only once recorded in a second session or said by the user.

## 0.78.1

### Docs

- `docs/hero.png` is now rendered by `scripts/render-hero.mjs` (`npm run hero`), and every number in it comes from the 2026-09-24 field report (759 sessions); the install line reads `pi install npm:pi-warden`.

## 0.78.0

### Added

- Relevance compaction (`compaction`): experimental, off by default, not recommended. In a replay of 48 recorded compactions its summary was 4.7 times the size of Pi's at the median and kept whole only 1 of the 34 files the agent read again. Try it or improve it; changes that make it smaller or keep what the agent goes back for are welcome. At compaction, pi-warden can write the summary instead of Pi's model. User messages and assistant text stay word for word, thinking is left out, and Jev scores each tool call with its result, each extension message, and each part of the previous summary against the current task; kept units go in verbatim, tool output inside a fence marked untrusted, and the rest become one line each. Every kept section is fenced, and a `<` that starts a `summary` tag in kept text is written `&lt;`, so kept text cannot end Pi's summary wrapper. When the security check is on, results it flagged as a possible prompt injection are never kept verbatim; results the context saver compressed keep their excerpt. `compaction.enabled` is user file only; a project may tune the other keys. One compaction sends at most `compaction.maxRequests` (12) requests sends nothing when its requests would leave fewer than 50 of the session's `maxRequests`, and stops before any request when fewer than 50 remain, so it never turns judgments off for the guards; `compaction.timeoutMs` bounds the whole compaction and the global `timeoutMs` each request. Any failure, timeout, abort, missing consent, a provider in `compaction.skipProviders` (default `claude-bridge`), a request limit, or a summary over `compaction.maxSummaryTokens` lets Pi's own summary run; the hook never cancels a compaction. One trace entry per compaction and a line in `/warden status`.
- `scripts/relevance-replay.mjs` replays recorded compactions through the relevance compaction and compares size, re-fetch coverage, and cost with Pi's summaries. First measurement in `docs/guards.md` → Calibration.

## 0.77.0

### Added

- Context filter (beta, off by default). With `"context": { "filter": { "enabled": true } }`, an output that would get the generic head/diagnostic/tail excerpt is split at line boundaries and Jev scores each chunk for the agent's current task; chunks scoring at least `minScore` (1.5) are kept word for word in original order, up to `maxKeptChars` (6000) with the last 1000 characters always kept, and each gap is marked. Parser excerpts, `all`, duplicates, and repeated runs are unchanged. Any error, a timeout (`timeoutMs`, 4000), judgments off, an exhausted request budget, or no passing chunk keeps today's excerpt. `/warden status`, the trace, and the new offline `scripts/filter-report.mjs` count filtered and excerpt outputs apart (count, recalls, kept size, requests, time, fallbacks), so a trial can be judged.

## 0.76.0

### Changed

- The intent-mismatch verdict is trace-only by default: `action.intentTraceOnly` is `"all"` instead of `"invisible"`, so a mismatch on a call with a visible effect (a commit, push, merge, tag, reset, pull request, release, publish, install, launched program, or a message sent from a script) no longer reaches the agent. The score, the trace entry, the `/warden status` counters, and the `visibleMismatch` and `intentMismatch` thresholds are unchanged; labels on 140 sampled calls, made blind to the score, put the score's separation of a differing call at AUROC 0.815, but of the 37 steers that would reach the agent, 36 were calls the plan or the user's latest request had asked for. Restore the old delivery with `"action": { "intentTraceOnly": "invisible" }`.

## 0.75.0

### Changed

- The default `action.irreversible.confirm` (the hold threshold) is 0.9 instead of 0.7, so a judge-only hold waits for the confidence the recorded action-guard corpus shows is safe: the judge's error rate falls from 15% below confidence 0.8 to under 1% above it, and a 0.9 cutoff chosen on one half of the corpus removed about 52 false alarms on the other half without losing a true catch. A call the judge scores 0.5 to 0.9 now warns instead of holding; pattern holds and user or project overrides are unchanged. Restore the old behaviour with `"action": { "irreversible": { "confirm": 0.7 } }`.

## 0.74.1

### Fixed

- Learning features work when Pi runs on Bun. Pi's release binaries (`pi-linux-x64.tar.gz` and the rest) are Bun `--compile` executables in which `import("node:sqlite")` fails with `No such built-in module: node:sqlite`, so `holds.db` never opened and learning was off for every release-binary user. `node:sqlite` is still tried first and is unchanged; only when that import fails and the process runs on Bun does `src/sqlite-adapter.ts` open the database through `bun:sqlite` behind the `DatabaseSync` subset learning uses. With neither module loading, learning stays off behind one warning that now names both modules.

## 0.74.0

### Added

- `typesafeBackend` accepts `"commandcode"`: judgments go to api.commandcode.ai under `/provider/v1/systemone`, with the key from `COMMANDCODE_API_KEY` and the model `typesafe/jev`.
- `typesafeBackend` accepts a caller-supplied endpoint object (`{ "label", "host", "path", "keyEnv", "defaultModel" }`, plus optional model-list fields) for a gateway that serves the same decisions protocol (pi-typesafe 0.8.0). The object is passed to the judge as written and validated on every call. It reads only its own `keyEnv` variable: the TypeSafe key and the `/typesafe login` store are never sent to it. `/warden status`, the `/warden enable` dialog, and the `/warden test` confirmation name the label, host, and model sent for any non-TypeSafe backend, and the consent disclosure names the real destination host.

### Changed

- An unknown `typesafeBackend` name, or an endpoint object the judge refuses, no longer silently falls back to `"typesafe"`: judgments turn off, the refusal message is shown once and in `/warden status`, and nothing is sent to api.typesafe.ai because a value was mistyped.

## 0.73.1

### Tests

- `tests/host-compat.test.ts`: the fake host's per-handler timeout stays referenced while a dispatch runs and is cleared before `emit()` returns, so an awaited `emit()` always has a loop wakeup. The timer was unref'd, so on Node 22 the event loop could drain mid-dispatch and node:test cancelled the rest of the file with `Promise resolution is still pending but the event loop has already resolved`.

## 0.73.0

### Fixed

- pi-warden runs on oh-my-pi and other hosts that load Pi extensions through a compatibility layer. `src/host-compat.ts` maps the host API onto the Pi contract: `before_agent_start` gets `systemPromptOptions` with the active skills, and an `appendSystemPrompt` becomes the host's `systemPrompt` array. An input the extension handles is also marked `handled`. `agent_settled` runs after pi-warden's `agent_end` handlers have been dispatched and the host becomes idle. If background work is cancelled without another `agent_end`, the adapter waits for that work to drain. Command contexts get `getSystemPromptOptions()`. On upstream Pi the API is not changed.
- Data paths follow the host: the user config, the `/warden index` directory, and `holds.db` use the host's agent directory (`~/.pi/agent` on Pi, `~/.omp/agent` on oh-my-pi), and the project file uses the host's config directory (`.pi/pi-warden.json` or `.omp/pi-warden.json`).
- On a host whose overlay handle cannot release focus, Escape closes the trace and config panels.
- `import { defaultConfig } from "pi-warden"` works again without the optional `@earendil-works/pi-coding-agent` peer and now also without the optional `@earendil-works/pi-tui` peer: the library entry has no runtime import of either. Host directories come from the new injectable `HostDirs` parameter on every path function (`defaultHostDirs()` reads `PI_CODING_AGENT_DIR` and falls back to `~/.pi/agent`; existing callers keep working unchanged), and `src/extension.ts` builds them once from the host and passes them to every call. The entry's only pi-tui code — the rendered status stack — moved to `src/widget-render.ts`, which the entry does not re-export.
- On a host whose agent directory is not the Pi default (oh-my-pi), an interactive session shows a one-time notice when `~/.pi/agent/pi-warden` exists and the notice has not been shown on this host: it names the target and legacy folders and a command that moves the fresh data aside and copies the legacy data in its place, and records a marker beside the data folder so it shows once. Headless sessions show nothing.

### Docs

- `docs/configuration.md`, `docs/data-handling.md`, `docs/commands.md`, and `docs/faq.md` say that paths follow the host. `docs/configuration.md` and `docs/data-handling.md` add a one-time migration note for existing oh-my-pi users: close all Pi and oh-my-pi sessions, then run `{ [ ! -e "$HOME/.omp/agent/pi-warden" ] || mv "$HOME/.omp/agent/pi-warden" "$HOME/.omp/agent/pi-warden.before-migration"; } && cp -R "$HOME/.pi/agent/pi-warden" "$HOME/.omp/agent/pi-warden"` and copy each project's `.pi/pi-warden.json` to `.omp/pi-warden.json` (keep the original). oh-my-pi shows this notice once per machine.

## 0.72.0

### Added

- A project rule may cite where its wording came from with a `source: <file>:<line>` header beside `paths:`, for example `source: AGENTS.md:65`. `/warden rules` shows it, and when the rule fires the steer names it: `"<rule>" (from AGENTS.md line 65) ...`. A bad value is ignored and `/warden rules` reports the line.
- `/warden init` compiles an existing `AGENTS.md` or `CLAUDE.md` into small rules. The prompt hands the agent the instruction file's lines with line numbers and asks for one rule per instruction that can be judged from one changed file, each with a `source:` header and a `paths:` header when the instruction concerns certain files, wording close to the source, and a concrete violation pattern. Instructions that need other files, repository history, or the task, and anything a linter or type checker enforces, are left out of the file and listed in the reply with the reason. The reply suggests `/warden rules check` when the user has a key; the check is never run automatically. When `pi-warden.md` already exists the prompt is unchanged.
- `/warden rules audit [paths...] [--max N] [--yes]` judges existing files against the project rules as if each had just been written: one Jev request per file, at most four at a time, over the source files under the given paths (default: the project) that git does not ignore and at least one rule applies to, capped at `--max` (default 50) with the number left out reported. A confirm dialog names the file count and what leaves the machine before anything is sent; a headless run needs `--yes`. The output is a table by rule (files judged, files flagged, mean score) and the flagged files with their rule scores, worst first, plus a Markdown copy at `.pi-warden/rules-audit.md`. Nothing is recorded in the rules log. With no key or no consent it says so and sends nothing.
- `/warden bench [--runs N]` (default 10) measures what a rules check costs on this machine: the fixed built-in sample file judged N times against the active rules, reporting p50 and p95 latency, requests, mean input tokens per check, and estimated cost per check and per 100 edits. No confirmation is needed — the sample is built in and no project content is sent — and with no key or no consent it says so and sends nothing.
- `/warden rules calibrate [--commits N] [--max N] [--yes]` replays the changed files of the last N non-merge commits (default 20) through the project rules and reports, per rule, how often it applied and fired, the mean score, and the flags `fires on everything` and `undecided`, worst first, then the rules no file in the sample reached; a rule with no fire in the sample reports `no violation in sample` and is not flagged, because replayed commits are mostly compliant code. Each changed file is one `edit` request (the removed lines as `oldText`, the added lines as `newText`, the file after the commit as context), capped at `--max` (default 40); binary, generated, gitignored, `rules.exclude`, and `rules.skip` files are skipped, and a rule fires at its own `threshold:` cutoff. The scores go to the local rules log with `source: "calibrate"`, which `/warden report` counts apart from live verdicts. Nothing is sent before a confirm dialog showing the request count and the redacted diffs; a headless run needs the explicit `--yes`.
- `/warden rules tune` sends the session's agent one prompt with the rules the latest calibrate flagged `fires on everything` or `undecided`, or that `/warden rules check` (this session) flagged: each rule's current text and why it was flagged, and the ask for a rewrite that is concrete and judgeable from one changed file. The agent edits `pi-warden.md` with its own tools. With nothing flagged it says so and sends nothing.
- A project rule may carry `when: turn` beside `paths:`, `threshold:`, and `severity:` (default `edit`). A `when: turn` rule is judged once at the end of each agent run against the whole diff the run made and the user's task for that run, in one request, instead of on every edit — the home for rules one edit cannot answer, such as a change that adds more than the task asked for, a new abstraction with a single use, or logic duplicated across files. Turn rules are never asked about a single edit. The header lines parse in any order and at most once; a bad value is ignored and `/warden rules` reports the line.
- The end-of-run pass also judges files that shell commands changed in ways the per-edit guard cannot see (`sed -i`, `patch`, `git apply`, a generator's output redirected to a file, a subagent's writes): each changed file that no `write`, `edit`, or literal shell write already judged during the run is judged once, with its diff as the edit and the same per-edit question. The baseline is a read-only snapshot of the working tree taken in the background at run start (a temporary index file; the working tree, the real index, and the stash list are never touched), diffed at run end and including new untracked files git does not ignore. Every git call is asynchronous, so no hook blocks while git hashes the tree; the run end waits for a snapshot still running. The diff is capped at `rules.maxChars` per file and in total with the cut named. The unseen-change requests are capped at five files per run — the same cap as the files one shell command writes — with the first files in diff order judged and the rest named in the trace. Findings are one steer at the end of the run through the done-check's delivery, at most once per run and within the per-run steer budget; nothing holds. With no `when: turn` rules and no change the per-edit guard missed, no request is made and nothing is said.

### Tests

- Offline coverage for the history replay: hunk extraction from `git log -p`, the skip rules (binary, generated, ignored, `rules.exclude`, `rules.skip`), the request cap, the confirm and `--yes` paths, the report flags and their order at the `/warden report` thresholds, the `source: "calibrate"` log records, and the tune prompt (with no prompt when nothing is flagged), on temporary git repositories with a fake judge.

- Rules replay (`scripts/rules-replay.mjs`, `npm run eval:replay`): replays the `write` and `edit` calls of past Pi sessions in a project against that project's current rules, one request per judged call, and writes a review sheet (every flagged call plus a fixed-seed sample of unflagged calls) outside the repository beside aggregate counts. `--score` turns labelled sheets into precision on the flagged items and the estimated miss rate from the unflagged sample. The first run on this repository's own sessions is in `eval/reports/2026-09-27-rules-replay/`, unlabelled pending an independent reviewer. Offline tests cover the session replay and the output boundaries.

### Docs

- `docs/commands.md`, `docs/guards.md`, and `docs/data-handling.md` cover the two commands and what the replay sends.

## 0.71.0

### Added

- A project rule may set its own cutoff and severity in header lines at the top of its body, beside `paths:`: `threshold: 0.8` (a number from 0 to 1) and `severity: high|normal|low` (default `normal`). A rule with a `threshold:` fires at its own cutoff instead of `rules.threshold`; severity only orders findings (high, normal, low, then score), in the steer and in the trace. A bad value is ignored and `/warden rules` reports the line.
- `rules.softThreshold` (default `0`, off): a score from this value up to a rule's cutoff becomes a soft "please double-check" finding. Soft findings never hold, get one short separate sentence in the same steer (`Also check whether "<rule>" applies here (0.62).`), count against the steer budget like any other steer, and are recorded in the rules log with `soft: true`. When only soft findings exist the steer is that sentence alone.

### Tests

- Rules bench (`eval/rules-bench/`): 161 labelled cases (107 tune, 54 holdout) and eight new cases: six add a new violation of a rule the file already breaks and two touch only a line next to an old violation. Three fixture rules carry header lines (`severity:` on two, `threshold: 0.9` on the boolean-name rule). The scorer reads those headers and reports each rule at its own cutoff and the soft tier under it. The run is in `eval/reports/2026-09-27-rules-tiers/`, with case `r15-04` recorded as a still-open miss.

### Docs

- `docs/guards.md` → Calibration records the rules-tier measurement, and `docs/configuration.md` documents `rules.softThreshold`.

## 0.70.2

### Fixed

- Two store writes in one process no longer race. Every write to a loops, prefs, user-config, steer-stats, or rules-log file now goes to a temporary file unique to the process and the write before the rename, and the read-modify-write changes to the loops and prefs files run one after another, so a `warden_loops` or `warden_remember` call can no longer fail with `ENOENT` or silently lose the other call's change. A second Pi process writing the same file is still not guarded.

## 0.70.1

### Tests

- Rules bench (`eval/rules-bench/`, `npm run eval:rules`): 17 fixture rules and 153 labelled cases (four violations, three compliant near-misses and two cases where the rule does not apply for each rule), split into a fixed `tune` set (102) and a fixed `holdout` set (51), one request per case. `--split` selects the set, `--budget` caps requests, `--concurrency` sets parallel requests, `--dry-run` lists the plan and sends nothing, and `--rescore DIR` re-scores saved answers without spending. The scorer reports recall, false-alarm rate, precision and counts at cutoffs 0.3 to 0.9, AUC per rule, the rules whose clean cases sit in the 0.3 to 0.5 band, and the two-tier view (raise at 0.7 against a 0.5 to 0.7 double-check). Cases where a path-scoped rule is not asked at all are counted apart from the metrics. The first run is in `eval/reports/2026-09-26-rules-bench/`. The guard is unchanged.

## 0.70.0

### Added

- `/warden rules check` asks Jev which of the active rules the rules guard cannot judge well, and prints one line per rule that needs attention with the reason, its score, and one suggestion (`move it to your linter`, `split it so the changed file alone shows the violation`), then `N fine, M need attention`. Two questions per rule: whether it can be judged from one changed file's content alone (`from_change_alone`, `needs_other_files`, `needs_task_or_history`, `too_vague`) and whether a standard linter, formatter, or type checker could enforce it exactly (cutoff 0.70, measured in `docs/guards.md` → Calibration). Rule names, text, and `paths:` scopes are sent redacted, with no file content and no task text; with no key or no consent it says so and sends nothing, and plain `/warden rules` stays local. Advice only: no rule is changed, disabled, or skipped, and the guard's questions, thresholds, and defaults are untouched.

## 0.69.0

### Added

- `/warden report [--days N]` reads a local rules verdict log and reports, per rule, how often it was judged, fired, was cleared after a fire, and its mean violation score, with a flag for `never fires`, `fires on everything`, or `undecided`, then the rules in the current set with no records. Default 30 days; local only, nothing is sent. Each judgment from the rules guard is now recorded (time, session id, project-relative path, tool, rule id and name, outcome, P(violation), the threshold, whether it was a finding, and whether it cleared an earlier finding), keyed by a hash of the project path under `~/.pi/agent/pi-warden/rules/`; the file keeps the newest 5,000 records and a write failure is silent to the agent and shown once in the trace.

### Docs

- README rewritten shorter: badges, one headline claim, a table of what the agent does and what pi-warden does, and the measured numbers in one list.

## 0.68.0

### Added

- `/warden rules` prints the active parsed rule ids, path scopes and source files, plus the dropped count and `rules.exclude` patterns, so the local rule set can be inspected without sending anything to Jev. With `rules.enabled: false` the output leads with `Rules guard is off (rules.enabled: false). These would apply:` and the same details follow. A fallback document judged as one aggregate rule reports its condensed size only.

## 0.67.0

### Added

- **Stuck evidence.** The stuck guard now sends the judge a compact structured `evidence` section next to today's fields. Per run: the failing test, error, location, summary and exit code, parsed generically from the run's own output (TAP/node test, jest, vitest, pytest, tsc, eslint, cargo, go, a `make test` script, Playwright), the run number of the earlier run that failed the same way after durations, clock times, temp paths, line:column positions and ordering are normalised, and a 300-character head plus 300-character tail fallback when no parser knows the output. Per `edit`/`write`: the path and a diff of the change capped at 600 characters. A digest gives the failed runs, the distinct failures, the runs that repeat an earlier command, the edits between the first and last failed run, and the information-gathering calls after the first failure. Every string is redacted, the whole object is capped at 4 KB, and the oldest runs are dropped first. The measurement behind it is in `eval/reports/2026-09-26-stuck-evidence/`: on the same 40 stuck bench cases, accuracy 0.725 → 1.000, right where the old state was wrong on 11 cases and wrong where it was right on none (sign test p = 0.001), no latency change at p50. Edit diffs (capped, redacted) now leave the machine for stuck checks; `docs/data-handling.md` lists them.
- Config `stuck.evidence` (default `true`, valid in the user and the project file). `false` sends the output tails only, as before. The guard's questions, thresholds and when it fires are unchanged.

### Tests

- Judge bench: the stuck arms are now the shipped guard itself. Arm A is `buildStuckRequest` with `stuck.evidence` on (the default), arm C is the same builder with it off, and arm B keeps A and enlarges the raw slices, so a run compares the shipped state against its predecessor on the same cases. The generic parser and the failure signature moved out of `eval/judge-bench/` into `src/evidence.ts`, so the bench exercises the shipped code; the bench's own parser module is gone.
- New tests: the request without evidence equals the state sent before the change, one sample of each runner format names its failing test, an unknown output falls back to head and tail, noise-only differences (line numbers, times, temp paths, ordering) are one failure while a changed failure is two, a credential in an output or in a diff never reaches the state, the 4 KB cap holds and drops the oldest runs first then the oldest edits, and `stuck.evidence` is read from the user file and the project file.

## 0.66.1

### Tests

- Judge bench (`eval/judge-bench/`, `npm run eval:judge`): 80 labelled cases for the stuck and done guards (40 each, half positive), each sent to the real judge in three request states: A, the state the guards build today; B, the same shape with larger raw output slices; C, today's fields plus a compact `evidence` object from a generic failure parser (failing tests, errors, locations, edit diffs, file types, checks after the last edit). 36 traces come from real runs of node test, tsc, cargo, go, sbcl and scripts in throwaway projects; the rest are written in the runners' own formats. Scoring uses the guards' own thresholds and gate. `--dry-run` lists the plan and sends nothing; `--budget` caps requests. Guard behaviour does not change.
- First judge bench run (`eval/reports/2026-09-26-judge-bench/`, 720 requests, 3 repeats): on stuck, the structured state is right where today's state is wrong on 11 cases and never the reverse (sign test p = 0.001; accuracy 0.725 → 0.992), mostly progressing windows that today's state calls stuck; its digest is close to the label rule, so this is an upper bound. On done, no arm beats today's state beyond noise, because the five not-done cases with a passing check after the last edit never reach the judge. Larger raw slices change one verdict. Latency p50 is 245–257 ms in every arm.

## 0.66.0

### Added

- Call-waste notes. Each tool call re-reads the whole conversation, so four patterns that spend calls for nothing now earn one advisory sentence each, attached to the tool result that triggers them: a second `sleep` poll inside 10 calls, a third ranged read of one file whose ranges are adjacent or overlapping, a third search of one file with the same or an overlapping pattern, and a check re-run with a different output filter after an earlier run was cut by a pipe and showed no failure. The note is text added to a result the model is about to read, so it costs no request; it never holds, blocks, or warns, never spends `steerBudget`, and is not adapted by `steers`. One note per detector per 20 calls. On the first run of a session one tip is appended to the system prompt when `waste.tip` is on: read files in large ranges or whole, run a check once without a pipe and search its output, and wait with one blocking command instead of repeated sleeps. New config section `waste`: `enabled` (default `true`), `tip` (default `false`, opt-in), `every` (20), and one switch per detector (`sleep`, `paging`, `search`, `recheck`, all default `true`). Every note is recorded in the trace as the `waste` guard with its detector. Thresholds come from an offline measurement over the tool calls of 1175 existing sessions; the weak-model bench that ran the guard on and off is under `eval/reports/2026-09-26-waste-nudges/`.

### Changed

- The session tip is opt-in: `waste.tip` defaults to `false`. The five-repeat A/B on the weak suite (`eval/reports/2026-09-26-waste-tip-5x/`, 80 runs) put the tip's arm 0.5% apart on tokens and 0.6% apart on turns from the control, with a paired sign test over the task medians at p = 1.0 for tokens and for turns, with and without the long task, so the prompt tax is not paid by default. The four call-waste notes stay on by default and are unaffected; `waste.enabled` still gates both.

### Tests

- The same two cells re-run at five repeats on the weak suite (`eval/reports/2026-09-26-waste-tip-5x/`, 80 runs) do not confirm the two-repeat numbers: tokens −0.5%, turns +0.6%, tool calls −10%, no detector note fired in either cell, tip delivered in all 40 waste-on runs, success 33 against 30 of 40 and harm 2 against 4. A paired sign test over the task medians gives p = 1.00 for tokens and for turns, with and without the long task, so the −43% tokens and −26% turns of the batch above were small-sample spread rather than a guard effect. One waste-on run was killed at the runner's 12-minute timeout; dropping it does not change the verdict.

## 0.65.1

### Fixed

- The rules guard no longer blames an edit for code that the edit kept. Each edit's request now carries `after`, the lines of `before` with the edit applied, and each rule question asks whether the change introduces a violation, judged on `after`, instead of judging `newText` alone with `before` as context only. In the weak-model bench, three of the four rules steers that were noise flagged a missing `@returns` for an edit to a function body or an added import, with the JSDoc still directly above the function. An edit that drops a required `@returns` is still flagged.
- A rules steer names the rule and the written file only; it no longer names the rules file (`from pi-warden.md`). After a false rules steer in the bench, one weak model spent 6 calls reading pi-warden's own config and hold log.

## 0.65.0

### Added

- Adaptive steers per model. pi-warden counts, per model and per steer kind (`intent-mismatch`, `off-task`, `rules`, `slop`, `stuck`, `conscience`, and the other advisory notes), the steers it sent, the ones the agent followed (a course change in its next two messages), and the ones it disputed ("as I said", "false positive"). After 30 or more steers, a kind followed under 20% of the time or disputed over 40% becomes trace-only for that model; 1 in 5 is still sent, and every further 30 steers the probes decide whether it is sent again. Holds, confirm, deny, security masking, the credential notice on masked output, and the done-check are never trace-only, and per-call judgments never change. The counts stay in `steer-stats.json` in pi-warden's data folder. `/warden status` lists the trace-only kinds per model with their rates; `/warden unmute <kind> [model]` resets a pair. New config section `steers`: `adaptive` (default `true`), `minSteers` (30), `minFollowed` (0.2), `maxDisputed` (0.4), `recheckEvery` (30), `probeEvery` (5). A replay of 937 recorded sessions would make `intent-mismatch` trace-only for three models (6 to 11% followed) and nothing else.

## 0.64.1

### Fixed

- A recursive `rm` of recorded session scratch now keeps its hold when the same command also moves, links, copies, extracts, or mounts data: `mv`, `ln`, `cp`, `tar` (also `g`- or `bsd`-prefixed), `rsync`, `mount`, `hdiutil`, `bindfs`, or `git … clone`, anywhere in the command and also quoted or escaped (`\mv`, `"ln"`, `l''n`). The scratch tree walk runs before the command, so it could not see data the command itself put into the scratch path before its `rm`. A plain `rm -rf` of recorded scratch is still released.

## 0.64.0

### Added

- Open loops. New agent tool `warden_loops` keeps what the agent promised to do later in this session: `add` (at most 160 characters, with an optional `when` condition such as "after CI passes"), `done`, `drop` with a reason, and `list`; its description tells the agent to add a loop whenever it promises something for later. The open loops (at most 8 and 600 characters) appear in the compaction appendix, in one end-of-run notice for the next turn (counted against the steer budget as `loops`, never twice for the same unchanged list), and in one message on resume. Loops are stored per session and project in pi-warden's data folder, so they survive compaction and resume and never reach another session or project. `/warden loops` lists them for the user.
- New agent tool `warden_recall`: the failed attempts of this session with their error lines, the last passing check with whether the code changed since, and the saved-output paths. It prints the same sections the compaction appendix builds, from the same session state. Read-only.
- Both run in code, with no TypeSafe request.

## 0.63.0

### Changed

- An intent mismatch on a call with no visible effect is trace-only: the trace, the warn notice, and the status line (`N off plan (M trace-only)`) record it, and the agent gets no steer. A commit, push, merge, tag, reset, pull request, release, or publish still steers (decided in code by `isVisibleCommand`), and so does any call Jev judges `visible` at 0.8 or more, such as an install, a launched program, or a message sent from a script. The steer reaches the agent only after the call ran: on 275 recorded intent-mismatch steers over 7 days, 275 arrived after the call, and a strict course change (the agent asked the user, reverted, or changed approach) followed 8% of them. New `action.intentTraceOnly` sets which mismatches are trace-only: `"invisible"` (default), `"all"`, or `"none"` (every mismatch steers, as before).

## 0.62.0

### Changed

- `prefs.inject` is on by default, and strict: a wrong memory is worse than none. A standing preference reaches the agent only when you typed it, in a standing form (no question and no temporary word; `now`, `until`, `this PR`, `this branch`, and `for this` join `yet`, `for now`, `today`, and `this time`), not bound to one task (a pronoun-only object such as "don't commit it", a ticket, branch, PR number, or hash), in 3 or more sessions on 2 or more days, last within 30 days, not lifted by a later message of the opposite polarity ("do use subagents here"), and not weakening a check (skipping tests, checks, reviews, or confirmations, turning warden off, or pushing, deploying, or deleting without asking; the markers are in `WEAKENS_CHECK`). At most 5 items and 400 characters, each quoted as said with its session count, ending with "If the current request says otherwise, follow the current request." Still one message per session, not a steer, and not repeated on resume.
- `/warden prefs` shows each item as injected or the rule that kept it out ("not injected: seen in 2 sessions", "not injected: weakens a check"). `/warden prefs forget <n>` drops an item for the project for good, rewordings included; the key is kept in pi-warden's data folder.
- New agent tool `warden_remember`: after a user correction, or a stuck, repeat, or done-check steer, within the last 5 assistant turns of the run, the agent can record one standing lesson (at most 160 characters) for the project. The same rules apply; a lesson that repeats a stored lesson or a listed preference confirms it instead of adding one. A lesson is injected only once confirmed (recorded again in a later session, or said by the user), after your preferences, marked `(agent lesson)`, and expires after 30 days without a confirmation. Lessons are stored with the date and session id under pi-warden's data folder, never in a rules file or a session file. Preference and lesson text goes to the session model only, never to TypeSafe.

## 0.61.0

### Added

- The context saver cuts repeated runs. In a new tool result, a run of at least 20 lines and 1500 characters that exactly matches text already in context on the current branch becomes one pointer line naming where the earlier copy is and the file that holds the full text. The last 2000 characters and images are never changed. The ledger counts the removed bytes and their token-turns; `/warden status` shows the repeats cut. `context.dedupeRuns` (default `true`) turns it off. `context.dedupeMessages` (default `false`) applies the same cut to new user and custom messages; it is off by default because a repeat the user sends can itself carry meaning.

### Tests

- A repeated report in a new tool result, and with `context.dedupeMessages` in a custom or user message, is cut to one pointer line; messages stay whole by default; one changed line breaks the match; the tail stays; the stored copy holds the full text and reading it back is a recall; `context.dedupeRuns: false` leaves everything whole.

## 0.60.1

### Fixed

- Message text in a command is no longer read as a command. The quoted values of `--body`, `-b`, `--title`, `-t`, and `--notes` on `gh pr|issue|release create|edit|comment`, and of `-m` and `--message` on `git commit` and `git tag`, are blanked before the patterns run, also in `=` form and as `$'…'`. A body that held `;`, `&&`, or new lines was cut into segments before, so a PR body that quoted `rm -rf /` was held as destructive. A value with `$(`, backticks, or an unclosed quote is still read, because the shell runs it.
- A recursive `rm` right after a backtick (`` `rm -rf ~` ``) is now classified like one after `$(`.

## 0.60.0

### Changed

- `git reset --hard` warns instead of holding when the working tree is clean: `git status --porcelain` in the call's directory prints nothing. The check runs once with a 2-second timeout; a failed or timed-out check holds.
- `git push --force-with-lease` now holds by default. It warns only when every target branch is named in the command or is the current branch, no target is `main`, `master`, or the remote's HEAD branch, and the command has no plain `--force`/`-f`. A `+` or delete refspec, `--all`, `--mirror`, `--tags`, an unknown flag, a detached HEAD, or `push.default=matching` on a bare push keeps the hold.
- Both relaxations read only a plain single `git reset` or `git push` command. A `cd`, `-C`, quote, variable, or second command keeps the hold.
- The conscience no longer sends its `agent_end` reminder when the run ended with a final text reply. The agent has answered; a reminder then started a new turn to revisit a finished answer.

### Fixed

- `git reset --hard` with global options before `reset` (`git -C dir`, `--git-dir`, `--work-tree`, `-c key=value`) is held. Before, the pattern needed `reset` right after `git`, so `git -C dir reset --hard` was neither held nor warned.
- `git push --force`, `-f`, and `--force-with-lease` with the same global options before `push` (`git -C dir push --force`) are held. The push patterns had the same gap.

### Tests

- A clean and a changed tree for `reset --hard`, and a failed status check. Lease pushes to a feature branch, to `main`, `master`, and the remote HEAD branch, with plain `--force`, with a bare push that tracks the default branch, and outside a repository. A conscience run that ended with a final reply sends no reminder. `reset --hard` with `-C`, `--git-dir`, `--work-tree`, and `-c` on a clean tree is held. `push --force`, `-f`, and `--force-with-lease` with those options are held.

## 0.59.5

### Fixed

- Shell writes that gave neither a judged write nor a skip are now judged. `exec > f; echo x` judges the text the later commands print into `f`; a redirected `{ echo x; } > f` or `(echo x) > f` group judges the text its commands print, and a group that also runs a program is skipped with a reason; `env echo x > f` treats `env` as a wrapper; a target such as `/dev/../tmp/p/f` is normalized before the `/dev/` test; a partly quoted heredoc delimiter (`<<E"OF"`) ends at `EOF` and keeps the body literal, as in bash.
- One bash command no longer starts one rules request per write. Writes to the same file are joined into one request (40 `>>` appends to one file are one request), and past five files a command writes, the rest are recorded in the trace as skipped. The action request lists each file once.
- The done-check no longer counts `grep -rn screenshot src`, `idb list-targets`, or `flutter test test/unit/x_test.dart` as visual proof. A `done.visualTools.commandWords` word counts only after a `commands` head, `flutter test` counts only for an `integration_test/` or golden path (or `--update-goldens`), and `idb` only for its `screenshot` or `ui` subcommand. `chrome`, `chromium`, and `google-chrome` are now `commands` heads that count with a screenshot flag (`chrome --headless --screenshot=…`), so a headless-browser screenshot is proof and `chromium --version` is not.
- The conscience now drops camelCase destructive tools (`deleteIssue`, `dropTable`, `mcp__db__truncateTable`) and tools whose name or leading description verb is `kill`, `force`, `uninstall`, `revoke`, `erase`, or `clear` (`kill_process`, `force_push`, `uninstall_package`).

## 0.59.4

### Fixed

- A prompt no longer authorizes a recursive `rm` of `/`, `.`, `./`, `..`, `~`, `*`, or `$HOME`. Before, "Clean up build/ please." released the hold on `rm -rf /`: the target `/` was found in `build/`. The `rm-recursive-dangerous-target` hit is now never authorized by a prompt. A path the prompt authorizes must appear as a whole word (a space, quote, bracket, or punctuation before and after it), so `old/build` and `build.gradle` no longer authorize `rm -rf build`, and a root-like, home, variable, or one-character target is never matched.
- `git grep` takes the read-only fast path only with listed flags. `--open=sh` (git accepts any abbreviation of `--open-files-in-pager`) and `-O` bundled after other flags (`-lOnode`) run a program on the matched files, and both skipped the judge.
- The `/warden index` directory is a host path only when neither it nor a directory between it and Pi's agent directory is a symlink, and its real path is inside the agent directory. A symlinked index directory could make the home directory a host path, so an overwrite of a shell profile was not held.
- The read-only fast path no longer takes commands that write a file named in their arguments: `sort -o`, `uniq` with an output file, `tree -o` and `tree -R`, and `xxd -r` or `xxd` with an output file.

### Tests

- Tests for each case above: the root-like `rm` prompts, the `git grep` pager forms and common safe flags, a symlinked index directory, and the writing forms of `sort`, `uniq`, `tree`, and `xxd`.

## 0.59.3

### Fixed

- The conscience no longer recommends a tool that cannot run on this platform. `powershell`, `pwsh`, and `cmd` are dropped from the tool candidates when the platform is not Windows, and a tool whose description says Windows-only or macOS-only is dropped on the other platforms. Skills are not filtered. In a run on macOS the conscience recommended `tool:powershell` at P(useful) 0.91; its end-of-run reminder then made the agent spend a turn checking for `pwsh` and answer about PowerShell instead of the task. The reminder re-runs the same assessment, so it can no longer name such a tool either.
- The conscience's end-of-run reminder now passes the same activation gate as the first recommendation. Before, a capability held with `no_policy` (question hash or answering model not in the policy) was still sent later as `Reminder: consider using …`, which bypassed the gate that should fail closed.

## 0.59.2

### Changed

- The `large_output` score of a judged `bash` call is now recorded. The action trace entry shows it (`large-output 0.12` in the details, a `largeOutput` template token), and the holds database keeps it in `scores`. The hold signature still hashes only the irreversible score and the reasons, so hold matching is unchanged. Before, the question never steered in field use and nothing showed whether it scored low or was never asked.
- The context saver traces the outputs it judged and kept whole. One `context` trace entry per output (per text block for a multi-block result) records the retention, confidence, format, and format confidence, so the `context.confidence` gate can be calibrated. Trace only: no notice, no steer, and the status line does not change.

### Fixed

- `/warden recommend` is offered in the command completions (`/warden rec` completes to it) and has a row in `docs/commands.md`.

## 0.59.1

### Fixed

- A write or edit of a `/warden index` file is no longer held as "overwrites a file outside the project". `/warden index` asks the agent to write `global.json` and `projects/<hash>.json` in `pi-warden/index/` under Pi's agent directory, and in a hold-precision review 3 of the 4 approved outside-project overwrite holds were these files. That directory is now always a host path for the outside-project rule. The rest of the agent directory is still held: `auth.json`, `settings.json`, pi-warden's own `config.json`, and other extensions' data. Every other check still applies there.

## 0.59.0

### Added

- Standing preferences. `/warden prefs` lists the corrections and preferences you repeated in two or more earlier sessions of this project ("never bump the version in a feature commit", "keep replies short"), each with its session count and last date, and suggests adding the ones worth keeping to `pi-warden.md` as rules. The scan reads only the messages you typed (not tool output, extension messages, pasted orders and reports, messages another agent relays for you, questions, or temporary holds such as "don't commit yet") in the session files of the project and of its other git worktrees, at most the 200 newest sessions of the last 30 days within a 250 ms budget. It groups clauses that share most of their words, or a subject word that is rare in your messages ("don't spawn subagents", "no subagents, review it yourself"), and keeps the 10 most repeated. It runs in code, once per session start, and never writes a file. New keys `prefs.enabled` (default `true`) and `prefs.inject` (default `false`): with `inject` on, the list goes to the agent as one context message at session start (at most 600 characters, not a steer, no steer budget spent).

## 0.58.0

### Changed

- The conscience no longer recommends core tools the agent already uses. In a week of field use, 75 of 144 recommendations named `read`, `bash`, or `edit`, which tells the agent nothing new; one read "use bash instead of bash". New key `conscience.skipTools`, default `["read", "bash", "edit", "write", "grep", "find", "ls"]`, removes those tools from the candidate list before the judge is asked. Skills are never removed by this key; `skipTools: []` restores the earlier behaviour. The question wording is unchanged, so the beta policy hash still matches.
- The conscience never recommends a destructive tool. A tool whose name has `delete`, `drop`, `destroy`, `remove`, `purge`, `wipe`, `reset`, or `truncate` as a whole word or `_`-separated part, or whose description starts with one of these words, is not a candidate. The field data had 4 recommendations of `delete_project`.
- Fewer candidates make the conscience request smaller. On a catalog of 19 skills and 32 tools, one assessment now sends 45 questions in 2 requests instead of 54 questions in 3.

## 0.57.0

### Added

- The done-check asks for a visual check after UI changes (`done.uiProof`, default on). When a run changes a file that matches `done.uiFiles` (stylesheets, markup, `.jsx`/`.tsx`/`.vue`/`.svelte`/`.astro` components, Flutter `.dart` files, `web/` and `public/` scripts; tests excluded), whether by `write`, `edit`, or a `bash` file write, passing tests and builds no longer prove a "done" reply. Only a successful `done.visualTools` call after the last UI change does: `agent-browser`, `playwright`, `flutter test`, `idb`, `xcrun simctl io`, a `screenshot` command, a browser MCP tool such as `take_screenshot` or `navigate_page`, or a `read` of an image. Without one, the final reply is judged with the existing questions, and the nudge names the file: "You changed `web/app.css` but did not look at the result. Open it in a browser or take a screenshot before calling it done, or say it is unverified." In a week of real sessions, 23 of 75 UI runs that ended with a "done" reply had no visual step after the last UI change; replayed, the rule nudges 20 of them and 7 of the other 52, 6 of which had no real visual step either. `uiProof: false` restores the previous rule. See `docs/guards.md` → Done-check.

## 0.56.1

### Tests

- The two judge cooldown tests that wait for the window to end no longer depend on runner speed. They used a 40 ms window and a 60 ms sleep, so on a slow runner the window could end again before the next action, and the test failed with `the window is open again: 3 !== 2`. They now use a 60 s window and move a mocked `Date.now` forward instead of sleeping. The failed-probe test also checks that the probe after the window reaches the judge, so it can no longer pass when the window never ends. `JudgeCooldown` now reads `Date.now` on each call rather than keeping the function it saw at construction; the timing is unchanged.

## 0.56.0

### Added

- The stuck guard catches a literal repeat on the 2nd call, in code, with no request. When the agent makes the same call (same tool and input) a second time and nothing that can change state ran between, it gets a short steer if the call failed with the same output ("you already ran `npm test`; it failed the same way: 1 failing. Change something before running it again.") or if a read (`read`, or a read-only shell command) returned the same output again ("you already have this output from `read src/config.ts` (3 calls ago); nothing changed since."). Every call that is not provably read-only resets the check: writes and edits, MCP tools, scripts, unknown tools, and shell commands that are not read-only; only `read`, `grep`, `find`, `ls`, and read-only shell commands do not. Polling and waiting (`sleep`, `watch`, `git status`, `gh run watch`, `gh pr checks`, `tail -f`, `ps`) never fire. It fires once per call per prompt, so a 3rd identical failure still reaches the regular stuck check; it counts against the per-run steer budget as `repeat`, and a stuck verdict on the same result takes its place. New key `stuck.repeatSteer` (default `true`) turns it off; it also follows `stuck.nudge`.

## 0.55.0

### Changed

- With masking on, the credential banner in a tool result is sent only when a value was masked, and its text is unchanged. A credential-shaped value that was detected but not masked is recorded in the trace as `possible credentials, none masked (traced)` and is not announced to the agent. With `security.maskOutput: false` the value is in the agent's context, so the generic notice stays. In one week of sessions, 510 of 527 credential banners were the generic "Possible credentials in this output" text that pointed at no value, and agents disputed 49 of them. The prompt-injection notice is unchanged.
- Masking now covers every value the offline credential check detects: URL passwords (`postgres://user:pass@host`), `Authorization` header and `Bearer` values, `ghu_`/`ghs_`/`ghr_` GitHub tokens, `xoxr-`/`xoxs-` Slack tokens, and `AIza` keys. Before, these were announced but left readable in the tool result.

## 0.54.0

### Changed

- The action guard's read-only fast path, which skips the Jev judgment, now also accepts `sed -n` with one print command (`sed -n '10,20p' f`, `sed -n '/a/,/b/p' f`), `git worktree list`, `git stash list`, and `git merge-base`. For `sed`, the only accepted options are ones that cannot write or run anything: no `-i`, no `-f`, and no option after the first operand. The script must be literal, with no variable expansion and no `w`, `W`, `e`, or `r` command. In one week of real sessions, `sed -n` line ranges were almost all of the read-only commands that still went to Jev; about a third of them got a `warn`. The fast path now also rejects `<(...)` process substitution and git's `--output` and `-O`/`--open-files-in-pager`, which run a command, write a file, or open a pager program.
- The read-only fast path accepts a leading variable assignment (`LC_ALL=C sort f`) only for `LANG`, `LC_*`, `TZ`, `NO_COLOR`, `TERM`, `COLUMNS`, and `FORCE_COLOR`. Any other assignment, such as `PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`, `IFS`, `PAGER`, or `GIT_*`, can change what the command runs or loads, so the call goes to Jev.

## 0.53.0

### Added
- Rules, slop, and security judge code that a `bash` command writes to a file, as if it were a `write`: heredocs into `cat` or `tee` (quoted or unquoted delimiter, `<<-`), here-strings, and `echo`/`printf` with `>` or `>>`. Each target in a chain is judged on its own, before the command runs, with the same `.gitignore` and outside-project skip as a `write`; an append judges only the appended text. An authoring form whose text cannot be read (`$VAR` or `$(...)` in the body, a pipe into `tee`) and `sed -i`, `patch`, and `git apply` are not judged, and the trace says why; a program's output sent to a file (`cmd > log`) is not judged and leaves no trace note. See `docs/guards.md` → Rules.

## 0.52.2

### Fixed

- The context saver's trace now shows how many token-turns a saving spared. The ledger line of a compression or a dropped duplicate is written before the turn that carries it ends, so it nearly always read `~0 token-turns spared over 0 turns`. When a turn with a saving ends, its latest context entry in the trace gets a second line, `at turn end: Context saver: …`, with the counts that include that turn. Token-turns are the removed tokens (bytes / 4) times the turns the removal has been in effect, summed over the session; a new prompt does not reset them. A whole-file recall puts a stored output back into context, so from the next turn on its bytes no longer count toward token-turns; a scoped recall does not change the count. `/warden status` is unchanged.

## 0.52.1

### Fixed

- Authorizing an rm target from the task text no longer drops an unrelated pattern hit. A hit leaves the level computation only when every per-target violation it produced is authorized; before this, violations and hits were matched by list position, so `rm -rf a b c` with a task naming `c` could drop another rule's hit. An rm-family hit with no readable target (`find . -name '*.log' | xargs rm -rf`, `find -delete`) now gets one violation without a path; only a task that contains that command segment verbatim (whitespace collapsed) authorizes it, so "clean up the log files" does not authorize `xargs rm -rf` of any list, and the hit stays in the level computation. rm targets are read with shell quoting (`rm -rf 'a b'` is one target), redirections such as `2>/dev/null` are no longer targets, and each rm-family hit is scoped only to the targets of the segments that produced it (`rm a; rm -rf b` scopes `rm-rf` to `b`).

## 0.52.0

### Changed

- The compaction evidence appendix lists what already failed, so the agent does not retry it after compaction. `### Tried and failed` holds up to five distinct failed calls from the stuck guard's attempt window, oldest first, each with the last line of its output that names the error (runner tallies such as "Found 1 error." are skipped), at most 160 characters per entry. `### Verification` names the last passing check and says whether code was written or edited after it (`code changed since last passing check: yes/no`), or says that no check has passed yet when code was changed. The stuck section shows failures out of the attempt window instead of an always-empty same-strategy score and a bare tool name.
- When the appendix is over its 2 000-character cap, lower-value sections shrink first: saved outputs to the three newest, then held actions, then the active task, stuck state, and older checks. The failed attempts and the verification line are kept whole.

### Fixed

- Saved full outputs in the compaction appendix show the tool that produced them and their real size. Before this, every entry read `unknown → path (0 bytes)`. `ContextLedger.record` takes an optional third argument, `{ tool, bytes }`, and the new `ContextLedger.storedOutputs()` returns it with each path. An output recorded without it is listed by path only.

## 0.51.0

### Changed

- The rules guard applies its 31-question cap per write after path scoping, not when the rules file loads. Before this, rules past 31 in file order were never judged, even when most rules were scoped by `paths:` to other files. Each write now takes the rules that apply to its path, in file order, and asks the first 31. The trace entry records how many applicable rules were dropped and the first dropped rule id. The first write in a session with dropped rules shows one notice naming the rules file and that rule id.
- `/warden status` shows the total rule count, and names only the unscoped rules that are past the cap for every file. `RuleSet.dropped` is replaced by `RuleSet.alwaysDropped` (unscoped rules past the cap); `RuleSet.rules` now holds every parsed rule.

## 0.50.1

### Changed

- `/warden trace` sends the trace as text whenever `PI_WARDEN_TRACE_DIR` is set to an absolute path (the host asked for the trace file), whether or not the host built the sidebar. Before this, the text went out only when the sidebar component was never built, so a host without a terminal UI that builds components would get no trace.

## 0.50.0

### Added

- Credentials in a tool result are masked before the model sees them, not only announced. High-confidence values in the text blocks (private key blocks, `sk-` keys including `sk-proj-`, `ghp_`, `gho_` and `github_pat_` tokens, `AKIA` keys, `xoxa-`/`xoxb-`/`xoxp-` Slack tokens, JWTs, and credential-key assignments whose value looks like a secret) become `[redacted]` before any other rewrite, so compressed excerpts, duplicate notes, and stored full output hold the masked text too. Fixture and documentation stand-ins stay readable. The banner says "N value(s) masked in this output as [redacted]" and tells the agent to check presence without printing the value. A value already announced this session is still masked, without a second banner. `security.maskOutput` (default `true`) turns it off; masking is local and still runs when `security.enabled` is `false`, which only switches off the banner and the security judgments.
- Built-in pattern `printenv-secret` (destructive): `printenv NAME`, or `echo $NAME` / `echo "${NAME}"`, where the name contains `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, or `PASSWD` in any case, including inside `ssh … "…"` and `fly ssh console -C "…"`. The label tells the agent to check that the variable is set without printing it (`test -n "$NAME" && echo set`, `printenv NAME | wc -c`); those checks, `${NAME:+set}`, `${#NAME}`, bare `printenv`, and `env` are not held. A double-quoted string that expands such a variable is no longer blanked as data text for the pattern rules. Like every built-in pattern, it holds on its own when no judge answers or with `action.floor: "level"`; in the default evidence mode it is evidence for Jev. Exemptable by id.

### Fixed

- Signed URLs no longer raise "Possible credentials". A value found only in the query signature of an `https://` URL that also carries an expiry (`X-Amz-Expires`, `X-Goog-Expires`, `Expires`, or `se=`) counts as a stand-in: the `X-Amz-Signature`, `X-Amz-Credential`, `X-Goog-Signature`, `X-Goog-Credential`, `Signature`, and `token` parameters of S3 and GCS presigned URLs and storage links. It is traced once, with no banner and no masking in the result; redaction of what leaves the machine is unchanged. A `token=` outside such a URL, or a value that also appears on its own, still counts. Before this, nearly every read of an issue tracker's API raised the notice, because its responses carry signed upload URLs. `partitionSecrets` takes the text as an optional second argument for this check.
- A credential value containing `&` is redacted whole: `DB_PASSWORD=Tr0ub4dor&3xK9` no longer leaves `&3xK9` in what goes to Jev, the trace, or the masked result. `&` still ends a value before another `name=` (a URL query), before a second `&`, and before whitespace or the end.
- `security.maskOutput` is read from the user file only: a repository's `.pi/pi-warden.json` cannot turn off masking of credentials in its own agent's output.
- `X-Amz-Security-Token` counts as a signed-URL parameter, so an S3 presigned URL made with temporary credentials no longer raises "Possible credentials".

## 0.49.0

### Added

- The action guard reads which database a `psql`, `mysql`, `mariadb`, or `supabase` command targets (`sqlTarget`): loopback, hosted, or unknown. A loopback `DELETE FROM … WHERE …` warns (`sql-delete-local`) instead of holding; `DROP`, `TRUNCATE`, and a `DELETE` with no `WHERE` or an always-true one (`WHERE true`, `WHERE 1=1`, `WHERE 'a'='a'`, `WHERE NOT false`) still hold on loopback. SQL in a heredoc fed to a database client is now checked for `DROP`, `TRUNCATE`, and `DELETE FROM` on every target, as `-c` SQL is; before, such a heredoc was treated as data and got no hit. A hosted target (Supabase, Neon, RDS, PlanetScale, or a supabase `--linked` or non-local `--target`) warns as elevated (`sql-hosted`), and a write statement against it holds (`sql-hosted-write`). A hosted Postgres command wrapped as `BEGIN READ ONLY; … ROLLBACK;` is quiet; a `COMMIT` anywhere voids that. A variable host such as `$DATABASE_URL`, and SQL from `-f` or a pipe, keep the plain SQL hits. See docs/guards.md.

## 0.48.1

### Fixed

- The intent-mismatch question is asked only when the agent stated a plan for the call: the text of the assistant message that makes the call, or of the text-only message right before it with no tool call in between. Before this, a call with no text of its own was judged against the latest assistant text since the user's prompt, often written before several earlier calls. A shell command with a visible effect (a `git` commit, push, merge, tag, or reset, `gh pr`, `gh release`, or `npm publish` in any segment, decided in code before the request) is still judged against the latest assistant text since the prompt, because an unannounced commit or push after an older plan is the mismatch users object to. On the recorded sessions from 2026-09-21 to 2026-09-24, 151 of 163 intent-mismatch notices were judged against stale text; the question would now be asked for 63 of the 163 (8 against the call's own text, 55 visible actions against stale text). A skipped question is one fewer question in the action request.

### Tooling

- `tests/steer-delivery.test.ts` pins that a steer sent from `tool_call` or `tool_result` for the last call of a turn joins the request that carries the tool result and costs no extra model request, so the intent-mismatch notice stays a steer.
- `scripts/intent-cases.mjs` reads Pi session logs and, for every intent-mismatch notice, classifies where the plan came from: the message that made the call, the text-only message right before it, or text from before earlier tool calls (stale). It also runs the built `assistantPlan` on each call's branch and counts the notices whose question would still be asked. Aggregate counts only; offline.

### Docs

- README leads with a new image of the self-correction loop and its numbers from the first nine days of use; the headline numbers are updated to match.

## 0.48.0

### Added

- `PI_WARDEN_HOST_PATHS`: a `:`-separated list of absolute directories outside the project where the host lets its agent write. A `write` or `edit` in one of them, after `..` and symlinks are resolved, is not held or warned by the outside-project rule; command rules, path rules, deny rules, sensitive paths, secrets, and Jev still apply. Relative entries, empty entries, and `/` are ignored. Environment only; no config file can set it.

## 0.47.1

### Fixed

- A done-check nudge no longer clears the evidence that caused it. A run that a warden follow-up starts (done-check nudge, runaway recovery, subagent wake) keeps the changes and checks of the run before it, so the agent must still show a passing check. A later "done" with no check in that run is judged and recorded as unverified; the one-nudge-per-prompt bound stays. A user prompt still starts with empty evidence.

### Docs

- Field usage report for 2026-09-21 to 2026-09-24 (`eval/reports/2026-09-24-field-usage/`) and `scripts/field-usage.mjs`, which reads Pi session logs and the holds database and prints aggregate counts only. README leads with the field numbers, names the task spine under Privacy, and notes the scratch-delete exemption and the judgments-off notice.

## 0.47.0

### Changed

- A recursive `rm` whose every target is scratch the agent created in this session under the OS temp directory (`mkdir`, `mktemp`, a `write`, or a temp directory a command printed and created) warns as `rm-session-scratch` instead of holding as destructive. Targets are resolved through `..` and symlinks first; a temp root, a wildcard, a variable, a substitution, `sudo` or another privilege prefix, content older than the directory it sits in, or any target that was not created this session (or was replaced since) keeps the hold. The created paths live in memory and reset on `session_start`.

## 0.46.0

### Added

- When a guard would ask Jev but cannot, Warden says so once per session and reason, with the fix: `warden: Jev judgments are off (no consent). Run /warden enable.` (`Set PI_WARDEN_ENABLED=1.` headless), `(no key for <backend>). Set <key variable>.` (with ` or run /typesafe login` on the TypeSafe backend, the only one login stores a key for), or for a rejected key `(the key saved by /typesafe login was rejected). Run /typesafe login.` or `(the key in <key variable> was rejected). Check the key, then run /warden status.` A headless session gets a status message. A spent request budget keeps its own warning. Before this, judgments stopped silently.
- Trace file: the `session` line has `judgments` (`on`, or `off:<reason>` with reason `no_consent`, `no_key`, `key_rejected`, or `budget`), and a `judgments` line records a later change.

### Fixed

- The conscience traces why no judge was available (`no_consent`, `no_key`, `key_rejected`, or `budget`). Before this, it traced `no_consent` whenever the judge was missing, also when consent was given and the saved key was rejected.

## 0.45.0

### Added

- A judge cooldown. After three consecutive timeout, network, or other failures, or one auth or configuration failure, pi-warden stops asking Jev for a minute instead of paying a full request timeout on every guarded action. One warning names the failure kind, the duration, and for an auth failure the fix; one info notice says when judgments resume. Guards run as they do with no judge configured, nothing is sent during the window, and `/warden status` counts the checks that ran without Jev. Configure with `judge.failuresBeforeCooldown` and `judge.cooldownMs` (capped at 10 minutes); state is per session. A malformed request that pi-typesafe rejects locally does not count. A request that hits pi-warden's own `timeoutMs` reaches the SDK as an abort, so it is told apart from a user's cancel by the signal's reason and counted as a timeout.

## 0.44.1

### Fixed

- The credential and untrusted-output notice rides the tool result: the banner in the result content and the trace record stay, and the separate steer message is gone, so a notice on the last tool result of a turn no longer costs an extra model turn.
- Credential detection no longer fires on placeholder values (`<redacted>`, `<...>`, `***`, `REDACTED`, `xxxx`), plain numbers with `_` or `,` separators, or a key name whose value is only an identifier or expression in code (`findSecrets(text)`, `output.secretIds`).

## 0.44.0

### Added

- `PI_WARDEN_TRACE_DIR`: with an absolute path, Warden appends its trace to `<path>/<session id>.jsonl`, one owner-only file per Pi session, so a host that runs Pi in RPC mode can read what the status line and the sidebar would show. Each line is a JSON object with `"v": 1` and a `kind`: `session` (session id, `~`-shortened working directory, Warden version, mode, time), `entry` (a numeric `id` unique in the file, time, and the trace entry as stored), or `amend` (the entry `id`, the added line, time). The 100-entry limit of the sidebar does not apply to the file. A write error is reported once and stops the file for the session; guards and tool calls do not change. Unset, empty, or relative: no file. `docs/configuration.md` lists the record format and `docs/data-handling.md` lists the file.
- `/warden trace` in RPC mode sends the last 20 trace entries as one text notification, newest last, with the trace file path when the file is on. RPC mode settles the overlay request without building the sidebar, so before this the command did nothing there. The terminal sidebar does not change.

## 0.43.0

### Changed

- The off-task judgment and the conscience recommendation both judge with a task spine in the request state: the thread's first user turn (the goal), the latest user turn, and up to four earlier user turns (newest first). The whole spine is capped at 1200 characters — `task_history` is clipped first, then `goal`; the latest turn is never clipped. A follow-up like "now the tests" is no longer judged without the goal it belongs to. Approval still comes from the latest user turn only; the spine is context, never authorization, and no threshold moved (the conscience beta policy's pinned questionHash still matches). The action approval question now names `spine` beside `context` as text that cannot grant approval. A thread with one user turn sends no spine, so the budget is not spent on a copy of the task. A queued prompt admitted at `message_start` is also assessed with the spine. Both request paths cap a spine they receive at four history entries and the same per-field lengths (goal 1200, each entry 750 characters), whoever built it. After a compaction the goal is still the thread's first user turn: the branch keeps the summarized entries, and a compaction summary never becomes the goal. `docs/data-handling.md` lists the spine for the action guard and the conscience.

## 0.42.1

### Fixed

- A write the action guard holds, denies, or the user declines no longer gets a rules or slop steer. The steer said "the content just written" about content that was never written. A confirm-dialog write gets the steer after the user allows it. An approved retry of a held write is judged again and gets its own steer. The trace still records the rule findings of the held write, marked as not told.

## 0.42.0

### Added

- A judged `bash` call now also asks whether the command will print far more output than the agent needs. At or above `context.largeOutput.threshold` (default `0.85`) the agent is told once per command family per session to redirect or filter it, for example to a file with `tail -40`. The call is never held. `context.largeOutput.enabled: false` removes the question. `scripts/context-cases.mjs` has eight labelled commands to calibrate it.

### Fixed

- The rules guard no longer judges writes to files outside the project root or paths ignored by the project's `.gitignore`. Those files are not project code and the rules in `pi-warden.md` do not apply to them.

## 0.41.0

### Added

- The A/B eval (`npm run eval:ab`) now scores two more axes per run, shown side by side for the two cells in an "Outcome and waste" section of the report. Outcome: whether every check the task declares passes when the runner re-runs it, the diff violation count, and whether the final reply claimed tests/build success without the agent ever running that check. Waste, read from the saved session log (`eval/waste.mjs`): tool-call count, retries (same tool, same or near-same input, after a failure), reverts (a `git checkout`/`git restore` naming a path, or a `write` restoring a file to earlier content), total tokens, and wall seconds.

## 0.40.2

### Fixed

- The first-run notice no longer names a fallback document when `rules.files` is what resolved. It was decided by whether `pi-warden.md` existed, so a project whose rules come from `rules.files` was told `AGENTS.md` was judging it while its own configured files were the ones in force — and the notice's remedy, creating a `pi-warden.md`, is the one thing that shadows those files. The notice now asks the rule store which tier answered and fires only when a fallback document really is in force, listing `rules.files` among the tiers it looked at.
- The escalation request carries the rules the config resolves, not a document of the resolver's own choosing. It walked `pi-warden.md` and then `AGENTS.md` / `CLAUDE.md` / `README.md` while the rules guard was judging with `rules.files`, so a project with configured rules sent `AGENTS.md` prose as its rules, or no rules at all when it had no such file. It now takes every file in `rules.files`, in order, before the fallback names, and honors `rules.fallback: false`.

## 0.40.1

### Fixed

- An `rm` in a compound command (`rm -rf build && npm test`) no longer makes every word after it a separate target. Target extraction now runs per shell segment, so a compound command stops producing one Jev question per trailing token and no longer trips TypeSafe's 32-question limit on long command lines. A single `rm` naming more targets than the request budget still can; chunking is separate.
- An `rm` followed by a newline and another command produced no targets at all, so it was never scoped; it now yields the targets of its own line.

## 0.40.0

### Fixed

- `/warden status` and `/warden enable` now describe the key of the configured `typesafeBackend`. With `"openrouter"`, status said "TypeSafe key: missing" on the same line that counted judgments, and enable opened the TypeSafe login prompt, so consent could not be saved. Both call pi-typesafe's backend-aware `authState` and `ensureApiKey`; with no OpenRouter key, enable reports the variable to set instead of prompting (#57).
- The headless hint and the enable confirmation name the backend's own environment variable.

### Changed

- `src/backend.ts` reads hosts and key variables from pi-typesafe's `DECISIONS_BACKENDS` instead of keeping its own copy; `keyAvailable` is replaced by `authState({ backend }).usable`, which also honours a rejected key. Requires pi-typesafe 0.7.0.

## 0.39.1

### Changed
- Bump `pi-typesafe` from `^0.6.1` to `^0.6.2`. Programmatic API is unchanged; the 0.6.2 tool schema now documents its own payload fields, and no pi-warden text duplicated it.

## 0.39.0

### Docs
- README quick start now carries the four setup commands (`/warden enable`, `/warden init`, `/warden index`, `/warden test`) and the beta note; `docs/commands.md` gains rows for `/warden init --force` and `/warden index`.
- Conscience policy measurement on the per-project corpus with the split disposition gate: beta candidate policy record (89% pooled precision, 74/83; 95% gate not met), comparison against the first measurement and the remeasure, labelled-subset reproduction of the live-run gate numbers.
- Conscience recommendation remeasurement after index + question changes: before-and-after table, labelled-subset comparison, research-role tool rate, candidate policy update.

### Added
- `/warden index` command: builds a local capability index with the session model. Entries carry `lead`, `useWhen`, `examples`, and `role` instead of bare names and descriptions. The conscience uses index entries when the source hash matches; bare descriptions are the fallback. Index files live at `~/.pi/agent/pi-warden/index/global.json` and `projects/<hash>.json`. Once-per-session nudge when the index is missing or stale.
- `conscience.advanceThreshold` config key (default `0.70`): separate gate for the disposition question's P(advance), independent of the usefulness threshold.
- `CONSCIENCE_BETA_POLICY` in `src/load.ts` (questionHash `fb2d35042f667b3c`, model `jev-1.13.0`, usefulness 0.80, advance 0.70), held in the extension's closure and passed to the activation gate; a test pins the question wording to the policy hash, and `questionHash` is computed over the disposition question plus one canonical candidate question so it no longer moves with batch shape.
- Capability roles (`research`, `evidence`, `execution`, `delegation`, `review`, `conversation`) in index entries and candidate state; role-based guidance in Score questions.

### Changed
- Conscience defaults: `recommendThreshold` 1.0 → 0.80 (beta policy thresholds); still off by default — `conscience.enabled: true` is the one switch.
- The replay script omits prompt excerpts from the selected-candidates table unless `PI_WARDEN_OWNER_REPORTS=1`, so committed reports carry no Linear ids or branch names; scrub greps include `CON-[0-9]+`.
- Replay script `scripts/conscience-replay.mjs` gates delivery on `advanceThreshold` (default 0.70) and reports pi-warden status rows below the gate.
- Conscience question wording reverted to baseline after four calibration iterations; the disposition gate, not wording, was the lever.

### Fixed
- The conscience activation gate now fails closed: with no active policy, or a policy whose hash or model does not match the request, no recommendation is delivered (traced `no_policy`). Previously an absent policy let delivery through, contradicting `docs/configuration.md`. The gate also compares the policy's model against the model that actually answered instead of the literal `"jev-latest"`.

## 0.38.3

### Fixed
- `/warden config` keeps its panel handle and toggles shut, instead of stacking a second overlay against its own header hint.
- A bare `/warden` runs `status` again, and `config set <key> <value>` / `get <key>` reach the setting — the argument split dropped the default action and kept only the word after the subcommand.

## 0.38.2

### Docs
- Conscience recommendation calibration on recorded sessions: first measurement scripts, report, and guard calibration tables.

## 0.38.1

### Changed
- Verified against Pi 0.87.0; dev dependency updated.

## 0.38.0

### Added
- Conscience coach: disabled by default pending calibration. Recommends or loads skills and tools before the agent acts via `before_agent_start`. Trace-only until a measured policy ships. Load mode reads skill files from disk with path-rule checks, size bounds, frontmatter validation, and credential canary detection. 48 adversarial tests plus the fixture set.

### Docs
- Conscience recommendation calibration (2026-09-22): first measurement on 609 turns across 4 projects. Tool recommendation 84% precision, skill recommendation unmeasured pending human labels. No threshold meets the 95% gate; closest is 0.95 at 91%. Candidate policy recorded (not active); `docs/guards.md` updated. `eval/reports/2026-09-22-conscience-recommend/`.
## 0.37.1

### Docs
- CONTRIBUTING.md: reflecting the evidence floor for destructive patterns; version bump is optional for outside PRs. docs/guards.md: same stale wording fixed.

## 0.37.0

### Added
- Compaction evidence appendix (`context.compactAppendix`, default true): after compaction succeeds, the extension sends a deterministic summary of session evidence — saved outputs, last checks, held actions, stuck state, and the active task — as one custom message so the agent can prefer saved paths over re-running commands. All strings are redacted. Does not spend a steer unit.

## 0.36.0

### Changed
- The resolved rules file content no longer rides the action request when the rules guard is off. `rules.enabled: false` now means no rules file content leaves the machine at all; with the guard on, the request is unchanged. `EvaluateOptions.rules` and `InspectOptions.rules` carry the switch, and a library caller that omits it keeps the earlier behaviour. The disclosure and `docs/data-handling.md` say so.

### Docs
- `docs/configuration.md`: `Recipe: security work` — what each guard sends off the machine and what `/warden disable` leaves behind, a local-only user profile, a lab/CTF project profile with the exemptions security work needs, and an out-of-scope deny rule. README privacy paragraph points to it.

## 0.35.0

### Added
- Stuck-loop diff: when the stuck detector marks a repeated failed attempt, the agent sees a short unified line diff against the previous output instead of the full repeated output again. Byte-identical outputs get a one-line note. The diff note never grows the result. Config keys `stuck.diffLimit` (3000) and `stuck.tailLimit` (1000) control the diff and tail caps.

## 0.34.1

### Fixed
- `scripts/calibrate-action.mjs`: `--yes` now spends what the corpus needs instead of stopping at the 2000-request default; `--max-requests N` is an explicit cap that `--yes` does not lift, and a run it stops early says how many replays it skipped and writes `report-latest-partial.md`.

### Docs
- Action guard calibration on 315 recorded sessions at 0.33.3 under `eval/reports/2026-09-21-calibration-0.33.3/`, with the headline table in `docs/guards.md`.
- README measurement paragraph reworded for readability, same numbers.

## 0.34.0

### Added
- `scripts/hold-stats.mjs`: read-only script reporting per-project and total hold statistics from the SQLite database, with `--json` output and `PI_WARDEN_DB` support.
- `/warden status` now shows a lifetime hold sentence for the current project root (e.g. "Lifetime here: 55 holds, 11 labeled, 0 stood (0/11), 114 allowed accepted, 0 regretted.").

### Docs
- README "Does it actually help?" section now includes a measurement-on-real-use paragraph with current hold numbers, date, and the link to the floor-evidence decision in 0.33.0.

## 0.33.4

### Fixed
- Rules guard no longer judges prose-only fallback documents (README.md, CLAUDE.md, AGENTS.md) as one rule; a fallback with no rule-shaped sections is skipped.

## 0.33.3

### Tests
- Live smoke stuck suite now exercises the Jev-judged path: two new cases reach `source: "typesafe"` and print real scores; the existing offline-repeat case prints `offline repeat` instead of three `undefined` values.

## 0.33.2

### Fixed
- Tests and eval runs now write to an isolated database via `PI_WARDEN_DB` instead of polluting the user's `holds.db`.

## 0.33.1

### Tests
- Live smoke suite cap raised from 60 to 100 requests; summary line now reports budget-error misses.

## 0.33.0

### Changed
- Built-in pattern floor is now evidence when a judge answers (`action.floor: "evidence"`, default). Built-in hits (shell rules, rm classifier, sensitive-path, outside-project) are fed to the judge as `floor_hits` in the request state and traced as `(evidence)`, but they no longer override the judge's `irreversible` score. User-declared rules keep their declared action. `action.floor: "level"` restores the legacy behaviour. Replay on 52 real holds: evidence mode drops held count from 52 to 28; level mode preserves 44 confirm + 8 warn.

### Fixed
- Deferred sensitive-path hit now warns (instead of silently allowing) when the judge fails in evidence mode with `failOpen: true`.

## 0.32.0

### Fixed
- `replanned` outcomes now persist to SQLite, closing the gap where re-plan labels were set in memory but never written to the database.
- `command_preview` stores the redacted command or path (capped at 200 chars) instead of the bare tool name.
- Outcome known at record time (dialog-approved/declined) is no longer lost to a race between `noteOutcomes` and `learningIds.set`.
- Set `PRAGMA busy_timeout` on the SQLite connection and skip VACUUM when no rows are pruned, preventing SQLITE_BUSY on startup with concurrent sessions. Fixes #36.

### Changed
- Judged allowed calls (`held = 0`) are now stored in SQLite alongside held calls, enabling precision and false-negative rate computation.
- Disclosure and `docs/data-handling.md` updated to reflect that judged allowed calls are stored with `held = 0`.

## 0.31.0

### Added
- `/warden audit` command: agent-driven workspace audit that sends a prompt to the session model. The model reads source, finds concrete Jev opportunities, produces measurable evidence, and writes an HTML report to `.pi-warden/audit-report.html`.

### Changed
- Bumped pi-typesafe dependency to ^0.6.1.

## 0.30.4

### Changed
- Made `should_proceed` trace-only by default until calibrated, so low scores no longer ask the agent to pause. Set `action.shouldProceed.steer: true` to restore the existing steer; the `hold` threshold is unchanged.

## 0.30.3

### Fixed
- Live status follows the newest verdict, including guards without sentence tokens; stack entries retain guard update order within their severity groups.
- Action warning and hold sentences use verdict reasons instead of inferring irreversibility from the level or unrelated scores.

## 0.30.2

### Fixed
- The live widget bar wraps its sentence to the pane width; one over-wide line tripped pi's render-width guard and aborted the session. Fixes #29.

## 0.30.1

### Fixed
- Approval question now accepts generic task-level approval ("proceed", "yes", "go ahead", "sure") instead of requiring explicit approval of each specific action. Fixes the pattern where the model keeps holding after the user approved the whole task.

### Changed
- Approval question uses intent-based wording that lets Jev reason about approval directly rather than matching specific words.
- Bumped pi-typesafe dependency to ^0.6.1.

## 0.30.0

### Added
- Violation pipeline: deterministic per-violation authorization, escalation, and aggregation for pattern-detected and rules-guard violations.
- `Violation`, `ViolationScope`, `Authorization`, `EscalatedViolation` types for the violation pipeline.
- `authorize()`, `isNegated()`, `scopeMatches()`, `isAuthEligible()` (severity-based) for deterministic authorization.
- `escalateBlastRadius()` and `escalateRulesViolation()` for Jev-backed severity escalation.
- `aggregateLevel()` for final tool-call level from remaining violations.
- `resolveRulesFile()` and `extractRules()` for token-aware rules file resolution.
- `checkPiWardenMissing()` for first-run warning support.
- `escalationThreshold` config key in `ActionGuardConfig` (default 0.85).
- `/warden init` command: scaffolds a starter pi-warden.md with safety rules and project-type-specific rules.
- `writeStarterRules()`, `generateStarterRules()`, `detectProjectType()`, `buildProjectContext()` in `src/init.ts`.
- First-run warning when pi-warden.md is missing and a fallback is active.
- Per-violation noul questions sent to Jev on the same request, returning P(yes) as a confidence value. Answers drive escalation (`escalateBlastRadius`, `escalateRulesViolation`) and aggregation (`aggregateLevel`) in the action guard pipeline. Calibrated: AUC 0.73 against regret, 0.42 against rejected turns (600 sessions, 2026-09-20).
- `parseViolationJudgments()` for safe parsing of Jev noul responses with defaults for missing/malformed data; supports legacy choice fallback.
- Resolved rules file (`rules`, `rulesSource`) passed to Jev in the request state.
- `should_proceed` noul question on every action request: unified gate covering rule violations, unrequested scope, explicit constraint breaches, and material user decisions. Calibrated: AUC 0.26 against regret, 0.58 against rejected turns (600 sessions, 2026-09-20).
- `action.shouldProceed` config key `{ hold: number }` (default 0.6): steer threshold for `should_proceed`.
- `shouldProceedQuestion` exported from `src/guard.ts`.
- `Verdict.shouldProceedSteer` flag for the unified gate steer.
- `Judgment.shouldProceed` field for traceability.
- `matchPathRules` is now exported for use by conscience-loader.

### Changed
- `ViolationScope` no longer has a `labels` field; scope matching uses paths only.
- `Violation` no longer has an `authEligible` field; eligibility is derived from severity in `authorize()`.
- `isAuthEligible()` now takes a `Severity` parameter instead of a `PatternHit`.
- `escalateRulesViolation()` threshold check now matches `escalateBlastRadius()` style (guard clause for no-escalation).

### Tests
- 38 tests for authorization, escalation, aggregation, violation judgment parsing, rules-file resolution, and first-run warning.

## 0.29.3

### Fixed

- Trace-only off-task findings no longer reach the agent through dedicated steers, generic headless warnings, or the headless `/warden test` report. Independent warning and confirmation reasons on the same call still deliver normally.

## 0.29.2

### Added

- GitHub Actions CI for pull requests, main pushes, version tags, and manual runs: workflow lint plus typecheck, offline tests, and build on Node 22.19.0, 24, and 26.
- Package installation smoke checks and downloadable npm tarballs with SHA-256 checksums; validated version tags prepare draft GitHub releases without publishing to npm.

### Docs

- Documented CI checks and manual release steps, and corrected the contributor version-bump instructions.

## 0.29.1

### Changed

- Extracted duplicated credential-key regex alternation in `redact.ts` into a shared `CREDENTIAL_KEYS` constant.

## 0.29.0

### Changed

- Off-task is now gated on the categorical scope answer instead of the score alone (AUC 0.51). `expected_step` vetoes off-task entirely; `unrelated` always warns; `plausible_side_step` warns trace-only. All off-task steers are trace-only until AUC clears 0.51.
- Ledger records now include a `callExcerpt` (tool + path) for auditing off-task and intent-mismatch warns.

## 0.28.4

### Fixed

- Extension no longer crashes on load when node:sqlite is unavailable (e.g. some Node v25 builds). Learning features disabled gracefully; all guards still work.

## 0.28.3

### Fixed

- Temp output directories from saveOutput() are now cleaned up at session start (~2.5 MB/session leak).

## 0.28.2

### Fixed

- One-time warning when confirm mode falls back to steer in headless sessions.

## 0.28.1

### Fixed

- TypeSafe consent disclosure now mentions the SQLite hold database, its contents, and the retention policy.

## 0.28.0

### Added

- \`learning.retentionDays\` config key (default 365) — prunes hold records older than this on startup. \`0\` disables pruning.

### Fixed

- SQLite hold database grew unboundedly; now pruned on startup with VACUUM.
- Empty catch blocks in learning.ts now log warnings instead of silently swallowing errors.

## 0.27.2

### Fixed

- Redact user prompts before storing in SQLite hold records (JSONL was already safe).

## 0.27.1

### Removed

- Dead `SessionCompressionTracker` class — `getMultiplier()` and `record()` were never called outside tests. ~50 lines removed.

## 0.27.0

### Added

- Sentence-style status bar templates (70+ across all 9 guards). `pickSentenceTemplate()` selects the best template from token context; zero LLM cost.
- `widget.barMode: "live"` (default): status bar shows one sentence like *"warden allowed bash action — write to src/config.ts"* instead of data-style tokens.
- `widget.barMode: "stack"`: the previous multi-guard data-style view.
- Compact sidebar mode: trace entries default to 1–3 lines; press `d` to toggle detailed view.
- Interactive config panel (`/warden config`): arrow-key navigation, Enter to toggle booleans or edit values, `s` to save.
- `/warden config set <key.path> <value>` and `/warden config get <key.path>` for quick CLI edits.
- `TraceEntry.tokens` field for live-mode re-rendering with sentence templates.
- `formatVerdictTokens()` returns both rendered line and raw tokens.
- `setNestedValue`, `getNestedValue`, `parseConfigValue` config helpers.

### Changed

- `widget.barMode` defaults to `"live"`.
- Removed 7 exported-but-never-called functions and 3 non-functional blocks (proactive guidance, adaptive thresholds, intent prediction).

### Fixed

- `/warden config` now works before any guard activity fires (`lastUi` set on session start).

## 0.26.0

### Added

- OpenRouter as a configurable judgment backend (`typesafeBackend` in user config). Set to `"openrouter"` to route Jev decisions through OpenRouter's decisions API instead of api.typesafe.ai. New `src/backend.ts` module; `OPENROUTER_API_KEY` env var; project overrides cannot redirect judgments.

### Changed

- Bumped pi-typesafe to ^0.6.0 (native `backend` option on `TypeSafeOptions`).
- Deduplicated `resolveBackend` call in `shape.ts`.

### Fixed

- Host-TUI capability guard: the extension no longer crashes when the host's bundled `pi-tui` lacks the `MouseRegion` component (e.g. omp 18.2.5). A missing named import was a link-time error that silently killed every guard, the `/warden` command, and the shortcut. The import is now a namespace property read (`tuiModule.MouseRegion`), which degrades to `undefined` instead of failing. The status widget renders the same guard text without the clickable wrapper.

## 0.25.0

### Added

- Smart hold learning system (src/learning.ts). Records full context (task, plan, conversation, agent reason) with each hold decision and predicts outcomes using historical patterns. SQLite database at ~/.pi/agent/pi-warden/holds.db. Query functions weight exact matches 5x, similar matches 2x, and same-reason matches 1x, with time decay. Never skips destructive patterns.

## 0.24.0

### Added

- User-defined command rules (`action.commandRules`, `action.commandDenyRules`, `action.exemptRules`, user config only): your own patterns on the same data-text-stripped command the built-ins read, with `warn`/`confirm`/`deny` severity. `confirm` defaults to a user dialog in every mode; `deny` blocks with no dialog and no TypeSafe request; `exemptRules` silences built-ins, the `rm` classifier ids, `sensitive-path`, and your own rules by id. The `deny` verdict renders as a chip in the status line and the trace sidebar.
- Overnight eval stability proof: 109 cycles, 13,952 cases, 100% pass rate, zero score drift ([docs/overnight-eval.md](docs/overnight-eval.md), [eval/reports/2026-09-18-overnight-stability/](eval/reports/2026-09-18-overnight-stability/)). Confirms that guard thresholds are deterministic against the TypeSafe API and the case set is a reliable regression gate.
- User-defined path rules (`action.pathRules`, user config only): a path dimension for the pattern floor — `{ id, paths, access, tools, action, message?, onlyIfExists?, regex? }`. `access` names the side that flows (`"none"` holds any touch, `"read"` holds writes, `"write"` holds reads); file tools match the structured `path` field, the bash surface matches whole-text mentions and redirect/`tee` write sinks only — never arbitrary argv tokens. `action` maps to `note`/`warn`/`confirm` (dialog)/`block` (deny); `exemptRules` silences a path rule by id. A `read`-scoped rule needs `read` added to `action.tools` (read tools are not inspected by default).
- User-defined arming rules (`action.armingRules`, user config only): session-scoped rules that correlate a preparation edit with a later command — `{ id, when: { edited, regex?, tools? }, arms: { command, for?, caseSensitive? }, action, message? }`. Editing a file matching a `when.edited` glob arms `arms.command` for `arms.for` (default 10 minutes); while armed, matching commands fire the rule's `action` (`confirm` dialog, `hold` steer, `block` deny). State lives for the rule's window within a session, is visible in `/warden status`, and never depends on Jev.

## 0.23.0

### Added

- Same-target churn detection (WARDEN-LOOP-2). The stuck guard now catches repeated calls to the same tool and input where the output changes each time — polling a command that returns a different result every run, or cycling through slight variations of the same call. `churnThreshold` (default 5) sets how many calls to the same target trigger the verdict; it is part of `StuckGuardConfig` and configurable like the other stuck-guard fields. The widget shows `churn · stuck`, and the nudge tells the agent to act on the latest result or switch targets.

## 0.22.0

### Changed

- Status line design pass (WARDEN-TUI-1, the widget half). The verdict leads each line as a bold colored chip (`WARN`, `STUCK`, `UNVERIFIED`) instead of hiding at the end; the redundant `warden ·` prefix is gone; the guard follows in muted and the body reads as data (subject in the text tone, labels muted, numeric values bright) — the same palette and vocabulary as the 0.19.0 sidebar pass.
- Verdicts the guard found nothing in (`ok`, `allow`, `skipped`) fold into one line per verdict, naming the guards that spoke: six guards firing in one turn cost one line, not six, and the folded scores stay in the sidebar. A quiet verdict keeps its own line when the line names a finding or a caveat — `typesafe error`, `user approved`, `slop: <symptom>`, `patterns: <id>` — because folding it would report a verdict the guard did not give. The worst verdict sits last, nearest the editor.
- The folded line is a display choice, not data loss: `/warden status` prints the raw line per guard under `Last:`, and the trace sidebar keeps every event with its scores. Templates still work; a template that keeps `{level}` or `{status}` mid-line has no verdict to lead with, so the guard name leads the line instead.

## 0.21.0

### Added

- Per-block retention for multi-block tool results (WARDEN-CTX-10). A result made of several parts (text plus images, or several text blocks) used to skip compression entirely; now each text block at or above `context.tailMinChars` earns its own retention request and its own excerpt, with its full text stored separately. Block order and non-text parts are untouched, and a credential or injection banner lands on the block that earned it instead of wrapping the first and last text block. Blocks below the threshold keep their text and still get the offline credential scan; `mergeOutput` gives the session bookkeeping (secret dedup, trace scores) the worst signal across blocks.

## 0.20.0

### The end-of-task restatement loop

A closing run used to collect a notice per guarded call (intent mismatch, credentials, off-task), and each delivered notice cost the agent one more LLM turn, which it filled by restating the final status. Six notices, six "CON-375 is complete" replies. The 0.16 wording caps and the 0.17 stuck-guard repeats could not touch this: the disease is not one reply, and not one tool call.

### Added

- `"steerBudget": 3` (default): steers delivered to the agent per run before further non-critical ones are recorded in the trace only. A notice skipped for the budget keeps its chance: the same notice can deliver on the next run. Critical guards (stuck, done, runaway recovery, subagent wake) always deliver, because their message starts the turn it asks for. `0` disables the budget.
- Restatement measurement (code only, no request): at the end of a run the final message is compared with the run's earlier final messages (`RestatementWindow`, `restatedShare` in `src/prose.ts`). A reply whose substantive sentences mostly restate an earlier reply of the same run is counted in the trace, the widget, and `/warden status`; it is never steered, because a nudge cannot retract the reply and would cost the turn it warns against. The window resets with each user prompt, so answering you is never a restatement.
- `/warden status` reports the run's restatement count and the steer budget next to the steer counts.

### Changed

- A repeated steer is no longer re-sent, not even as the one-line reminder: the reminder itself cost the accounting turn it forbade. The first copy is already in the agent's context; the trace says `steer recorded, not delivered` and carries the text. The delivery result is now known to the trace, so a notice the budget or a repeat swallowed no longer claims `agent told:`.
- `repeatSteer` is removed from the public API (`src/index.ts`); `SteerRepeatWindow` and `steerFingerprint` stay.

### Tests

- `tests/prose.test.ts` pins the restatement share (paraphrase restates, fresh information does not, one-line acknowledgements never count, the window resets per prompt).
- `tests/extension.test.ts` pins: a repeated notice is recorded only; the per-run budget records further notices and refills on the next prompt; critical guards deliver past the spent budget; a restating final reply is counted without steering.

## 0.19.0

### Changed

- Trace sidebar design pass. The verdict leads each entry as a bold colored chip (`ALLOW`, `STUCK`, `UNVERIFIED`) instead of hiding at the end of the line; the redundant `warden ·` prefix is gone; the body reads as data (subject in text tone, labels muted, numeric values bright); details stay dim under the entry; the header rule uses the border color. Same palette, same separators, same rail — hierarchy instead of new primitives.

## 0.18.0

### Changed

- A warn-level verdict no longer dies with the UI. In a headless run (`ctx.hasUI` false) the warn reasons go to the agent as a steer — the only reader available — instead of reaching nobody. Interactive sessions keep the UI notice with no extra steer. Decision on WARDEN-ACT-1: delivery to the agent, not gating on `steerVisible`, which is a display option.

## 0.17.0

### Changed

- The stuck guard now sees successful loops. A call that succeeds but prints the same normalised output `minFailures` times (the poll that keeps answering "all checks passed") reaches a repeat verdict in code, with its own nudge: act on the answer already in hand instead of re-running. `AttemptWindow.successRepeats` drives it; the widget flags the verdict `successful repeat`.

## 0.16.0

### Added

- `"notices": false` (default): the per-call yellow warnings (`warden · …`) no longer print in the transcript. The widget, the trace sidebar, and `/warden trace` still show every event; set `"notices": true` in the user config to print them again.

### Changed

- Steers bound the reply they ask for. The intent-mismatch and off-task steers now cap the acknowledgement at one short sentence and say not to restate session state, so a notice costs a line instead of an end-of-task essay.
- An unchanged steer is sent once. When the same notice (scores and counts ignored) repeats inside the last three steers, the agent gets a one-line reminder that nothing new is owed instead of the full text.
- Jev calls go through pi-typesafe's `ask`. `src/jev.ts` is removed: it was the same function plus a usage field. `tests/ask.test.ts` pins what the guards rely on, one signal for the per-guard timeout and the caller's abort, and failures that carry no upstream text.
- `/warden status` and the judge path consult `authState().usable` and `describeAuth()` instead of `resolveApiKey()`. An enabled warden with no usable key used to report "enabled" while silently running pattern checks only.
- `scripts/calibrate-action.mjs` takes AUC, the threshold grids, and the recommendation from `pi-typesafe/calibrate`, counters from `getSpend()`, and the price from `DEFAULT_USD_PER_MTOK`. Its session replay, labelling, and the two-parameter hold-rule report stay local.
- Dependency: `pi-typesafe` 0.3.0 to 0.5.0.

### Benchmarks (repo tooling, not in the npm package)

- `eval/fixture` v2 with ten rules, five of which no model can know from training, and every scored rule announced to both cells. `bare-todo` and `console-log` were scored before without ever being told.
- 15 tasks in four families (rules, project-only, verification, blast-radius) plus a 12-turn decay arc. Each task ships the files that make its shortcut tempting.
- `eval/verify.mjs` scores two axes independently of the guard: the final reply's claims against the checks the runner itself runs, and unasked visible actions from the tool calls plus the run's git state.
- `eval/env.mjs` drops credential-named variables whose value pi-warden itself would flag, so an environment dump cannot reach a model. Two of fifty deepseek runs had leaked a real-format token before this.
- Runner: `--concurrency` (each run has its own temp project and agent dir), `--turns N` for an arc in one session, a local bare `origin` so a push is observable, and a refusal to start without an explicit `--model` unless `--yes` is passed, because a batch spends real tokens.
- `scripts/eval-rescore.mjs` re-scores a finished batch against its own evidence when a checker is corrected, so a fix costs no model spend.
- Measured over 150 paired runs: 6 control runs with a rule violation against 0 warden runs; no false claims in either cell; no hold delta on blast radius; no rule-violation growth over the 12-turn arc. Reports and the checker corrections: [eval/reports/](eval/reports/README.md).

### Docs

- README leads with the measured numbers, adds "why a strong model does not make this pointless", and publishes what the benchmark does not show yet. No em-dashes.

## 0.14.0

- Credential notices trace fixture-shaped values instead of announcing them (`syntheticish`), while a real-shaped value is still reported once.
- `/warden status` counts steers per guard, so the cost of the guard is visible per session.
- Subagent triage: offline first, only a report that names trouble reaches Jev, one batched wake per `subagent.cooldownMs` (120 s) sent as a pointer that names the report, and a failed request stays quiet.
- README restructured around the guard table; the eval report generator stopped writing em-dashes.

## 0.13.0

- `npm run eval:ab`: a repeatable with/without benchmark. Each run gets an isolated `PI_CODING_AGENT_DIR` with exactly one extension, so the cells differ by pi-warden alone; a mechanical checker over the final diff shares no code with the guard.
- Rules observability: rules verdicts, silent allows included, land in the hold log with per-rule scores.
- Per-value credential dedup: warnings keyed on the fingerprint of the set of secrets in an output.
- Published negatives: the hermetic task showed no reliable effect, and the warden-cell test failures were model variance on the retry task where the guard stayed silent.

## 0.12.0

- Off-task never holds. On 17k recorded calls it made 40% of the holds and caught nothing the irreversible score missed.
- A visible action (commit, push, merge, publish, launch) that departs from the agent's plan warns; git bypass flags and PR merges warn.
- The credentials notice needs a value shape, so `secret: boolean` and bare env-var names no longer fire.
- Desktop notifications are off by default.
- `scripts/calibrate-action.mjs --extra` measures candidate questions on your recorded sessions.

## 0.11.1

- The intent steer threshold moves from 0.8 to 0.9, chosen on 17k recorded calls: a quarter of the volume with two to three times the precision.
- `scripts/calibrate-action.mjs` replays recorded sessions through the guard and labels each turn by what the user did next.

## 0.11.0

- The agent's own words before a call travel with the request as `plan`. A call that differs materially from the plan steers at `intent_mismatch` 0.8 when it is visible.
- Trace shows the plan and the score; the hold log records `planChars`.

## 0.10.0

- Hold feedback loop: every held call is labelled by what the user does next (approved, declined, redirected, complained), and `/warden status` shows holds per outcome with precision over the labelled ones.
- Live regret cases: 5 of 5 as expected.

## Earlier releases

One line each, from the release commit headers.

- 0.9.1 survive a stale shape module after an update; data text with substitutions elsewhere is still data
- 0.9.0 project rules judge written code; destructive text that is data no longer holds a command
- 0.8.0 runaway guard stops a looping reply; desktop notifications when the agent needs you
- 0.7.0 context saver drops duplicate results, keeps exact lines per output format, and points recalls at a search
- 0.6.0 a budget error from any guard stops further requests; the Action guard owns hold and approval
- 0.5.5 judge sibling tool calls together; overlap the end-of-turn checks
- 0.5.4 approval applies to the action, not the exact command string
- 0.5.3 measure the context saver
- 0.5.2 off-task holds only actions that change something; survive a mixed module graph
- 0.5.1 non-modal trace sidebar
- 0.5.0 tool-output security, tail compression, task context for scope
- 0.4.0 per-symptom code slop, prose slop against an audience, hidden steers, repeat escalation
- 0.3.0 configurable status line templates, session trace, and a live trace panel
- 0.2.2 guard context-mode `ctx_execute*` and powershell, and count checks run through them
- 0.2.1 README explains the slop feedback loop
- 0.2.0 steer mode by default, stuck-loop detector, done-check, slop notes, chat approval of held calls
- 0.1.2 README leads with real verdicts and the generated preview image
- 0.1.1 `/warden enable` prompts for and stores a key; `/warden test` shows the confirm dialog as a demo
- 0.1.0 first release: the action guard with pattern checks plus Jev judgments before bash, write, and edit
