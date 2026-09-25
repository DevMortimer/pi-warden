# Changelog

Notable changes to pi-warden, newest first. Versions follow semver. The published surface is `dist/` plus `README.md`; changes under `eval/`, `scripts/`, and `docs/` are repo tooling and ride along with the next release.

How to keep this current: add the entry in the same pull request as the change, under `Unreleased`. The release commit renames `Unreleased` to the version it ships and adds its own notes. Entries before 0.10.0 are one-line summaries taken from the release commit headers; the detail for those is in `git log`.

## Unreleased

### Added

- The context saver cuts repeated runs. In a new tool result, user message, or custom message, a run of at least 20 lines and 1500 characters that exactly matches text already in context on the current branch becomes one pointer line naming where the earlier copy is and the file that holds the full text. The last 2000 characters and images are never changed. The ledger counts the removed bytes and their token-turns; `/warden status` shows the repeats cut. `context.dedupeRuns` (default `true`) turns it off.

### Tests

- A repeated report in a new custom message, user message, and tool result is cut to one pointer line; one changed line breaks the match; the tail stays; the stored copy holds the full text and reading it back is a recall; `context.dedupeRuns: false` leaves everything whole.

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
