# pi-warden

You are working on pi-warden, a Pi extension that enforces project rules against the agent at the moment it acts. The rules this project keeps are in `pi-warden.md`. Read it before making changes.

## Version bumps and changelogs

This is the release protocol. Follow it exactly.

### The rule

**The very last commit on every PR is the version bump commit.** This commit does two things
and nothing else:

1. Bumps the version in `package.json`.
2. Renames the `## Unreleased` heading in `CHANGELOG.md` to `## X.Y.Z` and adds any release
   notes that belong to this version.

PRs are squash-merged, so the squashed commit on `main` carries both the feature work and its
version bump as one atomic unit.

### How to decide the version

Follow semver. For a 0.x project the conventions are:

| Change type | Bump |
| --- | --- |
| New feature, new guard, new config key, anything that changes the public API or behaviour | **minor** (0.25 → 0.26.0) |
| Bug fix, threshold tuning, docs-only, internal refactor with no API change | **patch** (0.25.0 → 0.25.1) |
| Breaking change: removed config key, changed export signature, changed guard semantics | **major** (0.25 → 1.0.0, or minor if still pre-1.0 and acceptable) |

When in doubt, minor is the right answer. This project moves fast and is still pre-1.0.

### Never commit with unstaged or uncommitted changes

Before committing, run `git status`. If there are unstaged or untracked files, do **not**
commit until you understand what each change is and have decided whether it belongs in this
commit. A dirty tree means something was missed or forgotten. Stage deliberately, not in bulk.

### After merging main

If main was bumped while your PR was in flight (e.g. another PR merged with its own version
bump), the merge brings that new version into your branch. **Your fix still needs its own
bump** — merge main, then bump again. A bug fix on top of 0.26.0 is 0.26.1, not 0.26.0.
The CHANGELOG entry for your fix goes under the new version heading, not under the one the
merge brought in.

### Step by step

1. All feature/fix commits land on the PR branch. Under `CHANGELOG.md`, entries go under
   `## Unreleased` with the appropriate subsection (`### Added`, `### Changed`, `### Fixed`,
   `### Tests`, `### Docs`).

2. The last commit on the PR — the bump commit — does this:

   **package.json:**
   ```json
   "version": "X.Y.Z"
   ```

   **CHANGELOG.md:**
   ```markdown
   ## Unreleased

   <!-- Empty. Next release starts here. -->

   ## X.Y.Z

   ### Added
   - What shipped in this version.

   ### Changed
   - What changed.

   ## 0.25.0
   ...
   ```

   The `## Unreleased` section stays at the top, empty or with future-planning notes.
   The old `## Unreleased` content moves under the new version heading.

3. The commit message for the bump commit:
   ```
   chore: version bump to X.Y.Z
   ```
   Optionally add `, finalize CHANGELOG` or `, sync CONTRIBUTING.md` if those files also
   changed in this commit.

4. Push the branch. The PR is ready to squash-merge.

5. Squash-merge on GitHub — never locally:
   ```
   gh pr merge <number> --squash --delete-branch
   ```
   This closes the PR on GitHub, squash-merges to `main`, and deletes the remote branch
   in one step. Do **not** `git merge --squash` locally and delete the branch by hand —
   that marks the PR as closed (not merged) on GitHub.

6. After merge, pull and tag:
   ```
   git checkout main && git pull origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

### What the bump commit does NOT do

- Does not run `npm version` (that creates its own commit and tag; we manage both manually).
- Does not touch `dist/` (that is built by `npm run build` / `prepack` at publish time).
- Does not publish to npm (that is a separate manual step: `npm publish`).
- Does not change any source code, tests, or behaviour. It is a bookkeeping commit only.

### Example (from the repo history)

```
953d9b9 chore: version bump to 0.24.0, finalize CHANGELOG, sync CONTRIBUTING.md
```

This commit bumped `package.json` from 0.23.0 to 0.24.0, renamed `## Unreleased` to
`## 0.24.0` in the changelog, and synced a CONTRIBUTING.md paragraph. It was the last
commit on PR #9.

## Development

```
npm install                     # install dependencies
npm run check                   # typecheck + build + offline tests (must pass)
npm run test                    # offline tests only
npm run test:live               # live tests against TypeSafe (costs real judgments)
npm run dev:pi                  # start Pi with this working tree
npm run eval:ab -- --dry-run    # list benchmark batch without spending tokens
npm run eval:ab                 # run A/B benchmark (costs real tokens per task)
npm run preview                 # render the preview image
```

`npm run check` is the gate. It must pass before and after every change.

## Architecture

```
extension.ts          ← Pi hook entry; wires all guards, handles steers and notices
  ├─ config.ts        ← loadConfig, defaultConfig, thresholds, project/user overrides
  ├─ guard.ts         ← action guard (irreversible, off-task, intent mismatch, command/path rules)
  ├─ done.ts          ← done-check: catches unverified "done" claims
  ├─ stuck.ts         ← stuck-loop detector: three failures, same strategy
  ├─ trace.ts         ← trace panel, verdict recording, clip/percent formatters
  ├─ trace-file.ts    ← JSONL trace for hosts that run Pi without a terminal UI
  ├─ prose.ts         ← slop detection: restating comments, hedging, stubs
  ├─ widget.ts        ← status-line rendering, templates
  ├─ widget-render.ts ← status-line TUI component
  ├─ panel.ts         ← TUI panel logic
  ├─ tools.ts         ← commandOf and tool classification helpers
  ├─ build-info.ts    ← the running build's version, commit, build time, and staleness
  └─ redact.ts        ← strip secrets and paths from anything that leaves the machine
```

The only runtime dependency is `pi-typesafe` (the Jev judge). `@earendil-works/pi-coding-agent`
and `@earendil-works/pi-tui` are optional peer dependencies. The library has no dependency on
Pi's runtime, so every guard is safe to call in tests.

## How the guards work

| Guard | What it watches | What it does |
| --- | --- | --- |
| **Rules** | every `write` and `edit` | Judges written code against `pi-warden.md` and names the violated rule |
| **Slop** | written code and final replies | Names stubs, restating comments, dead code, hedging, padded replies |
| **Stuck** | tool results | Notices three failures with the same strategy and asks for a new hypothesis |
| **Done-check** | the final message | Catches "done" claims after code changes when no test, build, or lint passed |
| **Context saver** | large or repeated tool output | Keeps the exact lines that matter, stores the rest in a file |
| **Action** | every `bash`, `write`, `edit` before it runs | Holds irreversible calls, steers back on off-task or intent-mismatch |
| **Security** | written code and tool output | Flags hardcoded secrets, disabled TLS, unsafe interpolation |
| **Runaway** | the reply stream | Stops a reply that repeats the same block over and over |
| **Steer budget** | the agent's attention | Bounds steers per run; repeats past budget are recorded, not re-sent |
| **Subagent triage** | async child reports | Jev decides whether a child report is worth waking the agent for |

## Configuration

User config lives at `~/.pi/agent/pi-warden/config.json` (under Pi's agent directory). Project
overrides go in `.pi/pi-warden.json` at the project root; some keys are user-file only (command,
deny, exempt, path, and arming rules; `action.floor`; `mode`; `steerBudget`). The config is
additive: every key in `defaultConfig()` is a valid override. See `docs/configuration.md` for
the full key reference.

## For extension authors

Every guard is a plain function. Call it with any object that has pi-typesafe's `evaluate`
method as the judge:

```ts
import { evaluateAction, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge: createTypeSafe() },
);
```

The rules guard, the session-level `ActionGuard` and `RulesGuard`, and other exports are
documented in `docs/extension-authors.md`.

## Publishing

After the bump commit is on `main`:

1. `git pull origin main`
2. `npm run check` (verify clean)
3. `npm publish`
4. `git tag vX.Y.Z && git push origin vX.Y.Z`

The `prepack` script runs `npm run build` automatically, so `dist/` is always fresh.

## Where to ask

Issues on GitHub, or the Pi and TypeSafe Discord servers. Be specific and kind; critique the
code, not the person.
