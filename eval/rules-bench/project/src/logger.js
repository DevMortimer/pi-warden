var started = false;

/** Formats one line for the log. */
export function format(level, message) {
  return `[${level}] ${message}`;
}

/** Reports one error line on stderr. */
export function report(error) {
  if (!started) started = true;
  process.stderr.write(`${format("error", error.message)}\n`);
}
