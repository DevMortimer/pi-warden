#!/usr/bin/env node
/**
 * Steer ask probe: measures the proposed `should_ask` question (scripts/action-candidates.mjs) on the blind
 * labels that scripts/steer-calibration.mjs collected, one billable request per labelled call. The shipped
 * `should_proceed` wording rides the same request, so both questions see the same state and the comparison is
 * side by side against the same labels.
 *
 * IMPORTANT: this script makes real TypeSafe API requests and costs money (one request per labelled call).
 * Run it on purpose. `--dry-run` prints the count; a run needs `--yes`, and `--limit N` caps the run for a
 * smoke test. Output is owner-only under --dir and never committed; the repository gets aggregate numbers.
 *
 * Usage:
 *   PI_WARDEN_DB=/path/to/holds-copy.db node scripts/steer-ask-probe.mjs --dir DIR --dry-run
 *   PI_WARDEN_DB=/path/to/holds-copy.db node scripts/steer-ask-probe.mjs --dir DIR --yes [--limit N]
 *   node scripts/steer-ask-probe.mjs --dir DIR --score            # metrics from a finished probe.jsonl
 *
 * The state each request sees is the guard's own request shape (buildRequest): redacted and bounded task,
 * plan, context and action, plus the two questions. Answers land in DIR/probe.jsonl keyed by the blinded id.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ask, createTypeSafe } from "pi-typesafe";
import { candidates } from "./action-candidates.mjs";
import { buildRequest } from "../dist/guard.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const dir = resolve(value("dir", ""));
const dbPath = process.env.PI_WARDEN_DB ?? join(homedir(), ".pi", "agent", "pi-warden", "holds.db");
const timeoutMs = Number(value("timeout", 20000));

// ---------------------------------------------------------------------------
// Labels and keys

function loadSample() {
  const keys = readFileSync(join(dir, "keys.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const labels = new Map();
  for (const line of readFileSync(join(dir, "blinded-labels.txt"), "utf8").split("\n")) {
    const match = /^c(\d+)\s+o=([01?])\s+s=([01?])/.exec(line.trim());
    if (match) labels.set(`c${match[1]}`, { o: match[2], s: match[3] });
  }
  return keys.filter((key) => labels.has(key.id)).map((key) => ({ ...key, label: labels.get(key.id) }));
}

/** The same request the action guard sends, so the probe's answers mean what production answers mean. */
function requestFor(row) {
  const context = String(row.context ?? "").split("\n").map((line) => {
    const match = /^(user|assistant):\s?(.*)$/.exec(line);
    return match ? { role: match[1], text: match[2] } : { role: "assistant", text: line };
  }).filter((message) => message.text.trim());
  const summary = { tool: row.tool, ...(row.tool === "bash" ? { command: row.action } : { path: row.action }) };
  return buildRequest(summary, row.task, {
    context: context.slice(-8),
    plan: row.plan || undefined,
    questions: { should_ask: candidates.should_ask },
    largeOutput: false,
  });
}

// ---------------------------------------------------------------------------

async function probe(sample) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  const placeholders = sample.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, tool, task, plan, context_summary, command_preview FROM holds WHERE id IN (${placeholders})`).all(...sample.map((entry) => entry.holdId));
  db.close();
  const rowById = new Map(rows.map((row) => [Number(row.id), row]));

  const judge = createTypeSafe({ maxRequests: sample.length + 10, timeoutMs });
  const out = [];
  let failed = 0;
  let firstError = "";
  let cursor = 0;
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= sample.length) return;
      const entry = sample[index];
      const row = rowById.get(entry.holdId);
      const result = await ask(judge, requestFor({
        tool: row.tool,
        task: row.task,
        plan: row.plan,
        context: row.context_summary,
        action: row.command_preview,
      }), { timeoutMs });
      if (!result.ok) { failed++; firstError ||= result.error ?? "unknown error"; continue; }
      out.push({
        id: entry.id,
        label: entry.label.s,
        shouldAsk: result.answers.should_ask.noul,
        shouldProceed: result.answers.should_proceed.noul,
      });
    }
  });
  await Promise.all(workers);
  out.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(dir, "probe.jsonl"), `${out.map((line) => JSON.stringify(line)).join("\n")}\n`);
  console.log(`probed ${out.length} calls (${failed} failed requests${firstError ? `: ${firstError}` : ""}) · model answers in ${resolve(dir, "probe.jsonl")}`);
}

// ---------------------------------------------------------------------------

/** Mann-Whitney AUC with ties counted at one half; undefined when a class is empty. */
function auc(positives, negatives) {
  if (!positives.length || !negatives.length) return undefined;
  const all = [...positives.map((score) => ({ score, pos: true })), ...negatives.map((score) => ({ score, pos: false }))].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let pos = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j].score === all[i].score) j++;
    const mid = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k].pos) { rankSum += mid; pos++; }
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * (all.length - pos));
}

function score() {
  const probeLines = readFileSync(join(dir, "probe.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.label !== "?");
  const positives = probeLines.filter((line) => line.label === "1");
  const negatives = probeLines.filter((line) => line.label === "0");
  console.log(`labels: ${positives.length} should-ask, ${negatives.length} not (${probeLines.length} certain)`);
  console.log(`AUC should_ask       : ${auc(positives.map((l) => l.shouldAsk), negatives.map((l) => l.shouldAsk))?.toFixed(3)}`);
  console.log(`AUC 1 - should_proceed: ${auc(positives.map((l) => 1 - l.shouldProceed), negatives.map((l) => 1 - l.shouldProceed))?.toFixed(3)}`);
  console.log("");
  console.log("threshold on P(should ask)   flagged   TP   precision   recall");
  for (const threshold of [0.3, 0.5, 0.7, 0.8, 0.9]) {
    const flagged = probeLines.filter((line) => line.shouldAsk >= threshold);
    const tp = flagged.filter((line) => line.label === "1").length;
    const recall = positives.length ? tp / positives.length : 0;
    console.log(`${String(threshold).padStart(8)}                     ${String(flagged.length).padStart(7)}  ${String(tp).padStart(3)}   ${(flagged.length ? tp / flagged.length : 0).toFixed(3).padStart(9)}   ${recall.toFixed(3).padStart(6)}`);
  }
}

// ---------------------------------------------------------------------------

const sample = loadSample();
if (flag("score")) score();
else if (flag("dry-run")) console.log(`${sample.length} requests, one per labelled call; re-run with --yes to spend`);
else if (!flag("yes")) { console.error("refusing to spend without --yes (or use --dry-run)"); process.exit(1); }
else await probe(flag("limit") ? sample.slice(0, Number(value("limit", 10))) : sample);
