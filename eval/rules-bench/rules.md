# No console statements
Code must not contain `console.log`, `console.debug`, or `console.info` calls. Use the logger or remove them.

# No explicit any type
paths: **/*.ts, **/*.tsx
TypeScript code must not use the `any` type. Use a specific type, `unknown`, or a generic parameter.

# TODO comments need a reference
Any `TODO` or `FIXME` comment must include a ticket reference, for example `TODO(JIRA-123): ...`. A bare TODO is a violation.

# No empty catch blocks
A `catch` block must not be empty. It must handle the error, log it, or rethrow it. An empty catch block, or one whose body is only a comment, is a violation.

# Switch statements must have a default case
Every `switch` statement must include a `default` case, even if it only throws on an unexpected value.

# No hardcoded credentials
Source code must not contain hardcoded passwords, API keys, or tokens; these come from configuration.

# Exported functions must have explicit return types
paths: **/*.ts, **/*.tsx
Every exported function must declare its return type explicitly rather than relying on inference.

# Boolean names start with is/has/should/can
A boolean variable or property must be named with a predicate prefix such as `is`, `has`, `should`, or `can`.

# Every exported function documents its return value
paths: src/**/*.js
An exported function or arrow constant in `src/` carries a JSDoc block with a `@returns` tag directly above it.

# Never clip user-visible text
Do not shorten user-facing message text by slicing it (`.slice(0, N)`, `.substring(0, N)`). If text is too long, summarize it so the important content survives; the meaning must stay intact.

# Errors never reach the user raw
A caught error must not be shown to the user as it is. Show a plain message and report the technical detail with `console.warn` or the logger. Replying with `error.message` or `error.stack` as the user-visible text is a violation.

# No new dependency without need
Do not add a package to `package.json` unless the project's own code needs it and the standard library cannot do the job. An import of a package the manifest does not list, or a new dependency entry no code uses, is a violation.

# Python except clauses name their exception
paths: **/*.py
A Python `except` clause must name the exception type it handles. A bare `except:` is a violation. Catching `Exception` is allowed when the body re-raises or reports it.

# Python functions do not use mutable default arguments
paths: **/*.py
A Python function must not use a mutable default such as `[]`, `{}`, or `set()`. Use `None` and build the value inside the function.

# JavaScript uses const or let
paths: **/*.js, **/*.mjs, **/*.cjs
JavaScript code declares variables with `const` or `let`. A `var` declaration is a violation.

# Markdown carries no placeholder text
paths: **/*.md
Documentation must not ship placeholder text: the word `TBD`, `Lorem ipsum`, an angle-bracket placeholder such as `<insert ...>`, or a section that says the content is coming soon.

# No partial implementations
Implement features fully. A comment that says "for now", "simplified", or "later", or a stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead of stubbing it.
