<div align="center">

# pi-warden

**Your coding agent says "done". It didn't run the tests.**<br>
**pi-warden catches it, and the agent fixes it without you.**

[![npm](https://img.shields.io/npm/v/pi-warden?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-warden)
[![downloads](https://img.shields.io/npm/dm/pi-warden?color=blue)](https://www.npmjs.com/package/pi-warden)
[![stars](https://img.shields.io/github/stars/DevMortimer/pi-warden?style=flat&logo=github)](https://github.com/DevMortimer/pi-warden/stargazers)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Pi](https://img.shields.io/badge/Pi-0.85%2B-8a2be2)](https://github.com/earendil-works/pi)
[![judged by Jev](https://img.shields.io/badge/judged%20by-Jev-orange)](https://typesafe.ai)

</div>

![pi-warden tells the agent what it got wrong and the agent fixes it: told 124 times that it said done with nothing checked, the agent ran a check next 94 times (76%); of 111 held actions with a known outcome, the agent found a safer way 79 times, you approved 29, you said no 3 times; 422 steers named a project rule; 1,168 real sessions, 2026-09-16 to 2026-10-01](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/hero.png)

<div align="center">

**1,168 sessions · 419 risky actions stopped before they ran · 76% of fake "done"s turned into real test runs**

<sub>Sixteen days of the maintainer's real use across all their projects, not just this one, 2026-09-16 to 2026-10-01. Method and noise: [field report](eval/reports/2026-10-01-field-usage/).</sub>

</div>

## Install

```bash
pi install npm:pi-warden
```

Then `/warden enable` (paste a [TypeSafe](https://console.typesafe.ai) key) and `/warden init` (writes a starter `pi-warden.md`). That's it. No key? The offline guards still run.

## It steers. It doesn't nag.

Most guardrails stop and ask you. pi-warden tells **the agent** what it got wrong, and the agent corrects itself. You are pulled in only when something can't be undone. In a replay of 18,075 recorded calls (2026-09-21), **0.27% were held at the old 0.7 threshold and 0.1% at 0.9**, the default since 0.75.0 ([report](eval/reports/2026-09-21-calibration-0.33.3/report.md)).

| Your agent… | pi-warden… |
| --- | --- |
| says "done" with no test, build, or lint behind it | sends it back to prove it |
| breaks a rule in your `pi-warden.md` or `AGENTS.md` | quotes the exact rule it broke |
| is about to `git push --force`, `reset --hard`, `rm -rf`, `DROP` | holds it before it runs. A built-in pattern holds the destructive ones with no key at all; with Jev on, a score of 0.9 or more for "cannot be undone" holds too |
| retries the same failing fix for the third time | asks for a new hypothesis |
| writes stubs, restating comments, hardcoded secrets | names them on the spot |
| floods its context with a huge log | keeps the lines that matter, stores the rest |
| starts repeating itself forever | stops the reply |

[Every guard, with its thresholds and calibration →](docs/guards.md)

## Features

Every guard and feature, its default, and its status. Defaults are `defaultConfig()` in `src/config.ts`; Beta and Experimental are the labels in [the guard docs](docs/guards.md). Guards that ask Jev need a key and `/warden enable`; without one, their offline parts still run.

| Feature | What it does | Default | Status |
| --- | --- | --- | --- |
| Jev judgments | Sends redacted samples to Jev for the judged checks below | Off until `/warden enable` | Stable |
| [Action guard](docs/guards.md#action-guard) | Checks each command, write, and edit before it runs: offline patterns plus one Jev request | On | Stable |
| ↳ Offline floor | Holds destructive patterns (force push, `reset --hard`, `rm -rf` on a path outside scratch, `DROP`) with no key and no request; with Jev on, a pattern hit goes to Jev as evidence | On | Stable |
| ↳ Irreversible hold | Jev adds holds: a call scored 0.9 or more as irreversible is held; 0.5 to 0.9 warns | On | Stable |
| ↳ Scratch deletes | A recursive `rm` of temp scratch the agent made warns instead of holding; data moved in keeps the hold | On | Stable |
| ↳ Ask gate | Code decides offline when no Jev answer could change what the agent sees, so the call sends no request: 48.9% fewer requests, 327 of the 338 changed outcomes still asked | On. `action.ask` | Stable |
| ↳ Approval on demand | After a hold, a call held again under your next reply gets one request that reads your reply and the agent's turn; released only when `approved` and `reply_points_at_action` are both 0.7 or more | On | Stable |
| ↳ Off-task notice | Notes in the trace when a call looks unrelated to your request; never steers or holds | On, trace only | Stable |
| ↳ Intent-mismatch steer | Tells the agent when a call differs from its stated plan; the score stays in the trace | Off: trace only. `action.intentTraceOnly: "invisible"` | Stable |
| ↳ Should-proceed notice | Notes in the trace when the judge would ask you first. `action.shouldProceed.steer: true` also tells the agent; the 2026-09-30 labels do not support it (2 of 427 calls needed asking) | Off: trace only | Beta |
| ↳ Your command, path, and arming rules | Warn, hold, or deny commands and paths you name | On, none set | Stable |
| ↳ Large-output warning | Tells the agent to filter a command that will print far more than it needs | On | Stable |
| [Rules](docs/guards.md#rules) | Judges every write and edit against the rules in your `pi-warden.md` | On | Stable |
| [Rules at turn start](docs/guards.md#rules-at-turn-start) | Names the rules a new request will touch, in the background, and delivers them at the next tool boundary; the prompt never waits | On. `rulesAtTurnStart.enabled` | Stable |
| ↳ Soft double-check tier | Asks the agent to double-check a score just below a rule's cutoff | Off. `rules.softThreshold` | Stable |
| [Slop](docs/guards.md#slop) | Names stubs, restating comments, dead code, and padded replies | On | Stable |
| [Security](docs/guards.md#security) | Flags risky written code and prompt injection in tool output; masks credentials, but leaves code values such as a call or an index alone | On | Stable |
| [Stuck](docs/guards.md#stuck) | Asks for a new hypothesis when the agent repeats a failing approach | On | Stable |
| [Done-check](docs/guards.md#done-check) | Sends an unverified "done" back for a check; after a UI change, a visual check | On | Stable |
| [Runaway](docs/guards.md#runaway) | Stops a reply that repeats itself, offline | On | Stable |
| [Context saver](docs/guards.md#context-saver) | Replaces large or duplicate tool output with an excerpt and a saved full copy | On | Stable |
| ↳ Repeated user messages | Cuts repeated runs in your own messages too | Off. `context.dedupeMessages` | Stable |
| ↳ Compaction evidence appendix | After a compaction, lists failed calls, the last passing check, holds, and saved outputs | On | Stable |
| [Context filter](docs/guards.md#context-filter-beta-off-by-default) | Jev scores chunks of a large output and keeps the ones for the current task | Off. `context.filter.enabled` | Beta |
| [Relevance compaction](docs/guards.md#relevance-compaction) | Writes the compaction summary instead of Pi's model; not recommended | Off. `compaction.enabled` (user file only) | Experimental |
| [Call-waste notes](docs/guards.md#call-waste) | One advisory line on polling, paging, repeated searches, and re-filtered checks | On | Stable |
| ↳ Session tip | Adds one paragraph about call cost to the system prompt | Off. `waste.tip` | Stable |
| [Open loops and recall](docs/guards.md#open-loops-and-recall) | `warden_loops` keeps the agent's promises; `warden_recall` lists what it already tried | On, no switch | Stable |
| [Subagent triage](docs/guards.md#subagent-triage) | Wakes the agent only for a subagent report that needs it | On | Stable |
| [Judge cooldown](docs/guards.md#judge-cooldown) | Pauses Jev requests after repeated failures, so a dead backend costs no timeouts | On, no switch | Stable |
| [Steer budget](docs/guards.md#steer-messages) | At most 3 non-critical steers per run; the rest go to the trace | On | Stable |
| [Adaptive steers](docs/guards.md#adaptive-steers-per-model) | Makes a steer kind trace-only for a model that rarely follows or often disputes it | On | Stable |
| Steers and notices in the transcript | Shows steers and per-call notices in the chat, not only in the trace | Off. `steerVisible`, `notices` | Stable |
| [Desktop notifications](docs/guards.md#desktop-notifications) | Holds, confirm dialogs, and runaway stops reach the desktop or your relay | Off. `notify.enabled` | Stable |
| [Herdr pane state](docs/guards.md#herdr-pane-state) | In a herdr pane, a waiting confirm dialog shows as blocked in the herdr sidebar instead of working | On, no switch | Stable |
| [Conscience](docs/guards.md#conscience) | Recommends a skill or tool the agent is missing; ranks candidates on your machine first and sends one request, or none | Off. `conscience.enabled` | Beta |
| Learning from holds | Keeps each judged call in a local database with its Pi session id and, for a hold, what happened next (`approved`, `declined`, `replanned`, `abandoned`); a call that was not held keeps only the judge data, and is pruned after 90 days (`learning.allowedRetentionDays`; holds after 365). `/warden recommend` suggests threshold changes from it. Nothing is sent | On | Stable |
| Config surface | A project file can only make the action guard and security stricter, a value that cannot be applied as written is shown once as a warning, and `deny` and `block` mean the same in every rule kind | On, no switch | Stable |
| Standing preferences | `/warden prefs` finds preferences you repeated across sessions and sends them at session start | On | Stable |

All keys and their values: [configuration](docs/configuration.md). Commands: [commands](docs/commands.md).

## What it costs

Jev requests cost money, so each 1.0 change was measured by what it saves. Each figure is the measured change on recorded sessions of one machine, not a promise for yours.

| Change | Measured effect | Source |
| --- | --- | --- |
| Ask gate and lean request ([#153](https://github.com/DevMortimer/pi-warden/pull/153)) | Action-guard requests 28,036 → 14,326 (−48.9%); input tokens 64.2M → 20.5M (−68.1%); 327 of the 338 calls whose answer changed what the agent saw are still asked (96.7%) | [Ask gate and lean request](docs/guards.md#ask-gate-and-lean-request-2026-09-30) |
| Conscience ranks locally first ([#155](https://github.com/DevMortimer/pi-warden/pull/155)) | Requests per prompt 2 → 1; input tokens per prompt 14,620 → 10,241 (−30%); 30.9% of 7,614 recorded prompts send none | [Local gate, top k, and tip text](docs/guards.md#local-gate-top-k-and-tip-text-2026-10-01) |
| Turn-start reminder and conscience in the background ([#152](https://github.com/DevMortimer/pi-warden/pull/152)) | The prompt hold falls from about 255 ms to under 1 ms at p90; the reminder names a rule that applies 68.9% of the time and catches 21.5% of the rules that apply | [Turn-start delivery calibration](docs/guards.md#turn-start-delivery-calibration-2026-10-01-background-delivery) and [Rules at turn start calibration](docs/guards.md#rules-at-turn-start-calibration-2026-09-30-first-measurement) |
| Approval on demand ([#160](https://github.com/DevMortimer/pi-warden/pull/160), [#161](https://github.com/DevMortimer/pi-warden/pull/161)) | Approval questions per 1,000 judged calls 90.0 → 0.7; wrong releases 45 → 1 in the measured runs | [Approval on demand](docs/guards.md#approval-on-demand-2026-10-01-three-designs-three-sets) |
| Hold database ([#149](https://github.com/DevMortimer/pi-warden/pull/149)) | A copy of 52,362 rows shrinks from 285.9 MiB to 41.6 MiB | [Data handling](docs/data-handling.md#what-stays-on-this-machine) |

Features that did not earn their cost did not ship: the working-memory pruning, the stale-result stubs, and a hybrid compaction failed their gates, and the off-task and should-proceed steers stay trace-only. The numbers are in the [Calibration](docs/guards.md#calibration) section.

## Rules no linter can check

```markdown
# A TODO names a ticket
A bare `TODO` or `FIXME` without a ticket reference is a violation.

# Errors never reach the user raw
paths: src/api/**/*.ts
Catch errors at the handler and return a message a user can act on.
```

Each `#` heading is one rule. Every write and edit is judged against it in about a quarter of a second by [Jev](https://typesafe.ai), a model that returns a probability, not prose. No `pi-warden.md`? Your `AGENTS.md`, `CLAUDE.md`, or `README.md` is used instead.

Coming from 0.74.1? See [Upgrading](docs/upgrading.md).

## Receipts

- **Rules:** in 150 paired agent runs (four batches, `eval/reports/2026-09-18T00-*`), the agent without pi-warden broke a project rule in **6** of 150 runs. With it: **0** of 150.
- **Done-check:** after a nudge, the agent ran a check **94 of 124** times, and sometimes found a failure it had missed.
- **Holds:** when the agent was stopped, it found a safer way **79 of 111** times; you approved 29. Field data from 2026-09-16 to 2026-10-01, across versions, so it includes holds from before the 0.9 threshold and the `rm` scratch change.
- **Stability:** 13,952 guard cases over 109 overnight cycles, no score drift.

Every number has a script and a raw report in [`eval/reports/`](eval/reports/) or the Calibration section of [the guard docs](docs/guards.md#calibration). They are the maintainer's measurements, not a universal promise, and the reports list what was noise.

## How the defaults are chosen

Thresholds are set on recorded sessions. Where the data allows, a threshold is chosen on one half of the corpus and checked on the other. A feature that measured worse ships off or trace-only. [Calibration →](docs/guards.md#calibration)

- **Irreversible hold at 0.9** (0.75.0). On 15,346 judged calls the judge was wrong on 15% of calls below confidence 0.8 and under 1% above it. A 0.9 cutoff chosen on one half removed about 52 false alarms on the other half and lost no true catch. Scores from 0.5 to 0.9 now warn.
- **Intent steer in the trace only** (0.76.0). The score separates a differing call (AUROC 0.815 on 140 calls labelled blind to the score), but 36 of the 37 steers it would send were for calls the plan or your request had asked for.
- **Failed gates stay off.** Pruning stale tool results had a safe point in 10 of 1,042 recorded sessions (median saving 0.00%); a hybrid compaction kept 5 of the 34 re-read files where the gate asked for 10; the working-memory gate's best cut dropped 23.5% of candidates and missed 12.8% where the gate allowed 10%; and no slice of the off-task or should-proceed steers reached 0.80 precision. Each is recorded in [Calibration](docs/guards.md#calibration).
- **Relevance compaction off** (0.78.0). In a replay of 48 recorded compactions its summary was 4.7 times the size of Pi's at the median and kept whole only 1 of the 34 files the agent read again.

## Privacy

Secrets and unshown paths are stripped before anything leaves your machine. The offline guards send nothing. The opt-in features send more when you turn them on: the context filter sends a large output whole, redacted, in chunks; relevance compaction sends an outline of the conversation and a sample of each tool result. [Exactly what is sent →](docs/data-handling.md)

## Credits

- **Confidence bands for the irreversible hold:** Li, Miao, Krishnan, Padman, "JEV-as-a-Judge: Accept When Confident, Escalate When Unsure", [arXiv:2609.26550](https://arxiv.org/abs/2609.26550).
- **Chunk scoring in the context filter:** GPT Researcher's [context filter](https://docs.gptr.dev/docs/gpt-researcher/gptr/context-filter).
- **The judge:** [Jev](https://typesafe.ai) by TypeSafe.

## Versioning

From 1.0, pi-warden follows semver for: the documented config keys and their defaults (except `compaction.*`, `context.filter.*`, `conscience.*`, and `action.shouldProceed.steer`, which are experimental or beta); the `/warden` commands and their arguments; the `warden_remember`, `warden_loops`, and `warden_recall` tools; the documented `PI_WARDEN_*` environment variables; the widget template tokens; and the exports named in [docs/extension-authors.md](docs/extension-authors.md). The trace file format, the files in pi-warden's data folder, session message types, and every other export are internal and may change in any release.

## Docs

[Guards](docs/guards.md) · [Configuration](docs/configuration.md) · [Commands](docs/commands.md) · [FAQ](docs/faq.md) · [Data handling](docs/data-handling.md) · [Examples](docs/examples.md)

## Development

```bash
npm install
npm run check        # typecheck + offline tests + build
```

MIT licensed.
