import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";

/** Directories to skip during source-file discovery. */
export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".output",
  "coverage", ".cache", "__pycache__", ".pi-warden", "vendor",
  ".turbo", ".vercel", ".netlify", ".svelte-kit",
]);

export const SOURCE_RE = /\.(ts|tsx|js|jsx|rs|py|go|vue|svelte|rb|php|java|kt|swift|cs|cpp|c|h)$/;

/**
 * Recursively walk `dir` and collect source-file paths (relative to `dir`).
 * Skips directories in SKIP_DIRS and stops after `max` files.
 */
export function discoverSourceFiles(dir: string, max = 200): string[] {
  const files: string[] = [];
  function walk(current: string) {
    if (files.length >= max) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(current, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch (err) { console.warn(`audit: could not list ${redact(current)}: ${err instanceof Error ? err.message : err}`); return; }
    for (const entry of entries) {
      if (files.length >= max) return;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile() && SOURCE_RE.test(entry.name)) {
        files.push(fullPath.slice(dir.length + 1)); // relative path
      }
    }
  }
  walk(dir);
  return files;
}

/**
 * Find project directories inside a workspace. A project is any directory
 * containing a known manifest file. The workspace root itself counts if it
 * has one.
 */
export function findProjects(cwd: string): string[] {
  const projects: string[] = [];
  const manifests = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];

  for (const m of manifests) {
    if (existsSync(join(cwd, m))) { projects.push(cwd); break; }
  }

  let entries: string[];
  try { entries = readdirSync(cwd); } catch (err) { console.warn(`audit: could not read workspace ${redact(cwd)}: ${err instanceof Error ? err.message : err}`); return projects; }

  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const sub = join(cwd, entry);
    try { if (!existsSync(join(sub, "package.json")) && !existsSync(join(sub, "Cargo.toml")) && !existsSync(join(sub, "pyproject.toml")) && !existsSync(join(sub, "go.mod"))) continue; } catch (err) { console.warn(`audit: could not check ${redact(sub)}: ${err instanceof Error ? err.message : err}`); continue; }
    if (!projects.includes(sub)) projects.push(sub);
  }

  return projects;
}
