# Field usage, 2026-09-16 to 2026-10-01

What pi-warden did during sixteen days of the maintainer's own work across all their projects: several coding agents running in parallel in a handful of repositories, this one included. The data is not a benchmark. It is everything pi-warden logged while it was used for real. It replaces the [2026-09-24 report](../2026-09-24-field-usage/README.md) as the source of the README numbers.

- Produced by: `node scripts/field-usage.mjs --since 2026-09-16T00:00:00+08:00 --until 2026-10-02T00:00:00+08:00 --json`
- Raw numbers: [`usage.json`](usage.json). Aggregate counts only: no session text, paths, project names, or rule names (the rules come from private projects, so each rule is a count).
- pi-warden versions: whatever was installed as each release landed, from before 0.56 to 0.89.0.

## Totals

| | |
| --- | --- |
| Sessions | 1,168 |
| `bash` calls | 70,599 |
| Actions judged by the action guard | 53,868 |
| Held before running | 419 (0.8%) |
| Steers sent to the agent | 1,834 |
| Oversized tool outputs replaced by an excerpt | 457 |

## What worked

**The done-check changes behaviour.** It nudged 124 times when an agent said it was done with no passing test, build, or lint behind the claim. In 94 of those (76%), the agent's next few calls ran a check.

**Holds were cheap and usually right about the action.** 419 of 53,868 judged actions were held. Of the 111 holds with a recorded outcome, the agent took a safer route 79 times, the user approved 29, and declined 3. The held actions included 25 `git reset --hard` and 14 force pushes.

**The rules guard catches what no linter checks.** 422 steers named a project rule, spread over 41 rules.

## What was noise

**Deleting its own scratch.** 283 of the 419 holds were recursive deletes of an absolute or temp path, mostly agents cleaning up scratch they had just made. In the last seven days the share was 172 of 199. The scratch-precision changes (0.82.0 and later) landed during and after this window; the share is not re-measured here.

**Credential notices on code.** 400 notices, all of them before 2026-09-25. None were sent from 2026-09-25 to 2026-10-01. Later changes (0.83.0) also keep masking away from code values such as a call or a variable name.

**The conscience mostly names tools the agent already uses.** 265 recommendations: 146 named a core tool (`read`, `bash`, `search_code`), 25 named another tool, and 94 named a skill.

## Steer classes

`scripts/field-usage.mjs` sorts each steer by its text. Before this report, 239 of the 1,834 steers (13.0%) fell into "other"; in the last seven days it was 152 of 473 (32.1%), because the classifier did not know the stuck-loop, off-task, security-weakness, open-loop, subagent, repeat-note, action-warning, and tool-or-skill reminder messages, nor the turn-rules message for a change made by a command. After adding them, 10 of 1,834 are "other" (0.5%); in the last seven days, 5 of 473 (1.1%).

| Class | Steers, 2026-09-16 to 2026-10-01 |
| --- | --- |
| rules | 422 |
| credential notice | 400 |
| intent mismatch | 397 |
| slop | 125 |
| done-check | 124 |
| stuck | 89 |
| open loops | 86 |
| needs user input | 59 |
| off-task | 25 |
| tool or skill reminder | 24 |
| prose trend | 22 |
| security | 16 |
| prompt injection | 14 |
| other | 10 |
| repeat note | 9 |
| action warning | 6 |
| runaway | 3 |
| subagent report | 3 |

Intent-mismatch and off-task notices appear here as steers only while a version sent them to the agent; from 0.76.0 the intent steer is trace-only by default, and the off-task notice is trace-only as well.

## Method and limits

- Session logs and the local holds database, read by `scripts/field-usage.mjs`. The script also runs on your own logs.
- "Followed by a check" means one of the agent's next four messages ran a verification command. It does not prove the nudge caused the check.
- All ratios are counts, not labels.
- 308 of the 419 holds have no recorded outcome.
- One maintainer, one machine, sixteen days of fast-changing versions. Read it as field evidence, not as a benchmark.
