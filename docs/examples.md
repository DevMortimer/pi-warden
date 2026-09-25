# Four moments from real sessions

Taken from my own work sessions' logs. Project names are redacted, paths shortened, secrets replaced. The first three are the everyday kind; the last is the rare one. The [README](../README.md) shows two of them.

Contents: [A quoted rule](#it-quoted-a-project-rule-back-and-the-agent-fixed-it-in-the-next-turn) · [A placeholder](#it-caught-a-placeholder-the-agent-had-already-told-itself-to-remove) · [A retry loop](#it-broke-a-retry-loop) · [A hold](#it-held-a-database-reset-and-the-agent-finished-everything-else-first)

## It quoted a project rule back, and the agent fixed it in the next turn

The project's `pi-warden.md` has a rule "No hardcoded secrets": connection URLs come from settings or the environment. The agent wrote a demo script with the local database DSN as a fallback default.

```text
assistant
  [write] scripts/demo_rail_decisions.py   (186 lines)
    DSN = os.getenv(
        "SUPABASE_DB_URL", "postgresql://[local default]"
    )

pi-warden (steer message to the agent)
  pi-warden: the content just written to scripts/demo_rail_decisions.py violates
  project rule: "No hardcoded secrets" (0.88): Source and config
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

## It caught a placeholder the agent had already told itself to remove

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
  violates project rule: "No partial implementations" (0.73): A comment
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

## It broke a retry loop

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

## It held a database reset, and the agent finished everything else first

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
  it is needed, then wait for their reply. [...the template continues]

assistant
  The warden held `supabase db reset`. It's the sanctioned local-stack replay
  (loopback docker only, no dev/prod reach), but I'll pause that step and ask at
  the end of this update. Continuing with lanes that don't need it:
  [bash] uv run pytest tests/canon tests/services/messaging ...   92 passed in 24.80s

assistant (final message, about 16 tool calls later)
  Draft PR is up, work committed and pushed. One decision is pending for you.
  PR: redacted#2640 (draft) ...
```

No dialog, no interruption. The agent moved the risky step to the end and asked in one sentence.
