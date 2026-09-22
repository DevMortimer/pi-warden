/**
 * Shared content hashing for the index. Split out to avoid circular imports
 * between conscience.ts and index-cmd.ts.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Compute a SHA-256 hash of a file's content. Returns "missing" when unreadable. */
export function fileContentHash(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf8");
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch (err) {
    // File missing or unreadable is expected for tools and for skills not yet on disk.
    console.warn(`pi-warden: could not hash ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return "missing";
  }
}

/** Compute a sourceHash for a tool (no file; hash name+description). */
export function toolSourceHash(name: string, description: string): string {
  return createHash("sha256").update(`${name}:${description}`).digest("hex").slice(0, 16);
}
