#!/usr/bin/env node
/**
 * Rules-at-turn-start skip replay: how many recorded prompts would send no rule question because the prompt-level gate
 * skips them ("yes", "continue", a relayed child report). Offline: reads session files and sends nothing.
 *
 * The rules request runs before each new user message; the skip predicates are the same ones the conscience uses, so
 * the two surfaces agree on what needs no judgment. This counts requests per 100 recorded prompts before the skip
 * (every prompt sent one) and after it.
 *
 * Run: npm run build && node scripts/rules-turn-replay.mjs [--dir PATH] [--since DATE]
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isRelayedReport, isShortContinuation } from "../dist/conscience.js";
import { redact } from "../dist/redact.js";

const args = process.argv.slice(2);
const value = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const sessionsRoot = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
const since = value("since");

const text = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part && part.type === "text").map(part => part.text ?? "").join("\n") : "";

async function readBranch(path) {
  const entries = [];
  const lines = createInterface({ input: createReadStream(path, { crlfDelay: Infinity }) });
  for await (const line of lines) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { /* one torn line is not a lost session */ } }
  const header = entries.find(entry => entry.type === "session");
  const byId = new Map(entries.filter(entry => entry.id).map(entry => [entry.id, entry]));
  let leaf = entries.filter(entry => entry.id).at(-1);
  const chain = [];
  while (leaf) { chain.push(leaf); leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined; }
  return { header, branch: chain.reverse() };
}

/** Every operator prompt of a session, in order, as the turn-start hook receives it. */
function promptsOf(branch) {
  const prompts = [];
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const prompt = text(entry.message.content).trim();
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

async function sessionFiles() {
  const dir = value("dir");
  const dirs = dir ? [resolve(dir)] : (existsSync(sessionsRoot) ? readdirSync(sessionsRoot).filter(name => statSync(join(sessionsRoot, name)).isDirectory()).map(name => join(sessionsRoot, name)) : []);
  const files = [];
  for (const projectDir of dirs) for (const name of await readdir(projectDir)) if (name.endsWith(".jsonl")) files.push(join(projectDir, name));
  files.sort();
  return files;
}

const files = await sessionFiles();
let total = 0, short = 0, relayed = 0, sessions = 0;
for (const file of files) {
  const { header, branch } = await readBranch(file);
  if (!header || (since && new Date(header.timestamp ?? 0) < new Date(since))) continue;
  sessions++;
  for (const prompt of promptsOf(branch)) {
    total++;
    // The hook checks the same redacted, clipped text the conscience gate sees.
    const gated = redact(prompt).slice(0, 2000);
    if (isShortContinuation(gated)) short++;
    else if (isRelayedReport(gated)) relayed++;
  }
}
const skipped = short + relayed;
const perHundred = (count) => (total ? count / total * 100 : 0);
console.log(JSON.stringify({
  sessions,
  prompts: total,
  shortContinuation: short,
  relayedReport: relayed,
  skipped,
  requestsPer100Before: total ? 100 : 0,
  requestsPer100After: total ? Math.round((100 - perHundred(skipped)) * 10) / 10 : 0,
  skipSharePercent: Math.round(perHundred(skipped) * 10) / 10,
}, null, 2));
