// src/sqlite-adapter.ts - bun:sqlite fallback for the learning database
//
// node:sqlite stays the first choice and is not touched here. Pi's release binaries are Bun
// --compile executables in which node:sqlite may not be a built-in module, so learning needs a
// second way in: bun:sqlite, wrapped to answer like the DatabaseSync subset learning calls. One
// module owns the difference, so src/learning.ts keeps a single code path for both drivers.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The driver that opened the learning database. */
export type SqliteDriver = "node:sqlite" | "bun:sqlite";

/** Bindable values. Learning binds only positional `?` placeholders, never named keys, so the
 *  named-parameter prefixes never meet: Bun's default (non-strict) mode already accepts both a
 *  bare `name` and a `$name` key, and the adapter does not open in strict mode. */
export type SqliteValue = null | number | bigint | string | ArrayBufferView;

export type SqliteRow = Record<string, unknown>;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: SqliteValue[]): SqliteRunResult;
  get(...params: SqliteValue[]): SqliteRow | undefined;
  all(...params: SqliteValue[]): SqliteRow[];
}

/** The DatabaseSync subset learning uses: schema and PRAGMAs through exec, rows through prepare. */
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** bun:sqlite's statement shape, as the adapter reads it. */
export interface BunSqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): SqliteRow | null;
  all(...params: unknown[]): SqliteRow[];
}

/** bun:sqlite's handle shape, as the adapter reads it. */
export interface BunSqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): BunSqliteStatement;
  close(): void;
}

/** bun:sqlite could not be loaded. The caller reports "neither module" and learning stays off. */
export class SqliteUnavailableError extends Error {
  constructor(moduleName: string, cause: unknown) {
    super(`${moduleName} could not be loaded`, { cause });
  }
}

/** True when this process is Bun, the only runtime where bun:sqlite can be loaded. */
export function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string" || typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open the learning database through bun:sqlite. Throws SqliteUnavailableError when the module
 * does not load; any other error is a path open or PRAGMA failure for this path only, and the
 * half-open handle is closed first, as the node:sqlite path does.
 */
export async function openBunSqlite(dbPath: string): Promise<SqliteDb> {
  let bunSqlite: typeof import("bun:sqlite");
  try {
    bunSqlite = await import("bun:sqlite");
  } catch (err) {
    throw new SqliteUnavailableError("bun:sqlite", err);
  }
  // bun:sqlite does not create parent directories either; on a fresh machine the folder is missing.
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = wrapBunDatabase(new bunSqlite.Database(dbPath));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 10000");
  } catch (err) {
    try { db.close(); } catch { /* already closed */ }
    throw err;
  }
  return db;
}

/** Present a bun:sqlite handle as the DatabaseSync subset learning uses. */
export function wrapBunDatabase(db: BunSqliteHandle): SqliteDb {
  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => stmt.run(...params),
        // Bun answers a miss with null where node:sqlite answers undefined. Learning reads no row
        // as undefined, so the adapter hands back the node answer.
        get: (...params) => stmt.get(...params) ?? undefined,
        all: (...params) => stmt.all(...params),
      };
    },
    close() {
      db.close();
    },
  };
}
