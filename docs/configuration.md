# Configuration reference

Every key, its default, what a project file may change, the status line templates, and the update note. The [README](../README.md) covers the common cases; [guards.md](guards.md) explains what each threshold does.

Contents: [User config](#user-config) · [Project config](#project-config) · [Recipe: security work](#recipe-security-work) · [Environment](#environment) · [Status line and trace sidebar](#status-line-and-trace-sidebar) · [After updating the package](#after-updating-the-package)

## User config

User file `~/.pi/agent/pi-warden/config.json` (owner-only). `/warden config` opens the panel that edits it (`s` saves, `/warden config` again or `q` closes); `/warden config get <key>` prints one value without the panel. Missing keys use these defaults:

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
    "intentTraceOnly": "invisible",
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
  "security": { "enabled": true, "threshold": 0.7, "maskOutput": true },
  "stuck": { "enabled": true, "window": 12, "minFailures": 3, "cooldown": 3, "sameStrategy": 0.7, "nudge": true },
  "done": {
    "enabled": true, "claimsDone": 0.7, "nudge": true, "uiProof": true,
    "uiFiles": ["**/*.{css,scss,sass,less,html,htm,vue,svelte,jsx,tsx,astro,dart}", "**/web/**/*.js", "**/public/**/*.js", "!**/*.{test,spec}.*", "!**/*_test.dart", "!**/{test,tests,__tests__}/**"],
    "visualTools": {
      "commands": ["agent-browser", "playwright", "npx playwright", "flutter test", "fvm flutter test", "idb", "xcrun simctl io", "chrome", "chromium", "google-chrome"],
      "commandWords": ["screenshot"],
      "tools": ["screenshot", "take_snapshot", "navigate"],
      "images": ["png", "jpg", "jpeg", "webp"]
    }
  },
  "context": { "enabled": true, "tailMinChars": 12000, "confidence": 0.8, "duplicateMinChars": 2000, "recallTool": "auto", "formatConfidence": 0.7, "dedupeRuns": true, "dedupeMessages": false, "largeOutput": { "enabled": true, "threshold": 0.85 } },
  "runaway": { "enabled": true, "repeats": 4, "thinkingRepeats": 10, "minChars": 400, "recover": true },
  "notify": { "enabled": false, "cooldownMs": 10000, "command": [] },
  "judge": { "cooldownMs": 60000, "failuresBeforeCooldown": 3 },
  "subagent": { "enabled": true, "wake": true, "threshold": 0.8, "cooldownMs": 120000 },
  "widget": { "enabled": true, "placement": "aboveEditor", "shortcut": "ctrl+shift+w", "panelWidth": "40%" },
  "steerVisible": false,
  "notices": false,
  "steerBudget": 3,
  "steers": { "adaptive": true, "minSteers": 30, "minFollowed": 0.2, "maxDisputed": 0.4, "recheckEvery": 30, "probeEvery": 5 },
  "typesafeBackend": "typesafe"
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | Master switch for the extension. |
| `typesafe` | Consent to send requests to TypeSafe. Set by `/warden enable`; only the user file or `PI_WARDEN_ENABLED=1` can grant it. |
| `typesafeBackend` | The judgment service: `"typesafe"` (default) or `"openrouter"`. User file only — a project must not redirect judgments. |
| `mode` | `steer` (hold goes back to the agent), `confirm` (dialog for you), `advise` (never holds). User file only; a project's `.pi/pi-warden.json` cannot change it, by design. |
| `timeoutMs` | Per-request timeout. On timeout the call is allowed with a warning when `action.failOpen` is true. |
| `maxRequests` | Per-session request budget. When spent, pi-warden says so once and continues with offline checks. |
| `action.tools` | Tools the action guard inspects. Add your own shell-like tools here. |
| `action.irreversible` | `warn` and `confirm` (hold) thresholds on P(irreversible). |
| `action.offTask` | `warn` and `steer` thresholds on P(off-task). Off-task never holds. |
| `action.intentMismatch` | P(call differs from the agent's stated plan) that warns and tells the agent, on calls that can change something. |
| `action.visibleMismatch` | Lower mismatch threshold for commands whose effect is visible outside the working tree (commit, push, publish, install, launch). |
| `action.intentTraceOnly` | Which intent mismatches stay in the trace without a steer to the agent. `"invisible"` (default): a call with no visible effect: not a commit, push, merge, tag, reset, pull request, release, or publish (decided in code), and not judged `visible` at 0.8 or more (an install, a launched program, a message sent from a script). `"all"`: every mismatch. `"none"`: none; every mismatch steers, as before. The steer arrives after the call ran. |
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
| `rules.enabled` | The rules guard, and whether the resolved rules file content rides action requests at all. `false` keeps that content on this machine. |
| `rules.*` | Rules source, threshold, path globs, sensitive-path notes. See [guards.md → Rules](guards.md#rules). |
| `slop.*` | Code slop threshold and reply (prose) checks. `prose.audience` is `technical`, `plain`, or free text. |
| `security.threshold` | Written-code risk and tool-output injection threshold. |
| `security.maskOutput` | Default `true`. Before the model sees a tool result, replace every credential value the offline check detects in its text blocks with `[redacted]`: private key blocks, `sk-` keys, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), `AKIA` keys, Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-`), `AIza` keys, JWTs, `KEY=value` assignments whose name is a credential key, `Authorization` and `Bearer` values, and URL passwords (`postgres://user:pass@host`), each only when the value looks like a secret. Test fixtures, documented examples (`AKIAIOSFODNN7EXAMPLE`), and the query signatures of signed URLs stay readable. The banner says how many values were masked. Images and other parts are not changed. `false` shows the value and keeps the generic credential banner, because the value is in the agent's context. With masking on, the credential banner is sent only when a value was masked; a detected value that was not masked is traced without a banner. User file only: a project file cannot turn masking off. Masking runs even with the security guard off (`security.enabled: false`); only the user's `security.maskOutput: false` stops it. |
| `stuck.*` | Window of tool results kept, failures before a check, cooldown between checks, same-strategy threshold. |
| `stuck.repeatSteer` | Default `true`. Steer on the 2nd identical call when only provably read-only calls ran between the two calls and the call failed with the same output, or re-read an output the agent already has. Code only, no request. Needs `stuck.nudge`. See [guards.md → Stuck](guards.md#stuck). |
| `done.*` | Completion-claim threshold and whether the agent gets a follow-up turn. |
| `done.uiProof` | Default `true`. After a change to a `done.uiFiles` path, only a `done.visualTools` call after that change counts as proof; passing tests and builds do not. `false` restores the test/build/lint-only rule. |
| `done.uiFiles` | Globs for files whose change shows on screen, matched against `write`/`edit` paths and files a `bash` command writes. `{a,b}` alternatives work; a glob that starts with `!` excludes. The defaults exclude test files. |
| `done.visualTools` | What counts as looking at the result, case-insensitive, successful calls only. `commands`: heads of a shell command segment; `flutter test` counts only for an `integration_test/` or golden path (or `--update-goldens`), `idb` only for its `screenshot` or `ui` subcommand, and `chrome`, `chromium`, or `google-chrome` only with a `commandWords` flag (`--headless --screenshot`). `commandWords`: a word that stands alone as an argument or flag after a `commands` head (`idb screenshot`, `flutter test --screenshot`); the same word after another command (`grep -rn screenshot src`), quoted messages, heredoc bodies, and paths such as `screenshots/` do not count. `tools`: text in a tool name, or in the `tool` an MCP proxy (`mcp`, `mcp__…`) calls. `images`: extensions whose `read` counts. |
| `context.*` | Compression thresholds, retention confidence, duplicate size, recall tool. |
| `context.dedupeRuns` | Default `true`. A run of at least 20 lines and 1500 characters in a new tool result that exactly repeats (trailing spaces ignored) text already in context on the current branch becomes one line: `[pi-warden: the next N lines repeat an earlier bash result — omitted; full text: <path>]`. The full original is stored in that file. The last 2000 characters and images are never changed. Code only; no request. `false` also turns off `context.dedupeMessages`. |
| `context.dedupeMessages` | Default `false`. With `context.dedupeRuns` also on, cut repeated runs in new user and custom messages the same way. Off by default because a repeat the user sends can itself carry meaning ("here it is again, still failing"), and on recent sessions messages gave about 0.8% of their bytes back. A custom message that Pi appends without an agent turn (`triggerTurn: false`, or unset while the agent is idle) does not pass Pi's `message_end` hook and stays whole. |
| `context.largeOutput.enabled` | Add one question to each judged `bash` request: will the command print far more than the agent needs? Off keeps the question out of the request. Read-only commands (`cat`, `find`, `git log`) skip the judge, so the question does not ride them. |
| `context.largeOutput.threshold` | P(large output) at or above which the agent is told, once per command family (`npm test`, `git log`, `find`) per session, to redirect or filter the command before it runs one like it again. The call is never held or warned. Default `0.85`. |
| `runaway.*` | Repeat counts that abort a reply, minimum size, whether the agent gets one recovery turn. |
| `notify.*` | Desktop notifications, cooldown, optional relay command (user file only). |
| `judge.failuresBeforeCooldown` | Consecutive timeout, network, or other judge failures before judgments pause for the session (3). One auth or configuration failure pauses at once. |
| `judge.cooldownMs` | How long a failing judge is left alone before the next action asks it again (60000), capped at 600000 (10 minutes). |
| `subagent.enabled` | Read async subagent reports at all. `false` ignores them, as before 0.14. |
| `subagent.wake` | Ask Jev whether a report that names trouble deserves a wake. `false` keeps the offline layer, which never wakes. |
| `subagent.threshold` | P(report needs the agent awake) that wakes it. Conservative on purpose. |
| `subagent.cooldownMs` | At most one batched wake per window, so several children finishing together cost one interruption. |
| `widget.*` | Status line placement, sidebar shortcut and width, per-guard text templates (below). |
| `learning.adaptiveThresholds` | Learn from hold outcomes and suggest threshold adjustments via `/warden recommend`. | 
| `learning.patternAnalysis` | Analyze hold patterns and generate recommendations. |
| `learning.retentionDays` | Days to keep hold records in SQLite before pruning. Records older than this are deleted on startup. `0` disables pruning. Default: `365`. |
| `conscience.enabled` | Master switch for the conscience coach. Default `false` — the coach ships as **beta**: off until you flip this one switch. |
| `conscience.skills.mode` | `"off"` (no skill selection), `"recommend"` (name a skill and ask the agent to load it), or `"load"` (supply instructions directly from disk). Default `"recommend"`. `load` requires global consent, a trusted project, and reads the skill file bounded by `maxSkillBytes` and `maxLoadedBytes`. A project cannot upgrade from `recommend` to `load` when the user permits only `recommend`. |
| `conscience.skills.exclude` | Case-sensitive skill names to exclude; `*` is the only wildcard. Default `[]`. |
| `conscience.tools.enabled` | Suggest tools including evidence/research tools; never execute or enable them directly. Default `true`. |
| `conscience.tools.exclude` | Case-sensitive tool names to exclude; `*` is the only wildcard. Default `[]`. |
| `conscience.skipTools` | Exact tool names the conscience never recommends: core tools the agent already uses on nearly every turn. Skills are never skipped by this list. `[]` makes every tool a candidate again. Default `["read", "bash", "edit", "write", "grep", "find", "ls"]`. Independent of this key, a tool whose name has a destructive part (`delete`, `drop`, `destroy`, `remove`, `purge`, `wipe`, `reset`, `truncate`, `kill`, `force`, `uninstall`, `revoke`, `erase`, `clear`; a camelCase name such as `deleteIssue` is split into words) or whose description starts with one is never a candidate. |
| `conscience.timeoutMs` | Total wall-clock deadline for one assessment (ms). Effective deadline is `min(conscience.timeoutMs, timeoutMs)`. Range 100–10000. Default `3000`. |
| `conscience.maxAssessments` | Max assessments per admitted operator prompt, including the initial. Range 1–10. Default `3`. |
| `conscience.maxNudges` | Max new guidance deliveries per admitted operator prompt. Range 1–5. Default `2`. |
| `conscience.maxSkillBytes` | Max UTF-8 bytes per skill file for automatic loading. Range 1024–131072. Default `32768`. |
| `conscience.maxLoadedBytes` | Max cumulative automatic loading bytes per admitted prompt. Range 1024–262144. Default `65536`. |
| `conscience.recommendThreshold` | `P(useful now)` must reach this to select a candidate for recommendation. Default `0.80` (beta policy, measured 2026-09-22). |
| `conscience.advanceThreshold` | `P(advance)` from the disposition question must reach this before a candidate is considered. Default `0.70` (beta policy). |
| `prefs.enabled` | Default `true`. `/warden prefs` reads the earlier session files of this project and its other git worktrees for preferences you repeated. `false` (or `enabled: false`) reads no session file. |
| `prefs.inject` | Default `true`. At session start, send the standing preferences that pass every injection rule to the agent as one context message: at most 5 items and 400 characters, each quoted as said with its session count, ending with "If the current request says otherwise, follow the current request." A preference is injected only when you typed it (not a relayed message), in a standing form (`don't`, `never`, `always`, `stop`, `from now on`, `next time`, `I told you`; no question and no temporary word such as `yet`, `now`, `until`, `this PR`, `this branch`), not bound to one task (no pronoun-only object, ticket, branch, PR number, or hash), in 3 or more sessions on 2 or more days, last within 30 days, not lifted by a later message, and not weakening a check (skipping tests, checks, reviews, or confirmations, turning warden off, or pushing, deploying, or deleting without asking). A prohibition of a harmful action ("never check in secrets", "don't commit to main") is a safety preference and is injected. Agent lessons from `warden_remember` share the budget after your preferences, and only once confirmed. `/warden prefs` shows each item as injected or the rule that kept it out; `/warden prefs forget <n>` drops one for the project. Preference text goes to the session model only, never to TypeSafe. Not a steer; it does not use the steer budget. Sent once per session; a resumed session is not sent it again. `false` sends nothing and keeps `/warden prefs`. |
| `conscience.loadThreshold` | `P(useful now)` must reach this to auto-load. Must be ≥ `recommendThreshold`. Default `1.0` (recommend only in the beta policy; loading stays off). |
| **Activation gate** | When a measured policy exists (`{ questionHash, model, recommendThreshold, advanceThreshold, loadThreshold }`), the module delivers only when the current hash and model match the policy. Without a matching policy, no recommendation message is sent regardless of the configured thresholds; the assessment is traced with `no_policy`. No production config switch bypasses measurement. |
| **Capability index** | `/warden index` builds a local index at `~/.pi/agent/pi-warden/index/global.json` (global skills and all tools) and `~/.pi/agent/pi-warden/index/projects/<sha256(projectRoot).slice(0,12)>json` (project skills). Entries carry `lead`, `useWhen`, `examples`, and `role` instead of bare descriptions. The conscience uses index entries when the source hash matches; bare descriptions are the fallback. Index files are owner-only and built locally by the session model; only sanitized entries reach Jev; advertised locations never do. |

After building, `/warden index` reports which skill and tool descriptions would recommend better with a rewrite. This is advice for the author's own skill files — nothing is changed automatically. The index prompt expects the description shape: trigger word first in `lead`, situations in `useWhen`, example user phrasings in `examples`.

| `steerVisible` | Show steer messages in the transcript instead of only in the trace panel. |
| `notices` | Print the per-call warning notices (`warden · …`) in the transcript. Off by default; the widget, the trace panel, and `/warden trace` always show every event. |
| `steerBudget` | Steers delivered to the agent per run before further non-critical ones are recorded in the trace only. Every delivered steer costs at least one LLM turn, and a closing run that collects six notices collects six restatements of the final status. `0` disables the budget. Critical guards (stuck, done, runaway recovery, subagent wake) always deliver. |
| `steers.adaptive` | Default `true`. A steer kind that a model rarely follows or often disputes becomes trace-only for that model; see [adaptive steers](guards.md#adaptive-steers-per-model). User file only. |
| `steers.minSteers` | Observed steers of one kind for one model before that pair can become trace-only. Default `30`. |
| `steers.minFollowed` | Trace-only when the share followed is under this. Default `0.2`. Kinds with no follow measure (`prose`, `sensitive-path`) are judged by disputes alone. |
| `steers.maxDisputed` | Trace-only when the share disputed is over this. Default `0.4`. |
| `steers.recheckEvery` | A trace-only pair is re-checked after this many further steers. Default `30`. |
| `steers.probeEvery` | While trace-only, 1 in this many steers is still sent, so the re-check has fresh data. Default `5`. |
| `waste.enabled` | Default `true`. Master switch for the call-waste notes and the session tip. A note is text added to the tool result that triggers it, so it costs no request and never holds or blocks a call, spends the steer budget, or makes a model or TypeSafe call. See [guards.md → Call waste](guards.md#call-waste). |
| `waste.tip` | Default `true`. On the first run of a session the tip below is appended to the system prompt; later runs re-append the same text, so it stays in the prompt and the host records one change. `false` adds nothing to the prompt. |
| `waste.every` | Tool calls between two notes from the same detector in one session. Default `20`. |
| `waste.sleep` | Default `true`. A `sleep` poll is `sleep N`, optionally after `cd DIR &&`, optionally followed by one short status command (`sleep 30 && gh pr checks 12`, `sleep 5; curl -s URL \| jq .x`). The note fires on the 2nd poll in the last 10 calls. A loop that sleeps is not a poll. |
| `waste.paging` | Default `true`. A ranged read is `read` with `offset` or `limit` and at most 100 lines, `sed -n 'a,bp' F`, `head`/`tail -n N` with N at most 100, or `awk 'NR>=a && NR<=b'`. The note fires on the 3rd ranged read of one file in the last 10 calls when the reads are adjacent or overlapping and nothing wrote that file between them, and it names the one read that covers the same lines. |
| `waste.search` | Default `true`. A search is `grep` or `rg` on one named file, not a glob and not `-r`. The note fires on the 3rd search of one file in the last 10 calls when two of them use the same or an overlapping pattern and nothing wrote that file between them. |
| `waste.recheck` | Default `true`. A check is a test, lint, typecheck, or build command (`npm test`, `npm run check`, `npx tsc`, `eslint`, `vitest`, `jest`, `pytest`, `ruff`, `mypy`, `cargo test`, `go test`, `make test`, `flutter test`, `dart analyze`, and their `bun`/`pnpm`/`uv` forms). The note fires when the same runner and target runs again in the last 10 calls with a different output filter, the earlier output was cut by a pipe, the earlier result showed no failure, and nothing wrote a file in between. |

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

For penetration testing, incident response, vulnerability research, CTF, and hardening work, where the day touches credentials, scanners, and hostile samples. Nothing leaves until `/warden enable`. After that, each guarded call sends a redacted, truncated summary of the call (tool, command or path, the agent's stated plan), your latest request with up to eight earlier messages as task context, and the resolved rules content — `pi-warden.md`, or the files in `rules.files`, or the `AGENTS.md` / `CLAUDE.md` / `README.md` fallback — which rides every action request while the rules guard is on. A `write` or `edit` adds a sample of the written code; the security and context guards add redacted tool-output samples; stuck sends recent commands and output tails; the done-check sends the final message. Redaction (`src/redact.ts`) replaces credential shapes — `Authorization`, `TOKEN=`, `sk-`, `ghp_`, `AKIA`, JWTs, PEM blocks, URL passwords — and nothing else: it is not a path scrubber, so hostnames, IP addresses, and file paths travel as written. [data-handling.md](data-handling.md) lists every field per guard.

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
- `rules.enabled` — no rules-guard request, so no exploit or tooling source is judged against a README, and no rules file content rides the action requests either.
- `slop.enabled` — drops the slop questions, which carry written code.
- `security.enabled` — no tool-output or written-code sample for the weakness check.
- `context.enabled` — large tool output is never sampled for compression; long scanner output stays in the transcript whole.
- `subagent.enabled` — child reports are never sampled, and never wake the agent.

One residue: a judged bash call still sends its redacted summary and the task context. Only `action.enabled: false` (which also removes the pattern checks) or `/warden disable` stops that.

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
| `PI_WARDEN_TRACE_DIR=<absolute path>` | Appends the trace to `<path>/<session id>.jsonl`, one file per Pi session. For a host that runs Pi in RPC mode, where the status line and the sidebar never show. An empty or relative path turns it off. See [Trace file](#trace-file). |
| `PI_WARDEN_HOST_PATHS=<dir>:<dir>` | Directories outside the project where the host lets its agent write, `:`-separated. A `write` or `edit` in one of them, after `..` and symlinks are resolved, is not held or warned by the outside-project rule. Every other check still applies: command rules, path rules, deny rules, sensitive paths, secrets, and Jev; the action summary still shows the path as outside the project, and the rules guard still does not judge these files against the project rules. Relative entries, empty entries, and `/` are ignored. Read once per session. Environment only: no config file can set or extend it. pi-warden's index directory (`pi-warden/index/` under Pi's agent directory), where `/warden index` asks the agent to write, is always treated as a host path; the rest of the agent directory is not. |

When a guard would ask Jev but cannot, Warden tells you once per session and reason why, and what to do: no consent (`/warden enable`, or `PI_WARDEN_ENABLED=1` headless), no key for the backend (set its key variable, or run `/typesafe login` for the TypeSafe backend), or a rejected key (named by where it comes from: run `/typesafe login` again for the key it saved, or check the key in the environment variable and run `/warden status`); a headless session gets a status message instead of a notice, and a spent request budget keeps its own warning.

### Trace file

With `PI_WARDEN_TRACE_DIR` set to an absolute path, Warden appends every trace event to `<path>/<session id>.jsonl`. The directory is created owner-only (`0700`) when it is missing; the file is owner-only (`0600`). A new or resumed session writes to its own file. The file keeps every event: the 100-entry limit of the sidebar does not apply. Each line is one JSON object with `"v": 1` and a `kind`:

| `kind` | Written | Fields |
| --- | --- | --- |
| `session` | Once when the session opens the file | `sessionId`; `cwd` (the home directory shown as `~`, redacted); `wardenVersion`; `mode` (`steer`, `confirm`, or `advise`); `judgments` (`on`, or `off:<reason>` with reason `no_consent`, `no_key`, `key_rejected`, or `budget`); `at` |
| `judgments` | When a guard finds the judgment state changed from the last `session` or `judgments` line | `judgments` (same values as on `session`); `at` |
| `entry` | For every trace event | `id` (a number, unique in the file; a reload continues the count); `at`; `guard`; `line` (the status-line text); `details` (the redacted detail lines the sidebar shows); `tokens` (the widget tokens, when the event has them) |
| `amend` | When an outcome lands on an event that is still in the sidebar's 100 entries | `id` of the entry; `line` (the added detail line); `at` |

`at` is an ISO 8601 timestamp. Lines are in trace order. A write error is reported once as a warning and stops the file for the rest of the session; guards and tool calls do not change. In RPC mode `/warden trace` sends the last 20 events as one text notification, newest last, with the path of this file when it is on.


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
| action | `tool level source irreversible offTask scope approved intent visible largeOutput plan slop slopStub slopComments slopDead slopHedging patterns reasons path model ms flags time` |
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
