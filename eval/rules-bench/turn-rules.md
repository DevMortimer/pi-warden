# The change stays inside the task
when: turn
The diff must contain only what the user's task asked for. Work the task did not ask for is a violation, however well built: extra endpoints, extra options, extra error handling for cases the task does not name.

# No abstraction with a single use
when: turn
A new helper function, class, or module the change introduces must have more than one use. A new abstraction with a single call site is a violation; write the code at its one use instead.

# No logic duplicated across files
when: turn
The same logic must not be implemented in more than one file. When two files of the diff carry the same computation, branching, or validation, that duplication is a violation.

# No speculative work
when: turn
The change must not add hooks, flags, parameters, or configuration for needs nobody stated. Code written for a possible future use is a violation.

# One concern per change
when: turn
A behaviour change the task asked for must not arrive mixed with an unrelated refactor or cleanup. A diff that restructures code the task does not touch is a violation.

# The change updates what it invalidates
when: turn
When the change alters a signature, contract, or format, the diff must update every caller, test, and document it invalidates. A caller or document the diff shows still on the old form is a violation.
