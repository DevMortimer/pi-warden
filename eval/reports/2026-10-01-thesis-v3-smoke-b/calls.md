# Per-call cost: `claude-bridge/claude-sonnet-5-5`

Each call is priced at the rate of its own UTC timestamp (`eval/config.mjs`; sources: Anthropic Claude API docs, Pricing: https://docs.claude.com/en/docs/about-claude/pricing (read 2026-10-01)).

| Run | Call time (UTC) | Window | Input | Output | Cache read | Cache write | Dollars |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t1-redact control r1 | 2026-10-01T01:27:01.098Z | flat | 2 | 245 | 1660 | 7847 | $0.022403 |
| t1-redact control r1 | 2026-10-01T01:27:05.538Z | flat | 2 | 485 | 9507 | 887 | $0.008973 |
| t1-redact control r1 | 2026-10-01T01:27:09.345Z | flat | 2 | 238 | 10394 | 874 | $0.006648 |
| t1-redact warden-offline r1 | 2026-10-01T01:27:01.779Z | flat | 2 | 83 | 0 | 10448 | $0.026954 |
| t1-redact warden-offline r1 | 2026-10-01T01:27:04.337Z | flat | 2 | 545 | 10448 | 686 | $0.009259 |
| t1-redact warden-offline r1 | 2026-10-01T01:27:09.234Z | flat | 2 | 245 | 11134 | 910 | $0.006956 |
| t1-redact warden r1 | 2026-10-01T01:27:01.785Z | flat | 2 | 83 | 0 | 10409 | $0.026856 |
| t1-redact warden r1 | 2026-10-01T01:27:04.204Z | flat | 2 | 514 | 10409 | 894 | $0.009461 |
| t1-redact warden r1 | 2026-10-01T01:27:09.210Z | flat | 2 | 250 | 11303 | 878 | $0.006960 |

Per run:

| Run | Calls | Input | Output | Cache read | Cache write | Total tokens | Agent dollars | Jev requests | Jev input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| t1-redact control r1 | 3 | 6 | 968 | 21561 | 9608 | 32143 | $0.038024 | 0 | 0 |
| t1-redact warden-offline r1 | 3 | 6 | 873 | 21582 | 12044 | 34505 | $0.043168 | 0 | 0 |
| t1-redact warden r1 | 3 | 6 | 847 | 21712 | 12181 | 34746 | $0.043277 | 5 | 11121 |
