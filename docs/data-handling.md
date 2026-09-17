# Data handling

What pi-warden sends to TypeSafe, what it keeps on this machine, and what it never sends. Nothing leaves the machine until you run `/warden enable` and confirm the notice (or set `PI_WARDEN_ENABLED=1` for headless runs).

## What is sent, per guard

With consent, requests go to `https://api.typesafe.ai` only.

| Guard | Sent |
| --- | --- |
| **Action** | Your latest prompt (1500 characters), up to eight earlier user and assistant messages (750 redacted characters each), the agent's text from the message that makes the call (500 redacted characters), the tool name, the command (2000 characters) or the file path (relative inside the project, `~`-shortened outside), whether the file exists, a 1500-character head/middle/tail sample of a `write`, the first three edit pairs (400 characters each) of an `edit`. On the first guarded call after your reply, the tool names and commands (300 characters) or paths of up to six calls allowed in the previous turn, for the regret question. |
| **Rules** | The project-relative path, a 6000-character sample of a `write` or each edit's new text (1500 characters) with about 40 lines of the current file around the replaced text, and the rule text from your rules file or the condensed fallback document (`rules.maxChars`). No task text. Files under `rules.exclude` are never sent. |
| **Stuck** | The last 12 tool calls (300 characters each) with 400-character output tails. |
| **Done-check and prose** | The agent's final message (2000 and 2500 characters), the run's check commands, the audience description. |
| **Output checks** | A redacted head/tail sample up to 6000 characters plus size, line counts, and tool name. |
| **Nothing** | Duplicate detection, the runaway guard, sensitive-path notes, and pattern checks run entirely in code. |

## What stays on this machine

- The hold feedback log under `~/.pi/agent/pi-warden/holds/`, owner-only: one JSON line per judged call with tool, pattern ids, scores, level, mode, outcome, and the length of the agent's stated plan; never the command, path, prompt, or plan text. `"action": { "feedbackLog": false }` turns the file off.
- Full copies of compressed tool output, owner-only, in the OS temporary directory. They can contain secrets and stay there until removed.
- Your API key in `~/.pi/agent/pi-typesafe/auth.json` (owner-only, shared with pi-typesafe). `TYPESAFE_API_KEY` in the environment takes precedence and is never written to disk.
- Consent and settings in `~/.pi/agent/pi-warden/config.json`.

## Redaction

Obvious credentials (`Authorization` headers, `TOKEN=` and `SECRET=` assignments, `sk-`, `ghp_`, `AKIA`, JWTs, URL passwords, PEM blocks) are replaced with `[redacted]` before sending. Best-effort; do not rely on it for prompts that contain secrets.

Text steered to the agent names the tool, the reasons, and the scores, not the command. UI errors never include upstream response bodies or keys. Judgments are model output; thresholds are yours to tune.
