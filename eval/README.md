# A/B benchmark

Measures whether pi-warden improves the code an agent produces, against the honest
null hypothesis: the same rules handed to the model as prose.

- `fixture/`: a zero-dependency repo. `AGENTS.md` carries five rules as prose;
  `pi-warden.md` carries the same five for the warden cell.
- `tasks.mjs`: five tasks. Each ships a pre-written failing test plus a prompt that
  tempts one rule violation, designed so the shortcut passes the tests and only the
  violation checker can tell it apart from the compliant fix.
- `check.mjs`: mechanical violation checker over the agent's diff. Shares no code
  with the guard on purpose: no Jev verdict can influence a score.
- `reports/`: committed `report.md` + `runs.json` per run batch. Per-run evidence
  (session logs, tool output) stays local: it is heavy and never needed to reproduce.

Run: `npm run eval:ab -- --repeats 5` (add `--provider X --model Y` to pick the model;
omitted, it uses pi's default). One cell per run gets an isolated `PI_CODING_AGENT_DIR`
seeded with your provider credentials and exactly one extension, pi-warden, so the
two cells differ by that extension alone.

Interpretation rules: quote the report folder next to every claim; negatives stay in
the table; a claim that does not survive a re-run on your model gets rewritten.
