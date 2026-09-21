# 2026-09-22 conscience recommendation calibration

First measurement of the conscience guard's `recommend` skill/tool selection on recorded
Pi sessions: 111 sessions, 609 turns, 1302 requests, about 6.0M input tokens.

Command: `node scripts/conscience-replay.mjs --dir DIR --max-sessions N --yes`, one
project at a time, then `--report FILE` for the combined run. Instability:
`node scripts/conscience-instability.mjs`.

`report.md` holds the combined summary. The raw JSONL files stay under
`.local/calibration/` on the machine that made them. They are owner-only and never
committed: every record carries the prompt text.

The `.report.md` files here have prompts redacted; counts, rates, and thresholds are
unchanged.
