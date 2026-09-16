# pi-warden

A second pair of eyes for [Pi](https://pi.dev) that makes the agent smarter instead of interrupting you. Before the agent runs a `bash`, `write`, or `edit` call (or a shell command through [context-mode](https://www.npmjs.com/package/context-mode)'s `ctx_execute`), pi-warden asks [Jev](https://typesafe.ai) two questions about it in ~250 ms: *would this destroy something that cannot be recovered?* and *is this what the user actually asked for?* The answers are probabilities, so `rm -rf dist` after "rebuild from scratch" sails through while `npm run db:reset` after "add a column" is held, and the agent is told why so it re-plans or asks you in chat. Three more guards watch the run: a **stuck-loop** detector, a **done-check** for completion claims that no test backed up, and a **slop** note for stubs and filler. Built on [pi-typesafe](https://github.com/DevMortimer/pi-typesafe).

![Real verdicts from pi-warden: the same command gets a different verdict depending on what the user asked for](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/preview.png)

The verdicts above are real output from `npm run test:live`. Independent project; not affiliated with TypeSafe AI or the Pi authors.

## Philosophy

pi-warden is a harness for the agent, not a gate for the user. It watches every tool call, tool result, and reply, asks Jev small typed questions about them, and acts through the agent's own context — a held call, a steer message, a compressed output — rather than through dialogs. Jev decides; code applies the decision; the LLM is never asked to judge itself. Everything warden does is visible in the trace panel, and nothing is rewritten in your session file.

Three jobs, in order of maturity:

| Pillar | What it means | Status |
| --- | --- | --- |
| **Security** | Irreversible or off-task actions are held with a reason the agent can act on; credential files, force pushes, destructive SQL, and remote-script execution are caught offline; secrets are redacted before anything leaves the machine. Next: injected instructions inside tool output (web pages, issues, files) flagged and quarantined; insecure patterns in written code steered. | built · extending |
| **Deslopify** | Written code is scored per symptom — stubs, restating comments, dead code, hedging — and the agent gets a nudge naming the symptom and its fix; repeats become a standing rule. Replies are scored for wordiness, assistant clichés, and jargon against an `audience` setting, and a trend across replies shapes the next one. | built |
| **Context saving** | Jev judges which tool outputs are worth keeping; code compresses them. Only at moments that cannot cost a prompt-cache miss: when an output arrives (before it enters the cache), when the cache is measurably cold, or when Pi compacts anyway. Works alongside prompt-cache optimizers because it never touches the system prompt or a warm prefix. | planned |

## Why a coding agent needs this

Agents are good at picking the next command and bad at noticing when that command is out of proportion to the request. Pattern lists catch `rm -rf /` and force pushes; they cannot tell `db:reset` when you asked for a reset from `db:reset` when you asked for a column. A generative model can, but a second LLM call per tool call is slow and expensive. Jev is a System One model: it returns calibrated probabilities instead of text, in a quarter of a second, for a fraction of a cent. That makes it cheap enough to sit in front of **every** guarded call:

- **Irreversible actions are held, not run**: history rewrites, deleted untracked work, dropped tables, overwritten files outside the project, publishes and deploys. The agent receives the judgment as its tool result — what was flagged, the scores, and two acceptable next moves: find a recoverable alternative, or explain the action to you and wait. If you approve in chat, the retry goes through; Jev reads your reply as the approval. No modal dialog unless you ask for one (`/warden mode confirm`).
- **Scope drift gets flagged.** Poems in a bugfix, refactors nobody asked for, dependency installs unrelated to the task: warned to you at 0.6, held at 0.85 when Jev also calls the action `unrelated`.
- **Loops get broken.** Three failures with the same strategy (same command with cosmetic changes, same error after each edit) earn the agent a steer: re-read the error, form a new hypothesis, or report the blocker. Exact repeats are caught offline; Jev tells "investigating between failures" from "flailing" — 0.32 vs 0.93 in the smoke run.
- **"Done" gets checked.** When the final message reports completion after file changes and no test, build, or lint passed in that run, the agent is asked to verify before you read a false "all green". A claim that tests passed when none ran is called out as such. Once per prompt, so it cannot loop.
- **Slop gets a name.** Written code is scored per symptom on the same request as the action guard (zero extra latency): stubs and fake-data mocks, comments that restate the code, dead or duplicated code, hedging notes. The agent is told which symptom and how to fix it, never held; the third repeat in a session becomes a standing rule. Replies are scored too — wordy, clichéd, or too technical for the configured audience — and a trend across replies earns a nudge that shapes the next one without spending a turn.
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

### Slop in code (`write`/`edit`, same request as the action guard)

pi-warden cannot rewrite code — Jev only judges — so slop is handled as a feedback loop through the agent:

1. When the agent calls `write` or `edit`, four Noul questions ride on the action guard's request (no extra latency), one per symptom, each with concrete yes/no criteria: `slop_stub` (placeholder, mock, or "implement later" code where `task` needs a working implementation), `slop_comments` (explanatory comments that restate what the adjacent code shows), `slop_dead` (commented-out code, unused imports or variables, duplicated logic, unreachable branches), `slop_hedging` ("should work", "for now", TODOs without a plan). Jev sees a head/middle/tail sample of a `write` (1500 characters) or the first three replacement texts of an `edit`, plus your request.
2. Any symptom ≥ `slop.threshold` (0.7) trips the note. The write **goes through** — holding it would leave a half-written file.
3. The agent receives a steer message naming the symptoms and their fixes, e.g. *"pi-warden: the content just written to `src/x.ts` has stub or placeholder code where a working implementation is needed; hedging or vague notes. Fix it in your next edit: replace stubs, placeholders, and hard-coded fake data with the working implementation, or state in your reply exactly what is left unimplemented and why; replace \"should work\", \"for now\", and TODOs without a plan with a definite statement or a concrete follow-up."* The third time a symptom appears in a session, the note says so and asks the agent to treat it as a standing rule.

Per-symptom scoring is what makes this precise. From the tuning set (`scripts/slop-cases.mjs`, 16 code cases): a `// TODO: implement later` stub scores stub 0.99; restating comments score comments 0.97 while an explanatory why-comment scores 0.08; commented-out code scores dead 0.96 and comments 0.43; a mock inside a *test file* scores stub 0.51 (below threshold, correctly); a stub explicitly outside the task scores 0.24. Not covered: code written through shell heredocs and content past the sample limits.

### Slop in replies (`agent_end`)

The run's final reply (≥ 200 characters) is judged against `slop.prose.audience`: `wordy` (preamble, restating the request, closing summary, filler), `cliches` ("Great question", "I hope this helps", "it's worth noting", unrequested caveat lists, emoji headings), `jargon` (unexplained terms for the audience). `audience` is `technical` (default), `plain`, or any free-text description such as *"a founder without programming background"*. One long answer to a long question is not punished: a symptom must appear in `trend` (2) of the last 3 replies before the agent is nudged, the nudge is queued for the next user prompt so it shapes the next reply without spending a turn, and two replies pass before the same nudge can fire again. From the tuning set: a padded reply scores wordy 0.97 / clichés 0.99; a dense three-point summary 0.25 / 0.05; the same status update scores jargon 0.94 for a plain audience and 0.24 for a developer.

### Steer messages

Nudges from the stuck, done, slop, and prose guards are custom messages in the agent's context. By default they are **hidden from the transcript** (`steerVisible: false`) so the conversation stays yours; the notification tells you a nudge happened and the trace panel shows the exact text. Set `steerVisible: true` to see them inline.

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
  "action": "warden · {tool} · irreversible {irreversible} · off-task {offTask} · {scope} · slop: {slop} · patterns: {patterns} · {flags} · {level}",
  "stuck": "warden · stuck · {failures} failures · same strategy {sameStrategy} · change {approachChange} · progress {progress} · {flags} · {status}",
  "done": "warden · done-check · {changes} changes · {checksPassed}/{checks} checks passed · claims done {claimsDone} · claims verified {claimsVerified} · checks apply {checksApply} · {outcome} · {status}",
  "prose": "warden · prose · wordy {wordy} · clichés {cliches} · jargon {jargon} · {flags} · {status}"
}
```

Tokens — action: `tool level source irreversible offTask scope approved slop slopStub slopComments slopDead slopHedging patterns reasons path model ms flags time`; prose: `wordy cliches jargon status reasons model ms flags time`; stuck: `failures sameStrategy approachChange progress status source reasons model ms flags time`; done: `changes checks checksPassed claimsDone claimsVerified checksApply outcome status reasons model ms flags time`. A minimal line: `"action": "⚔ {tool} {level} · {irreversible}/{offTask}"`. Set `"enabled": false` to hide the line (the trace and panel keep working); `"shortcut": ""` disables the keybinding.

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
  "slop": {
    "enabled": true,
    "threshold": 0.7,
    "prose": { "enabled": true, "audience": "technical", "threshold": 0.7, "trend": 2, "minChars": 200 }
  },
  "widget": { "enabled": true, "placement": "aboveEditor", "shortcut": "ctrl+shift+w" },
  "steerVisible": false
}
```

A project may add `.pi/pi-warden.json` with `enabled` and per-guard overrides (for example stricter thresholds, extra guarded tools, or `"done": { "enabled": false }`). Project files are read only when Pi trusts the project, and they can never grant `typesafe` consent, change `mode`, or raise `timeoutMs`/`maxRequests`. Environment: `PI_WARDEN_ENABLED=1` (consent), `PI_WARDEN_MODE=steer|confirm|advise`. Files from 0.1.x that set `action.timeoutMs`/`action.maxRequests` keep working.

## Data handling

- With consent, each guarded call sends to `https://api.typesafe.ai`: your latest prompt (truncated to 1500 characters), the tool name, the command (truncated to 2000 characters) or the file path (relative inside the project, `~`-shortened outside), whether the file exists, a 1500-character head/middle/tail sample for `write`, and the first three edit pairs (400 characters each) for `edit`. The stuck detector sends the last 12 tool calls (300 characters each) with 400-character output tails; the done-check and the prose check send the agent's final message (2000 and 2500 characters) with the run's check commands and the audience description. No other files, history, or telemetry.
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
npm run test:live    # 31 billable synthetic judgments across all guards (key from .env or the stored login); pass action|slop|approval|stuck|done for one group
npm run dev:pi       # start Pi with this working tree plus an installed pi-typesafe
node scripts/slop-cases.mjs   # 22 billable cases that tune the slop and prose questions
npm run preview      # re-render docs/preview.png from the recorded live verdicts (needs a Chrome binary)
```

## License

MIT
