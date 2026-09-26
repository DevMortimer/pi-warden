# 2026-09-26 judge bench

80 labelled cases for the stuck and done guards (`eval/judge-bench/`), each sent to the judge in three request states,
3 repeats: 720 requests, 0 failed, 46.9 s, judge `jev-1.13.0`.

- **stuck:** structured evidence (C) is right where today's state (A) is wrong on 11 cases and never the reverse
  (sign test p = 0.001); accuracy 0.725 → 0.992, Brier 0.207 → 0.094. Most of A's errors are *progressing* windows
  called stuck. More raw bytes (B) change one verdict. The C digest is close to the label rule, so treat the gain as
  an upper bound.
- **done:** no arm beats A beyond noise (C +1 case, p = 1.0). Five *not done* cases have a passing check after the
  last edit and never reach the judge, in any arm.
- Cost: C adds ~1.5 KB (stuck) and ~0.35 KB (done) at p50; latency p50 is 245–257 ms in every arm.

Files: [report.md](report.md) (method, tables, verdicts, limits), `results.json` (answers, per-case verdicts, scores),
`requests.jsonl` (arm, bytes, latency, outcome per request; no state content).

Reproduce: `npm run build && npm run eval:judge -- --repeats 3 --budget 900`. Re-score after a label change:
`npm run eval:judge -- --rescore eval/reports/2026-09-26-judge-bench`.
