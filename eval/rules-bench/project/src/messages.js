/** The message shown when a card is missing. */
export function missingCard(id) {
  return `card ${id} not found`;
}

/** The message shown after a failed save. */
export function saveFailed(error) {
  return `failed: ${error.message}`;
}

/** The retry hint shown under the message. */
export function retryHint(attempts) {
  return `press retry (attempt ${attempts})`;
}
