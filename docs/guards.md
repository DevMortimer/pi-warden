# The guards in detail

Every guard, what it looks at, the questions it asks Jev, the thresholds, and the numbers behind them. The [README](../README.md) has the short version. Defaults live in [configuration.md](configuration.md); what leaves the machine is in [data-handling.md](data-handling.md).

Contents: [Action guard](#action-guard) · [Calibration](#calibration) · [Rules](#rules) · [Slop](#slop) · [Security](#security) · [Stuck](#stuck) · [Runaway](#runaway) · [Done-check](#done-check) · [Context saver](#context-saver) · [Desktop notifications](#desktop-notifications) · [Steer messages](#steer-messages)

## Action guard

Runs on `tool_call`, before the tool executes.

1. **Skip** read-only tools and read-only shell lines (`git status && ls`): no request, no widget line.
2. **Patterns**, offline: force pushes, `git reset --hard`, `git clean`, recursive `rm` on absolute, home, variable, or parent paths, SQL `DROP`/`TRUNCATE`/`DELETE FROM`, block-device writes, `chmod -R 777`, fork bombs, `curl | sh`, `kill -1`, shutdown, package publishing, infrastructure destroys hold the call. `rm -rf` on a project path, `git checkout -- .`, `git branch -D`, `git stash drop`, `find -delete`, `sudo`, `--no-verify` or signing switched off on a git command, and `gh pr merge` warn. Reads or writes of `.env`, SSH, AWS, npm, kube, and other credential files warn. A `write` that overwrites a file outside the project holds; creating or editing outside the project warns.

   Text that is data is not a command. A heredoc body written to a file, a quoted `echo`/`printf` argument, a `grep` pattern, or a `git commit -m` message can mention `git push --force` without a hold. The same text fed to `sh`, `bash -c`, `eval`, `xargs`, or a `python3 - <<EOF` script that calls `os.system` keeps every hit.
3. **Jev**, with consent: one request with `{ task, context, plan, action }` and four questions. `irreversible` (yes/no), `off_task` (yes/no), `mutates` (does it change anything), `scope` (expected step, plausible side step, unrelated, unclear). Defaults: irreversible at 0.5 warns and at 0.7 holds. Off-task never holds: at 0.6 it warns, and at 0.85 with `unrelated` on a call that can change something the agent is also steered back to your request (an unrelated `grep` is warned about only). Patterns set the floor; Jev can only raise it.

   `plan` is the agent's own words in the message that makes the call (or its latest text since your prompt, 500 redacted characters). It tells Jev which step this is, so a verification fixture the agent just announced is not judged unrelated; it never authorizes anything. When there is a plan, a fifth question `intent_mismatch` asks whether the call does something materially different from it: a delete where the plan said list, a force push where it said push. At `action.intentMismatch` (0.9) on a call that can change something, the call is warned about and the agent is told to keep its words and its calls in step. A command whose effect is visible outside the working tree (`visible`: a commit, push, merge, publish, message, install, launched program) needs only `action.visibleMismatch` (0.8): on recorded sessions that pair is what users objected to. Never held on that alone. The trace shows the plan under each verdict.
4. **Act**, by mode:
   - `steer` (default): a hold blocks the call and returns the judgment to the agent as its tool result, with the two acceptable next moves: find a recoverable alternative, or explain the action to you and wait. If your reply approves it, the retry goes through (Jev reads your reply; offline, a yes/go-ahead heuristic does).
   - `confirm`: a `ctx.ui.confirm` dialog. No blocks with a short reason. Falls back to `steer` without a UI.
   - `advise`: never holds, reports only.

The action guard receives your latest message plus up to eight earlier user and assistant messages (750 redacted characters each) so follow-ups and side comments do not replace the task. Sibling tool calls in one assistant message are judged together in one round trip. If TypeSafe cannot answer, the call is allowed with a warning (`failOpen: true`; set it to `false` to hold instead).

**Hold feedback.** What you do next labels each judgment, so hold precision is measured on your sessions rather than assumed. A hold your reply releases (or the confirm dialog allows) was a false positive; a hold you decline, or that nobody approves after you replied and the next turn ended, stood. An allowed call your next message tells the agent to stop, undo, or revert was a miss: one `regretted` question rides the first action request after your reply, with the redacted summaries of last turn's allowed calls (a locator names the one when there are several); offline, a stop-word heuristic stands in. `/warden status` shows the counts and the precision, the trace entry of each call gets its outcome, and every judged call is written with its scores and outcome to an owner-only per-session file under `~/.pi/agent/pi-warden/holds/` (tool, pattern ids, scores, level, mode, outcome; never the command). `"action": { "feedbackLog": false }` keeps the counts and skips the file.

### Calibration

`node scripts/calibrate-action.mjs --all` replays every guarded call in your recorded Pi sessions through the guard (one request per call) and asks Jev, once per turn, whether your next message regrets one of the calls that ran, approves each held call, and how it receives the turn (continues, corrects, rejects, unrelated). Run on 321 sessions from this machine (1,085 labelled turns, 17,160 guarded calls, 14,903 judged):

- Regret is rare: 20 calls (2% of turns). None of them was about data loss: their `irreversible` scores were 0.04 to 0.57, median 0.07. They were scope and permission complaints: a commit the user did not want, an edit to a personal `CLAUDE.md`, a merge, a test run when conflicts were the job, a program launched at night. The hold rule catches none of them at any threshold that holds fewer than 3% of calls, so the hold defaults stay where they are; they are a checkpoint for destructive actions, and regret is the wrong yardstick for those.
- Signal ranking against regret (AUC): `mutates` 0.74, `irreversible` 0.71, `intent_mismatch` 0.57, `off_task` 0.51. Off-task alone caused 56 of the 139 replay holds and none of them drew a complaint, so since 0.12 off-task warns and steers but never holds (`offTask.steer`; a `confirm` key in an older config file still sets it).
- The intent steer earned its threshold here. At 0.8 it fires on 11% of calls that can change something and 14% of those sit in a turn the user rejects (base rate 5%); at 0.9 it fires on 4% and 33% of those are in a rejected turn, 54% in one the user rejects or corrects (base rate 24%). The default is 0.9.
- A second pass asked four candidate questions on the same calls (`scripts/action-candidates.mjs`, `--extra`). None separates rejected turns on its own: "would a careful engineer ask first", "is this unrequested", "did the user ask to pause", and "is the effect visible outside the working tree" all sit at the 4 to 5% base rate. `visible` has the best recall on regret (AUC 0.82, 10 of 19 regretted calls) but a commit or push is usually what was asked. Paired with the plan it works: `visible >= 0.8` and `intent_mismatch >= 0.8` flags 1.1% of calls with 18% in a rejected turn, so that pair steers at `visibleMismatch` 0.8. Two deterministic patterns came from the regretted list: a git command with hooks or signing switched off, and `gh pr merge`.
- Of 42 holds pi-warden made in those sessions, the user's next message approved 5.

It is not cheap: the two full runs above made about 32,000 requests and 80M input tokens together (about $3.40 at the listed rate), because every replay carries the prompt, eight context messages, the plan, the action, and the questions. `--dry-run` prints the request count, token estimate, and cost first; a run over 2,000 requests stops there unless you add `--yes`. The output stays under `.local/calibration/` (owner-only, never committed); `--report FILE` recomputes the tables without requests, `--project DIR` limits the run to one project's sessions.

## Rules

Write your project's rules as Markdown headings in `pi-warden.md` at the project root (a starter file with a dozen rules is in [`examples/pi-warden.md`](../examples/pi-warden.md)):

```markdown
# No console statements
Code must not contain `console.log` or `console.debug`. Use the logger.

# Exported functions must have explicit return types
paths: src/**/*.ts
Every exported function declares its return type.

# TODO comments need a reference
A `TODO` or `FIXME` must name a ticket, for example `TODO(APP-123): ...`.
```

Each heading is one rule; the text under it is the specification. A `paths:` line right under the heading limits the rule to matching files (`**` matches any depth, `*` stays within one segment). Content inside code fences is never read as a heading. The highest heading level present in the file delimits rules, so `##` rules under a `#` title work too.

On every `write` and `edit`, pi-warden sends its own request, in parallel with the action guard's, carrying the written content and one question per rule: `compliant`, `violation`, `not_applicable`, or `insufficient_context`. A `write` is sampled at 6000 characters (head, middle, tail); an `edit` sends each new text plus about 40 lines of the current file around the replaced text. With two or more edits, one more question asks which edit contains the violation.

Any rule with P(violation) at or above `rules.threshold` (0.7) is named to the agent: the heading, up to 200 characters of the rule text, and the edit when located. The write goes through; a held write would leave a half-written file. The third hit of one rule in a session says so and asks the agent to treat it as a standing rule. When slop also fires on the same write, both arrive as one message.

Sources, in order: `pi-warden.md` at the root; else the files listed in `rules.files` (all sent in one request); else, with `rules.fallback` (default true), the first of `README.md`, `CLAUDE.md`, `AGENTS.md`, judged as one document with one question. A fallback document is cut to `rules.maxChars` (8000) with every heading and the head of each section kept, so a very long AGENTS.md still fits. Files are re-read when they change; no restart needed. At most 31 rules are asked per request (TypeSafe's cap is 32); the rest are ignored and `/warden status` says how many.

Path scoping in config: `rules.exclude` globs are never sent to Jev (secrets, generated, vendored files); `rules.skip` globs are files the rules do not apply to (tests, docs); a per-rule `paths:` line narrows one rule. `rules.sensitivePaths` maps a glob to a note, for example `"migrations/**": "Tell the user this touches a migration and add a rollback"`; a write or edit under a matching path gives the agent that note once per path, offline, with no request.

From the tuning set (`scripts/rules-cases.mjs`, 8 rules, 13 cases, all as expected): `console.log` in code scores 1.00, a bare TODO 1.00 and a `TODO(QUEUE-41)` 0.00, an empty catch 0.99, a `switch` without `default` 0.96, a hardcoded token 0.88, a missing return type 0.99 with a bad boolean name 0.96 on the same write. A compliant module, a test that mentions `console.log` in a string, and a Markdown doc about `console.log` score nothing. The locator points at the right one of two edits. Not covered: code written through shell heredocs and content past the sample limits.

Ideas borrowed with thanks from [jevrealtimecodecheck](https://github.com/MrDesjardins/jevrealtimecodecheck) (rules as headings, the four outcomes) and [wince](https://github.com/TinyFrontier/wince) (path globs, sensitive paths, judge the change and not its story, the locator question).

## Slop

**In code.** When the agent calls `write` or `edit`, four yes/no questions ride on the action guard's request (no extra latency), one per symptom: `slop_stub` (placeholder or fake-data code where a working implementation is needed), `slop_comments` (comments that restate the code), `slop_dead` (commented-out code, unused imports, duplicated logic, unreachable branches), `slop_hedging` ("should work", "for now", TODOs without a plan). Jev sees a 1500-character head/middle/tail sample of a `write` or the first three replacement texts of an `edit`. Any symptom at or above `slop.threshold` (0.7) sends the agent a steer naming the symptom and its fix. The write is never held. The third repeat of a symptom becomes a standing rule.

From the tuning set (`scripts/slop-cases.mjs`): a `// TODO: implement later` stub scores stub 0.99; restating comments 0.97 while an explanatory why-comment scores 0.08; commented-out code scores dead 0.96; a mock inside a test file scores stub 0.51 (below threshold, correctly).

**In replies.** The final reply (200 characters or more) is judged against `slop.prose.audience`: `wordy`, `cliches`, `jargon`. `audience` is `technical` (default), `plain`, or free text such as "a founder without programming background". A symptom must appear in `trend` (2) of the last 3 replies before the agent is nudged; the nudge is queued for your next prompt so it shapes the next reply without spending a turn. A padded reply scores wordy 0.97 / clichés 0.99; a dense three-point summary 0.25 / 0.05.

## Security

Written code gets a `security_risk` question on the action request: hardcoded credentials, disabled TLS checks, unsafe shell or SQL interpolation, broad permissions, bypassed verification. A threshold crossing (0.7) warns you and steers the agent; it does not block.

Tool output from content-bearing tools (`read`, fetch and search tools, named MCP equivalents) is checked for instructions that redirect the assistant or ask for private data; other tools from 2048 characters. Jev receives a redacted 6000-character head/tail sample. A score at or above `security.threshold` wraps the text in an untrusted-data notice and steers the agent. Credential-shape checks work offline and warn not to echo or commit possible secrets. This is advisory, not a sandbox.

## Stuck

Keeps the last 12 tool results for the current prompt. When the latest result failed and at least 3 failures have accumulated, exact repeats are caught offline (same call, same output with timings and addresses normalised). Otherwise one request judges the sequence: `same_strategy`, `approach_change` (identical / cosmetic / meaningfully different), `progress`. Same strategy at 0.7 counts as stuck: you get a notification and the agent gets a steer asking for a new hypothesis or a blocker report. At most one check per 3 results. In the smoke run, "investigating between failures" scored 0.32 and "flailing" 0.93.

## Runaway

A model that degenerates mid-reply repeats the same lines until the token limit or you press Esc; no tool runs and no turn ends, so nothing else stops it. pi-warden reads the stream as it arrives: per token it appends to a buffer; every 256 characters it counts identical paragraphs (24 characters or more) and checks for one unit repeated back to back at the end. A block repeated `repeats` (4) times in the reply, or `thinkingRepeats` (10) times in thinking, aborts the run. Code only: nothing is sent anywhere. With `recover: true` (default) the agent gets one follow-up turn that names the repeat and asks for the one next step; a second runaway for the same prompt is stopped and left for you. Calibrated on 43,000 local assistant messages: ordinary replies repeat a paragraph twice at most, thinking up to seven times, and the one real runaway repeated its block 28 times. The guard stopped only that one, at half its length.

## Done-check

Tracks each run's evidence: code changes (`write`, `edit`) and check commands (`npm test`, `pytest`, `cargo test`, `tsc`, `eslint`, `go test`, `make test`, and similar) with pass or fail; context-mode's inline `Command exited with code N` counts as a failure. A check counts only if it ran after the last change: an edit after a passing run puts the run back in unverified territory, because nothing has yet run on the code as it stands. Earlier checks stay in the trace as history; the check, the numbers Jev sees, the reason, and the gap line count only the checks that cover the current code. When a run ends with a normal message after code changes and no passing check, one request judges the message: `claims_done`, `claims_verified`, `verification_applies`, `outcome`. A completion claim at 0.7 or above for a task where checks mean something is reported as unverified; a claim that tests passed when no check ran anywhere in the run is called a false claim; a check that only ran before the latest change leaves the run unverified, not falsely claimed. With `nudge: true` the agent gets one follow-up turn asking it to run the checks or say plainly that nothing was verified. Once per prompt.

## Context saver

Only the newest tool result is ever changed, before it enters the session, so the prompt cache prefix and all earlier entries stay as they were.

- **Duplicates** (code only). A text result of at least `context.duplicateMinChars` (2000) that is identical to an earlier result of this session becomes a short note naming the earlier tool and the size, plus a recall footer. Re-running the same failing test is the typical case.
- **Retention and format** (Jev decides, code applies). For a single text block of at least `context.tailMinChars` (12000), Jev picks `all`, `errors_and_summary`, or `summary_only`, and names the format (`vitest_jest`, `node_test`, `tsc`, `eslint`, `pytest`, `git_diff`, `git_log`, `npm_install`, `other`). When a format is confident (0.7) and its markers are present, a parser keeps the exact lines that matter: failing tests with their assertions, compiler and linter errors with file and line, changed files with counts, package notices, the summary line. Otherwise bounded head, diagnostic, and tail excerpts. Nothing is paraphrased. The full output is written to an owner-only temporary file first; the excerpt links to it. If storage fails, the original stays. Multiple text blocks are not compressed.
- **Recall through search.** The footer names the file and a search command that exists on this machine (probed once: `rg`, `ag`, `ugrep`, `git grep --no-index`, `grep`, `Select-String`, `findstr`). `context.recallTool` pins one or `none`.
- **Measuring it.** `/warden status` shows how many outputs were candidates, how many were compressed or dropped as duplicates, the bytes removed, the token-turns spared, and the recalls, split into whole-file reads (which give the saving back) and scoped accesses. A recall rate above about 10% means `context.confidence` is too low for your work.

Set `context.enabled: false` to turn it off. Full-output files can contain secrets and stay in the OS temporary directory until removed.

## Desktop notifications

Off by default. With `"notify": { "enabled": true }` in your config, a held call the agent will ask you about, a confirm dialog waiting for an answer, and a runaway stop reach the desktop. macOS uses `osascript`; Linux tries `notify-send`, `dunstify`, `gdbus`, `kdialog`, `zenity`, then `powershell.exe` for WSL; Windows shows a toast through PowerShell. Interactive sessions only, one notification per `cooldownMs` (10 s), the reason but never the command. `"command": ["curl", "-d", "{body}", "https://ntfy.sh/your-topic"]` in the user file replaces the desktop tool with your own relay (no shell; `{title}` and `{body}` are replaced and set as `PI_WARDEN_TITLE` / `PI_WARDEN_BODY`). A project file may switch notifications off but never names a command.

## Steer messages

Nudges from the rules, slop, stuck, done, and prose guards are custom messages in the agent's context. By default they are hidden from the transcript (`steerVisible: false`); the notification tells you a nudge happened and the trace panel shows the exact text. When the per-session request budget is spent, pi-warden says so once and continues with offline checks.
