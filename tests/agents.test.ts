import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// `AGENTS.md` is the first thing every agent reads in this repository, so the Architecture map is a claim about the
// source tree and the Development block must not carry a test count that drifts. Both are checked against `src/` here;
// the test fails, rather than the map silently lying, when a file is renamed or a count is written back in.
const agentsPath = fileURLToPath(new URL("../AGENTS.md", import.meta.url));
const agents = readFileSync(agentsPath, "utf8");

test("AGENTS.md Architecture names real files under src/", () => {
  const block = /## Architecture[^\n]*\n\s*```[^\n]*\n([\s\S]*?)```/.exec(agents)?.[1];
  assert.ok(block, "AGENTS.md has an Architecture code block");
  const names = [...block.matchAll(/([A-Za-z0-9_-]+\.ts)\b/g)].map(match => match[1]!);
  assert.ok(names.length >= 5, `the Architecture block names the source files (found ${names.length})`);
  for (const name of new Set(names)) {
    assert.ok(existsSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url))), `AGENTS.md Architecture names src/${name}, which does not exist`);
  }
});

test("AGENTS.md states no test count", () => {
  assert.doesNotMatch(agents, /\b\d[\d,]*\s+(?:offline\s+|unit\s+|integration\s+)?tests?\b/i, "AGENTS.md must not state a test count: the number drifts and the map should not lie");
});
