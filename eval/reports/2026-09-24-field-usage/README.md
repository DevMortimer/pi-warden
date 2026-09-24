# Field usage, 2026-09-21 to 2026-09-24

What pi-warden did during four days of the maintainer's own work: several coding agents running in parallel across a handful of repositories, including this one. The data is not a benchmark. It is everything pi-warden logged while it was used for real.

- Produced by: `node scripts/field-usage.mjs --since 2026-09-21T00:00:00+08:00 --until 2026-09-24T17:00:00+08:00 --json`
- Raw numbers: [`usage.json`](usage.json). Aggregate counts only; no session text, paths, or project names.
- pi-warden versions: 0.33 to 0.47, as the week's releases landed.

## Totals

| | |
| --- | --- |
| Sessions | 397 |
| `bash` calls | 20,574 |
| Actions judged by the action guard | 19,695 |
| Held before running | 143 (0.7%) |
| Steers sent to the agent | 624 |
| Oversized tool outputs replaced by an excerpt | 143 |

## What worked

**The done-check changes behaviour.** It nudged 47 times when an agent said it was done with no passing test, build, or lint behind the claim. In 35 of those (74%), the agent's next few calls ran a check.

**Holds were cheap and usually right about the action.** 143 of 19,695 judged actions were held. Of the 44 holds with a recorded outcome, the agent took a safer route 33 times, the user approved 10, and declined 1. Every `git reset --hard` and force-push hold was a real irreversible action.

**The rules guard catches what no linter checks.** 195 steers named a project rule. Examples from the week:

- a process wait with no timeout ("Waits are bounded")
- a home-directory path committed into a public test fixture ("Public text has no local traces")
- a new judge question with no measurement ("A new Jev question ships with a measurement"), 16 times; it was right

**The context saver kept excerpts good enough.** In the 32 sessions with a trace file, 33 large outputs were compressed and about 123,000 tokens removed, and no agent went back to read a full output.

## What was noise, and what changed

**Deleting its own scratch.** 94 of the 143 holds were recursive deletes under the temp directory, mostly agents cleaning up scratch they had just made. 0.47.0 lets an agent delete temp-directory scratch it created in the same session (macOS and Windows).

**Credential notices on code.** 105 notices, most after reading source, tests, or data scans that hold no secret: variable names like `secretIds`, redacted values, token counts. Each one also cost the agent an extra turn. 0.44.1 attaches the notice to the tool result and ignores placeholders, plain numbers, and code identifiers. Not yet re-measured.

**Some rules were too broad.**

- "Nothing that leaves the machine carries a secret or unshown path" fired 36 times on files outside the project that never leave the machine. 0.42.0 stops judging files outside the project or ignored by git.
- "Do not bump version in a feature or fix commit" fired 42 times, often on ordinary changelog edits. The rule's wording is being tightened.

**Intent mismatch is useful but noisy.** 160 notices. In a sample of 14, about half caught a real gap between what the agent said and what it did, for example "Staging only those two:" followed by `git push`. The rest fired where the agent had stated no plan. Each notice also arrives as its own turn. Both are being changed.

**The conscience mostly names tools the agent already uses.** 70 recommendations. 55 of them named a core tool (`read`, `bash`, `search_code`), and 13 named a skill.

**"Needs user input".** 47 steers. All of them fired on the first morning, before that check became trace-only.

## Method and limits

- Session logs and the local holds database, read by `scripts/field-usage.mjs`. The script also runs on your own logs.
- "Followed by a check" means one of the agent's next four messages ran a verification command. It does not prove the nudge caused the check.
- The intent-mismatch split comes from a hand-labelled sample of 14. The other ratios are counts, not labels.
- 99 of the 143 holds have no recorded outcome.
- One maintainer, one machine, one week of fast-changing versions. Read it as field evidence, not as a benchmark.
