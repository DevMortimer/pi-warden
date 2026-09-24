#!/usr/bin/env node
/**
 * Intent-mismatch notices in real Pi sessions: where the plan they were judged against came from.
 *
 * For every intent-mismatch notice, finds the assistant message that made the call and classifies the plan source:
 *   same      the message that made the call has text
 *   previous  the text is in an earlier assistant message with no tool call in between
 *   stale     the text is from before one or more earlier tool calls
 * It also rebuilds the branch as it stood at `tool_call` time and runs the built `assistantPlan` on it (with the call's
 * `isVisibleAction`), to count the notices whose question the current code would still ask. Run `npm run build` first.
 *
 * Prints aggregate counts only: no session text, no paths. Offline; no requests.
 *
 * Usage:
 *   node scripts/intent-cases.mjs --since 2026-09-21 [--until 2026-09-25] [--json]
 *
 * Environment:
 *   PI_SESSIONS_DIR  Session logs (default: ~/.pi/agent/sessions).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assistantPlan, isVisibleAction } from "../dist/extension.js";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const since = new Date(arg("--since") ?? "1970-01-01");
const until = arg("--until") ? new Date(arg("--until")) : new Date();
const asJson = args.includes("--json");
const sessionsDir = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");

const NOTICE = /does something different from what you said/;

function* sessionFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n") : "";
const hasText = (message) => textOf(message.content).trim().length > 0;
const hasToolCall = (message) => Array.isArray(message.content) && message.content.some(part => part?.type === "toolCall");

/** The entries from the root to `entry`, following parent ids; file order when an entry has no parent id. */
function branchTo(entries, byId, index) {
  if (entries[index].parentId === undefined) return entries.slice(0, index + 1);
  const chain = [];
  for (let entry = entries[index]; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) chain.push(entry);
  return chain.reverse();
}

/** Classifies one notice; `branch` ends at the notice. */
function classify(branch, toolName) {
  let at = branch.length - 1;
  // The notice follows the tool results of the message that made the call.
  while (at >= 0 && !(branch[at].type === "message" && branch[at].message?.role === "assistant")) {
    if (branch[at].type === "message" && branch[at].message?.role === "user") return { kind: "no-call" };
    at--;
  }
  if (at < 0) return { kind: "no-call" };
  const call = branch[at].message;
  if (!hasToolCall(call)) return { kind: "no-call" };
  const toolMatches = call.content.some(part => part?.type === "toolCall" && part.name === toolName);
  const atCall = branch.slice(0, at + 1);
  // With several calls of the notice's tool in one message, the notice is taken as visible when any of them is.
  const visible = call.content.some(part => part?.type === "toolCall" && part.name === toolName && isVisibleAction(part.name, part.arguments ?? {}));
  const planNow = assistantPlan({ sessionManager: { getBranch: () => atCall } }, visible) !== undefined;
  if (hasText(call)) return { kind: "same", toolMatches, planNow };
  let crossed = 0;
  for (let index = at - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") break;
    if (message.role === "toolResult") continue;
    if (message.role !== "assistant") continue;
    // Text in a message that also made a tool call described that call.
    if (hasToolCall(message)) crossed++;
    if (hasText(message)) return { kind: crossed ? "stale" : "previous", crossed, toolMatches, planNow };
  }
  return { kind: "no-text", toolMatches, planNow };
}

const counts = { same: 0, previous: 0, stale: 0, "no-text": 0, "no-call": 0 };
const staleDepth = new Map();
let notices = 0, toolMismatch = 0, askedNow = 0, files = 0;
const seen = new Set();

for (const file of sessionFiles(sessionsDir)) {
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  const byId = new Map(entries.filter(entry => entry.id).map(entry => [entry.id, entry]));
  let fileHasNotice = false;
  entries.forEach((entry, index) => {
    if (entry.type !== "custom_message" || entry.customType !== "pi-warden-steer") return;
    const at = new Date(entry.timestamp);
    if (at < since || at >= until) return;
    const text = textOf(entry.content);
    if (!NOTICE.test(text)) return;
    // A forked session copies its parent's entries; count each notice once.
    if (entry.id) { if (seen.has(entry.id)) return; seen.add(entry.id); }
    fileHasNotice = true;
    notices++;
    const toolName = /this (\S+) call does something different/.exec(text)?.[1];
    const result = classify(branchTo(entries, byId, index), toolName);
    counts[result.kind]++;
    if (result.toolMatches === false) toolMismatch++;
    if (result.planNow) askedNow++;
    if (result.kind === "stale") staleDepth.set(result.crossed, (staleDepth.get(result.crossed) ?? 0) + 1);
  });
  if (fileHasNotice) files++;
}

const report = {
  window: { since: since.toISOString(), until: until.toISOString() },
  notices,
  sessions: files,
  planSource: counts,
  staleByEarlierToolCallMessages: Object.fromEntries([...staleDepth].sort((a, b) => a[0] - b[0])),
  noticeToolNotInCallMessage: toolMismatch,
  askedByCurrentAssistantPlan: askedNow,
};
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`intent-mismatch notices: ${notices} in ${files} sessions (${report.window.since.slice(0, 10)} to ${report.window.until.slice(0, 10)})`);
  console.log(`plan source: same message ${counts.same}, previous message ${counts.previous}, stale ${counts.stale}${counts["no-text"] ? `, no text ${counts["no-text"]}` : ""}${counts["no-call"] ? `, no call found ${counts["no-call"]}` : ""}`);
  if (staleDepth.size) console.log(`stale, by earlier tool-call messages crossed: ${[...staleDepth].sort((a, b) => a[0] - b[0]).map(([depth, n]) => `${depth}: ${n}`).join(", ")}`);
  if (toolMismatch) console.log(`notices whose tool is not in the call message found: ${toolMismatch}`);
  console.log(`question asked by the built assistantPlan: ${askedNow} of ${notices}`);
}
