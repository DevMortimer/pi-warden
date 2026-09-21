#!/usr/bin/env node
/**
 * Read-only hold statistics script.
 * Queries the pi-warden SQLite database and prints per-project and total counts.
 *
 * Usage:
 *   node scripts/hold-stats.mjs              # human-readable table
 *   node scripts/hold-stats.mjs --json       # machine-readable JSON
 *
 * Environment:
 *   PI_WARDEN_DB  Override the database path (default: ~/.pi/agent/pi-warden/holds.db).
 *
 * Exclusion rules (roots are excluded when they match):
 *   - "unknown"
 *   - /var/folders/*
 *   - /private/tmp/*
 *   - /test
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DB_PATH = process.env.PI_WARDEN_DB ?? join(homedir(), ".pi", "agent", "pi-warden", "holds.db");
const JSON_MODE = process.argv.includes("--json");

if (!existsSync(DB_PATH)) {
  if (JSON_MODE) {
    console.log(JSON.stringify({ error: "database not found", path: "~" + DB_PATH.slice(homedir().length) }));
  } else {
    console.error(`Database not found: ~${DB_PATH.slice(homedir().length)}`);
  }
  process.exit(1);
}

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });

/** Check if a project root should be excluded from reporting. */
function excluded(root) {
  if (root === "unknown") return true;
  if (root.startsWith("/var/folders/")) return true;
  if (root.startsWith("/private/tmp/")) return true;
  if (root === "/test" || root.startsWith("/test/")) return true;
  return false;
}

/** Strip the home directory prefix so absolute paths never appear in output. */
function redactPath(root) {
  const home = homedir();
  return root.startsWith(home) ? "~" + root.slice(home.length) : root;
}

/** Precision formula: (declined + replanned) / (approved + declined + replanned). */
function precision(stats) {
  const labels = stats.approved + stats.declined + stats.replanned;
  return labels > 0 ? (stats.declined + stats.replanned) / labels : null;
}

// Fetch all rows, then aggregate per project in JS (avoids complex SQL CASE across grouped results).
const rows = db.prepare("SELECT project_root, held, outcome, timestamp FROM holds").all();

const projects = new Map();
let total = { held: 0, labeled: 0, approved: 0, declined: 0, replanned: 0, allowed: 0, regretted: 0, accepted: 0, oldest: Infinity, newest: -Infinity };

for (const row of rows) {
  const root = row.project_root;
  if (excluded(root)) continue;

  if (!projects.has(root)) {
    projects.set(root, { held: 0, labeled: 0, approved: 0, declined: 0, replanned: 0, allowed: 0, regretted: 0, accepted: 0, oldest: Infinity, newest: -Infinity });
  }
  const p = projects.get(root);

  if (row.held === 1) {
    p.held++;
    total.held++;
    if (row.outcome === "approved") { p.approved++; total.approved++; }
    if (row.outcome === "declined") { p.declined++; total.declined++; }
    if (row.outcome === "replanned") { p.replanned++; total.replanned++; }
    if (["approved", "declined", "replanned"].includes(row.outcome)) { p.labeled++; total.labeled++; }
  } else {
    p.allowed++;
    total.allowed++;
    if (row.outcome === "regretted") { p.regretted++; total.regretted++; }
    if (row.outcome === "accepted") { p.accepted++; total.accepted++; }
  }

  if (row.timestamp < p.oldest) p.oldest = row.timestamp;
  if (row.timestamp > p.newest) p.newest = row.timestamp;
  if (row.timestamp < total.oldest) total.oldest = row.timestamp;
  if (row.timestamp > total.newest) total.newest = row.timestamp;
}

db.close();

function formatDate(ts) {
  if (!ts || ts === Infinity || ts === -Infinity) return "n/a";
  return new Date(ts).toISOString().slice(0, 10);
}

function formatRow(name, s) {
  const prec = precision(s);
  const precStr = prec === null ? "n/a" : `${(prec * 100).toFixed(0)}% (${prec === 0 ? 0 : s.declined + s.replanned}/${s.labeled})`;
  return {
    project: name,
    held: s.held,
    labeled: s.labeled,
    precision: precStr,
    approved_retry: s.approved,
    allowed: s.allowed,
    regretted: s.regretted,
    date_range: `${formatDate(s.oldest)} – ${formatDate(s.newest)}`,
  };
}

if (JSON_MODE) {
  const result = {
    total: formatRow("(all)", total),
    projects: [...projects.entries()].map(([root, s]) => formatRow(redactPath(root), s)),
  };
  console.log(JSON.stringify(result, null, 2));
} else {
  const sorted = [...projects.entries()].sort((a, b) => b[1].held - a[1].held);
  if (sorted.length === 0) {
    console.log("No hold data found (excluding test/temp roots).");
    process.exit(0);
  }

  console.log("pi-warden hold statistics");
  console.log(`Database: ~${DB_PATH.slice(homedir().length)}`);
  console.log(`Date range: ${formatDate(total.oldest)} – ${formatDate(total.newest)}`);
  console.log("");

  for (const [root, s] of sorted) {
    const p = formatRow(redactPath(root), s);
    console.log(`  ${p.project}`);
    console.log(`    held: ${p.held}  labeled: ${p.labeled}  precision: ${p.precision}  approved on retry: ${p.approved_retry}  allowed: ${p.allowed} (${p.regretted} regretted)  range: ${p.date_range}`);
  }

  console.log("");
  const tp = formatRow("(total)", total);
  console.log(`  TOTAL`);
  console.log(`    held: ${tp.held}  labeled: ${tp.labeled}  precision: ${tp.precision}  approved on retry: ${tp.approved_retry}  allowed: ${tp.allowed} (${tp.regretted} regretted)  range: ${tp.date_range}`);
}
