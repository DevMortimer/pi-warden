import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { discoverSourceFiles, findProjects, SKIP_DIRS, SOURCE_RE } from "../src/discover.js";
import { buildAuditPrompt, snapshotReport, reportOutcome } from "../src/audit.js";

let temporary: string;

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-warden-audit-"));
});

after(async () => {
  await rm(temporary, { recursive: true, force: true });
});

// ─── discoverSourceFiles ──────────────────────────────────────────────────────

test("discoverSourceFiles: finds files in root-level layout (no src/, lib/, app/, internal/)", async () => {
  const project = join(temporary, "root-layout");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "index.ts"), "export const x = 1;");
  await writeFile(join(project, "utils.py"), "print('hi')");
  await writeFile(join(project, "main.go"), "package main");
  await writeFile(join(project, "README.md"), "# not source");

  const files = discoverSourceFiles(project);
  assert.ok(files.includes("index.ts"), "should find root-level .ts file");
  assert.ok(files.includes("utils.py"), "should find root-level .py file");
  assert.ok(files.includes("main.go"), "should find root-level .go file");
  assert.ok(!files.includes("README.md"), "should not include non-source files");
});

test("discoverSourceFiles: finds files in nested directories like packages/server/", async () => {
  const project = join(temporary, "nested-layout");
  await mkdir(join(project, "packages", "server"), { recursive: true });
  await mkdir(join(project, "packages", "client"), { recursive: true });
  await writeFile(join(project, "packages", "server", "handler.rs"), "fn main() {}");
  await writeFile(join(project, "packages", "client", "App.vue"), "<template/>");
  await writeFile(join(project, "packages", "server", "Cargo.toml"), "[package]");

  const files = discoverSourceFiles(project);
  assert.ok(files.includes("packages/server/handler.rs"), "should find nested .rs file");
  assert.ok(files.includes("packages/client/App.vue"), "should find nested .vue file");
  assert.ok(!files.includes("packages/server/Cargo.toml"), "should not include non-source files");
});

test("discoverSourceFiles: skips .git, node_modules, dist, build", async () => {
  const project = join(temporary, "skip-dirs");
  await mkdir(join(project, ".git", "objects"), { recursive: true });
  await mkdir(join(project, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(project, "dist"), { recursive: true });
  await mkdir(join(project, "build"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, ".git", "objects", "pack.ts"), "skip me");
  await writeFile(join(project, "node_modules", "pkg", "index.js"), "skip me");
  await writeFile(join(project, "dist", "bundle.js"), "skip me");
  await writeFile(join(project, "build", "output.ts"), "skip me");
  await writeFile(join(project, "src", "app.ts"), "find me");

  const files = discoverSourceFiles(project);
  assert.deepEqual(files, ["src/app.ts"], "only src/app.ts should be found");
});

test("discoverSourceFiles: skips .pi-warden directory", async () => {
  const project = join(temporary, "skip-pi-warden");
  await mkdir(join(project, ".pi-warden"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, ".pi-warden", "audit-report.html"), "<html>");
  await writeFile(join(project, "src", "main.ts"), "export {}");

  const files = discoverSourceFiles(project);
  assert.deepEqual(files, ["src/main.ts"]);
});

test("discoverSourceFiles: skips hidden directories (starting with dot)", async () => {
  const project = join(temporary, "skip-hidden");
  await mkdir(join(project, ".vscode"), { recursive: true });
  await mkdir(join(project, ".idea"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, ".vscode", "settings.ts"), "skip me");
  await writeFile(join(project, ".idea", "config.js"), "skip me");
  await writeFile(join(project, "src", "app.ts"), "find me");

  const files = discoverSourceFiles(project);
  assert.deepEqual(files, ["src/app.ts"]);
});

test("discoverSourceFiles: respects max limit", async () => {
  const project = join(temporary, "max-limit");
  await mkdir(project, { recursive: true });
  for (let i = 0; i < 10; i++) {
    await writeFile(join(project, `file${i}.ts`), `export const x${i} = ${i};`);
  }

  const files = discoverSourceFiles(project, 3);
  assert.equal(files.length, 3, "should stop at max");
});

test("discoverSourceFiles: returns empty array for empty directory", async () => {
  const project = join(temporary, "empty");
  await mkdir(project, { recursive: true });

  const files = discoverSourceFiles(project);
  assert.deepEqual(files, []);
});

test("discoverSourceFiles: handles non-existent directory gracefully", () => {
  const files = discoverSourceFiles("/nonexistent/path/that/does/not/exist");
  assert.deepEqual(files, []);
});

// ─── findProjects ─────────────────────────────────────────────────────────────

test("findProjects: discovers workspace root with package.json", async () => {
  const workspace = join(temporary, "workspace-root");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "package.json"), "{}");

  const projects = findProjects(workspace);
  assert.ok(projects.includes(workspace), "workspace root should be a project");
});

test("findProjects: discovers sub-projects with manifests", async () => {
  const workspace = join(temporary, "workspace-multi");
  await mkdir(join(workspace, "a"), { recursive: true });
  await mkdir(join(workspace, "b"), { recursive: true });
  await writeFile(join(workspace, "a", "package.json"), "{}");
  await writeFile(join(workspace, "b", "Cargo.toml"), "[package]");

  const projects = findProjects(workspace);
  assert.ok(projects.includes(join(workspace, "a")), "should find package a");
  assert.ok(projects.includes(join(workspace, "b")), "should find package b");
});

test("findProjects: skips node_modules and dot-directories", async () => {
  const workspace = join(temporary, "workspace-skip");
  await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, "real"), { recursive: true });
  await writeFile(join(workspace, "node_modules", "pkg", "package.json"), "{}");
  await writeFile(join(workspace, ".git", "config"), "");
  await writeFile(join(workspace, "real", "package.json"), "{}");

  const projects = findProjects(workspace);
  assert.ok(!projects.some(p => p.includes("node_modules")), "should not include node_modules");
  assert.ok(!projects.some(p => p.includes(".git")), "should not include .git");
  assert.ok(projects.includes(join(workspace, "real")), "should find real project");
});

// ─── SOURCE_RE ────────────────────────────────────────────────────────────────

test("SOURCE_RE matches expected extensions", () => {
  const shouldMatch = ["foo.ts", "foo.tsx", "foo.js", "foo.jsx", "foo.rs", "foo.py", "foo.go", "foo.vue", "foo.svelte", "foo.rb", "foo.php", "foo.java", "foo.kt", "foo.swift", "foo.cs", "foo.cpp", "foo.c", "foo.h"];
  const shouldNotMatch = ["foo.txt", "foo.md", "foo.json", "foo.yaml", "foo.css", "foo.html", "foo.toml", "foo.lock", "foo.jpg", "foo.png"];

  for (const name of shouldMatch) {
    assert.ok(SOURCE_RE.test(name), `${name} should match SOURCE_RE`);
  }
  for (const name of shouldNotMatch) {
    assert.ok(!SOURCE_RE.test(name), `${name} should not match SOURCE_RE`);
  }
});

// ─── SKIP_DIRS ────────────────────────────────────────────────────────────────

test("SKIP_DIRS contains expected directories", () => {
  for (const dir of [".git", "node_modules", "dist", "build", ".next", "coverage", "__pycache__", ".pi-warden", "vendor"]) {
    assert.ok(SKIP_DIRS.has(dir), `${dir} should be in SKIP_DIRS`);
  }
});

// ─── buildAuditPrompt ───────────────────────────────────────────────────────

test("buildAuditPrompt: returns a string containing project names and instructions", () => {
  const prompt = buildAuditPrompt("/tmp/workspace", ["/tmp/workspace", "/tmp/workspace/packages/a"]);
  assert.ok(typeof prompt === "string", "should return a string");
  assert.ok(prompt.includes("Workspace Audit"), "should mention workspace audit");
  assert.ok(prompt.includes("Jev"), "should mention Jev");
  assert.ok(prompt.includes("file:line"), "should ask for file:line citations");
  assert.ok(prompt.includes(".pi-warden/audit-report.html"), "should name the report path");
  assert.ok(prompt.includes("unmeasured"), "should mention unmeasured findings");
});

// ─── audit report mtime check ───────────────────────────────────────────────

// ─── reportOutcome ──────────────────────────────────────────────────────────

test("reportOutcome: missing when file does not exist after", () => {
  const snap = { exists: false, mtimeMs: 0 };
  assert.equal(reportOutcome(snap, snap), "missing");
});

test("reportOutcome: written when file exists after and did not exist before", () => {
  assert.equal(reportOutcome({ exists: false, mtimeMs: 0 }, { exists: true, mtimeMs: 100 }), "written");
});

test("reportOutcome: written when mtime advanced", () => {
  assert.equal(reportOutcome({ exists: true, mtimeMs: 100 }, { exists: true, mtimeMs: 200 }), "written");
});

test("reportOutcome: stale when file exists but mtime unchanged", () => {
  assert.equal(reportOutcome({ exists: true, mtimeMs: 100 }, { exists: true, mtimeMs: 100 }), "stale");
});

// ─── snapshotReport ─────────────────────────────────────────────────────────

test("snapshotReport: captures mtime of existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-audit-snap-"));
  const reportPath = join(dir, "report.html");
  await writeFile(reportPath, "<html>");
  const snap = snapshotReport(reportPath);
  assert.equal(snap.exists, true, "file should exist");
  assert.ok(snap.mtimeMs > 0, "mtime should be positive");
  // Touch with a later mtime
  await new Promise(r => setTimeout(r, 50));
  await writeFile(reportPath, "<html>updated</html>");
  const snap2 = snapshotReport(reportPath);
  assert.ok(snap2.mtimeMs > snap.mtimeMs, "mtime should advance after rewrite");
  await rm(dir, { recursive: true, force: true });
});

test("snapshotReport: returns missing for nonexistent file", () => {
  const snap = snapshotReport("/nonexistent/path/to/report.html");
  assert.equal(snap.exists, false);
  assert.equal(snap.mtimeMs, 0);
});
