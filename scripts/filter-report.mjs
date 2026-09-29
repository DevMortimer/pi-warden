#!/usr/bin/env node
/**
 * Context filter report: filtered outputs beside head/diagnostic/tail excerpt outputs, across real Pi sessions.
 *
 * Reads Pi session logs and finds each compressed tool result by its header, then counts the later calls of the same
 * session that went back to its full-output file, with the recall rule the context saver uses: the first call whose
 * input names the file is a recall; a `read` without offset or limit, or a bare `cat`/`type`/`Get-Content` of it, is a
 * whole-file recall, anything else is scoped. Prints counts only: no session text, no paths. Offline; no requests.
 *
 * Usage:
 *   node scripts/filter-report.mjs [--since 2026-09-17] [--until 2026-09-29] [--json]
 *
 * Environment:
 *   PI_SESSIONS_DIR  Session logs (default: ~/.pi/agent/sessions).
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const since = new Date(arg("--since") ?? "1970-01-01");
const until = arg("--until") ? new Date(arg("--until")) : new Date();
const asJson = args.includes("--json");
const sessionsDir = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) { console.error("--since and --until take an ISO date"); process.exit(2); }

// The headers src/filter.ts and src/output.ts write; a security banner may come first, so they match at any line start.
const FILTERED = /^\[pi-warden: filtered; (\d+) original characters, \d+ lines\. Passages selected for the current task; omitted text is in the full-output file\.\]\n/m;
const EXCERPT = /^\[pi-warden: (?:errors_and_summary|summary_only); (\d+) original characters, \d+ lines\. Excerpts only; omitted text is in the full-output file\.\]\n/m;
const FOOTER = /\n\nFull output: (.+)\n/;

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

const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n") : "";
const mentions = (text, path) => text.includes(path) || text.includes(JSON.stringify(path).slice(1, -1));

/** Same rule as classifyRecall in src/recall.ts. */
function recallKind(tool, input, path) {
  const record = typeof input === "object" && input !== null ? input : {};
  if (tool === "read") return typeof record.offset === "number" || typeof record.limit === "number" ? "scoped" : "full";
  const command = typeof record.command === "string" ? record.command : typeof record.code === "string" ? record.code : undefined;
  if (!command) return "scoped";
  for (const segment of command.split(/&&|\|\||[;|]|\n/)) {
    if (!segment.includes(path)) continue;
    if (/^\s*(?:cat|type|Get-Content|gc)\b/.test(segment) && !/\s-(?:TotalCount|Head|Tail)\b/i.test(segment)) return "full";
  }
  return "scoped";
}

const blank = () => ({ outputs: 0, sessions: 0, originalChars: [], keptChars: [], recalls: 0, recallsFull: 0 });
const kinds = { filtered: blank(), excerpt: blank() };
let files = 0;
let unreadable = 0;

if (!existsSync(sessionsDir)) { console.error(`No session directory at the configured location.`); process.exit(1); }
for (const file of sessionFiles(sessionsDir)) {
  files++;
  const pending = []; // compressed outputs of this session not yet recalled
  const seenKinds = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { unreadable++; continue; }
    const message = event?.type === "message" ? event.message : undefined;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        const serialized = JSON.stringify(part.arguments ?? {});
        for (const item of pending) {
          if (item.recalled || !mentions(serialized, item.path)) continue;
          item.recalled = true;
          const counts = kinds[item.kind];
          counts.recalls++;
          if (recallKind(part.name, part.arguments, item.path) === "full") counts.recallsFull++;
        }
      }
    }
    if (message.role !== "toolResult") continue;
    const text = textOf(message.content);
    const filtered = FILTERED.exec(text);
    const excerpt = filtered ? undefined : EXCERPT.exec(text);
    const header = filtered ?? excerpt;
    if (!header) continue;
    const kind = filtered ? "filtered" : "excerpt";
    const footer = FOOTER.exec(text);
    const bodyStart = header.index + header[0].length;
    const body = footer && footer.index > bodyStart ? text.slice(bodyStart, footer.index) : text.slice(bodyStart);
    const counts = kinds[kind];
    counts.outputs++;
    counts.originalChars.push(Number(header[1]));
    counts.keptChars.push(body.length);
    seenKinds.add(kind);
    if (footer) pending.push({ kind, path: footer[1].trim(), recalled: false });
  }
  for (const kind of seenKinds) kinds[kind].sessions++;
}

const median = (values) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2); };
const sum = (values) => values.reduce((total, value) => total + value, 0);
const summary = Object.fromEntries(Object.entries(kinds).map(([kind, counts]) => [kind, {
  outputs: counts.outputs,
  sessions: counts.sessions,
  originalChars: { median: median(counts.originalChars), max: counts.originalChars.length ? Math.max(...counts.originalChars) : 0, total: sum(counts.originalChars) },
  keptChars: { median: median(counts.keptChars), max: counts.keptChars.length ? Math.max(...counts.keptChars) : 0, total: sum(counts.keptChars) },
  recalls: counts.recalls,
  recallsFull: counts.recallsFull,
  recallsScoped: counts.recalls - counts.recallsFull,
  recallRate: counts.outputs ? Number((counts.recalls / counts.outputs).toFixed(3)) : null,
}]));
const report = { since: since.toISOString(), until: until.toISOString(), sessionFiles: files, unreadableLines: unreadable, ...summary };

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Context filter report, ${report.since.slice(0, 10)} to ${report.until.slice(0, 10)}: ${files} session files${unreadable ? `, ${unreadable} unreadable lines` : ""}.`);
  for (const kind of ["filtered", "excerpt"]) {
    const row = summary[kind];
    const rate = row.recallRate === null ? "n/a" : `${Math.round(row.recallRate * 100)}%`;
    console.log(`  ${kind.padEnd(8)} ${row.outputs} outputs in ${row.sessions} sessions; original median ${row.originalChars.median} (max ${row.originalChars.max}) characters; kept median ${row.keptChars.median} (max ${row.keptChars.max}); recalls ${row.recalls} (${rate}; ${row.recallsFull} whole-file, ${row.recallsScoped} scoped).`);
  }
}
