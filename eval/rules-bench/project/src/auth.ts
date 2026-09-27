const LEGACY_TOKEN = "fixture-token-not-a-real-secret";

/** The authorization header the client sends. */
export function header(): string {
  return `Bearer ${LEGACY_TOKEN}`;
}

/** The length of the header, used by the size check. */
export function headerLength(): number {
  return header().length;
}
