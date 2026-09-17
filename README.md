# pi-warden

Makes the [Pi](https://pi.dev) agent follow your project's rules. An `AGENTS.md` asks the model to remember; pi-warden checks. On every write and edit, [Jev](https://typesafe.ai) judges the change against the rules in your `pi-warden.md` (about 250 ms, a fraction of a cent) and the violated rule is quoted back into the agent's own context. The same channel names slop, breaks retry loops, calls out "done" when no test ran, keeps large tool output small, and holds the rare destructive command. You keep working; the agent gets a nudge instead of you getting a dialog.

![Real verdicts from pi-warden: the same command gets a different verdict depending on what the user asked for](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/preview.png)

The verdicts above are real output from `npm run test:live`. Independent project; not affiliated with TypeSafe AI or the Pi authors. Built on [pi-typesafe](https://github.com/DevMortimer/pi-typesafe).

## In one minute

```bash
pi install npm:pi-warden
```

Then, inside Pi:

1. `/warden enable`. Read the data notice and confirm. If no key is stored yet, paste one from [console.typesafe.ai](https://console.typesafe.ai) (hidden input, saved owner-only, shared with pi-typesafe).
2. `/warden test` shows one synthetic verdict and what the agent would be told.
3. Work as usual. The line above the editor shows the latest verdict; `ctrl+shift+w` opens the trace with the scores and the exact text the agent received.

Requires Pi 0.85 or newer and Node.js 22.19 or newer. Without a key, the offline parts still run: the pattern list, the runaway stop, duplicate-output notes, sensitive-path notes, and the credential-shape warnings. The [examples folder](examples/README.md) has a starter rules file and both config files.

## What it watches

| Guard | Watches | Does |
| --- | --- | --- |
| **Rules** | every `write` and `edit` | judges the written code against your project's Markdown rules (`pi-warden.md`) and names the violated rule to the agent |
| **Slop** | written code and final replies | names stubs, restating comments, dead code, hedging, padded replies; the agent fixes them in the next edit |
| **Stuck** | tool results | notices three failures with the same strategy and asks for a new hypothesis |
| **Done-check** | the final message | catches "done" claims after code changes when no test, build, or lint passed |
| **Context saver** | large or repeated tool output | keeps the exact lines that matter, stores the rest in a file, points recalls at a search |
| **Action** | every `bash`, `write`, `edit` (and context-mode's `ctx_execute*`) before it runs | holds irreversible calls and tells the agent why, so it re-plans or asks you; steers it back when a change is unrelated to your request |
| **Security** | written code and tool output | flags hardcoded secrets, disabled TLS, unsafe interpolation; marks injected instructions in tool output; fixture and documentation stand-ins are traced, never announced |
| **Runaway** | the reply stream | stops a reply that repeats the same block over and over (code only, no request) |
| **Subagent triage** | async subagent reports | Jev decides whether a child report is worth waking the agent for; routine progress stays in context and costs no request ([detail](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md#subagent-triage)) |
| **Notifications** (opt-in) | moments that need you | desktop notification for a held call, a confirm dialog, a runaway stop |

Three jobs, one channel: keep the agent on your rules, keep slop out of the code and the replies, keep the context small. The action guard is the seatbelt underneath: on 17,000 recorded calls it held 42 times. Everything arrives through the agent's own context, so the agent gets smarter and you are not the approval button. Full detail per guard, with thresholds and tuning numbers, is in [docs/guards.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md).

## Does it improve the code?

**Short answer: yes, on a model that breaks rules.** The same five tasks through glm-5.3-flash broke a rule in **7 of 25 runs without pi-warden and 1 of 25 with it**, at no cost in passing tests. On a model that already writes clean code (deepseek-v4.1-flash) it changed nothing measurable: 0 rule-breaking runs in either cell.

`npm run eval:ab` runs the same fixture tasks through headless Pi twice. The control cell gets the five rules as prose in `AGENTS.md`; the warden cell gets the same file plus pi-warden enforcing `pi-warden.md`. A mechanical checker scores every final diff and shares no code with the guard, so no guard verdict can influence a score; each task ships a shortcut that passes the provided tests while breaking a rule, so only the checker can tell the cells apart. Run it on your own model: `npm run eval:ab -- --repeats 5 --model <model>` (about 45 minutes and a few hundred thousand tokens for 50 runs).

Results so far, 50 runs per model (5 tasks, both cells, 5 repeats):

| Model | Cell | Rule violations in final diffs | Tests fully passing | Median run time |
| --- | --- | --- | --- | --- |
| glm-5.3-flash | control | **7 of 25 runs** | 50 of 50 | 34 s |
| glm-5.3-flash | warden | **1 of 25 runs** | 47 of 50 | 44 s |
| deepseek-v4.1-flash | control | 0 of 25 runs | 25 of 25 | 15 s |
| deepseek-v4.1-flash | warden | 0 of 25 runs | 25 of 25 | 20 s |

The clipping task shows the effect best. Without the warden, 6 of 10 glm runs cut user-visible text to fit. With it, 1 of 10, and every run that received a clip steer ended clean. On deepseek, a model that already wrote clean code, the warden changed nothing worth measuring and cost a few seconds per run.

The honest footnotes. The glm test failures in the warden cell are model variance, not guard interference: a 20-run retry-only batch put both cells at 8 of 10, and the guard stayed silent in every failure. Credential steer noise was the one measured waste: 30 of deepseek's 34 steers were two fixture tokens the agent read from the test file it was editing. 0.14 traces those stand-ins instead, which replays those 50 runs at 2 credential steers instead of 30, both of them a real-shaped token an environment dump exposed. All numbers so far come from one machine and two models; per-batch reports live in [eval/reports/](eval/reports/README.md), and the claim has to survive your re-run too.

## Two moments from real sessions

Both are from my own work sessions, taken from the session logs. Project names are redacted, paths shortened, secrets replaced. The other two, a placeholder the agent talked itself out of removing and a retry loop broken mid-run, are in [docs/examples.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/examples.md).

### It quoted a project rule back, and the agent fixed it in the next turn

The project's `pi-warden.md` rule "No hardcoded secrets" says connection URLs come from settings or the environment. The agent wrote a demo script with the local database DSN as a fallback default.

```text
assistant
  [write] scripts/demo_rail_decisions.py   (186 lines)
    DSN = os.getenv("SUPABASE_DB_URL", "postgresql://[local default]")

pi-warden (steer message to the agent)
  pi-warden: the content just written to scripts/demo_rail_decisions.py violates
  project rule from pi-warden.md: "No hardcoded secrets" (0.88): Source and config
  code must not contain passwords, API keys, tokens, or connection URLs (including
  Supabase DSNs and `FLY_API_TOKEN` values). They come from settings
  (`utils/config.py`) or the environ… [77 more chars]. Fix it in your next edit.

assistant
  The warden flags the hardcoded local DSN. Right call. Making the script require
  `SUPABASE_DB_URL` from the environment instead:
    DSN = os.getenv("SUPABASE_DB_URL")
    if not DSN:
        sys.exit("Set SUPABASE_DB_URL to the local stack's DB_URL (supabase status)")
```

The rule is three lines of Markdown in the repo. No linter knows what a Supabase DSN looks like in a default argument; Jev does, and the agent got the rule text, not a red X.

### It held a database reset, and the agent finished everything else first

A feature branch with a migration. The agent decided to replay the local database. `supabase db reset` is legitimate in that repo, but it wipes local state and nobody had asked for it.

```text
assistant
  [bash] cd .claude/worktrees/con-142 && supabase db reset 2>&1 | tail -6

tool result (written by pi-warden; the command did not run)
  pi-warden held this bash call before it ran: irreversible 0.85. Do not retry it
  unchanged. Either (1) reach the goal with a recoverable alternative that stays
  inside the project (a targeted path, a dry run, a move instead of a delete, a
  normal push), or (2) if this exact action is genuinely required, stop and tell
  the user in one or two sentences what it does, what cannot be undone, and why
  it is needed, then wait for their reply. [...the template continues]

assistant
  The warden held `supabase db reset`. It's the sanctioned local-stack replay
  (loopback docker only, no dev/prod reach), but I'll pause that step and ask at
  the end of this update. Continuing with lanes that don't need it:
  [bash] uv run pytest tests/canon tests/services/messaging ...   92 passed in 24.80s

assistant (final message, about 16 tool calls later)
  Draft PR is up, work committed and pushed. One decision is pending for you.
  PR: redacted#2640 (draft) ...
```

No dialog, no interruption. The agent moved the risky step to the end and asked in one sentence.

## How it decides

Every guarded call (`bash`, `write`, `edit`, and shell-like tools such as context-mode's `ctx_execute`) goes through four steps:

1. **Read-only? Skip.** `git status && ls` or a `read`: no request, no line in the trace.
2. **Pattern list, offline.** Force push, `git reset --hard`, recursive `rm` outside the project, SQL `DROP`/`TRUNCATE`/`DELETE FROM`, `curl | sh`, publishing, infrastructure destroys: the call is held. Risky but recoverable things (`rm -rf` on a project path, `sudo`, `--no-verify`, `gh pr merge`, touching `.env`) warn. Text that is data, such as a commit message that mentions `git push --force`, is not a command.
3. **Jev, with your consent.** One request carries your request, up to eight earlier messages, the agent's own words right before the call (its plan), and the call itself. Jev answers fixed questions with probabilities: irreversible, off task, does it change anything, how it relates to the task, does it contradict the plan, is the effect visible outside the working tree. On a write the slop and security questions ride along, and the rules check is a second request in parallel. About 250 ms before the tool runs.
4. **Act.** Only two things hold a call: a destructive pattern, or `irreversible` at 0.7 or above. Everything else (off task, plan mismatch, slop, a rule violation, a security smell) tells the agent and lets the call run.

In the default `steer` mode a hold goes back to the agent as its tool result with two acceptable next moves: find a recoverable way, or explain the action to you in a sentence and wait. If your reply approves it, the retry goes through. `confirm` mode shows you a dialog instead; `advise` never holds.

Three rules hold all of this together. Patterns set the floor and Jev can only raise it. The agent's plan can add a nudge but never remove a hold. Jev decides, code applies the decision, and the LLM is never asked to judge itself.

**Why Jev and not a second LLM call.** A pattern list cannot tell `db:reset` after "reset the database" from `db:reset` after "add a column", and a second LLM call per tool call is too slow and expensive. Jev returns calibrated probabilities to fixed questions in about 250 ms for a fraction of a cent, cheap enough for every guarded call. The full argument, and how large a request gets, is in [docs/guards.md#why-jev](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md#why-jev-and-not-a-second-llm-call).

## What the numbers say

`node scripts/calibrate-action.mjs --all` replays every guarded call in your recorded Pi sessions through the guard and asks Jev, once per turn, whether your next message approved a hold, regretted a call that ran, or rejected the turn. On 321 of my own sessions (17,160 guarded calls): **42 holds, and my next message approved 5**, so 37 stood; **20 regretted calls (2% of turns)**, all scope rather than data loss; and off-task caused 56 of the 139 replay holds without drawing a complaint, so it now steers and never holds.

The labelling never stops: what you do after each hold (approve, decline, redirect, complain) becomes a label, and `/warden status` shows hold precision for your own sessions. The signal ranking, the intent threshold, the candidate questions that lost, and what 67 live steers did to the agent are in [docs/guards.md#calibration](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md#calibration).

## Questions people asked

**How is this different from putting the rules in AGENTS.md?**
An `AGENTS.md` is read once and asks the model to remember. Long sessions, compaction, and cheap models forget. pi-warden re-reads your rules file when it changes and judges every write against it at the moment it happens, then quotes the rule the agent broke. The rules can be things a linter cannot check: "exported functions declare return types", "a TODO must name a ticket", "comments must not restate the code". Keep the AGENTS.md; this is the check behind it.

**Do I need a TypeSafe key?**
Only for Jev judgments. Without one you still get the pattern list, the runaway stop, duplicate-output notes, sensitive-path notes, and credential-shape warnings. Keys come through a waitlist at [console.typesafe.ai](https://console.typesafe.ai); install now and run `/warden enable` when yours arrives.

The other answers (regex, Claude Code's auto mode, cost, permissions, what is sent to TypeSafe, project overrides, headless CI, and the size of a Jev request) are in [docs/faq.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/faq.md).

## Rules for your project

Put `pi-warden.md` at the project root. Each heading is one rule; the text under it is the specification. An optional `paths:` line limits the rule to matching files.

```markdown
# No console statements
Code must not contain `console.log` or `console.debug`. Use the logger.

# Exported functions must have explicit return types
paths: src/**/*.ts
Every exported function declares its return type.
```

On every write and edit, Jev judges the change against each rule: compliant, violation, not applicable, or insufficient context. A violation at 0.7 or above is quoted back to the agent (heading, rule text, and which edit); the write goes through, because a held write would leave a half-written file. The third hit of one rule in a session is called out as a standing rule, and files are re-read when they change.

Without a `pi-warden.md`, the first of `README.md`, `CLAUDE.md`, `AGENTS.md` is judged as one document instead, so existing context files work from day one. Starter file with a dozen rules: [`examples/pi-warden.md`](examples/pi-warden.md). Path globs, sensitive-path notes, and the tuning set: [docs/guards.md#rules](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md#rules).

## Commands

Seven commands: `/warden status`, `enable`, `disable`, `mode steer|confirm|advise`, `config`, `test`, `trace`. `status` reports guard state, session counts, steer counts per guard, thresholds, hold precision, and config paths; `trace` toggles the sidebar with the exact text the agent received. The full table is in [docs/commands.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/commands.md).

## Configuration

Two optional files: your defaults in `~/.pi/agent/pi-warden/config.json` (`/warden config` opens it) and per-repo overrides in `.pi/pi-warden.json`. Common tweaks are `mode`, `steerVisible`, `notify.enabled`, `slop.prose.audience`, `rules.skip`, and `context.enabled`. Every key with its default, what a project file may and may not change, and the environment variables: [docs/configuration.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/configuration.md). Worked examples of all three files: [examples/README.md](examples/README.md).

## Status line and trace

The line above the editor shows the latest verdict per guard, for example `warden · bash · irreversible 0.84 · off-task 0.86 · unrelated · confirm`. `/warden trace`, `ctrl+shift+w`, or a click on the line opens a right-hand sidebar with the full trace, newest first. Clicks need Pi's fullscreen mode (`tuiMode: "fullscreen"` in `/settings`). Widget templates and placement: [docs/configuration.md#status-line-and-trace-sidebar](https://github.com/DevMortimer/pi-warden/blob/main/docs/configuration.md#status-line-and-trace-sidebar).

## For extension authors

Every guard is a plain function you can call with any object that has pi-typesafe's `evaluate` method as the judge, and the library has no dependency on Pi's runtime, so it is safe in tests:

```ts
import { evaluateAction, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge: createTypeSafe() },   // omit judge for pattern checks only
);
```

The rules guard, the session-level `ActionGuard` and `RulesGuard`, and the other exports are in [docs/extension-authors.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/extension-authors.md).

## Development

`npm install`, then `npm run check` (typecheck, offline tests on a mocked transport, build). `npm run test:live` spends real judgments across the guards; `node scripts/calibrate-action.mjs --dry-run` estimates a calibration run on your own sessions; `npm run dev:pi` starts Pi with this working tree. The rules the code keeps (steers never hold, approval comes from the user only, a new question ships with a measurement) are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Rules as headings and the four outcomes come from [jevrealtimecodecheck](https://github.com/MrDesjardins/jevrealtimecodecheck); path globs, sensitive paths, and "judge the change, not its story" from [wince](https://github.com/TinyFrontier/wince).

## License

MIT
