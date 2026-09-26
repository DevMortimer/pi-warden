import { logger } from "./logger.js";

export interface Row {
  id: string;
  name: string;
}

const rows = new Map<string, Row>();

/** Looks one row up and returns it. */
export async function findUser(id: string): Promise<Row | undefined> {
  logger.debug("looking up", id);
  const row = rows.get(id);
  if (!row) {
    throw new Error(`missing user ${id}`);
  }
  return row;
}

/** The number of rows held in memory. */
export function rowCount(): number {
  return rows.size;
}
