// src/learning.ts - Smart hold learning system
// Records full context with each hold and predicts outcomes using history.

import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync | undefined;

// --- Schema (shared constant) ---

export const HOLDS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    project_root TEXT NOT NULL,
    session_id TEXT,
    tool TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    command_preview TEXT,
    input_summary TEXT,
    task TEXT,
    plan TEXT,
    context_summary TEXT,
    scores TEXT NOT NULL,
    level TEXT NOT NULL,
    held INTEGER NOT NULL,
    reasons TEXT,
    agent_reason TEXT,
    outcome TEXT,
    outcome_at INTEGER,
    confidence REAL,
    prediction TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_holds_project_signature ON holds(project_root, signature_hash);
  CREATE INDEX IF NOT EXISTS idx_holds_outcome ON holds(outcome);
  CREATE INDEX IF NOT EXISTS idx_holds_timestamp ON holds(timestamp);
`;

function getDb(): DatabaseSync {
  if (!db) {
    try {
      const dbPath = process.env.PI_WARDEN_DB ?? join(homedir(), ".pi", "agent", "pi-warden", "holds.db");
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Fail open: if DB is corrupted or inaccessible, return a no-op stub
      return {
        exec() {},
        prepare() { return { run() { return { lastInsertRowid: 0 }; }, all() { return []; } }; },
        pragma() {},
      } as unknown as DatabaseSync;
    }
  }
  return db;
}

export function initSchema(): void {
  try { getDb().exec(HOLDS_SCHEMA); } catch { /* fail open */ }
}

// --- Types ---

export interface HoldScores {
  irreversible: number;
  reasons: string[];
}

export interface HoldRecord {
  timestamp: number;
  projectRoot: string;
  sessionId?: string;
  tool: string;
  commandPreview: string;
  inputSummary?: string;
  task?: string;
  plan?: string;
  contextSummary?: string;
  scores: HoldScores;
  level: string;
  held: boolean;
  reasons: string[];
  agentReason?: string;
  confidence?: number;
  prediction?: string;
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
  return createHash("sha256").update(tool + ":" + JSON.stringify(scores)).digest("hex").slice(0, 16);
}

/** Score a batch of rows with time-decayed weights. Returns { score, totalWeight }. */
function scoreRows(rows: Record<string, unknown>[], weight: number): { score: number; totalWeight: number } {
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  let score = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const age = now - (row.timestamp as number);
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
  item: { at: number; tool: string; level: string; reasons: string[]; scores?: Record<string, unknown> },
  projectRoot: string,
  task?: string,
  plan?: string,
  contextSummary?: string,
  agentReason?: string,
): HoldRecord {
  const raw = item.scores ?? {};
  const result: HoldRecord = {
    timestamp: item.at,
    projectRoot,
    tool: item.tool,
    commandPreview: item.tool,
    scores: { irreversible: (raw.irreversible as number) ?? 0, reasons: (raw.reasons as string[]) ?? [] },
    level: item.level,
    held: true,
    reasons: item.reasons,
  };
  if (task) result.task = task;
  if (plan) result.plan = plan;
  if (contextSummary) result.contextSummary = contextSummary;
  if (agentReason) result.agentReason = agentReason;
  return result;
}

// --- Recording ---

export function recordHold(hold: HoldRecord): number {
  const d = getDb();
  const hash = signatureHash(hold.tool, hold.scores);
  const stmt = d.prepare(`
    INSERT INTO holds
    (timestamp, project_root, session_id, tool, signature_hash, command_preview,
     input_summary, task, plan, context_summary,
     scores, level, held, reasons, agent_reason, confidence, prediction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    hold.timestamp, hold.projectRoot, hold.sessionId ?? null,
    hold.tool, hash, hold.commandPreview,
    hold.inputSummary ?? null, hold.task ?? null, hold.plan ?? null,
    hold.contextSummary ?? null,
    JSON.stringify(hold.scores), hold.level, hold.held ? 1 : 0,
    JSON.stringify(hold.reasons), hold.agentReason ?? null,
    hold.confidence ?? null, hold.prediction ?? null,
  );
  const row = d.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

export function recordOutcome(id: number, outcome: string): void {
  try { getDb().prepare("UPDATE holds SET outcome = ?, outcome_at = ? WHERE id = ?").run(outcome, Date.now(), id); } catch { /* fail open */ }
}

// --- Querying ---

export function querySmartHistory(tool: string, scores: HoldScores, projectRoot: string): SmartHistory {
  const d = getDb();
  const hash = signatureHash(tool, scores);

  const exact = d.prepare(`
    SELECT task, plan, outcome, scores, agent_reason, timestamp
    FROM holds WHERE signature_hash = ? AND project_root = ? AND held = 1
    ORDER BY timestamp DESC LIMIT 10
  `).all(hash, projectRoot) as Record<string, unknown>[];

  const similar = d.prepare(`
    SELECT task, plan, outcome, scores, agent_reason, timestamp
    FROM holds WHERE tool = ? AND held = 1
    AND ABS(CAST(json_extract(scores, '$.irreversible') AS REAL) - ?) < 0.2
    ORDER BY timestamp DESC LIMIT 10
  `).all(tool, scores.irreversible) as Record<string, unknown>[];

  const reasonCat = scores.reasons[0] ? scores.reasons[0].split(":")[0] : "";
  const sameReason = reasonCat ? d.prepare(`
    SELECT task, plan, outcome, scores, agent_reason, timestamp
    FROM holds WHERE held = 1 AND reasons LIKE ?
    ORDER BY timestamp DESC LIMIT 10
  `).all("%" + reasonCat + "%") as Record<string, unknown>[] : [];

  return { exact, similar, sameReason, signatureHash: hash };
}

export function calculateSmartConfidence(history: SmartHistory): ConfidenceResult {
  const exact = scoreRows(history.exact, 5);
  const similar = scoreRows(history.similar, 2);
  const sameReason = scoreRows(history.sameReason, 1);

  const totalWeight = exact.totalWeight + similar.totalWeight + sameReason.totalWeight;
  if (totalWeight === 0) return { confidence: 0, reason: "no history", exactCount: 0, similarCount: 0, sameReasonCount: 0 };

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

export function shouldSkipHold(tool: string, scores: HoldScores, projectRoot: string): SkipResult {
  const history = querySmartHistory(tool, scores, projectRoot);
  const { confidence, reason } = calculateSmartConfidence(history);

  const isDestructive = scores.reasons.some(r => r.startsWith("destructive:"));
  if (isDestructive) return { skip: false, confidence, reason: "destructive pattern, never skip" };

  if (confidence > 0.8 && history.exact.length >= 3) {
    return { skip: true, confidence, reason: "high confidence, " + history.exact.length + " exact approvals" };
  }

  return { skip: false, confidence, reason };
}
