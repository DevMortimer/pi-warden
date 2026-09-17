# Questions people asked

The [README](../README.md) answers two of these; the rest are here.

## How much of this could a good regex filter do?

A good chunk of the destructive-command part, and pi-warden ships that regex layer too: force push, `rm -rf` outside the project, `DROP`/`TRUNCATE`, `curl | sh`, and it looks inside `bash -c`, `eval`, and `python3 - <<EOF`. It runs offline with no key. What regex cannot do is context: `db reset` after "reset the database" is fine and after "add a column" it is not, same string. Jev sees your request and the last few messages. And none of the rest is regex-able: a rule violation in written code, a restating comment, the same failing strategy three times, a "done" with no test run.

## Is this like Claude Code's auto mode?

The action guard is the same idea: judge each tool call against what you actually asked and stop the ones that overreach. Three differences. It runs as a Pi extension. The judge is Jev, not a second LLM, so it costs 250 ms and a fraction of a cent per call, cheap enough for every guarded call. And the verdict goes to the agent, not to you: the agent re-plans or asks in a sentence, so you are not the approval button. The rest of pi-warden is outside auto mode's scope: rules on every write, slop, stuck loops, done claims, output compression.

## What does it cost?

Usage is billed to your TypeSafe account. A judgment is about 600 input tokens; a rules request with 8 rules about 2,000; output is free. At TypeSafe's listed rate ($42 per billion input tokens at the time of writing) a thousand guarded calls cost two or three cents. `maxRequests` (500 per session) caps it and `/warden status` shows the count.

## How big is a Jev request? Does it approach Jev's context window?

No, and the caps are the reason. Jev's window is 32k tokens; the largest request pi-warden builds lands around 4 to 5 thousand tokens even in the worst case:

- Rule text is condensed to `rules.maxChars` (8,000 characters, about 2,000 tokens).
- Task context is at most 8 messages of 750 redacted characters each (about 1,500 tokens).
- The action or written-content summary, the agent's plan, and the questions are a few hundred tokens; a tool-output sample is capped at 6,000 characters, and only for security and retention.

Every cap is a config key, so a long rules file cannot push a request past it; it gets condensed instead. `/warden status` shows the request count for the session.

## Will it keep asking me for permission?

No. On 17k of my calls it held 42 times, and a hold goes to the agent, not to you. You are asked only when the agent decides the action is really needed and says so in a sentence. `confirm` mode gives you a dialog instead if you prefer that.

## Why did you build it?

To trust cheaper, faster models more. Flash-class models make more out-of-proportion decisions, and I did not want to babysit them or hand them a yolo mode. A second cheap judge catches the bad step, and a steer makes the model think before the next one. Two of the moments in [examples.md](examples.md) are the kind of thing it was built for.

## The agent's own "I'm about to do X" text can be slop too. Why compare the call against it?

It can, so pi-warden never lets it approve anything. Holds come from two places, the offline patterns and the irreversible score, and the irreversible question does not mention the plan. The agent's words reach only the questions that nudge: off task, scope, and "does the call contradict what it just said". Those steer, never hold. So a wrong plan can earn the agent an extra nudge; it cannot remove a hold. Why keep it at all: on recorded sessions a visible effect (commit, push, publish) paired with a plan mismatch flagged 1.1% of calls, and 18% of those sat in a turn the user then rejected, four times the base rate. It is the best signal measured so far for "the agent did something the user did not want", and the calibration script measures it on your own sessions.

## My model never runs unwanted migrations or loops. Do I need this?

Then the action guard will mostly stay quiet; it is a seatbelt, and on 17k of my own calls it held 42 times. The daily value for a well-behaved model is the rest: rules judged on every write, slop and hedging named, done claims without a test run called out, large outputs cut to the lines that matter with the full copy kept on disk.

## How is this different from pi-ward, pi-sensitive-guard, or a permission system?

Those draw deterministic lines: which paths, which patterns, allow or deny. pi-warden has a pattern list too, but its main job is the judgment a list cannot make: `db:reset` after "reset the database" is fine, `db:reset` after "add a column" is not. It is advisory, not a sandbox, and it runs alongside those extensions.

## What is sent to TypeSafe?

Nothing until you run `/warden enable`. After that, per guard, redacted and truncated samples: your prompt and recent messages, the command or path, samples of written content, your rule text, recent failing tool calls, the final message, and (only for a subagent report that names a failure, a stop, or a question) a redacted sample of that report. Never for pattern checks, the runaway guard, duplicate detection, or the offline part of subagent triage. Credential shapes are redacted best-effort. The full list is in [data-handling.md](data-handling.md).

## Can a project config weaken it?

A project's `.pi/pi-warden.json` may tighten thresholds, add guarded tools, name rule files, skip paths, or turn a guard off for that repo. It cannot grant consent, change the mode, raise timeouts or budgets, or set a notification command. It is read only when Pi trusts the project.

## I updated and now see a warning about config sections.

Restart Pi. `/reload` can leave an older module in memory; the warning says which guard was switched off until you do. Details in [configuration.md](configuration.md#after-updating-the-package).

## Headless or CI?

`PI_WARDEN_ENABLED=1` gives consent, `PI_WARDEN_MODE=steer|confirm|advise` sets the mode, `TYPESAFE_API_KEY` supplies the key. A headless run writes status messages as custom messages instead of UI notifications, and `/warden trace` prints the last events rather than opening the sidebar.
