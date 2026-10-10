import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { pruneDist } from "../scripts/prune-dist.mjs";

/** Every file under `dir`, relative to it, sorted. */
function listFiles(dir: string, base: string = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else files.push(relative(base, full));
  }
  return files.sort();
}

/** A source and output tree with kept outputs, orphans, a `.bak` file, and an orphan-only subdirectory. */
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "prune-dist-test-"));
  const src = join(base, "src");
  const dist = join(base, "dist");
  mkdirSync(join(src, "nested"), { recursive: true });
  writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(src, "nested", "b.ts"), "export const b = 2;\n");
  // A declaration source emits nothing, so its same-named output is an orphan.
  writeFileSync(join(src, "types.d.ts"), "declare const types: number;\n");
  mkdirSync(join(dist, "nested"), { recursive: true });
  mkdirSync(join(dist, "sub"), { recursive: true });
  for (const file of [
    "a.js",
    "a.d.ts",
    "a.js.map",
    "nested/b.js",
    "nested/b.d.ts.map",
    "orphan.js",
    "orphan.d.ts",
    "orphan.js.map",
    "types.d.ts",
    "extension.js.bak",
    "sub/old.js",
    "sub/old.d.ts",
  ]) {
    writeFileSync(join(dist, file), "x\n");
  }
  return { base, src, dist };
}

test("pruneDist keeps current outputs and deletes the rest", () => {
  const { base, src, dist } = makeTree();
  const deleted = pruneDist(src, dist);

  assert.deepEqual(listFiles(dist), ["a.d.ts", "a.js", "a.js.map", "nested/b.d.ts.map", "nested/b.js"]);
  assert.deepEqual(deleted, [
    "extension.js.bak",
    "orphan.d.ts",
    "orphan.js",
    "orphan.js.map",
    "sub/old.d.ts",
    "sub/old.js",
    "types.d.ts",
  ]);
  assert.equal(existsSync(join(dist, "sub")), false);
  assert.equal(existsSync(join(base, "src")), true);
});

test("pruneDist removes nested directories that become empty", () => {
  const base = mkdtempSync(join(tmpdir(), "prune-dist-test-"));
  const src = join(base, "src");
  const dist = join(base, "dist");
  mkdirSync(join(src, "keep"), { recursive: true });
  mkdirSync(join(dist, "keep"), { recursive: true });
  mkdirSync(join(dist, "deep", "deeper"), { recursive: true });
  writeFileSync(join(src, "keep", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dist, "keep", "a.js"), "x\n");
  writeFileSync(join(dist, "deep", "deeper", "gone.js"), "x\n");

  const deleted = pruneDist(src, dist);

  assert.deepEqual(listFiles(dist), ["keep/a.js"]);
  assert.deepEqual(deleted, ["deep/deeper/gone.js"]);
  assert.equal(existsSync(join(dist, "deep")), false);
  assert.equal(existsSync(resolve(dist, "keep")), true);
});
