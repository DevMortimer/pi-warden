# pi-warden

A second pair of eyes for [Pi](https://pi.dev). It watches what the agent does, asks [Jev](https://typesafe.ai) small typed questions about it (about 250 ms each), and acts through the agent's own context: a held call, a short steer message, a compressed output. You keep working; the agent gets smarter.

![Real verdicts from pi-warden: the same command gets a different verdict depending on what the user asked for](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/preview.png)

The verdicts above are real output from `npm run test:live`. Independent project; not affiliated with TypeSafe AI or the Pi authors. Built on [pi-typesafe](https://github.com/DevMortimer/pi-typesafe).

Default configs and a starter rules file are in [`examples/`](examples/).

## What it does

| Guard | Watches | Does |
| --- | --- | --- |
| **Action** | every `bash`, `write`, `edit` (and context-mode's `ctx_execute*`) before it runs | holds irreversible or off-task calls and tells the agent why, so it re-plans or asks you |
| **Rules** | every `write` and `edit` | judges the written code against your project's Markdown rules (`pi-warden.md`) and names the violated rule to the agent |
| **Slop** | written code and final replies | names stubs, restating comments, dead code, hedging, padded replies; the agent fixes them in the next edit |
| **Security** | written code and tool output | flags hardcoded secrets, disabled TLS, unsafe interpolation; marks injected instructions in tool output |
| **Stuck** | tool results | notices three failures with the same strategy and asks for a new hypothesis |
| **Runaway** | the reply stream | stops a reply that repeats the same block over and over (code only, no request) |
| **Done-check** | the final message | catches "done" claims after code changes when no test, build, or lint passed |
| **Context saver** | large or repeated tool output | keeps the exact lines that matter, stores the rest in a file, points recalls at a search |
| **Notifications** | moments that need you | desktop notification for a held call, a confirm dialog, a runaway stop |

Every verdict lands on a status line above the editor. Click it (fullscreen mode), press `ctrl+shift+w`, or run `/warden trace` for a live sidebar with the scores, the reasons, and exactly what the agent was told.

## Why Jev

Agents pick the next command well and notice badly when that command is out of proportion to the request. Pattern lists catch `rm -rf /` and force pushes; they cannot tell `db:reset` after "reset the database" from `db:reset` after "add a column". A generative model can, but a second LLM call per tool call is slow and expensive. Jev is a System One model: it returns calibrated probabilities instead of text, in a quarter of a second, for a fraction of a cent. That is cheap enough to sit in front of every guarded call. Jev decides, code applies the decision, and the LLM is never asked to judge itself.

## Install

```bash
pi install npm:pi-warden
```

Requires Pi 0.85 or newer and Node.js 22.19 or newer. Pattern checks work with no account. Jev judgments need a TypeSafe API key and are billed to your TypeSafe account (a judgment is roughly 600 input tokens; a rules request with 8 rules is about 2000; output is free).

## Setup

1. Get a key at [console.typesafe.ai](https://console.typesafe.ai) (API Keys).
2. Run `/warden enable`. Read the data notice and confirm. If no key is stored yet, paste it at the hidden prompt. The key is verified and saved to `~/.pi/agent/pi-typesafe/auth.json` (owner-only, shared with pi-typesafe). Consent is saved to `~/.pi/agent/pi-warden/config.json` and stays on until `/warden disable`.
3. Optional: `/warden test` shows one synthetic verdict.

`TYPESAFE_API_KEY` in the environment takes precedence over the stored key. Headless runs give consent with `PI_WARDEN_ENABLED=1`.

The [examples README](examples/README.md) walks through the starter `pi-warden.md`, the project `.pi/pi-warden.json`, and the user `config.json`.

## Philosophy

pi-warden is a harness for the agent, not a gate for you. Three jobs:

| Pillar | What it means |
| --- | --- |
| **Security** | Holds and offline patterns protect risky operations. Output checks flag injected instructions and credential shapes. Insecure written code gets a targeted steer. Advisory, not a sandbox. |
| **Deslopify** | Written code is scored per symptom and judged against your project rules. Replies are scored for wordiness, clichés, and jargon. Repeats become a standing rule. |
| **Context saving** | Only the newest tool result is ever touched, so the prompt cache prefix stays byte-identical. Large output is cut to exact lines and stored; recalls go to a search, not a whole-file read. |

## The guards

### Action guard

Runs on `tool_call`, before the tool executes.

1. **Skip** read-only tools and read-only shell lines (`git status && ls`): no request, no widget line.
2. **Patterns**, offline: force pushes, `git reset --hard`, `git clean`, recursive `rm` on absolute, home, variable, or parent paths, SQL `DROP`/`TRUNCATE`/`DELETE FROM`, block-device writes, `chmod -R 777`, fork bombs, `curl | sh`, `kill -1`, shutdown, package publishing, infrastructure destroys hold the call. `rm -rf` on a project path, `git checkout -- .`, `git branch -D`, `git stash drop`, `find -delete`, `sudo` warn. Reads or writes of `.env`, SSH, AWS, npm, kube, and other credential files warn. A `write` that overwrites a file outside the project holds; creating or editing outside the project warns.

   Text that is data is not a command. A heredoc body written to a file, a quoted `echo`/`printf` argument, a `grep` pattern, or a `git commit -m` message can mention `git push --force` without a hold. The same text fed to `sh`, `bash -c`, `eval`, `xargs`, or a `python3 - <<EOF` script that calls `os.system` keeps every hit.
3. **Jev**, with consent: one request with `{ task, context, action }` and four questions. `irreversible` (yes/no), `off_task` (yes/no), `mutates` (does it change anything), `scope` (expected step, plausible side step, unrelated, unclear). Defaults: irreversible at 0.5 warns and at 0.7 holds; off-task at 0.6 warns and at 0.85 with `unrelated` holds, but only when the action can change something. An unrelated `grep` is warned about, never held. Patterns set the floor; Jev can only raise it.
4. **Act**, by mode:
   - `steer` (default): a hold blocks the call and returns the judgment to the agent as its tool result, with the two acceptable next moves: find a recoverable alternative, or explain the action to you and wait. If your reply approves it, the retry goes through (Jev reads your reply; offline, a yes/go-ahead heuristic does).
   - `confirm`: a `ctx.ui.confirm` dialog. No blocks with a short reason. Falls back to `steer` without a UI.
   - `advise`: never holds, reports only.

The action guard receives your latest message plus up to eight earlier user and assistant messages (750 redacted characters each) so follow-ups and side comments do not replace the task. Sibling tool calls in one assistant message are judged together in one round trip. If TypeSafe cannot answer, the call is allowed with a warning (`failOpen: true`; set it to `false` to hold instead).

### Rules

Write your project's rules as Markdown headings in `pi-warden.md` at the project root (a starter file with a dozen rules is in [`examples/pi-warden.md`](examples/pi-warden.md)):

```markdown
# No console statements
Code must not contain `console.log` or `console.debug`. Use the logger.

# Exported functions must have explicit return types
paths: src/**/*.ts
Every exported function declares its return type.

# TODO comments need a reference
A `TODO` or `FIXME` must name a ticket, for example `TODO(APP-123): ...`.
```

Each heading is one rule; the text under it is the specification. A `paths:` line right under the heading limits the rule to matching files (`**` matches any depth, `*` stays within one segment). Content inside code fences is never read as a heading. The highest heading level present in the file delimits rules, so `##` rules under a `#` title work too.

On every `write` and `edit`, pi-warden sends its own request, in parallel with the action guard's, carrying the written content and one question per rule: `compliant`, `violation`, `not_applicable`, or `insufficient_context`. A `write` is sampled at 6000 characters (head, middle, tail); an `edit` sends each new text plus about 40 lines of the current file around the replaced text. With two or more edits, one more question asks which edit contains the violation.

Any rule with P(violation) at or above `rules.threshold` (0.7) is named to the agent: the heading, up to 200 characters of the rule text, and the edit when located. The write goes through; a held write would leave a half-written file. The third hit of one rule in a session says so and asks the agent to treat it as a standing rule. When slop also fires on the same write, both arrive as one message.

Sources, in order: `pi-warden.md` at the root; else the files listed in `rules.files` (all sent in one request); else, with `rules.fallback` (default true), the first of `README.md`, `CLAUDE.md`, `AGENTS.md`, judged as one document with one question. A fallback document is cut to `rules.maxChars` (8000) with every heading and the head of each section kept, so a very long AGENTS.md still fits. Files are re-read when they change; no restart needed. At most 31 rules are asked per request (TypeSafe's cap is 32); the rest are ignored and `/warden status` says how many.

Path scoping in config: `rules.exclude` globs are never sent to Jev (secrets, generated, vendored files); `rules.skip` globs are files the rules do not apply to (tests, docs); a per-rule `paths:` line narrows one rule. `rules.sensitivePaths` maps a glob to a note, for example `"migrations/**": "Tell the user this touches a migration and add a rollback"`; a write or edit under a matching path gives the agent that note once per path, offline, with no request.

From the tuning set (`scripts/rules-cases.mjs`, 8 rules, 13 cases, all as expected): `console.log` in code scores 1.00, a bare TODO 1.00 and a `TODO(QUEUE-41)` 0.00, an empty catch 0.99, a `switch` without `default` 0.96, a hardcoded token 0.88, a missing return type 0.99 with a bad boolean name 0.96 on the same write. A compliant module, a test that mentions `console.log` in a string, and a Markdown doc about `console.log` score nothing. The locator points at the right one of two edits. Not covered: code written through shell heredocs and content past the sample limits.

Ideas borrowed with thanks from [jevrealtimecodecheck](https://github.com/MrDesjardins/jevrealtimecodecheck) (rules as headings, the four outcomes) and [wince](https://github.com/TinyFrontier/wince) (path globs, sensitive paths, judge the change and not its story, the locator question).

### Slop

**In code.** When the agent calls `write` or `edit`, four yes/no questions ride on the action guard's request (no extra latency), one per symptom: `slop_stub` (placeholder or fake-data code where a working implementation is needed), `slop_comments` (comments that restate the code), `slop_dead` (commented-out code, unused imports, duplicated logic, unreachable branches), `slop_hedging` ("should work", "for now", TODOs without a plan). Jev sees a 1500-character head/middle/tail sample of a `write` or the first three replacement texts of an `edit`. Any symptom at or above `slop.threshold` (0.7) sends the agent a steer naming the symptom and its fix. The write is never held. The third repeat of a symptom becomes a standing rule.

From the tuning set (`scripts/slop-cases.mjs`): a `// TODO: implement later` stub scores stub 0.99; restating comments 0.97 while an explanatory why-comment scores 0.08; commented-out code scores dead 0.96; a mock inside a test file scores stub 0.51 (below threshold, correctly).

**In replies.** The final reply (200 characters or more) is judged against `slop.prose.audience`: `wordy`, `cliches`, `jargon`. `audience` is `technical` (default), `plain`, or free text such as "a founder without programming background". A symptom must appear in `trend` (2) of the last 3 replies before the agent is nudged; the nudge is queued for your next prompt so it shapes the next reply without spending a turn. A padded reply scores wordy 0.97 / clichés 0.99; a dense three-point summary 0.25 / 0.05.

### Security

Written code gets a `security_risk` question on the action request: hardcoded credentials, disabled TLS checks, unsafe shell or SQL interpolation, broad permissions, bypassed verification. A threshold crossing (0.7) warns you and steers the agent; it does not block.

Tool output from content-bearing tools (`read`, fetch and search tools, named MCP equivalents) is checked for instructions that redirect the assistant or ask for private data; other tools from 2048 characters. Jev receives a redacted 6000-character head/tail sample. A score at or above `security.threshold` wraps the text in an untrusted-data notice and steers the agent. Credential-shape checks work offline and warn not to echo or commit possible secrets. This is advisory, not a sandbox.

### Stuck

Keeps the last 12 tool results for the current prompt. When the latest result failed and at least 3 failures have accumulated, exact repeats are caught offline (same call, same output with timings and addresses normalised). Otherwise one request judges the sequence: `same_strategy`, `approach_change` (identical / cosmetic / meaningfully different), `progress`. Same strategy at 0.7 counts as stuck: you get a notification and the agent gets a steer asking for a new hypothesis or a blocker report. At most one check per 3 results. In the smoke run, "investigating between failures" scored 0.32 and "flailing" 0.93.

### Runaway

A model that degenerates mid-reply repeats the same lines until the token limit or you press Esc; no tool runs and no turn ends, so nothing else stops it. pi-warden reads the stream as it arrives: per token it appends to a buffer; every 256 characters it counts identical paragraphs (24 characters or more) and checks for one unit repeated back to back at the end. A block repeated `repeats` (4) times in the reply, or `thinkingRepeats` (10) times in thinking, aborts the run. Code only: nothing is sent anywhere. With `recover: true` (default) the agent gets one follow-up turn that names the repeat and asks for the one next step; a second runaway for the same prompt is stopped and left for you. Calibrated on 43,000 local assistant messages: ordinary replies repeat a paragraph twice at most, thinking up to seven times, and the one real runaway repeated its block 28 times. The guard stopped only that one, at half its length.

### Done-check

Tracks each run's evidence: code changes (`write`, `edit`) and check commands (`npm test`, `pytest`, `cargo test`, `tsc`, `eslint`, `go test`, `make test`, and similar) with pass or fail; context-mode's inline `Command exited with code N` counts as a failure. When a run ends with a normal message after code changes and no passing check, one request judges the message: `claims_done`, `claims_verified`, `verification_applies`, `outcome`. A completion claim at 0.7 or above for a task where checks mean something is reported as unverified; a claim that tests passed when none ran is called a false claim. With `nudge: true` the agent gets one follow-up turn asking it to run the checks or say plainly that nothing was verified. Once per prompt.

### Context saver

Only the newest tool result is ever changed, before it enters the session, so the prompt cache prefix and all earlier entries stay as they were.

- **Duplicates** (code only). A text result of at least `context.duplicateMinChars` (2000) that is identical to an earlier result of this session becomes a short note naming the earlier tool and the size, plus a recall footer. Re-running the same failing test is the typical case.
- **Retention and format** (Jev decides, code applies). For a single text block of at least `context.tailMinChars` (12000), Jev picks `all`, `errors_and_summary`, or `summary_only`, and names the format (`vitest_jest`, `node_test`, `tsc`, `eslint`, `pytest`, `git_diff`, `git_log`, `npm_install`, `other`). When a format is confident (0.7) and its markers are present, a parser keeps the exact lines that matter: failing tests with their assertions, compiler and linter errors with file and line, changed files with counts, package notices, the summary line. Otherwise bounded head, diagnostic, and tail excerpts. Nothing is paraphrased. The full output is written to an owner-only temporary file first; the excerpt links to it. If storage fails, the original stays. Multiple text blocks are not compressed.
- **Recall through search.** The footer names the file and a search command that exists on this machine (probed once: `rg`, `ag`, `ugrep`, `git grep --no-index`, `grep`, `Select-String`, `findstr`). `context.recallTool` pins one or `none`.
- **Measuring it.** `/warden status` shows how many outputs were candidates, how many were compressed or dropped as duplicates, the bytes removed, the token-turns spared, and the recalls, split into whole-file reads (which give the saving back) and scoped accesses. A recall rate above about 10% means `context.confidence` is too low for your work.

Set `context.enabled: false` to turn it off. Full-output files can contain secrets and stay in the OS temporary directory until removed.

### Desktop notifications

A held call the agent will ask you about, a confirm dialog waiting for an answer, and a runaway stop reach the desktop. macOS uses `osascript`; Linux tries `notify-send`, `dunstify`, `gdbus`, `kdialog`, `zenity`, then `powershell.exe` for WSL; Windows shows a toast through PowerShell. Interactive sessions only, one notification per `cooldownMs` (10 s), the reason but never the command. `"notify": { "enabled": false }` turns it off; `"command": ["curl", "-d", "{body}", "https://ntfy.sh/your-topic"]` in the user file replaces the desktop tool with your own relay (no shell; `{title}` and `{body}` are replaced and set as `PI_WARDEN_TITLE` / `PI_WARDEN_BODY`). A project file may switch notifications off but never names a command.

### Steer messages

Nudges from the rules, slop, stuck, done, and prose guards are custom messages in the agent's context. By default they are hidden from the transcript (`steerVisible: false`); the notification tells you a nudge happened and the trace panel shows the exact text. When the per-session request budget is spent, pi-warden says so once and continues with offline checks.

## Commands

| Command | Effect |
| --- | --- |
| `/warden status` | Guard state, consent and key source, session counts, thresholds, rules source, config paths, last verdicts |
| `/warden enable` | Data notice, key prompt if none is stored, consent saved |
| `/warden disable` | Stop Jev judgments; pattern checks continue |
| `/warden mode steer\|confirm\|advise` | How holds are handled; without an argument, show the current mode |
| `/warden config` | Edit the user config JSON in Pi's editor |
| `/warden test` | One synthetic destructive action, its verdict, and what the agent would be told |
| `/warden trace` | Toggle the trace sidebar (or print the last 20 events without a UI) |

## Status line and trace sidebar

The line above the editor shows the latest verdict per guard, for example `warden · bash · irreversible 0.84 · off-task 0.86 · unrelated · confirm`. `/warden trace`, `ctrl+shift+w`, and a click on the line each toggle a right-hand sidebar with the full trace, newest first, live. The sidebar does not take the keyboard; click inside it for arrow keys and PgUp/PgDn, `c` clears, Esc hands input back, `q` closes. `widget.panelWidth` sets its width.

Clicks and the wheel need Pi's fullscreen mode (`tuiMode: "fullscreen"` in `/settings`). In macOS Terminal.app enable View → Allow Mouse Reporting.

Templates in `config.widget` control the text. Segments are separated by ` · `; a segment whose token has no value is dropped:

```json
"widget": {
  "action": "warden · {tool} · irreversible {irreversible} · off-task {offTask} · {scope} · slop: {slop} · patterns: {patterns} · {flags} · {level}",
  "rules": "warden · rules · {tool} {path} · {asked} rules · {violations} · {status}",
  "stuck": "warden · stuck · {failures} failures · same strategy {sameStrategy} · change {approachChange} · progress {progress} · {flags} · {status}",
  "done": "warden · done-check · {changes} changes · {checksPassed}/{checks} checks passed · claims done {claimsDone} · claims verified {claimsVerified} · checks apply {checksApply} · {outcome} · {status}",
  "prose": "warden · prose · wordy {wordy} · clichés {cliches} · jargon {jargon} · {flags} · {status}",
  "security": "warden · security · {tool} · injection {injection} · exfiltration {exfiltration} · {status}",
  "context": "warden · context · {tool} · {retention} · saved {bytesSaved} bytes",
  "runaway": "warden · runaway · {kind} · {count}× repeated · {chars} chars · {signal} · {status}"
}
```

Tokens per guard: action `tool level source irreversible offTask scope approved slop slopStub slopComments slopDead slopHedging patterns reasons path model ms flags time`; rules `tool path asked violations status source reasons model ms flags time`; prose `wordy cliches jargon status reasons model ms flags time`; stuck `failures sameStrategy approachChange progress status source reasons model ms flags time`; done `changes checks checksPassed claimsDone claimsVerified checksApply outcome status reasons model ms flags time`; security `tool injection exfiltration status`; context `tool retention bytesSaved`; runaway `kind count chars signal block status time`. `"enabled": false` hides the line; `"shortcut": ""` disables the keybinding.

## Configuration

User file `~/.pi/agent/pi-warden/config.json` (owner-only). Missing keys use these defaults:

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
    "offTask": { "warn": 0.6, "confirm": 0.85 }
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
  "notify": { "enabled": true, "cooldownMs": 10000, "command": [] },
  "widget": { "enabled": true, "placement": "aboveEditor", "shortcut": "ctrl+shift+w", "panelWidth": "40%" },
  "steerVisible": false
}
```

A project may add `.pi/pi-warden.json` with `enabled` and per-guard overrides: stricter thresholds, extra guarded tools, `rules.files`, `rules.skip`, `rules.sensitivePaths`, or `"done": { "enabled": false }`. Project files are read only when Pi trusts the project. They can never grant `typesafe` consent, change `mode`, raise `timeoutMs` or `maxRequests`, or set `notify.command`. Environment: `PI_WARDEN_ENABLED=1` (consent), `PI_WARDEN_MODE=steer|confirm|advise`.

A wince-style setup for a backend repo (the full version is [`examples/pi-warden.json`](examples/pi-warden.json)):

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

## Data handling

With consent, requests go to `https://api.typesafe.ai`. What is sent:

- **Action guard**: your latest prompt (1500 characters), up to eight earlier user and assistant messages (750 redacted characters each), the tool name, the command (2000 characters) or the file path (relative inside the project, `~`-shortened outside), whether the file exists, a 1500-character head/middle/tail sample of a `write`, the first three edit pairs (400 characters each) of an `edit`.
- **Rules**: the project-relative path, a 6000-character sample of a `write` or each edit's new text (1500 characters) with about 40 lines of the current file around the replaced text, and the rule text from your rules file or the condensed fallback document (`rules.maxChars`). No task text. Files under `rules.exclude` are never sent.
- **Stuck**: the last 12 tool calls (300 characters each) with 400-character output tails.
- **Done-check and prose**: the agent's final message (2000 and 2500 characters), the run's check commands, the audience description.
- **Output checks**: a redacted head/tail sample up to 6000 characters plus size, line counts, and tool name.
- **Nothing** for duplicate detection, the runaway guard, sensitive-path notes, or pattern checks.

Obvious credentials (`Authorization` headers, `TOKEN=` and `SECRET=` assignments, `sk-`, `ghp_`, `AKIA`, JWTs, URL passwords, PEM blocks) are replaced with `[redacted]` before sending. Best-effort; do not rely on it for prompts that contain secrets. Text steered to the agent names the tool, the reasons, and the scores, not the command. UI errors never include upstream response bodies or keys. Judgments are model output; thresholds are yours to tune.

## After updating the package

Restart Pi after an update; `/reload` re-imports the entry module but can leave older modules of the same package in memory. Since 0.5.2 the extension checks the shape of the config it receives; a section that an older module does not know (the symptom of two package versions in one process) switches that guard off and prints one warning naming the sections and the schema numbers. 0.9.0 crashed instead when the shape-check module itself was the stale one; since 0.9.1 the extension guards the sections it reads in its own module, so the warning appears and everything else keeps working. If you see the warning, restart Pi.

## For extension authors

Every guard is a plain function you can call with any object that has pi-typesafe's `evaluate` method as the judge:

```ts
import { evaluateAction, evaluateRules, RuleStore, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const judge = createTypeSafe();
const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge },   // omit judge for pattern checks only
);
verdict.level;      // "allow" | "warn" | "confirm"  (confirm = hold in steer mode)
verdict.reasons;    // ["destructive: git force push", "irreversible 0.91"]

const set = new RuleStore().load(process.cwd(), defaultConfig().rules);
const rules = await evaluateRules("write", { path: "src/a.ts", content: "console.log(1)" }, { cwd: process.cwd(), config: defaultConfig().rules, set, judge, timeoutMs: 5000 });
rules.findings;     // [{ id: "no-console-statements", name, violation: 0.97, body }]
```

What spans calls in a session lives in `ActionGuard` (hold, reply, retry approval, sibling batching) and `RulesGuard` (rule cache, sibling prejudging, repeat counts, sensitive-path notes). Also exported: `matchPatterns`, `isReadOnlyCommand`, `stripDataText`, `describeAction`, `parseRules`, `matchGlob`, `redact`, `formatVerdict`, the question sets, the stuck detector, the runaway guard, the notifier, the done-check, and the config helpers.

## Development

```bash
npm install
npm run check                    # typecheck, offline tests (mocked transport), build
npm run test:live                # billable synthetic judgments across the guards; pass action|slop|approval|stuck|done|security|context for one group
node scripts/rules-cases.mjs     # 13 billable cases against an 8-rule fixture file
node scripts/slop-cases.mjs      # 22 billable cases for the slop and prose questions
node scripts/security-cases.mjs  # 9 output-security and task-continuity cases
node scripts/context-cases.mjs   # 15 labelled outputs for retention and format
npm run dev:pi                   # start Pi with this working tree plus an installed pi-typesafe
npm run preview                  # re-render docs/preview.png (needs a Chrome binary)
```

## License

MIT
