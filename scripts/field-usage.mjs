#!/usr/bin/env node
/**
 * Field usage report: what pi-warden did across real Pi sessions in a time window.
 *
 * Reads the Pi session logs and the local holds database. Prints aggregate counts only: no session text, no paths,
 * no project names. Offline; no requests.
 *
 * Usage:
 *   node scripts/field-usage.mjs --since 2026-09-21 [--until 2026-09-25] [--json]
 *
 * Environment:
 *   PI_SESSIONS_DIR  Session logs (default: ~/.pi/agent/sessions).
 *   PI_WARDEN_DB     Holds database (default: ~/.pi/agent/pi-warden/holds.db).
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const since = new Date(arg("--since") ?? "1970-01-01");
const until = arg("--until") ? new Date(arg("--until")) : new Date();
const asJson = args.includes("--json");
const sessionsDir = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");
const dbPath = process.env.PI_WARDEN_DB ?? join(homedir(), ".pi/agent/pi-warden/holds.db");

/** A verification command, the same family the done-check counts. */
const CHECK = /\b(?:npm (?:run )?(?:test|check|build|lint|typecheck)|npx tsc|make(?: test)?|pytest|cargo test|go test|node --test|flutter test|pnpm (?:test|build))\b/;

const STEER_KINDS = [
  ["done-check", /reports completion/],
  ["intent mismatch", /something different from what you said/],
  ["credential notice", /Possible credentials/],
  ["stuck", /same call (?:succeeded|failed)|called \d+ times with/],
  ["rules", /content just written to .* violates project rules?/],
  ["slop", /stub or placeholder|restate the code|dead or duplicated|hedging|vague notes/],
  ["needs user input", /may need user input/],
  ["runaway", /stopped your reply/],
  ["prose trend", /recent replies read as/],
  ["prompt injection", /prompt injection/i],
  ["large output", /large-output/],
];
const kindOf = (text) => STEER_KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";

function* sessionFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.name.endsWith(".jsonl")) {
      const mtime = statSync(path).mtime;
      if (mtime >= since && mtime < until) yield path;
    }
  }
}

const textOf = (content) => typeof content === "string" ? content : JSON.stringify(content ?? "");
const inWindow = (timestamp) => { const at = new Date(timestamp); return !(at < since || at >= until); };

const count = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const steers = new Map();
const doneFollowUp = { ranCheck: 0, noCheck: 0 };
const conscience = { tool: 0, skill: 0, coreTool: 0 };
const rules = new Map();
let files = 0, entries = 0, bashCalls = 0, heldResults = 0, compressed = 0, unreadableLines = 0;

for (const file of sessionFiles(sessionsDir)) {
  files++;
  const lines = readFileSync(file, "utf8").split("\n");
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { unreadableLines++; }
  }
  events.forEach((event, index) => {
    if (event.timestamp && !inWindow(event.timestamp)) return;
    entries++;
    const message = event.message ?? {};
    if (message.role === "assistant" && Array.isArray(message.content)) {
      bashCalls += message.content.filter(part => part?.type === "toolCall" && part.name === "bash").length;
    }
    if (message.role === "toolResult") {
      const text = textOf(message.content);
      if (text.includes("pi-warden held this")) heldResults++;
      if (text.includes("Full output: ")) compressed++;
    }
    if (event.customType === "pi-warden-steer") {
      const text = textOf(event.content);
      const kind = kindOf(text);
      count(steers, kind);
      if (kind === "rules") {
        const name = /pi-warden\.md: "([^"]+)"/.exec(text)?.[1];
        if (name) count(rules, name);
      }
      if (kind === "done-check") {
        const next = events.slice(index + 1, index + 15).filter(e => e.message?.role === "assistant").slice(0, 4);
        const ran = next.some(e => (e.message.content ?? []).some(part => part?.type === "toolCall" && part.name === "bash" && CHECK.test(JSON.stringify(part.arguments ?? {}))));
        doneFollowUp[ran ? "ranCheck" : "noCheck"]++;
      }
    }
    if (event.customType === "pi-warden-conscience") {
      const match = /"([^"]+)" (tool|skill)/.exec(textOf(event.content));
      if (match) {
        conscience[match[2]]++;
        if (match[2] === "tool" && ["read", "bash", "edit", "write", "grep", "find", "ls", "search_code"].includes(match[1])) conscience.coreTool++;
      }
    }
  });
}

let holds;
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const window = [since.getTime(), until.getTime()];
  const rows = db.prepare("SELECT level, held, outcome, reasons FROM holds WHERE timestamp >= ? AND timestamp < ?").all(...window);
  const levels = new Map(), outcomes = new Map(), reasons = new Map();
  for (const row of rows) {
    count(levels, row.level);
    if (!row.held) continue;
    count(outcomes, row.outcome ?? "unlabelled");
    const r = String(row.reasons ?? "").toLowerCase();
    const reason = r.includes("recursive rm on an absolute") ? "recursive rm (absolute or temp path)"
      : r.includes("reset --hard") ? "git reset --hard"
      : r.includes("force") ? "force push"
      : r.includes("outside the project") ? "file outside the project"
      : r.includes("irreversible") ? "judged irreversible"
      : "other";
    count(reasons, reason);
  }
  holds = { judged: rows.length, levels: Object.fromEntries(levels), held: rows.filter(row => row.held).length, outcomes: Object.fromEntries(outcomes), reasons: Object.fromEntries(reasons) };
  db.close();
}

const sorted = (map) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));
const report = {
  window: { since: since.toISOString(), until: until.toISOString() },
  sessions: files, entries, bashCalls, unreadableLines,
  holds,
  heldResultsInSessions: heldResults,
  steers: { total: [...steers.values()].reduce((a, b) => a + b, 0), byKind: sorted(steers) },
  doneCheckFollowUp: doneFollowUp,
  rulesByName: sorted(rules),
  conscience,
  contextSaver: { compressedResults: compressed },
};

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
console.log(`pi-warden field usage, ${report.window.since.slice(0, 10)} to ${report.window.until.slice(0, 10)}`);
console.log(`${files} sessions, ${bashCalls} bash calls, ${holds?.judged ?? "?"} judged actions, ${holds?.held ?? "?"} holds`);
console.log(`steers: ${report.steers.total}`, report.steers.byKind);
console.log(`done-check: ${doneFollowUp.ranCheck} of ${doneFollowUp.ranCheck + doneFollowUp.noCheck} followed by a check`);
console.log("holds:", holds);
console.log("conscience:", conscience, "context saver:", report.contextSaver);
