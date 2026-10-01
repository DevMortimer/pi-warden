#!/usr/bin/env node
/**
 * Stale-result replay: what replacing out-of-date tool results with stubs would have saved on recorded Pi sessions.
 * Offline: reads session files on this machine and sends nothing. Prints aggregate numbers only.
 *
 * Each recorded model call is rebuilt with its context (compactions applied), the real stale-results module runs on it,
 * and the context is priced two ways: Anthropic-style (cache write 1.25x, cache read 0.1x of input) and DeepSeek
 * (the deepseek-flash entry of Pi's model catalog: input 0.3, cache read 0.006, no separate write price, so a miss costs
 * the input price). Every growth of the stub set is charged as a rewrite of the context from the first changed message.
 * Class "edited" is also charged the worst case: one full re-read of the file for every stubbed read.
 *
 * Run: npm run build && node scripts/stale-replay.mjs --dir SESSIONS_DIR [--since 2026-09-16] [--latency]
 * The folder comes from --dir or PI_SESSIONS_DIR; there is no default.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StaleResults, cacheIsCold, CHARS_PER_TOKEN } from "../dist/stale-results.js";

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined; };
const root = value("dir") ?? process.env.PI_SESSIONS_DIR;
if (!root) { console.error("Give the session folder with --dir or PI_SESSIONS_DIR."); process.exit(2); }
const since = value("since") ?? "2026-09-16";
const PRICES = {
  anthropic: { read: 0.1, write: 1.25 },
  deepseek: { read: 0.006 / 0.3, write: 1 },
};
// Pi's catalog gives a cache lifetime (300 s short retention) to the anthropic provider only; a bridge or a disk cache has none.
const ttlOf = call => call.provider === "anthropic" ? 300_000 : undefined;
// --grow cold (default): the stub set grows at a cold point only. run: at every run start. any: at every call. The last two
// show what the cache rule costs; both are charged the rewrite.
const grow = value("grow") ?? "cold";
const coldOf = call => call.afterCompaction
  || (grow === "any")
  || (grow === "run" && call.runStart)
  || (call.runStart && cacheIsCold({ now: call.at, lastTouch: call.lastTouch, ttlMs: ttlOf(call) }));
const CLASSES = [["superseded"], ["replaced"], ["edited"], ["superseded", "replaced", "edited"]];
const NAMES = ["superseded (a)", "replaced (b)", "edited (c)", "all three"];

const lenOfContent = content => {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text") n += (part.text ?? "").length;
    else if (part.type === "toolCall") n += JSON.stringify(part.arguments ?? {}).length + (part.name ?? "").length;
    else if (part.type === "thinking") n += (part.thinking ?? "").length;
  }
  return n;
};
const lenOf = message => lenOfContent(message.content);

/** The calls of one session: the messages in context before each model call, with run-start and compaction flags. */
function load(path) {
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { /* torn line */ } }
  const header = entries[0];
  if (!header || header.type !== "session" || String(header.timestamp) < since) return undefined;
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]));
  const branch = [];
  for (let e = entries[entries.length - 1]; e; e = e.parentId ? byId.get(e.parentId) : undefined) branch.push(e);
  branch.reverse();
  const calls = [];
  let context = [];
  let afterCompaction = true;
  let lastTouch;
  const touch = e => { const t = Date.parse(e.timestamp); if (Number.isFinite(t)) lastTouch = t; };
  for (const e of branch) {
    if (e.type === "compaction") {
      const at = context.findIndex(item => item.id === e.firstKeptEntryId);
      context = [{ id: e.id, message: { role: "user", content: [{ type: "text", text: e.summary ?? "" }] } }, ...(at >= 0 ? context.slice(at) : [])];
      afterCompaction = true;
    } else if (e.type === "custom_message") {
      context.push({ id: e.id, message: { role: "user", content: typeof e.content === "string" ? [{ type: "text", text: e.content }] : e.content } });
    } else if (e.type === "usage" && e.kind === "cache_warm") touch(e);
    else if (e.type === "message" && e.message) {
      const m = e.message;
      if (m.role === "assistant") {
        const last = context[context.length - 1]?.message;
        const runStart = !last || last.role === "user";
        const usage = m.usage ?? {};
        calls.push({ provider: m.provider ?? "", model: `${m.provider ?? ""}/${m.model ?? ""}`, messages: context.map(item => item.message), runStart, afterCompaction, lastTouch, at: Date.parse(e.timestamp), usage: { input: usage.input ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 } });
        afterCompaction = false;
        touch(e);
      }
      context.push({ id: e.id, message: m });
    }
  }
  return { cwd: header.cwd, calls, branch };
}

const quantile = (values, q) => { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Replay one class set over a session; returns tokens and costs under both price models. */
function replay(session, classes) {
  const stale = new StaleResults({ cwd: session.cwd, classes });
  const out = { stubbed: 0, tokensRemoved: 0, points: 0, base: { anthropic: 0, deepseek: 0 }, net: { anthropic: 0, deepseek: 0 }, reread: { anthropic: 0, deepseek: 0 }, coldPoints: 0 };
  let prevBase = 0;
  let prevScenario = 0;
  let prevPrefixSizes = [];
  for (const call of session.calls) {
    const cold = coldOf(call);
    const sizes = call.messages.map(m => Math.ceil(lenOf(m) / CHARS_PER_TOKEN));
    const outcome = stale.apply(call.messages, cold);
    const scenarioSizes = outcome.messages ? outcome.messages.map(m => Math.ceil(lenOf(m) / CHARS_PER_TOKEN)) : sizes;
    const base = sizes.reduce((a, b) => a + b, 0);
    const scenario = scenarioSizes.reduce((a, b) => a + b, 0);
    let cachedBase = call.afterCompaction ? 0 : prevBase;
    let cachedScenario = call.afterCompaction ? 0 : prevScenario;
    if (outcome.grew) {
      out.points++;
      if (cold) out.coldPoints++;
      out.stubbed += outcome.grew.stubbed;
      // Worst case for class (c): every read stubbed as edited is read again once, at the write price.
      for (const item of outcome.grew.items) if (item.reason === "edited") for (const model of Object.keys(PRICES)) out.reread[model] += Math.ceil(item.chars / CHARS_PER_TOKEN) * PRICES[model].write;
      let first = scenarioSizes.length;
      for (let i = 0; i < scenarioSizes.length; i++) if (scenarioSizes[i] !== sizes[i]) { first = i; break; }
      // Everything from the first changed message on is written again; the prefix before it stays cached.
      cachedScenario = Math.min(cachedScenario, scenarioSizes.slice(0, first).reduce((a, b) => a + b, 0));
    }
    out.tokensRemoved += base - scenario;
    for (const model of Object.keys(PRICES)) {
      const p = PRICES[model];
      const b = Math.min(cachedBase, base) * p.read + (base - Math.min(cachedBase, base)) * p.write;
      const s = Math.min(cachedScenario, scenario) * p.read + (scenario - Math.min(cachedScenario, scenario)) * p.write;
      out.base[model] += b;
      out.net[model] += b - s;
    }
    prevBase = base;
    prevScenario = scenario;
  }
  return out;
}

/** How the recorded agent behaved around edits: re-reads after an edit, and edits that failed on stale text. */
function editBehaviour(session) {
  const calls = new Map();
  const timeline = [];
  for (const e of session.branch) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "assistant" && Array.isArray(m.content)) for (const part of m.content) if (part?.type === "toolCall") calls.set(part.id, part);
    if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId);
      const path = call?.arguments?.path;
      if (!call || typeof path !== "string" || !["read", "edit", "write"].includes(call.name)) continue;
      const text = Array.isArray(m.content) ? m.content.filter(p => p?.type === "text").map(p => p.text).join("") : String(m.content ?? "");
      timeline.push({ tool: call.name, path, failed: m.isError === true, notFound: m.isError === true && /could not find|not found|did not match|no match|does not match/i.test(text) });
    }
  }
  const r = { edits: 0, reread: 0, failedEdits: 0, notFoundAfterStaleRead: 0 };
  timeline.forEach((item, i) => {
    if (item.tool === "edit" && !item.failed) { r.edits++; if (timeline.slice(i + 1).some(x => x.tool === "read" && x.path === item.path)) r.reread++; }
    if (item.tool === "edit" && item.failed) {
      r.failedEdits++;
      if (!item.notFound) return;
      let lastEdit = -1;
      for (let j = i - 1; j >= 0; j--) if (timeline[j].path === item.path && timeline[j].tool === "edit" && !timeline[j].failed) { lastEdit = j; break; }
      if (lastEdit < 0) return;
      const readBefore = timeline.slice(0, lastEdit).some(x => x.tool === "read" && x.path === item.path);
      const readBetween = timeline.slice(lastEdit + 1, i).some(x => x.tool === "read" && x.path === item.path);
      if (readBefore && !readBetween) r.notFoundAfterStaleRead++;
    }
  });
  return r;
}

const files = [];
const walk = dir => { for (const d of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, d.name); if (d.isDirectory()) walk(p); else if (d.name.endsWith(".jsonl")) files.push(p); } };
walk(root);

if (args.includes("--latency")) {
  // The longest recorded session: time of one `apply` per model call.
  let longest;
  for (const f of files) { const s = load(f); if (s && (!longest || s.calls.length > longest.calls.length)) longest = s; }
  const stale = new StaleResults({ cwd: longest.cwd });
  const times = [];
  for (const call of longest.calls) {
    const cold = coldOf(call);
    const t0 = performance.now();
    stale.apply(call.messages, cold);
    times.push(performance.now() - t0);
  }
  console.log(JSON.stringify({ calls: longest.calls.length, maxMessages: Math.max(...longest.calls.map(c => c.messages.length)), p50ms: +quantile(times, 0.5).toFixed(2), p90ms: +quantile(times, 0.9).toFixed(2), maxMs: +Math.max(...times).toFixed(2) }));
  process.exit(0);
}

if (args.includes("--cold")) {
  // Run starts by gap since the cache was last touched and model family: share whose first call read little from the cache.
  const family = model => /claude|opus|fable|sonnet|haiku/i.test(model) ? "anthropic-family" : /deepseek/i.test(model) ? "deepseek" : "other";
  const edges = [60e3, 300e3, 600e3, 1800e3, 3600e3, Infinity];
  const label = ["<1m", "1-5m", "5-10m", "10-30m", "30-60m", ">60m"];
  const table = {};
  for (const f of files) {
    const s = load(f);
    if (!s) continue;
    s.calls.forEach((call, i) => {
      if (!call.runStart || call.afterCompaction || i === 0 || call.lastTouch === undefined) return;
      const before = s.calls[i - 1].usage;
      const prompt = before.input + before.cacheRead + before.cacheWrite;
      if (prompt < 2000) return;
      const gap = call.at - call.lastTouch;
      const bucket = edges.findIndex(e => gap <= e);
      const row = (table[family(call.model)] ??= label.map(() => [0, 0]))[bucket];
      row[0]++; if (call.usage.cacheRead < 0.5 * prompt) row[1]++;
    });
  }
  for (const [name, rows] of Object.entries(table)) console.log(name, rows.map((r, i) => `${label[i]}: ${r[1]}/${r[0]}`).join("  "));
  process.exit(0);
}

const per = CLASSES.map(() => []);
let withPoint = 0;
const behaviour = { sessions: 0, edits: 0, reread: 0, failedEdits: 0, notFoundAfterStaleRead: 0 };
const cold = { starts: 0, predictedCold: 0, truthCold: 0, both: 0 };
let sessions = 0;
let callsTotal = 0;
for (const f of files) {
  let session;
  try { session = load(f); } catch { continue; }
  if (!session || session.calls.length < 2) continue;
  sessions++;
  callsTotal += session.calls.length;
  const b = editBehaviour(session);
  behaviour.sessions++;
  for (const k of ["edits", "reread", "failedEdits", "notFoundAfterStaleRead"]) behaviour[k] += b[k];
  // Cold-signal check: a run start predicted cold against a first call that read little of the earlier prompt from cache.
  const caching = session.calls.some(c => c.usage.cacheRead > 0);
  if (caching) session.calls.forEach((call, i) => {
    if (!call.runStart || call.afterCompaction || i === 0) return;
    const before = session.calls[i - 1].usage;
    const prompt = before.input + before.cacheRead + before.cacheWrite;
    if (prompt < 2000) return;
    const predicted = cacheIsCold({ now: call.at, lastTouch: call.lastTouch, ttlMs: ttlOf(call) });
    const truth = call.usage.cacheRead < 0.5 * prompt;
    cold.starts++; if (predicted) cold.predictedCold++; if (truth) cold.truthCold++; if (predicted && truth) cold.both++;
  });
  CLASSES.forEach((classes, i) => {
    const r = replay(session, classes);
    const row = { stubbed: r.stubbed, tokens: r.tokensRemoved, points: r.points };
    for (const model of Object.keys(PRICES)) {
      const net = r.net[model] - r.reread[model];
      row[model] = { gain: net, pct: r.base[model] ? 100 * net / r.base[model] : 0, pctNoReread: r.base[model] ? 100 * r.net[model] / r.base[model] : 0 };
    }
    per[i].push(row);
    if (i === 3 && r.points) withPoint++;
  });
}

console.log(JSON.stringify({ grow, since, sessions, sessionsWithGrowthPoint: withPoint, calls: callsTotal, behaviour, coldSignal: cold }, null, 1));
const fmt = n => n.toFixed(2);
console.log("| class | model | median saving % | p10 | p90 | sessions losing >1% | median stubbed | p90 stubbed | median tokens removed | p90 tokens removed | sessions with a growth point | their median saving % | gate |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
CLASSES.forEach((classes, i) => {
  const rows = per[i];
  const stubbed = rows.map(r => r.stubbed);
  const tokens = rows.map(r => r.tokens);
  const gate = {};
  for (const model of Object.keys(PRICES)) {
    const pct = rows.map(r => r[model].pct);
    const losing = pct.filter(p => p < -1).length / rows.length;
    gate[model] = quantile(pct, 0.5) > 0 && losing <= 0.1;
    console.log(`| ${NAMES[i]} | ${model} | ${fmt(quantile(pct, 0.5))} | ${fmt(quantile(pct, 0.1))} | ${fmt(quantile(pct, 0.9))} | ${(100 * losing).toFixed(1)}% | ${quantile(stubbed, 0.5)} | ${quantile(stubbed, 0.9)} | ${quantile(tokens, 0.5)} | ${quantile(tokens, 0.9)} | ${rows.filter(r => r.points).length} | ${fmt(quantile(rows.filter(r => r.points).map(r => r[model].pct), 0.5))} | ${gate[model] ? "pass" : "fail"} |`);
  }
  console.log(`| ${NAMES[i]} | both | | | | | | | | | | | ${gate.anthropic && gate.deepseek ? "PASS" : "FAIL"} |`);
});
