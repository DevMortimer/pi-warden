/**
 * URL slug for a room or event title.
 * @returns {string} lower-case slug
 */
export function slugify(title) {
  return title.toLowerCase();
}

/**
 * Title case for a display name.
 * @returns {string} the display name
 */
export const titleCase = name => name.replace(/\b\w/g, ch => ch.toUpperCase());

/** The title shown for an untitled room. */
export const UNTITLED = "untitled";
