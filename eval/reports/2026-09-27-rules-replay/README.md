# Rules replay, first run

`scripts/rules-replay.mjs` (`npm run eval:replay`) judges the `write` and `edit` calls of past Pi sessions against a
project's current rules: each call's content is rebuilt from the session log and sent to `evaluateRules` in the request
the guard builds, one request per call. This is the first run, on this repository's own sessions, with a hard budget of
150 requests. This folder holds the aggregates only (`aggregates.json`); the review sheet is not part of the report.

| Aggregate | Count |
| --- | --- |
| sessions | 191 |
| calls found | 2620 |
| rebuilt | 817 |
| unrebuilt (skipped) | 1455 |
| calls outside the project | 348 |
| judged | 150 |
| flagged | 11 |
| judge errors | 0 |
| requests spent | 150 of 150 |

Unrebuilt calls are edits whose content before the call the log does not show: 1413 with unknown content, 36 whose old
text is not found or not unique, 4 without edits, 2 with empty old text. They are skipped and counted, never judged.
Another 665 rebuilt calls were past the budget and not judged.

Flagged per rule id (a call can flag several rules):

| Rule | Flagged calls |
| --- | --- |
| `no-partial-implementations` | 4 |
| `nothing-that-leaves-the-machine-carries-a-secret-or-unshown-path` | 4 |
| `errors-are-not-swallowed` | 3 |
| `a-new-jev-question-ships-with-a-measurement` | 1 |
| `steers-never-hold` | 1 |

## Labels

The review sheet — every flagged call plus an equal-sized random sample of unflagged calls (fixed seed), each with the
file, a short excerpt, the score, and an empty `label` — is written outside the repository under the system temp
directory and is never committed. An independent reviewer labels each item `real`, `false-alarm`, or `unsure`, and
`npm run eval:replay -- --score <sheet>` then reports precision over the flagged items and the miss rate estimated from
the unflagged sample. Until those labels arrive the run is **unlabelled**: the counts above say how often the guard
flagged, not how often it was right.
