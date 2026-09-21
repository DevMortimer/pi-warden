# Action guard calibration on real sessions, 2026-09-21

Guard version 0.33.3 (`501bf72`) · floor mode `evidence` · judge `jev-1.13.0` (16,698 of 16,709
requests answered by it) · replayed 2026-09-21 · about $3.30 at the listed $0.042/MTok.

Command: `node scripts/calibrate-action.mjs --project DIR --extra --yes --max-requests 25000`, run
for four project directories in turn, then `--report FILE` per run. `--extra` adds the candidate
questions of `scripts/action-candidates.mjs` to every replay.

Every guarded call in the recorded sessions of a project is replayed through `evaluateAction` with
the prompt, context, and plan it had at the time. The user's next message labels the turn: one
request per turn asks the judge whether that message regrets one of the calls that ran (and which),
whether it approves each call the guard held live, and how it receives the turn.

## Findings

**1. The holds and the regrets are disjoint sets.** Under the shipped defaults the guard would hold
48 of the 18,075 calls that ran; the user regretted 27 of them; no call is in both sets. Precision
and recall of the hold rule against regret are therefore 0% and 0%, in each of the four projects
separately and at every `irreversible` threshold from 0.6 up. Only 0.3 to 0.5 catch any regretted
call at all — 3, 2, and 1 of 27 — at 1% precision and 298, 182, and 113 holds. The label base is
thin: 27 positives over 18,075 calls, 0.15%, so read this as "the hold rule is not aimed at what
users complain about", not as a measured failure rate.

**2. Two candidate questions outperform the shipped hold signal at naming the regretted call.**
AUC against regret over the same 15,232 judged calls with 26 positives: `visible` 0.80,
`consult_first` 0.77, `irreversible` 0.73, `should_proceed` read as `1 - p` 0.75, `off_task` 0.51.
The signal the hold rule runs on, `irreversible`, ranks below both candidates, and the signal that
once gated holds, `off_task`, is at chance.

**3. Live hold quality fell.** Of the 119 holds these recordings contain, the user's next message
approved 43 (36%); on 17 September it was 5 of 43 (12%). It is concentrated in millia: 22 of 34
holds approved there against 21 of 84 in pi-warden. These sessions were recorded under 0.29 to 0.32
behaviour, before the floor became evidence in 0.33.0, so the figure measures the guard the user
lived with, not the guard measured in the rest of this report.

A known limit, not a finding: 11 replays of 16,709 (0.07%) failed the TypeSafe limit of 32 questions
per request, hit where `--extra` questions meet a call with many held siblings.

## 1. Corpus and spend

| project | sessions | labelled turns | guarded calls | judged replays | read-only (free) | requests |
| --- | --- | --- | --- | --- | --- | --- |
| pi-warden | 128 | 531 | 7267 | 5618 | 1560 | 6238 |
| millia | 176 | 787 | 10551 | 9322 | 1189 | 10149 |
| pi-typesafe | 7 | 21 | 282 | 225 | 56 | 247 |
| pi-tiny-search | 4 | 8 | 95 | 67 | 28 | 75 |
| **combined** | **315** | **1347** | **18195** | **15232** | **2833** | **16709** |

Input tokens, measured per completed process: pi-warden 15.26M (4238 requests, resumed), millia
46.15M (8142, resumed), pi-typesafe 1.33M, pi-tiny-search 0.26M — 63.0M over 12,702 requests. The
first attempt made the other 4,007 requests before it stopped at the default request cap; 5.24M of
its tokens are in the spend ledger and the rest (about 1,870 requests, about 11M tokens at millia's
measured 5.7k tokens per request) are not, because that process was stopped before it wrote its
ledger entry. Voyage total: **16,709 requests, about 79M input tokens, about $3.30.**

Label errors: none. Replay errors: 11 of 16,709 requests (0.07%), all of them the TypeSafe limit of
32 questions per request, hit on calls that carry many held siblings alongside the `--extra`
questions.

## 2. Hold rate under the shipped defaults (irreversible 0.7, off-task holding disabled)

| project | ran calls | holds the guard would produce | hold rate | by pattern | by irreversible | by off-task | held live | replay agrees |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi-warden | 7182 | 18 | 0.25% | 4 | 14 | 0 | 84 | 32 |
| millia | 10517 | 30 | 0.29% | 21 | 9 | 0 | 34 | 15 |
| pi-typesafe | 281 | 0 | 0% | 0 | 0 | 0 | 1 | 0 |
| pi-tiny-search | 95 | 0 | 0% | 0 | 0 | 0 | 0 | — |
| **combined** | **18075** | **48** | **0.27%** | **25** | **23** | **0** | **119** | **47** |

Holds made live, judged by the user's next message:

| project | holds in the recording | approved by the user (false positive) | hold stood |
| --- | --- | --- | --- |
| pi-warden | 84 | 21 (25%) | 63 |
| millia | 34 | 22 (65%) | 12 |
| pi-typesafe | 1 | 0 | 1 |
| **combined** | **119** | **43 (36%)** | **76** |

How the user received a turn the replay would hold under the defaults (combined): continues 32,
corrects 11, rejects 0, unrelated 5.

## 3. Precision and recall of the hold rule against regret

Positives — a call that ran and whose regret the user's next message names — are rare: pi-warden 10
of 7182 ran calls, millia 16 of 10517, pi-typesafe 1 of 281, pi-tiny-search 0 of 95;
**27 of 18075 combined (0.15%)**, in 2% of turns.

Combined at the shipped defaults: 48 holds, TP 0, FP 48, FN 27 — **precision 0%, recall 0%.** The
same in every project: the set of calls the guard holds and the set the user regrets do not
intersect.

## 4. AUC against regret, with n

| signal | pi-warden (n=5618, 9 pos) | millia (n=9322, 16 pos) | pi-typesafe (n=225, 1 pos) | pi-tiny-search (n=67, 0 pos) | combined (n=15232, 26 pos) |
| --- | --- | --- | --- | --- | --- |
| `irreversible` | 0.73 | 0.74 | 0.50 | — | **0.73** |
| `off_task` | 0.56 | 0.46 | 0.86 | — | **0.51** |
| `off_task` gated (unrelated & can change) | 0.51 | 0.52 | 0.40 | — | **0.51** |
| max(`irreversible`, gated `off_task`) | 0.70 | 0.72 | 0.45 | — | **0.70** |
| `intent_mismatch` (calls with a plan) | 0.55 (n=4679, 5 pos) | 0.55 (n=7711, 14 pos) | 0.63 (n=184, 1 pos) | — (n=62) | **0.56** (n=12636, 20 pos) |
| `mutates` | 0.72 | 0.71 | 0.89 | — | **0.72** |

Candidate questions carried by every judged replay (`--extra`):

| question | pi-warden (9 pos) | millia (16 pos) | pi-typesafe (1 pos) | combined (n=15232, 26 pos) | combined rejected / rejected-or-corrected |
| --- | --- | --- | --- | --- | --- |
| `unrequested` | 0.76 | 0.64 | 0.63 | **0.68** | 0.51 / 0.51 |
| `consult_first` | 0.86 | 0.73 | 0.88 | **0.77** | 0.45 / 0.52 |
| `visible` | 0.85 | 0.80 | 0.40 | **0.80** | 0.48 / 0.51 |
| `pause_requested` | 0.51 | 0.50 | 0.87 | **0.52** | 0.59 / 0.58 |
| `violation_judgment` | 0.74 | 0.68 | 0.95 | **0.70** | 0.42 / 0.52 |
| `should_proceed` | 0.13 | 0.32 | 0.18 | **0.25** | 0.55 / 0.49 |
| `approval_broadened` | 0.51 | 0.56 | 0.63 | **0.54** | 0.45 / 0.49 |

pi-tiny-search has no positives and therefore no regret AUC; its other figures rest on one turn.
`should_proceed` runs in the direction `docs/guards.md` records: read as `1 - should_proceed` it
scores 0.75, on a par with `irreversible`. Its operating point is the problem, not its direction —
at 0.6 it flagged 44% of calls, which is why it stays trace-only.

`--extra` holds seven questions and none of them is a tool-recommendation question; that question
does not exist in the tree yet and is therefore unmeasured here.

## 5. The `irreversible` threshold, combined

Off-task holding disabled, as shipped:

| `irreversible` >= | holds | hold rate | TP | FP | FN | precision | recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.3 | 298 | 2% | 3 | 295 | 24 | 1% | 11% |
| 0.4 | 182 | 1% | 2 | 180 | 25 | 1% | 7% |
| 0.5 | 113 | 1% | 1 | 112 | 26 | 1% | 4% |
| 0.6 | 71 | 0.4% | 0 | 71 | 27 | 0% | 0% |
| **0.7 (shipped)** | **48** | **0.27%** | **0** | **48** | **27** | **0%** | **0%** |
| 0.8 | 29 | 0.2% | 0 | 29 | 27 | 0% | 0% |
| 0.9 | 25 | 0.1% | 0 | 25 | 27 | 0% | 0% |
| 0.95 | 25 | 0.1% | 0 | 25 | 27 | 0% | 0% |

Per project, holds / TP:

| `irreversible` >= | pi-warden | millia | pi-typesafe | pi-tiny-search |
| --- | --- | --- | --- | --- |
| 0.3 | 91 / 1 | 206 / 2 | 1 / 0 | 0 / 0 |
| 0.4 | 53 / 1 | 129 / 1 | 0 / 0 | 0 / 0 |
| 0.5 | 34 / 0 | 79 / 1 | 0 / 0 | 0 / 0 |
| 0.6 | 24 / 0 | 47 / 0 | 0 / 0 | 0 / 0 |
| 0.7 | 18 / 0 | 30 / 0 | 0 / 0 | 0 / 0 |
| 0.8 | 8 / 0 | 21 / 0 | 0 / 0 | 0 / 0 |
| 0.9 | 4 / 0 | 21 / 0 | 0 / 0 | 0 / 0 |

Moving the default from 0.7 to 0.6 adds 23 holds over 18,075 calls and catches nothing the user
regretted. Only 0.3 to 0.5 ever catch a regretted call, at 1% precision and at most 11% recall. The
report's own verdict for every signal is `recommended: none (no threshold clears the floors)`.

If off-task holding were re-enabled (irreversible fixed at 0.7, combined): 0.5 gives 970 holds (5%),
0.7 gives 300 (2%), 0.85 gives 93 (1%), 0.9 gives 52 (0.3%), with at most 1 true positive anywhere.

The intent-mismatch steer, combined over 6080 judged calls that have a plan and can change
something (baseline: 3% sit in a rejected turn, 19% in a rejected-or-corrected turn): the shipped
rule — `intent_mismatch >= 0.9`, or `visible >= 0.8` with `intent_mismatch >= 0.8` — steers 269
calls (4%), of which 3 were regretted, 10 (4%) sat in a rejected turn and 65 (24%) in a
rejected-or-corrected turn.

## 6. Against the 2026-09-17 run

The 17 September run covered 1085 turns and 17,117 ran calls over more projects; this one covers
1347 turns and 18,075 ran calls over four. The hold rate is the visible move: 139 holds (1%) then,
48 (0.27%) now, because off-task holding is disabled in 0.33.3 — the 56 holds that off-task alone
produced are gone, pattern holds fell from 77 to 25, and holds by irreversible alone rose from 6 to
23. Precision
and recall were 0% and 0% then and are 0% and 0% now; no threshold in either run puts a hold on a
call the user went on to regret. `irreversible` drifted up (0.71 to 0.73), `off_task` stayed at
chance (0.51), `intent_mismatch` is unchanged (0.57 to 0.56), `mutates` slipped (0.75 to 0.72).
Candidate questions moved little where they are comparable (`consult_first` 0.77 to 0.77, `visible`
0.82 to 0.80, `unrequested` 0.65 to 0.68, `pause_requested` 0.50 to 0.52); `violation_judgment`
(0.70), `approval_broadened` (0.54), and `should_proceed` (0.25) are new to a full run. The one
regression is live hold quality: the user approved 5 of 43 recorded holds on 17 September (12%) and
43 of 119 here (36%), concentrated in millia (22 of 34, 65%).

## 7. Caveats

- 27 positives over 18,075 calls is a thin label base. Every precision and recall figure rests on
  it, and AUC on 26 positives has wide error bars. Per-project differences under 0.1 are noise, and
  the two small projects are anecdote.
- The runs were made before the flag fix that ships on this branch: `--yes` then permitted a large
  run without raising the 2000-request cap, so the first attempt stopped at the cap and printed a
  full-looking report over truncated data. Both files were resumed with `--max-requests 25000` and
  no requests were wasted. `--yes` now spends what the corpus needs, and a run stopped by an
  explicit `--max-requests` says so and writes `report-latest-partial.md`.
- Adding another `--extra` question will make the 32-question per-request limit bite more often.

## 8. Data files

`combined.report.txt` and one `<project>.report.txt` per project sit beside this file: the
`--report` output with every per-call example line removed. See `README.md` in this folder.
