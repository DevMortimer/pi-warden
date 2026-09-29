/**
 * The bun:sqlite adapter: the DatabaseSync subset learning uses, behind Bun's API shape.
 *
 * The shape below was measured on Bun 1.4.2 with a real `bun:sqlite` database: `exec()` answers a
 * result object instead of void, `get()` answers `null` for a miss instead of undefined, `run()`
 * answers `{ changes, lastInsertRowid }` as numbers, and there is no `pragma()` method, so PRAGMAs
 * go through `exec()`. The fake runs everywhere; the `bun:sqlite` module itself is exercised only
 * when the suite runs under Bun (`npm run test:bun`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBunRuntime, openBunSqlite, wrapBunDatabase, SqliteUnavailableError } from "../src/sqlite-adapter.js";
import { HOLDS_SCHEMA } from "../src/learning.js";

const onBun = typeof process.versions.bun === "string";

class FakeBunStatement {
  readonly bound: unknown[][] = [];
  constructor(private readonly rows: Record<string, unknown>[], private readonly changes = 1, private readonly lastInsertRowid = 7) {}
  run(...params: unknown[]) { this.bound.push(params); return { changes: this.changes, lastInsertRowid: this.lastInsertRowid }; }
  get(...params: unknown[]) { this.bound.push(params); return this.rows[0] ?? null; }
  all(...params: unknown[]) { this.bound.push(params); return this.rows; }
}

class FakeBunDatabase {
  readonly executed: string[] = [];
  readonly statements = new Map<string, FakeBunStatement>();
  closed = false;
  constructor(private readonly rows: Record<string, unknown>[] = []) {}
  exec(sql: string) { this.executed.push(sql); return { changes: 0, lastInsertRowid: 0 }; }
  prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, statement = new FakeBunStatement(this.rows));
    return statement;
  }
  close() { this.closed = true; }
}

/** The adapter on a fake handle with Bun's shape. */
function adapt(rows: Record<string, unknown>[] = []): { db: ReturnType<typeof wrapBunDatabase>; fake: FakeBunDatabase } {
  const fake = new FakeBunDatabase(rows);
  return { db: wrapBunDatabase(fake), fake };
}

test("exec runs Bun's SQL and answers nothing, like node:sqlite", () => {
  const { db, fake } = adapt();
  const returned = db.exec("PRAGMA busy_timeout = 10000");
  assert.equal(returned, undefined, "exec answers void even though Bun answers a result object");
  assert.deepEqual(fake.executed, ["PRAGMA busy_timeout = 10000"], "the SQL reaches Bun unchanged");
});

test("get turns Bun's null miss into undefined", () => {
  const { db } = adapt();
  assert.equal(db.prepare("SELECT id FROM holds WHERE id = ?").get(999), undefined, "a miss answers undefined, as node:sqlite does");
});

test("get passes Bun's row through", () => {
  const { db } = adapt([{ id: 3, held: 1, outcome: "approved" }]);
  assert.deepEqual(db.prepare("SELECT id, held, outcome FROM holds WHERE id = ?").get(3), { id: 3, held: 1, outcome: "approved" });
});

test("all passes Bun's rows through", () => {
  const { db } = adapt([{ id: 1 }, { id: 2 }]);
  assert.deepEqual(db.prepare("SELECT id FROM holds ORDER BY id").all(), [{ id: 1 }, { id: 2 }], "an array of rows, empty array for no rows");
  assert.deepEqual(adapt().db.prepare("SELECT id FROM holds").all(), [], "no rows answers an empty array");
});

test("run keeps Bun's changes and lastInsertRowid usable", () => {
  const { db } = adapt();
  const result = db.prepare("INSERT INTO holds (timestamp) VALUES (?)").run(Date.now());
  assert.deepEqual(result, { changes: 1, lastInsertRowid: 7 }, "the same keys node:sqlite answers");
  assert.ok(result.changes > 0, "initSchema reads changes as a number");
  assert.equal(Number(result.lastInsertRowid), 7, "recordHold reads Number(lastInsertRowid)");
});

test("positional parameters reach Bun's statement unchanged", () => {
  const { db, fake } = adapt();
  const sql = "SELECT id FROM holds WHERE project_root = ? AND held = ?";
  db.prepare(sql).all("/test/project", 1);
  assert.deepEqual(fake.statements.get(sql)?.bound, [["/test/project", 1]], "learning binds only positional ? placeholders");
});

test("close delegates to Bun's handle", () => {
  const { db, fake } = adapt();
  db.close();
  assert.equal(fake.closed, true, "Bun's close() is called");
});

// On Bun there is nothing to refuse: bun:sqlite loads there, so this half runs on Node only.
if (!onBun) {
  test("the adapter refuses to open on a runtime without bun:sqlite", async () => {
    assert.equal(isBunRuntime(), false, "Node does not report itself as Bun");
    const dir = mkdtempSync(join(tmpdir(), "pi-warden-nobun-"));
    try {
      const file = join(dir, "nested", "holds.db");
      await assert.rejects(
        () => openBunSqlite(file),
        (err: unknown) => err instanceof SqliteUnavailableError && /bun:sqlite/.test((err as Error).message),
        "openBunSqlite reports the module it could not load",
      );
      assert.equal(existsSync(join(dir, "nested")), false, "the import fails before anything is written to disk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

if (onBun) {
  test("this runtime is Bun", () => {
    assert.equal(isBunRuntime(), true, "process.versions.bun is set");
  });

  test("openBunSqlite opens a real database with the schema, pragmas, and rows learning needs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-warden-bun-"));
    try {
      const file = join(dir, "nested", "holds.db");
      const db = await openBunSqlite(file);
      assert.ok(existsSync(file), "the adapter created the missing parent directory");
      db.exec(HOLDS_SCHEMA);

      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(mode.journal_mode, "wal", "journal_mode = WAL is set, as on the node:sqlite path");
      const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(busy.timeout, 10000, "busy_timeout = 10000 is set, as on the node:sqlite path");

      const inserted = db.prepare(
        "INSERT INTO holds (timestamp, project_root, tool, signature_hash, scores, level, held, reasons) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(Date.now(), "/bun/project", "bash", "hash", JSON.stringify({ irreversible: 0.5, reasons: [] }), "confirm", 1, JSON.stringify(["irreversible 0.5"]));
      const id = Number(inserted.lastInsertRowid);
      assert.ok(id > 0, "recordHold's id path works");

      assert.deepEqual(db.prepare("SELECT tool, held FROM holds WHERE id = ?").get(id), { tool: "bash", held: 1 }, "row values match node:sqlite's");
      assert.equal(db.prepare("SELECT tool FROM holds WHERE id = ?").get(999_999), undefined, "a miss answers undefined through the adapter");
      assert.equal(db.prepare("SELECT tool FROM holds WHERE id > ?").all(999_999).length, 0, "no rows answers an empty array");
      assert.equal(db.prepare("SELECT COUNT(*) AS total FROM holds").get()?.total, 1, "aggregate queries answer a row, as holdStats reads them");

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
