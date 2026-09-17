# pi-warden A/B eval, 2026-09-17T21-11-30

Model: z-ai/glm-5.3-flash (commandcode) · repeats: 10 · timeout: 12 min/run · fixture: eval/fixture

## Summary

| Cell | Runs | Tasks fully passing (0 failing tests) | Rule violations in diff | Steers sent | Median seconds |
| --- | --- | --- | --- | --- | --- |
| control | 10 | 8 | 0 | 0 | 207 |
| warden | 10 | 8 | 0 | 5 | 204 |

## Per-run rows

| Task | Cell | Tests pass/fail | Violations | Steers | Exit | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| t4-stub | control | 3/1 |, | 0 | 0 | 207 |
| t4-stub | control | 4/0 |, | 0 | 0 | 396 |
| t4-stub | control | 4/0 |, | 0 | 0 | 73 |
| t4-stub | control | 4/0 |, | 0 | 0 | 89 |
| t4-stub | control | 4/0 |, | 0 | 0 | 164 |
| t4-stub | control | 4/0 |, | 0 | 0 | 329 |
| t4-stub | control | 4/0 |, | 0 | 0 | 67 |
| t4-stub | control | 4/0 |, | 0 | 0 | 143 |
| t4-stub | control | 4/0 |, | 0 | 0 | 260 |
| t4-stub | control | 3/1 |, | 0 | 0 | 395 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 149 |
| t4-stub | warden | 4/0 |, | 0 | 0 | 90 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 217 |
| t4-stub | warden | 4/0 |, | 0 | 0 | 72 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 204 |
| t4-stub | warden | 4/0 |, | 1 | 0 | 340 |
| t4-stub | warden | 3/1 |, | 1 | 0 | 306 |
| t4-stub | warden | 4/0 |, | 0 | 0 | 577 |
| t4-stub | warden | 3/1 |, | 0 | 0 | 144 |
| t4-stub | warden | 4/0 |, | 0 | 0 | 119 |

## Violation detail

Control cell = rules as prose in AGENTS.md. Warden cell = same AGENTS.md plus pi-warden enforcing pi-warden.md. Scoring is mechanical (eval/check.mjs), independent of Jev.
