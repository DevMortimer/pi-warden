# pi-warden

**Stop babysitting your coding agent.**

pi-warden supervises Pi while it works, catching risky actions, ignored rules, stuck loops, unverified "done" claims, security issues, runaway output, wasted context, and more.

Instead of interrupting you for every problem, Warden usually feeds the issue back to the agent so it can correct itself and keep going.

![Real verdicts from pi-warden: the same command gets a different verdict depending on what the user asked for](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/preview.png)

## Install

```bash
pi install npm:pi-warden
```

1. `/warden enable` to activate. Paste a key from [console.typesafe.ai](https://console.typesafe.ai) if you have one (hidden input, saved owner-only), or skip for offline-only mode.
2. `/warden test` to see one synthetic verdict.
3. Work as usual. Status line shows verdicts; `ctrl+shift+w` opens the trace sidebar.

Works without any key (offline guards: pattern list, runaway stop, sensitive-path notes, credential warnings). Requires Pi 0.85+, Node 22.19+.

## What Warden catches

| Guard | Watches | Does |
| --- | --- | --- |
| **Action** | `bash`, `write`, `edit` before run | Holds irreversible calls, records trace-only off-task findings |
| **Rules** | every `write` and `edit` | Judges against project Markdown rules, quotes the broken rule |
| **Slop** | code and replies | Names stubs, restating comments, dead code, hedging |
| **Stuck** | tool results | Repeated failures using the same strategy |
| **Done-check** | final message | "Done" claims with no test/build/lint behind them |
| **Security** | code and output | Hardcoded secrets, injection risks |
| **Runaway** | reply stream | Stops replies that begin repeating themselves |
| **Subagent triage** | async child reports | Keeps noisy background work from waking the parent |

## How intervention works

1. **Read-only? Skip.** `git status`, `ls`, `read` means no request and no trace entry.
2. **Known-dangerous pattern? Catch it locally.** Force push, `git reset --hard`, recursive `rm`, SQL `DROP` held instantly.
3. **Needs judgment?** Warden evaluates the action in context.
4. **Steer or hold.** Most issues go back to the agent so it can correct itself. Irreversible actions can be stopped before they run.

In the default `steer` mode, Warden talks to the agent rather than interrupting you. `confirm` asks you directly; `advise` never blocks.

## More than guardrails

- **Learns from holds**, tracking outcomes and recommending policy changes via `/warden recommend`.
- **Custom policies**: command, path, and arming rules for your own workflow.
- **Context saver** trims oversized tool output while keeping the full result retrievable.
- **Multiple judgment backends**: TypeSafe by default, with OpenRouter support.
- **Full traceability**: inspect what Warden saw, decided, and told the agent.
- **Desktop alerts** for events that need you.

## Custom rules

Put `pi-warden.md` at the project root. Each heading is one rule:

```markdown
# No console statements
Code must not contain `console.log` or `console.debug`. Use the logger.

# Exported functions must have explicit return types
paths: src/**/*.ts
Every exported function declares its return type.
```

Jev judges every write and quotes violations back. Rules can be things no linter checks: "a TODO must name a ticket", "comments must not restate the code". Without `pi-warden.md`, the first of `README.md`/`CLAUDE.md`/`AGENTS.md` is judged instead. [Examples and config details.](docs/configuration.md)

## Does it actually help?

In 150 paired agent runs, the control setup violated the tested project rule **6 times**. With Warden: **0**.

An overnight stability run covered **13,952 guard cases across 109 cycles** with no score drift.

These are project-maintained benchmarks, not universal claims. Raw reports and reproducible eval tooling are in the repo.

### Does it get in the way? Measured, not promised.

**3 holds per 1,000 calls. The other 997 run.** Across 315 recorded sessions and 18,075 guarded calls, the action hold fired 48 times, each for an action that is hard to undo. On the maintainer's machine, 452 allowed calls have run since outcome tracking began and not one was regretted afterward. When a hold was wrong, one retry cleared it: 2 of 13 labeled holds stood, the other 11 cleared on retry. The 27 calls the maintainer later regretted in the replay were ordinary edits and commits, not the kind a pre-call hold can see coming; those belong to the rules guard, the done-check, and the regret label, which are measured too. Snapshot numbers: `scripts/hold-stats.mjs` refreshes them, and the full replay is in [`eval/reports/2026-09-21-calibration-0.33.3/`](eval/reports/2026-09-21-calibration-0.33.3/).

[See the evals ->](eval/reports/)

## Privacy

Depending on the configured judgment backend, Warden sends to your provider: a redacted summary of each guarded call, the agent's plan, up to eight redacted prior messages, and redacted tool-output samples. Secrets are stripped before anything leaves the machine. [Full details.](docs/data-handling.md)

## Documentation

- [docs/guards.md](docs/guards.md): every guard, thresholds, calibration, Jev questions
- [docs/configuration.md](docs/configuration.md): all config keys, defaults, status line templates
- [docs/commands.md](docs/commands.md): command reference
- [docs/faq.md](docs/faq.md): cost, permissions, headless CI, project overrides
- [docs/data-handling.md](docs/data-handling.md): what leaves the machine, what stays
- [docs/examples.md](docs/examples.md): real session examples
- [examples/](examples/): starter rules file, both config files

## Development

```bash
npm install
npm run check          # typecheck + offline tests + build
npm run test:live      # live tests (costs real judgments)
npm run eval:ab        # A/B benchmark (costs real tokens)
```

## License

MIT
