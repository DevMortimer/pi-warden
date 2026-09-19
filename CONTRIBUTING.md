# Contributing to pi-warden

Thank you. Complaints are as useful as code: a steer that annoyed you is calibration data.

## Report

- **A steer or hold was wrong.** Use the "A steer or hold was wrong" issue template. Paste the steer text (it contains no command), what you were doing, and whether you approved, ignored, or re-planned. The `/warden trace` lines for that call help.
- **A bug.** Use the "Bug" template with `/warden status` output, the Pi and pi-warden versions, and the smallest sequence that reproduces it.
- **Security.** Do not open a public issue for a way to make pi-warden leak a secret or run a held command. Email the maintainer (address in `package.json`).

## Change

1. `npm install`, then `npm run check` (typecheck, offline tests with a mocked transport, build). It must pass before and after your change.
2. Behaviour changes come with tests in `tests/`. The fake judge in `tests/extension.test.ts` answers every question from `nextAnswers`, so a new question needs no network to test.
3. Live scripts (`npm run test:live`, `scripts/*-cases.mjs`, `scripts/calibrate-action.mjs`) send billable requests to TypeSafe. Run them on purpose, with your own key, and paste the summary line in the PR when a change touches question wording or thresholds.
4. Match the surrounding style: small functions, comments that say why, no restating the code.

## Rules the code keeps

- **A new Jev question ships with a measurement.** Add it to `scripts/action-candidates.mjs` (or the guard's `*-cases.mjs` set), run it, and put the numbers in the PR and the Calibration section of `docs/guards.md`. An unmeasured question can be merged as `extra` (recorded, never acted on), not as a rule. See `docs/guards.md` → Calibration for the method.
- **Steers never hold.** Three things block a call: a destructive pattern, a `deny` command rule (blocked outright, no dialog), or `irreversible` at 0.7 or above. Off-task, plan mismatch, slop, rules, and security notices tell the agent and let the call run.
- **Approval comes from the user's message only.** Assistant text explains a call; it cannot approve one.
- **Nothing that leaves the machine or lands in the trace carries a command, a path the user did not show, or a secret.** `redact()` before sending; reasons name patterns and scores. `docs/data-handling.md` must stay true after your change.
- **Fail open, say so.** A TypeSafe error allows the call with a warning (`failOpen`); it never crashes a hook.
- **Config is additive.** New keys get a default in `defaultConfig()`, a fallback in `shape.ts`, and one line in `docs/configuration.md`.

## Commits and pull requests

- One change per commit, with a message that says what changed and why. No tool or AI attribution lines.
- Keep a PR to one topic. Update the README or the matching `docs/` file in the same PR when behaviour or config changes.
- Releases are cut by the maintainer, about weekly; do not bump `package.json` in a PR.

## Where to ask

Issues here, or the Pi and TypeSafe Discord servers. Be specific and kind; critique the code, not the person.
