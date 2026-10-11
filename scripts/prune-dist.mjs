#!/usr/bin/env node
/**
 * Prune dist: delete every build output whose TypeScript source is gone.
 *
 * `tsc` writes outputs for current sources but never removes an output whose source was deleted, so `dist/` can
 * collect orphans from builds of other branches. Pruning after `tsc` keeps `dist/` equal to the current `src/`
 * without emptying it first; that empty window would leave a running session without the built extension.
 *
 * A file is kept only when stripping one of the extensions below gives a path `<rel>` for which `<source>/<rel>.ts`
 * exists and is not itself a declaration source. Everything else goes, including `.bak` files; directories left empty
 * are removed. `dist/` is not deleted before `tsc` runs.
 *
 * Usage: node scripts/prune-dist.mjs
 */
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Extensions an emitted file may carry; stripping one yields the source-relative path. */
const OUTPUT_EXTENSIONS = [".js", ".d.ts", ".js.map", ".d.ts.map"];

/** Repository root, two levels up from this script. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** True when `rel` is an output of a current, non-declaration source under `sourceDir`. */
function hasSource(rel, sourceDir) {
  for (const extension of OUTPUT_EXTENSIONS) {
    if (!rel.endsWith(extension)) continue;
    const source = `${rel.slice(0, -extension.length)}.ts`;
    if (source.endsWith(".d.ts")) continue;
    if (existsSync(join(sourceDir, source))) return true;
  }
  return false;
}

/** Collect every file under `dir`, as paths relative to `outDir`. */
function collectFiles(dir, outDir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, outDir, files);
    else files.push(relative(outDir, full));
  }
}

/** Remove directories under `dir` that hold nothing; `outDir` itself stays. */
function removeEmptyDirs(dir, outDir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name), outDir);
  }
  if (dir !== outDir && readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Delete every file under `outDir` that is not the output of a current source under `sourceDir`.
 * Returns the deleted paths, relative to `outDir`, sorted.
 */
export function pruneDist(sourceDir, outDir) {
  const source = resolve(sourceDir);
  const output = resolve(outDir);
  if (!existsSync(output)) return [];

  const files = [];
  collectFiles(output, output, files);
  const deleted = [];
  for (const rel of files) {
    if (hasSource(rel, source)) continue;
    rmSync(join(output, rel));
    deleted.push(rel);
  }
  removeEmptyDirs(output, output);
  return deleted.sort();
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const deleted = pruneDist(join(ROOT, "src"), join(ROOT, "dist"));
  // Write to stderr so `npm pack --json` keeps a clean JSON stdout.
  console.error(`pruned ${deleted.length} file${deleted.length === 1 ? "" : "s"} from dist/`);
}
