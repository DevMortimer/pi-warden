#!/usr/bin/env node
/**
 * Turn-start latency bench: how long `before_agent_start` holds a prompt while the rules request and the conscience
 * assessment run. The judgment is answered by a local mock after a fixed delay, so the number measures the hold, not
 * the network; nothing leaves the machine and no key is needed.
 *
 * The bench loads the extension from the tree that contains this script (`src/extension.ts`), so the same script run in
 * a tree before and after a change gives both sides of the comparison.
 *
 * Run: node --import tsx scripts/turn-start-latency.mjs --mode rules --runs 100 --delay 250
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const tree = resolve(here, "..");

/** Argv as `--name value`; unknown names throw so a typo is not a silent default. */
function parseArgs(argv) {
  const opts = { mode: undefined, runs: 100, delay: 250 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--mode") opts.mode = value();
    else if (arg === "--runs") opts.runs = Number(value());
    else if (arg === "--delay") opts.delay = Number(value());
    else throw new Error(`unknown argument ${arg}`);
  }
  if (opts.mode !== "rules" && opts.mode !== "conscience") throw new Error("--mode must be rules or conscience");
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isFinite(opts.delay) || opts.delay < 0) throw new Error("--delay must be milliseconds");
  return opts;
}

/** Nearest-rank percentile, the same shape the curator ledger reports. */
function percentile(times, fraction) {
  if (!times.length) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

const opts = parseArgs(process.argv.slice(2));

// A private home for the run: no user config, trace file, database, or key from the real machine is read.
const home = mkdtempSync(join(tmpdir(), "pi-warden-latency-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
process.env.PI_WARDEN_DB = join(home, "agent", "pi-warden", "holds.db");
process.env.TYPESAFE_API_KEY = "offline-bench-key";
mkdirSync(join(home, "agent", "pi-warden"), { recursive: true });
writeFileSync(join(home, "pi-warden.md"), "# No hardcoded secrets\nSource code must not contain passwords or API keys.\n\n# House prose\nNo em-dashes in documents.\n");
writeFileSync(join(home, "agent", "pi-warden", "config.json"), JSON.stringify({
  typesafe: true, notices: false,
  rules: { enabled: opts.mode === "rules" },
  rulesAtTurnStart: { enabled: opts.mode === "rules" },
  conscience: { enabled: opts.mode === "conscience", localFloor: 0 },
  slop: { enabled: false }, done: { enabled: false }, action: { feedbackLog: false },
  security: { enabled: false }, notify: { enabled: false }, waste: { enabled: false },
}));

let inFlight = 0;
let settled = Promise.resolve();
const originalFetch = globalThis.fetch;
// One mock for every judgment: the model list answers at once, the judgment waits `--delay` so the hold is visible.
globalThis.fetch = async (input, init) => {
  if (String(input).endsWith("/v1/models")) return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }] });
  const body = JSON.parse(String(init?.body));
  const answers = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === "noul") answers[id] = { type: "noul", noul: id.startsWith("applies_") ? 0.1 : 0.1 };
    else if (question.type === "choice") {
      const keys = Object.keys(question.criteria);
      answers[id] = { type: "choice", choice: keys[0], confidence: 0.8, probabilities: Object.fromEntries(keys.map(key => [key, key === keys[0] ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])) };
    } else {
      const levels = question.criteria.length;
      answers[id] = { type: "score", score: 0, confidence: 0.8, legend: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), `level ${index}`])), probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === 0 ? 0.8 : 0.2 / Math.max(1, levels - 1)])) };
    }
  }
  inFlight++;
  const wait = new Promise(resolveWait => setTimeout(resolveWait, opts.delay)).then(() => { inFlight--; });
  settled = settled.then(() => wait);
  await wait;
  return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 50, output_tokens: 0 } });
};

const loader = new DefaultResourceLoader({
  cwd: home,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager: SettingsManager.inMemory(),
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: [join(tree, "src", "extension.ts")],
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length) throw new Error(`extension load failed: ${loaded.errors.map(error => error.message).join("; ")}`);
const extension = loaded.extensions[0];
// Capture custom messages instead of letting the unbound runtime throw.
loaded.runtime.sendMessage = () => {};
loaded.runtime.sendUserMessage = () => {};

const ui = { notify() {}, confirm: async () => true, editor: async () => undefined, setWidget() {}, custom: async () => undefined, input: async () => undefined };
const ctx = () => ({
  hasUI: false, ui, cwd: home,
  sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "set up the retry helper" } }] },
  signal: undefined, isProjectTrusted: () => true, isIdle: () => true, waitForIdle: async () => {},
  getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
});
const fire = async (type, event, context) => {
  const handlers = extension.handlers.get(type) ?? [];
  for (const handler of handlers) await handler({ type, ...event }, context);
};

const skills = [{ name: "research", description: "Research questions against primary sources", filePath: join(home, "research.md"), baseDir: home, sourceInfo: { path: join(home, "research.md"), source: "bench", scope: "project", origin: "bench" }, disableModelInvocation: false }];
const context = ctx();
await fire("session_start", {}, context);
const times = [];
for (let index = 0; index < opts.runs; index++) {
  const started = performance.now();
  await fire("before_agent_start", opts.mode === "conscience" ? { prompt: "design a landing page for the docs site", systemPromptOptions: { cwd: home, skills } } : { prompt: "read the config module and tighten the retry default" }, ctx());
  times.push(performance.now() - started);
}
// Let the background judgments finish before the process exits, so a run never reports half a request.
await settled;
await new Promise(resolveWait => setTimeout(resolveWait, 50));

console.log(JSON.stringify({
  mode: opts.mode,
  runs: opts.runs,
  judgeDelayMs: opts.delay,
  p50: Math.round(percentile(times, 0.5) * 100) / 100,
  p90: Math.round(percentile(times, 0.9) * 100) / 100,
  p99: Math.round(percentile(times, 0.99) * 100) / 100,
  max: Math.round(Math.max(...times) * 100) / 100,
}, null, 2));

globalThis.fetch = originalFetch;
rmSync(home, { recursive: true, force: true });
