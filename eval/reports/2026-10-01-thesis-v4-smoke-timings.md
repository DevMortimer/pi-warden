# Smoke timings, thesis v4 (timings only; no outcome is read)

Each batch: 4 tasks (t6-dsn, t10-fixfail single-shot; t17-clip-arc, t20-ship-arc multi-turn) x 3 cells x 1 repeat of the model 1 spec `cheapestinference/deepseek-v4.1-flash`, run one after another on the one generation slot, with a 30-minute run timeout. Queue wait and generation time come from the extension's queue lines (`PI_CHEAPEST_QUEUE_DEBUG=1`): wait = slot acquired - requested, generation = slot released - acquired. Wall is the batch's wall-clock seconds.

## Concurrency 1

| Run | Kind | Wall s | Calls | Queue wait mean/max s | Generation mean/max s | Slot-held s |
| --- | --- | --- | --- | --- | --- | --- |
| t17-clip-arc control r1 | multi-turn | 1049 | 42 | 0.0 / 0.0 | 23.2 / 151.1 | 975.0 |
| t17-clip-arc warden r1 | multi-turn | 605 | 25 | 0.0 / 0.0 | 23.0 / 79.2 | 574.8 |
| t17-clip-arc warden-offline r1 | multi-turn | 1942 | 63 | 0.0 / 0.0 | 28.7 / 179.7 | 1810.8 |
| t20-ship-arc control r1 | multi-turn | 321 | 25 | 0.0 / 0.0 | 12.6 / 52.8 | 314.1 |
| t20-ship-arc warden r1 | multi-turn | 381 | 21 | 0.0 / 0.0 | 17.3 / 42.6 | 363.7 |
| t20-ship-arc warden-offline r1 | multi-turn | 219 | 21 | 0.0 / 0.0 | 10.0 / 32.5 | 209.5 |
| t10-fixfail control r1 | single-shot | 20 | 5 | 0.0 / 0.0 | 3.7 / 6.7 | 18.3 |
| t10-fixfail warden r1 | single-shot | 36 | 5 | 0.0 / 0.0 | 6.3 / 8.5 | 31.6 |
| t10-fixfail warden-offline r1 | single-shot | 100 | 9 | 0.0 / 0.0 | 9.8 / 38.4 | 88.0 |
| t6-dsn control r1 | single-shot | 37 | 7 | 0.0 / 0.0 | 4.5 / 7.0 | 31.6 |
| t6-dsn warden r1 | single-shot | 28 | 4 | 0.0 / 0.1 | 5.2 / 8.8 | 20.9 |
| t6-dsn warden-offline r1 | single-shot | 42 | 5 | 0.0 / 0.0 | 6.7 / 9.0 | 33.5 |

Runs: 12; batch wall 6769 s; runs per hour 6.4.
single-shot: 6 runs, wall mean 44 s, longest 100 s; 35 calls, queue wait mean 0.0 s (max 0.1), generation mean 6.4 s (max 38.4)
multi-turn: 6 runs, wall mean 753 s, longest 1942 s; 197 calls, queue wait mean 0.0 s (max 0.0), generation mean 21.6 s (max 179.7)
multi-turn turns: 33, mean 137 s, longest 1399 s; turns per run mean 5.5
Slot-held total 4471.7 s of 6769 s wall (66% busy).

## Concurrency 2

| Run | Kind | Wall s | Calls | Queue wait mean/max s | Generation mean/max s | Slot-held s |
| --- | --- | --- | --- | --- | --- | --- |
| t17-clip-arc control r1 | multi-turn | 1516 | 41 | 12.3 / 44.9 | 23.0 / 213.9 | 942.2 |
| t17-clip-arc warden r1 | multi-turn | 259 | 18 | 0.0 / 0.0 | 13.8 / 49.8 | 248.5 |
| t17-clip-arc warden-offline r1 | multi-turn | 1784 | 32 | 0.0 / 0.0 | 31.3 / 310.3 | 1001.2 |
| t20-ship-arc control r1 | multi-turn | 649 | 18 | 23.1 / 88.5 | 12.7 / 43.6 | 229.4 |
| t20-ship-arc warden r1 | multi-turn | 627 | 21 | 17.5 / 213.8 | 11.6 / 36.4 | 242.6 |
| t20-ship-arc warden-offline r1 | multi-turn | 520 | 19 | 14.7 / 93.4 | 12.1 / 38.3 | 229.8 |
| t10-fixfail control r1 | single-shot | 183 | 4 | 30.1 / 106.1 | 15.5 / 44.4 | 62.1 |
| t10-fixfail warden r1 | single-shot | 85 | 6 | 8.3 / 15.4 | 5.4 / 7.8 | 32.6 |
| t10-fixfail warden-offline r1 | single-shot | 159 | 11 | 5.5 / 10.4 | 8.4 / 15.7 | 92.5 |
| t6-dsn control r1 | single-shot | 56 | 5 | 5.9 / 15.7 | 5.1 / 7.0 | 25.5 |
| t6-dsn warden r1 | single-shot | 73 | 5 | 9.1 / 14.5 | 5.0 / 7.0 | 25.1 |
| t6-dsn warden-offline r1 | single-shot | 99 | 6 | 6.6 / 10.5 | 9.5 / 16.4 | 57.0 |

Runs: 12; batch wall 4853 s; runs per hour 8.9.
single-shot: 6 runs, wall mean 109 s, longest 183 s; 37 calls, queue wait mean 9.3 s (max 106.1), generation mean 8.0 s (max 44.4)
multi-turn: 6 runs, wall mean 893 s, longest 1784 s; 149 calls, queue wait mean 10.5 s (max 213.8), generation mean 19.4 s (max 310.3)
multi-turn turns: 33, mean 162 s, longest 1146 s; turns per run mean 5.5
Slot-held total 3188.5 s of 4853 s wall (66% busy).

## Concurrency 3

| Run | Kind | Wall s | Calls | Queue wait mean/max s | Generation mean/max s | Slot-held s |
| --- | --- | --- | --- | --- | --- | --- |
| t17-clip-arc control r1 | multi-turn | 2263 | 36 | 24.7 / 102.8 | 30.7 / 264.0 | 1106.1 |
| t17-clip-arc warden r1 | multi-turn | 1181 | 33 | 2.2 / 17.6 | 33.1 / 432.3 | 1091.4 |
| t17-clip-arc warden-offline r1 | multi-turn | 612 | 21 | 11.4 / 30.0 | 17.4 / 44.0 | 365.6 |
| t20-ship-arc control r1 | multi-turn | 819 | 20 | 29.6 / 261.1 | 11.1 / 25.6 | 221.7 |
| t20-ship-arc warden r1 | multi-turn | 1007 | 18 | 42.0 / 163.2 | 13.0 / 27.2 | 234.5 |
| t20-ship-arc warden-offline r1 | multi-turn | 686 | 23 | 18.9 / 104.1 | 10.6 / 29.2 | 243.5 |
| t10-fixfail control r1 | single-shot | 60 | 4 | 7.1 / 12.4 | 7.8 / 12.7 | 31.2 |
| t10-fixfail warden r1 | single-shot | 218 | 5 | 38.6 / 73.9 | 4.5 / 6.7 | 22.4 |
| t10-fixfail warden-offline r1 | single-shot | 1800 | 21 | 30.8 / 124.0 | 25.8 / 87.6 | 540.9 |
| t6-dsn control r1 | single-shot | 148 | 6 | 16.9 / 49.1 | 7.6 / 17.8 | 45.5 |
| t6-dsn warden r1 | single-shot | 199 | 6 | 22.9 / 56.6 | 9.7 / 24.3 | 58.3 |
| t6-dsn warden-offline r1 | single-shot | 229 | 5 | 37.7 / 166.6 | 7.6 / 8.7 | 37.9 |

Runs: 12; batch wall 4066 s; runs per hour 10.6.
single-shot: 6 runs, wall mean 442 s, longest 1800 s; 47 calls, queue wait mean 27.5 s (max 166.6), generation mean 15.7 s (max 87.6)
multi-turn: 6 runs, wall mean 1095 s, longest 2263 s; 151 calls, queue wait mean 19.8 s (max 261.1), generation mean 21.6 s (max 432.3)
multi-turn turns: 33, mean 199 s, longest 1800 s; turns per run mean 5.5
Slot-held total 3998.8 s of 4066 s wall (98% busy).

## Model 2, concurrency 3 (2 tasks: t6-dsn single-shot, t20-ship-arc multi-turn; `cheapestinference/mimo-v2.5`)

| Run | Kind | Wall s | Calls | Queue wait mean/max s | Generation mean/max s | Slot-held s |
| --- | --- | --- | --- | --- | --- | --- |
| t20-ship-arc control r1 | multi-turn | 148 | 19 | 1.2 / 19.9 | 6.2 / 11.0 | 118.2 |
| t20-ship-arc warden r1 | multi-turn | 330 | 16 | 9.6 / 27.3 | 10.4 / 30.3 | 165.8 |
| t20-ship-arc warden-offline r1 | multi-turn | 147 | 20 | 0.0 / 0.1 | 6.2 / 16.9 | 124.9 |
| t6-dsn control r1 | single-shot | 109 | 6 | 10.2 / 30.9 | 7.8 / 15.2 | 46.9 |
| t6-dsn warden r1 | single-shot | 115 | 6 | 11.3 / 26.0 | 7.3 / 24.0 | 43.8 |
| t6-dsn warden-offline r1 | single-shot | 1206 | 47 | 1.0 / 10.2 | 12.7 / 76.3 | 599.1 |

Runs: 6; batch wall 1433 s; runs per hour 15.1.
single-shot: 3 runs, wall mean 477 s, longest 1206 s; 59 calls, queue wait mean 3.0 s (max 30.9), generation mean 11.7 s (max 76.3)
multi-turn: 3 runs, wall mean 208 s, longest 330 s; 55 calls, queue wait mean 3.2 s (max 27.3), generation mean 7.4 s (max 30.3)
multi-turn turns: 18, mean 35 s, longest 102 s; turns per run mean 6.0
Slot-held total 1098.7 s of 1433 s wall (77% busy).
