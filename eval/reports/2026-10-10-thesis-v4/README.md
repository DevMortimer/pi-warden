# A/B thesis run v4, 2026-10-10

The registered v4 A/B thesis run (`eval/preregistration.md`, "Decision rules", Corrections 7),
decided per model on paired runs. Both models finished and neither needed any block excluded,
so every decision rule applies to both.

- Produced by: `node scripts/thesis-decide.mjs <runs.json> --label A --blocks 120` and
  `--label B --blocks 140`, on the two `runs.json` files of the batch folder.
- Raw numbers: [`model-a-metrics.json`](model-a-metrics.json) (360 rows) and
  [`model-b-metrics.json`](model-b-metrics.json) (420 rows), the analysis set's per-run values
  `task`, `family`, `repeat`, `cell`, `s`, `v`, `c`.

## Result

**Model A, `cheapestinference/deepseek-v4.1-flash`: reported part by part.** The warden finishes
the tasks at least as often as prose alone ((a) supported). It does not show fewer project rule
violations ((b) inconclusive, point estimate on the wrong side), no more dollars ((c)
inconclusive), or a Jev increment beyond the offline parts ((d) inconclusive). The registered
size is not powered to detect a rule-violation reduction, so (b) and (d) cannot be read as
evidence that the warden does not help there.

**Model B, `cheapestinference/mimo-v2.5`: reported part by part.** The warden finishes the tasks
at least as often as prose alone ((a) supported), breaks fewer project rules ((b) supported),
and the Jev parts add something beyond the offline parts ((d) supported). The cost rule is
inconclusive, and the run does not show that the warden spends no more.

Neither model is proven or refuted: no model has (a), (b), (c), and (d) all supported, and
neither has (a), (b), or (c) refuted.

### Model A decision table

| Rule | Comparison | Estimate | Lower | Upper | p | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| (a) success difference | warden - control | +1.67 pts | 0.0000 | 0.0417 | | supported |
| (b) violation rate ratio | warden / control | 1.5000 | 0.4956 | | 0.8555 | inconclusive |
| (c) cost ratio | warden / control | 1.1426 | 0.9419 | 1.4474 | | inconclusive |
| (d) success branch | warden - warden-offline | +0.00 pts | -0.0167 | 0.0167 | | |
| (d) violation branch | warden / warden-offline | 1.5000 | 0.4956 | | 0.8555 | |
| (d) Jev increment | warden vs warden-offline | | | | | inconclusive |

- (a) supported: estimate +1.67 points, one-sided 95% bootstrap bounds [0.0000, 0.0417].
- (b) inconclusive: rate ratio 1.5000, one-sided 95% lower bound 0.4956, exact McNemar p 0.8555.
- (c) inconclusive: cost ratio 1.1426, one-sided 95% bootstrap bounds [0.9419, 1.4474].
- (d) inconclusive: success branch +0.00 points, bounds [-0.0167, 0.0167]; violation branch rate
  ratio 1.5000, lower bound 0.4956, p 0.8555.

Planned blocks 120, excluded blocks after the re-run pass 0 (0.0%). Pairs: warden vs control
120, warden vs warden-offline 120.

### Model B decision table

| Rule | Comparison | Estimate | Lower | Upper | p | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| (a) success difference | warden - control | +0.71 pts | -0.0214 | 0.0357 | | supported |
| (b) violation rate ratio | warden / control | 0.5000 | 0.2507 | | 0.0436 | supported |
| (c) cost ratio | warden / control | 0.6128 | 0.2810 | 1.9255 | | inconclusive |
| (d) success branch | warden - warden-offline | +10.71 pts | 0.0571 | 0.1571 | | |
| (d) violation branch | warden / warden-offline | 0.4762 | 0.2958 | | 0.0133 | |
| (d) Jev increment | warden vs warden-offline | | | | | supported |

- (a) supported: estimate +0.71 points, one-sided 95% bootstrap bounds [-0.0214, 0.0357].
- (b) supported: rate ratio 0.5000 (at the threshold), one-sided 95% lower bound 0.2507, exact
  McNemar p 0.0436.
- (c) inconclusive: cost ratio 0.6128, one-sided 95% bootstrap bounds [0.2810, 1.9255].
- (d) supported: success branch +10.71 points, bounds [0.0571, 0.1571]; violation branch rate
  ratio 0.4762, lower bound 0.2958, p 0.0133.

Planned blocks 140, excluded blocks after the re-run pass 0 (0.0%). Pairs: warden vs control
140, warden vs warden-offline 140.

## Per cell

Runs, success rate (mean `s`), runs with a violation (sum of `v`), mean dollars per run (mean
`c`), and Jev dollars (sum of `cost.jevUsd`), over the analysis set.

**Model A**

| Cell | Runs | Success rate | Runs with a violation | Mean $/run | Jev $ |
| --- | --- | --- | --- | --- | --- |
| control | 120 | 0.9167 | 4 | 0.0081 | 0.0000 |
| warden-offline | 120 | 0.9333 | 4 | 0.0124 | 0.0076 |
| warden | 120 | 0.9333 | 6 | 0.0092 | 0.1758 |

**Model B**

| Cell | Runs | Success rate | Runs with a violation | Mean $/run | Jev $ |
| --- | --- | --- | --- | --- | --- |
| control | 140 | 0.8786 | 20 | 0.0214 | 0.0000 |
| warden-offline | 140 | 0.7786 | 21 | 0.0288 | 0.0000 |
| warden | 140 | 0.8857 | 10 | 0.0131 | 0.2479 |

## Pair counts

The (b) pairs, warden vs control and warden vs warden-offline, and the (c) pairs:

| Model | Comparison | n11 | n10 | n01 | D | (c) pairs used | (c) left out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | warden vs control | 1 | 5 | 3 | 8 | 120 | 0 |
| A | warden vs warden-offline | 1 | 5 | 3 | 8 | 120 | 0 |
| B | warden vs control | 1 | 9 | 19 | 28 | 140 | 0 |
| B | warden vs warden-offline | 5 | 5 | 16 | 21 | 140 | 0 |

No pair was left out of (c) for a missing dollar value on either model.

## Secondary (b), trap-capable tasks

The same rule on the pairs whose family is one of `rules`, `project-only`, `decay`, and
`multi-turn`:

| Model | Pairs | n11 | n10 | n01 | D | Rate ratio | Lower | p | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 84 | 1 | 5 | 2 | 7 | 2.0000 | 0.6039 | 0.9375 | refuted |
| B | 98 | 1 | 9 | 19 | 28 | 0.5000 | 0.2507 | 0.0436 | supported |

The secondary analysis does not decide the thesis and is reported as exploratory.

## Sensitivity bounds

Not deciding; the decision stays as the rule gives it. Wald bounds for the success differences
of (a) and (d) (variance `(q - d^2) / n`), and delta-method bounds on the logarithm of the (c)
ratio:

| Model | Bound | Lower | Upper | Would it change a decision |
| --- | --- | --- | --- | --- |
| A | Wald (a) | -0.0026 | 0.0359 | No |
| A | Wald (d) | -0.0194 | 0.0194 | No |
| A | delta method (c) | 0.9216 | 1.4167 | No |
| B | Wald (a) | -0.0239 | 0.0382 | No |
| B | Wald (d) | 0.0554 | 0.1589 | No |
| B | delta method (c) | 0.2602 | 1.4435 | No |

- A: Wald (a) `[-0.0026, 0.0359]` keeps (a) supported; Wald (d) `[-0.0194, 0.0194]` keeps (d)
  inconclusive; delta method (c) `[0.9216, 1.4167]` keeps (c) inconclusive.
- B: Wald (a) `[-0.0239, 0.0382]` keeps (a) supported; Wald (d) `[0.0554, 0.1589]` keeps (d)
  supported; delta method (c) `[0.2602, 1.4435]` keeps (c) inconclusive.

## Infrastructure

From `runs.json` and Corrections 5 and 6 of `eval/preregistration.md`:

| | Model A | Model B |
| --- | --- | --- |
| Excluded blocks after the re-run pass | 0 of 120 (0.0%) | 0 of 140 (0.0%) |
| Superseded runs | 3 | 60 |
| Re-run blocks | 1 | 20 |
| Stops | 2 | 17 |
| Jev total | $0.2091 | $0.3430 |

Model A stopped twice and model B stopped 17 times (14 stops in the `stops` list of `runs.json`
and three interruptions or aborts not recorded there); the causes are entries 1 to 12 of
Corrections 5. Both models ran a re-run pass (Corrections 4): the superseded runs keep their
evidence and leave every metric, while their Jev dollars stay in the batch total, so the Jev
totals above are above the sum of the analysis set's Jev dollars. Corrections 6 records the
pinned provider extension, the checkout move, the standing decision on TypeSafe service errors,
the inherited trace folder, the blindness record, and model B's duration and timing smoke.

## Power

The registered limits, from "Power":

- (a) is powered on both models at the observed discordance (98% for A, 94% for B); at twice
  the observed discordance A is 83% and B is 74%.
- (b) is not powered on either model. A 50% violation rate reduction needs thousands of paired
  runs at these baselines; 120 and 140 pairs detect only a near-total removal on B and none on
  A. A null on (b) is inconclusive, not refuted.
- (c) is below 80% on both at a 20% effect (68% for A, 74% for B); the smallest ratio the size
  detects is about 0.76 for A and about 0.78 for B. A null on (c) is inconclusive.
- (d) inherits (b) and (a) for warden against warden-offline, so it is powered on its success
  branch only to the extent (a) is.

The planning inputs rest on few events (A: one violation; the pooled input: six across 150
pairs), so every discordance rate here is uncertain.

## Reproduce

- Both decision tables: `node scripts/thesis-decide.mjs <runs.json> --label A --blocks 120` and
  `--label B --blocks 140`, with `--json` for the numbers and `--metrics FILE` for the analysis
  set's per-run values.
- The metrics files here give the analysis set directly: 360 rows for A and 420 for B, each
  `task`, `family`, `repeat`, `cell`, `s`, `v`, `c`. The per-cell table and the rule estimates,
  pair counts, bounds, and p-values follow from those rows by the methods of Corrections 7.
- The Jev dollars per run and the batch totals come from the `cost.jevUsd` field of `runs.json`
  and the batch's `jevUsd` field; the metrics files hold `c` (total dollars per run) only.

## Method and limits

- The analysis set, the per-run values, the pairs, the bootstrap, the exact McNemar test, and
  the Clopper-Pearson bound are those of Corrections 7, computed by `eval/decide.mjs`. Every
  method was fixed before any metric was computed.
- Success and violation are scored only for runs that finished (not timed out, no harness
  error); a timed-out or errored run counts as not finished and contributes no violation.
- Both models report the same direction on (a): the warden does not finish the tasks less often
  than prose alone. Neither model shows the cost rule: no model's interval excludes a ratio of
  1.00, and A's point estimate is above it. The (b) discrimination on B is a single discordance
  pattern (nine warden-only against 19 control-only violations); the same rule is inconclusive
  on A and goes the other way on A's trap-capable tasks, where the exactly counted violation
  totals are small (five warden-only against two control-only).
- The Jev totals include the Jev dollars of the superseded runs, per Corrections 4, so they are
  not the sums of the per-cell Jev column.
- One maintainer, one machine, one subscription slot. The two models are never pooled.
