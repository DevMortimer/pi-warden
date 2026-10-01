// Replays the approval question on held calls recorded in trace files, and counts approval questions offline.
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
//   --judge           send the old and the new question for each case (billable: cases x 2 x --repeats requests); without it, counts only
//   --repeats N       runs per question (default 3)
//   --out FILE        write per-case scores as JSON
// Build first (npm run build); run: PI_TYPESAFE_MAX_USD_PER_DAY=0.5 node scripts/approval-replay.mjs --traces DIR --labels FILE --judge
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTypeSafe } from 'pi-typesafe';
import { APPROVAL_THRESHOLD, approvalQuestion, buildApprovalRequest, buildRequest, describeAction, describePlan, taskSpine } from '../dist/index.js';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback; };
const tracesDir = value('traces');
if (!tracesDir) { console.error('--traces DIR is required'); process.exit(2); }
const sessionsDir = value('sessions', join(homedir(), '.pi', 'agent', 'sessions'));
const since = value('since', '2026-09-16');
const repeats = Number(value('repeats', 3));

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
  const before = branch.slice(0, userIndex).findLast(entry => entry.type === 'message' && (entry.message.role === 'assistant' || entry.message.role === 'user'));
  const askedText = before?.message.role === 'assistant' ? textOf(before.message.content).trim() : '';
  const reasons = (row.details.find(detail => detail.startsWith('why: ')) ?? '').slice(5).split('; ').filter(reason => reason && !reason.startsWith('user approved in the latest message'));
  const summary = describeAction(best.part.name, best.part.arguments, entries[0].cwd);
  const task = textOf(reply.message.content);
  const plan = describePlan(textOf(best.entry.message.content));
  cases.push({ key: `${row.sessionId}:${row.at}`, released: row.released, task, asked: askedText, summary, reasons, plan, spine: taskSpine(branch.slice(0, userIndex + 1)) });
}
console.log(`rebuilt from the session files: ${cases.length} of ${rows.length}`);
if (!args.includes('--judge')) process.exit(0);

// --- Judge: the old question (acting-request state, `task` only) against the new one. ---
const labelsFile = value('labels');
const labels = labelsFile ? JSON.parse(readFileSync(labelsFile, 'utf8')) : {};
const judge = createTypeSafe({ maxRequests: cases.length * repeats * 2 + 10 });
const scored = [];
for (const item of cases) {
  const oldRequest = { state: buildRequest(item.summary, item.task, { approval: true, plan: item.plan, spine: item.spine }).state, questions: approvalQuestion };
  const newRequest = buildApprovalRequest(item.summary, item.task, item.asked, item.reasons);
  const run = async request => Promise.all(Array.from({ length: repeats }, async () => (await judge.evaluate(request)).answers.approved.noul));
  const [oldScores, newScores] = await Promise.all([run(oldRequest), run(newRequest)]);
  scored.push({ key: item.key, released: item.released, label: labels[item.key], old: oldScores, new: newScores });
}
// A call counts as released when every run is at or above the threshold, held otherwise; the mean decides the table when runs disagree.
const mean = scores => scores.reduce((total, score) => total + score, 0) / scores.length;
const releases = scores => mean(scores) >= APPROVAL_THRESHOLD;
const labelled = scored.filter(item => typeof item.label === 'boolean');
const table = arm => ({
  releasedCorrectly: labelled.filter(item => item.label && releases(item[arm])).length,
  releasedWrongly: labelled.filter(item => !item.label && releases(item[arm])).length,
  heldCorrectly: labelled.filter(item => !item.label && !releases(item[arm])).length,
  heldWrongly: labelled.filter(item => item.label && !releases(item[arm])).length,
});
console.log(`labelled: ${labelled.length} (${labelled.filter(item => item.label).length} approve, ${labelled.filter(item => !item.label).length} do not)`);
console.log('old question:', JSON.stringify(table('old')));
console.log('new question:', JSON.stringify(table('new')));
console.log('as recorded (old question at the time):', JSON.stringify({ released: scored.filter(item => item.released).length, held: scored.filter(item => !item.released).length }));
const usage = judge.getUsage();
console.log(`requests: ${usage.requestsStarted}, input tokens: ${usage.inputTokens}, output tokens: ${usage.outputTokens}`);
if (value('out')) writeFileSync(value('out'), JSON.stringify(scored, null, 1), { mode: 0o600 });
