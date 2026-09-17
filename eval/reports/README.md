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
| [2026-09-17-deepseek-v4.1-flash-5x2x5](2026-09-17-deepseek-v4.1-flash-5x2x5/report.md) | deepseek-v4.1-flash | 5 tasks, 2 cells, 5 repeats | 0/25 vs 0/25 | clean model: the warden neither helped nor hurt |
| [2026-09-17-glm-5.3-flash-5x2x5-a](2026-09-17-glm-5.3-flash-5x2x5-a/report.md) | glm-5.3-flash | 5 tasks, 2 cells, 5 repeats | control 5/25, warden 1/25 (re-scored) | first full batch |
| [2026-09-17-glm-5.3-flash-5x2x5-b](2026-09-17-glm-5.3-flash-5x2x5-b/report.md) | glm-5.3-flash | 5 tasks, 2 cells, 5 repeats | control 2/25, warden 0/25 (re-scored) | rules logging active; credential dedup active |
| [2026-09-17-glm-5.3-flash-1x2x10-t4](2026-09-17-glm-5.3-flash-1x2x10-t4/report.md) | glm-5.3-flash | t4-stub only, 2 cells, 10 repeats | 8/10 vs 8/10 fully passing | retry-task test failures are model variance, guard silent in all |
| [2026-09-17-glm-5.3-flash-1x2x2-t1](2026-09-17-glm-5.3-flash-1x2x2-t1/report.md) | glm-5.3-flash | t1-redact only, 2 cells, 2 repeats | control 1/2, warden 1/2 (both `stub`) | 0.14 credential change: 0 credential steers; the 4 warden steers are real slop findings |

The last batch ran the model named in the folder, which is pi's default
(`commandcode/z-ai/glm-5.3-flash`); the folder the runner itself created said
`default`, so it was renamed to match the convention above. Its four warden-cell
steers are three `stub` notes on `src/redact.js` and one repeat; no credential
steer fired, where the same task produced the credential noise in the 5x2x5 batch.
Replay the credential decision over any batch offline with
`node scripts/credential-replay.mjs --report eval/reports/<batch>` (no key, no
requests).

Combined glm-5.3-flash baseline over the two full batches: control 7 of 50 runs with
at least one rule violation (8 instances: 7 clip, 1 stub), warden 1 of 50 (1 clip).
Clipping: 6 of 10 control runs vs 1 of 10 warden runs. Hermetic: 0 real violations
in either cell across all 20 runs.

Credential steers, measured offline over the committed session logs of a whole
batch (`scripts/credential-replay.mjs`): deepseek-v4.1-flash 5x2x5 went from 30
recorded credential steers to 2 under the 0.14 rule, and both survivors are a
real-shaped token an environment dump exposed. glm 5x2x5-a went from 19 to 0 and
5x2x5-b from 22 to 0.
