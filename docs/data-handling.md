# Data handling

What pi-warden sends to TypeSafe, what it keeps on this machine, and what it never sends. Nothing leaves the machine until you run `/warden enable` and confirm the notice (or set `PI_WARDEN_ENABLED=1` for headless runs).

## What is sent, per guard

With consent, requests go to `https://api.typesafe.ai` (default) or `https://openrouter.ai` when `typesafeBackend` is set to `"openrouter"` in the user config.

| Guard | Sent |
| --- | --- |
| **Action** | Your latest prompt (1500 characters), the task spine it is judged against (the thread's first request and up to four earlier requests, redacted, capped at 1200 characters together), up to eight earlier user and assistant messages (750 redacted characters each), the agent's text from the message that makes the call (500 redacted characters), the tool name, the command (2000 characters) or the file path (relative inside the project, `~`-shortened outside), whether the file exists, a 1500-character head/middle/tail sample of a `write` (or of the content a `bash` command writes to a file with the content in the command, with the written paths), the first three edit pairs (400 characters each) of an `edit`. The resolved active rules content (`pi-warden.md`, the configured files, or `AGENTS.md`/`CLAUDE.md`/`README.md` as fallback, token-aware truncated at ~4000 tokens) is sent with every action request, unless `rules.enabled` is false: with the rules guard off, no rules content leaves the machine. On the first guarded call after your reply, the tool names and commands (300 characters) or paths of up to six calls allowed in the previous turn, for the regret question. |
| **Rules** | The project-relative path, a 6000-character sample of a `write` (or of the content a `bash` heredoc, `echo`, or `printf` writes to a file, judged as a `write`) or each edit's new text (1500 characters) with about 40 lines of the current file around the replaced text, and the rule text from your rules file or the condensed fallback document (`rules.maxChars`). No task text. Files under `rules.exclude` are never sent. |
| **Stuck** | The last 12 tool calls (300 characters each) with 400-character output tails. |
| **Done-check and prose** | The agent's final message (2000 and 2500 characters), the run's check commands, the audience description. |
| **Output checks** | A redacted head/tail sample up to 6000 characters plus size, line counts, and tool name. |
| **Conscience** (recommend mode) | Your current request (2000 redacted characters), the same task spine (the thread's first request and up to four earlier requests, redacted, capped at 1200 characters together), up to four recent user/assistant text messages (500 redacted characters each with roles), and sanitized candidate metadata (skill/tool name, role, lead, useWhen, examples when an index entry matches; bare description otherwise). Full skill instructions never go to Jev. The index is built locally by the session model; only sanitized entries reach Jev; advertised locations never do. Sent only when TypeSafe consent is given and the conscience module is enabled. |
| **Conscience** (load mode) | Same judge payload as recommend mode, plus: the selected skill file is read from disk (bounded by `maxSkillBytes` and `maxLoadedBytes`), frontmatter is stripped, credentials are checked, and the complete body is supplied to the main model via a custom message. Skill bodies never go to Jev. |
| **Subagent triage** | Only for a child report that names a failure, a stop, a timeout, or a question (an incremental progress line or a clean completion is answered in code and sends nothing): a redacted 1500-character head plus 500-character tail of the report, the notification type, whether it is an incremental notify, its length, and your latest prompt (1000 characters). |
| **Nothing** | Duplicate detection, the runaway guard, sensitive-path notes, the offline part of subagent triage, and pattern checks run entirely in code. |

## What stays on this machine

- The hold feedback log under `~/.pi/agent/pi-warden/holds/`, owner-only: one JSON line per judged call with tool, pattern ids, scores, level, mode, outcome, and the length of the agent's stated plan; never the command, prompt, or plan text. A redacted tool+path excerpt is included for auditing off-task and intent-mismatch. `"action": { "feedbackLog": false }` turns the file off.
- An owner-only SQLite database under `~/.pi/agent/pi-warden/holds.db` stores redacted hold context (plan, summary, redacted command preview, outcomes) for held and judged-allowed calls (`held = 1` and `held = 0`), for learning and retention (configurable, default 365 days). Calls the guard skipped as read-only are not stored. The `PI_WARDEN_DB` environment variable overrides this path; tests and eval runs use it to write to an isolated database instead of the user's.
- With `PI_WARDEN_TRACE_DIR` set to an absolute path, the trace of each session in `<path>/<session id>.jsonl`, owner-only: the same redacted lines the trace sidebar shows (status line, details, widget tokens), the session id, the working directory (`~`-shortened), the Warden version, the mode, and whether Jev judgments are on (or the reason they are off). Off by default. See [configuration.md](configuration.md#trace-file).
- Full copies of compressed tool output, owner-only, in the OS temporary directory. They can contain secrets and stay there until removed.
- The compaction evidence appendix (`pi-warden-compact-evidence`), sent as a local session message after compaction. Contains failed calls and one error line from each output (redacted), the last passing check command (redacted), saved-output paths (redacted), last check commands (redacted), held actions (redacted), stuck state, and the active task. Goes to the session model with the rest of the context; nothing new leaves for Jev.
- Your API key in `~/.pi/agent/pi-typesafe/auth.json` (owner-only, shared with pi-typesafe). `TYPESAFE_API_KEY` in the environment takes precedence and is never written to disk.
- Consent and settings in `~/.pi/agent/pi-warden/config.json`.

## Redaction

Obvious credentials (`Authorization` headers, `TOKEN=` and `SECRET=` assignments, `sk-`, `ghp_`, `AKIA`, JWTs, URL passwords, PEM blocks) are replaced with `[redacted]` before sending. Best-effort; do not rely on it for prompts that contain secrets.

Text steered to the agent names the tool, the reasons, and the scores, not the command. User-declared path rules and command rules are evaluated entirely in code; their matches travel only as pattern ids and scores in the reasons, never as the matched path or command text. Arming-rule state is session-local memory that never leaves the machine. UI errors never include upstream response bodies or keys. Judgments are model output; thresholds are yours to tune.
