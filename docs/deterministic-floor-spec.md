# The deterministic floor: extending pi-warden's pattern layer

*Status: design spec. Not yet implemented. Each section is one pull request; they are
independently mergeable and compose. Config keys marked additive per
[CONTRIBUTING.md](../CONTRIBUTING.md#change).*

pi-warden's action guard has two layers: a deterministic pattern floor (shell rules,
sensitive-path detection, `rm` classification) and the Jev judgment layer (irreversibility,
scope, intent). The judgment layer gets most of the attention because it is the novel part.
This spec is about the other layer — the floor — and about the failure modes that only a
floor can catch, because a floor is the only part that works when the judge is absent,
wrong, or unconsented.

Three capabilities are missing from the floor, in ascending order of novelty:

1. **User-extensible command rules** (PR 1). `SHELL_RULES` is a hardcoded array; a user
   cannot add a pattern, exempt one, or choose its severity. This is the enabling PR: every
   later PR rides on rules being declarable.
2. **Path rules with an access dimension** (PR 2). Sensitive-path detection is a fixed regex
   over a fixed path list, producing notes after the fact. It cannot express "read ok,
   write held", and it cannot fence a path deterministically at all.
3. **Arming rules** (PR 3). Neither the floor nor the judge can correlate a *preparation*
   (an edit that changes what a later command will do) with the *armed* command. The
   damage scenario in [Context](#context) is exactly this pair, seen from either side and
   found harmless in isolation.

A design constraint runs through all three: **every new mechanism is negative-space** —
the user declares what is dangerous; everything else flows untouched. The moment any of
these starts classifying arbitrary tokens positively ("is this string a path?"), it
reproduces the false-positive treadmill of lexical path extraction, which is the failure
mode this spec exists to avoid.

---

## Context

These scenarios are generalized from real sessions on an operator machine used to
administer a Kubernetes cluster (GitOps-managed, Flux-based) and various local repos. In
each, the agent did nothing the user had not asked for in spirit; the problem is that the
deterministic layer had no vocabulary for the risk.

### Scenario A: the permission that trains approval

The user's path-gating extension at the time classified path-like tokens in shell commands
positively. Over one week it produced ~2,000 approval prompts, of which roughly 87% were
false positives: URL path fragments inside Python string literals, container paths in
`kubectl exec` argv, URL substrings in `.count('...')` calls, separator literals like
`'/'` in `'/'.join(...)`. Several were un-grantable (the extracted "path" did not exist and
could never exist), so "allow always" was unavailable and the same prompt re-fired.

The security consequence is the one that matters: prompts that fire this often train the
operator to approve reflexively. A prompt layer's reliability is only as good as its last
hundred prompts. The lesson drawn is not "prompt less" but "prompt *selectively*" — a
deterministic floor that only fires on things the user *declared* dangerous can be trusted
when it fires, and the operator stays attentive for the cases that matter.

### Scenario B: the harmless edit that armed a teardown

A session asked the agent to relocate a GitOps repository checkout to a new path. The edit
itself was ordinary — a config file inside the workspace, no dangerous pattern, no
outside-project path. The file it edited was the root definition of what a
`flux`-class reconciliation tool considers the cluster's desired state.

A later (equally ordinary) reconciliation command then applied the *edited* definition.
The reconciliation engine dutifully pruned everything the old root had contained and the
new root did not: the cluster's workloads were torn down. At no point in the session was
there a tool call that any pattern rule would match — no `rm -rf`, no force push, no
destructive flag. The operator was never prompted, because every individual call was
harmless and the *composition* was catastrophic.

What was needed, and absent: a way to say "editing *this* file class arms *these*
commands; while armed, they require my confirmation." No single-call rule can express it;
the judge cannot either, because "irreversible" asks about the call in isolation, and the
call in isolation was fine. The relationship between the edit and the command is session
state.

### Scenario C: the risky command the user actually wants to see

The same operator uses the agent for cluster administration, which legitimately involves
commands like `kubectl delete pod`, `helm uninstall`, or `flux suspend` — genuinely risky,
genuinely intentional, and (in one live incident) the *only* signal that a session was
about to touch production state. In default steer mode these flow through as warnings the
agent may act on, or as holds the agent may talk its way around. The operator does not
want these held from the agent (they are the job); they want a *dialog* — "allow this?"
— before they run, every time, without configuring the whole extension into a
prompt-heavy mode to get it.

pi-warden currently has no configuration surface for "these specific commands, at this
specific severity, prompting me directly." The severity ladder exists internally
(`warn` / `confirm`); nothing exposes a user-defined rung of it.

### Why the floor and not the judge

The judge is excellent and gets better with measurement, but it has three structural
limits as a safety layer:

- **Consent-gated.** `typesafe: false` (the default) leaves only the pattern floor. Every
  capability in this spec must therefore work judge-less to be a floor capability.
- **Fail-open by design.** `failOpen: true` means a transport error silently degrades to
  the floor. The floor's coverage defines the outage-time guarantee.
- **Per-call.** Jev's questions evaluate one call against task and context. Scenario B is
  not a per-call judgment; it is a relationship between calls at distance. (A new Jev
  question could *report* armed state as context — a possible follow-up, not a substitute:
  it would still be unmeasured, unconsented, and advisory.)

---

## PR 1: user-defined command rules (`commandRules`)

### Problem

`SHELL_RULES` (src/guard.ts) is a compiled-in array. Users cannot add a rule for their
environment's dangerous commands, exempt a built-in that mis-fires on their workflow, or
control severity. Scenario C is unaddressable; a false-positive built-in cannot be turned
off without disabling the whole guard.

### Design

New config key `action.commandRules` (user file only; project files must not be able to
grant themselves severity — see [Threat model](#threat-model)):

```jsonc
"action": {
  "commandRules": [
    { "id": "kubectl-delete",      "pattern": "\\bkubectl\\s+delete\\b",        "severity": "confirm" },
    { "id": "flux-suspend",        "pattern": "\\bflux\\s+suspend\\b",          "severity": "confirm" },
    { "id": "helm-uninstall",      "pattern": "\\bhelm\\s+(uninstall|delete)\\b", "severity": "confirm" },
    { "id": "git-push-any-branch", "pattern": "\\bgit\\s+push\\b",              "severity": "warn" }
  ],
  "commandDenyRules": [
    { "id": "never-talos-reset", "pattern": "\\btalosctl\\s+reset\\b" }
  ]
}
```

- `pattern`: regex, case-insensitive by default (`caseSensitive: true` to opt out),
  matched against the `stripDataText`-processed command — so heredoc bodies, quoted data
  arguments, and commit messages behave exactly as the built-in rules do. This is the
  single most important implementation detail: user rules must ride the same data-text
  pipeline as built-ins, or they reintroduce the commit-message false-positive class that
  the pipeline exists to prevent.
- `severity`: `"warn" | "confirm" | "deny"`. `warn` and `confirm` join the existing level
  ladder (`higher()`); `deny` is new — see below.
- `commandDenyRules` (or `severity: "deny"` on the same shape, whichever the maintainer
  prefers) hard-blocks with no dialog. This is the `talosctl reset` case: never run it,
  not even once, not even with approval, because the operator has a keyboard for the
  approval and prefers the cable pull to be physical.
- `message`: optional human string shown in the dialog/steer, replacing the derived label.
- Built-in rules get stable ids in the same namespace, so users can also *exempt*: an
  `exemptRules: ["infra-destroy"]` (or `severityOverride` per id) covers the user whose
  workflow legitimately runs `kubectl delete` constantly and wants Jev's judgment instead
  of the pattern confirm.

### Enforcement semantics

This is where Scenario C's requirement lands. A user rule with `severity: "confirm"`
*prompts the user* (via the existing `ctx.ui.confirm` confirm-mode path), regardless of
steer/advise mode. Rationale: the user asked for a dialog explicitly. The current
steer-mode behavior for `confirm`-level verdicts — hold and steer the agent — remains the
behavior for *built-in* rules, so nothing changes for existing users; the per-rule
`action` field is the opt-in to dialog semantics:

```jsonc
{ "id": "kubectl-delete", "pattern": "...", "severity": "confirm", "action": "dialog" }
```

Default `action` for user rules: `"dialog"` when `severity: "confirm"` (that is the
reason one writes such a rule), `"hold"` available for those who prefer steer semantics.
A `dialog` action costs a prompt; the operator chose it for this pattern on purpose.

### Calibration and measurement

Per CONTRIBUTING: steers never hold; holds require measurement. A `dialog` user rule
holds the call pending the user's *own* answer — the operator is the measurement. No
Jev request is spent. The rule fires exactly as often as the user's patterns match, on
text the user chose, so the Scenario A failure mode (the extension deciding what to ask
about) cannot recur from this feature.

### Tests

- Pattern matching against `stripDataText` output (heredoc body mentioning the pattern
  does not fire; shell-sink heredoc does).
- Severity ladder interaction with built-ins (`higher()`).
- `deny` blocks with the configured message; `dialog` prompts and honors the answer.
- Exemption of a built-in id; unknown ids warn once at load.
- Config validation: project-file rule with severity `deny`/`confirm` is rejected (see
  threat model).

---

## PR 2: path rules with an access dimension (`pathRules`)

### Problem

Sensitive-path detection today is one compiled regex (`SENSITIVE_PATH`) producing a
*post-hoc note to the agent* — never a hold, never a dialog, never user-extensible. It
cannot express the three protection levels real credential layouts need, and it only
covers a fixed list. Guardrails-style all-or-nothing path policies are the alternative on
offer in the ecosystem, and they cannot express read/write asymmetry either — and their
positive-space token classification is precisely the Scenario A treadmill.

### Design

New config key `action.pathRules` (user file only):

```jsonc
"action": {
  "pathRules": [
    {
      "id": "ssh-private-keys",
      "paths": ["~/.ssh/id_*", "~/.ssh/*.pem"],
      "access": "write",          // "none" | "read" | "write"
      "tools": ["write", "edit", "bash"],
      "action": "block",
      "message": "SSH private keys are never written by agents."
    },
    {
      "id": "flux-repo-read-only",
      "paths": ["~/repos/flux-cluster/**"],
      "access": "read",
      "tools": ["write", "edit"],
      "action": "confirm",
      "message": "Writes to the GitOps repo change cluster state on next reconcile."
    },
    {
      "id": "env-files",
      "paths": ["**/.env", "**/.env.*"],
      "access": "none",
      "tools": ["*"],
      "action": "confirm",
      "onlyIfExists": true
    }
  ]
}
```

Semantics:

- **`access` is the new dimension.** `"none"` = any touch matches. `"read"` = only
  *writes* match (reads flow). `"write"` = only *reads* match (an append-only audit log
  the agent may create but never open). "Which side" is known structurally for file tools
  (`read`-class tools vs `write`/`edit`) and via `mutates`-class signals for bash — see
  below.
- **`tools` selects the surface.** `["write", "edit"]` checks the structured `input.path`
  — cheap, exact, zero parsing. `"*"` additionally covers bash commands, which is where
  discipline is required.
- **Bash coverage is negative-space by construction.** A path rule with `tools: "*"` does
  *not* extract path tokens from arbitrary commands (that is the Scenario A treadmill).
  It matches the same way the existing `SENSITIVE_PATH` regex does: the rule's compiled
  patterns are tested against the `stripDataText`-processed command string, and against
  redirect targets only (`>`, `>>`, `tee` targets — extraction limited to the three
  write-sinks a shell grammar actually defines). A `grep` mentioning a path in its
  arguments therefore does not match a `write`-access rule on the command surface; a
  `> ~/.ssh/authorized_keys` does. When Jev is available, a `mutates` answer below
  threshold downgrades a command-surface match to a note (the existing deferSensitive
  behavior, extended to user rules) — the read/write distinction for ambiguous command
  text is semantic, and the judge is the semantic oracle. Without Jev, command-surface
  matches follow the rule's `action` (fail toward the user's declared severity, since the
  user wrote the pattern).
- **`action` levels:** `note` (current behavior — agent told after the fact),
  `warn`, `confirm` (dialog; same semantics as PR 1's `action: "dialog"`),
  `block` (deny). Default `note` preserves today's behavior for a bare rule.
- **`onlyIfExists`** defaults `true` (mirrors guardrails' best idea: phantom paths do not
  fire), overridable for create-protect cases.
- Glob semantics match the rules-guard (`**` recursive, `*` single segment), `~` expanded;
  `regex: true` per-rule opt-in for shapes globs cannot express.
- The built-in `SENSITIVE_PATH` becomes (or ships alongside) a default rule set with the
  same shape, so behavior is continuous and the fixed list gains a documented escape
  hatch (`exemptRules` per PR 1's mechanism, extended to path-rule ids).

### What this deliberately does not do

It does not classify tokens in arbitrary command text. A path rule's bash surface sees:
the full command string via pattern matching (so `.env` inside `kubectl exec -- cat /x/.env`
*does* match an `access: "none"` rule — the operator declared that path always-matters),
redirect and `tee` targets for `write`-access precision, and nothing else. Every token
not written by the user flows to Jev or nowhere.

### Tests

- `access` gating on file tools: read-tool touches pass a `read` rule, write-tools fire.
- Redirect-target extraction for bash (`>`, `>>`, `tee`); non-sink mentions pass
  `write`-access rules; `access: "none"` rules match bare mentions.
- `stripDataText` interaction (pattern inside a data heredoc does not fire).
- `onlyIfExists` true/false; glob semantics (`**`, single-segment `*`, `~`).
- Project-file rejection of `action` levels above `note` (threat model).
- Existing sensitive-path behavior byte-identical with default config (the fixed regex
  reframed as default rules).

---

## PR 3: arming rules (`armingRules`)

### Problem

Scenario B: a preparation (editing a file that changes what a later command will do)
and the armed command (applying it) are each individually harmless by every existing
measure. The damage lives in the *relationship*. Neither the pattern floor (single-call)
nor the judge (single-call, and unconsented by default) can see it. No ecosystem tool
expresses this today.

### Design

New config key `action.armingRules` (user file only):

```jsonc
"action": {
  "armingRules": [
    {
      "id": "gitops-edit-arms-reconcile",
      "when": {
        "edited": ["~/repos/flux-cluster/**/kustomization.yaml",
                    "~/repos/flux-cluster/**/helmrelease.yaml"],
        "tools": ["write", "edit"]
      },
      "arms": {
        "command": "\\bflux\\b|\\bkustomize\\b|\\bkubectl\\s+(apply|delete|prune)\\b",
        "for": "10m"
      },
      "action": "confirm",
      "message": "Cluster state definitions were edited this session; this reconciliation applies them."
    }
  ]
}
```

- **`when.edited`**: path globs (PR 2's matcher) describing the preparation. Matched
  against write/edit calls, structured `input.path` only — no command parsing, no
  ambiguity.
- **`arms.command`**: regex over `stripDataText`-processed commands (PR 1's matcher).
- **Arming state**: session-scoped. When a `when` matches, the rule becomes armed with an
  expiry (`for`, default e.g. 10 minutes, refreshed on each matching edit). When an armed
  rule's `arms.command` matches a subsequent call, the rule's `action` fires — `confirm`
  (dialog), `hold` (steer), or `block`.
- **State location**: the arming tracker is a small in-memory structure in the extension
  (per session); expiry on wall-clock; cleared on `agent_end`. It must appear in
  `/warden status` ("2 armed rules: gitops-edit-arms-reconcile (5m left)") so the
  operator can see when a session is armed — an armed session that the operator forgot
  about is its own small hazard, and visibility is the mitigation.
- **Dialog content** (for `confirm`): names the rule, the file(s) that armed it, and the
  pending command's pattern — enough to answer without re-deriving the history.

### Deliberate limits

- **No cross-session arming.** The state dies with the session. Scenario B happened
  within one session; persistent arming is a scope creep with real annoyance potential.
- **No inference.** The operator declares the relationship. There is no "the agent
  edited something suspicious" heuristic — that road leads to positive-space FPs again.
  The declaration is cheap (one rule per dangerous edit→apply pair in one's workflow)
  and the FP rate is exactly the declared pattern's match rate.
- **Jev interplay**: an armed hit rides as *context* to Jev if available (the judge may
  weigh "this session armed the GitOps teardown path" in its irreversibility answer) but
  never depends on it. The `action` is deterministic.

### Tests

- Arm → expire (no hit after `for` elapses); re-arm refresh.
- `when` matches only write/edit tools on matching globs; bash edits that create the
  same condition via redirect *do* arm when the file glob matches a redirect target
  (redirect targets are already extracted per PR 2).
- Command match fires `confirm`/`hold`/`block` per rule; non-matching commands clear
  nothing (multiple armed rules coexist).
- `/warden status` renders armed state; state cleared on `agent_end`.
- Multiple rules arming from one edit; one rule armed by multiple edits (dedup).

---

## Threat model

Two new surfaces deserve explicit attention:

1. **Project config must not self-escalate.** All three keys are user-file-only. A
   cloned repository must not be able to ship a `.pi/pi-warden.json` that (a) declares
   `deny` rules, (b) declares `dialog` actions (a social-engineering prompt farm), or (c)
   arms on paths the repo controls. The existing user/project split (`applyGuards`
   project merge) is the enforcement point; new keys join the user-only set. Severity
   allowed in project files, if any: `note`/`warn` only.
2. **Data handling.** Path rules and arming rules are evaluated entirely locally; their
   *matches* may appear in reasons sent to Jev only as pattern names and scores, per the
   existing "reasons name patterns, never commands" rule. `docs/data-handling.md` gains
   one paragraph: user-declared rules never leave the machine; armed-state is
   session-local memory.

The fail-open story is unchanged and strictly improved: every rule here is deterministic
and local, so judge outages leave *more* floor, not less.

## Sizing and sequencing

| PR | Touches | Est. | Depends on |
| --- | --- | --- | --- |
| 1. commandRules | guard.ts (rules merge), config.ts, shape.ts, extension.ts (dialog path exists), configuration.md, guard tests | ~250 LOC + tests | — |
| 2. pathRules | new src/path-rules.ts (glob matcher reuse from rules-guard), guard.ts (surface selection), redirect-target extraction (ast.ts already has redirect walk), config/docs/tests | ~400 LOC + tests | reuses PR 1's config patterns; independently mergeable |
| 3. armingRules | new src/arming.ts (state + expiry), extension.ts (edit hook + command check), status rendering, config/docs/tests | ~300 LOC + tests | PR 2's glob matcher; PR 1's command matcher |

PR 1 is the foundation and the cheapest; PR 2 stands alone functionally; PR 3 is the
novel capability and reads as the payoff of the first two. All three keep
`CONFIG_SCHEMA` bump discipline, additive defaults, and the steers-never-hold rule
(`dialog` is a user-invoked prompt, not a steer; `hold` remains the built-in behavior).

## Rejected alternatives

- **Positive-space path extraction for user rules.** ("Let users write path rules that
  extract tokens from any command.") This is Scenario A; rejected regardless of how
  convenient it looks. Redirect targets and declared patterns only.
- **Arming via Jev question.** ("Add `did_session_prepare_this` to the question set.")
  Unmeasured questions cannot act per CONTRIBUTING; it would also be judge-dependent,
  defeating the floor purpose. Recorded as a possible future `extra` question.
- **Extending guardrails instead.** The existing path-access module's architecture
  (classify every token, filter with heuristics) is the failure mode; layering config on
  it inherits the treadmill. The floor belongs where the session state and the data-text
  pipeline already live.
