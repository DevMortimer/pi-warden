// src/learning.ts - Smart hold learning system
// Records full context with each hold and predicts outcomes using history.

import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { isBunRuntime, openBunSqlite, SqliteUnavailableError } from "./sqlite-adapter.js";
import type { SqliteDb, SqliteDriver } from "./sqlite-adapter.js";
import type { HostDirs } from "./host-dirs.js";
import { defaultHostDirs } from "./host-dirs.js";
import { userConfigPath } from "./config.js";
import { redact } from "./redact.js";
import type { CallScores } from "./holds.js";

const dbs = new Map<string, Promise<SqliteDb>>();
let sqliteAvailable: boolean | undefined;
/** Which module opened the learning database; undefined while learning is off. */
let driver: SqliteDriver | undefined;

// --- Schema (shared constant) ---

/**
 * The `holds` table: one row per judged call. The last five columns are what an earlier version wrote and nothing
 * reads now; they stay, always empty, so a session still running that version -- whose INSERT names them -- and a
 * downgrade keep recording holds into a migrated database instead of failing every guarded call until they restart.
 */
const HOLDS_TABLE_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
  ["timestamp", "INTEGER NOT NULL"],
  ["project_root", "TEXT NOT NULL"],
  ["session_id", "TEXT"],
  ["tool", "TEXT NOT NULL"],
  ["signature_hash", "TEXT NOT NULL"],
  ["command_preview", "TEXT"],
  ["task_hash", "TEXT"],
  ["plan", "TEXT"],
  ["context_summary", "TEXT"],
  ["scores", "TEXT NOT NULL"],
  ["level", "TEXT NOT NULL"],
  ["held", "INTEGER NOT NULL"],
  ["reasons", "TEXT"],
  ["agent_reason", "TEXT"],
  ["outcome", "TEXT"],
  ["outcome_at", "INTEGER"],
  ["task", "TEXT"],
  ["input_summary", "TEXT"],
  ["preceding_actions", "TEXT"],
  ["prediction", "TEXT"],
  ["confidence", "REAL"],
];

const HOLDS_TABLE = HOLDS_TABLE_COLUMNS.map(([name, type]) => `    ${name} ${type}`).join(",\n");

const HOLDS_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_holds_project_signature ON holds(project_root, signature_hash);
  CREATE INDEX IF NOT EXISTS idx_holds_outcome ON holds(outcome);
  CREATE INDEX IF NOT EXISTS idx_holds_timestamp ON holds(timestamp);`;

/** Columns only a held row keeps: the held = 1 queries read them; nothing reads them for an allowed call. */
const HELD_ONLY_COLUMNS = ["task_hash", "plan", "context_summary", "scores", "reasons", "agent_reason"];

/** Text an earlier layout wrote for every call, held or not. Clearing it is the size win; the columns stay. */
const LEGACY_TEXT_COLUMNS = ["task", "input_summary", "preceding_actions", "prediction"];

/** Everything an allowed row is better off without; the migration clears it on the rows of calls that were not held. */
const CLEARED_ON_ALLOWED_COLUMNS = [...HELD_ONLY_COLUMNS, ...LEGACY_TEXT_COLUMNS];

/**
 * The columns whose content marks a row an older session wrote. `scores` is not one: every layout declares it NOT
 * NULL, so an allowed row always carries the empty object, and a row this version wrote matches nothing here.
 */
const MARKS_AN_OLDER_ROW = CLEARED_ON_ALLOWED_COLUMNS.filter(name => name !== "scores");

/** `hold_meta` keys: that the one-time move ran, and the highest row id whose allowed text was cleared. */
const LAYOUT_KEY = "layout";
const ALLOWED_CLEARED_ID = "allowed_cleared_id";

/**
 * Three tables. `holds` keeps one row per judged call: the columns every reader uses on every row, plus the
 * context a held row carries. The task text is stored once in `hold_tasks`, keyed by its hash, so a turn's
 * task is not repeated for every call it made; `holds.task_hash` points at it. A call that was not held has
 * no context columns: no reader asks for them on an allowed row, and they were most of the file. `hold_meta`
 * holds the two marks the startup maintenance steps keep. The five columns at the end stay for the version
 * that wrote them; see HOLDS_TABLE_COLUMNS.
 */
export const HOLDS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS holds (${HOLDS_TABLE}
  );
  CREATE TABLE IF NOT EXISTS hold_tasks (
    hash TEXT PRIMARY KEY,
    text TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS hold_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  ) WITHOUT ROWID;${HOLDS_INDEXES}
`;

/** The task text hash: the key of hold_tasks. */
export function taskHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const NOOP_DB = {
  exec() {},
  prepare() { return { run() { return { changes: 0, lastInsertRowid: 0 }; }, get() { return undefined; }, all() { return []; } }; },
  pragma() {},
} as unknown as SqliteDb;

/** Learning stays off: one warning names both candidate modules so the report says what to look at. */
function disableLearning(detail: unknown): SqliteDb {
  sqliteAvailable = false;
  console.warn("pi-warden: node:sqlite unavailable, bun:sqlite unavailable, learning features disabled:", detail);
  return NOOP_DB;
}

/** Pi's release binaries are Bun --compile executables, where node:sqlite may not be a built-in
 *  module while bun:sqlite always is. On Bun the database opens through the adapter; with neither
 *  module loading, learning stays off behind one warning. */
async function openBunFallback(dbPath: string, nodeFailure: unknown): Promise<SqliteDb> {
  if (!isBunRuntime()) return disableLearning(nodeFailure);
  try {
    const db = await openBunSqlite(dbPath);
    sqliteAvailable = true;
    driver = "bun:sqlite";
    return db;
  } catch (err) {
    if (err instanceof SqliteUnavailableError) return disableLearning(err);
    // bun:sqlite did load (this is Bun), so only this path failed, as on the node:sqlite path.
    sqliteAvailable = true;
    console.warn(`pi-warden: could not open ${dbPath}:`, err);
    return NOOP_DB;
  }
}

/** Open one connection; a failure is remembered per path so later calls neither warn again nor retry forever. */
async function openDb(dbPath: string): Promise<SqliteDb> {
  let opened: SqliteDb | undefined;
  try {
    // Static import cannot work: node:sqlite is flagged experimental and loads lazily so a missing
    // or broken build of it disables learning features instead of failing the whole process.
    const sqlite = await import("node:sqlite").catch(err => ({ importFailed: err as unknown }));
    if ("importFailed" in sqlite) return await openBunFallback(dbPath, sqlite.importFailed);
    const { DatabaseSync } = sqlite;
    sqliteAvailable = true;
    // DatabaseSync does not create parent directories; on a fresh machine the folder may not exist yet.
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    opened = new DatabaseSync(dbPath);
    opened.exec("PRAGMA journal_mode = WAL");
    opened.exec("PRAGMA busy_timeout = 10000");
    driver = "node:sqlite";
    return opened;
  } catch (err) {
    // Import failures are handled above; this is a path open or PRAGMA failure for this path only.
    // Close the half-opened handle and leave the resolved NOOP promise cached: one warning,
    // and later calls neither reopen nor retry an unusable file.
    try { opened?.close(); } catch { /* already closed */ }
    console.warn(`pi-warden: could not open ${dbPath}:`, err);
    return NOOP_DB;
  }
}

/** One connection per resolved path; concurrent first calls share one open. */
async function getDb(dirs: HostDirs = defaultHostDirs()): Promise<SqliteDb> {
  const dbPath = process.env.PI_WARDEN_DB ?? join(dirname(userConfigPath(dirs)), "holds.db");
  if (sqliteAvailable === false) return NOOP_DB;
  let opening = dbs.get(dbPath);
  if (!opening) dbs.set(dbPath, opening = openDb(dbPath));
  return opening;
}

/** Which module opened the learning database: "node:sqlite", "bun:sqlite", or undefined while learning is off. */
export function sqliteDriver(): SqliteDriver | undefined {
  return driver;
}

/** The columns `holds` has right now; empty when the table does not exist. */
function tableColumns(d: SqliteDb, table: string): Set<string> {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.map(row => String(row.name)));
}

/** The highest row id in `holds`; 0 on an empty table. It reads the rowid, so it costs no scan. */
function newestHoldId(d: SqliteDb): number {
  const row = d.prepare("SELECT MAX(id) AS id FROM holds").get() as { id?: unknown } | undefined;
  return Number(row?.id ?? 0) || 0;
}

/** One `hold_meta` mark; 0 when it was never written. */
function readMeta(d: SqliteDb, key: string): number {
  const row = d.prepare("SELECT value FROM hold_meta WHERE key = ?").get(key) as { value?: unknown } | undefined;
  return Number(row?.value ?? 0) || 0;
}

function writeMeta(d: SqliteDb, key: string, value: number): void {
  d.prepare("INSERT INTO hold_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** The task text of each held row moves into `hold_tasks` once; the row keeps the hash. */
function moveTaskText(d: SqliteDb): void {
  const insert = d.prepare("INSERT OR IGNORE INTO hold_tasks (hash, text) VALUES (?, ?)");
  const update = d.prepare("UPDATE holds SET task_hash = ? WHERE id = ?");
  const rows = d.prepare("SELECT id, task FROM holds WHERE held = 1 AND task IS NOT NULL AND length(task) > 0").all() as Array<{ id: number; task: string }>;
  for (const row of rows) {
    const hash = taskHash(row.task);
    insert.run(hash, row.task);
    update.run(hash, row.id);
  }
}

/** Clear the text an older layout wrote; a held row's task text is in `hold_tasks` by then. */
function clearLegacyText(d: SqliteDb): void {
  d.prepare(`UPDATE holds SET ${LEGACY_TEXT_COLUMNS.map(name => `${name} = NULL`).join(", ")}
    WHERE ${LEGACY_TEXT_COLUMNS.map(name => `${name} IS NOT NULL`).join(" OR ")}`).run();
}

/**
 * Clear the context and text of every allowed row past `fromId`. A row that carries none of it is left alone, so a
 * start that finds only rows this version wrote changes no page. `scores` takes the empty object rather than NULL:
 * every layout declares it NOT NULL, and an older table rejects a NULL write.
 */
function clearAllowedText(d: SqliteDb, fromId: number): void {
  const assignments = CLEARED_ON_ALLOWED_COLUMNS.map(name => `${name} = ${name === "scores" ? "'{}'" : "NULL"}`).join(", ");
  const mark = MARKS_AN_OLDER_ROW.map(name => `${name} IS NOT NULL`).join(" OR ");
  d.prepare(`UPDATE holds SET ${assignments} WHERE held = 0 AND id > ? AND (${mark})`).run(fromId);
}

/**
 * One-time move to the slim layout, inside one transaction: no column is dropped and no row is copied, so a session
 * still running an older version keeps writing into this table. The task text of each held row lands once in
 * `hold_tasks` (the row keeps its hash), the older layout's text is cleared, and the rows of calls that were not
 * held keep no context columns. A missing column is added, which also gives back the columns an earlier build of
 * this version slimmed away. A database already on this layout is left alone. Returns whether it changed anything.
 */
function migrateHolds(d: SqliteDb): boolean {
  const before = tableColumns(d, "holds");
  // No `held` column: not a table this code wrote. Leave it alone, as earlier versions did.
  if (!before.has("held")) return false;
  const missing = HOLDS_TABLE_COLUMNS.filter(([name]) => !before.has(name));
  const move = before.has("task") && readMeta(d, LAYOUT_KEY) === 0;
  if (!missing.length && !move) return false;
  d.exec("BEGIN IMMEDIATE");
  try {
    // An added column carries no constraint: NOT NULL cannot be added to a table that already has rows.
    for (const [name, type] of missing) d.exec(`ALTER TABLE holds ADD COLUMN ${name} ${type.replace(" NOT NULL", "")}`);
    if (move) {
      moveTaskText(d);
      clearLegacyText(d);
      clearAllowedText(d, 0);
      writeMeta(d, ALLOWED_CLEARED_ID, newestHoldId(d));
      writeMeta(d, LAYOUT_KEY, 1);
    }
    d.exec("COMMIT");
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch { /* the transaction is already gone */ }
    throw err;
  }
  return true;
}

/**
 * At each start, clear the context and text of the allowed rows an older session wrote since the last one: that
 * version knows nothing of this layout and fills the columns this one never writes. The highest id already cleared
 * is kept in `hold_meta`, so a start looks only at the rows written after it and writes nothing when there are
 * none. Another session holding the database skips the step, as it does the prune; the next start runs it.
 */
function slimAllowedRows(d: SqliteDb): void {
  const cleared = readMeta(d, ALLOWED_CLEARED_ID);
  const newest = newestHoldId(d);
  if (newest <= cleared) return;
  d.exec("BEGIN IMMEDIATE");
  try {
    clearAllowedText(d, cleared);
    writeMeta(d, ALLOWED_CLEARED_ID, newest);
    d.exec("COMMIT");
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch { /* the transaction is already gone */ }
    throw err;
  }
}

/**
 * Delete rows past their retention: an allowed call (`held = 0`) is kept `allowedRetentionDays`, a hold
 * `retentionDays`. 0 on either keeps those rows. Task text no remaining row points at goes with them, so the
 * dedup table does not grow past the rows that use it.
 */
function pruneHolds(d: SqliteDb, retentionDays: number, allowedRetentionDays: number): void {
  const now = Date.now();
  let deleted = 0;
  if (allowedRetentionDays > 0) deleted += Number(d.prepare("DELETE FROM holds WHERE held = 0 AND timestamp < ?").run(now - allowedRetentionDays * 86_400_000).changes ?? 0);
  if (retentionDays > 0) deleted += Number(d.prepare("DELETE FROM holds WHERE held = 1 AND timestamp < ?").run(now - retentionDays * 86_400_000).changes ?? 0);
  if (deleted > 0) d.exec("DELETE FROM hold_tasks WHERE hash NOT IN (SELECT task_hash FROM holds WHERE task_hash IS NOT NULL)");
}

/**
 * Run one startup maintenance step without waiting for the write lock: another session holding the database makes it
 * fail at once, and the step runs at the next start instead. A step that fails for any other reason is reported.
 */
function withoutWaiting<T>(d: SqliteDb, step: () => T): T | undefined {
  d.exec("PRAGMA busy_timeout = 0");
  try {
    return step();
  } catch (err) {
    const code = err && typeof err === "object" && "errcode" in err ? Number((err as { errcode: number }).errcode) : 0;
    // SQLITE_BUSY (5) and SQLITE_BUSY_SNAPSHOT (517): another session has the database; try again next start.
    if (code !== 5 && code !== 517) console.warn("pi-warden: hold log maintenance failed:", err);
    return undefined;
  } finally {
    d.exec("PRAGMA busy_timeout = 10000");
  }
}

/** Free pages worth a VACUUM; below this the rewrite buys less than it delays the session start. */
const VACUUM_MIN_FREE_PAGES = 256;

/** Reclaim the pages the migration and the prune freed, once, and never make a session wait for the rewrite. */
function vacuumWhenManyFreePages(d: SqliteDb): void {
  try {
    const free = Number((d.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0);
    if (free < VACUUM_MIN_FREE_PAGES) return;
    withoutWaiting(d, () => d.exec("VACUUM"));
  } catch (err) {
    console.warn("pi-warden: could not read the hold log size:", err);
  }
}

/**
 * Create the schema, migrate an older database once, clear what an older session wrote since the last start, and
 * prune past retention. The migration runs with the normal write timeout, because a write into a database the
 * migration has not reached yet fails; the clearing, the prune, and the VACUUM skip a database another session
 * holds, and the next start runs them.
 * `allowedRetentionDays` is how long a call that was not held is kept; held rows use `retentionDays`.
 */
export async function initSchema(retentionDays = 365, dirs: HostDirs = defaultHostDirs(), allowedRetentionDays = 90): Promise<void> {
  try {
    const d = await getDb(dirs);
    d.exec(HOLDS_SCHEMA);
    migrateHolds(d);
    withoutWaiting(d, () => slimAllowedRows(d));
    withoutWaiting(d, () => pruneHolds(d, retentionDays, allowedRetentionDays));
    vacuumWhenManyFreePages(d);
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "errcode" in err ? ` (errcode ${String((err as { errcode: number }).errcode)})` : "";
    console.warn(`pi-warden: hold database startup failed:${code}`, err);
  }
}

// --- Types ---

export interface HoldScores {
  irreversible: number;
  /** Reason categories from the verdict, used for same-reason queries and destructive-pattern detection. */
  reasons: string[];
  /** The large_output score of a judged bash call; recorded for calibration, never part of the signature. */
  largeOutput?: number;
}

/** Enumerations for type safety over bare strings. */
export type HoldLevel = "allow" | "deny" | "confirm";
export type HoldOutcome = "approved" | "declined" | "replanned" | "abandoned" | "accepted" | "regretted" | "pending";

/** Context fields gathered at hold time, passed to toHoldRecord. */
export interface HoldContext {
  task?: string | undefined;
  plan?: string | undefined;
  contextSummary?: string | undefined;
  agentReason?: string | undefined;
  /** Redacted command or path, capped at 200 chars. Stored as command_preview instead of the bare tool name. */
  preview?: string | undefined;
  /** The Pi session the call belongs to; empty only for a caller that does not know one (the import script). */
  sessionId?: string | undefined;
}

export interface HoldRecord {
  timestamp: number;
  projectRoot: string;
  sessionId?: string;
  tool: string;
  commandPreview: string;
  /** Stored once in hold_tasks, under its hash; written for a held row only. */
  task?: string;
  plan?: string;
  contextSummary?: string;
  scores: HoldScores;
  level: HoldLevel;
  held: boolean;
  reasons: string[];
  agentReason?: string;
}

export interface SmartHistory {
  exact: Record<string, unknown>[];
  similar: Record<string, unknown>[];
  sameReason: Record<string, unknown>[];
  signatureHash: string;
}

export interface ConfidenceResult {
  confidence: number;
  reason: string;
  exactCount: number;
  similarCount: number;
  sameReasonCount: number;
}

export interface SkipResult {
  skip: boolean;
  confidence: number;
  reason: string;
}

// --- Helpers ---

/** Hash tool + scores to identify similar holds. */
export function signatureHash(tool: string, scores: HoldScores): string {
  return createHash("sha256").update(tool + ":" + JSON.stringify({ irreversible: scores.irreversible, reasons: scores.reasons })).digest("hex").slice(0, 16);
}

/** Score a batch of rows with time-decayed weights. Returns { score, totalWeight }.
 *  recent holds (< 1 week) weight fully, medium-age (< 4 weeks) at 70%, older at 40%.
 *  Approved outcomes add the weight; replanned subtract half (user changed their mind). */
function scoreRows(rows: Record<string, unknown>[], weight: number): { score: number; totalWeight: number } {
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  let score = 0;
  let totalWeight = 0;
  for (const row of rows) {
    if (typeof row.timestamp !== "number" || typeof row.outcome !== "string") continue;
    const age = now - row.timestamp;
    const ageWeight = age < week ? 1.0 : age < 4 * week ? 0.7 : 0.4;
    const w = weight * ageWeight;
    totalWeight += w;
    if (row.outcome === "approved") score += w;
    if (row.outcome === "replanned") score -= w * 0.5;
  }
  return { score, totalWeight };
}

/** Build HoldRecord from held call data. Centralizes the field mapping. */
export function toHoldRecord(
  item: { at: number; tool: string; level: string; reasons: string[]; scores?: CallScores | undefined; held?: boolean | undefined },
  projectRoot: string,
  ctx?: HoldContext,
): HoldRecord {
  const raw = item.scores;
  const result: HoldRecord = {
    timestamp: item.at,
    projectRoot,
    tool: item.tool,
    commandPreview: redact(ctx?.preview ?? item.tool).slice(0, 200),
    scores: { irreversible: raw?.irreversible ?? 0, reasons: item.reasons, ...(raw?.largeOutput !== undefined ? { largeOutput: raw.largeOutput } : {}) },
    level: item.level as HoldLevel,
    held: item.held ?? true,
    reasons: item.reasons,
  };
  if (ctx?.task) result.task = ctx.task;
  if (ctx?.plan) result.plan = ctx.plan;
  if (ctx?.contextSummary) result.contextSummary = ctx.contextSummary;
  if (ctx?.agentReason) result.agentReason = ctx.agentReason;
  if (ctx?.sessionId) result.sessionId = ctx.sessionId;
  return result;
}

// --- Recording ---

/**
 * One row per judged call. The task text goes into hold_tasks under its hash, once per task; the context
 * columns are written for a held row only, because no reader asks for them on the row of an allowed call. The
 * `scores` column is NOT NULL in every layout, so an allowed row carries the empty object instead of NULL.
 */
export async function recordHold(hold: HoldRecord, dirs: HostDirs = defaultHostDirs()): Promise<number> {
  const d = await getDb(dirs);
  const hash = signatureHash(hold.tool, hold.scores);
  const taskKey = hold.held && hold.task ? taskHash(hold.task) : null;
  if (taskKey && hold.task) d.prepare("INSERT OR IGNORE INTO hold_tasks (hash, text) VALUES (?, ?)").run(taskKey, hold.task);
  const stmt = d.prepare(`
    INSERT INTO holds
    (timestamp, project_root, session_id, tool, signature_hash, command_preview,
     task_hash, plan, context_summary, scores,
     level, held, reasons, agent_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    hold.timestamp, hold.projectRoot, hold.sessionId ?? null,
    hold.tool, hash, hold.commandPreview,
    taskKey, hold.held ? hold.plan ?? null : null,
    hold.held ? hold.contextSummary ?? null : null, hold.held ? JSON.stringify(hold.scores) : "{}",
    hold.level, hold.held ? 1 : 0,
    hold.held ? JSON.stringify(hold.reasons) : null, hold.held ? hold.agentReason ?? null : null,
  );
  return Number(result.lastInsertRowid);
}

export async function recordOutcome(id: number, outcome: string, dirs: HostDirs = defaultHostDirs()): Promise<void> {
  try { (await getDb(dirs)).prepare("UPDATE holds SET outcome = ?, outcome_at = ? WHERE id = ?").run(outcome, Date.now(), id); } catch (err) { console.warn("pi-warden: could not record hold outcome:", err); }
}

// --- Querying ---

/** Query holds by project and held value. Used by tests and future analytics. */
export async function queryHoldsForProject(projectRoot: string, options?: { held?: boolean }, dirs: HostDirs = defaultHostDirs()): Promise<Record<string, unknown>[]> {
  const d = await getDb(dirs);
  if (options?.held !== undefined) {
    return d.prepare("SELECT id, tool, held, outcome, command_preview FROM holds WHERE project_root = ? AND held = ? ORDER BY timestamp").all(projectRoot, options.held ? 1 : 0) as Record<string, unknown>[];
  }
  return d.prepare("SELECT id, tool, held, outcome, command_preview FROM holds WHERE project_root = ? ORDER BY timestamp").all(projectRoot) as Record<string, unknown>[];
}

/** Lifetime hold statistics for one project root. Matches the precision formula in holds.ts: (declined + replanned) / (approved + declined + replanned). */
export interface HoldStats {
  /** held = 1 rows for this root. */
  held: number;
  /** Rows with a label (approved + declined + replanned). */
  labeled: number;
  /** Held rows approved on retry (false positives). */
  approved: number;
  /** Held rows declined (true positives). */
  declined: number;
  /** Held rows replanned (true positives). */
  replanned: number;
  /** Held rows the run after the reply neither released nor replaced: nothing came of the hold. */
  abandoned: number;
  /** held = 0 rows for this root. */
  allowed: number;
  /** Allowed rows the user regretted. */
  regretted: number;
  /** Allowed rows accepted. */
  accepted: number;
  /** Date range: oldest and newest timestamp (ms since epoch). */
  oldest: number;
  newest: number;
}

export async function holdStats(projectRoot: string, dirs: HostDirs = defaultHostDirs()): Promise<HoldStats> {
  const d = await getDb(dirs);
  const held = d.prepare(
    `SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN outcome IN ('approved','declined','replanned') THEN 1 END) AS labeled,
      COUNT(CASE WHEN outcome = 'approved' THEN 1 END) AS approved,
      COUNT(CASE WHEN outcome = 'declined' THEN 1 END) AS declined,
      COUNT(CASE WHEN outcome = 'replanned' THEN 1 END) AS replanned,
      COUNT(CASE WHEN outcome = 'abandoned' THEN 1 END) AS abandoned,
      MIN(timestamp) AS oldest,
      MAX(timestamp) AS newest
    FROM holds WHERE project_root = ? AND held = 1`
  ).get(projectRoot) as Record<string, unknown>;
  const allowed = d.prepare(
    `SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN outcome = 'regretted' THEN 1 END) AS regretted,
      COUNT(CASE WHEN outcome = 'accepted' THEN 1 END) AS accepted
    FROM holds WHERE project_root = ? AND held = 0`
  ).get(projectRoot) as Record<string, unknown>;
  return {
    held: (held.total as number) ?? 0,
    labeled: (held.labeled as number) ?? 0,
    approved: (held.approved as number) ?? 0,
    declined: (held.declined as number) ?? 0,
    replanned: (held.replanned as number) ?? 0,
    abandoned: (held.abandoned as number) ?? 0,
    allowed: (allowed.total as number) ?? 0,
    regretted: (allowed.regretted as number) ?? 0,
    accepted: (allowed.accepted as number) ?? 0,
    oldest: (held.oldest as number) ?? 0,
    newest: (held.newest as number) ?? 0,
  };
}

export async function querySmartHistory(tool: string, scores: HoldScores, projectRoot: string, dirs: HostDirs = defaultHostDirs()): Promise<SmartHistory> {
  const d = await getDb(dirs);
  const hash = signatureHash(tool, scores);

  // The task text lives once in hold_tasks; these queries are the only reader that joins it back.
  const exact = d.prepare(`
    SELECT t.text AS task, h.plan, h.outcome, h.scores, h.agent_reason, h.timestamp
    FROM holds h LEFT JOIN hold_tasks t ON t.hash = h.task_hash
    WHERE h.signature_hash = ? AND h.project_root = ? AND h.held = 1
    ORDER BY h.timestamp DESC LIMIT 10
  `).all(hash, projectRoot) as Record<string, unknown>[];

  const similar = d.prepare(`
    SELECT t.text AS task, h.plan, h.outcome, h.scores, h.agent_reason, h.timestamp
    FROM holds h LEFT JOIN hold_tasks t ON t.hash = h.task_hash
    WHERE h.tool = ? AND h.held = 1
    AND ABS(CAST(json_extract(h.scores, '$.irreversible') AS REAL) - ?) < 0.2
    ORDER BY h.timestamp DESC LIMIT 10
  `).all(tool, scores.irreversible) as Record<string, unknown>[];

  const reasonCat = scores.reasons[0] ? scores.reasons[0].split(":")[0] : "";
  const sameReason = reasonCat ? d.prepare(`
    SELECT t.text AS task, h.plan, h.outcome, h.scores, h.agent_reason, h.timestamp
    FROM holds h LEFT JOIN hold_tasks t ON t.hash = h.task_hash
    WHERE h.held = 1 AND h.reasons LIKE ?
    ORDER BY h.timestamp DESC LIMIT 10
  `).all("%" + reasonCat + "%") as Record<string, unknown>[] : [];

  return { exact, similar, sameReason, signatureHash: hash };
}

export function calculateSmartConfidence(history: SmartHistory): ConfidenceResult {
  const exact = scoreRows(history.exact, 5);
  const similar = scoreRows(history.similar, 2);
  const sameReason = scoreRows(history.sameReason, 1);

  const totalWeight = exact.totalWeight + similar.totalWeight + sameReason.totalWeight;
  if (totalWeight === 0) return { confidence: 0, reason: "no history", exactCount: 0, similarCount: 0, sameReasonCount: 0 };

  // Normalize the weighted approval ratio to [0, 1].
  // Raw ratio range is [-0.5, 1] (all-replanned to all-approved);
  // the (x+1)/2 transform maps that to [0.25, 1], clamped to [0, 1].
  const confidence = Math.max(0, Math.min(1, ((exact.score + similar.score + sameReason.score) / totalWeight + 1) / 2));
  return {
    confidence,
    reason: confidence > 0.7 ? "high confidence approval" : confidence > 0.4 ? "borderline" : "low confidence",
    exactCount: history.exact.length,
    similarCount: history.similar.length,
    sameReasonCount: history.sameReason.length,
  };
}

// --- Integration ---

export async function shouldSkipHold(tool: string, scores: HoldScores, projectRoot: string, dirs: HostDirs = defaultHostDirs()): Promise<SkipResult> {
  const history = await querySmartHistory(tool, scores, projectRoot, dirs);
  const { confidence, reason } = calculateSmartConfidence(history);

  const isDestructive = scores.reasons.some(r => r.startsWith("destructive:"));
  if (isDestructive) return { skip: false, confidence, reason: "destructive pattern, never skip" };

  if (confidence > 0.8 && history.exact.length >= 3) {
    return { skip: true, confidence, reason: "high confidence, " + history.exact.length + " exact approvals" };
  }

  return { skip: false, confidence, reason };
}

// --- Adaptive Thresholds ---

/** Learn from past outcomes to suggest threshold adjustments. */
export interface ThresholdAdjustment {
  guard: string;
  currentThreshold: number;
  suggestedThreshold: number;
  reason: string;
  confidence: number;
}

/** Analyze hold outcomes to suggest threshold adjustments. */
export async function analyzeThresholds(projectRoot: string, dirs: HostDirs = defaultHostDirs()): Promise<ThresholdAdjustment[]> {
  const d = await getDb(dirs);
  const adjustments: ThresholdAdjustment[] = [];

  // Analyze action guard: look at holds vs approvals
  const actionHolds = d.prepare(`
    SELECT outcome, COUNT(*) as cnt
    FROM holds WHERE project_root = ? AND tool != 'rules' AND held = 1
    GROUP BY outcome
  `).all(projectRoot) as Record<string, unknown>[];

  const totalHolds = actionHolds.reduce((sum, row) => sum + (row.cnt as number), 0);
  if (totalHolds >= 10) {
    const approved = actionHolds.find(row => row.outcome === 'approved')?.cnt as number ?? 0;
    const declined = actionHolds.find(row => row.outcome === 'declined')?.cnt as number ?? 0;
    const precision = totalHolds > 0 ? (declined + (actionHolds.find(row => row.outcome === 'replanned')?.cnt as number ?? 0)) / totalHolds : 0;
    
    // If precision is high (>0.7), we're catching real issues - keep or raise threshold
    // If precision is low (<0.3), we're being too aggressive - lower threshold
    if (precision < 0.3 && totalHolds >= 20) {
      adjustments.push({
        guard: 'action',
        currentThreshold: 0.7,
        suggestedThreshold: 0.6,
        reason: `Low precision (${(precision * 100).toFixed(0)}%); consider lowering the confirmation threshold`,
        confidence: Math.min(1, totalHolds / 50),
      });
    }
  }

  // Analyze regret rates
  const regretRate = d.prepare(`
    SELECT 
      COUNT(CASE WHEN outcome = 'regretted' THEN 1 END) as regrets,
      COUNT(CASE WHEN outcome IN ('accepted', 'regretted') THEN 1 END) as total
    FROM holds WHERE project_root = ? AND held = 0
  `).get(projectRoot) as { regrets: number; total: number } | undefined;

  if (regretRate && regretRate.total >= 10) {
    const rate = regretRate.regrets / regretRate.total;
    if (rate > 0.15) {
      adjustments.push({
        guard: 'action',
        currentThreshold: 0.7,
        suggestedThreshold: 0.75,
        reason: `High regret rate (${(rate * 100).toFixed(0)}%); consider raising the confirmation threshold`,
        confidence: Math.min(1, regretRate.total / 30),
      });
    }
  }

  return adjustments;
}

// --- Pattern Learning ---

/** Learn which patterns are most likely to be false positives. */
export interface PatternInsight {
  pattern: string;
  falsePositiveRate: number;
  sampleSize: number;
  suggestion: string;
}

export async function analyzePatterns(projectRoot: string, dirs: HostDirs = defaultHostDirs()): Promise<PatternInsight[]> {
  const d = await getDb(dirs);
  const insights: PatternInsight[] = [];

  // Get pattern outcomes
  const patterns = d.prepare(`
    SELECT 
      reasons,
      outcome,
      COUNT(*) as cnt
    FROM holds WHERE project_root = ? AND held = 1
    GROUP BY reasons, outcome
  `).all(projectRoot) as Record<string, unknown>[];

  // Aggregate by pattern category
  const patternStats = new Map<string, { approved: number; declined: number; total: number }>();
  
  for (const row of patterns) {
    const reasons = JSON.parse(row.reasons as string) as string[];
    const outcome = row.outcome as string;
    const cnt = row.cnt as number;
    
    for (const reason of reasons) {
      const category = reason.split(':')[0] ?? 'unknown';
      const stats = patternStats.get(category) ?? { approved: 0, declined: 0, total: 0 };
      stats.total += cnt;
      if (outcome === 'approved') stats.approved += cnt;
      if (outcome === 'declined') stats.declined += cnt;
      patternStats.set(category, stats);
    }
  }

  for (const [pattern, stats] of patternStats) {
    if (stats.total >= 5) {
      const falsePositiveRate = stats.approved / stats.total;
      if (falsePositiveRate > 0.5) {
        insights.push({
          pattern,
          falsePositiveRate,
          sampleSize: stats.total,
          suggestion: `Pattern '${pattern}' has a ${(falsePositiveRate * 100).toFixed(0)}% false positive rate; consider adding it to exemptRules or raising its threshold`,
        });
      }
    }
  }

  return insights.sort((a, b) => b.falsePositiveRate - a.falsePositiveRate);
}

// --- Contextual Recommendations ---

export interface ContextRecommendation {
  type: 'threshold' | 'exempt' | 'pattern';
  message: string;
  priority: 'high' | 'medium' | 'low';
}

/** Generate recommendations based on learning data. */
export async function generateRecommendations(projectRoot: string, dirs: HostDirs = defaultHostDirs()): Promise<ContextRecommendation[]> {
  const recommendations: ContextRecommendation[] = [];

  const thresholdAdjustments = await analyzeThresholds(projectRoot, dirs);
  for (const adj of thresholdAdjustments) {
    if (adj.confidence > 0.5) {
      recommendations.push({
        type: 'threshold',
        message: `${adj.reason} (confidence: ${(adj.confidence * 100).toFixed(0)}%)`,
        priority: adj.confidence > 0.7 ? 'high' : 'medium',
      });
    }
  }

  const patternInsights = await analyzePatterns(projectRoot, dirs);
  for (const insight of patternInsights.slice(0, 3)) {
    if (insight.falsePositiveRate > 0.6) {
      recommendations.push({
        type: 'exempt',
        message: insight.suggestion,
        priority: insight.falsePositiveRate > 0.8 ? 'high' : 'medium',
      });
    }
  }

  return recommendations.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

// --- Steer Effectiveness Analysis ---

/** Analyze which types of steers are most effective at changing agent behavior. */
export interface SteerEffectivenessReport {
  /** Overall effectiveness rate (0-1). */
  overall: number;
  /** Effectiveness by steer type. */
  byType: Record<string, { effective: number; total: number; rate: number }>;
  /** Suggestions for improving steer effectiveness. */
  suggestions: string[];
  /** Top performing steer patterns. */
  topPatterns: Array<{ pattern: string; effectiveness: number; sampleSize: number }>;
}

/** Analyze steer effectiveness from hold outcomes. */
export async function analyzeSteerEffectivenessReport(projectRoot: string, dirs: HostDirs = defaultHostDirs()): Promise<SteerEffectivenessReport> {
  const d = await getDb(dirs);
  const suggestions: string[] = [];

  // Get steer outcomes (inferred from hold outcomes)
  const steerOutcomes = d.prepare(`
    SELECT 
      agent_reason,
      outcome,
      COUNT(*) as cnt
    FROM holds WHERE project_root = ? AND held = 1 AND agent_reason IS NOT NULL
    GROUP BY agent_reason, outcome
  `).all(projectRoot) as Record<string, unknown>[];

  // Analyze effectiveness: if a steer led to approval (agent fixed the issue), it was effective
  const steerStats = new Map<string, { effective: number; total: number }>();

  for (const row of steerOutcomes) {
    const reason = row.agent_reason as string;
    const outcome = row.outcome as string;
    const cnt = row.cnt as number;

    // Extract steer type from the reason
    const steerType = reason.includes('irreversible') ? 'irreversible'
      : reason.includes('off-task') ? 'off-task'
      : reason.includes('intent mismatch') ? 'intent-mismatch'
      : reason.includes('pattern') ? 'pattern'
      : 'other';

    const stats = steerStats.get(steerType) ?? { effective: 0, total: 0 };
    stats.total += cnt;
    if (outcome === 'approved') stats.effective += cnt; // Agent fixed the issue
    steerStats.set(steerType, stats);
  }

  let totalEffective = 0;
  let totalSteers = 0;
  const byType: Record<string, { effective: number; total: number; rate: number }> = {};
  const topPatterns: Array<{ pattern: string; effectiveness: number; sampleSize: number }> = [];

  for (const [type, stats] of steerStats) {
    const rate = stats.total > 0 ? stats.effective / stats.total : 0;
    byType[type] = { effective: stats.effective, total: stats.total, rate };
    totalEffective += stats.effective;
    totalSteers += stats.total;

    // Generate suggestions for ineffective steers
    if (stats.total >= 5 && rate < 0.3) {
      suggestions.push(`Steer type '${type}' has a ${(rate * 100).toFixed(0)}% effectiveness rate; consider rewording or adding more specific guidance`);
    }

    // Track top patterns
    if (stats.total >= 3) {
      topPatterns.push({ pattern: type, effectiveness: rate, sampleSize: stats.total });
    }
  }

  const overall = totalSteers > 0 ? totalEffective / totalSteers : 0;

  // Sort top patterns by effectiveness
  topPatterns.sort((a, b) => b.effectiveness - a.effectiveness);

  return { overall, byType, suggestions, topPatterns: topPatterns.slice(0, 5) };
}
