# 2026-09-21 action guard calibration, 0.33.3

Every guarded call in the recorded Pi sessions of four projects (pi-warden, millia, pi-typesafe,
pi-tiny-search) replayed through the action guard at 0.33.3, floor mode `evidence`, judge
`jev-1.13.0`: 315 sessions, 1347 labelled turns, 16,709 requests, about 79M input tokens.

Command: `node scripts/calibrate-action.mjs --project DIR --extra --yes --max-requests 25000`, one
project at a time, then `node scripts/calibrate-action.mjs --report FILE` for each run.

`report.md` holds the combined summary; `combined.report.txt` and the four `<project>.report.txt`
files hold the `--report` output.

The raw run files stay under `.local/calibration/*.jsonl` on the machine that made them. They are
owner-only and never committed: every record carries the prompt, the context messages, the plan, and
the command or path of the call.

The `.report.txt` files here are the `--report` output with every per-call example line removed for
the same reason; each removal is marked in place. Counts, rates, and thresholds are unchanged.
