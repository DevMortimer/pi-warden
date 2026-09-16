# pi-warden

A second pair of eyes for [Pi](https://pi.dev) that makes the agent smarter instead of interrupting you. Before the agent runs a `bash`, `write`, or `edit` call (or a shell command through [context-mode](https://www.npmjs.com/package/context-mode)'s `ctx_execute`), pi-warden asks [Jev](https://typesafe.ai) two questions about it in ~250 ms: *would this destroy something that cannot be recovered?* and *is this what the user actually asked for?* The answers are probabilities, so `rm -rf dist` after "rebuild from scratch" sails through while `npm run db:reset` after "add a column" is held, and the agent is told why so it re-plans or asks you in chat. Three more guards watch the run: a **stuck-loop** detector, a **done-check** for completion claims that no test backed up, and a **slop** note for stubs and filler. Built on [pi-typesafe](https://github.com/DevMortimer/pi-typesafe).

![Real verdicts from pi-warden: the same command gets a different verdict depending on what the user asked for](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/preview.png)

The verdicts above are real output from `npm run test:live`. Independent project; not affiliated with TypeSafe AI or the Pi authors.

## Why a coding agent needs this

Agents are good at picking the next command and bad at noticing when that command is out of proportion to the request. Pattern lists catch `rm -rf /` and force pushes; they cannot tell `db:reset` when you asked for a reset from `db:reset` when you asked for a column. A generative model can, but a second LLM call per tool call is slow and expensive. Jev is a System One model: it returns calibrated probabilities instead of text, in a quarter of a second, for a fraction of a cent. That makes it cheap enough to sit in front of **every** guarded call:

- **Irreversible actions are held, not run**: history rewrites, deleted untracked work, dropped tables, overwritten files outside the project, publishes and deploys. The agent receives the judgment as its tool result — what was flagged, the scores, and two acceptable next moves: find a recoverable alternative, or explain the action to you and wait. If you approve in chat, the retry goes through; Jev reads your reply as the approval. No modal dialog unless you ask for one (`/warden mode confirm`).
- **Scope drift gets flagged.** Poems in a bugfix, refactors nobody asked for, dependency installs unrelated to the task: warned to you at 0.6, held at 0.85 when Jev also calls the action `unrelated`.
- **Loops get broken.** Three failures with the same strategy (same command with cosmetic changes, same error after each edit) earn the agent a steer: re-read the error, form a new hypothesis, or report the blocker. Exact repeats are caught offline; Jev tells "investigating between failures" from "flailing" — 0.32 vs 0.93 in the smoke run.
- **"Done" gets checked.** When the final message reports completion after file changes and no test, build, or lint passed in that run, the agent is asked to verify before you read a false "all green". A claim that tests passed when none ran is called out as such. Once per prompt, so it cannot loop.
- **Slop gets a note.** Stub functions, `TODO: implement later`, mocks returning fake data, filler comments: scored on the same request as the action guard (zero extra latency) and steered back to the agent after the write, never held.
- **Nothing slows down the boring calls.** Read-only shell lines are skipped without a request; anything else costs one request of ~600 input tokens.
- **It degrades gracefully.** Offline pattern checks and exact-repeat detection run with no account at all. On an API timeout or outage the call is allowed with a warning (configurable), and reasons never include your command text or upstream error bodies.

## Install

```bash
pi install npm:pi-warden
```

Requires Pi 0.85 or newer and Node.js 22.19 or newer. Pattern checks work with no account. Jev judgments need a TypeSafe API key and are billed to your TypeSafe account (a judgment is roughly 600 input tokens; output is free).

## Setup

1. Get a key at [console.typesafe.ai](https://console.typesafe.ai) (API Keys).
2. Run `/warden enable`. Read the data notice and confirm; if no key is configured yet, paste it at the hidden prompt. The key is verified against the API and saved to `~/.pi/agent/pi-typesafe/auth.json` with owner-only permissions, shared with [pi-typesafe](https://github.com/DevMortimer/pi-typesafe) and anything else built on it. Consent is saved to `~/.pi/agent/pi-warden/config.json`, so judgments stay on in every new session until you run `/warden disable`.
3. Optionally run `/warden test` to see one synthetic verdict.

A `TYPESAFE_API_KEY` environment variable takes precedence over the stored key. Without step 2, pi-warden still guards with offline pattern checks only.

## How the guards work

### Action guard (`tool_call`)

1. **Skip** read-only tools, and read-only shell lines such as `git status && ls` (no network, no widget). Guarded by default: `bash`, `powershell`, `write`, `edit`, and context-mode's `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` (their `code`/`commands` fields are read as the command; non-shell code such as JavaScript is judged but never skipped as read-only). Add other tools with `action.tools`; unknown tools are judged from their JSON input.
2. **Pattern pass** (offline): force pushes, `git reset --hard`, `git clean -f`, recursive `rm` on absolute/home/variable/parent paths, SQL `DROP`/`TRUNCATE`/`DELETE FROM`, block-device writes, `chmod -R 777`, fork bombs, `curl | sh`, `kill -1`, shutdown, package publishing, infrastructure destroys → **hold**. `rm -rf` on a project path, `git checkout -- .`, `git branch -D`, `git stash drop`, `find -delete`, `sudo` → **warn**. Reads or writes of `.env`, SSH, AWS, npm, kube, and other credential files → **warn**. A `write` that overwrites an existing file outside the project → **hold**; creating or editing outside the project → **warn**.
3. **Jev judgment** (with consent): one request with the state `{ task, action }` and three questions — `irreversible` (Noul), `off_task` (Noul), `scope` (Choice: expected step, plausible side step, unrelated, unclear). Defaults: irreversible ≥ 0.5 warns, ≥ 0.7 holds; off-task ≥ 0.6 warns, ≥ 0.85 with `unrelated` holds. Pattern results set the floor; Jev can only raise it. For `write`/`edit`, two slop questions ride on the same request.
4. **Act**, by mode:
   - `steer` (default): a hold blocks the call and returns the judgment to the agent as the tool result, with the two acceptable next moves. You see a notification and the widget line; the agent keeps working. When the agent asks you and your reply approves the action (Jev: `approved` ≥ 0.7, or an offline yes/go-ahead heuristic without consent), the identical retry is allowed once.
   - `confirm`: a hold opens a `ctx.ui.confirm` dialog; No blocks with a short reason. Without a UI this falls back to `steer`.
   - `advise`: never holds; every judgment is reported to you only.

   Warn-level verdicts notify you and continue in every mode. The widget above the editor shows the last verdict of each guard, for example `warden · bash · irreversible 0.84 · off-task 0.86 · unrelated · confirm`.

### Stuck detector (`tool_result`)

Keeps the last 12 tool results for the current prompt. When the latest result failed and at least 3 failures have accumulated, it first checks for exact repeats offline (same call, same output with timings and addresses normalised). Otherwise one Jev request judges the sequence: `same_strategy` (Noul), `approach_change` (Score: identical / cosmetic / meaningfully different), `progress` (Noul). Same-strategy ≥ 0.7 counts as stuck: you get a notification, and with `nudge: true` (default) the agent gets a steer message asking for a new hypothesis or a blocker report. At most one Jev check per 3 results.

### Done-check (`agent_end`)

Tracks each run's evidence: code changes (`write`, `edit`) and check commands (`npm test`, `pytest`, `cargo test`, `tsc`, `eslint`, `go test`, `make test`, and similar, whether run through `bash` or `ctx_execute`) with pass/fail; context-mode's inline `Command exited with code N` counts as a failure. When a run ends with a normal assistant message after code changes and no passing check, one Jev request judges the message: `claims_done`, `claims_verified`, `verification_applies` (Noul), `outcome` (Choice: complete / partial / blocked / other). A completion claim ≥ 0.7 that is not a blocker or question, for a task where checks would mean something (≥ 0.5; prose and file housekeeping score ~0.05), is reported as unverified; a verification claim with no check run is reported as a false claim. With `nudge: true` (default) the agent receives one follow-up turn asking it to run the checks or say plainly that nothing was verified — once per user prompt.

### Slop (`write`/`edit`, same request as the action guard)

pi-warden cannot rewrite code — Jev only judges — so slop is handled as a feedback loop through the agent:

1. When the agent calls `write` or `edit`, two questions ride on the action guard's request (no extra latency): `slop_quality`, a Score over three described levels — *focused* (does what the task needs, comments only where they add information) / *some filler* (comments restating the code, minor dead code, hedging) / *sloppy* (stub or placeholder code, TODO where a working implementation is needed, duplicated or commented-out logic, vague text) — and `slop_placeholder`, a Noul: does the content leave placeholder, stub, mock, or "implement later" code where `task` needs a working implementation? Jev sees the first 1500 characters of a `write` or the first three replacement texts of an `edit`, plus your request, so "needed" is judged against what you asked for.
2. Quality ≥ 1.5 or placeholder ≥ 0.7 (config `slop`) trips the note. Below that, nothing happens.
3. The write **goes through** — holding it would leave a half-written file. Instead the agent receives a steer message before its next LLM call: *"pi-warden: the content just written to `src/x.ts` reads as quality 1.90/2 (filler or sloppy) and placeholder or stub code 0.92. Replace stubs and placeholders with working code, remove comments that restate the code, and keep only what the request needs. If something is intentionally left unimplemented, say so in your reply instead of leaving it in the code."* The agent fixes the file on its next turn; you see a notification and `slop 1.9/2 · stub 0.92` in the widget.

From the live smoke: a `// TODO: implement later` stub scored quality 2.00 / placeholder 0.99, a mock returning fake user data 2.00 / 0.98, a focused implementation 0.00 / 0.02, and a function with only restating comments 0.87 / 0.02 — deliberately below the threshold, because the guard is for stubs and filler that change behaviour, not for style. Not covered: code written through bash heredocs, content past the excerpt limits, and the agent's prose replies.

If TypeSafe cannot answer (timeout after 5 s, outage, budget), an action-guard call is allowed with a warning (`failOpen: true`; set it to `false` to hold instead), and the other guards simply skip. When the per-session request budget is spent, pi-warden says so once and continues with offline checks. Consent in headless runs comes from `PI_WARDEN_ENABLED=1`; `PI_WARDEN_MODE` overrides the mode.

## Commands

| Command | Effect |
| --- | --- |
| `/warden status` | Guard state, consent source, key source, session counts, thresholds, config paths, last verdict |
| `/warden enable` | Show the data notice, prompt for a key if none is stored, and save consent for Jev judgments |
| `/warden disable` | Stop Jev judgments; pattern checks continue |
| `/warden mode steer\|confirm\|advise` | Choose how holds are handled; without an argument, show the current mode |
| `/warden config` | Edit the user config JSON in Pi's editor and save it |
| `/warden test` | Evaluate one synthetic destructive action and show the verdict and what the agent would be told |
| `/warden trace` | Open the trace panel (or print the last 20 events without a UI) |

## Status line and trace panel

The line above the editor shows the latest verdict per guard, for example `warden · bash · irreversible 0.84 · off-task 0.86 · unrelated · confirm`. Every verdict is also kept in a session trace with what was inspected (redacted command or path), the pattern hits, Jev's scores with model and latency, the reasons, and the exact text the agent was told. Open the panel with `/warden trace`, `ctrl+shift+w`, or by clicking the status line (clicks need Pi's fullscreen mode: `tuiMode: "fullscreen"` in settings, because regular mode leaves the mouse to the terminal). The panel is a right-hand overlay, newest first, live-updating while the agent works; ↑↓/PgUp/PgDn scroll, `c` clears, Esc closes.

Templates in `config.widget` control the text. Segments are separated by ` · `; a segment whose token has no value for that verdict is dropped, so optional information disappears together with its label:

```json
"widget": {
  "enabled": true,
  "placement": "aboveEditor",
  "shortcut": "ctrl+shift+w",
  "action": "warden · {tool} · irreversible {irreversible} · off-task {offTask} · {scope} · slop {slopQuality} · stub {slopStub} · patterns: {patterns} · {flags} · {level}",
  "stuck": "warden · stuck · {failures} failures · same strategy {sameStrategy} · change {approachChange} · progress {progress} · {flags} · {status}",
  "done": "warden · done-check · {changes} changes · {checksPassed}/{checks} checks passed · claims done {claimsDone} · claims verified {claimsVerified} · checks apply {checksApply} · {outcome} · {status}"
}
```

Tokens — action: `tool level source irreversible offTask scope approved slopQuality slopStub patterns reasons path model ms flags time`; stuck: `failures sameStrategy approachChange progress status source reasons model ms flags time`; done: `changes checks checksPassed claimsDone claimsVerified checksApply outcome status reasons model ms flags time`. A minimal line: `"action": "⚔ {tool} {level} · {irreversible}/{offTask}"`. Set `"enabled": false` to hide the line (the trace and panel keep working); `"shortcut": ""` disables the keybinding.

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
  "stuck": { "enabled": true, "window": 12, "minFailures": 3, "cooldown": 3, "sameStrategy": 0.7, "nudge": true },
  "done": { "enabled": true, "claimsDone": 0.7, "nudge": true },
  "slop": { "enabled": true, "quality": 1.5, "placeholder": 0.7 },
  "widget": { "enabled": true, "placement": "aboveEditor", "shortcut": "ctrl+shift+w" }
}
```

A project may add `.pi/pi-warden.json` with `enabled` and per-guard overrides (for example stricter thresholds, extra guarded tools, or `"done": { "enabled": false }`). Project files are read only when Pi trusts the project, and they can never grant `typesafe` consent, change `mode`, or raise `timeoutMs`/`maxRequests`. Environment: `PI_WARDEN_ENABLED=1` (consent), `PI_WARDEN_MODE=steer|confirm|advise`. Files from 0.1.x that set `action.timeoutMs`/`action.maxRequests` keep working.

## Data handling

- With consent, each guarded call sends to `https://api.typesafe.ai`: your latest prompt (truncated to 1500 characters), the tool name, the command (truncated to 2000 characters) or the file path (relative inside the project, `~`-shortened outside), whether the file exists, a 1500-character content excerpt for `write`, and the first three edit pairs (400 characters each) for `edit`. The stuck detector sends the last 12 tool calls (300 characters each) with 400-character output tails; the done-check sends the agent's final message (2000 characters) and the run's check commands. No other files, history, or telemetry.
- Obvious credentials in the action (`Authorization` headers, `TOKEN=`/`SECRET=` assignments, `sk-`, `ghp_`, `AKIA`, JWTs, URL passwords, PEM blocks) are replaced with `[redacted]` before sending. This is best-effort; do not rely on it for prompts that contain secrets.
- Text returned or steered to the agent names the tool, the reasons, and the scores, not the command text. UI errors never include upstream response bodies or keys.
- Judgments are model output. Thresholds are yours to tune; a hold is information for the agent and for you, not a verdict on either.

## For extension authors

The guard is a plain function you can call from your own extension or tests, with any object that has pi-typesafe's `evaluate` method as the judge:

```ts
import { evaluateAction, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge: createTypeSafe() },   // omit judge for pattern checks only
);
verdict.level;      // "allow" | "warn" | "confirm"  (confirm = hold in steer mode)
verdict.reasons;    // ["destructive: git force push", "irreversible 0.91"]
verdict.judgment;   // { irreversible, offTask, scope, scopeConfidence, approved?, model, elapsedMs }
steerReason(verdict, { canApprove: true });   // the text the agent receives for a hold
```

Also exported: `matchPatterns`, `isReadOnlyCommand`, `describeAction`, `redact`, `formatVerdict`, the question sets, the stuck detector (`AttemptWindow`, `makeAttempt`, `evaluateStuck`, `stuckNudge`), the done-check (`classifyToolResult`, `recordOutcome`, `needsDoneCheck`, `evaluateDone`, `doneNudge`), and the config helpers.

## Development

```bash
npm install
npm run check        # typecheck, offline tests (mocked transport), build
npm run test:live    # 28 billable synthetic judgments across all guards (key from .env or the stored login); pass action|slop|approval|stuck|done for one group
npm run dev:pi       # start Pi with this working tree plus an installed pi-typesafe
npm run preview      # re-render docs/preview.png from the recorded live verdicts (needs a Chrome binary)
```

## License

MIT
