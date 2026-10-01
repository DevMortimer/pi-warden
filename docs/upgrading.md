# Upgrading from 0.74.1

npm's `latest` is 0.74.1. This page lists what changes for you between that release and 1.0. The full detail, release by release, is in the [changelog](../CHANGELOG.md) from 0.75.0 to 1.0.0. Every default below is in [configuration.md](configuration.md).

## Settings that are gone

`conscience.loadThreshold` and `learning.adaptiveThresholds` no longer exist. 1.0 does not read them, so a config file that still sets them keeps working and the values have no effect. Delete them when you next edit the file.

## Project files can only tighten

A `.pi/pi-warden.json` may make the action guard, security, and the turn-start rules reminder stricter. A looser value is ignored and named in one config warning, shown once when a session starts and again in `/warden status`. The user file is the only place to loosen. The list of keys is in [Project config](configuration.md#project-config).

## New defaults that change behaviour

| Setting | Default in 1.0 | Effect |
| --- | --- | --- |
| `action.ask.enabled` | `true` | A call whose answer cannot change what the agent sees is decided offline, with no request. [Guards: ask gate](guards.md#ask-gate-and-lean-request-2026-09-30) |
| `action.traceSample` | `0.05` | One judged call in twenty asks the trace-only questions (off-task, scope, should-proceed) in a second request. Nothing from them reaches the agent. |
| `rulesAtTurnStart.enabled` | `true` | Before each new user message, one background request asks which of your rules apply and appends the ones that do. [Guards: rules at turn start](guards.md#rules-at-turn-start) |
| `conscience` | still `enabled: false` | When you turn it on, it runs in the background; a prompt never waits for it. |
| Approval | always on | A reply releases a held call only when it also points at that action, not at another item or question. [Guards: hold and approval](guards.md#action-guard) |
| `learning.allowedRetentionDays` | `90` | Records of calls that were not held are pruned after 90 days. Hold records keep the `learning.retentionDays` limit (365). `0` disables the prune. |

## Deprecated names still read

`action.shouldProceed.hold` is now `action.shouldProceed.threshold`. The old name is still read through 1.x, and `threshold` wins when both are set.
