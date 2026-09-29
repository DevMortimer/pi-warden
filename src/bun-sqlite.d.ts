/**
 * Local types for the optional `bun:sqlite` fallback, so the TypeScript build needs no new
 * dependency. Only the members `src/sqlite-adapter.ts` touches are declared; Bun ships its own
 * types with its runtime. Measured on Bun 1.4.2: `exec()` answers a result object instead of
 * void, `get()` answers `null` for a miss instead of undefined, and `prepare()` has no
 * `pragma()` counterpart (PRAGMAs go through `exec()`).
 */
declare module "bun:sqlite" {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class Statement {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Record<string, unknown>[];
  }

  export interface DatabaseOptions {
    /** Create the file when it does not exist. Defaults to `true`. */
    create?: boolean;
    /** Open read-only. */
    readonly?: boolean;
    /** Require named parameters without the `$` prefix. Defaults to `false`, which accepts both. */
    strict?: boolean;
  }

  export class Database {
    constructor(path: string, options?: DatabaseOptions);
    exec(sql: string): unknown;
    prepare(sql: string): Statement;
    close(): void;
  }
}
