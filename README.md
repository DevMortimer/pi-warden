# pi-warden

[![npm](https://img.shields.io/npm/v/pi-warden?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-warden)
[![downloads](https://img.shields.io/npm/dm/pi-warden?color=blue)](https://www.npmjs.com/package/pi-warden)
[![stars](https://img.shields.io/github/stars/DevMortimer/pi-warden?style=flat&logo=github)](https://github.com/DevMortimer/pi-warden/stargazers)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Pi](https://img.shields.io/badge/Pi-0.85%2B-8a2be2)](https://github.com/earendil-works/pi)
[![judged by Jev](https://img.shields.io/badge/judged%20by-Jev-orange)](https://typesafe.ai)

**Hand real work to a cheaper model.** pi-warden stands between a coding agent and your machine. It stops the moves
that cannot be undone, gives the model what a careless model lacks (your project's rules, its own failure history,
the things it promised to do), and tells you what the agent actually did instead of what it said it did.

It runs inside [Pi](https://github.com/earendil-works/pi), and as hooks in Claude Code and Codex.

![A careless agent makes six moves in a terminal: it tries to wipe uncommitted work, reads a secrets file, repeats a failing command, tries to switch pi-warden off, fakes a fix with a stub, and claims the tests pass. pi-warden holds two of them, masks the secrets, and reports the other three to the owner.](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/assets/demo.gif)

## The idea

A strong model is expensive partly because it is careful. It reads the house rules, notices when it is going in
circles, hesitates before `git reset --hard`, and runs the tests before it says "done". A cheaper model is fast and
usually right, and it skips those steps.

pi-warden moves that care out of the model. One part is plain code that runs on your machine with no network. The
other part is [Jev](https://typesafe.ai), a small judgment model that answers typed yes-or-no questions with a
probability. Neither part depends on the agent being careful, so the same supervision applies to whatever model you
run.

Every guard acts in one of three ways, and it helps to know which:

| | What happens | Who sees it |
| --- | --- | --- |
| **It stops the call** | The command or write is held before it runs. The agent gets the reason as the tool result, with how to re-plan. | The agent and you |
| **It changes what the model reads** | Tool output is masked, cut down or annotated before the model sees it, and the rules and memory that apply are added to the system prompt. | The agent |
| **It tells you** | A judgment lands on the status line above the editor, in the trace sidebar, and in a trace file. With `notices` on it is also a line in the transcript, as in the recording. In Pi it does not enter the conversation. | You |

## A careless move, and what happens to it

| The agent | pi-warden | Works with no key |
| --- | --- | :---: |
| runs `git reset --hard` over uncommitted work, force-pushes, drops a table, destroys infrastructure, or deletes a folder outside the project | **holds the call** before it runs | yes |
| runs something destructive that no pattern names | asks Jev how irreversible it is: 0.9 holds, 0.5 warns | |
| edits a config, then runs the command that applies it | **holds the second step**, by an arming rule you wrote | yes |
| writes to pi-warden's own config, the file that could switch a check off | **holds the call** | yes |
| prints a credential, or reads a file that contains one | **masks the value** as `[redacted]` before the model reads it | yes |
| reads output that says "ignore your instructions" | marks the output as untrusted data | |
| prints far more output than the task needs | keeps the lines that matter and saves the rest to a file the agent can search | |
| reads the same long output twice | replaces the repeat with a pointer | yes |
| runs the same failing command again with nothing changed | **tells you** on the second run | yes |
| fails three times with the same strategy | **tells you** it is stuck, and swaps the repeated output for a diff against the last attempt | |
| polls with `sleep`, pages through one file a few lines at a time, or re-runs a check with a different filter | adds one sentence to the tool result, which costs no extra model call | yes |
| writes code that breaks one of your project's rules | **tells you** which rule, in which file | |
| leaves a stub, comments that restate the code, dead code, or hedging | **tells you** which | |
| writes a hardcoded credential, disables TLS checks, or builds SQL from strings | **tells you** | |
| does something other than what it just said it would do | **tells you** it is off plan | |
| starts work that looks unrelated to your request | records it in the trace, and never holds for it | |
| says "done" with no test, build or lint run since its last change | **tells you** the claim is unverified | |
| changes a UI file and offers a unit test as proof | does not count the test: something has to have looked at the screen | |
| says "the cause is X" and never checked | **tells you** the cause is unchecked | |
| repeats the same paragraph over and over | **stops the reply** and gives the agent one turn to recover | yes |
| forgets a correction you gave in earlier sessions | puts the corrections you repeated back in the system prompt | yes |
| forgets what it promised before the context was compacted | keeps open promises in a file and shows them again | yes |
| is woken by every report a background subagent sends | wakes it only for a report that needs it | |

The right column is the offline half. It is deterministic, it sends nothing, and it works the moment the package is
installed. Everything else needs Jev.

## Install

```sh
pi install npm:pi-warden
```

That is enough for the offline half. For the judged half, in Pi:

```
/warden enable     consent screen, then your key from console.typesafe.ai
/warden init       writes a starter pi-warden.md for this project
/warden status     what is guarded, what is on, and what this session spent
```

It needs Pi 0.85.1 or newer and Node 22.19 or newer. It also runs on oh-my-pi.

`/warden enable` shows exactly what will be sent before anything is sent, and the choice stays until
`/warden disable`. A headless run has nobody to ask, so it takes consent from the environment instead:
`PI_WARDEN_ENABLED=1` and `TYPESAFE_API_KEY`.

## Holds

A hold is the only thing pi-warden does that stops work, so it is kept narrow. Three things block a call:

- **A destructive pattern.** The floor reads a command the way the shell runs it: through `sudo`, `bash -c`, pipes into
  `sh`, command substitution, and the body of a script or `npm run` target the command starts. It skips text that is
  only data, so a commit message that mentions `git push --force` is not held. The built-in patterns cover force push,
  hard reset, `git clean`, recursive delete of a dangerous target, SQL `DROP`, `TRUNCATE` and `DELETE FROM`, writes to a
  block device, `curl | sh`, package publish, infrastructure destroy, and printing a credential.
- **A rule you wrote.** `deny` blocks outright. `confirm` asks you. A path rule guards a folder by read or by write. An
  arming rule holds a command only after a matching file was edited, which catches the pair of harmless steps that are
  destructive together.
- **Jev's score.** When judgments are on, Jev reads the call, your request, and the plan the agent stated, and scores
  how irreversible the call is. The patterns become evidence it weighs instead of a verdict.

A held call returns its reason to the agent with two ways forward: reach the goal by something recoverable, or stop
and ask you. Approval comes only from your next message. When the agent retries the held call after you reply, Jev
reads your reply and releases the call only if it approves that action. The agent's own text can explain a call and
can never approve one.

`/warden mode` picks what a hold does: `steer` (the default) hands the reason to the agent, `confirm` opens a dialog
for you, and `advise` never holds and only reports.

The floor errs toward holding. In the maintainer's own use over forty-one days, 632 of 817 holds were an agent deleting
scratch folders it had just made ([field report](eval/reports/2026-10-27-field-usage/README.md)). Session scratch and
temp folders are now recognized and let through with a warning.

## Project rules

Rules live in `pi-warden.md` at the project root. Every heading is one rule, and the text under it is what the judge
reads:

```markdown
# No console output in library code
paths: src/**
Code under `src/` must not call `console.log`. Use the project logger.

# Errors are not swallowed
A `catch` block must handle the error, log it with context, or rethrow it.

# Public API changes come with a changelog line
when: turn
A change to an exported function adds a line under Unreleased.
```

`paths:` scopes a rule to matching files. `threshold:` sets its own cutoff, `severity:` orders the findings, and
`when: turn` judges the rule once against the whole diff at the end of a run instead of on every edit. With no
`pi-warden.md`, the files you list in `rules.files` are used, and after that `AGENTS.md`, `CLAUDE.md` or `README.md` is
read as one document.

The rules reach the work in three places:

1. **At the start of a turn.** Jev picks the rules that apply to what you just asked, and they are added to the
   agent's system prompt for that run.
2. **On every write and edit.** The written content is judged against each rule that covers the file. A shell command
   that writes a file, such as a heredoc, is judged the same way.
3. **At the end of a run.** `when: turn` rules are judged against the whole diff, with any changed file no earlier
   check saw.

Rule findings never hold a call. In Pi they go to you. In Claude Code and Codex they go back to the model.

There are tools for the rules themselves: `/warden rules check` flags rules the judge cannot decide well,
`/warden rules calibrate` replays your recent commits through the rules to find the ones that fire on everything,
`/warden rules audit` judges existing files, and `/warden report` reads the local log of past judgments and flags
the rules that never fire, fire on everything, or cannot decide.

`/warden improve` reads the last seven days of this project's own sessions, rules log and hold log (`/warden improve 4`
reads four days, up to 90) and prints what cost you: whole-file reads, calls flagged as repeats, requests you typed
twice, and holds, rule by rule. It then hands those counts to the model already running in the session, which may make
at most three changes to `pi-warden.md`, each citing the count it came from. A backup is written first, and the diff is
printed after. It sends no Jev request. While the pass runs, the rules judge is quiet in that one session, so the
rewrite is not graded against the rules it is rewriting; the floor stays on.

## Memory the agent can use

pi-warden gives the agent three tools:

| Tool | What it keeps |
| --- | --- |
| `warden_remember` | A standing lesson for this project, for later sessions. |
| `warden_loops` | Promises made in this session ("after CI passes I will bump the version"). They survive compaction and resume. |
| `warden_recall` | What was already tried in this session: failed attempts with their error lines, the last passing check, and the paths of saved full outputs. |

It also reads your own earlier sessions of the project, on your machine, for corrections you typed more than once.
`/warden prefs` lists them, and the ones repeated in three sessions on two different days are added to the system
prompt.

When Pi compacts a long session, pi-warden appends what a summary tends to lose: the failed calls, the last passing
check, the holds, and the paths of saved outputs.

## Claude Code and Codex

The same rules and checks run as hooks, without Pi:

```sh
npm install -g pi-warden
pi-warden init claude      # or: pi-warden init codex
```

Add `--project` to install into the project's own settings instead of your user settings. `pi-warden uninstall`
removes exactly the entries it added. Run `init` again after an upgrade: it adds only the hooks that are missing.
Codex asks you to review new hooks once, with `/hooks`.

| | Claude Code | Codex |
| --- | :---: | :---: |
| Project rules on a file change (`Write` and `Edit`, or `apply_patch`) | yes | yes |
| Done-check when the run stops | yes | yes |
| Stuck-check on repeated failures | yes | |
| Holds and the destructive-command floor | | |

The hooks run after a tool call, so they never hold one: the floor is a Pi feature. They read your user config only,
and they take consent from `PI_WARDEN_ENABLED=1` and the key from the environment. See
[docs/claude-code.md](docs/claude-code.md) and [docs/codex.md](docs/codex.md).

## What leaves your machine

Nothing, until you run `/warden enable` or set `PI_WARDEN_ENABLED=1`. After that, requests go to `api.typesafe.ai`,
or to the backend you name in `typesafeBackend` (OpenRouter, Command Code, Liquid AI, SubQ, Nace.AI, or your own
endpoint). A project file cannot change the backend.

What is sent is a redacted, truncated summary, never the raw session:

- your latest request, and the first request of the thread with up to four earlier ones;
- for each guarded call, the command or a sample of the written content, and the plan the agent stated;
- for a rules check, the written content with the lines around each edit, and the rule text;
- the tails of recent tool calls when the agent keeps failing;
- the agent's final message, when it claims completion or states a cause;
- a sample of a large tool output, to decide what to keep.

Credential shapes are stripped from all of it before it is sent. Redaction is best effort, so list secret and
generated files under `rules.exclude`, which keeps their content on your machine. `rules.enabled: false` keeps your
rule text there too.

What stays local: saved full outputs (owner-only temp files), the hold log, the rules log, standing preferences,
open loops, and a SQLite file of redacted hold records (a hold is kept 365 days, an allowed call 90). The full list is in
[docs/data-handling.md](docs/data-handling.md), and it is the same text the consent screen shows.

## What it costs

The offline half is free. The judged half costs Jev requests on your own key.

- A session stops asking after 500 requests (`maxRequests`). `/warden status` shows the count.
- A gate keeps calls that cannot change anything, such as reads, searches, builds and test runs, from spending a
  request. On recorded sessions it cut the action guard's requests by 48.9%
  ([measurement](docs/guards.md#calibration)).
- If Jev times out or is down, the call is allowed with a warning and the patterns decide alone. After three failures
  in a row the guards stop asking for a minute.
- `/warden bench` measures the latency, the input tokens and the estimated cost of one check against your own rule set.

For scale: in this project's benchmark, the judgments for 780 guarded agent runs cost $0.90 in total, through the
SubQ backend ([report](eval/reports/2026-10-25-thesis-v5-low/README.md)).

## What is measured

Each claim here has a report in [`eval/reports`](eval/reports/README.md).

- **Holds.** Over forty-one days and 3,350 sessions of the maintainer's own work, 817 of 184,249 judged actions were
  held (0.4%). Of the
  276 holds with a known outcome, the agent took a safer route 235 times, the user approved 30 and declined 11.
- **Rules.** On 139 labelled cases at the shipped 0.7 cutoff, the rules guard caught 62 of 68 violations, with 2 false
  alarms in 71 clean cases.
- **Stability.** 13,952 guard cases over 109 overnight cycles passed with zero regressions.
- **End to end.** A pre-registered A/B run compared the same agent with pi-warden and with the same rules as plain
  prose. On DeepSeek V4.1 Flash the agent finished tasks as often with pi-warden as without it. The run did not show
  the halving of rule violations it was designed to detect, and the guarded runs cost 1.3 to 2 times as much in total.
  An earlier, smaller run did see violations halved on the weaker of its two models. Read it as: pi-warden is
  measured to stop destructive calls and to catch rule violations when they happen, and it is not yet measured to make
  a model follow rules more often than a well-written prompt does.

Thresholds are set on recorded sessions, and a feature that measured worse ships off or records to the trace only. The
0.9 hold, for one, replaced 0.7 because the band between them held no call a user regretted. The method and every
number are under [Calibration](docs/guards.md#calibration).

## Commands

| Command | What it does |
| --- | --- |
| `/warden status` | Guards, mode, thresholds, this session's counts, and the build that is running. |
| `/warden enable`, `/warden disable` | Consent for judgments. The offline checks stay on either way. |
| `/warden mode steer\|confirm\|advise` | What a hold does. |
| `/warden init` | Starter rules for this project, written by the session model. |
| `/warden audit` | Has the session model look through the workspace for places a judge would help, and write an HTML report. |
| `/warden rules` | The active rules. Also `rules check`, `rules audit`, `rules calibrate`, `rules tune`. |
| `/warden report`, `/warden improve` | What the rules did lately, and a pass that proposes better ones. |
| `/warden trace` | The trace sidebar: every judgment, with its scores and what was said. |
| `/warden config` | A settings panel, or `config set <key> <value>` and `config get <key>`. |
| `/warden prefs`, `/warden loops` | Standing preferences and open promises. |
| `/warden recommend` | Threshold suggestions drawn from how your past holds turned out. |
| `/warden index` | A local index of your skills and tools, for the coach below. |
| `/warden test` | One synthetic hold, to see what a real one looks like. |

More in [docs/commands.md](docs/commands.md).

## Configuration

Your settings are in `~/.pi/agent/pi-warden/config.json`, and a project can add `.pi/pi-warden.json`. Every guard has
a switch and a threshold. A project file can tighten a check. The keys that could loosen your protection or redirect
your data are read from your own file only: deny, exempt, path and arming rules, the mode, and the backend. When a
project file does loosen something it is allowed to, you are told once, by name.

```json
{
  "mode": "steer",
  "notices": true,
  "action": {
    "commandDenyRules": [{ "id": "no-prod-db", "pattern": "psql .*prod", "message": "production database" }]
  },
  "rules": { "exclude": ["secrets/**"], "skip": ["tests/**"] }
}
```

Some features are off until you turn them on:

| Feature | Key | Status |
| --- | --- | --- |
| A transcript line for each notice | `notices` | Stable |
| Desktop notifications when a call waits for you, or your own notifier command | `notify.enabled` | Stable |
| A coach that suggests a skill or tool the agent is missing | `conscience.enabled` | Beta |
| A filter that keeps the passages of a large output that matter to the task | `context.filter.enabled` | Beta |
| A relevance-based replacement for Pi's compaction summary | `compaction.enabled` | Experimental, not recommended |

Two things run without a switch: in a [herdr](https://herdr.dev) pane a waiting dialog shows as blocked, and with
judgments on, pi-warden records Jev's read of Token Guardian supervision events in the trace without acting on them.
`/warden status` also counts, per model, how often a notice was followed.

Every key is in [docs/configuration.md](docs/configuration.md), and [`examples/`](examples) has files to copy.

## As a library

Every guard is a plain function with no dependency on Pi's runtime:

```ts
import { evaluateAction, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge: createTypeSafe() },
);
```

See [docs/extension-authors.md](docs/extension-authors.md).

## Versioning

pi-warden follows semver for the documented config keys and their defaults (except `compaction.*`, `context.filter.*`
and `conscience.*`, which are experimental or beta), the `/warden` commands and their arguments, the `warden_remember`,
`warden_loops` and `warden_recall` tools, the documented `PI_WARDEN_*` environment variables, the status line's
template tokens, and the exports named in [docs/extension-authors.md](docs/extension-authors.md). The trace file
format, the files in pi-warden's data folder, and every other export are internal and may change in any release.

## Development

```sh
npm install
npm run check        # typecheck, build, offline tests
npm test             # offline tests only
npm run dev:pi       # start Pi with this working tree
npm run demo         # record the animation above again
```

## Credits

- **Confidence bands for the irreversible hold:** Li, Miao, Krishnan, Padman, "JEV-as-a-Judge: Accept When Confident,
  Escalate When Unsure", [arXiv:2609.26550](https://arxiv.org/abs/2609.26550).
- **Chunk scoring in the context filter:** GPT Researcher's
  [context filter](https://docs.gptr.dev/docs/gpt-researcher/gptr/context-filter).
- **The judge:** [Jev](https://typesafe.ai) by TypeSafe.

## More

[Guards and their calibration](docs/guards.md) · [Examples](docs/examples.md) · [CI and headless runs](docs/ci-cd.md) ·
[FAQ](docs/faq.md) · [Upgrading](docs/upgrading.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

MIT licensed.
