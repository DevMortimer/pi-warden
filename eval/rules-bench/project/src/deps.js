import { readFileSync } from "node:fs";

/** The manifest text as it is on disk. */
export function manifestText() {
  return readFileSync("package.json", "utf8");
}
