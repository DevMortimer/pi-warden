import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const name = manifest.name ?? "app";

export function banner() {
  return `building ${name}`;
}
