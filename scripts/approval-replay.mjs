// Replays the approval designs on held calls recorded in trace files, and counts approval questions offline.
//
// A real case is a judged action call whose trace line has a `confirm` verdict and an `approved` score: the call was held, or it
// was released because the reply read as approval. Its reply (`task`), the agent message before it (`asked`), the call, and the
// plan and spine of the old request are rebuilt from the session file of the same session. Session content stays on this machine:
// the script prints counts and rates only; with --out it writes the per-case scores (no text) to a file you keep private.
//
//   --traces DIR      directory of per-session trace files (the `PI_WARDEN_TRACE_DIR` layout, one level of subfolders allowed). Required.
//   --sessions DIR    Pi session files (default ~/.pi/agent/sessions)
//   --since DATE      first day to read (default 2026-09-16)
//   --labels FILE     JSON { "<session id>:<trace time>": true|false }: whether the reply approves that action, labelled blind by a model
//   --judge           send every design's request for each case (billable: cases x 3 x --repeats requests); without it, counts only
//   --designs LIST    comma list of old, candidate, round2 (default all)
//   --repeats N       runs per question (default 3)
//   --out FILE        write per-case scores as JSON
// Build first (npm run build); run: PI_TYPESAFE_MAX_USD_PER_DAY=0.5 node scripts/approval-replay.mjs --traces DIR --labels FILE --judge
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTypeSafe } from 'pi-typesafe';
import { describeAction, describePlan, taskSpine } from '../dist/index.js';
import { designs, measure, tally } from './approval-designs.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback; };
const tracesDir = value('traces');
if (!tracesDir) { console.error('--traces DIR is required'); process.exit(2); }
const sessionsDir = value('sessions', join(homedir(), '.pi', 'agent', 'sessions'));
const since = value('since', '2026-09-16');
const repeats = Number(value('repeats', 3));
const only = value('designs', designs.join(',')).split(',');

const walk = dir => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : name.endsWith('.jsonl') ? [path] : []; });
const norm = text => String(text).replace(/\s+/g, ' ').trim();
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

// --- Traces: counts for (c), and the held calls for (b). ---
let judged = 0, asked = 0;
const rows = [];
for (const file of walk(tracesDir)) {
  let header;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    if (record.kind === 'session') { header = record; continue; }
    if (record.kind !== 'entry' || record.guard !== 'action' || record.at.slice(0, 10) < since) continue;
    const jev = (record.details ?? []).find(detail => detail.startsWith('jev: '));
    if (!jev) continue;
    judged++;
    if (!/approved \d\.\d\d/.test(jev)) continue;
    asked++;
    const released = (record.details ?? []).some(detail => /^why: user approved in the latest message/.test(detail));
    if (record.tokens?.level === 'confirm' || released) rows.push({ sessionId: header?.sessionId, at: record.at, released, tool: record.tokens?.tool, details: record.details });
  }
}
console.log(`judged action calls since ${since}: ${judged}`);
console.log(`carried the old approval question: ${asked} (${(asked / judged * 1000).toFixed(1)} per 1,000 judged calls)`);
console.log(`approval requests the new design sends: ${rows.length} (${(rows.length / judged * 1000).toFixed(1)} per 1,000 judged calls): one per held call under a reply`);
console.log(`real cases (confirm verdict with an approval score): ${rows.length}, ${rows.filter(row => row.released).length} released, ${rows.filter(row => !row.released).length} held`);

// --- Sessions: rebuild each case. ---
const sessionFiles = {};
for (const file of walk(sessionsDir)) { const match = file.match(/_([0-9a-f-]{36})\.jsonl$/); if (match) sessionFiles[match[1]] = file; }
const cases = [];
for (const row of rows) {
  const file = sessionFiles[row.sessionId];
  if (!file) continue;
  const entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const ran = norm((row.details.find(detail => detail.startsWith('ran: ')) ?? '').slice(5)).replace(/…$/, '');
  // The call: the tool call of that tool nearest in time, a prefix match of the traced command winning ties.
  let best, bestScore = Infinity;
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content) {
      if (part.type !== 'toolCall' || part.name !== row.tool) continue;
      const command = norm(part.arguments?.command ?? part.arguments?.path ?? '');
      const prefix = ran.length > 0 && (command.startsWith(ran.slice(0, 200)) || ran.startsWith(command.slice(0, 200)));
      const score = Math.abs(Date.parse(entry.timestamp) - Date.parse(row.at)) + (prefix ? 0 : 20000);
      if (score < bestScore) { bestScore = score; best = { entry, part }; }
    }
  }
  if (!best || bestScore > 60000) continue;
  const branch = [];
  for (let cursor = best.entry; cursor; cursor = byId.get(cursor.parentId)) branch.unshift(cursor);
  const userIndex = branch.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  if (userIndex < 0) continue;
  const reply = branch[userIndex];
  // The assistant messages of the turn the reply answers: after the previous user message, before the reply, in order.
  const messages = [];
  for (let cursor = userIndex - 1; cursor >= 0 && !(branch[cursor].type === 'message' && branch[cursor].message.role === 'user'); cursor--) {
    if (branch[cursor].type === 'message' && branch[cursor].message.role === 'assistant') messages.unshift(textOf(branch[cursor].message.content).trim());
  }
  const reasons = (row.details.find(detail => detail.startsWith('why: ')) ?? '').slice(5).split('; ').filter(reason => reason && !reason.startsWith('user approved in the latest message'));
  const summary = describeAction(best.part.name, best.part.arguments, entries[0].cwd);
  const task = textOf(reply.message.content);
  const plan = describePlan(textOf(best.entry.message.content));
  cases.push({ key: `${row.sessionId}:${row.at}`, released: row.released, task, messages, summary, reasons, plan, spine: taskSpine(branch.slice(0, userIndex + 1)) });
}
console.log(`rebuilt from the session files: ${cases.length} of ${rows.length}`);
if (!args.includes('--judge')) process.exit(0);

// --- Judge: every design on every case, `repeats` runs each. ---
const labelsFile = value('labels');
const labels = labelsFile ? JSON.parse(readFileSync(labelsFile, 'utf8')) : {};
const judge = createTypeSafe({ maxRequests: cases.length * repeats * only.length + 10 });
const rows = await measure(judge, cases.map(item => ({ ...item, approves: labels[item.key] })), { repeats, only });
const labelled = rows.filter(row => typeof row.item.approves === 'boolean');
console.log(`labelled: ${labelled.length} (${labelled.filter(row => row.item.approves).length} approve, ${labelled.filter(row => !row.item.approves).length} do not)`);
for (const design of only) console.log(design, JSON.stringify(tally(labelled, design)));
console.log('as recorded (old question at the time):', JSON.stringify({ released: cases.filter(item => item.released).length, held: cases.filter(item => !item.released).length }));
const usage = judge.getUsage();
console.log(`requests: ${usage.requestsStarted}, input tokens: ${usage.inputTokens}, output tokens: ${usage.outputTokens}`);
if (value('out')) writeFileSync(value('out'), JSON.stringify(rows.map(({ item, runs }) => ({ key: item.key, label: item.approves, released: item.released, runs })), null, 1), { mode: 0o600 });
