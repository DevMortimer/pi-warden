# Configuration reference

Every key, its default, what a project file may change, the status line templates, and the update note. The [README](../README.md) covers the common cases; [guards.md](guards.md) explains what each threshold does.

Contents: [User config](#user-config) · [Project config](#project-config) · [Recipe: security work](#recipe-security-work) · [Environment](#environment) · [Status line and trace sidebar](#status-line-and-trace-sidebar) · [After updating the package](#after-updating-the-package)

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
    "shouldProceed": { "hold": 0.6, "steer": false },
    "feedbackLog": true,
    "floor": "evidence",
    "commandRules": [],
    "commandDenyRules": [],
    "exemptRules": [],
    "pathRules": [],
    "armingRules": []
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
  "steerBudget": 3,
  "typesafeBackend": "typesafe"
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | Master switch for the extension. |
| `typesafe` | Consent to send requests to TypeSafe. Set by `/warden enable`; only the user file or `PI_WARDEN_ENABLED=1` can grant it. |
| `typesafeBackend` | The judgment service: `"typesafe"` (default) or `"openrouter"`. User file only — a project must not redirect judgments. |
| `mode` | `steer` (hold goes back to the agent), `confirm` (dialog for you), `advise` (never holds). |
| `timeoutMs` | Per-request timeout. On timeout the call is allowed with a warning when `action.failOpen` is true. |
| `maxRequests` | Per-session request budget. When spent, pi-warden says so once and continues with offline checks. |
| `action.tools` | Tools the action guard inspects. Add your own shell-like tools here. |
| `action.irreversible` | `warn` and `confirm` (hold) thresholds on P(irreversible). |
| `action.offTask` | `warn` and `steer` thresholds on P(off-task). Off-task never holds. |
| `action.intentMismatch` | P(call differs from the agent's stated plan) that warns and tells the agent, on calls that can change something. |
| `action.visibleMismatch` | Lower mismatch threshold for commands whose effect is visible outside the working tree (commit, push, publish, install, launch). |
| `action.shouldProceed` | `{ hold, steer }`. Scores at or below `hold` (default 0.6) are trace-only by default until calibrated; they never hold a call. |
| `action.shouldProceed.steer` | Default `false`. Set `true` to restore the steer that asks the agent to pause and seek user approval. |
| `action.feedbackLog` | Write each judged call and its outcome to `~/.pi/agent/pi-warden/holds/`; never the command. |
| `action.floor` | `"evidence"` (default): when a judge answers, built-in pattern hits are evidence in the request, not level-setters. `"level"`: the floor sets the level before the judge, as it did pre-0.31. User-declared rules keep their declared action in both modes. User file only; project files cannot change it. |
| `action.commandRules` | User-defined command rules: `{ id, pattern, severity: "warn" \| "confirm" \| "deny", action?, message?, caseSensitive? }`. Patterns match the data-text-stripped command, so heredoc bodies and commit messages do not fire them. `confirm` defaults to `action: "dialog"` (a prompt for you, in every mode); `action: "hold"` restores steer semantics. Patterns are JavaScript regexes matched against full commands, so a pattern with nested quantifiers can be slow on long commands — a pathological one is self-inflicted. User rule ids must not reuse a built-in id (see `EXEMPTABLE_IDS` in `src/guard.ts`); a collision silently drops the user rule. User file only. |
| `action.commandDenyRules` | The same shape, shorthand for `severity: "deny"`: the call is blocked with no dialog and no TypeSafe request. User file only. |
| `action.pathRules` | User-defined path rules: `{ id, paths, access, tools, action, message?, onlyIfExists?, regex? }`. `paths` are globs (`**` any depth, `*` one segment, `?` one character, `~` expands; `regex: true` reads them as regexes). `access` is the dimension: `"none"` any touch matches, `"read"` writes are held and reads flow, `"write"` reads are held and writes flow (an append-only log). `tools` picks the surface: file tools by name check the structured `path` field; `"*"` also matches bash commands — a `none` rule fires on a mention anywhere in the data-text-stripped command, and the write side is matched only at redirect (`>`, `>>`) and `tee` targets, never in arbitrary argv. `action`: `note` (the default; the agent is told after the fact), `warn`, `confirm` (a dialog, in every mode), `block` (deny, no dialog). `onlyIfExists` defaults `true`, so phantom paths do not fire. A `read`-scoped rule needs `read` in `action.tools`, which does not inspect the read tools by default. User file only. |
| `action.armingRules` | User-defined arming rules: `{ id, when: { edited, regex?, tools? }, arms: { command, for?, caseSensitive? }, action, message? }`. Editing a file matching a `when.edited` glob arms the rule's `arms.command` regex for `arms.for` (default `"10m"`; accepts `"30s"`, `"2h"`, or ms). While armed, commands matching the regex fire the rule's `action`: `confirm` (dialog), `hold` (steer), `block` (deny). State lives for the rule's window within a session, refreshed on each matching edit, cleared on `session_start`, and shown in `/warden status`. Approving the dialog approves that call, not the window; the dialog re-fires for each matching command while the rule is armed. User file only. |
| `action.exemptRules` | Built-in or user rule ids to exempt, e.g. `["infra-destroy"]` for a workflow whose `kubectl delete` is routine; also `rm-recursive` / `rm-rf` / `rm-recursive-dangerous-target` (the `rm` classifier) and `sensitive-path`. An id naming nothing is inert and reported once at startup. Exempting `sensitive-path` removes the only deterministic credential-touch signal, Jev questions aside. User file only. |
| `action.escalationThreshold` | Jev confidence above which a violation's severity is escalated in the blast-radius and rules-guard escalation paths. Default `0.85`. Escalation fires when confidence strictly exceeds this threshold; setting it to `1` effectively disables escalation since noul confidence cannot exceed 1. |
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
| `learning.adaptiveThresholds` | Learn from hold outcomes and suggest threshold adjustments via `/warden recommend`. | 
| `learning.patternAnalysis` | Analyze hold patterns and generate recommendations. |
| `learning.retentionDays` | Days to keep hold records in SQLite before pruning. Records older than this are deleted on startup. `0` disables pruning. Default: `365`. |
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

## Recipe: security work

### What leaves the machine

For penetration testing, incident response, vulnerability research, CTF, and hardening work, where the day touches credentials, scanners, and hostile samples. Nothing leaves until `/warden enable`. After that, each guarded call sends a redacted, truncated summary of the call (tool, command or path, the agent's stated plan), your latest request with up to eight earlier messages as task context, and the resolved rules file content — `pi-warden.md`, or the `AGENTS.md` / `CLAUDE.md` / `README.md` fallback — which rides every action request even when the rules guard is off. A `write` or `edit` adds a sample of the written code; the security and context guards add redacted tool-output samples; stuck sends recent commands and output tails; the done-check sends the final message. Redaction (`src/redact.ts`) replaces credential shapes — `Authorization`, `TOKEN=`, `sk-`, `ghp_`, `AKIA`, JWTs, PEM blocks, URL passwords — and nothing else: it is not a path scrubber, so hostnames, IP addresses, and file paths travel as written. [data-handling.md](data-handling.md) lists every field per guard.

For nothing at all, `/warden disable`: the offline layer keeps working: built-in patterns, your own `commandRules` and `pathRules`, `rules.sensitivePaths` notes, duplicate detection, and the runaway guard. Everything that needs a judgment stops with it, including the done-check.

### Local-only profile

Keeps the pattern floor and the done-check; sends no written code, no tool-output samples, and no subagent reports. User file `~/.pi/agent/pi-warden/config.json`:

```json
{
  "action": { "tools": ["bash"] },
  "rules": { "enabled": false },
  "slop": { "enabled": false },
  "security": { "enabled": false },
  "context": { "enabled": false },
  "subagent": { "enabled": false }
}
```

- `action.tools` — only bash is inspected, so no `write` or `edit` content sample is ever built; file writes lose the action guard too.
- `rules.enabled` — no rules-guard request, so no exploit or tooling source is judged against a README.
- `slop.enabled` — drops the slop questions, which carry written code.
- `security.enabled` — no tool-output or written-code sample for the weakness check.
- `context.enabled` — large tool output is never sampled for compression; long scanner output stays in the transcript whole.
- `subagent.enabled` — child reports are never sampled, and never wake the agent.

One residue: a judged bash call still sends its redacted summary, the task context, and the rules file content. Only `action.enabled: false` (which also removes the pattern checks) or `/warden disable` stops that.

### Lab profile

Project file `.pi/pi-warden.json` in the lab or CTF repo (a project file is read only when Pi trusts the project):

```json
{
  "security": { "enabled": false },
  "rules": { "exclude": ["exploits/**", "samples/**", "**/*.pcap"] }
}
```

- `security.enabled` — fixtures that are supposed to hold a hardcoded secret or a disabled TLS check stop firing. The switch is per project, not per directory, so the rest of the repo loses the check as well.
- `rules.exclude` — those paths are never sent to Jev at all; `rules.skip` is the weaker form (still local, rules just do not apply).

The exemptions belong in the user file — `action.exemptRules`, `commandRules`, `commandDenyRules`, `pathRules`, `armingRules`, and `action.floor` are user-only keys, silently ignored in a project file, so a checked-out repo cannot ship itself a hold-free floor:

```json
{ "action": { "exemptRules": ["sensitive-path", "remote-script-exec", "chmod-777"] } }
```

- `sensitive-path` — stops the hold on every `cat .env`, ssh config, `auth.json`, keystore, and fake-secret fixture. It is the only deterministic credential-touch signal, so real credential reads go unflagged too, Jev's questions aside.
- `remote-script-exec` — lets a lab setup pipe a remote script into a shell without a hold; a hostile URL in that shape is no longer caught offline.
- `chmod-777` — lets the lab's broad permissions pass; the same command on a production path passes too.

### Engagement hard stop and measuring your own rate

A deny rule blocks a call outright: no dialog, no TypeSafe request. Command rules are matched in code and never sent, and a match travels only as its id, so the hosts you name stay on this machine. Replace the placeholders below with the out-of-scope hosts from your own scope document (user file):

```json
{
  "action": { "commandRules": [
    { "id": "out-of-scope-target", "pattern": "\\b(?:out-of-scope\\.example|other-tenant\\.example)\\b", "severity": "deny", "message": "Not in the signed engagement scope — check the scope document first." }
  ] }
}
```

It is a backstop for sanctioned work, not a boundary anyone hostile respects: keep the pattern short and update it when the scope changes. After a week on these settings, run `node scripts/hold-stats.mjs` for your own hold rate and the ids behind it, then exempt or re-enable from your own numbers — the rates in the README come from the maintainer's corpus, and security work fires a different mix of patterns.

## Environment

| Variable | Effect |
| --- | --- |
| `TYPESAFE_API_KEY` | Takes precedence over the key stored by `/warden enable` or `/typesafe login`. |
| `OPENROUTER_API_KEY` | API key for the OpenRouter backend. Required when `typesafeBackend` is `"openrouter"`. |
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
