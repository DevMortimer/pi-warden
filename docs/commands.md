# Commands, status line, and trace

## Commands

| Command | Effect |
| --- | --- |
| `/warden status` | Guard state, consent and key source, session counts, steers sent per guard, the steer kinds that are trace-only per model with their rates, thresholds, context saver totals, hold precision, rules source, config paths, last verdicts |
| `/warden rules` | List the active parsed rules, their path scopes and source files, plus the dropped count and `rules.exclude` patterns. This is local-only and sends nothing to Jev. |
| `/warden enable` | Data notice, key prompt if none is stored, consent saved |
| `/warden disable` | Stop Jev judgments; pattern checks continue |
| `/warden mode steer\|confirm\|advise` | How holds are handled; without an argument, show the current mode |
| `/warden config` | Open the user-config panel (`s` saves, `q` closes, and a second `/warden config` closes it the way `/warden trace` toggles the trace). `/warden config set <key> <value>` and `/warden config get <key>` change one key without the panel |
| `/warden test` | One synthetic destructive action, its verdict, and what the agent would be told |
| `/warden trace` | Toggle the trace sidebar (or print the last 20 events without a UI, or as one notification in RPC mode, where the sidebar cannot show) |
| `/warden init` | Scaffold a starter `pi-warden.md` with safety rules and project-type rules. Pass `--force` to overwrite an existing file. |
| `/warden recommend` | Learning recommendations: up to 5 threshold and pattern suggestions from this project's hold history, then a steer-effectiveness report (overall rate, up to 3 suggestions, the rate per steer type). Read-only; reads the local holds database only, so nothing is sent anywhere and no Jev request is made. With too little hold data it says so. |
| `/warden prefs` | Standing preferences: corrections and preferences you repeated in 2 or more earlier sessions of this project, up to 10, and the lessons the agent recorded with `warden_remember`, each with its session count, last date, and "injected" or the rule that kept it out of the session-start message (`prefs.inject`). Add the ones you want to keep to `pi-warden.md` as rules. Reads the session files of this project and of its other git worktrees on this machine only, once per session start; no Jev request. |
| `/warden unmute <kind> [model]` | Resets the follow and dispute counts of one steer kind (for example `intent-mismatch` or `rules`) for the current model, or for the named model: its steers are sent again and counted from zero. See [adaptive steers](guards.md#adaptive-steers-per-model). |
| `/warden loops` | The open loops of this session that the agent added with `warden_loops`, and the closed ones with how each closed (done, or dropped with its reason). Read-only; loops of other sessions and projects are never shown. |
| `/warden prefs forget <n>` | Drops item `n` of `/warden prefs` for this project: it is not listed or injected again, and an agent lesson is deleted. Stored in pi-warden's data folder. |
| `/warden index` | Build the capability index with the session model: reads every installed skill file and tool description, writes sanitized entries to `~/.pi/agent/pi-warden/index/`. Re-running overwrites both files. |
| `/warden audit` | Agent-driven workspace audit. Sends a prompt to the session model which reads source code, finds concrete Jev (TypeSafe) opportunities with file:line citations, produces measurable evidence, and writes an HTML report to `.pi-warden/audit-report.html`. Uses the session model; may take several minutes and use real tokens. |

## Status line and trace

The line above the editor shows the latest verdict per guard, the verdict leading as a chip (`WARN action write · irreversible 0.09 · off-task 0.95 · unrelated · off task`). Verdicts the guard found nothing in fold into one line per verdict (`OK rules · prose · done`), so a quiet turn costs one line; a line that names a finding or a caveat keeps its own. `/warden trace`, `ctrl+shift+w`, or a click on the line opens a right-hand sidebar with the full trace, newest first, including the exact text sent to the agent. Clicks need Pi's fullscreen mode (`tuiMode: "fullscreen"` in `/settings`).

The status line is one template per guard (`widget.action`, `widget.security`, `widget.subagent`, and so on): segments separated by ` · `, each dropped when its token has no value. The template's trailing `{level}` or `{status}` becomes the chip; `/warden status` prints the raw line per guard under `Last:`, folded or not. Placement, width, the shortcut, and the available tokens per guard are in [configuration.md](configuration.md#status-line-and-trace-sidebar).

### Steers sent, per guard

`/warden status` counts every steer it sent in the session and names the guard that asked for it:

```text
Steers sent: 5 (security 3, action 2, rules 1; 1 of them carried more than one reason).
```

One message can carry notes from more than one guard (a slop note and a rule violation arrive together), so the per-guard numbers may add up to more than the message count, and the line says so. Sorted by count, so the noisiest guard is the first number.
