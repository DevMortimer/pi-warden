// src/learning.ts - Smart hold learning system
// Records full context with each hold and predicts outcomes using history.

import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { redact } from "./redact.js";
import type { CallScores } from "./holds.js";

let db: import("node:sqlite").DatabaseSync | undefined;
let sqliteAvailable: boolean | undefined;

// --- Schema (shared constant) ---

export const HOLDS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    project_root TEXT NOT NULL,
    tool TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    command_preview TEXT,
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
    confidence REAL
  );
  CREATE INDEX IF NOT EXISTS idx_holds_project_signature ON holds(project_root, signature_hash);
  CREATE INDEX IF NOT EXISTS idx_holds_outcome ON holds(outcome);
  CREATE INDEX IF NOT EXISTS idx_holds_timestamp ON holds(timestamp);
`;

const NOOP_DB = {
  exec() {},
  prepare() { return { run() { return { changes: 0, lastInsertRowid: 0 }; }, get() { return undefined; }, all() { return []; } }; },
  pragma() {},
} as unknown as import("node:sqlite").DatabaseSync;

async function getDb(): Promise<import("node:sqlite").DatabaseSync> {
  if (db) return db;
  if (sqliteAvailable === false) return NOOP_DB;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    sqliteAvailable = true;
    const dbPath = process.env.PI_WARDEN_DB ?? join(homedir(), ".pi", "agent", "pi-warden", "holds.db");
    // DatabaseSync does not create parent directories; on a fresh machine the folder may not exist yet.
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    return db;
  } catch (err) {
    sqliteAvailable = false;
    console.warn("pi-warden: node:sqlite unavailable, learning features disabled:", err);
    return NOOP_DB;
  }
}

export async function initSchema(retentionDays = 365): Promise<void> {
  try {
    const d = await getDb();
    d.exec(HOLDS_SCHEMA);
    // Migrate: add columns that may be missing from older databases.
    try { d.exec("ALTER TABLE holds ADD COLUMN preceding_actions TEXT"); } catch { /* column exists */ }
    // Prune old records if retention is enabled.
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 86_400_000;
      d.prepare("DELETE FROM holds WHERE timestamp < ?").run(cutoff);
      d.exec("VACUUM");
    }
  } catch (err) { console.warn("pi-warden: hold retention prune failed:", err); }
}

// --- Types ---

export interface HoldScores {
  irreversible: number;
  /** Reason categories from the verdict, used for same-reason queries and destructive-pattern detection. */
  reasons: string[];
}

/** Enumerations for type safety over bare strings. */
export type HoldLevel = "allow" | "deny" | "confirm";
export type HoldOutcome = "approved" | "declined" | "replanned" | "accepted" | "regretted" | "pending";

/** Context fields gathered at hold time, passed to toHoldRecord. */
export interface HoldContext {
  task?: string | undefined;
  plan?: string | undefined;
  contextSummary?: string | undefined;
  precedingActions?: string | undefined;
  agentReason?: string | undefined;
  /** Redacted command or path, capped at 200 chars. Stored as command_preview instead of the bare tool name. */
  preview?: string | undefined;
}

export interface HoldRecord {
  timestamp: number;
  projectRoot: string;
  tool: string;
  commandPreview: string;
  task?: string;
  plan?: string;
  contextSummary?: string;
  precedingActions?: string;
  scores: HoldScores;
  level: HoldLevel;
  held: boolean;
  reasons: string[];
  agentReason?: string;
  confidence?: number;
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
    scores: { irreversible: raw?.irreversible ?? 0, reasons: item.reasons },
    level: item.level as HoldLevel,
    held: item.held ?? true,
    reasons: item.reasons,
  };
  if (ctx?.task) result.task = ctx.task;
  if (ctx?.plan) result.plan = ctx.plan;
  if (ctx?.contextSummary) result.contextSummary = ctx.contextSummary;
  if (ctx?.precedingActions) result.precedingActions = ctx.precedingActions;
  if (ctx?.agentReason) result.agentReason = ctx.agentReason;
  return result;
}

// --- Recording ---

export async function recordHold(hold: HoldRecord): Promise<number> {
  const d = await getDb();
  const hash = signatureHash(hold.tool, hold.scores);
  const stmt = d.prepare(`
    INSERT INTO holds
    (timestamp, project_root, tool, signature_hash, command_preview,
     task, plan, context_summary, preceding_actions,
     scores, level, held, reasons, agent_reason, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    hold.timestamp, hold.projectRoot,
    hold.tool, hash, hold.commandPreview,
    hold.task ?? null, hold.plan ?? null,
    hold.contextSummary ?? null, hold.precedingActions ?? null,
    JSON.stringify(hold.scores), hold.level, hold.held ? 1 : 0,
    JSON.stringify(hold.reasons), hold.agentReason ?? null,
    hold.confidence ?? null,
  );
  return Number(result.lastInsertRowid);
}

export async function recordOutcome(id: number, outcome: string): Promise<void> {
  try { (await getDb()).prepare("UPDATE holds SET outcome = ?, outcome_at = ? WHERE id = ?").run(outcome, Date.now(), id); } catch (err) { console.warn("pi-warden: could not record hold outcome:", err); }
}

// --- Querying ---

/** Query holds by project and held value. Used by tests and future analytics. */
export async function queryHoldsForProject(projectRoot: string, options?: { held?: boolean }): Promise<Record<string, unknown>[]> {
  const d = await getDb();
  if (options?.held !== undefined) {
    return d.prepare("SELECT id, tool, held, outcome, command_preview FROM holds WHERE project_root = ? AND held = ? ORDER BY timestamp").all(projectRoot, options.held ? 1 : 0) as Record<string, unknown>[];
  }
  return d.prepare("SELECT id, tool, held, outcome, command_preview FROM holds WHERE project_root = ? ORDER BY timestamp").all(projectRoot) as Record<string, unknown>[];
}

export async function querySmartHistory(tool: string, scores: HoldScores, projectRoot: string): Promise<SmartHistory> {
  const d = await getDb();
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

export async function shouldSkipHold(tool: string, scores: HoldScores, projectRoot: string): Promise<SkipResult> {
  const history = await querySmartHistory(tool, scores, projectRoot);
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
export async function analyzeThresholds(projectRoot: string): Promise<ThresholdAdjustment[]> {
  const d = await getDb();
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

export async function analyzePatterns(projectRoot: string): Promise<PatternInsight[]> {
  const d = await getDb();
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
export async function generateRecommendations(projectRoot: string): Promise<ContextRecommendation[]> {
  const recommendations: ContextRecommendation[] = [];

  const thresholdAdjustments = await analyzeThresholds(projectRoot);
  for (const adj of thresholdAdjustments) {
    if (adj.confidence > 0.5) {
      recommendations.push({
        type: 'threshold',
        message: `${adj.reason} (confidence: ${(adj.confidence * 100).toFixed(0)}%)`,
        priority: adj.confidence > 0.7 ? 'high' : 'medium',
      });
    }
  }

  const patternInsights = await analyzePatterns(projectRoot);
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
export async function analyzeSteerEffectivenessReport(projectRoot: string): Promise<SteerEffectivenessReport> {
  const d = await getDb();
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
