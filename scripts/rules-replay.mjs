#!/usr/bin/env node
/**
 * Rules replay: judge the write and edit calls of past Pi sessions against a project's current rules.
 *
 * Finds the sessions whose working directory is the project, rebuilds each file's content before every call from the
 * session log, and judges each rebuilt call with `evaluateRules` in the request the guard builds. The output is a
 * review sheet for an independent labeler (every flagged call plus a fixed-seed sample of unflagged calls) and
 * aggregate counts.
 *
 * Privacy: the review sheet carries file paths, code excerpts, and scores, so it is written to `--out` only and must
 * never be committed. The default `--out` is a fresh directory under the system temp dir, outside the repository, and
 * is printed. `aggregates.json` holds counts only (no paths, no excerpts) and is the only output that belongs in
 * `eval/reports/`. Session content from any project must stay out of commits.
 *
 * Usage:
 *   node scripts/rules-replay.mjs --project <dir> [--since DATE] [--max N] [--budget N] [--out DIR] [--dry-run]
 *   node scripts/rules-replay.mjs --score <sheet>
 *
 * Options:
 *   --project DIR   Project whose sessions are replayed (required).
 *   --since DATE    Only sessions that started at or after this date.
 *   --max N         Replay at most N calls, oldest first.
 *   --budget N      Hard cap on judged requests, passed to the judge as maxRequests (default 20).
 *   --out DIR       Output directory (default: a fresh directory under the system temp dir).
 *   --dry-run       Count calls and classify them locally; write nothing and send nothing.
 *   --score SHEET   Read a labelled review sheet and print precision and the estimated miss rate.
 *
 * Environment:
 *   PI_SESSIONS_DIR  Session logs (default: ~/.pi/agent/sessions).
 *
 * Build first (npm run build): the CLI runs the rules guard from dist/. Every judged call is one billable request.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `node scripts/rules-replay.mjs --project <dir> [--since DATE] [--max N] [--budget N] [--out DIR] [--dry-run]
       node scripts/rules-replay.mjs --score <sheet>`;

/** Fixed seed for the unflagged sample, so a re-run over the same log picks the same items. */
export const SAMPLE_SEED = 20260928;
/** Per-request deadline; one request judges one call. */
const TIMEOUT_MS = 20_000;
/** Excerpt size per review item: enough to judge, too little to reproduce a file. */
const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 240;

export function parseArgs(argv) {
  const opts = { project: undefined, since: undefined, max: undefined, budget: 20, out: undefined, dryRun: false, score: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    const int = () => {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${arg} must be a positive integer`);
      return parsed;
    };
    if (arg === "--project") opts.project = value();
    else if (arg === "--since") opts.since = value();
    else if (arg === "--max") opts.max = int();
    else if (arg === "--budget") opts.budget = int();
    else if (arg === "--out") opts.out = value();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--score") opts.score = value();
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (opts.score) return opts;
  if (!opts.project) throw new Error(`--project is required\n${USAGE}`);
  if (opts.since !== undefined && Number.isNaN(new Date(opts.since).getTime())) throw new Error(`--since must be a date`);
  return opts;
}

function* jsonlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

/** The sessions whose working directory is the project, oldest first. */
function loadSessions(sessionsDir, projectDir) {
  const sessions = [];
  for (const file of jsonlFiles(sessionsDir)) {
    const events = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* one torn line is not a lost session */ }
    }
    const head = events.find(event => event.type === "session" && typeof event.cwd === "string");
    if (!head || resolve(head.cwd) !== projectDir) continue;
    sessions.push({ file, start: typeof head.timestamp === "string" ? head.timestamp : "", events });
  }
  sessions.sort((a, b) => (a.start === b.start ? (a.file < b.file ? -1 : 1) : a.start < b.start ? -1 : 1));
  return sessions;
}

const occurrences = (text, needle) => text.split(needle).length - 1;

/**
 * The edits one call carries: the `edits` array the tool takes, or the single oldText/newText pair older logs record.
 * The entries are the raw strings; the judge input is rebuilt from them below.
 */
function editList(input) {
  if (Array.isArray(input.edits)) return input.edits.map(item => ({ oldText: typeof item?.oldText === "string" ? item.oldText : "", newText: typeof item?.newText === "string" ? item.newText : "" }));
  if (typeof input.oldText === "string") return [{ oldText: input.oldText, newText: typeof input.newText === "string" ? input.newText : "" }];
  return undefined;
}

/**
 * The file content before one call, when the log allows rebuilding it. A write carries its own content. An edit needs
 * the content tracked from earlier calls: every oldText must appear exactly once in the original, as the edit tool
 * requires, and the edits must not overlap. When the rebuild fails the call is marked and skipped, and the file's
 * content becomes unknown until a later write restores it. `ok` is the call's tool result: a failed call left the file
 * as it was.
 */
function rebuildCall(lib, files, projectDir, part, ok) {
  const tool = part.name;
  const input = (part.arguments ?? {});
  const call = { tool, input, ok, rel: undefined, rebuilt: false, reason: undefined, before: undefined };
  const rel = typeof input.path === "string" ? lib.projectPath(input.path, projectDir) : undefined;
  if (!rel) {
    call.reason = "outside the project";
    return call;
  }
  call.rel = rel;
  if (tool === "write") {
    if (typeof input.content !== "string") {
      call.reason = "write without content";
      if (ok) files.set(rel, undefined);
      return call;
    }
    call.rebuilt = true;
    if (ok) files.set(rel, input.content);
    return call;
  }
  const edits = editList(input);
  const before = files.get(rel);
  if (!edits) {
    call.reason = "edit without edits";
    if (ok) files.set(rel, undefined);
    return call;
  }
  if (typeof before !== "string") {
    call.reason = "content before the call unknown";
    return call;
  }
  const spans = [];
  for (const edit of edits) {
    if (!edit.oldText) {
      call.reason = "empty old text";
      break;
    }
    if (occurrences(before, edit.oldText) !== 1) {
      call.reason = "old text not found or not unique";
      break;
    }
    const at = before.indexOf(edit.oldText);
    if (spans.some(([from, to]) => at < to && from < at + edit.oldText.length)) {
      call.reason = "edits overlap";
      break;
    }
    spans.push([at, at + edit.oldText.length, edit.newText]);
  }
  if (call.reason) {
    if (ok) files.set(rel, undefined);
    return call;
  }
  let after = before;
  for (const [from, to, newText] of spans.slice().sort((a, b) => b[0] - a[0])) after = after.slice(0, from) + newText + after.slice(to);
  call.rebuilt = true;
  call.before = before;
  if (ok) files.set(rel, after);
  return call;
}

/** Every write and edit call in session order, with the rebuild state above. */
function replayCalls(lib, sessions, projectDir) {
  const files = new Map();
  const calls = [];
  for (const session of sessions) {
    const failed = new Set();
    for (const event of session.events) {
      const message = event.message;
      if (message?.role === "toolResult" && message.isError === true && typeof message.toolCallId === "string") failed.add(message.toolCallId);
    }
    for (const event of session.events) {
      const message = event.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type !== "toolCall" || (part.name !== "write" && part.name !== "edit")) continue;
        calls.push(rebuildCall(lib, files, projectDir, part, !failed.has(part.id)));
      }
    }
  }
  return calls;
}

/** The tool input as the guard sees it: the project-relative path the mirror holds the content in. */
function judgeInput(call) {
  if (call.tool === "write") return { path: call.rel, content: call.input.content };
  const edits = Array.isArray(call.input.edits) ? call.input.edits.map(item => ({ oldText: typeof item?.oldText === "string" ? item.oldText : "", newText: typeof item?.newText === "string" ? item.newText : "" })) : undefined;
  return edits ? { path: call.rel, edits } : { path: call.rel };
}

/** A short redacted sample of what the call writes, enough for a labeler to judge, too little to reproduce a file. */
function excerptOf(lib, call, verdict) {
  let text;
  if (call.tool === "write") text = call.input.content;
  else {
    const edits = Array.isArray(call.input.edits) ? call.input.edits : [{ newText: call.input.newText }];
    const index = verdict?.editId ? Number(verdict.editId.replace("edit_", "")) - 1 : 0;
    text = edits[index]?.newText ?? edits[0]?.newText ?? "";
  }
  const lines = String(text ?? "").trim().split("\n").slice(0, EXCERPT_LINES).join("\n");
  return lib.redact(lines.length > EXCERPT_CHARS ? `${lines.slice(0, EXCERPT_CHARS)}` : lines);
}

function reviewItem(lib, call, verdict, n) {
  const top = verdict.findings[0];
  const best = top ?? (verdict.scores ?? []).reduce((winner, score) => (winner === undefined || score.violation > winner.violation ? score : winner), undefined);
  return {
    n,
    kind: verdict.findings.length ? "flagged" : "unflagged",
    tool: call.tool,
    file: call.rel,
    rule: best?.id ?? "",
    score: best?.violation ?? 0,
    excerpt: excerptOf(lib, call, verdict),
    label: "",
    ...(verdict.findings.length > 1 ? { alsoRules: verdict.findings.slice(1).map(finding => finding.id) } : {}),
  };
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed-seed sample of `items`, `n` of them, without replacement. */
export function sample(items, n, seed = SAMPLE_SEED) {
  const pool = items.slice();
  const rand = mulberry32(seed);
  const picked = [];
  for (let i = 0; i < n && pool.length; i++) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return picked;
}

const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const sorted = (map) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

const LABELS = ["real", "false-alarm", "unsure"];

function tally(items) {
  const counts = { real: 0, "false-alarm": 0, unsure: 0, unlabelled: 0 };
  for (const item of items) {
    const label = item.label === "" || item.label === undefined ? "unlabelled" : item.label;
    if (!(label in counts)) throw new Error(`unknown label ${JSON.stringify(item.label)}`);
    counts[label]++;
  }
  return counts;
}

const rate = (hits, decided) => (decided ? hits / decided : 0);

/**
 * What a labelled sheet says: precision over the flagged items (the labeler confirms or denies each flag) and the miss
 * rate over the unflagged sample (a `real` there is a violation the guard did not flag).
 */
export function scoreSheet(sheet) {
  const flagged = sheet.items.filter(item => item.kind === "flagged");
  const unflagged = sheet.items.filter(item => item.kind === "unflagged");
  const flags = tally(flagged);
  const misses = tally(unflagged);
  return {
    flagged: { items: flagged.length, ...flags, decided: flags.real + flags["false-alarm"], precision: rate(flags.real, flags.real + flags["false-alarm"]) },
    unflagged: { items: unflagged.length, ...misses, decided: misses.real + misses["false-alarm"], missRate: rate(misses.real, misses.real + misses["false-alarm"]) },
  };
}

function printScore(scored, log) {
  const { flagged, unflagged } = scored;
  log(`flagged items: ${flagged.items} (${flagged.real} real, ${flagged["false-alarm"]} false-alarm, ${flagged.unsure} unsure, ${flagged.unlabelled} unlabelled); precision ${flagged.precision.toFixed(3)} over ${flagged.decided} decided`);
  log(`unflagged sample: ${unflagged.items} (${unflagged.real} missed, ${unflagged["false-alarm"]} clean, ${unflagged.unsure} unsure, ${unflagged.unlabelled} unlabelled); estimated miss rate ${unflagged.missRate.toFixed(3)} over ${unflagged.decided} decided`);
}

/**
 * The replay. `deps` carries pi-warden's API and a judge factory, so an offline test can drive it with a stub judge;
 * the CLI wires it to dist/ and pi-typesafe. Returns the aggregates and the review sheet, or the score for --score.
 */
export async function main(argv, deps) {
  const log = deps.log ?? console.log;
  const opts = parseArgs(argv);

  if (opts.score) {
    const scored = scoreSheet(JSON.parse(readFileSync(opts.score, "utf8")));
    printScore(scored, log);
    return { scored };
  }

  const lib = deps.lib;
  const sessionsDir = deps.sessionsDir ?? process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");
  const projectDir = resolve(opts.project);
  const config = lib.defaultConfig();
  const set = new lib.RuleStore().load(projectDir, config.rules);
  if (!set) throw new Error(`no rules file resolved in the project at ${projectDir}`);

  const since = opts.since === undefined ? undefined : new Date(opts.since);
  const sessions = loadSessions(sessionsDir, projectDir).filter(session => since === undefined || new Date(session.start) >= since);
  const all = replayCalls(lib, sessions, projectDir);
  const calls = opts.max === undefined ? all : all.slice(0, opts.max);

  const judge = opts.dryRun ? undefined : deps.createJudge({ maxRequests: opts.budget, timeoutMs: TIMEOUT_MS });
  const mirror = mkdtempSync(join(tmpdir(), "rules-replay-mirror-"));
  const unrebuiltReasons = new Map();
  const skippedReasons = new Map();
  const flaggedPerRule = new Map();
  const flaggedItems = [];
  const unflaggedItems = [];
  const counts = { rebuilt: 0, unrebuilt: 0, outside: 0, skipped: 0, judged: 0, flagged: 0, errors: 0, budgetSkipped: 0 };
  let spent = 0;
  let planned = 0;
  const started = performance.now();
  try {
    for (const [index, call] of calls.entries()) {
      if (call.reason === "outside the project") {
        counts.outside++;
        continue;
      }
      if (!call.rebuilt) {
        counts.unrebuilt++;
        count(unrebuiltReasons, call.reason);
        continue;
      }
      counts.rebuilt++;
      // The mirror holds the file as it stood before the call, so the guard builds its before/after context from it.
      if (call.tool === "edit") {
        mkdirSync(dirname(join(mirror, call.rel)), { recursive: true });
        writeFileSync(join(mirror, call.rel), call.before);
      }
      const input = judgeInput(call);
      const reason = lib.skipReason(lib.describeTarget(call.tool, input, mirror), set, config.rules);
      if (reason) {
        counts.skipped++;
        count(skippedReasons, reason);
        continue;
      }
      if (spent + planned >= opts.budget) {
        counts.budgetSkipped++;
        continue;
      }
      if (opts.dryRun) {
        planned++;
        continue;
      }
      spent++;
      const verdict = await lib.evaluateRules(call.tool, input, { cwd: mirror, config: config.rules, set, judge, timeoutMs: TIMEOUT_MS });
      if (verdict.source === "skipped") {
        counts.skipped++;
        count(skippedReasons, verdict.skippedReason ?? "skipped");
        continue;
      }
      if (verdict.source !== "typesafe") {
        counts.errors++;
        continue;
      }
      counts.judged++;
      const item = reviewItem(lib, call, verdict, index + 1);
      if (verdict.findings.length) {
        counts.flagged++;
        for (const finding of verdict.findings) count(flaggedPerRule, finding.id);
        flaggedItems.push(item);
      } else {
        unflaggedItems.push(item);
      }
    }
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
  const wallMs = Math.round(performance.now() - started);

  const aggregates = {
    date: new Date().toISOString().slice(0, 10),
    project: basename(projectDir),
    sessions: sessions.length,
    calls: { found: all.length, selected: calls.length, ...counts },
    unrebuiltReasons: sorted(unrebuiltReasons),
    skippedReasons: sorted(skippedReasons),
    flaggedPerRule: sorted(flaggedPerRule),
    requests: { budget: opts.budget, spent, ...(planned ? { planned } : {}) },
    labels: "unlabelled",
    ...(judge?.getUsage ? { usage: judge.getUsage() } : {}),
    wallMs,
  };
  const sheet = {
    generated: new Date().toISOString(),
    seed: SAMPLE_SEED,
    labels: { real: "a real violation", "false-alarm": "no violation here", unsure: "cannot tell" },
    items: [...flaggedItems, ...sample(unflaggedItems, flaggedItems.length)].sort((a, b) => a.n - b.n),
  };

  log(`sessions: ${sessions.length}; calls found ${all.length}${opts.max === undefined ? "" : `, first ${calls.length} replayed`}`);
  log(`rebuilt ${counts.rebuilt}, unrebuilt ${counts.unrebuilt}${unrebuiltReasons.size ? ` (${[...unrebuiltReasons].map(([reason, n]) => `${reason} ${n}`).join(", ")})` : ""}, outside the project ${counts.outside}`);
  log(`judged ${counts.judged}, flagged ${counts.flagged}, skipped ${counts.skipped}${skippedReasons.size ? ` (${[...skippedReasons].map(([reason, n]) => `${reason} ${n}`).join(", ")})` : ""}, past the budget ${counts.budgetSkipped}, judge errors ${counts.errors}`);
  if (flaggedPerRule.size) log(`flagged per rule: ${JSON.stringify(sorted(flaggedPerRule))}`);

  if (opts.dryRun) {
    log(`dry run: ${planned} requests would be sent (budget ${opts.budget}), 0 sent, nothing written`);
    return { aggregates, sheet };
  }

  const out = opts.out ?? mkdtempSync(join(tmpdir(), "rules-replay-"));
  mkdirSync(out, { recursive: true });
  const aggregatesFile = join(out, "aggregates.json");
  if (existsSync(aggregatesFile)) throw new Error(`${aggregatesFile} exists; choose another --out or move it`);
  writeFileSync(aggregatesFile, `${JSON.stringify(aggregates, null, 1)}\n`);
  writeFileSync(join(out, "review-sheet.json"), `${JSON.stringify(sheet, null, 1)}\n`);
  log(`requests: ${spent} sent of ${opts.budget} budget${judge?.getUsage ? ` (${judge.getUsage().requestsStarted} started)` : ""}`);
  log(`review sheet: ${join(out, "review-sheet.json")} (${flaggedItems.length} flagged, ${sheet.items.length - flaggedItems.length} sampled unflagged; labels unlabelled)`);
  log(`aggregates: ${aggregatesFile}`);
  log(`output directory: ${out}`);
  return { aggregates, sheet, out };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const lib = await import("../dist/index.js");
    const { createTypeSafe } = await import("pi-typesafe");
    await main(process.argv.slice(2), { lib, createJudge: (options) => createTypeSafe(options) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
