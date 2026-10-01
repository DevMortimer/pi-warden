# Field usage, 2026-09-16 to 2026-09-24

What pi-warden did during nine days of the maintainer's own work across all their projects: several coding agents running in parallel in a handful of repositories, this one included. The data is not a benchmark. It is everything pi-warden logged while it was used for real.

- Produced by: `node scripts/field-usage.mjs --since 2026-09-16T00:00:00+08:00 --until 2026-09-25T00:00:00+08:00 --json`
- Raw numbers: [`usage.json`](usage.json). Aggregate counts only: no session text, paths, project names, or rule names (the rules come from private projects, so each rule is a count).
- pi-warden versions: from the first release to 0.56, as the releases landed.

## Totals

| | |
| --- | --- |
| Sessions | 759 |
| `bash` calls | 37,865 |
| Actions judged by the action guard | 23,664 |
| Held before running | 220 (0.9%) |
| Steers sent to the agent | 1,356 |
| Oversized tool outputs replaced by an excerpt | 298 |

## What worked

**The done-check changes behaviour.** It nudged 75 times when an agent said it was done with no passing test, build, or lint behind the claim. In 57 of those (76%), the agent's next few calls ran a check.

**Holds were cheap and usually right about the action.** 220 of 23,664 judged actions were held. Of the 65 holds with a recorded outcome, the agent took a safer route 40 times, the user approved 24, and declined 1. The held actions included 18 `git reset --hard` and 14 force pushes.

**The rules guard catches what no linter checks.** 349 steers named a project rule, spread over 36 rules. Examples:

- a process wait with no timeout ("Waits are bounded")
- a home-directory path committed into a public test fixture
- a new judge question with no measurement ("A new Jev question ships with a measurement"), 31 times

## What was noise, and what changed

**Deleting its own scratch.** 111 of the 220 holds were recursive deletes of an absolute or temp path, mostly agents cleaning up scratch they had just made. 0.47.0 lets an agent delete temp-directory scratch it created in the same session (macOS and Windows).

**Credential notices on code.** 400 notices, most after reading source, tests, or data scans that hold no secret: variable names, redacted values, token counts. 0.44.1 attaches the notice to the tool result and ignores placeholders, plain numbers, and code identifiers. Not yet re-measured.

**Some rules were too broad.** The two rules that fired most (56 times each) were a version-bump rule that often fired on ordinary changelog edits, and a prose-style rule. A rule about secrets and unshown paths fired 51 times, many on files outside the project that never leave the machine; 0.42.0 stops judging files outside the project or ignored by git.

**Intent mismatch is useful but noisy.** 287 notices. In a labelled sample of 14 (the report does not record who labelled it) from the last four days, about half caught a real gap between what the agent said and what it did, for example "Staging only those two:" followed by `git push`. The rest fired where the agent had stated no plan.

**The conscience mostly names tools the agent already uses.** 132 recommendations: 103 named a core tool (`read`, `bash`, `search_code`), and 22 named a skill.

**"Needs user input".** 59 steers, before that check became trace-only.

## Method and limits

- Session logs and the local holds database, read by `scripts/field-usage.mjs`. The script also runs on your own logs.
- "Followed by a check" means one of the agent's next four messages ran a verification command. It does not prove the nudge caused the check.
- The intent-mismatch split comes from a labelled sample of 14; the report does not record who labelled it. The other ratios are counts, not labels.
- 155 of the 220 holds have no recorded outcome.
- One maintainer, one machine, nine days of fast-changing versions. Read it as field evidence, not as a benchmark.
