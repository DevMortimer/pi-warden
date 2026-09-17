# Commands, status line, and trace

## Commands

| Command | Effect |
| --- | --- |
| `/warden status` | Guard state, consent and key source, session counts, steers sent per guard, thresholds, context saver totals, hold precision, rules source, config paths, last verdicts |
| `/warden enable` | Data notice, key prompt if none is stored, consent saved |
| `/warden disable` | Stop Jev judgments; pattern checks continue |
| `/warden mode steer\|confirm\|advise` | How holds are handled; without an argument, show the current mode |
| `/warden config` | Edit the user config JSON in Pi's editor |
| `/warden test` | One synthetic destructive action, its verdict, and what the agent would be told |
| `/warden trace` | Toggle the trace sidebar (or print the last 20 events without a UI) |

## Status line and trace

The line above the editor shows the latest verdict per guard, for example `warden · bash · irreversible 0.84 · off-task 0.86 · unrelated · confirm`. `/warden trace`, `ctrl+shift+w`, or a click on the line opens a right-hand sidebar with the full trace, newest first, including the exact text sent to the agent. Clicks need Pi's fullscreen mode (`tuiMode: "fullscreen"` in `/settings`).

The status line is one template per guard (`widget.action`, `widget.security`, `widget.subagent`, and so on): segments separated by ` · `, each dropped when its token has no value. Placement, width, the shortcut, and the available tokens per guard are in [configuration.md](configuration.md#status-line-and-trace-sidebar).

### Steers sent, per guard

`/warden status` counts every steer it sent in the session and names the guard that asked for it:

```text
Steers sent: 5 (security 3, action 2, rules 1; 1 of them carried more than one reason).
```

One message can carry notes from more than one guard (a slop note and a rule violation arrive together), so the per-guard numbers may add up to more than the message count, and the line says so. Sorted by count, so the noisiest guard is the first number.
