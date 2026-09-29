/**
 * Which driver the learning database actually opens with, observed from a child process so the
 * module-level connection cache and warnings start fresh. Both children run on Node: the Bun
 * runtime is covered by tests/sqlite-adapter.test.ts, and Bun cannot be made to refuse node:sqlite
 * here (Bun 1.4.2 loads it even from a --compile binary), so this file's children only run under
 * Node, where `npm test` runs them.
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
  if (specifier === "node:sqlite") throw new Error("blocked node:sqlite for this test");
  return next(specifier, context);
}
`;

const recordHoldCall = (projectRoot: string) => `await learning.recordHold({
  timestamp: Date.now(),
  projectRoot: ${JSON.stringify(projectRoot)},
  tool: "bash",
  commandPreview: "npm test",
  scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
  level: "allow",
  held: true,
  reasons: ["irreversible 0.5"],
});`;

/** Run a child that loads learning.ts and prints one parsed RESULT line. */
async function childResult(child: string, temp: string): Promise<{ stdout: string; stderr: string; data: Record<string, unknown> }> {
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], {
    cwd: root,
    env: { ...process.env, PI_WARDEN_DB: join(temp, "holds.db"), PI_CODING_AGENT_DIR: temp },
    encoding: "utf8",
  });
  const line = stdout.split("\n").find(row => row.startsWith("RESULT "));
  assert.ok(line, "child printed a result line; stdout was: " + stdout);
  return { stdout, stderr, data: JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown> };
}

const onBun = typeof process.versions.bun === "string";

if (!onBun) {
  test("the Node path opens the learning database with node:sqlite", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-warden-driver-"));
    try {
      const child = `
const learning = await import("./src/learning.ts");
await learning.initSchema(0);
const id = ${recordHoldCall("/driver/node/project")}
const rows = await learning.queryHoldsForProject("/driver/node/project");
console.log("RESULT " + JSON.stringify({ driver: learning.sqliteDriver() ?? null, id, rows: rows.length }));
`;
      const { data } = await childResult(child, temp);
      assert.equal(data.driver, "node:sqlite", "node:sqlite is tried first and loads on Node");
      assert.ok((data.id as number) > 0, "recordHold returned a real id, not the NOOP id");
      assert.equal(data.rows, 1, "the row was written to SQLite");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("with node:sqlite unresolvable and no Bun, learning turns off behind one warning naming both modules", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-warden-driver-"));
    try {
      const child = `
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hookSource)}));
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(" "));
const learning = await import("./src/learning.ts");
await learning.initSchema(0);
const id = ${recordHoldCall("/driver/blocked/project")}
const rows = await learning.queryHoldsForProject("/driver/blocked/project");
console.warn = originalWarn;
console.log("RESULT " + JSON.stringify({ driver: learning.sqliteDriver() ?? null, id, rows: rows.length, warnings }));
`;
      const { stderr, data } = await childResult(child, temp);
      const warnings = data.warnings as string[];
      assert.equal(warnings.length, 1, "exactly one warning, from the failed open");
      assert.match(warnings[0]!, /node:sqlite/, "the warning names node:sqlite");
      assert.match(warnings[0]!, /bun:sqlite/, "the warning names bun:sqlite");
      assert.match(warnings[0]!, /learning features disabled/, "the warning says learning is off");
      assert.equal(stderr.includes("pi-warden:"), false, "nothing else warned to stderr");
      assert.equal(data.driver, null, "no driver opened");
      assert.equal(data.id, 0, "recordHold answers the NOOP id instead of failing");
      assert.equal(data.rows, 0, "queries answer nothing instead of failing");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
