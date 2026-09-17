Copy this file to the root of your project as `pi-warden.md` and edit it. Every `#` heading below is one rule. The text
under a heading is what Jev reads when it judges a write or an edit. A `paths:` line right under a heading limits that rule
to matching files. Text above the first heading, like this paragraph, is ignored, so keep the intro heading-free.

Keep rules short and concrete. Say what a violation looks like. Jev is good at "must not contain X" and "every X needs a Y";
it is worse at taste ("code should be clean").

# No console output in library code
paths: src/**
Code under `src/` must not call `console.log`, `console.debug`, or `console.info`. Use the project logger or remove the
call before committing. Tests and scripts may print.

# TODO comments need a reference
A `TODO` or `FIXME` comment must name a ticket or issue, for example `TODO(APP-123): ...`. A bare `TODO` is a violation.

# No explicit any
paths: **/*.ts, **/*.tsx
Do not use the `any` type. Use a precise type, `unknown` with a runtime check, or a generic parameter.

# Exported functions declare their return type
paths: src/**/*.ts
Every exported function or method declares its return type instead of relying on inference.

# Errors are not swallowed
A `catch` block must handle the error, log it with context, or rethrow it. An empty `catch`, or one that only has a comment
such as `// ignore`, is a violation.

# Switch statements have a default case
Every `switch` has a `default` branch, even if it only throws on an unexpected value.

# No hardcoded secrets
Source code must not contain passwords, API keys, or tokens. They come from configuration or a secrets manager. A test fixture
with an obviously fake value such as `test-key` is fine.

# Boolean names read as a question
A boolean variable or property starts with `is`, `has`, `should`, `can`, or a similar predicate prefix, for example
`isEnabled`, not `enabled`.

# New exported functions get a test
paths: src/**
A newly added exported function or class comes with at least one test that exercises its main behaviour. Changing an
existing function does not require a new test by itself.

# Comments explain why, not what
A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment that restates what the next line
plainly does is a violation.

# No commented-out code
Delete code that is no longer used. Do not leave it behind as comments.

# Migrations are reversible
paths: **/migrations/**
Every migration has a down step (or an explicit note in the file that the change cannot be reversed and why).
