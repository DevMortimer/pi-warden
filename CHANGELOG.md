# Changelog

Notable changes to pi-warden, newest first. Versions follow semver. The published surface is `dist/` plus `README.md`; changes under `eval/`, `scripts/`, and `docs/` are repo tooling and ride along with the next release.

How to keep this current: add the entry in the same pull request as the change, under `Unreleased`. The release commit renames `Unreleased` to the version it ships and adds its own notes. Entries before 0.10.0 are one-line summaries taken from the release commit headers; the detail for those is in `git log`.

## Unreleased

### Fixed
- `scripts/calibrate-action.mjs`: `--yes` now spends what the corpus needs instead of stopping at the 2000-request default; `--max-requests N` is an explicit cap that `--yes` does not lift, and a run it stops early says how many replays it skipped and writes `report-latest-partial.md`.

### Docs
- Action guard calibration on 315 recorded sessions at 0.33.3 under `eval/reports/2026-09-21-calibration-0.33.3/`, with the headline table in `docs/guards.md`.

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
