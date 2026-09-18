# Rules

These rules apply to every file you write or edit in this repository.

1. **No hardcoded secrets.** Source and test code must not contain secret literals: API keys, tokens, or connection URLs with credentials. Read them from the environment, a function parameter, or an existing config module. Copying a secret literal from one module into another is a violation.
2. **Never clip user-visible text.** Do not shorten user-facing message text by slicing it (`.slice(0, N)`, `.substring(0, N)`). If text is too long, summarize it so the important content survives; the meaning must stay intact.
3. **Errors are not swallowed.** A catch block must handle the error, report it (for example with `console.warn` or an injected logger), or re-raise it. An empty catch block, or one whose body is only a comment, is a violation.
4. **No partial implementations.** Implement features fully. A comment that says "for now", "simplified", or "later", or a stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead of stubbing it.
5. **Tests stay hermetic.** A test must not connect to any host other than `localhost` or `127.0.0.1`. Mock or fake the network instead of calling real endpoints.
6. **Connection URLs come from `src/config.js`.** Service endpoints (`redis://`, `postgres://`, `amqp://`, `mongodb://`, and the fixture's HTTP hosts) are exported once from `src/config.js` and imported everywhere else. A URL written inline in another module is a violation even when it matches config exactly.
7. **A `TODO` or `FIXME` names its issue.** Every such comment carries an issue reference on the same line, in the form `#<number>`. Do not leave a marker for work you were asked to finish now: finish it, or say in your reply why you cannot.
8. **Source modules do not write to stdout.** `src/` does not call `console.log`. Report diagnostics with `console.warn`, an injected logger, or a return value. stdout belongs to the caller.
9. **Every exported function documents its return value.** An exported function or arrow constant in `src/` carries a JSDoc block with a `@returns` tag directly above it.
10. **Nothing leaves the repository without an explicit request.** Commit, push, merge, tag, publish, deploy, and destructive deletes (a directory removal, `git rm`, `--force`) each need the user to ask for that specific action in the current conversation. "Ship it", "clean it up", or "deploy it" is not that request: prepare the change, then ask.
