// scripts/import-holds.mjs - Import existing JSONL hold data into SQLite
// Run once: node scripts/import-holds.mjs

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { HOLDS_SCHEMA } from "../dist/learning.js";

const holdsDir = join(homedir(), ".pi", "agent", "pi-warden", "holds");
const dbPath = join(homedir(), ".pi", "agent", "pi-warden", "holds.db");
const db = new DatabaseSync(dbPath);

db.exec("PRAGMA journal_mode = WAL");
db.exec(HOLDS_SCHEMA);

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
