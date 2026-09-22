# Conscience policy measurement, 2026-09-22

Third measurement and the one the beta policy record quotes: the conscience replay on the
final questions (hash `fb2d35042f667b3c`) with the split disposition gate
(`conscience.advanceThreshold` 0.70) and the candidate `recommendThreshold` 0.80. One
per-project full-corpus run, then the owner-labelled subset.

## Corpus and spend

| project | sessions | turns | requests | tokens | cost |
| --- | --- | --- | --- | --- | --- |
| millia | 50 | 285 | 855 | 4.9M (est.) | ~$0.21 |
| pi-warden | 50 | 239 | 717 | 4.07M | $0.17 |
| pi-tiny-search | 5 | 14 | 42 | 0.23M | $0.01 |
| pi-typesafe | 7 | 33 | 99 | 0.56M | $0.02 |
| **combined** | **112** | **571** | **1713** | **~9.8M** | **~$0.41** |

The 50 newest sessions of millia and pi-warden; all sessions of pi-tiny-search and
pi-typesafe. Full tool catalog from the capability index (32 tools, 51 entries). The
millia completion line was lost before it was recorded; its request count comes from the
per-assessment `requestCount` totals and its tokens from the measured per-request rate of
the other three projects (5,463–5,679 tokens/request), so the millia figure is an
estimate, marked as such.

Plus 99 requests (2.11M tokens, $0.09) to replay the 33 labelled-subset turns that the
50-newest cap had pushed out of the corpus (four sessions from 09-17 and 09-20; see
Labelled subset below), and 264 requests (~1.5M tokens, ~$0.06) replayed twice by
mistake during that replay.
**Voyage total: 2076 requests, about 13.4M input tokens, about $0.56.**

## Findings

**1. Pooled precision at the candidate policy is 89% — the 95% gate is not met.** At
usefulness ≥ 0.80 with the advance gate at 0.70, the conscience selected 83 candidates
and 74 landed on turns where the agent used a tool (74/83, 89%). The gate requires 95%
with n ≥ 10; n = 83 here, precision 89%, so the gate is not met on the full corpus
either. On the labelled subset the same thresholds give 9/10 (90%, n = 10) — also below
the gate. The policy ships as a beta candidate, not an active policy.

**2. Tool recommendation holds; skill recommendation regressed to 0%.** Tool picks: 121
selected across the run, 102 matched the agent's first usage (84%). Skill picks: 20
selected, 0 matched. The remeasure showed 10% skill precision on its corpus; this
corpus is younger and smaller (571 turns, 50-newest cap) and the skill-first rate is
lower (9% of turns vs 12% in the remeasure window), but 0 of 20 is not a sampling
artifact — the Skill/index-description gap noted in the disposition-gate work stands.

**3. Disposition accuracy dropped to 49% (277/571) from 60%.** Part of the drop is the
corpus: this run's turn mix is heavier on short status-update prompts from the newest
sessions. The advance gate at 0.70 also changes what `advance` means relative to the
remeasure sweep, which had no gate; the two disposition numbers are not directly
comparable. On the labelled subset, 12 of 27 status-update prompts were marked `no_gap`
(44%, vs 42% in the remeasure) and 11 of 12 pi-warden status rows sat below the gate —
exactly the remeasure's live-run value.

**4. P(advance) AUC is 0.54 on this corpus (0.60 remeasure, 0.62 baseline).** Usefulness
AUC against skill-used-first is 0.34. Both signals are weaker here; see the corpus caveat
above.

**5. The labelled subset reproduces the live-run gate numbers.** See below; three of the
four headline figures match the 1a live run exactly.

## Recommendation precision and recall (threshold sweep, advance gate 0.70)

threshold | selected | precision | recall | unnecessary (no-usage FP)
--- | --- | --- | --- | ---
0.50 | 132 | 92% | 25% | 10 (12%)
0.55 | 130 | 92% | 25% | 10 (12%)
0.60 | 125 | 92% | 24% | 10 (12%)
0.65 | 122 | 92% | 23% | 10 (12%)
0.70 | 114 | 91% | 21% | 10 (12%)
0.75 | 103 | 90% | 19% | 10 (12%)
0.80 | 83 | 89% | 15% | 9 (10%)
0.85 | 58 | 88% | 11% | 7 (8%)
0.90 | 35 | 91% | 7% | 3 (3%)
0.95 | 14 | 100% | 3% | 0 (0%)

## Skill recommendation precision and recall

threshold | selected-skill | precision | recall
--- | --- | --- | ---
0.50 | 18 | 0% | 0%
0.60 | 17 | 0% | 0%
0.70 | 17 | 0% | 0%
0.80 | 12 | 0% | 0%
0.90 | 6 | 0% | 0%

## Disposition accuracy

advance vs no\_gap against any-tool label: 277/571 (49%).

## AUC

| signal | AUC | n |
| --- | --- | --- |
| P(advance) vs any-tool | 0.54 | 571 |
| usefulness vs any-tool | 0.55 | 571 |
| usefulness vs skill-used-first | 0.34 | 571 |

## Unnecessary-suggestion rate on status-update prompts

Status-update / no-usage prompts: 86 turns. Of those, the conscience selected a
candidate: 14 (16%). At the candidate policy (≥ 0.80 with the gate): 9 (10%).

## Per-project

| project | turns | selected | tools | precision |
| --- | --- | --- | --- | --- |
| millia | 285 | 70 | 245 | 94% |
| pi-warden | 239 | 51 | 198 | 84% |
| pi-tiny-search | 14 | 8 | 14 | 100% |
| pi-typesafe | 33 | 12 | 28 | 83% |

## Per candidate kind

| kind | selected | matched | precision |
| --- | --- | --- | --- |
| skill | 20 | 0 | 0% |
| tool | 121 | 102 | 84% |

## Selected candidates (first 25)

| candidate | P(useful) | disposition | actual first usage | prompt |
| --- | --- | --- | --- | --- |
| technical-thinking-partner | 0.80 | advance | tool:bash | doing the CON-142 thing.... and CON-350. in progress. the snm-hk-onboarding was done yesterday btw. … |
| mcp__linear | 0.97 | advance | tool:bash | make the CON linear issue for this please... assign me. put it under an existing project if applicab… |
| mcp | 0.38 | advance | none | Agent said: \<logs\>This will permanently delete whatsapp_groups row [id]… |
| impeccable | 0.85 | advance | tool:read | Add another issue on shift-note about this /staff [path] |
| search_code | 0.72 | advance | tool:ctx_batch_execute | [path] |
| writing-for-agents | 0.70 | advance | tool:bash | On 2673, i'll let it finish every single CI errors. need a pormpt for it,, both CI errors AND dev er… |
| mcp__linear | 0.94 | advance | tool:mcpScript | for these three, make the linear issues, thank you,,, again same rules, if they are under a project … |
| mcp__linear | 0.85 | advance | tool:mcpScript | need to have linear issues for the other three. the CON-372 entry one is linear CON-373 haha. don't … |
| search_code | 0.82 | advance | tool:read | [path] |
| mcp__linear | 0.55 | advance | tool:ctx_execute | ohhhh, is CON-376 something started rn, what's the overall state of everything. don't show me comple… |
| bash | 0.95 | advance | tool:ctx_execute | yes apply them please now, then rerun dev deploy |
| search_code | 0.87 | advance | tool:ctx_batch_execute | also check how pi-warden works so you know what to put in pi-warden.md |
| bash | 0.58 | advance | tool:bash | continue the UI wiring on the same PR.. so rename PR title + PR body. |
| tdd | 0.71 | advance | tool:bash | Decision: start the Lane-3 code now. Rebase mail/con-350-... onto the CON-322/P13 branch and state t… |
| bash | 0.78 | advance | tool:bash | it now has real code. continue reviewing. |
| bash | 0.79 | advance | tool:bash | don't use subagents, do it yourself. |
| edit | 0.83 | advance | tool:bash | On the same PR, fix all the hard violations (if any) and all the judgement calls that you think were… |
| mcp__linear | 0.84 | advance | tool:bash | paste the snapshot and the delete result as a CON-365 comment, and set the issue to In Progress. |
| edit | 0.84 | advance | tool:ctx_execute | On the same PR, fix all hard violations, all the bad "judgement calls" you think. Push on the same p… |
| read | 0.87 | advance | skill:impeccable | one more. [path] |
| read | 0.65 | advance | tool:ctx_execute | continue |
| edit | 0.75 | advance | tool:ctx_batch_execute | hmmmmm idk,,, need something or somehow a way to "view" sample photo... let's not make it shown by d… |
| read | 0.80 | advance | tool:ctx_batch_execute | dont use subagent. review it yourself. |
| edit | 0.87 | advance | tool:ctx_execute | fix all. for the judgement call, judge them if they are a non-issue or not, your call whethter to fi… |
| bash | 0.81 | advance | tool:bash | Yes, I give you explicit go on the force push yes you can force push but do not do force with lease … |

## Labelled subset (owner labels, 126 rows)

The labelled subset from the order's corpus alone matches 93 of 126 label rows: the 50
newest millia and pi-warden sessions no longer reach back to four labelled sessions from
09-17 and 09-20 (33 rows: 7 y, 13 n, 13 unpicked). Those 33 turns were replayed separately
(99 requests) and the full 126-row subset is reported here.

126 rows, 126 scored, 0 errors. Owner labels: 20 y, 18 n, 88 unpicked.

threshold | y-picks survive | n-picks rescued | new picks on unpicked
--- | --- | --- | ---
0.50 | 10 | 17 | 10
0.60 | 10 | 17 | 10
0.70 | 9 | 17 | 8
0.80 | 9 | 17 | 4
0.85 | 8 | 17 | 2
0.90 | 8 | 18 | 0
0.95 | 6 | 18 | 0

Status-update prompts (27): 12 no\_gap (44%), 15 other.
Pi-warden status rows with pAdvance < 0.70: 11/12.

Precision on labelled picks (y and n):
- P(useful) ≥ 0.80: 9/10 (90%), n=10
- P(useful) ≥ 0.85: 8/9 (89%), n=9
- P(useful) ≥ 0.90: 8/8 (100%), n=8
- P(useful) ≥ 0.95: 6/6 (100%), n=6

Against the 1a live run at the same commit and thresholds (y 9/20, n 17/18, new picks
2/88, precision 9/10, pi-warden status rows below gate 11/12): y-picks 9/20 ✓, n rescued
17/18 ✓, precision 9/10 ✓, status rows 11/12 ✓, new picks on unpicked 4 vs 2 at 0.80.
The one gap is two extra picks on unpicked rows near the threshold boundary; every
y/n-labelled row landed where the live run landed.

## Comparison: first measurement, remeasure, this run

| metric | first (609 turns) | remeasure (2114 turns) | this run (571 turns) |
| --- | --- | --- | --- |
| tool precision (≥0.80) | 88% (120 selected) | 92% (331 selected) | 89% (83 selected, gate 0.70) |
| skill precision (≥0.80) | 0% (20 selected) | 10% (86 selected) | 0% (12 selected) |
| disposition accuracy | 63% | 60% | 49% |
| P(advance) AUC | 0.62 | 0.60 | 0.54 |
| usefulness AUC | 0.60 | 0.62 | 0.55 |
| unnecessary-suggestion (≥0.80) | 14% | 4% | 10% |
| status-update no_gap | unmeasured | 42% (5/12) | 44% (12/27) |
| labelled precision at candidate | unmeasured | 90% (9/10), threshold 0.75 | 90% (9/10), threshold 0.80 |
| question hash | 1ee518cb4a54b980 | fb2d35042f667b3c | fb2d35042f667b3c |

The corpora are not the same size or window: the first measurement used per-session tool
proxies and no advance gate, the remeasure ran the full session dirs with no advance gate,
and this run applies the 0.70 advance gate to the 50-newest per-project corpus. Rows are
directional, not controlled comparisons.

## Candidate policy (beta candidate)

```json
{
  "questionHash": "fb2d35042f667b3c",
  "model": "jev-1.13.0",
  "recommendThreshold": 0.80,
  "advanceThreshold": 0.70,
  "loadThreshold": 1.0
}
```

Pooled precision at this policy: 89% (74/83) on the 571-turn corpus; 90% (9/10) on the
labelled subset. The 95% gate with n ≥ 10 is **not met** (n = 83 pooled, n = 10
labelled). `loadThreshold` stays at 1.0 (trace-only) until the authored 240-scenario
held-out set is measured per spec §7.
