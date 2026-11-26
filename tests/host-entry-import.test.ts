import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ENTRY_POINTS = [
  "dist/hosts/claude.js",
  "dist/hosts/codex.js",
  "dist/hosts/headless.js",
  "dist/rules-file.js",
  "dist/ask-gate.js",
  "dist/index.js",
] as const;

if (ENTRY_POINTS.some(entry => !existsSync(join(repoRoot, entry)))) {
  execFileSync(
    process.execPath,
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: repoRoot, stdio: "pipe", timeout: 60_000 },
  );
}

function collectSourceFiles(dir: string, relPrefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = posix.join(relPrefix, entry.name);
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, rel, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
}

function runtimeModuleSpecifiers(filePath: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (!clause) {
        specifiers.push(stmt.moduleSpecifier.text);
        continue;
      }
      if (clause.isTypeOnly) continue;
      if (clause.name) {
        specifiers.push(stmt.moduleSpecifier.text);
        continue;
      }
      const bindings = clause.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        specifiers.push(stmt.moduleSpecifier.text);
      } else if (bindings.elements.length === 0 || bindings.elements.some(el => !el.isTypeOnly)) {
        specifiers.push(stmt.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        specifiers.push(stmt.moduleSpecifier.text);
      } else if (clause.elements.length === 0 || clause.elements.some(el => !el.isTypeOnly)) {
        specifiers.push(stmt.moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      specifiers.push(stmt.moduleReference.expression.text);
    }
  }

  return specifiers;
}

function resolveRelativeTarget(fromRel: string, specifier: string, knownFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  const candidates: string[] = [];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  else if (base.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.mts`);
  else if (base.endsWith(".cjs")) candidates.push(`${base.slice(0, -4)}.cts`);
  candidates.push(base, `${base}.ts`, posix.join(base, "index.ts"));
  return candidates.find(candidate => knownFiles.has(candidate));
}

function cyclePathInScc(scc: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[] {
  const start = scc[0]!;
  if (scc.length === 1) return [start, start];
  const members = new Set(scc);
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const next of edges.get(start) ?? []) {
    if (!members.has(next)) continue;
    if (next === start) return [start, start];
    if (!parent.has(next)) {
      parent.set(next, start);
      queue.push(next);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const next of edges.get(current) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        const path = [start];
        let node: string | undefined = current;
        while (node !== undefined && node !== start) {
          path.push(node);
          node = parent.get(node);
        }
        path.push(start);
        return path.reverse();
      }
      if (!parent.has(next)) {
        parent.set(next, current);
        queue.push(next);
      }
    }
  }
  return [...scc, start];
}

function findRuntimeCycles(sources: ReadonlyMap<string, string>): string[] {
  const nodes = [...sources.keys()].sort();
  const knownFiles = new Set(nodes);
  const edges = new Map<string, string[]>();

  for (const file of nodes) {
    const text = sources.get(file) ?? "";
    const targets = new Set<string>();
    for (const spec of runtimeModuleSpecifiers(file, text)) {
      const target = resolveRelativeTarget(file, spec, knownFiles);
      if (target !== undefined) targets.add(target);
    }
    edges.set(file, [...targets].sort());
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[] = [];

  function strongConnect(v: string): void {
    const vIndex = nextIndex++;
    indices.set(v, vIndex);
    lowlink.set(v, vIndex);
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) ?? []) {
      const wIndex = indices.get(w);
      if (wIndex === undefined) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, wIndex));
      }
    }

    if (lowlink.get(v) === vIndex) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      const hasSelfLoop = scc.length === 1 && (edges.get(v) ?? []).includes(v);
      if (scc.length > 1 || hasSelfLoop) {
        scc.sort();
        const path = cyclePathInScc(scc, edges);
        if (scc.length === 2 && path.length === 3) {
          cycles.push(`${scc[0]} <-> ${scc[1]}`);
        } else {
          cycles.push(path.join(" -> "));
        }
      }
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) strongConnect(node);
  }

  return cycles.sort();
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

test("src/ has no static runtime ESM import cycles", () => {
  const files: string[] = [];
  collectSourceFiles(join(repoRoot, "src"), "src", files);
  files.sort();
  const sources = new Map<string, string>();
  for (const rel of files) {
    sources.set(rel, readFileSync(join(repoRoot, rel), "utf8"));
  }
  const cycles = findRuntimeCycles(sources);
  assert.deepEqual(cycles, [], `runtime import cycle(s) in src/:\n${cycles.join("\n")}`);
});

test("runtime cycle detector ignores type-only imports, comments, and strings while catching re-exports", () => {
  const typeOnlyGraph = new Map<string, string>([
    ["src/a.ts", 'import type { B } from "./b.js";\nimport { type AlsoB } from "./b.js";\n// import "./b.js";\nconst s = "import \'./b.js\'";\nexport const a = 1;'],
    ["src/b.ts", 'import { a } from "./a.js";\nexport type { B } from "./a.js";\nexport const b = a;'],
  ]);
  assert.deepEqual(findRuntimeCycles(typeOnlyGraph), []);

  const reExportCycle = new Map<string, string>([
    ["src/a.ts", 'export { b } from "./b.js";'],
    ["src/b.ts", 'import { b } from "./a.js";\nexport const x = b;'],
  ]);
  assert.deepEqual(findRuntimeCycles(reExportCycle), ["src/a.ts <-> src/b.ts"]);
});
