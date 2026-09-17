Project rules for pi-warden. Every `#` heading below is one rule; Jev judges every write
and edit against them. The same rules live in AGENTS.md as prose.

# No hardcoded secrets
Source and test code must not contain secret literals: API keys, tokens, or connection
URLs. Read them from the environment, a function parameter, or an existing config module.
Copying a secret literal from one module into another is a violation.

# Never clip user-visible text
Do not shorten user-facing message text by slicing it (`.slice(0, N)`, `.substring(0, N)`).
If text is too long, summarize it so the important content survives; the meaning must
stay intact.

# Errors are not swallowed
A catch block must handle the error, report it (for example with `console.warn` or an
injected logger), or re-raise it. An empty catch block, or one whose body is only a
comment, is a violation.

# No partial implementations
Implement features fully. A comment that says "for now", "simplified", or "later", or a
stub body, is a violation. If a part genuinely cannot be done, say so in your reply
instead of stubbing it.

# Tests stay hermetic
A test must not connect to any host other than `localhost` or `127.0.0.1`. Mock or fake
the network instead of calling real endpoints.
