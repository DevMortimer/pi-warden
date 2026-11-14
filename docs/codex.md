# Codex rules hooks

Install the CLI once with `npm install --global pi-warden`, then run `pi-warden init codex`. It adds one `PostToolUse` command hook, matched to `apply_patch`, to `~/.codex/hooks.json`, or to `$CODEX_HOME/hooks.json` when `CODEX_HOME` is set. `pi-warden init codex --project` uses the current project's `.codex/hooks.json` instead; Codex loads project hooks only when that project's `.codex/` layer is trusted.

Codex skips a new or changed hook until you review it: open `/hooks` in Codex once after `init` and trust the `pi-warden hook codex PostToolUse` entry. Codex keys that review to the hook's file, event, position and command. The command never contains a version, so upgrading pi-warden keeps the review. `init` appends its group after any existing ones, so no hook you already reviewed moves. Codex warns when one config layer defines hooks both in `hooks.json` and in `config.toml` `[hooks]`; keep one of the two per layer.

Start Codex with `PI_WARDEN_ENABLED=1` and the active backend's key in its environment. The default backend uses `TYPESAFE_API_KEY`. As for [Claude Code](claude-code.md), both are required, the CLI reads the global `~/.pi/agent/pi-warden/config.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`), and `.pi/pi-warden.json` project overrides do not apply. The same POSIX rule holds for the hooks file: a symbolic link is refused, with its path and the reason, before anything is written.

## Rules behavior

Codex reports every file edit as `apply_patch`, with the patch text in `tool_input.command`, and runs `PostToolUse` only after the whole patch applied. The hook parses the patch the way Codex does, including the `<<'EOF'` wrapper Codex tolerates, and judges each file it wrote against the same rule sources, path scoping, thresholds, soft findings, exclusions and per-edit question cap as Pi:

- `*** Add File` is judged as a write of the added content.
- `*** Update File` is judged as an edit with one entry per `@@` chunk, at most six per file: `before` is the chunk's context and removed lines, `after` its context and added lines, `newText` the added lines alone. A chunk that only removes lines is still judged, so deleting required content can be caught.
- `*** Move to` judges the file at its new path. `*** Delete File` sends nothing.

The context comes from the patch itself: the context lines Codex wrote around each change, usually three, rather than the up to 20 lines of the current file on each side that Pi and the Claude `Edit` hook send. The hook does not read the file on disk, so a later change to it cannot alter what is judged.

A path that does not resolve inside the project is skipped, and so are gitignored files and files under `rules.exclude`. A patch's first four files are judged at once, in parallel; a line in the feedback names how many more were not judged. Sensitive-path notes and the question-cap notice are shown once per session. A finding is `PostToolUse` additional context for the model. The hook never returns `decision: "block"`, which in Codex would replace the tool result, and never holds or denies the call.

This adapter covers per-edit rules for `apply_patch` only. It does not see files written by shell commands, MCP tools, or `apply_patch` run inside a shell command: Codex applies that patch itself and runs no `PostToolUse` hook for it. The other guards still run only inside Pi.

## Deadlines and state

Hook stdin and each local text file are limited to 1 MiB. The whole invocation has an eight-second deadline, and the installed hook a ten-second Codex timeout. The engine runs in a child process that the CLI cancels and, when necessary, terminates. Hook failures, including a patch that cannot be parsed, exit zero and report a bounded diagnostic on stderr. Stdout contains only hook JSON. Feedback is capped at 9,000 characters. Codex saves `additionalContext` over its default limit of about 2,500 tokens to a file and shows the model a preview.

State lives under `<agent dir>/pi-warden/state/codex/<session hash>/`: exclusive processed-call, sensitive-path, notice and request-slot markers and the session's request cap, and no file content. Session, subagent and tool-use identity keep a replayed call from sending a second request or a second feedback. `maxRequests` (default 500 per session) is enforced across hook processes exactly as for [Claude Code](claude-code.md#deadlines-and-state), with the same optional daily caps from pi-typesafe.

## Uninstall

Run `pi-warden uninstall codex` for the user hooks file, or `pi-warden uninstall codex --project` for the current project's. Each scope keeps its own installation receipt under `<agent dir>/pi-warden/hosts/codex/`. Uninstall removes only the unchanged entry this CLI added, keeps the other hooks and the file's `description`, and reports a retained user-modified or duplicated entry. A hook group listed after the removed one moves up one position, so Codex may ask you to review it again. Uninstall preserves `pi-warden.md`, global configuration, API keys, session state and history.
