/**
 * The library entry must import without the optional Pi peers installed. A child process loads
 * src/index.ts through a resolve hook that makes `@earendil-works/pi-coding-agent` and
 * `@earendil-works/pi-tui` unresolvable (both peers are type-only in library modules) and calls
 * `defaultConfig()` plus the path functions. Type-only imports are erased by tsx, so only a real
 * runtime import would fail here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const hookSource = `
export async function resolve(specifier, context, next) {
  const blocked = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
  if (blocked.some(peer => peer === specifier || specifier.startsWith(peer + "/"))) {
    throw new Error("blocked optional peer (" + specifier + ")");
  }
  return next(specifier, context);
}
`;

const child = `
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hookSource)}));
const index = await import("./src/index.ts");
const config = index.defaultConfig();
assert.equal(config.enabled, true);
const dirs = index.defaultHostDirs();
assert.match(dirs.agentDir, /pi-warden-nopi-/);
assert.match(index.userConfigPath(dirs), /config\\.json$/);
await index.initSchema(0, dirs);
console.log("NO_PI_IMPORT_OK");
`;

test("src/index.ts imports and works with the Pi peer unresolvable", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-warden-nopi-"));
  try {
    const { stdout } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: temp, PI_WARDEN_DB: join(temp, "holds.db") },
      encoding: "utf8",
    });
    assert.match(stdout, /NO_PI_IMPORT_OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
