// Replays the recorded compactions in Pi's session files through the relevance compaction, with real Jev requests, and
// compares each result with the summary Pi wrote. Billable: one request per batch of keep questions.
// Build first; run: node --env-file-if-exists=.env scripts/relevance-replay.mjs [--dry-run] [--cap 1500] [--out <dir>] [--sessions <dir>]
// The output directory gets counts, sizes, rates, and scores per compaction; never session text. Keep it private anyway.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTypeSafe } from 'pi-typesafe';
import { buildRequests, buildUnits, compactionCandidates, defaultConfig, KEEP_CHARS, relevanceCompaction, renderSummary, summaryTokens, taskSpine } from '../dist/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const dryRun = args.includes('--dry-run');
const cap = Number(flag('--cap', '1500'));
const out = resolve(flag('--out', '.local/relevance-replay'));
const sessionsRoot = resolve(flag('--sessions', join(homedir(), '.pi', 'agent', 'sessions')));
const SINGLE_RUNS = 3;
/** The extension's own per-request timeout (config.timeoutMs), so replay latency matches a session. */
const REQUEST_TIMEOUT_MS = defaultConfig().timeoutMs;
const compaction = defaultConfig().compaction;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}

/** The branch Pi resumes: the parent chain from the last entry. */
function mainPath(entries) {
  const byId = new Map(entries.filter(entry => typeof entry?.id === 'string').map(entry => [entry.id, entry]));
  const last = entries.at(-1);
  if (!last || typeof last.id !== 'string' || byId.size === 0) return entries;
  const path = [];
  const seen = new Set();
  for (let current = last; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    path.push(current);
  }
  return path.reverse();
}

/** The message an entry puts in context, as Pi's compaction sees it. */
function entryMessage(entry) {
  if (entry.type === 'message' && entry.message) return entry.message;
  if (entry.type === 'custom_message') return { role: 'custom', customType: entry.customType, content: entry.content };
  if (entry.type === 'branch_summary') return { role: 'branchSummary', summary: entry.summary };
  return undefined;
}

const toolCalls = messages => messages.filter(message => message.role === 'assistant').flatMap(message => (Array.isArray(message.content) ? message.content : []).filter(block => block?.type === 'toolCall'));
const callKey = block => {
  const input = block.arguments ?? {};
  if (block.name === 'read' && typeof input.path === 'string') return `read:${input.path}`;
  if (block.name === 'bash' && typeof input.command === 'string') return `bash:${input.command.trim()}`;
  return undefined;
};

function fileOps(messages, previous) {
  const ops = { read: new Set(), written: new Set(), edited: new Set() };
  if (previous && !previous.fromHook && previous.details) {
    for (const file of previous.details.readFiles ?? []) ops.read.add(file);
    for (const file of previous.details.modifiedFiles ?? []) ops.edited.add(file);
  }
  for (const block of toolCalls(messages)) {
    const path = block.arguments?.path;
    if (typeof path !== 'string') continue;
    if (block.name === 'read') ops.read.add(path);
    else if (block.name === 'write') ops.written.add(path);
    else if (block.name === 'edit') ops.edited.add(path);
  }
  return ops;
}

/** Every compaction on the resumed branch, with the span it replaced and the first ten tool calls after it. */
function recordedCompactions() {
  const found = [];
  for (const file of walk(sessionsRoot)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('"compaction"')) continue;
    const entries = text.split('\n').filter(line => line.trim()).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const path = mainPath(entries);
    let previous;
    let previousIndex = -1;
    for (let index = 0; index < path.length; index++) {
      const entry = path[index];
      if (entry.type !== 'compaction') continue;
      const kept = path.findIndex(candidate => candidate.id === entry.firstKeptEntryId);
      let start = 0;
      if (previous) {
        const previousKept = path.findIndex(candidate => candidate.id === previous.firstKeptEntryId);
        start = previousKept >= 0 ? previousKept : previousIndex + 1;
      }
      const spanEntries = path.slice(start, kept >= 0 ? kept : index).filter(candidate => candidate.type !== 'compaction');
      const messages = spanEntries.map(entryMessage).filter(Boolean);
      const after = [];
      for (const later of path.slice(index + 1)) {
        if (later.type !== 'message' || later.message?.role !== 'assistant') continue;
        for (const block of toolCalls([later.message])) if (after.length < 10) after.push(block);
        if (after.length >= 10) break;
      }
      const spanKeys = new Set(toolCalls(messages).map(callKey).filter(Boolean));
      const refetches = after.map(callKey).filter(key => key && spanKeys.has(key));
      const before = path.slice(0, index);
      const turns = before.filter(candidate => candidate.type === 'message' && candidate.message?.role === 'user');
      const lastUser = turns.at(-1)?.message?.content;
      const task = typeof lastUser === 'string' ? lastUser : (Array.isArray(lastUser) ? lastUser.filter(part => part.type === 'text').map(part => part.text).join('\n') : '');
      found.push({
        id: `${createHash('sha256').update(file).digest('hex').slice(0, 8)}-${index}`,
        piSummary: typeof entry.summary === 'string' ? entry.summary : '',
        input: { messages, previousSummary: previous?.summary, fileOps: fileOps(messages, previous), task, spine: taskSpine(before, task) },
        refetches,
      });
      previous = entry;
      previousIndex = index;
    }
  }
  return found;
}

const tokens = chars => Math.ceil(chars / 4);
const quantile = (values, q) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (q === 0.5) { const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

/** Whether a unit for this re-fetch key is kept, and whole or cut to its head and tail. */
function coverage(key, units, kept) {
  const [tool, ...rest] = key.split(':');
  const target = rest.join(':');
  const matches = units.filter(unit => unit.kind === 'tool' && unit.input && unit.tool === tool && (tool === 'read' ? unit.input.path === target : typeof unit.input.command === 'string' && unit.input.command.trim() === target));
  const keptMatches = matches.filter(unit => kept.has(unit.id));
  if (!keptMatches.length) return 'none';
  return keptMatches.some(unit => unit.compressed || (unit.result ?? '').length <= KEEP_CHARS) ? 'whole' : 'partial';
}

const compactions = recordedCompactions();
const plans = compactions.map(item => {
  const { units, files } = buildUnits(item.input);
  // Text that is always kept over budget falls back before any request.
  const fits = summaryTokens(renderSummary(units, files, new Set())) <= compaction.maxSummaryTokens;
  return { item, units, fits, candidates: compactionCandidates(units).length, requests: fits ? buildRequests(units, item.input).length : 0 };
});
// The one-question runs use the spans nearest the median size, so their states look like a typical compaction's.
const medianUnits = quantile(plans.map(plan => plan.candidates), 0.5);
const singles = plans.filter(plan => plan.fits).sort((a, b) => Math.abs(a.candidates - medianUnits) - Math.abs(b.candidates - medianUnits)).slice(0, SINGLE_RUNS);
const plannedBatched = plans.reduce((sum, plan) => sum + plan.requests, 0);
const plannedSingles = singles.reduce((sum, plan) => sum + plan.candidates, 0);
console.log(`compactions: ${plans.length}; scored units: ${plans.reduce((sum, plan) => sum + plan.candidates, 0)}; re-fetch calls: ${plans.reduce((sum, plan) => sum + plan.item.refetches.length, 0)}`);
console.log(`planned requests: ${plannedBatched} batched + ${plannedSingles} one-question (${singles.map(plan => plan.candidates).join(', ')} units) = ${plannedBatched + plannedSingles}; cap ${cap}`);
if (dryRun) process.exit(0);

// The cap is enforced twice: the plan skips what would pass it, and the client refuses request cap + 1.
let budget = cap;
const runBatched = [];
const skipped = [];
for (const plan of plans) {
  if (plan.requests > budget - plannedSingles) { skipped.push({ id: plan.item.id, requests: plan.requests, why: 'cap' }); continue; }
  budget -= plan.requests;
  runBatched.push(plan);
}
const client = createTypeSafe({ timeoutMs: REQUEST_TIMEOUT_MS, maxRequests: cap });
let sent = 0;
const judge = { evaluate: (request, options) => { sent++; return client.evaluate(request, options); } };

const rows = [];
for (const plan of runBatched) {
  const { item, units } = plan;
  const result = await relevanceCompaction(item.input, { judge, config: compaction });
  const kept = new Set(result.ok ? result.keptIds : []);
  const refetch = item.refetches.map(key => ({ ours: result.ok ? coverage(key, units, kept) : 'fallback', piMentions: item.piSummary.includes(key.slice(key.indexOf(':') + 1)) }));
  rows.push({
    id: item.id, ok: result.ok, reason: result.ok ? undefined : result.reason, detail: result.ok ? undefined : result.detail,
    candidates: plan.candidates, kept: result.stats.kept, requests: result.stats.requests, inputTokens: result.stats.inputTokens, elapsedMs: result.stats.elapsedMs,
    threshold: result.stats.threshold, oursTokens: result.ok ? tokens(result.summary.length) : null, piTokens: tokens(item.piSummary.length),
    refetch, scores: result.scores,
  });
  console.log(`${item.id}: ${result.ok ? `kept ${result.stats.kept}/${plan.candidates}, ~${tokens(result.summary.length)} tokens` : `fallback ${result.reason}`}; ${result.stats.requests} requests, ${result.stats.elapsedMs} ms`);
}

const agreement = [];
for (const plan of singles) {
  const batched = rows.find(row => row.id === plan.item.id);
  if (!batched) { skipped.push({ id: plan.item.id, requests: plan.candidates, why: 'one-question run: batched run skipped' }); continue; }
  // A generous deadline and no per-compaction cap: this run measures probabilities, not latency; the client cap still holds.
  const single = await relevanceCompaction(plan.item.input, { judge, config: { ...compaction, timeoutMs: 600_000, maxRequests: Infinity }, questionsPerRequest: 1 });
  const ids = Object.keys(single.scores).filter(id => id in batched.scores);
  const same = ids.filter(id => (single.scores[id] >= compaction.keepThreshold) === (batched.scores[id] >= compaction.keepThreshold)).length;
  const diffs = ids.map(id => single.scores[id] - batched.scores[id]);
  agreement.push({ id: plan.item.id, units: ids.length, requests: single.stats.requests, ok: single.ok, reason: single.ok ? undefined : single.reason, agree: same, meanAbsDiff: diffs.reduce((sum, d) => sum + Math.abs(d), 0) / (ids.length || 1), meanDiff: diffs.reduce((sum, d) => sum + d, 0) / (ids.length || 1) });
}

const ran = rows.filter(row => row.requests > 0);
const replaced = rows.filter(row => row.ok);
const refetchAll = rows.flatMap(row => row.refetch);
const count = predicate => refetchAll.filter(predicate).length;
const fallbacks = rows.filter(row => !row.ok).reduce((map, row) => ({ ...map, [row.reason]: (map[row.reason] ?? 0) + 1 }), {});
const report = {
  generatedAt: new Date().toISOString(), cap, planned: { batched: plannedBatched, singles: plannedSingles }, sent, skipped,
  compactions: plans.length, replayed: rows.length, replaced: replaced.length,
  size: {
    oursMedian: quantile(replaced.map(row => row.oursTokens), 0.5), oursP90: quantile(replaced.map(row => row.oursTokens), 0.9),
    piMedian: quantile(replaced.map(row => row.piTokens), 0.5), piP90: quantile(replaced.map(row => row.piTokens), 0.9),
    ratioMedian: quantile(replaced.map(row => row.oursTokens / Math.max(1, row.piTokens)), 0.5),
  },
  refetch: { total: refetchAll.length, oursWhole: count(r => r.ours === 'whole'), oursPartial: count(r => r.ours === 'partial'), oursNone: count(r => r.ours === 'none'), oursFallback: count(r => r.ours === 'fallback'), piVerbatim: 0, piMentions: count(r => r.piMentions) },
  cost: {
    requestsMedian: quantile(ran.map(row => row.requests), 0.5), requestsP90: quantile(ran.map(row => row.requests), 0.9),
    inputTokensMedian: quantile(ran.map(row => row.inputTokens), 0.5), inputTokensP90: quantile(ran.map(row => row.inputTokens), 0.9),
    msMedian: quantile(ran.map(row => row.elapsedMs), 0.5), msP90: quantile(ran.map(row => row.elapsedMs), 0.9),
  },
  fallbacks, agreement, rows,
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
console.log(`report: ${join(out, 'report.json')}`);
