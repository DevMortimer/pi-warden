#!/usr/bin/env node
/**
 * Cause-check pre-filter replay: counts the final replies in recorded Pi sessions and the replies the offline
 * pre-filter flags. Nothing is sent; the script only reads local session logs.
 *
 * The pre-filter is deliberately broad, so this measures how often a reply reaches Jev at all. A sample of the
 * flagged replies goes to `--out` (redacted and clipped) so a person can label each one; stdout carries aggregate
 * counts only, and the report under `eval/reports/` carries no session text, paths, or project names.
 *
 * Usage:
 *   node scripts/cause-replay.mjs [--sessions DIR] [--since DATE] [--until DATE] [--sample N] [--out FILE] [--json]
 *
 * Build first: the replay runs the guard from dist/.
 */
import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { causePreFilter, redact } from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const has = name => args.includes(name);
const since = new Date(flag("--since", "2026-09-16"));
const until = flag("--until") ? new Date(flag("--until")) : new Date();
const sessionsRoot = resolve(flag("--sessions", join(homedir(), ".pi", "agent", "sessions")));
const sampleSize = Number(flag("--sample", "20"));
const out = flag("--out");
const wantJson = has("--json");
const inWindow = at => !(at < since || at >= until);

/** Every `.jsonl` file under a directory, with its modification time. */
function walk(dir, files = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.name.endsWith(".jsonl")) {
      try { files.push({ path, mtime: statSync(path).mtime }); } catch { /* unreadable */ }
    }
  }
  return files;
}

const textOf = content => (typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part && part.type === "text").map(part => part.text ?? "").join("\n") : "");

/** The branch Pi resumes: the parent chain from the last entry. */
function mainPath(entries) {
  const byId = new Map(entries.filter(entry => typeof entry?.id === "string").map(entry => [entry.id, entry]));
  const last = entries.at(-1);
  if (!last || typeof last.id !== "string" || byId.size === 0) return entries;
  const path = [];
  const seen = new Set();
  for (let current = last; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    path.push(current);
  }
  return path.reverse();
}

async function readEntries(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  const entries = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return entries;
}

/** The final reply of each run: an assistant text message that ended a run normally. */
function finalReplies(branch) {
  const replies = [];
  for (const entry of branch) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason !== "stop") continue;
    const text = textOf(entry.message.content).trim();
    if (text) replies.push(text);
  }
  return replies;
}

// --- Count ---------------------------------------------------------------------------------------------
const files = walk(sessionsRoot).filter(file => file.mtime >= since && file.mtime < until);
let sessions = 0;
let replies = 0;
let flagged = 0;
const samples = [];
for (const file of files) {
  let entries;
  try { entries = await readEntries(file.path); } catch { continue; }
  if (!entries.length) continue;
  sessions++;
  for (const reply of finalReplies(mainPath(entries))) {
    replies++;
    if (!causePreFilter(reply)) continue;
    flagged++;
    samples.push(reply);
  }
}

// A deterministic spread across the flagged replies, so a run over a different corpus still gives a fair sample.
const picked = [];
if (sampleSize > 0 && samples.length > 0) {
  const stride = samples.length / Math.min(sampleSize, samples.length);
  for (let index = 0; index < Math.min(sampleSize, samples.length); index++) picked.push(samples[Math.floor(index * stride)]);
}

const summary = { sessions, replies, flagged, flaggedShare: replies ? Number((flagged / replies).toFixed(3)) : 0, sample: picked.length };

if (out && picked.length) {
  const body = picked.map((reply, index) => {
    const clip = redact(reply).replace(/\s+/g, " ").trim().slice(0, 200);
    return `### ${index + 1}\n\n- reply: ${clip}\n- call: pending\n- reason: pending\n`;
  }).join("\n");
  writeFileSync(out, `# Cause-check pre-filter sample\n\nA deterministic sample of ${picked.length} flagged final replies from ${sessions} recorded sessions (${replies} final replies, ${flagged} flagged). Every reply is redacted and cut to 200 characters. Each call is a person's judgment of whether the reply is a real unchecked cause.\n\n${body}`);
}

if (wantJson) console.log(JSON.stringify(summary));
else {
  console.log(`sessions: ${sessions}`);
  console.log(`final replies: ${replies}`);
  console.log(`flagged by the pre-filter: ${flagged} (${(summary.flaggedShare * 100).toFixed(1)}%)`);
  console.log(`sample written: ${out ? picked.length : 0}`);
}
