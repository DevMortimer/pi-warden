# pi-warden

Harness guardrails for [Pi](https://pi.dev), built on [pi-typesafe](https://github.com/DevMortimer/pi-typesafe). Before the agent runs a `bash`, `write`, or `edit` call, pi-warden checks it twice: a fast offline pattern pass for the obvious hazards, then one TypeSafe (Jev) request that scores how **irreversible** and how **off-task** the action is relative to your latest request. High scores open a confirm dialog; you decide, and a declined call is blocked with a short reason the agent can act on.

Independent project. Not affiliated with TypeSafe AI or the Pi authors.

![Pi asking for confirmation before a destructive command, with pi-warden's irreversible and off-task scores in the dialog](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/preview.png)

## Install

```bash
pi install npm:pi-typesafe   # provides /typesafe login and the shared key store
pi install npm:pi-warden
```

Requires Pi 0.85 or newer and Node.js 22.19 or newer. Pattern checks work with no account. Jev judgments need a TypeSafe API key and are billed to your TypeSafe account (a judgment is roughly 600 input tokens; output is free).

## Setup

1. Run `/typesafe login` once and paste your key (or set `TYPESAFE_API_KEY`). pi-warden reads the same stored key; it never handles or displays the value.
2. Run `/warden enable`, read the data notice, and confirm. Consent is saved to `~/.pi/agent/pi-warden/config.json`, so it survives restarts until you run `/warden disable`.
3. Optionally run `/warden test` to see one synthetic verdict.

Without step 2, pi-warden still guards with offline pattern checks only.

## What it does on each guarded call

1. **Skip** read-only tools, and read-only shell lines such as `git status && ls` (no network, no widget).
2. **Pattern pass** (offline): force pushes, `git reset --hard`, `git clean -f`, recursive `rm` on absolute/home/variable/parent paths, SQL `DROP`/`TRUNCATE`/`DELETE FROM`, block-device writes, `chmod -R 777`, fork bombs, `curl | sh`, `kill -1`, shutdown, package publishing, infrastructure destroys → **confirm**. `rm -rf` on a project path, `git checkout -- .`, `git branch -D`, `git stash drop`, `find -delete`, `sudo` → **warn**. Reads or writes of `.env`, SSH, AWS, npm, kube, and other credential files → **warn**. A `write` that overwrites an existing file outside the project → **confirm**; creating or editing outside the project → **warn**.
3. **Jev judgment** (with consent): one request with the state `{ task, action }` and three questions — `irreversible` (Noul), `off_task` (Noul), `scope` (Choice: expected step, plausible side step, unrelated, unclear). Defaults: irreversible ≥ 0.5 warns, ≥ 0.7 confirms; off-task ≥ 0.6 warns, ≥ 0.85 with `unrelated` confirms. Pattern results set the floor; Jev can only raise it.
4. **Act**: allow silently, warn with a notification, or ask with `ctx.ui.confirm`. The widget above the editor shows the last verdict, for example `warden · bash · irreversible 0.84 · off-task 0.86 · unrelated · confirm`.

Headless runs (`pi -p`, JSON mode) cannot ask, so a confirm-level call is **blocked** unless `PI_WARDEN_HEADLESS=allow` or `"headless": "allow"` is set. Consent in headless runs comes from `PI_WARDEN_ENABLED=1`.

If TypeSafe cannot answer (timeout after 5 s, outage, budget), the call is allowed with a warning (`failOpen: true`). Set `failOpen` to `false` to ask instead. When the per-session request budget is spent, pi-warden says so once and continues with pattern checks.

## Commands

| Command | Effect |
| --- | --- |
| `/warden status` | Guard state, consent source, key source, session counts, thresholds, config paths, last verdict |
| `/warden enable` | Show the data notice and save consent for Jev judgments |
| `/warden disable` | Stop Jev judgments; pattern checks continue |
| `/warden config` | Edit the user config JSON in Pi's editor and save it |
| `/warden test` | Evaluate one synthetic destructive action and show the verdict |

## Configuration

User file `~/.pi/agent/pi-warden/config.json` (owner-only). Missing keys use these defaults:

```json
{
  "enabled": true,
  "typesafe": false,
  "headless": "block",
  "action": {
    "enabled": true,
    "tools": ["bash", "write", "edit"],
    "failOpen": true,
    "timeoutMs": 5000,
    "maxRequests": 500,
    "irreversible": { "warn": 0.5, "confirm": 0.7 },
    "offTask": { "warn": 0.6, "confirm": 0.85 }
  }
}
```

A project may add `.pi/pi-warden.json` with `enabled` and `action` overrides (for example stricter thresholds or extra guarded tools). Project files are read only when Pi trusts the project, and they can never grant `typesafe` consent or change `headless`. Environment: `PI_WARDEN_ENABLED=1` (consent), `PI_WARDEN_HEADLESS=allow|block`.

## Data handling

- With consent, each guarded call sends to `https://api.typesafe.ai`: your latest prompt (truncated to 1500 characters), the tool name, the command (truncated to 2000 characters) or the file path (relative inside the project, `~`-shortened outside), whether the file exists, a 600-character content excerpt for `write`, and the first three edit pairs (200 characters each) for `edit`. No other files, history, or telemetry.
- Obvious credentials in the action (`Authorization` headers, `TOKEN=`/`SECRET=` assignments, `sk-`, `ghp_`, `AKIA`, JWTs, URL passwords, PEM blocks) are replaced with `[redacted]` before sending. This is best-effort; do not rely on it for prompts that contain secrets.
- The block reason returned to the agent names the tool and the reasons, not the command text. UI errors never include upstream response bodies or keys.
- Judgments are model output. Thresholds are yours to tune; the dialog is the decision.

## For extension authors

The guard is a plain function you can call from your own extension or tests, with any object that has pi-typesafe's `evaluate` method as the judge:

```ts
import { evaluateAction, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge: createTypeSafe() },   // omit judge for pattern checks only
);
verdict.level;      // "allow" | "warn" | "confirm"
verdict.reasons;    // ["destructive: git force push", "irreversible 0.91"]
verdict.judgment;   // { irreversible, offTask, scope, scopeConfidence, model, elapsedMs }
```

Also exported: `matchPatterns`, `isReadOnlyCommand`, `describeAction`, `redact`, `formatVerdict`, `questions`, and the config helpers.

## Development

```bash
npm install
npm run check        # typecheck, offline tests (mocked transport), build
npm run test:live    # nine billable synthetic judgments against api.typesafe.ai (key from .env or /typesafe login)
npm run dev:pi       # start Pi with this working tree plus an installed pi-typesafe
```

## License

MIT
