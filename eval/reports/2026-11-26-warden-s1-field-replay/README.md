# Local `Warden-S1` Field Replay Evaluation (2026-11-26)

Offline + local System-One replay over a scrubbed, anonymized real-world field corpus packed by `scripts/s1-field-replay.mjs`. All raw session transcripts, commands, paths, and review artifacts stay local outside git (`~/.pi/agent/pi-warden-evals/`); this folder commits only pure aggregate counts, rates, and latencies (`aggregates.json`).

## Privacy & Scrubbing Gate

The `--pack` phase builds a self-contained local corpus with keyed per-pack SHA-256 pseudonymization (discarded after packing) layered on top of `redact`, `maskSecrets`, and `findSecrets` from `src/redact.ts`, rewriting home directories (`/home/dev/...`), workspaces (`/workspace/project-NNN/...`), session IDs (`session-NNN`), git remotes (`*.example.invalid`), emails (`dev-NNN@example.invalid`), non-loopback IPs (`198.51.100.x`), and private identifiers. A fail-closed post-scrub leak auditor scans every written byte and rejects any remaining OS username, home path, local repository name, private IP, git remote, email, or credential match.

| Audit check | Result |
| --- | --- |
| Local pack files audited | 3 (`manifest.json`, `sessions.jsonl`, `cases.jsonl`) |
| Local pack bytes audited | 1,225,708 |
| Leak-scanner hits (pack) | 0 |
| Leak-scanner hits (`aggregates.json`) | 0 |
| Packing salt retained | `false` (ephemeral per-pack random key) |

## Packed Corpus Composition

Collected from a 37-hour field window of Warden-enabled Pi sessions plus deduplicated historical labeled holds from the local holds ledger:

| Stratum | Packed count | Description |
| --- | --- | --- |
| Multi-turn trajectories (`sessions.jsonl`) | 40 | Scrubbed Pi-compatible session transcripts (`4`–`16` turns each) for `WardenS1SessionTracker` KV paging replay |
| `clean_field` (`cases.jsonl`) | 120 | Clean past-window cases across `action` (48), `output` (30), `rules` (24), and `stuck` (18) |
| `historical_catch` (`cases.jsonl`) | 84 | Deduplicated historical holds where the user declined or the agent replanned (`declined` / `replanned`) |
| `historical_overridden` (`cases.jsonl`) | 35 | Deduplicated historical holds explicitly approved/overridden by the user (`approved`) |
| `historical_regret` (`cases.jsonl`) | 21 | Deduplicated historical allowed calls later regretted by the user (`regretted`) |
| **Total cases** | **260** | `action`: 188, `output`: 30, `rules`: 24, `stuck`: 18 |

## Live `Warden-S1` Replay Scorecard (`--budget 60`)

Replayed against `warden-s1-752m-mlx-q4` (`mlx` runtime) in an isolated temporary daemon `stateDir` (`$0` API spend, `60/60` budgeted local model calls, `0` errors):

| Metric | Result | Counts |
| --- | --- | --- |
| Clean field specificity (overall) | **1.000** (`0.0%` false alarms) | `33 / 33` allowed (`20` model-judged, `13` offline-decided) |
| Clean field specificity — `action` | **1.000** | `9 / 9` allowed (`9` model-judged) |
| Clean field specificity — `output` | **1.000** | `8 / 8` allowed (`7` model-judged) |
| Clean field specificity — `stuck` | **1.000** | `8 / 8` allowed (`0` false loops) |
| Clean field specificity — `rules` | **1.000** | `8 / 8` allowed (`4` model-judged) |
| Historical positive catch recall (`declined` / `replanned`) | **0.875** | `7 / 8` held (`8` model-judged) |
| Historical overridden false-hold rate (`approved` holds) | **0.375** (`62.5%` fewer false holds) | `3 / 8` held, `5 / 8` allowed (`8` model-judged) |
| Historical regretted-allow catch rate (`regretted` allows) | **0.000** | `0 / 8` held (`8` model-judged) |
| Multi-turn trajectory clean specificity | **1.000** | `16 / 16` clean steps allowed across `4` sessions |
| Multi-turn `O(ΔL)` KV incremental hit rate | **1.000** | `12 / 12` incremental turns hit `delta` cache (`4` cold + `12` delta) |
| Epistemic abstention rate | **0.0411** | `6 / 146` noul probes abstained |
| Model / RPC errors | **0** | `0 / 60` |

## Latency & `O(ΔL)` KV Paging Breakdown

| Slice | Requests | Min (ms) | p50 (ms) | p95 (ms) | Max (ms) | Mean (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| Overall | 60 | 231.6 | 1562.7 | 4630.0 | 4810.1 | 1768.0 |
| Cold prefill (`miss`) | 48 | 626.1 | 1663.0 | 4648.2 | 4810.1 | 1997.3 |
| Incremental KV (`delta`) | 12 | 231.6 | 553.6 | 3266.4 | 3266.4 | 850.7 |
| Trajectory replay (`WardenS1SessionTracker`) | 16 | 231.6 | 700.6 | 3266.4 | 3266.4 | 1139.9 |
| `action` guard | 33 | 626.1 | 1658.0 | 4648.2 | 4810.1 | 1883.2 |
| `output` guard | 7 | 844.4 | 1777.8 | 1951.6 | 1951.6 | 1597.3 |
| `rules` guard | 4 | 1675.4 | 3657.8 | 4659.2 | 4659.2 | 3629.1 |

Incremental `O(ΔL)` KV reuse cut median latency by **3.0x** (`553.6 ms` p50 vs. `1,663.0 ms` cold p50) with `100%` (`12/12`) delta cache hits across multi-turn scrubbed sessions (average `741.8` prefix tokens, `615.3` delta tokens).

## Takeaways & Next Benchmark Uses

1. **Zero false alarms on clean field traffic**: `Warden-S1-752M` held `0 / 33` clean cases (`0 / 16` trajectory steps) across `action`, `output`, `stuck`, and `rules`, while catching `7 / 8` (`87.5%`) self-contained historical positive catches and releasing `5 / 8` (`62.5%`) historically overridden false holds.
2. **Subtle regretted-allow gap (`0 / 8`)**: Historical `regretted` allows were non-destructive routine-looking commands whose harm depended on user preference or broader project context not encoded in single-action irreversibility probes. Tracking this slice across future checkpoints gives a direct regression signal for preference-aware or multi-turn supervision.
3. **Reproducing**:
   ```bash
   npm run build
   node scripts/s1-field-replay.mjs --pack --out ~/.pi/agent/pi-warden-evals/warden-s1-field-2026-11-26
   node scripts/s1-field-replay.mjs --run --pack-dir ~/.pi/agent/pi-warden-evals/warden-s1-field-2026-11-26 --budget 60 --report-dir eval/reports/2026-11-26-warden-s1-field-replay
   ```
