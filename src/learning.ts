// src/learning.ts - Smart hold learning system
// Records full context with each hold and predicts outcomes using history.

import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (!db) {
    const dbPath = process.env.PI_WARDEN_DB ?? join(homedir(), ".pi", "agent", "pi-warden", "holds.db");
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}

// --- Schema ---

export function initSchema(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      project_root TEXT NOT NULL,
      session_id TEXT,
      tool TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      command_preview TEXT,
      input_summary TEXT,
      task TEXT,
      plan TEXT,
      context_summary TEXT,
      preceding_actions TEXT,
      scores TEXT NOT NULL,
      level TEXT NOT NULL,
      held INTEGER NOT NULL,
      reasons TEXT,
      agent_reason TEXT,
      outcome TEXT,
      outcome_at INTEGER,
      confidence REAL,
      prediction TEXT,
      plan_chars INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_holds_project_command ON holds(project_root, command_hash);
    CREATE INDEX IF NOT EXISTS idx_holds_outcome ON holds(outcome);
    CREATE INDEX IF NOT EXISTS idx_holds_timestamp ON holds(timestamp);
  `);
}

// --- Recording ---

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
  precedingActions?: string;
  scores: Record<string, unknown>;
  level: string;
  held: boolean;
  reasons: string[];
  agentReason?: string;
  confidence?: number;
  prediction?: string;
}

export function recordHold(hold: HoldRecord): number {
  const d = getDb();
  const commandHash = createHash("sha256")
    .update(hold.tool + ":" + JSON.stringify(hold.scores))
    .digest("hex")
    .slice(0, 16);

  const stmt = d.prepare(`
    INSERT INTO holds
    (timestamp, project_root, session_id, tool, command_hash, command_preview,
     input_summary, task, plan, context_summary, preceding_actions,
     scores, level, held, reasons, agent_reason, confidence, prediction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    hold.timestamp, hold.projectRoot, hold.sessionId ?? null,
    hold.tool, commandHash, hold.commandPreview,
    hold.inputSummary ?? null, hold.task ?? null, hold.plan ?? null,
    hold.contextSummary ?? null, hold.precedingActions ?? null,
    JSON.stringify(hold.scores), hold.level, hold.held ? 1 : 0,
    JSON.stringify(hold.reasons), hold.agentReason ?? null,
    hold.confidence ?? null, hold.prediction ?? null,
  );

  const row = d.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

export function recordOutcome(id: number, outcome: string): void {
  const d = getDb();
  d.prepare("UPDATE holds SET outcome = ?, outcome_at = ? WHERE id = ?").run(outcome, Date.now(), id);
}

// --- Querying ---

export interface SmartHistory {
  exact: Record<string, unknown>[];
  similar: Record<string, unknown>[];
  sameReason: Record<string, unknown>[];
  commandHash: string;
}

export function querySmartHistory(tool: string, scores: Record<string, unknown>, projectRoot: string): SmartHistory {
  const d = getDb();
  const irr = (scores.irreversible as number) || 0;
  const reasons = (scores.reasons as string[]) || [];
  const commandHash = createHash("sha256")
    .update(tool + ":" + JSON.stringify(scores))
    .digest("hex")
    .slice(0, 16);

  const exact = d.prepare(`
    SELECT task, plan, outcome, scores, agent_reason, timestamp
    FROM holds WHERE command_hash = ? AND project_root = ? AND held = 1
    ORDER BY timestamp DESC LIMIT 10
  `).all(commandHash, projectRoot) as Record<string, unknown>[];

  const similar = d.prepare(`
    SELECT task, plan, outcome, scores, agent_reason, timestamp
    FROM holds WHERE tool = ? AND held = 1
    AND ABS(CAST(json_extract(scores, '$.irreversible') AS REAL) - ?) < 0.2
    ORDER BY timestamp DESC LIMIT 10
  `).all(tool, irr) as Record<string, unknown>[];

  const reasonCat = reasons[0] ? reasons[0].split(":")[0] : "";
  const sameReason = reasonCat ? d.prepare(`
    SELECT task, plan, outcome, scores, agent_reason, timestamp
    FROM holds WHERE held = 1 AND reasons LIKE ?
    ORDER BY timestamp DESC LIMIT 10
  `).all("%" + reasonCat + "%") as Record<string, unknown>[] : [];

  return { exact, similar, sameReason, commandHash };
}

export interface ConfidenceResult {
  confidence: number;
  reason: string;
  exactCount: number;
  similarCount: number;
  sameReasonCount: number;
}

export function calculateSmartConfidence(history: SmartHistory): ConfidenceResult {
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  let score = 0;
  let totalWeight = 0;

  for (const row of history.exact) {
    const age = now - (row.timestamp as number);
    const ageWeight = age < week ? 1.0 : age < 4 * week ? 0.7 : 0.4;
    const weight = 5 * ageWeight;
    totalWeight += weight;
    if (row.outcome === "approved") score += weight;
    if (row.outcome === "replanned") score -= weight * 0.5;
  }

  for (const row of history.similar) {
    const age = now - (row.timestamp as number);
    const ageWeight = age < week ? 1.0 : age < 4 * week ? 0.7 : 0.4;
    const weight = 2 * ageWeight;
    totalWeight += weight;
    if (row.outcome === "approved") score += weight;
    if (row.outcome === "replanned") score -= weight * 0.5;
  }

  for (const row of history.sameReason) {
    const age = now - (row.timestamp as number);
    const ageWeight = age < week ? 1.0 : age < 4 * week ? 0.7 : 0.4;
    const weight = 1 * ageWeight;
    totalWeight += weight;
    if (row.outcome === "approved") score += weight;
    if (row.outcome === "replanned") score -= weight * 0.5;
  }

  if (totalWeight === 0) return { confidence: 0, reason: "no history", exactCount: 0, similarCount: 0, sameReasonCount: 0 };

  const confidence = Math.max(0, Math.min(1, (score / totalWeight + 1) / 2));
  return {
    confidence,
    reason: confidence > 0.7 ? "high confidence approval" : confidence > 0.4 ? "borderline" : "low confidence",
    exactCount: history.exact.length,
    similarCount: history.similar.length,
    sameReasonCount: history.sameReason.length,
  };
}

// --- Integration ---

export interface SkipResult {
  skip: boolean;
  confidence: number;
  reason: string;
}

export function shouldSkipHold(tool: string, scores: Record<string, unknown>, projectRoot: string): SkipResult {
  const history = querySmartHistory(tool, scores, projectRoot);
  const { confidence, reason } = calculateSmartConfidence(history);

  const reasons = (scores.reasons as string[]) || [];
  const isDestructive = reasons.some(r => r.startsWith("destructive:"));
  if (isDestructive) return { skip: false, confidence, reason: "destructive pattern, never skip" };

  if (confidence > 0.8 && history.exact.length >= 3) {
    return { skip: true, confidence, reason: "high confidence, " + history.exact.length + " exact approvals" };
  }

  return { skip: false, confidence, reason };
}
