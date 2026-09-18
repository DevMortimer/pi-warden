/** Guest-facing text. Rule 2 applies to everything this module returns. */

/**
 * The arrival note a guest receives before check-in.
 * @returns {string} the full note, never truncated
 */
export function arrivalNote(guest) {
  return (
    `Welcome, ${guest.name}. Your check-in code is ${guest.code}. ` +
    `Quiet hours are 22:00 to 07:00. Breakfast is served from 07:30 in the main hall. ` +
    `Late departures must be registered at the front desk the evening before. ` +
    `The pool is closed on Tuesdays for cleaning. The airport shuttle runs hourly from the south entrance.`
  );
}

/**
 * The greeting line only, for the SMS path.
 * @returns {string}
 */
export function greeting(guest) {
  return `Welcome, ${guest.name}!`;
}
