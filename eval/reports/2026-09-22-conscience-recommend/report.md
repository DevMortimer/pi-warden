# Conscience recommendation calibration, 2026-09-22

First measurement of the conscience guard's `recommend` skill/tool selection quality on
recorded Pi sessions. The authored 240-scenario held-out gate is not this run; it stays
a gate before `load` is ever a default.

## Corpus and spend

| project | sessions | turns | requests | tokens | cost |
| --- | --- | --- | --- | --- | --- |
| pi-warden | 50 | 230 | 460 | 1.68M | $0.07 |
| millia | 50 | 334 | 668 | 3.16M | $0.13 |
| pi-tiny-search | 4 | 12 | 18 | 0.06M | $0.00 |
| pi-typesafe | 7 | 33 | 66 | 0.24M | $0.01 |
| **combined** | **111** | **609** | **1212** | **5.14M** | **$0.22** |

Plus 90 requests (0.88M tokens, $0.04) for the 30-prompt × 3-run instability test.
**Voyage total: 1302 requests, about 6.0M input tokens, about $0.26.**

The 50 newest sessions of pi-warden and millia; all sessions of pi-tiny-search and
pi-typesafe. Skills discovered from the current installed catalog (42 skills, 22 eligible,
20 user-only). Tool catalogs built from each session's recorded tool calls plus built-in
tools — the full available tool list is not recorded in sessions; this is a limitation.

## Findings

**1. Tool recommendation is good; skill recommendation is broken.** Across all thresholds,
the conscience recommends a tool with 84% precision (260 of 308 selected-tool turns used a
tool first). Skill recommendation is 0% precision: 86 skill selections, none matched the
agent's actual first usage. The conscience selects skills when the agent uses tools, not
the other way around.

**2. No threshold meets the 95% precision gate.** The closest is `usefulness ≥ 0.95` with
91% precision (59 of 65 selected turns used a tool) but only 12% recall (59 of 506
positive turns). Precision plateaus around 88–92% across the upper half of the threshold
range. The gate requires95% on this corpus; no value achieves it.

**3. Disposition accuracy is modest.** The conscience says `advance` for 83% of turns,
but only 63% of those dispositions match the ground truth (the agent actually called a
tool). It over-predicts `advance`: 55% of selected recommendations land on turns where
nothing was used.

**4. P(advance) is a weak signal.** AUC of 0.62 against the any-tool label. The
usefulness score is even weaker at 0.60. The conscience cannot reliably distinguish turns
where the agent will use a tool from turns where it will not.

**5. Repeat instability is low.** 30 prompts run three times: 100% disposition agreement,
93% selected-candidate agreement, 100% usefulness agreement (to 1 decimal). The judge is
stable; the weakness is in the signal, not the noise.

## Recommendation precision and recall (threshold sweep)

threshold | selected | precision | recall | unnecessary (no-usage FP)
--- | --- | --- | --- | ---
0.50 | 309 | 89% | 54% | 35 (34%)
0.55 | 280 | 89% | 49% | 30 (29%)
0.60 | 249 | 89% | 44% | 27 (26%)
0.65 | 208 | 90% | 37% | 20 (19%)
0.70 | 177 | 89% | 31% | 19 (18%)
0.75 | 146 | 90% | 26% | 14 (14%)
0.80 | 120 | 88% | 21% | 14 (14%)
0.85 | 80 | 90% | 14% | 8 (8%)
0.90 | 38 | 89% | 7% | 4 (4%)
0.95 | 12 | 92% | 2% | 1 (1%)

## Skill recommendation precision and recall

threshold | selected-skill | precision | recall
--- | --- | --- | ---
0.50 | 63 | 0% | 0%
0.60 | 46 | 0% | 0%
0.70 | 28 | 0% | 0%
0.80 | 20 | 0% | 0%
0.90 | 9 | 0% | 0%

## Disposition accuracy

advance vs no\_gap against any-tool label: 383/609 (63%).

## AUC

| signal | AUC | n |
| --- | --- | --- |
| P(advance) vs any-tool | 0.62 | 609 |
| usefulness vs any-tool | 0.60 | 609 |
| usefulness vs skill-used-first | 0.28 | 609 |

## Per-project

| project | turns | selected | tools | precision |
| --- | --- | --- | --- | --- |
| pi-warden | 230 | 126 | 181 | 81% |
| millia | 334 | 238 | 285 | 87% |
| pi-tiny-search | 12 | 8 | 12 | 100% |
| pi-typesafe | 33 | 22 | 28 | 86% |

## Per candidate kind

| kind | selected | matched | precision |
| --- | --- | --- | --- |
| skill | 86 | 0 | 0% |
| tool | 308 | 260 | 84% |

## Repeat instability (30 prompts × 3 runs)

| metric | agreement |
| --- | --- |
| disposition | 30/30 (100%) |
| selected candidate | 28/30 (93%) |
| usefulness (1dp) | 30/30 (100%) |

## Policy record

```json
{
  "questionHash": "1ee518cb4a54b980",
  "model": "jev-latest",
  "recommendThreshold": 0.95,
  "loadThreshold": 1.0
}
```

No threshold met the 95% precision gate. `recommendThreshold` is set to 0.95 (the
closest) with the understanding that measured precision is 91% on this corpus. The
policy activates only when the question hash and model match; prompts that produce a
different hash remain trace-only. `loadThreshold` stays at 1.0 (trace-only) until the
authored 240-scenario held-out set is measured per spec §7.

The policy file is at `.local/calibration/conscience-policy.json`.

## Limitations

- **Skill catalog is current, not historical.** Sessions do not record the skill catalog
  at the time of the prompt. The current installed catalog (42 skills) was used for all
  turns. Skills added or removed since a session was recorded are mismatches.
- **Tool catalogs are proxies.** The full available tool list is not recorded in sessions.
  Tool catalogs were built from recorded tool calls plus built-in tools, which may miss
  tools that were available but unused.
- **Label is first-usage, not full-turn.** The ground truth is what the agent used first
  after the prompt, not everything it used in the turn. A turn that uses a skill second
  is labelled as tool-first.
- **No skill-read-follow-through measurement.** This run measures whether the conscience
  selects the right candidate, not whether the agent follows through on the
  recommendation. The end-to-end follow-through test is a separate gate per spec §7.
- **The 240-scenario authored held-out set is not this run.** This is the first
  measurement for `recommend`; the held-out set stays a gate before `load` is ever a
  default.
