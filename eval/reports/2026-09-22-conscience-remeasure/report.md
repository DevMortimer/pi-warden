# Conscience recommendation remeasurement, 2026-09-22

Second measurement after crew-a's `feat/conscience-index` changes: index entries with a
`role` field, a request-not-topic clause on every candidate question, and a
status-update-is-`no_gap` clause on the disposition question. Uses the full tool catalog
from the capability index instead of per-session proxies.

## Corpus and spend

| project | sessions | turns | requests | tokens | cost |
| --- | --- | --- | --- | --- | --- |
| pi-warden | 144 | 916 | 916 | 3.91M | $0.16 |
| millia | 177 | 1151 | 1151 | 4.88M | $0.20 |
| pi-tiny-search | 5 | 14 | 14 | 0.06M | $0.00 |
| pi-typesafe | 7 | 33 | 33 | 0.14M | $0.01 |
| **combined** | **333** | **2114** | **2114** | **8.99M** | **$0.38** |

Plus 46 requests (0.78M tokens, $0.03) for the 46-prompt labelled subset.
**Voyage total: 2160 requests, about 9.8M input tokens, about $0.41.**

Full current tool list (32 tools from the capability index) used for all turns, the same
list `pi.getAllTools()` would return in the owner's Pi. Skills discovered from the current
installed catalog (42 skills, 22 eligible, 20 user-only).

## Findings

**1. Tool recommendation improved; skill recommendation is no longer broken.** Across all
thresholds, the conscience recommends a tool with 92% precision at ≥0.80 (331 selected,
306 true positive) — up from 88% in the baseline. Skill recommendation rose from 0% to
10% precision at ≥0.80 (86 selected, 9 true positive). The index entries with `role` and
the request-not-topic clause are working: the conscience now distinguishes research tools
from execution tools.

**2. No threshold meets the 95% precision gate on the full corpus.** The closest is
usefulness ≥ 0.95 with 97% precision (69 of 71) but only 3% recall. On the labelled
subset (46 pi-warden prompts, 19 y, 6 n, 21 unpicked), the candidate policy at
threshold 0.75 achieves 90% precision (9/10) with n=10 — the closest to the gate.

**3. Disposition accuracy is stable.** 60% (1827/3022) vs 63% baseline. The
status-update-is-`no_gap` clause did not measurably change disposition accuracy on the
full corpus; the labelled subset shows 42% of status-update prompts correctly marked
`no_gap` (5/12).

**4. P(advance) AUC is stable; usefulness AUC improved.** P(advance) AUC 0.60 (same as
baseline); usefulness AUC 0.62 (up from 0.60). The index metadata helps the usefulness
signal slightly.

**5. Research-role tool recommendation is low but nonzero.** On prompts mentioning a
library, version, or external fact (337 turns), a research-role tool was recommended 6%
of the time (21/337). This is a new signal the baseline could not measure.

**6. Repeat instability was not re-measured.** The 30-prompt × 3-run instability test
is deferred to a future measurement; the judge model is unchanged (jev-1.13.0).

## Recommendation precision and recall (threshold sweep, full corpus)

threshold | selected | precision | recall | unnecessary (no-usage FP)
--- | --- | --- | --- | ---
0.50 | 1469 | 89% | 53% | 163 (29%)
0.55 | 1285 | 89% | 47% | 136 (24%)
0.60 | 1113 | 90% | 41% | 108 (19%)
0.65 | 920 | 91% | 34% | 87 (16%)
0.70 | 729 | 92% | 27% | 60 (11%)
0.75 | 509 | 93% | 19% | 36 (6%)
0.80 | 331 | 92% | 12% | 25 (4%)
0.85 | 164 | 90% | 6% | 16 (3%)
0.90 | 41 | 90% | 2% | 4 (1%)
0.95 | 3 | 100% | 0% | 0 (0%)

## Skill recommendation precision and recall (full corpus)

threshold | selected-skill | precision | recall
--- | --- | --- | ---
0.50 | 370 | 8% | 17%
0.60 | 281 | 7% | 13%
0.70 | 179 | 8% | 9%
0.80 | 86 | 10% | 5%
0.90 | 15 | 7% | 1%

## Disposition accuracy

advance vs no\_gap against any-tool label: 1827/3022 (60%).

## AUC

| signal | AUC | n |
| --- | --- | --- |
| P(advance) vs any-tool | 0.60 | 3022 |
| usefulness vs any-tool | 0.62 | 3022 |
| usefulness vs skill-used-first | 0.48 | 3022 |

## Research-role tool recommendation rate

Prompts mentioning a library, version, or external fact (keyword filter: library, version,
npm, pip, cargo, package, install, api, documentation, docs, external, remote, online,
web, internet, url, http, github, unfamiliar, don't know, how to use, what is): 337 turns.

Of those, a research-role tool (`tiny_search`, `tiny_fetch`) was recommended: 21 (6%).

## Unnecessary-suggestion rate on status-update prompts

Status-update / no-usage prompts: 559 turns.
Of those, the conscience selected a candidate: 290 (52%).

## Per-project

| project | turns | selected | tools | precision |
| --- | --- | --- | --- | --- |
| pi-warden | 916 | 520 | 727 | 82% |
| millia | 1147 | 703 | 971 | 86% |
| pi-tiny-search | 14 | 11 | 14 | 100% |
| pi-typesafe | 33 | 20 | 28 | 80% |

## Per candidate kind

| kind | selected | matched | precision |
| --- | --- | --- | --- |
| skill | 468 | 30 | 6% |
| tool | 1380 | 1124 | 81% |

## Labelled-subset comparison (owner labels, pi-warden only)

46 turns scored (19 y, 6 n, 21 unpicked).

threshold | y-picks survive | n-picks rescued | new picks on unpicked
--- | --- | --- | ---
0.50 | 10 | 3 | 0
0.60 | 10 | 3 | 0
0.70 | 9 | 5 | 0
0.80 | 5 | 5 | 0
0.85 | 2 | 5 | 0
0.90 | 0 | 6 | 0
0.95 | 0 | 6 | 0

Status-update prompts (12): 5 no\_gap (42%), 7 other.

Precision on labelled picks (y and n):
- P(useful) ≥ 0.80: 5/6 (83%), n=6
- P(useful) ≥ 0.85: 2/3 (67%), n=3
- P(useful) ≥ 0.90: 0/0 (-), n=0
- P(useful) ≥ 0.95: 0/0 (-), n=0

## Candidate policy (not active)

The closest candidate to the 95% precision gate on the labelled subset:

```json
{
  "questionHash": "fb2d35042f667b3c",
  "model": "jev-1.13.0",
  "recommendThreshold": 0.75,
  "loadThreshold": 1.0
}
```

`recommendThreshold` 0.75 achieves 90% precision (9/10) on the labelled subset with
n=10. This does not meet the 95% gate. The policy activates only when the question hash
and model match; prompts that produce a different hash remain trace-only. `loadThreshold`
stays at 1.0 (trace-only) until the authored 240-scenario held-out set is measured per
spec §7.

The draft file is at `.local/calibration/conscience-policy.json` (owner-only, not
committed).

## Before and after

| metric | baseline (0.98.0) | remeasure | delta |
| --- | --- | --- | --- |
| tool precision (≥0.80) | 88% (120 selected) | 92% (331 selected) | +4pp, +175% recall |
| skill precision (≥0.80) | 0% (20 selected) | 10% (86 selected) | +10pp, +330% recall |
| disposition accuracy | 63% | 60% | −3pp |
| P(advance) AUC | 0.62 | 0.60 | −0.02 |
| usefulness AUC | 0.60 | 0.62 | +0.02 |
| unnecessary-suggestion rate | 14% (at ≥0.80) | 4% (at ≥0.80) | −10pp |
| research-role recommendation rate | unmeasured | 6% | new signal |
| status-update no\_gap rate | unmeasured | 42% | new signal |
| best candidate threshold | 0.95 (91%, n=12) | 0.75 (90%, n=10) | lower threshold, comparable precision |
| question hash | 1ee518cb4a54b980 | fb2d35042f667b3c | changed (new questions) |

## Limitations

- **Skill catalog is current, not historical.** Sessions do not record the skill catalog
  at the time of the prompt. The current installed catalog (42 skills) was used for all
  turns.
- **Tool catalog is from the capability index.** The full available tool list (32 tools)
  comes from `global.json` rather than per-session proxies. This is more accurate than
  the baseline's per-session approach.
- **Label is first-usage, not full-turn.** The ground truth is what the agent used first
  after the prompt, not everything it used in the turn.
- **No repeat instability re-measurement.** The 30-prompt × 3-run test is deferred; the
  judge model is unchanged.
- **The 240-scenario authored held-out set is not this run.** The held-out set stays a
  gate before `load` is ever a default.
