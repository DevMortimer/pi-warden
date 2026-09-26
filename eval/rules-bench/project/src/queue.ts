import { logger } from "./logger.js";

/** Drains the queue and returns the items that survive. */
export function drain(items: string[]): string[] {
  const pending = items.filter(Boolean);
  logger.debug("draining", pending.length);
  return pending;
}

/** Adds one item to the queue. */
export function enqueue(items: string[], item: string): string[] {
  return [...items, item];
}
