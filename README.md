<div align="center">

# pi-warden

**Your coding agent says "done". It didn't run the tests.**<br>
**pi-warden catches it, and the agent fixes it without you.**

[![npm](https://img.shields.io/npm/v/pi-warden?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-warden)
[![downloads](https://img.shields.io/npm/dm/pi-warden?color=blue)](https://www.npmjs.com/package/pi-warden)
[![stars](https://img.shields.io/github/stars/DevMortimer/pi-warden?style=flat&logo=github)](https://github.com/DevMortimer/pi-warden/stargazers)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Pi](https://img.shields.io/badge/Pi-0.85%2B-8a2be2)](https://github.com/earendil-works/pi)
[![judged by Jev](https://img.shields.io/badge/judged%20by-Jev-orange)](https://typesafe.ai)

</div>

![pi-warden tells the agent what it got wrong and the agent fixes it: 65 untested "done" claims, 51 then ran the tests, 5 found a failure it had missed; after a hold the agent found a safer way 33 times](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/hero.png)

<div align="center">

**759 sessions · 220 risky actions stopped before they ran · 76% of fake "done"s turned into real test runs**

<sub>Nine days of the maintainer's real use across all their projects, not just this one, 2026-09-16 to 2026-09-24. Method and noise: [field report](eval/reports/2026-09-24-field-usage/).</sub>

</div>

## Install

```bash
pi install npm:pi-warden
```

Then `/warden enable` (paste a [TypeSafe](https://console.typesafe.ai) key) and `/warden init` (writes a starter `pi-warden.md`). That's it. No key? The offline guards still run.

## It steers. It doesn't nag.

Most guardrails stop and ask you. pi-warden tells **the agent** what it got wrong, and the agent corrects itself. You are pulled in only when something can't be undone: **3 holds per 1,000 calls. The other 997 just run.**

| Your agent… | pi-warden… |
| --- | --- |
| says "done" with no test, build, or lint behind it | sends it back to prove it |
| breaks a rule in your `pi-warden.md` or `AGENTS.md` | quotes the exact rule it broke |
| is about to `git push --force`, `reset --hard`, `rm -rf`, `DROP` | holds it before it runs |
| retries the same failing fix for the third time | asks for a new hypothesis |
| writes stubs, restating comments, hardcoded secrets | names them on the spot |
| floods its context with a 40k-line log | keeps the lines that matter, stores the rest |
| starts repeating itself forever | stops the reply |

[Every guard, with its thresholds and calibration →](docs/guards.md)

## Rules no linter can check

```markdown
# A TODO names a ticket
A bare `TODO` or `FIXME` without a ticket reference is a violation.

# Errors never reach the user raw
paths: src/api/**/*.ts
Catch errors at the handler and return a message a user can act on.
```

Each `#` heading is one rule. Every write and edit is judged against it in about a quarter of a second by [Jev](https://typesafe.ai), a model that returns a probability, not prose. No `pi-warden.md`? Your `AGENTS.md`, `CLAUDE.md`, or `README.md` is used instead.

## Receipts

- **Rules:** in 150 paired agent runs, the agent without pi-warden broke the tested rule **6 times**. With it: **0**.
- **Done-check:** after a nudge, the agent ran a check **57 of 75** times, and sometimes found a failure it had missed.
- **Holds:** when the agent was stopped, it found a safer way **40 of 65** times; you approved 24.
- **Stability:** 13,952 guard cases over 109 overnight cycles, no score drift.

Every number has a script and a raw report in [`eval/reports/`](eval/reports/). They are the maintainer's measurements, not a universal promise, and the reports list what was noise.

## Privacy

Secrets and unshown paths are stripped before anything leaves your machine. [Exactly what is sent →](docs/data-handling.md)

## Docs

[Guards](docs/guards.md) · [Configuration](docs/configuration.md) · [Commands](docs/commands.md) · [FAQ](docs/faq.md) · [Data handling](docs/data-handling.md) · [Examples](docs/examples.md)

## Development

```bash
npm install
npm run check        # typecheck + offline tests + build
```

MIT licensed.
