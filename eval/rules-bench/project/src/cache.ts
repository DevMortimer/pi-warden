const cache = new Map<string, string>();

/** Reads one value from the cache. */
export function lookup(key: string): string | undefined {
  return cache.get(key);
}

/** Stores one value in the cache. */
export function remember(key: string, value: string): void {
  cache.set(key, value);
}
