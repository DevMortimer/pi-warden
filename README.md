# pi-warden

Makes the [Pi](https://pi.dev) agent follow your project's rules. An `AGENTS.md` asks the model to remember; pi-warden checks. On every write and edit, [Jev](https://typesafe.ai) judges the change against the rules in your `pi-warden.md` (about 250 ms, a fraction of a cent) and the violated rule is quoted back into the agent's own context. The same channel names slop, breaks retry loops, calls out "done" when no test ran, keeps large tool output small, and holds the rare destructive command. You keep working; the agent gets a nudge instead of you getting a dialog.

![Real verdicts from pi-warden: the same command gets a different verdict depending on what the user asked for](https://raw.githubusercontent.com/DevMortimer/pi-warden/main/docs/preview.png)

The verdicts above are real output from `npm run test:live`. Independent project; not affiliated with TypeSafe AI or the Pi authors. Built on [pi-typesafe](https://github.com/DevMortimer/pi-typesafe).

## In one minute

```bash
pi install npm:pi-warden
```

Then, inside Pi:

1. `/warden enable`. Read the data notice and confirm. If no key is stored yet, paste one from [console.typesafe.ai](https://console.typesafe.ai) (hidden input, saved owner-only, shared with pi-typesafe).
2. `/warden test` shows one synthetic verdict and what the agent would be told.
3. Work as usual. The line above the editor shows the latest verdict; `ctrl+shift+w` opens the trace with the scores and the exact text the agent received.

Requires Pi 0.85 or newer and Node.js 22.19 or newer. No key yet? Install anyway: the offline parts (pattern list, runaway stop, duplicate output notes, sensitive-path notes, credential-shape warnings) run without one. The [examples folder](examples/README.md) has a starter rules file and both config files.

## What it watches

| Guard | Watches | Does |
| --- | --- | --- |
| **Rules** | every `write` and `edit` | judges the written code against your project's Markdown rules (`pi-warden.md`) and names the violated rule to the agent |
| **Slop** | written code and final replies | names stubs, restating comments, dead code, hedging, padded replies; the agent fixes them in the next edit |
| **Stuck** | tool results | notices three failures with the same strategy and asks for a new hypothesis |
| **Done-check** | the final message | catches "done" claims after code changes when no test, build, or lint passed |
| **Context saver** | large or repeated tool output | keeps the exact lines that matter, stores the rest in a file, points recalls at a search |
| **Action** | every `bash`, `write`, `edit` (and context-mode's `ctx_execute*`) before it runs | holds irreversible calls and tells the agent why, so it re-plans or asks you; steers it back when a change is unrelated to your request |
| **Security** | written code and tool output | flags hardcoded secrets, disabled TLS, unsafe interpolation; marks injected instructions in tool output |
| **Runaway** | the reply stream | stops a reply that repeats the same block over and over (code only, no request) |
| **Notifications** (opt-in) | moments that need you | desktop notification for a held call, a confirm dialog, a runaway stop |

Three jobs, one channel: keep the agent on your rules, keep slop out of the code and the replies, keep the context small. The action guard is the seatbelt underneath: on 17,000 recorded calls it held 42 times. Everything arrives through the agent's own context, so the agent gets smarter and you are not the approval button. Full detail per guard, with thresholds and tuning numbers, is in [docs/guards.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md).

## Four moments from real sessions

All four are from my own work sessions, taken from the session logs. Project names are redacted, paths shortened, secrets replaced. The first three are the everyday kind; the last is the rare one.

### It quoted a project rule back, and the agent fixed it in the next turn

The project's `pi-warden.md` has a rule "No hardcoded secrets": connection URLs come from settings or the environment. The agent wrote a demo script with the local database DSN as a fallback default.

```text
assistant
  [write] scripts/demo_rail_decisions.py   (186 lines)
    DSN = os.getenv(
        "SUPABASE_DB_URL", "postgresql://[local default]"
    )

pi-warden (steer message to the agent)
  pi-warden: the content just written to scripts/demo_rail_decisions.py violates
  project rule from pi-warden.md: "No hardcoded secrets" (0.88): Source and config
  code must not contain passwords, API keys, tokens, or connection URLs (including
  Supabase DSNs and `FLY_API_TOKEN` values). They come from settings
  (`utils/config.py`) or the environ… [77 more chars]. Fix it in your next edit.

assistant
  The warden flags the hardcoded local DSN. Right call. Making the script require
  `SUPABASE_DB_URL` from the environment instead:
    DSN = os.getenv("SUPABASE_DB_URL")
    if not DSN:
        sys.exit("Set SUPABASE_DB_URL to the local stack's DB_URL (supabase status)")
```

The rule is three lines of Markdown in the repo. No linter knows what a Supabase DSN looks like in a default argument; Jev does, and the agent got the rule text, not a red X.

### It caught a placeholder the agent had already told itself to remove

The agent's own reasoning said "clean that up (NO DEAD CODE)". Two edits later the placeholder test was still in the file.

```text
assistant (thinking)
  I left a junk placeholder test in there. Clean that up (NO DEAD CODE). Remove the
  placeholder test entirely and keep only the corrected one.
assistant
  [edit] tests/services/supabase/test_resolve_rung_multi_manager.py  (2 blocks)
tool result
  Successfully replaced 2 block(s) in tests/services/supabase/test_resolve_rung_multi_manager.py.

pi-warden (steer message to the agent)
  pi-warden: the content just written to tests/services/supabase/test_resolve_rung_multi_manager.py
  has dead or duplicated code; hedging or vague notes; stub or placeholder code where a
  working implementation is needed. Fix it in your next edit: remove commented-out code,
  unused imports and variables, duplicated logic, and unreachable branches; ...

  pi-warden: the content just written to ... in edit 2 (starting "await apply_decision(...")
  violates project rule from pi-warden.md: "No partial implementations" (0.73): A comment
  or docstring that says "simplified for now", "temporary", "for now just", ... Fix it in
  your next edit.

assistant
  You're right. I kept the placeholder instead of deleting it. Removing it outright and
  factoring the duplicated sit/task/cfg into one helper:
  [edit] tests/services/supabase/test_resolve_rung_multi_manager.py  (1 block)
tool result
  Successfully replaced 1 block(s) in tests/services/supabase/test_resolve_rung_multi_manager.py.
```

The model knew the rule. Knowing is not the same as checking. The slop questions ride on the same request as the action guard, so this cost no extra round trip.

### It broke a retry loop

The agent was renaming a reference across two test files but kept sending every edit to one of them. Two of the three failures are shown.

```text
assistant
  [edit] tests/canon/test_message_registry_seed_matches_snapshot.py  (2 blocks)
tool result
  Could not find edits[1] in tests/canon/test_message_registry_seed_matches_snapshot.py.
  The oldText must match exactly including all whitespace and newlines.

assistant
  [edit] tests/canon/test_message_registry_seed_matches_snapshot.py  (3 blocks)
tool result
  Could not find edits[2] in tests/canon/test_message_registry_seed_matches_snapshot.py. ...

pi-warden (steer message to the agent)
  pi-warden: 3 failures with the same strategy (0.74), approach change 1.6/2,
  progress 0.63. Stop retrying. Re-read the last error output carefully, state a
  new hypothesis about the cause, and either gather the missing information (read
  the relevant file, check versions or paths) or try a different method. If two
  different methods have failed, report the blocker to the user with the exact
  error instead of trying again.

assistant (thinking)
  The warden says stop retrying the same strategy. I passed
  path = test_message_registry_seed_matches_snapshot.py but edit #3's oldText was
  from tests/db/test_message_registry_atomic_save.py. That's the bug. Fix: apply
  edit #3 to the db test file, edits 1-2 to the seed test.

assistant
  The failing edit was mis-targeted. Splitting them correctly.
  [edit] tests/canon/test_message_registry_seed_matches_snapshot.py  (2 blocks)
  [edit] tests/db/test_message_registry_atomic_save.py  (1 block)
tool results
  Successfully replaced 2 block(s) in tests/canon/test_message_registry_seed_matches_snapshot.py.
  Successfully replaced 1 block(s) in tests/db/test_message_registry_atomic_save.py.
```

The steer names the pattern (same strategy, no progress) and what to do instead. The agent read its own error properly on the next turn.

### It held a database reset, and the agent finished everything else first

A feature branch with a migration. The agent decided to replay the local database. `supabase db reset` is a legitimate local command in that repo, but it wipes local state, and nobody had asked for it.

```text
assistant
  [bash] cd .claude/worktrees/con-142 && supabase db reset 2>&1 | tail -6

tool result (written by pi-warden; the command did not run)
  pi-warden held this bash call before it ran: irreversible 0.85. Do not retry it
  unchanged. Either (1) reach the goal with a recoverable alternative that stays
  inside the project (a targeted path, a dry run, a move instead of a delete, a
  normal push), or (2) if this exact action is genuinely required, stop and tell
  the user in one or two sentences what it does, what cannot be undone, and why
  it is needed, then wait for their reply. If the user's reply approves it, retry
  the same call and pi-warden will let it through.

assistant
  The warden held `supabase db reset`. It's the sanctioned local-stack replay
  (loopback docker only, no dev/prod reach), but I'll pause that step and ask at
  the end of this update. Continuing with lanes that don't need it:
  [bash] uv run pytest tests/canon tests/services/messaging ...   92 passed in 24.80s
  ... ruff, commit, push, draft PR ...

assistant (final message, about 16 tool calls later)
  Draft PR is up and the work is committed and pushed. One decision is pending
  for you. PR: redacted#2640 (draft) ...
```

No dialog, no interruption. The agent moved the risky step to the end and asked in one sentence.

## How it decides

Every guarded call (`bash`, `write`, `edit`, and shell-like tools such as context-mode's `ctx_execute`) goes through four steps:

1. **Read-only? Skip.** `git status && ls` or a `read`: no request, no line in the trace.
2. **Pattern list, offline.** Force push, `git reset --hard`, recursive `rm` outside the project, SQL `DROP`/`TRUNCATE`/`DELETE FROM`, `curl | sh`, publishing, infrastructure destroys: the call is held. Risky but recoverable things (`rm -rf` on a project path, `sudo`, `--no-verify`, `gh pr merge`, touching `.env`) warn. Text that is data, such as a commit message that mentions `git push --force`, is not a command.
3. **Jev, with your consent.** One request carries your request, up to eight earlier messages, the agent's own words right before the call (its plan), and the call itself. Jev answers fixed questions with probabilities: is it irreversible, is it off task, does it change anything, how does it relate to the task, does it contradict the plan, is the effect visible outside the working tree. On a write, the slop and security questions ride along; the rules check is a second request sent in parallel. About 250 ms before the tool runs.
4. **Act.** Only two things hold a call: a destructive pattern, or `irreversible` at 0.7 or above. Everything else (off task, plan mismatch, slop, a rule violation, a security smell) tells the agent and lets the call run.

In the default `steer` mode a hold goes back to the agent as its tool result with two acceptable next moves: find a recoverable way, or explain the action to you in a sentence and wait. If your reply approves it, the retry goes through. `confirm` mode shows you a dialog instead; `advise` never holds.

Three rules hold all of this together. Patterns set the floor and Jev can only raise it. The agent's plan can add a nudge but never remove a hold. Jev decides, code applies the decision, and the LLM is never asked to judge itself.

**Why Jev and not a second LLM call.** Agents pick the next command well and notice badly when that command is out of proportion to the request. A pattern list catches `rm -rf /`; it cannot tell `db:reset` after "reset the database" from `db:reset` after "add a column". A generative model can, but a second LLM call per tool call is slow and expensive. Jev is a System One model: it returns calibrated probabilities to fixed questions in a quarter of a second, for a fraction of a cent. That is cheap enough to sit in front of every guarded call.

## The numbers

Nothing here is assumed. `node scripts/calibrate-action.mjs --all` replays every guarded call in your recorded Pi sessions through the guard and asks Jev, once per turn, whether your next message approved a hold, regretted a call that ran, or rejected the turn. On 321 of my own sessions (work and hobby projects; 1,085 labelled turns, 17,160 guarded calls, 14,903 judged):

| Measured | Result |
| --- | --- |
| Holds | 42 in 17,160 calls. My next message approved 5, so 37 (88%) stood. |
| Regretted calls | 20 (2% of turns). None was data loss; all were scope: an unwanted commit, a merge, an edit to a personal `CLAUDE.md`, a program launched at night. |
| Off-task holds | Caused 56 of the 139 replay holds and none drew a complaint. Off-task now steers and never holds. |
| Plan mismatch at 0.9 | Fires on 4% of calls that change something; 33% of those sit in a turn the user rejected (base rate 5%). Kept, as a steer. |
| Visible effect plus mismatch at 0.8 | Flags 1.1% of calls; 18% of those in a rejected turn. Steers. |

The labelling never stops: what you do after each hold (approve, decline, redirect, complain) becomes a label, and `/warden status` shows hold precision for your own sessions. The other guards have their own tuning sets (rules: 13 cases, slop: 22, runaway: calibrated on 43,000 local messages, one real runaway stopped at half its length). Method, thresholds, and the candidate questions that lost are in [docs/guards.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md#calibration).

## Questions people asked

**How is this different from putting the rules in AGENTS.md?**
An `AGENTS.md` is read once and asks the model to remember. Long sessions, compaction, and cheap models forget. pi-warden re-reads your rules file when it changes and judges every write against it at the moment it happens, then quotes the rule the agent broke. The rules can be things a linter cannot check: "exported functions declare return types", "a TODO must name a ticket", "comments must not restate the code". Keep the AGENTS.md; the rules guard is the check behind it.

**How much of this could a good regex filter do?**
A good chunk of the destructive-command part, and pi-warden ships that regex layer too: force push, `rm -rf` outside the project, `DROP`/`TRUNCATE`, `curl | sh`, and it looks inside `bash -c`, `eval`, and `python3 - <<EOF`. It runs offline with no key. What regex cannot do is context: `db reset` after "reset the database" is fine and after "add a column" it is not, same string. Jev sees your request and the last few messages. And none of the rest is regex-able: a rule violation in written code, a restating comment, the same failing strategy three times, a "done" with no test run.

**Is this like Claude Code's auto mode?**
The action guard is the same idea: judge each tool call against what you actually asked and stop the ones that overreach. Three differences. It runs as a Pi extension. The judge is Jev, not a second LLM, so it costs 250 ms and a fraction of a cent per call, cheap enough for every guarded call. And the verdict goes to the agent, not to you: the agent re-plans or asks in a sentence, so you are not the approval button. The rest of pi-warden is outside auto mode's scope: rules on every write, slop, stuck loops, done claims, output compression.

**Do I need a TypeSafe key?**
Only for Jev judgments. Without one you still get the pattern list, the runaway stop, duplicate-output notes, sensitive-path notes, and credential-shape warnings. Jev is new and keys come through a waitlist at [console.typesafe.ai](https://console.typesafe.ai); people who filled in the survey and joined the TypeSafe Discord reported access the same day. Install now and run `/warden enable` when the key arrives.

**What does it cost?**
Usage is billed to your TypeSafe account. A judgment is about 600 input tokens; a rules request with 8 rules about 2,000; output is free. At TypeSafe's listed rate ($42 per billion input tokens at the time of writing) a thousand guarded calls cost two or three cents. `maxRequests` (500 per session) caps it and `/warden status` shows the count.

**Will it keep asking me for permission?**
No. On 17k of my calls it held 42 times, and a hold goes to the agent, not to you. You are asked only when the agent decides the action is really needed and says so in a sentence. `confirm` mode gives you a dialog instead if you prefer that.

**Why did you build it?**
To trust cheaper, faster models more. Flash-class models make more out-of-proportion decisions, and I did not want to babysit them or hand them a yolo mode. A second cheap judge catches the bad step, and a steer makes the model think before the next one. The two moments above are the kind of thing it was built for.

**The agent's own "I'm about to do X" text can be slop too. Why compare the call against it?**
It can, so pi-warden never lets it approve anything. Holds come from two places, the offline patterns and the irreversible score, and the irreversible question does not mention the plan. The agent's words reach only the questions that nudge: off task, scope, and "does the call contradict what it just said". Those steer, never hold. So a wrong plan can earn the agent an extra nudge; it cannot remove a hold. Why keep it at all: on recorded sessions a visible effect (commit, push, publish) paired with a plan mismatch flagged 1.1% of calls, and 18% of those sat in a turn the user then rejected, four times the base rate. It is the best signal measured so far for "the agent did something the user did not want", and the calibration script measures it on your own sessions.

**My model never runs unwanted migrations or loops. Do I need this?**
Then the action guard will mostly stay quiet; it is a seatbelt, and on 17k of my own calls it held 42 times. The daily value for a well-behaved model is the rest: rules judged on every write, slop and hedging named, done claims without a test run called out, large outputs cut to the lines that matter with the full copy kept on disk.

**How is this different from pi-ward, pi-sensitive-guard, or a permission system?**
Those draw deterministic lines: which paths, which patterns, allow or deny. pi-warden has a pattern list too, but its main job is the judgment a list cannot make: `db:reset` after "reset the database" is fine, `db:reset` after "add a column" is not. It is advisory, not a sandbox, and it runs alongside those extensions.

**What is sent to TypeSafe?**
Nothing until you run `/warden enable`. After that, per guard, redacted and truncated samples: your prompt and recent messages, the command or path, samples of written content, your rule text, recent failing tool calls, the final message. Never for pattern checks, the runaway guard, or duplicate detection. Credential shapes are redacted best-effort. The full list is in [docs/data-handling.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/data-handling.md).

**Can a project config weaken it?**
A project's `.pi/pi-warden.json` may tighten thresholds, add guarded tools, name rule files, skip paths, or turn a guard off for that repo. It cannot grant consent, change the mode, raise timeouts or budgets, or set a notification command. It is read only when Pi trusts the project.

**I updated and now see a warning about config sections.**
Restart Pi. `/reload` can leave an older module in memory; the warning says which guard was switched off until you do. Details in [docs/configuration.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/configuration.md#after-updating-the-package).

**Headless or CI?**
`PI_WARDEN_ENABLED=1` gives consent, `PI_WARDEN_MODE=steer|confirm|advise` sets the mode, `TYPESAFE_API_KEY` supplies the key.

## Rules for your project

Put `pi-warden.md` at the project root. Each heading is one rule; the text under it is the specification. An optional `paths:` line limits the rule to matching files.

```markdown
# No console statements
Code must not contain `console.log` or `console.debug`. Use the logger.

# Exported functions must have explicit return types
paths: src/**/*.ts
Every exported function declares its return type.

# TODO comments need a reference
A `TODO` or `FIXME` must name a ticket, for example `TODO(APP-123): ...`.
```

On every write and edit, Jev judges the change against each rule: compliant, violation, not applicable, or insufficient context. A violation at 0.7 or above is quoted back to the agent (heading, rule text, and which edit). The write goes through; a held write would leave a half-written file. The third hit of one rule in a session is called out as a standing rule. Files are re-read when they change.

Without a `pi-warden.md`, the first of `README.md`, `CLAUDE.md`, `AGENTS.md` is judged as one document instead, so existing context files work from day one. Starter file with a dozen rules: [`examples/pi-warden.md`](examples/pi-warden.md). Path globs, sensitive-path notes, and the tuning set: [docs/guards.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/guards.md#rules).

## Commands

| Command | Effect |
| --- | --- |
| `/warden status` | Guard state, consent and key source, session counts, thresholds, hold precision, rules source, config paths, last verdicts |
| `/warden enable` | Data notice, key prompt if none is stored, consent saved |
| `/warden disable` | Stop Jev judgments; pattern checks continue |
| `/warden mode steer\|confirm\|advise` | How holds are handled; without an argument, show the current mode |
| `/warden config` | Edit the user config JSON in Pi's editor |
| `/warden test` | One synthetic destructive action, its verdict, and what the agent would be told |
| `/warden trace` | Toggle the trace sidebar (or print the last 20 events without a UI) |

## Configuration

Two files, both optional. Your own defaults live in `~/.pi/agent/pi-warden/config.json` (`/warden config` opens it). A project adds `.pi/pi-warden.json` for repo-specific overrides. The most common tweaks:

```json
{
  "mode": "confirm",
  "steerVisible": true,
  "notify": { "enabled": true },
  "slop": { "prose": { "audience": "plain" } },
  "rules": { "skip": ["tests/**", "docs/**"] },
  "context": { "enabled": false }
}
```

Every key with its default, what a project file may and may not change, environment variables, and the status line templates: [docs/configuration.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/configuration.md). Worked examples of all three files: [examples/README.md](examples/README.md).

## Status line and trace

The line above the editor shows the latest verdict per guard, for example `warden · bash · irreversible 0.84 · off-task 0.86 · unrelated · confirm`. `/warden trace`, `ctrl+shift+w`, or a click on the line opens a right-hand sidebar with the full trace, newest first, including the exact text sent to the agent. Clicks need Pi's fullscreen mode (`tuiMode: "fullscreen"` in `/settings`).

## For extension authors

Every guard is a plain function you can call with any object that has pi-typesafe's `evaluate` method as the judge:

```ts
import { evaluateAction, defaultConfig } from "pi-warden";
import { createTypeSafe } from "pi-typesafe";

const verdict = await evaluateAction(
  { tool: "bash", input: { command: "git push --force" }, cwd: process.cwd(), task: "push my branch" },
  { config: defaultConfig().action, judge: createTypeSafe() },   // omit judge for pattern checks only
);
verdict.level;    // "allow" | "warn" | "confirm"  (confirm = hold in steer mode)
verdict.reasons;  // ["destructive: git force push", "irreversible 0.91"]
```

The rules guard, the session-level `ActionGuard` and `RulesGuard`, and the other exports are in [docs/extension-authors.md](https://github.com/DevMortimer/pi-warden/blob/main/docs/extension-authors.md).

## Development

```bash
npm install
npm run check                    # typecheck, offline tests (mocked transport), build
npm run test:live                # billable synthetic judgments across the guards; pass action|intent|slop|approval|regret|stuck|done|security|context for one group
node scripts/rules-cases.mjs     # 13 billable cases against an 8-rule fixture file
node scripts/slop-cases.mjs      # 22 billable cases for the slop and prose questions
node scripts/security-cases.mjs  # 9 output-security and task-continuity cases
node scripts/context-cases.mjs   # 15 labelled outputs for retention and format
node scripts/calibrate-action.mjs --dry-run   # action-guard calibration on your recorded sessions; drop --dry-run to spend the requests
npm run dev:pi                   # start Pi with this working tree plus an installed pi-typesafe
npm run preview                  # re-render docs/preview.png (needs a Chrome binary)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules the code keeps (steers never hold, approval comes from the user only, a new question ships with a measurement).

## Credits

Rules as headings and the four outcomes come from [jevrealtimecodecheck](https://github.com/MrDesjardins/jevrealtimecodecheck); path globs, sensitive paths, and "judge the change, not its story" from [wince](https://github.com/TinyFrontier/wince). Thanks to both.

## License

MIT
