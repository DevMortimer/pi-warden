# Claude Code rules hooks

Install the CLI once with `npm install --global pi-warden`, then run `pi-warden init claude`. It adds command hooks to `~/.claude/settings.json`. `pi-warden init claude --project` uses the current project's `.claude/settings.json` instead. Project installation selects the hook settings scope; Claude's own workspace trust and managed settings still govern whether hooks run.

On POSIX, the selected `settings.json` must be a regular file, not a symbolic link into a dotfiles repository. An existing link, including a dangling one, is refused on the initial settings read, before settings or receipt writes. The error reports its path and the reason, leaving the link, its target and any installation receipt unchanged. Settings and receipt errors identify the affected file without printing its contents.

Start Claude with `PI_WARDEN_ENABLED=1` and the active backend's key in its environment. The default backend uses `TYPESAFE_API_KEY`. Both are required: a saved `typesafe: true` setting or stored login key does not replace the explicit headless environment settings. The CLI reads the same global `~/.pi/agent/pi-warden/config.json` as Pi, or the agent directory selected by `PI_CODING_AGENT_DIR`. It does not apply `.pi/pi-warden.json` project overrides.

## Rules behavior

The hooks handle successful Claude `Write` and `Edit` calls. They reuse the existing rule source order, path scoping, thresholds, soft findings, exclusions and per-edit question cap. Disabled rules and gitignored files send no judgment request. Sensitive-path notes and the question-cap notice are emitted once per session. A finding is `PostToolUse` additional context: the file has already been changed, and the hook never holds or denies the call.

`Edit` captures real context in `PreToolUse` and computes the complete result of exact `replace_all` replacements. `PostToolUse` checks the input and resulting file fingerprints before judging it. Missing or expired capture, changed input, ambiguous replacement, concurrent modification or invalid state skips that judgment and reports a diagnostic. The hook does not infer a pre-edit file from the post-edit disk or transcript. Empty replacements remain edits, so deleting required content can be judged.

This adapter covers per-edit rules only. It does not register a Stop/done check or the other guards, and it does not observe Bash writes, external tools or arbitrary filesystem changes. Pi's exact repeated-finding ordinal and standing-rule wording are not reproduced.

## Deadlines and state

Hook stdin and each local text file are limited to 1 MiB. Edit samples keep the existing six-edit, 1,500-character and 20-line context limits; a stored capture is limited to 256 KiB. A non-regular, oversized, growing or unreadable input is skipped. The whole invocation has an eight-second deadline, including input and configuration; requests also use the configured `timeoutMs`. The CLI cancels its engine and, when necessary, terminates and reaps it. Cancellation also kills the direct `git check-ignore` child; descendants started by a shell or other `git` wrapper on PATH are outside that cleanup guarantee and may outlive the hook. Hook failures exit zero and report a bounded diagnostic. Stdout contains only hook JSON.

State lives under `<agent dir>/pi-warden/state/claude/<session hash>/`. Captures contain bounded redacted samples and fingerprints, are rejected after ten minutes, and are consumed exclusively. Later invocations in the same session prune expired capture files; an ended session can retain unused captures on disk. Session, actor and tool-use identity prevent replayed Write/Edit calls from issuing duplicate requests or feedback. Processed receipts and request reservations are separate from capture expiry and are retained.

`maxRequests` defaults to 500 requests per session and is enforced across fresh hook processes with exclusive, non-refundable session reservations, including each chunked judgment request. A failed, cancelled or crashed reservation stays consumed. If a reservation cannot be persisted, no request is submitted. The cap is fixed on the first invocation; changing it requires a new Claude session. These guarantees require the session state to remain intact on the local filesystem. By default, there is no daily request-count cap; a valid positive `PI_TYPESAFE_MAX_REQUESTS_PER_DAY` sets the SDK's daily request cap. Its separate daily input-token and spending caps can be set with `PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY` and `PI_TYPESAFE_MAX_USD_PER_DAY`. The SDK's shared daily usage and auth records retain their existing best-effort accounting and concurrent update behavior.

## Upgrade and uninstall

Hook commands are stable strings such as `pi-warden hook claude PostToolUse`; they contain no version, checkout path or per-call `npx`. Upgrade the global package normally. The CLI must remain on the PATH used by Claude's command-hook shell. The hooks use shell form so npm's Windows command shims are not passed to direct exec. POSIX behavior is covered by offline CLI tests; native Windows validation is still pending.

Run `pi-warden uninstall claude` for user settings, or `pi-warden uninstall claude --project` for the current project's settings. Each scope keeps its own installation receipt under `<agent dir>/pi-warden/hosts/claude/`. A pre-existing identical command belongs to its author. Uninstall removes only unchanged entries this CLI added, keeps other handlers in mixed groups, and reports retained user-modified or duplicated entries. Invalid JSON or an observed concurrent settings edit stops the operation without replacing that edit. An interrupted settings/receipt write is reconciled from its recorded before/after fingerprints; an ambiguous result is left for inspection.

Uninstall preserves `pi-warden.md`, global configuration, API keys, session state and history. It does not modify the other scope.
