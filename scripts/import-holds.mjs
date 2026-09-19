// scripts/import-holds.mjs - Import existing JSONL hold data into SQLite
// Run once: node scripts/import-holds.mjs

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { DatabaseSync } from "node:sqlite";

const holdsDir = join(homedir(), ".pi", "agent", "pi-warden", "holds");
const dbPath = join(homedir(), ".pi", "agent", "pi-warden", "holds.db");
const db = new DatabaseSync(dbPath);

// Shared schema from src/learning.ts
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
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
`);

const stmt = db.prepare(`
  INSERT OR IGNORE INTO holds
  (timestamp, project_root, session_id, tool, signature_hash, command_preview,
   scores, level, held, reasons, outcome, outcome_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const files = readdirSync(holdsDir).filter(f => f.endsWith(".jsonl"));
let imported = 0;

for (const file of files) {
  const lines = readFileSync(join(holdsDir, file), "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      const scores = r.scores || {};
      const hash = createHash("sha256")
        .update(r.tool + ":" + JSON.stringify(scores))
        .digest("hex")
        .slice(0, 16);

      stmt.run(
        r.at || 0,
        "unknown",
        r.sessionId || null,
        r.tool || "unknown",
        hash,
        r.tool + " irr=" + (scores.irreversible || 0).toFixed(2),
        JSON.stringify(scores),
        r.level || "allow",
        r.held ? 1 : 0,
        JSON.stringify(r.reasons || []),
        r.outcome || null,
        r.outcomeAt || null,
      );
      imported++;
    } catch {}
  }
}

console.log("Imported " + imported + " records into " + dbPath);
db.close();
