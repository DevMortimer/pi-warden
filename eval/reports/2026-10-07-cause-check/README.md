# Cause-check pre-filter, 2026-09-16 to 2026-10-07

How often the cause-check's offline pre-filter flags a final reply, measured on recorded sessions before the guard ever ran. The pre-filter is the cheap first stage. A flagged reply still goes to Jev, which decides whether it states a cause or hands a check to a person and whether the run checked it. This report measures the first stage only.

- Produced by: `node scripts/cause-replay.mjs --since 2026-09-16 --until 2026-10-08 --json`
- Raw numbers: the command's JSON output. Aggregate counts only: no session text, paths, project names, or branch names.
- Sample: 20 flagged replies, passed through `redact()` and cut to 200 characters, written outside the repository. They are not reproduced here.

## Totals

| | |
| --- | --- |
| Sessions | 1,544 |
| Final replies | 6,934 |
| Flagged by the pre-filter | 934 (13.5%) |

## Sample

A deterministic spread of 20 flagged replies was judged by hand:

| Call | Replies |
| --- | --- |
| Real unchecked cause | 4 |
| Not a real unchecked cause | 16 |

The four real replies: one hand-off that asked the user to confirm a CI lane the agent could check itself, one reply that named a likely cause and said it was not proven, one causal guess about a sign-in failure, and one causal guess that a message never reached its recipient. The 16 others were status reports, plans, and completed work that happened to contain a causal word (a source key that "points to" an entry, a reason named in passing, a "probably" in a sentence that was not a diagnosis).

## Method and limits

- Final replies are assistant messages with text that ended a run normally (`stopReason: "stop"`), read from the recorded session logs under the agent directory. Every log in the window was read; nothing was sent anywhere.
- The pre-filter is deliberately broad, so the Jev answer can reject the false positives. This report does not measure the Jev stage, and it does not measure whether a steer changed what the agent did next.
- One maintainer, one machine, three weeks of sessions that are mostly status reports and planning turns. The share of real unchecked causes will differ on other work.
