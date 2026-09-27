/**
 * Learning DB injection: interleaved use of two injected directories keeps their rows apart, and
 * `PI_WARDEN_DB` wins over both.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The modules read PI_WARDEN_DB per call, never at load time, so a static import is safe
// even though the tests change the variable afterwards.
import { initSchema, recordHold, recordOutcome, queryHoldsForProject, holdStats } from "../src/learning.js";

const testA = mkdtempSync(join(tmpdir(), "pi-warden-db-a-"));
const testB = mkdtempSync(join(tmpdir(), "pi-warden-db-b-"));
const dirsA = { agentDir: testA, configDirName: ".pi" };
const dirsB = { agentDir: testB, configDirName: ".omp" };

delete process.env.PI_WARDEN_DB;

test.after(() => {
  rmSync(testA, { recursive: true, force: true });
  rmSync(testB, { recursive: true, force: true });
});

const hold = (project: string) => ({
  timestamp: Date.now(),
  projectRoot: project,
  tool: "bash",
  commandPreview: "cmd",
  scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
  level: "confirm" as const,
  held: true,
  reasons: ["irreversible 0.5"],
});

test("interleaved A→B→A: each directory sees only its own rows", async () => {
  await initSchema(0, dirsA);
  const idA = await recordHold(hold("/proj"), dirsA);
  assert.ok(idA > 0);
  assert.ok(existsSync(join(testA, "pi-warden", "holds.db")), "A's database is under A's agent dir");

  await initSchema(0, dirsB);
  const idB = await recordHold(hold("/proj"), dirsB);
  assert.ok(existsSync(join(testB, "pi-warden", "holds.db")), "B's database is under B's agent dir");

  // Back in A: the cached connection for A is reused and still holds only A's row.
  const againA = await queryHoldsForProject("/proj", undefined, dirsA);
  assert.equal(againA.length, 1, `A sees only its own row, got ${againA.length}`);
  const rowsB = await queryHoldsForProject("/proj", undefined, dirsB);
  assert.equal(rowsB.length, 1, "B sees only its own row");

  await recordOutcome(idA, "approved", dirsA);
  await recordOutcome(idB, "declined", dirsB);
  const statsA = await holdStats("/proj", dirsA);
  const statsB = await holdStats("/proj", dirsB);
  assert.equal(statsA.approved, 1);
  assert.equal(statsB.declined, 1);
  assert.equal(statsB.approved, 0, "B's labels never reach A");
});

test("PI_WARDEN_DB wins over injected dirs", async () => {
  const overrideDir = mkdtempSync(join(tmpdir(), "pi-warden-db-override-"));
  process.env.PI_WARDEN_DB = join(overrideDir, "override.db");
  try {
    await initSchema(0, dirsA);
    await recordHold(hold("/proj"), dirsA);
    assert.ok(existsSync(process.env.PI_WARDEN_DB), "the override path is used");
    const rows = await queryHoldsForProject("/proj", undefined, dirsB);
    assert.equal(rows.length, 1, "both dirs resolve to the same override database");
  } finally {
    delete process.env.PI_WARDEN_DB;
    rmSync(overrideDir, { recursive: true, force: true });
  }
});

test("a failed open is closed, remembered, and warned about once", async () => {
  const bad = mkdtempSync(join(tmpdir(), "pi-warden-db-bad-"));
  const dirsBad = { agentDir: bad, configDirName: ".pi" };
  const dbPath = join(bad, "pi-warden", "holds.db");
  mkdirSync(join(bad, "pi-warden"), { recursive: true });
  writeFileSync(dbPath, "this is not a database");
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...parts: unknown[]) => warnings.push(String(parts[0]));
  try {
    await initSchema(0, dirsBad);
    await initSchema(0, dirsBad);
    await recordHold(hold("/proj"), dirsBad);
    assert.equal(warnings.filter(text => text.includes("could not open")).length, 1, "warned once, not per call");
    // The failure is per path: a fresh directory still records.
    const fresh = mkdtempSync(join(tmpdir(), "pi-warden-db-fresh-"));
    try {
      await initSchema(0, { agentDir: fresh, configDirName: ".pi" });
      const id = await recordHold(hold("/proj"), { agentDir: fresh, configDirName: ".pi" });
      assert.ok(id > 0, "a fresh directory records after another path failed");
      assert.equal(warnings.filter(text => text.includes("could not open")).length, 1, "no new warning for the good path");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    console.warn = original;
    rmSync(bad, { recursive: true, force: true });
  }
});
