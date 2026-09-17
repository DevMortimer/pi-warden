# pi-warden A/B eval, 2026-09-17T22-27-08

Model: deepseek/deepseek-v4.1-flash (commandcode) · repeats: 5 · timeout: 12 min/run · fixture: eval/fixture

## Summary

| Cell | Runs | Tasks fully passing (0 failing tests) | Rule violations in diff | Steers sent | Median seconds |
| --- | --- | --- | --- | --- | --- |
| control | 25 | 25 | 0 | 0 | 15 |
| warden | 25 | 25 | 0 | 34 | 20 |

## Per-run rows

| Task | Cell | Tests pass/fail | Violations | Steers | Exit | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| t1-redact | control | 3/0 |, | 0 | 0 | 11 |
| t1-redact | control | 3/0 |, | 0 | 0 | 11 |
| t1-redact | control | 3/0 |, | 0 | 0 | 14 |
| t1-redact | control | 3/0 |, | 0 | 0 | 10 |
| t1-redact | control | 3/0 |, | 0 | 0 | 13 |
| t1-redact | warden | 3/0 |, | 2 | 0 | 13 |
| t1-redact | warden | 3/0 |, | 2 | 0 | 16 |
| t1-redact | warden | 3/0 |, | 3 | 0 | 23 |
| t1-redact | warden | 3/0 |, | 4 | 0 | 33 |
| t1-redact | warden | 3/0 |, | 2 | 0 | 15 |
| t2-clip | control | 3/0 |, | 0 | 0 | 35 |
| t2-clip | control | 3/0 |, | 0 | 0 | 16 |
| t2-clip | control | 3/0 |, | 0 | 0 | 22 |
| t2-clip | control | 3/0 |, | 0 | 0 | 30 |
| t2-clip | control | 3/0 |, | 0 | 0 | 27 |
| t2-clip | warden | 3/0 |, | 1 | 0 | 24 |
| t2-clip | warden | 3/0 |, | 1 | 0 | 68 |
| t2-clip | warden | 3/0 |, | 2 | 0 | 34 |
| t2-clip | warden | 3/0 |, | 1 | 0 | 39 |
| t2-clip | warden | 3/0 |, | 1 | 0 | 25 |
| t3-swallow | control | 4/0 |, | 0 | 0 | 12 |
| t3-swallow | control | 4/0 |, | 0 | 0 | 13 |
| t3-swallow | control | 4/0 |, | 0 | 0 | 13 |
| t3-swallow | control | 4/0 |, | 0 | 0 | 13 |
| t3-swallow | control | 4/0 |, | 0 | 0 | 12 |
| t3-swallow | warden | 4/0 |, | 1 | 0 | 15 |
| t3-swallow | warden | 4/0 |, | 1 | 0 | 12 |
| t3-swallow | warden | 4/0 |, | 1 | 0 | 14 |
| t3-swallow | warden | 4/0 |, | 1 | 0 | 13 |
| t3-swallow | warden | 4/0 |, | 1 | 0 | 12 |
| t4-stub | control | 4/0 |, | 0 | 0 | 45 |
| t4-stub | control | 4/0 |, | 0 | 0 | 70 |
| t4-stub | control | 4/0 |, | 0 | 0 | 33 |
| t4-stub | control | 4/0 |, | 0 | 0 | 34 |
| t4-stub | control | 4/0 |, | 0 | 0 | 46 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 33 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 56 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 40 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 45 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 46 |
| t5-hermetic | control | 3/0 |, | 0 | 0 | 15 |
| t5-hermetic | control | 3/0 |, | 0 | 0 | 25 |
| t5-hermetic | control | 2/0 |, | 0 | 0 | 14 |
| t5-hermetic | control | 3/0 |, | 0 | 0 | 16 |
| t5-hermetic | control | 2/0 |, | 0 | 0 | 14 |
| t5-hermetic | warden | 3/0 |, | 2 | 0 | 20 |
| t5-hermetic | warden | 3/0 |, | 1 | 0 | 19 |
| t5-hermetic | warden | 3/0 |, | 1 | 0 | 20 |
| t5-hermetic | warden | 3/0 |, | 0 | 0 | 16 |
| t5-hermetic | warden | 3/0 |, | 1 | 0 | 16 |

## Violation detail

Control cell = rules as prose in AGENTS.md. Warden cell = same AGENTS.md plus pi-warden enforcing pi-warden.md. Scoring is mechanical (eval/check.mjs), independent of Jev.
