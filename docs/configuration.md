# Configuration reference

Every key, its default, what a project file may change, the status line templates, and the update note. The [README](../README.md) covers the common cases; [guards.md](guards.md) explains what each threshold does.

Contents: [User config](#user-config) · [Project config](#project-config) · [Environment](#environment) · [Status line and trace sidebar](#status-line-and-trace-sidebar) · [After updating the package](#after-updating-the-package)

## User config

User file `~/.pi/agent/pi-warden/config.json` (owner-only). `/warden config` opens it in Pi's editor. Missing keys use these defaults:

```json
{
  "enabled": true,
  "typesafe": false,
  "mode": "steer",
  "timeoutMs": 5000,
  "maxRequests": 500,
  "action": {
    "enabled": true,
    "tools": ["bash", "powershell", "ctx_execute", "ctx_batch_execute", "ctx_execute_file", "write", "edit"],
    "failOpen": true,
    "irreversible": { "warn": 0.5, "confirm": 0.7 },
    "offTask": { "warn": 0.6, "steer": 0.85 },
    "intentMismatch": 0.9,
    "visibleMismatch": 0.8,
    "feedbackLog": true,
    "commandRules": [],
    "commandDenyRules": [],
    "exemptRules": []
  },
  "rules": {
    "enabled": true,
    "threshold": 0.7,
    "files": [],
    "fallback": true,
    "maxChars": 8000,
    "exclude": [],
    "skip": [],
    "sensitivePaths": {}
  },
  "slop": {
    "enabled": true,
    "threshold": 0.7,
    "prose": { "enabled": true, "audience": "technical", "threshold": 0.7, "trend": 2, "minChars": 200 }
  },
  "security": { "enabled": true, "threshold": 0.7 },
  "stuck": { "enabled": true, "window": 12, "minFailures": 3, "cooldown": 3, "sameStrategy": 0.7, "nudge": true },
  "done": { "enabled": true, "claimsDone": 0.7, "nudge": true },
  "context": { "enabled": true, "tailMinChars": 12000, "confidence": 0.8, "duplicateMinChars": 2000, "recallTool": "auto", "formatConfidence": 0.7 },
  "runaway": { "enabled": true, "repeats": 4, "thinkingRepeats": 10, "minChars": 400, "recover": true },
  "notify": { "enabled": false, "cooldownMs": 10000, "command": [] },
  "subagent": { "enabled": true, "wake": true, "threshold": 0.8, "cooldownMs": 120000 },
  "widget": { "enabled": true, "placement": "aboveEditor", "shortcut": "ctrl+shift+w", "panelWidth": "40%" },
  "steerVisible": false,
  "notices": false,
  "steerBudget": 3
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | Master switch for the extension. |
| `typesafe` | Consent to send requests to TypeSafe. Set by `/warden enable`; only the user file or `PI_WARDEN_ENABLED=1` can grant it. |
| `mode` | `steer` (hold goes back to the agent), `confirm` (dialog for you), `advise` (never holds). |
| `timeoutMs` | Per-request timeout. On timeout the call is allowed with a warning when `action.failOpen` is true. |
| `maxRequests` | Per-session request budget. When spent, pi-warden says so once and continues with offline checks. |
| `action.tools` | Tools the action guard inspects. Add your own shell-like tools here. |
| `action.irreversible` | `warn` and `confirm` (hold) thresholds on P(irreversible). |
| `action.offTask` | `warn` and `steer` thresholds on P(off-task). Off-task never holds. |
| `action.intentMismatch` | P(call differs from the agent's stated plan) that warns and tells the agent, on calls that can change something. |
| `action.visibleMismatch` | Lower mismatch threshold for commands whose effect is visible outside the working tree (commit, push, publish, install, launch). |
| `action.feedbackLog` | Write each judged call and its outcome to `~/.pi/agent/pi-warden/holds/`; never the command. |
| `action.commandRules` | User-defined command rules: `{ id, pattern, severity: "warn" \| "confirm" \| "deny", action?, message?, caseSensitive? }`. Patterns match the data-text-stripped command, so heredoc bodies and commit messages do not fire them. `confirm` defaults to `action: "dialog"` (a prompt for you, regardless of mode); `action: "hold"` restores steer semantics. User file only. |
| `action.commandDenyRules` | The same shape, shorthand for `severity: "deny"`: the call is blocked with no dialog and no TypeSafe request. User file only. |
| `action.exemptRules` | Built-in or user rule ids to exempt, e.g. `["infra-destroy"]` for a workflow whose `kubectl delete` is routine. User file only. |
| `rules.*` | Rules source, threshold, path globs, sensitive-path notes. See [guards.md → Rules](guards.md#rules). |
| `slop.*` | Code slop threshold and reply (prose) checks. `prose.audience` is `technical`, `plain`, or free text. |
| `security.threshold` | Written-code risk and tool-output injection threshold. |
| `stuck.*` | Window of tool results kept, failures before a check, cooldown between checks, same-strategy threshold. |
| `done.*` | Completion-claim threshold and whether the agent gets a follow-up turn. |
| `context.*` | Compression thresholds, retention confidence, duplicate size, recall tool. |
| `runaway.*` | Repeat counts that abort a reply, minimum size, whether the agent gets one recovery turn. |
| `notify.*` | Desktop notifications, cooldown, optional relay command (user file only). |
| `subagent.enabled` | Read async subagent reports at all. `false` ignores them, as before 0.14. |
| `subagent.wake` | Ask Jev whether a report that names trouble deserves a wake. `false` keeps the offline layer, which never wakes. |
| `subagent.threshold` | P(report needs the agent awake) that wakes it. Conservative on purpose. |
| `subagent.cooldownMs` | At most one batched wake per window, so several children finishing together cost one interruption. |
| `widget.*` | Status line placement, sidebar shortcut and width, per-guard text templates (below). |
| `steerVisible` | Show steer messages in the transcript instead of only in the trace panel. |
| `notices` | Print the per-call warning notices (`warden · …`) in the transcript. Off by default; the widget, the trace panel, and `/warden trace` always show every event. |
| `steerBudget` | Steers delivered to the agent per run before further non-critical ones are recorded in the trace only. Every delivered steer costs at least one LLM turn, and a closing run that collects six notices collects six restatements of the final status. `0` disables the budget. Critical guards (stuck, done, runaway recovery, subagent wake) always deliver. |

## Project config

A project may add `.pi/pi-warden.json` with `enabled` and per-guard overrides: stricter thresholds, extra guarded tools, `rules.files`, `rules.skip`, `rules.sensitivePaths`, or `"done": { "enabled": false }`. Project files are read only when Pi trusts the project. They can never grant `typesafe` consent, change `mode`, raise `timeoutMs` or `maxRequests`, or set `notify.command`.

A wince-style setup for a backend repo (the full version is [`examples/pi-warden.json`](../examples/pi-warden.json)):

```json
{
  "rules": {
    "skip": ["tests/**", "**/*.test.*", "docs/**", "**/*.md"],
    "exclude": ["secrets/**", "**/*.pem"],
    "sensitivePaths": {
      "migrations/**": "This touches a migration: tell the user and add a rollback path",
      "**/permissions*": "Access control changed: ask the user for a security review before merging"
    }
  }
}
```

## Environment

| Variable | Effect |
| --- | --- |
| `TYPESAFE_API_KEY` | Takes precedence over the key stored by `/warden enable` or `/typesafe login`. |
| `PI_WARDEN_ENABLED=1` | Grants consent for headless runs (same as `"typesafe": true`). |
| `PI_WARDEN_MODE=steer\|confirm\|advise` | Overrides `mode`. |

## Status line and trace sidebar

The line above the editor shows the latest verdict per guard. The verdict leads as a chip, the guard follows, and the body reads as data:

```text
OK     rules · prose · done
WARN   action  write · irreversible 0.09 · off-task 0.95 · unrelated · slop: none · off task
       context bash · duplicate · saved 1024 bytes
```

A verdict the guard found nothing in (`ok`, `allow`, `skipped`) folds into one line per verdict naming the guards that spoke, so a quiet turn costs one line instead of one per guard. A quiet verdict keeps its own line when the line names a finding or a caveat (`typesafe error`, `user approved`, `slop: <symptom>`, `patterns: <id>`), because folding it would report a verdict the guard did not give. The worst verdict sits last, nearest the editor. Folded detail is not lost: `/warden status` prints the raw line per guard under `Last:`, and the sidebar keeps every event with its scores.

`/warden trace`, `ctrl+shift+w`, and a click on the line each toggle a right-hand sidebar with the full trace, newest first, live. The sidebar does not take the keyboard; click inside it for arrow keys and PgUp/PgDn, `c` clears, Esc hands input back, `q` closes. `widget.panelWidth` sets its width.

Clicks and the wheel need Pi's fullscreen mode (`tuiMode: "fullscreen"` in `/settings`). In macOS Terminal.app enable View → Allow Mouse Reporting.

Templates in `config.widget` control the text. Segments are separated by ` · `; a segment whose token has no value is dropped. A template should end on `{level}` or `{status}`: that trailing word becomes the chip. A template that keeps the level mid-line gives the line no chip, and the guard name leads it instead:

```json
"widget": {
  "action": "warden · {tool} · irreversible {irreversible} · off-task {offTask} · {scope} · slop: {slop} · patterns: {patterns} · {flags} · {level}",
  "rules": "warden · rules · {tool} {path} · {asked} rules · {violations} · {status}",
  "stuck": "warden · stuck · {failures} failures · same strategy {sameStrategy} · change {approachChange} · progress {progress} · {flags} · {status}",
  "done": "warden · done-check · {changes} changes · {checksPassed}/{checks} checks passed · claims done {claimsDone} · claims verified {claimsVerified} · checks apply {checksApply} · {outcome} · {status}",
  "prose": "warden · prose · wordy {wordy} · clichés {cliches} · jargon {jargon} · {flags} · {status}",
  "security": "warden · security · {tool} · injection {injection} · exfiltration {exfiltration} · {status}",
  "context": "warden · context · {tool} · {retention} · saved {bytesSaved} bytes",
  "runaway": "warden · runaway · {kind} · {count}× repeated · {chars} chars · {signal} · {status}",
  "subagent": "warden · subagent · {agent} · {kind} · {wake} · {status}"
}
```

Tokens per guard:

| Guard | Tokens |
| --- | --- |
| action | `tool level source irreversible offTask scope approved intent visible plan slop slopStub slopComments slopDead slopHedging patterns reasons path model ms flags time` |
| rules | `tool path asked violations status source reasons model ms flags time` |
| prose | `wordy cliches jargon status reasons model ms flags time` |
| stuck | `failures sameStrategy approachChange progress status source reasons model ms flags time` |
| done | `changes checks checksPassed claimsDone claimsVerified checksApply outcome status reasons model ms flags time` |
| security | `tool injection exfiltration status` |
| context | `tool retention bytesSaved` |
| runaway | `kind count chars signal block status time` |
| subagent | `agent kind wake status time` |

`"enabled": false` hides the line; `"shortcut": ""` disables the keybinding.

## After updating the package

Restart Pi after an update; `/reload` re-imports the entry module but can leave older modules of the same package in memory. Since 0.5.2 the extension checks the shape of the config it receives; a section that an older module does not know (the symptom of two package versions in one process) switches that guard off and prints one warning naming the sections and the schema numbers. 0.9.0 crashed instead when the shape-check module itself was the stale one; since 0.9.1 the extension guards the sections it reads in its own module, so the warning appears and everything else keeps working. If you see the warning, restart Pi.
