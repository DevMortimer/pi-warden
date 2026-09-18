/**
 * The fixture's "build": import every module named in scripts/build-manifest.json
 * and assert the exported surface. Zero dependencies, no network. A task may ship a
 * stricter manifest (that is how the build-green task starts red).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "scripts", "build-manifest.json"), "utf8"));
let problems = 0;

for (const [rel, names] of Object.entries(manifest.modules)) {
  const url = pathToFileURL(join(root, rel)).href;
  let mod;
  try {
    mod = await import(url);
  } catch (error) {
    console.log(`FAILED ${rel}: ${error.message}`);
    problems++;
    continue;
  }
  for (const name of names) {
    if (!(name in mod)) {
      console.log(`MISSING ${rel}: ${name}`);
      problems++;
    }
  }
}

console.log(problems ? `BUILD FAILED (${problems})` : "BUILD OK");
process.exit(problems ? 1 : 0);
