#!/usr/bin/env node
/**
 * Action-guard replay: rebuilds the action requests that real Pi sessions produced and measures the ask gate, the lean
 * request, and the verdict cache against them.
 *
 * Inputs are local session logs (full tool inputs), the trace files (per-guard counts), the holds database (which calls
 * the agent saw Jev change), and the pi-typesafe usage ledger (requests and input tokens per day). Nothing is sent
 * unless `--judge` is given; that phase is billable and is capped by `--sample`.
 *
 * Privacy: aggregate numbers only on stdout. A `--out` directory receives per-call detail (commands, paths, scores) and
 * must stay outside the repository.
 *
 * Usage:
 *   node scripts/action-replay.mjs [--since 2026-09-25] [--until 2026-09-30T22:24] [--out DIR] [--json]
 *   node scripts/action-replay.mjs --sample 200 --judge [--out DIR]        # billable: compares lean with full
 *
 * Environment:
 *   PI_SESSIONS_DIR  Session logs (default: ~/.pi/agent/sessions).
 *   PI_WARDEN_DB     Holds database (default: ~/.pi/agent/pi-warden/holds.db).
 *   PI_WARDEN_TRACE_DIR  Trace files (default: ~/.pi/agent/carvel/extension-data/warden/traces).
 *
 * Build first: the replay runs the guard from dist/.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { usagePath } from "pi-typesafe";
import { actionAskGate, buildRequest, commandOf, defaultConfig, describeAction, evaluateAction, resolveRulesFile, stripDataText } from "../dist/index.js";
import { VerdictCache, cacheKey } from "../dist/verdict-cache.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const has = name => args.includes(name);
const since = new Date(flag("--since", "2026-09-25"));
const until = flag("--until") ? new Date(flag("--until")) : new Date();
const sessionsRoot = resolve(flag("--sessions", join(homedir(), ".pi", "agent", "sessions")));
const dbPath = resolve(flag("--db", process.env.PI_WARDEN_DB ?? join(homedir(), ".pi", "agent", "pi-warden", "holds.db")));
const traceRoot = process.env.PI_WARDEN_TRACE_DIR ?? join(homedir(), ".pi", "agent", "carvel", "extension-data", "warden", "traces");
const out = flag("--out");
const wantJson = has("--json");
const sampleSize = Number(flag("--sample", "0"));
const useJudge = has("--judge");
const action = defaultConfig().action;
const TOOLS = new Set(action.tools);

const inWindow = at => !(at < since || at >= until);
const count = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const day = at => at.toISOString().slice(0, 10);
const textOf = content => (typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text).join("\n") : "");

function walk(dir, files = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

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

/** Every judged call of one session, with the task and context the guard would have sent. */
function callsOfSession(path, calls) {
  let entries;
  try { entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return; }
  const header = entries[0];
  const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
  if (!cwd) return;
  const branch = mainPath(entries);
  const history = [];
  for (const entry of branch) {
    if (entry?.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(content);
    if (role === "assistant" && Array.isArray(content)) {
      const at = new Date(entry.timestamp ?? header.timestamp ?? Date.now());
      if (!inWindow(at)) { if (text.trim()) history.push({ role, text }); continue; }
      const task = [...history].reverse().find(message => message.role === "user")?.text;
      const context = history.filter((_, index) => index < history.length - 1 || history[index].role !== "user").slice(-8).map(message => ({ role: message.role, text: message.text.slice(0, 750) }));
      for (const part of content) {
        if (part?.type !== "toolCall" || typeof part.name !== "string" || !TOOLS.has(part.name)) continue;
        calls.push({ at, cwd, session: header.id ?? path, tool: part.name, input: part.arguments ?? {}, task, context, plan: text.trim() ? text : undefined });
      }
    }
    if (text.trim()) history.push({ role, text });
  }
}

// --- Phase 1: rebuild every judged action call in the window ---------------------------------------------
const calls = [];
for (const path of walk(sessionsRoot)) {
  const mtime = statSync(path).mtime;
  if (mtime < since || mtime >= until) continue;
  callsOfSession(path, calls);
}
calls.sort((a, b) => a.at - b.at);

/** A judge stub: records the request it was handed and answers without a network call. */
function stubJudge(record) {
  return {
    evaluate: async request => {
      record.push(request);
      return {
        model: "stub",
        elapsedMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        answers: {
          irreversible: { type: "noul", noul: 0.02 },
          off_task: { type: "noul", noul: 0.1 },
          scope: { type: "choice", choice: "expected_step", confidence: 0.9 },
          mutates: { type: "noul", noul: 0.6 },
          visible: { type: "noul", noul: 0.05 },
          should_proceed: { type: "noul", noul: 0.9 },
          intent_mismatch: { type: "noul", noul: 0.1 },
          large_output: { type: "noul", noul: 0.05 },
          approved: { type: "noul", noul: 0 },
          security_risk: { type: "noul", noul: 0.02 },
          regretted: { type: "noul", noul: 0.1 },
          slop_stub: { type: "noul", noul: 0.02 },
          slop_comments: { type: "noul", noul: 0.02 },
          slop_dead: { type: "noul", noul: 0.02 },
          slop_hedging: { type: "noul", noul: 0.02 },
        },
      };
    },
  };
}

const fieldChars = new Map();
const addField = (map, name, chars) => count(map, name, chars);
const requestBytes = (request, map) => {
  const state = request?.state ?? {};
  if (map) {
    addField(map, "state.task", JSON.stringify(state.task ?? "").length);
    addField(map, "state.action", JSON.stringify(state.action ?? {}).length);
    addField(map, "state.context", JSON.stringify(state.context ?? []).length);
    addField(map, "state.spine", JSON.stringify(state.spine ?? null).length);
    addField(map, "state.plan", JSON.stringify(state.plan ?? null).length);
    addField(map, "state.previous_actions", JSON.stringify(state.previous_actions ?? null).length);
    addField(map, "state.rules", JSON.stringify(state.rules ?? null).length);
    addField(map, "state.floor_hits", JSON.stringify(state.floor_hits ?? null).length);
    addField(map, "questions", JSON.stringify(request?.questions ?? {}).length);
  }
  return JSON.stringify(request).length;
};
/** The acting request of a call: the one without the sampled trace-only questions, which name `off_task`. */
const mainRequest = requests => requests.find(request => request?.questions?.off_task === undefined) ?? requests[0];

/** The project's rules text, resolved once per project, for the reconstructed full request. */
const rulesCache = new Map();
function rulesFor(cwd) {
  if (!rulesCache.has(cwd)) {
    try { rulesCache.set(cwd, resolveRulesFile(cwd) ?? null); } catch { rulesCache.set(cwd, null); }
  }
  return rulesCache.get(cwd);
}

const perDay = new Map();
const beforeByTool = new Map();
const afterByTool = new Map();
const whyCounts = new Map();
const asksByReason = new Map();
const gateNanos = [];
const cacheNanos = [];
/** Median and p99 of a nanosecond sample, in microseconds. */
function percentiles(sample) {
  const sorted = [...sample].sort((a, b) => a - b);
  const at = fraction => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]) / 1000 : 0;
  return { medianUs: +at(0.5).toFixed(1), p99Us: +at(0.99).toFixed(1), calls: sorted.length };
}
let readOnly = 0;
let wouldAskBefore = 0;
let askedAfter = 0;
let fullChars = 0;
let leanChars = 0;
let samples = 0;
const cacheStats = { asks: 0, hits: 0, sampled: 0 };
const detail = [];
let measured = 0;
let sizeSamples = 0;
let fullCharsSum = 0;
let leanCharsTotal = 0;
let rulesSentAfter = 0;
let sampledRequests = 0;
let totalCharsBefore = 0;
let totalCharsAfter = 0;

/** One verdict cache per session, driven by the recorded call time so the reuse window is measured as it ran. */
const sessions = new Map();
function sessionState(id) {
  if (!sessions.has(id)) sessions.set(id, { cache: new VerdictCache(action.cacheMinutes * 60_000), clock: 0 });
  return sessions.get(id);
}
const BEFORE = { ...action, ask: { enabled: false }, cacheMinutes: 0, traceSample: 0 };

for (const call of calls) {
  const d = day(call.at);
  if (!perDay.has(d)) perDay.set(d, { calls: 0, judged: 0, readOnly: 0, askedBefore: 0, askedAfter: 0 });
  const row = perDay.get(d);
  row.calls++;
  const state = sessionState(call.session);
  state.clock = call.at.getTime();
  const input = { tool: call.tool, input: call.input, cwd: call.cwd, task: call.task, context: call.context, plan: call.plan };
  const before = [];
  const beforeVerdict = await evaluateAction(input, { config: BEFORE, judge: stubJudge(before), now: () => state.clock });
  let gateWhy;
  const after = [];
  const afterVerdict = await evaluateAction(input, { config: action, judge: stubJudge(after), cache: state.cache, now: () => state.clock, traceSample: action.traceSample });
  if (beforeVerdict.source === "read-only" || beforeVerdict.source === "skipped") { readOnly++; row.readOnly++; continue; }
  row.judged++;
  const askedBefore = before.length > 0;
  const askedNow = after.length > 0;
  if (askedBefore && measured % 10 === 0) {
    const summary = describeAction(call.tool, call.input, call.cwd);
    const rules = rulesFor(call.cwd);
    const extras = { context: call.context, plan: call.plan, rules: rules?.content, rulesSource: rules?.source, floorHits: "none", slop: true, security: true, largeOutput: true };
    const fullChars = JSON.stringify(buildRequest(summary, call.task, extras)).length;
    fullCharsSum += fullChars;
    requestBytes(buildRequest(summary, call.task, extras), fieldChars);
    sizeSamples++;
  }
  measured++;
  {
    const full = buildRequest(describeAction(call.tool, call.input, call.cwd), call.task, { context: call.context, plan: call.plan, rules: rulesFor(call.cwd)?.content, floorHits: "none", slop: true, security: true, largeOutput: true });
    totalCharsBefore += JSON.stringify(full).length;
  }
  if (askedBefore) { wouldAskBefore++; row.askedBefore++; samples++; count(beforeByTool, call.tool); }
  if (askedNow) {
    askedAfter++; row.askedAfter++; count(afterByTool, call.tool);
    const acting = mainRequest(after);
    const size = JSON.stringify(acting).length;
    leanCharsTotal += size;
    totalCharsAfter += size;
    for (const request of after) if (request !== acting) totalCharsAfter += JSON.stringify(request).length;
    if (acting?.state?.rules !== undefined) rulesSentAfter++;
  }
  sampledRequests += Math.max(0, after.length - 1);
  if (!askedNow && askedBefore) count(whyCounts, afterVerdict.notAsked ?? "unknown");
  {
    const t0 = process.hrtime.bigint();
    const view = commandOf(call.tool, call.input);
    const decision = actionAskGate(call.tool, call.input, view?.shell ? stripDataText(view.command).text : undefined, call.cwd);
    const t1 = process.hrtime.bigint();
    gateNanos.push(Number(t1 - t0));
    const t2 = process.hrtime.bigint();
    const key = cacheKey(call.cwd, call.tool, call.input);
    if (key) state.cache.get(key, state.clock);
    const t3 = process.hrtime.bigint();
    cacheNanos.push(Number(t3 - t2));
    count(asksByReason, `${decision.ask ? "ask" : "skip"}: ${decision.why}`);
    gateWhy = decision.why;
  }
  if (afterVerdict.cached) cacheStats.hits++;
  if (askedNow) cacheStats.asks++;
  if (after.length > 1) cacheStats.sampled++;
  if (out && detail.length < 40000) detail.push({ at: call.at.toISOString(), tool: call.tool, ask: askedNow, why: gateWhy, before: askedBefore, level: beforeVerdict.level, cached: afterVerdict.cached === true, beforeChars: askedBefore ? JSON.stringify(mainRequest(before)).length : 0, afterChars: askedNow ? JSON.stringify(mainRequest(after)).length : 0, call: call.tool === "bash" ? String(call.input.command ?? "").slice(0, 4000) : String(call.input.path ?? "") });
}

// --- Phase 2: which calls the agent saw Jev change, and whether the gate still asks ----------------------
let outcomes;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  outcomes = db.prepare("SELECT timestamp, project_root, tool, reasons, command_preview, held, level FROM holds WHERE timestamp >= ? AND timestamp < ?").all(since.getTime(), until.getTime());
  db.close();
} catch { outcomes = []; }

const delivered = [];
for (const row of outcomes) {
  if (!TOOLS.has(row.tool) || row.tool === "rules") continue;
  let reasons = [];
  try { reasons = JSON.parse(row.reasons ?? "[]"); } catch { reasons = []; }
  const irreversible = reasons.some(reason => /^(?:possibly )?irreversible /.test(reason));
  const intentVisible = reasons.some(reason => reason.includes("intent mismatch") && reason.includes("on a visible action"));
  if (irreversible || intentVisible) delivered.push(row);
}

/** The full command behind a holds row: the session call of the same project whose command starts with the preview. */
const byProject = new Map();
for (const call of calls) {
  const command = call.tool === "bash" ? commandOf(call.tool, call.input)?.command : undefined;
  const key = command ?? (typeof call.input.path === "string" ? call.input.path : undefined);
  if (key === undefined) continue;
  if (!byProject.has(call.cwd)) byProject.set(call.cwd, []);
  byProject.get(call.cwd).push({ tool: call.tool, text: key.replace(/\s+/g, " ").trim() });
}
const missed = [];
const perTool = new Map();
let resolvedFull = 0;
for (const row of delivered) {
  const preview = String(row.command_preview ?? "").replace(/\s+/g, " ").trim();
  const candidates = byProject.get(row.project_root) ?? [];
  const match = preview ? candidates.find(candidate => candidate.tool === row.tool && candidate.text.startsWith(preview.slice(0, 120))) : undefined;
  if (match) resolvedFull++;
  const text = match?.text ?? preview;
  const decision = row.tool === "bash"
    ? actionAskGate("bash", { command: text }, stripDataText(text).text, row.project_root)
    : { ask: true, why: row.tool };
  count(perTool, row.tool);
  if (!decision.ask) missed.push({ tool: row.tool, why: decision.why, text: text.slice(0, 300), at: new Date(row.timestamp).toISOString(), level: row.level });
}
const deliveredByTool = Object.fromEntries([...perTool].map(([tool, n]) => [tool, { delivered: n, missed: missed.filter(m => m.tool === tool).length }]));
const recall = perTool.size ? 1 - missed.length / [...perTool.values()].reduce((a, b) => a + b, 0) : 1;

// --- Phase 3: per-guard requests per day, from the trace files and the pi-typesafe ledger ----------------
const guardDays = new Map();
for (const path of walk(traceRoot)) {
  let lines;
  try { lines = readFileSync(path, "utf8").split("\n"); } catch { continue; }
  for (const line of lines) {
    if (!line.includes('"guard"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.kind !== "entry") continue;
    const at = new Date(entry.at);
    if (!inWindow(at)) continue;
    // A judged request: the trace tokens name TypeSafe as the source, or the details carry the scores it returned.
    const judged = entry.tokens?.source === "typesafe" || (entry.details ?? []).some(detail => detail.startsWith("jev:"));
    if (!judged) continue;
    if (!guardDays.has(day(at))) guardDays.set(day(at), new Map());
    count(guardDays.get(day(at)), entry.guard);
  }
}
let ledger;
try {
  const file = JSON.parse(readFileSync(usagePath(), "utf8"));
  ledger = Object.fromEntries(Object.entries(file.days ?? {}).filter(([d]) => inWindow(new Date(`${d}T12:00:00`))));
} catch { ledger = {}; }

// --- Report ----------------------------------------------------------------------------------------------
const sumBy = key => [...perDay.values()].reduce((a, row) => a + row[key], 0);
const aggregate = {
  window: { since: since.toISOString(), until: until.toISOString() },
  sessions: { calls: calls.length, readOnly, judged: sumBy("judged"), wouldAskBefore, askedAfter, requestsSaved: wouldAskBefore - askedAfter, savedShare: wouldAskBefore ? 1 - askedAfter / wouldAskBefore : 0, sampledRequests, totalAfter: askedAfter + sampledRequests },
  spend: { charsBefore: totalCharsBefore, charsAfter: totalCharsAfter, ratio: totalCharsBefore ? +(totalCharsAfter / totalCharsBefore).toFixed(3) : 0 },
  requestsByTool: { before: Object.fromEntries([...beforeByTool].sort()), after: Object.fromEntries([...afterByTool].sort()) },
  requestCharsAverage: sizeSamples ? Math.round(fullCharsSum / sizeSamples) : 0,
  requestCharsAverageLean: askedAfter ? Math.round(leanCharsTotal / askedAfter) : 0,
  rulesSentAfter,
  requestChars: Object.fromEntries([...fieldChars].map(([name, total]) => [name, { average: Math.round(total / Math.max(1, sizeSamples)), share: fullCharsSum ? +(total / fullCharsSum).toFixed(3) : 0 }])),
  cache: { asked: cacheStats.asks, hits: cacheStats.hits, hitRate: cacheStats.asks ? cacheStats.hits / cacheStats.asks : 0 },
  sampledCalls: cacheStats.sampled,
  outcomes: { delivered: delivered.length, resolvedToFullCommand: resolvedFull, byTool: deliveredByTool, missed: missed.length, recall, missedList: missed },
  askReasons: Object.fromEntries([...whyCounts].sort((a, b) => b[1] - a[1])),
  gateReasons: Object.fromEntries([...asksByReason].sort((a, b) => b[1] - a[1])),
  latency: { gate: percentiles(gateNanos), cache: percentiles(cacheNanos) },
  perDay: Object.fromEntries([...perDay].sort()),
  guardRequestsPerDay: Object.fromEntries([...guardDays].sort().map(([d, guards]) => [d, Object.fromEntries([...guards].sort((a, b) => b[1] - a[1]))])),
  ledger,
};

if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  writeFileSync(join(out, "calls.jsonl"), `${detail.map(item => JSON.stringify(item)).join("\n")}\n`);
  writeFileSync(join(out, "missed.json"), `${JSON.stringify(missed, null, 2)}\n`);
}

if (wantJson) { console.log(JSON.stringify(aggregate, null, 2)); process.exit(0); }
console.log(`action replay ${aggregate.window.since.slice(0, 10)} to ${aggregate.window.until.slice(0, 10)}`);
console.log(`${calls.length} action calls; ${readOnly} read-only (no request before or after); ${sumBy("judged")} reached the judge path`);
console.log(`requests: ${wouldAskBefore} before, ${askedAfter} after the gate (${(aggregate.sessions.savedShare * 100).toFixed(1)}% saved)`);
console.log(`request size: ${aggregate.requestCharsAverage} chars before, ${aggregate.requestCharsAverageLean} after; rules sent on ${rulesSentAfter} of ${askedAfter} acting requests`);
console.log(`request text: ${aggregate.spend.charsBefore} chars before, ${aggregate.spend.charsAfter} chars after (ratio ${aggregate.spend.ratio})`);
console.log("state and question share (before):", aggregate.requestChars);
console.log(`cache: ${cacheStats.hits}/${cacheStats.asks} hits (${(aggregate.cache.hitRate * 100).toFixed(1)}%); ${cacheStats.sampled} calls also asked the trace-only questions`);
console.log(`outcomes the agent saw: ${delivered.length}; gate asks ${delivered.length - missed.length}; recall ${(recall * 100).toFixed(2)}%`);
console.log("by tool:", deliveredByTool);
if (missed.length) console.log("missed:", JSON.stringify(missed.slice(0, 40), null, 2));
console.log("gate reasons:", aggregate.gateReasons);
console.log("added latency:", aggregate.latency);
console.log("per day:", aggregate.perDay);
console.log("guards:", aggregate.guardRequestsPerDay);
console.log("ledger:", ledger);

// --- Phase 4 (billable): the lean request against the full one on a fixed sample -------------------------
if (useJudge && sampleSize > 0) {
  const { ask } = await import("pi-typesafe");
  const { createTypeSafe } = await import("pi-typesafe");
  const judge = createTypeSafe({ maxRequests: sampleSize * 4 + 20, timeoutMs: 20000 });
  const pick = [];
  const step = Math.max(1, Math.floor(calls.length / sampleSize));
  for (let index = 0; index < calls.length && pick.length < sampleSize; index += step) {
    const call = calls[index];
    const probe = [];
    await evaluateAction({ tool: call.tool, input: call.input, cwd: call.cwd, task: call.task }, { config: { ...action, ask: { enabled: false } }, judge: stubJudge(probe), rules: undefined });
    if (probe.length) pick.push(call);
  }
  console.log(`billable comparison on ${pick.length} bash calls`);
  const rows = [];
  for (const call of pick) {
    const summary = describeAction(call.tool, call.input, call.cwd);
    const full = buildRequest(summary, call.task, { context: call.context, plan: call.plan, rules: undefined, floorHits: "none", slop: false, security: false });
    const lean = buildRequest(summary, call.task, { context: undefined, plan: call.plan, rules: undefined, floorHits: "none", slop: false, security: false, lean: true });
    const a = await ask(judge, full, { timeoutMs: 20000 });
    const b = await ask(judge, lean, { timeoutMs: 20000 });
    const t = await ask(judge, buildRequest(summary, call.task, { traceOnly: true, context: call.context, plan: call.plan, rules: undefined, floorHits: "none" }), { timeoutMs: 20000 });
    if (!a.ok || !b.ok) { console.log("request failed", a.ok ? b.error : a.error); continue; }
    const scoreOf = answer => answer.answers?.irreversible?.noul;
    rows.push({ tool: call.tool, full: scoreOf(a), lean: scoreOf(b), fullTokens: a.usage?.input_tokens, leanTokens: b.usage?.input_tokens, traceTokens: t.ok ? t.usage?.input_tokens : undefined });
  }
  const diffs = rows.filter(row => typeof row.full === "number" && typeof row.lean === "number").map(row => Math.abs(row.full - row.lean)).sort((a, b) => a - b);
  const median = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
  const tokens = rows.filter(row => row.fullTokens && row.leanTokens);
  const byTool = {};
  for (const tool of new Set(rows.map(row => row.tool))) {
    const group = rows.filter(row => row.tool === tool && row.fullTokens && row.leanTokens);
    byTool[tool] = { n: group.length, fullTokens: group.length ? Math.round(group.reduce((a, row) => a + row.fullTokens, 0) / group.length) : 0, leanTokens: group.length ? Math.round(group.reduce((a, row) => a + row.leanTokens, 0) / group.length) : 0 };
  }
  const report = {
    compared: rows.length,
    medianAbsoluteDifference: median,
    meanAbsoluteDifference: diffs.length ? +(diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(4) : 0,
    maxAbsoluteDifference: diffs.at(-1) ?? 0,
    crossedHalf: rows.filter(row => (row.full < 0.5) !== (row.lean < 0.5)).length,
    crossedPointNine: rows.filter(row => (row.full < 0.9) !== (row.lean < 0.9)).length,
    fullTokensAverage: tokens.length ? Math.round(tokens.reduce((a, row) => a + row.fullTokens, 0) / tokens.length) : 0,
    leanTokensAverage: tokens.length ? Math.round(tokens.reduce((a, row) => a + row.leanTokens, 0) / tokens.length) : 0,
    traceTokensAverage: tokens.filter(row => row.traceTokens).length ? Math.round(tokens.reduce((a, row) => a + (row.traceTokens ?? 0), 0) / tokens.filter(row => row.traceTokens).length) : 0,
    tokenRatio: tokens.length ? +((tokens.reduce((a, row) => a + row.leanTokens, 0)) / (tokens.reduce((a, row) => a + row.fullTokens, 0))).toFixed(3) : 0,
    requests: { before: wouldAskBefore, afterActing: askedAfter, afterSampled: sampledRequests },
    byTool,
    estimatedTokenRatio: tokens.length ? +(((askedAfter * (tokens.reduce((a, row) => a + row.leanTokens, 0) / tokens.length)) + (sampledRequests * (tokens.filter(row => row.traceTokens).reduce((a, row) => a + (row.traceTokens ?? 0), 0) / Math.max(1, tokens.filter(row => row.traceTokens).length)))) / (wouldAskBefore * (tokens.reduce((a, row) => a + row.fullTokens, 0) / tokens.length))).toFixed(3) : 0,
  };
  if (out) writeFileSync(join(out, "lean-compare.json"), `${JSON.stringify({ report, rows }, null, 2)}\n`);
  console.log("lean comparison:", report);
}
