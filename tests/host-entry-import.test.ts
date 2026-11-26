import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ENTRY_POINTS = [
  "dist/hosts/claude.js",
  "dist/hosts/codex.js",
  "dist/hosts/headless.js",
  "dist/rules-file.js",
  "dist/index.js",
] as const;

if (ENTRY_POINTS.some(entry => !existsSync(join(repoRoot, entry)))) {
  execFileSync(
    process.execPath,
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: repoRoot, stdio: "pipe", timeout: 60_000 },
  );
}

for (const entry of ENTRY_POINTS) {
  test(`${entry} loads when imported first in a fresh process`, () => {
    const target = join(repoRoot, entry);
    assert.ok(existsSync(target), `missing build artifact: ${entry}`);
    const url = pathToFileURL(target).href;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, `child killed by signal ${result.signal}`);
    assert.equal(result.status, 0, `${entry} failed to load:\n${result.stderr || result.stdout}`);
  });
}
