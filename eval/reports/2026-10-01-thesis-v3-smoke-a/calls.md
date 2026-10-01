# Per-call cost: `deepseek/deepseek-flash`

Each call is priced at the rate of its own UTC timestamp (`eval/config.mjs`; sources: DeepSeek API docs, Models & Pricing: https://api-docs.deepseek.com/quick_start/pricing (read 2026-10-01)).

| Run | Call time (UTC) | Window | Input | Output | Cache read | Cache write | Dollars |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t1-redact control r1 | 2026-10-01T01:26:36.514Z | off-peak | 3386 | 134 | 512 | 0 | $0.000590 |
| t1-redact control r1 | 2026-10-01T01:26:37.611Z | off-peak | 704 | 288 | 3968 | 0 | $0.000290 |
| t1-redact control r1 | 2026-10-01T01:26:39.313Z | off-peak | 782 | 131 | 4864 | 0 | $0.000210 |
| t1-redact control r1 | 2026-10-01T01:26:40.638Z | off-peak | 920 | 787 | 5760 | 0 | $0.000627 |
| t1-redact control r1 | 2026-10-01T01:26:44.045Z | off-peak | 210 | 80 | 7296 | 0 | $0.000101 |
| t1-redact control r1 | 2026-10-01T01:26:45.288Z | off-peak | 210 | 136 | 7552 | 0 | $0.000136 |
| t1-redact warden-offline r1 | 2026-10-01T01:26:37.226Z | off-peak | 4046 | 500 | 512 | 0 | $0.000908 |
| t1-redact warden-offline r1 | 2026-10-01T01:26:39.529Z | off-peak | 1332 | 365 | 4992 | 0 | $0.000434 |
| t1-redact warden-offline r1 | 2026-10-01T01:26:40.991Z | off-peak | 1239 | 765 | 6656 | 0 | $0.000665 |
| t1-redact warden-offline r1 | 2026-10-01T01:26:44.462Z | off-peak | 561 | 1376 | 8576 | 0 | $0.000935 |
| t1-redact warden-offline r1 | 2026-10-01T01:26:50.592Z | off-peak | 184 | 113 | 10368 | 0 | $0.000127 |
| t1-redact warden-offline r1 | 2026-10-01T01:26:51.830Z | off-peak | 217 | 585 | 10624 | 0 | $0.000415 |
| t1-redact warden r1 | 2026-10-01T01:26:37.230Z | off-peak | 4025 | 215 | 512 | 0 | $0.000734 |
| t1-redact warden r1 | 2026-10-01T01:26:38.837Z | off-peak | 1634 | 1205 | 4736 | 0 | $0.000982 |
| t1-redact warden r1 | 2026-10-01T01:26:44.864Z | off-peak | 235 | 166 | 7552 | 0 | $0.000158 |

Per run:

| Run | Calls | Input | Output | Cache read | Cache write | Total tokens | Agent dollars | Jev requests | Jev input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| t1-redact control r1 | 6 | 6212 | 1556 | 29952 | 0 | 37720 | $0.001955 | 0 | 0 |
| t1-redact warden-offline r1 | 6 | 7579 | 3704 | 41728 | 0 | 53011 | $0.003484 | 0 | 0 |
| t1-redact warden r1 | 3 | 5894 | 1586 | 12800 | 0 | 20280 | $0.001874 | 6 | 12889 |
