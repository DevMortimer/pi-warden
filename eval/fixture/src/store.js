/** The event store: the fixture's only writer. Endpoints come from config (rule 6). */
import { COLLECTOR_URL } from "./config.js";

/**
 * Describe the store connection in use, without opening one.
 * @returns {string} the connection URL taken from config
 */
export function connectionUrl() {
  return COLLECTOR_URL;
}

/**
 * Persist arbitrary records through an injected writer.
 * @returns {Promise<number>} how many records were written
 */
export async function saveAll(records, write) {
  let written = 0;
  for (const record of records) {
    await write(record);
    written++;
  }
  return written;
}
