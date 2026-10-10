import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What the running pi-warden was built from, read once when a session starts and shown by `/warden status`.
 *
 * Pi loads the extension from `extensions/index.js`, which re-exports `dist/extension.js`, so the module URL is the
 * built file. The package root resolves from there; `dist/extension.js` is the shipped entry and `src/` is the source a
 * checkout edits. A published package has no `src/`, so the stale check only speaks for a git checkout.
 */
export interface WardenBuild {
  version: string;
  /** Short HEAD commit when the package root is a git checkout; undefined otherwise. */
  commit: string | undefined;
  /** ISO build time of `dist/extension.js`; undefined when the shipped entry is missing. */
  builtAt: string | undefined;
  /** Version of the pi-typesafe that this process loaded. */
  typesafeVersion: string | undefined;
  /** The caret range pi-warden declares for pi-typesafe. */
  typesafeRange: string | undefined;
  /** True when a file under `src/` is newer than `dist/extension.js`. */
  stale: boolean;
}

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The short commit of the checkout that holds `root`, or undefined when `root` is not a git checkout. */
function gitCommit(root: string): string | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const output = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 2000 });
    const commit = output.trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

/** The newest mtime under `src/`, or 0 when the package has no source directory (a published install). */
function newestSourceMtime(root: string): number {
  const source = join(root, "src");
  if (!existsSync(source)) return 0;
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        // A file removed between the readdir and the stat cannot be the one that makes the build stale.
        const info = statSync(path, { throwIfNoEntry: false });
        if (info) newest = Math.max(newest, info.mtimeMs);
      }
    }
  };
  walk(source);
  return newest;
}

/** The version of the pi-typesafe this process resolved, from its package manifest. */
function loadedTypesafeVersion(): string | undefined {
  try {
    // pi-typesafe is ESM-only (its exports define `import`, not `require`), so resolve it the ESM way and walk up to
    // the manifest; `require.resolve` fails with ERR_PACKAGE_PATH_NOT_EXPORTED on this package.
    let dir = dirname(fileURLToPath(import.meta.resolve("pi-typesafe")));
    while (!existsSync(join(dir, "package.json")) && dir !== dirname(dir)) dir = dirname(dir);
    const manifest = readJson(join(dir, "package.json"));
    return typeof manifest?.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `version` sits inside the caret range `range`. Only `^x.y.z` is read, the form pi-warden declares; an
 * unreadable range or version returns true so a version string this code cannot parse never pages the user.
 */
export function satisfiesCaret(version: string, range: string): boolean {
  const wanted = /^\s*\^\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(range);
  const got = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!wanted || !got) return true;
  const [wantedMajor, wantedMinor, wantedPatch] = [Number(wanted[1]), Number(wanted[2]), Number(wanted[3])];
  const [major, minor, patch] = [Number(got[1]), Number(got[2]), Number(got[3])];
  if (major !== wantedMajor) return false;
  // A caret on 0.x is an exact minor line in npm (^0.9.1 := >=0.9.1 <0.10.0); above 0 it holds the major.
  if (wantedMajor > 0) return minor > wantedMinor || (minor === wantedMinor && patch >= wantedPatch);
  return minor === wantedMinor && patch >= wantedPatch;
}

/** Read the build provenance of this checkout or install. Never throws: a missing or unreadable file reads as absent. */
export function readWardenBuild(): WardenBuild {
  const manifest = readJson(join(packageRoot, "package.json")) ?? {};
  const dependencies = (manifest.dependencies ?? {}) as Record<string, unknown>;
  const dist = join(packageRoot, "dist", "extension.js");
  let builtAt: string | undefined;
  let builtMtime = 0;
  try {
    builtMtime = statSync(dist).mtimeMs;
    builtAt = new Date(builtMtime).toISOString();
  } catch {
    builtAt = undefined;
  }
  return {
    version: typeof manifest.version === "string" ? manifest.version : "unknown",
    commit: gitCommit(packageRoot),
    builtAt,
    typesafeVersion: loadedTypesafeVersion(),
    typesafeRange: typeof dependencies["pi-typesafe"] === "string" ? dependencies["pi-typesafe"] as string : undefined,
    stale: builtAt !== undefined && newestSourceMtime(packageRoot) > builtMtime,
  };
}
