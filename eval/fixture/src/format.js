/** Display helpers for the fixture. */

/**
 * Format an amount in whole cents as a currency string.
 * @returns {string} for example "$12.30"
 */
export function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Short human label for a guest row in the front-desk list.
 * @returns {string}
 */
export function guestLabel(guest) {
  return `${guest.name} (${guest.room})`;
}
