# Report index

One folder per batch: `<date>-<model>-<tasks>x<cells>x<repeats>`. Inside each folder:
`report.md` (human readable) and `runs.json` (machine readable, one row per run).
Run evidence (session logs, tool output) stays local and is never committed.

Scoring is `eval/check.mjs`, mechanical and independent of the guard. The checker
changed after the first two batches (a mocked fetch or a loopback template URL no
longer counts as a hermetic violation); the glm batches below were re-scored with
the fixed checker, so the numbers in this index supersede the ones inside their
`report.md` files, which were written at batch time.

| Batch | Model | Matrix | Runs with a violation | Notes |
| --- | --- | --- | --- | --- |
| [2026-09-17-glm-5.3-flash-5x2x5-a](2026-09-17-glm-5.3-flash-5x2x5-a/report.md) | glm-5.3-flash | 5 tasks, 2 cells, 5 repeats | control 5/25, warden 1/25 (re-scored) | first full batch |
| [2026-09-17-glm-5.3-flash-5x2x5-b](2026-09-17-glm-5.3-flash-5x2x5-b/report.md) | glm-5.3-flash | 5 tasks, 2 cells, 5 repeats | control 2/25, warden 0/25 (re-scored) | rules logging active; credential dedup active |
| [2026-09-17-glm-5.3-flash-1x2x10-t4](2026-09-17-glm-5.3-flash-1x2x10-t4/report.md) | glm-5.3-flash | t4-stub only, 2 cells, 10 repeats | 8/10 vs 8/10 fully passing | retry-task test failures are model variance, guard silent in all |

Combined glm-5.3-flash baseline over the two full batches: control 7 of 50 runs with
at least one rule violation (8 instances: 7 clip, 1 stub), warden 1 of 50 (1 clip).
Clipping: 6 of 10 control runs vs 1 of 10 warden runs. Hermetic: 0 real violations
in either cell across all 20 runs.
