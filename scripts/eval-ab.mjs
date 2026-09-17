#!/usr/bin/env node
/**
 * eval-ab.mjs — repeatable with/without A/B eval for pi-warden.
 *
 * For each task x cell x repeat:
 *   1. copy eval/fixture to a fresh /tmp dir, apply the task's failing tests, git init + commit
 *   2. run `pi --print` headless in that dir (warden cell: only pi-warden loaded via -e)
 *   3. run `npm test`; score the agent's diff with the mechanical checker (eval/check.mjs)
 *   4. count steers from the saved session log; copy it into the run dir
 *
 * Results print as a table and land in eval/reports/report-<stamp>.md + runs.json.
 * The report dir is the durable artifact; /tmp run dirs are removed unless --keep.
 *
 * Usage:
 *   node scripts/eval-ab.mjs                       # all tasks, both cells, 1 repeat
 *   node scripts/eval-ab.mjs --repeats 2 --model claude-sonnet-4-5
 *   node scripts/eval-ab.mjs --tasks t2-clip,t3-swallow --max-runs 4
 *   node scripts/eval-ab.mjs --provider openai --model gpt-5.2 --keep
 */

import { parseArgs } from "node:util";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tasks, taskById } from "../eval/tasks.mjs";
import { violations, violationCounts } from "../eval/check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "eval", "fixture");
const WARDEN_INDEX = join(ROOT, "extensions", "index.js");
const REPORTS = join(ROOT, "eval", "reports");

const { values } = parseArgs({
  options: {
    repeats: { type: "string", default: "1" },
    tasks: { type: "string" },
    "max-runs": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    "timeout-min": { type: "string", default: "12" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const REPEATS = Math.max(1, Number(values.repeats));
const TIMEOUT_MS = Number(values["timeout-min"]) * 60_000;
const SELECTED = values.tasks ? values.tasks.split(",").map((s) => s.trim()).map(taskById) : tasks;
if (SELECTED.some((t) => !t)) {
  console.error("Unknown task id. Available:", tasks.map((t) => t.id).join(", "));
  process.exit(2);
}
const CELLS = ["control", "warden"];

function modelArgs() {
  const args = [];
  if (values.provider) args.push("--provider", values.provider);
  if (values.model) args.push("--model", values.model);
  if (values.thinking) args.push("--thinking", values.thinking);
  return args;
}

async function git(dir, args) {
  return execFileSync("git", ["-C", dir, "-c", "user.email=eval@local", "-c", "user.name=eval", ...args], {
    encoding: "utf8",
  });
}

async function prepareRunDir(task, cell, repeat) {
  const base = await mkdtemp(join("/tmp", `pi-warden-eval-`));
  const project = join(base, "project");
  await cp(FIXTURE, project, { recursive: true });
  for (const [path, content] of Object.entries(task.files)) {
    const dest = join(project, path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  await git(project, ["init", "-q"]);
  await git(project, ["add", "-A"]);
  await git(project, ["commit", "-q", "-m", "fixture baseline + task tests"]);
  const agentDir = await prepareAgentDir(base);
  return { base, project, agentDir, sessions: join(base, "sessions") };
}

/**
 * Cell isolation: each run gets its own PI_CODING_AGENT_DIR seeded with the
 * user's provider credentials and ONE package (the model provider). The warden
 * is never in settings — the warden cell loads it explicitly with `-e`, so the
 * two cells differ by exactly one extension.
 */
const GLOBAL_AGENT = join(homedir(), ".pi", "agent");

async function prepareAgentDir(base, modelArgs) {
  const agentDir = join(base, "agent-dir");
  await mkdir(join(agentDir, "pi-warden"), { recursive: true });
  await mkdir(join(agentDir, "pi-typesafe"), { recursive: true });
  await symlink(join(GLOBAL_AGENT, "npm"), join(agentDir, "npm"), "dir");
  for (const f of ["auth.json", "commandcode-models.json", "models.json", "models-store.json"]) {
    if (existsSync(join(GLOBAL_AGENT, f))) await cp(join(GLOBAL_AGENT, f), join(agentDir, f));
  }
  // pi-typesafe stores its key in <agentDir>/pi-typesafe/auth.json — copy without logging.
  if (existsSync(join(GLOBAL_AGENT, "pi-typesafe", "auth.json"))) {
    await cp(join(GLOBAL_AGENT, "pi-typesafe", "auth.json"), join(agentDir, "pi-typesafe", "auth.json"));
  }
  const settings = {
    defaultProvider: values.provider ?? "commandcode",
    defaultModel: values.model ?? "z-ai/glm-5.3-flash",
    defaultThinkingLevel: values.thinking ?? "high",
    packages: ["npm:pi-commandcode-provider"],
  };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  await writeFile(join(agentDir, "pi-warden", "config.json"), JSON.stringify({ typesafe: true }));
  return agentDir;
}

/** Child pi must not inherit this session's identity or model pins. */
function childEnv(agentDir) {
  const env = { ...process.env };
  for (const k of ["PI_SESSION_FILE", "PI_SESSION_ID", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_SUBAGENT_PARENT_SESSION"]) delete env[k];
  env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

function piArgs(cell, sessionDir) {
  const args = ["--print", "-a", "--session-dir", sessionDir, ...modelArgs()];
  if (cell === "warden") args.push("-e", WARDEN_INDEX);
  return args;
}

function runPi(project, agentDir, sessionDir, prompt, cell) {
  return new Promise((resolveP) => {
    const started = Date.now();
    const child = spawn("pi", [...piArgs(cell, sessionDir), "--", prompt], {
      cwd: project,
      env: childEnv(agentDir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, out, err, timedOut, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const PASS_RE = /(?:#|ℹ)\s*pass (\d+)/;
const FAIL_RE = /(?:#|ℹ)\s*fail (\d+)/;

function runTests(project) {
  try {
    const out = execFileSync("npm", ["test"], { cwd: project, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    const pass = PASS_RE.exec(out);
    const fail = FAIL_RE.exec(out);
    return { pass: pass ? Number(pass[1]) : 0, fail: fail ? Number(fail[1]) : 0, raw: out.slice(-4000) };
  } catch (e) {
    const stdout = String(e.stdout ?? "");
    const pass = PASS_RE.exec(stdout);
    const fail = FAIL_RE.exec(stdout);
    return { pass: pass ? Number(pass[1]) : 0, fail: fail ? Number(fail[1]) : -1, raw: (stdout + String(e.stderr ?? "")).slice(-4000) };
  }
}

/** Hold-log decisions from the run's isolated agent dir (warden cell only). */
async function extractHolds(agentDir) {
  const holdsDir = join(agentDir, "pi-warden", "holds");
  if (!existsSync(holdsDir)) return [];
  const out = [];
  for (const f of await readdir(holdsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(holdsDir, f), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial */ }
    }
  }
  // `source` explains a missing `scores`: records with source "pattern" or "error" never got a Jev judgment
  // (no TypeSafe key in the agent dir, budget spent mid-run, or a failed request under failOpen). "typesafe" records carry it.
  return out.map((r) => ({ tool: r.tool, level: r.level, source: r.source, held: r.held, reasons: r.reasons, outcome: r.outcome, scores: r.scores }));
}

/** Steer messages from a saved session jsonl (pi-warden custom messages). */
async function extractSteers(sessionDir) {
  if (!existsSync(sessionDir)) return [];
  const steers = [];
  for (const f of await readdir(sessionDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const text = await readFile(join(sessionDir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"pi-warden-steer"')) continue;
      try {
        const rec = JSON.parse(line);
        steers.push({ at: rec.timestamp, text: String(rec.content ?? "").slice(0, 200) });
      } catch { /* partial line */ }
    }
  }
  return steers;
}

async function main() {
  if (!existsSync(WARDEN_INDEX)) {
    console.error(`dist/index.js missing — run \`npm run build\` first (${WARDEN_INDEX})`);
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = values.out ? resolve(values.out) : join(REPORTS, `report-${stamp}`);
  await mkdir(outDir, { recursive: true });

  const runs = [];
  const planned = [];
  for (const task of SELECTED) for (const cell of CELLS) for (let r = 1; r <= REPEATS; r++) planned.push({ task, cell, repeat: r });
  const cap = values["max-runs"] ? Number(values["max-runs"]) : planned.length;

  console.log(`eval-ab: ${SELECTED.length} tasks x ${CELLS.length} cells x ${REPEATS} repeat(s)` +
    (values.model ? `, model ${values.model}` : ", pi default model") +
    (values["dry-run"] ? " (dry run)" : ""));

  let n = 0;
  for (const { task, cell, repeat } of planned) {
    if (n >= cap) break;
    n++;
    if (values["dry-run"]) { console.log(`would run: ${task.id} ${cell} r${repeat}`); continue; }
    const label = `${task.id} ${cell} r${repeat}`;
    process.stdout.write(`[${n}/${Math.min(cap, planned.length)}] ${label} ... `);
    const { base, project, agentDir, sessions } = await prepareRunDir(task, cell, repeat);
    try {
      const pi = await runPi(project, agentDir, sessions, task.prompt, cell);
      const test = runTests(project);
      const viols = violations(project);
      const steers = await extractSteers(sessions);
      const holds = await extractHolds(agentDir);
      const diffStat = execFileSync("git", ["-C", project, "diff", "--cached", "--stat"], { encoding: "utf8" }).trim();
      const run = {
        task: task.id, cell, repeat, trap: task.trap,
        piExit: pi.code, timedOut: pi.timedOut, seconds: Math.round(pi.seconds),
        testsPass: test.pass, testsFail: test.fail,
        violations: viols, violationCounts: violationCounts(viols),
        steerCount: steers.length, steers, holds,
        diffStat,
      };
      runs.push(run);
      await writeFile(join(base, "pi-stdout.log"), pi.out);
      await writeFile(join(base, "pi-stderr.log"), pi.err);
      await writeFile(join(base, "npm-test.log"), test.raw);
      const summary = `exit=${pi.code}${pi.timedOut ? " TIMEOUT" : ""} tests ${test.pass}pass/${test.fail}fail viols=${viols.length} steers=${steers.length} ${Math.round(pi.seconds)}s`;
      console.log(summary);
      if (!values.keep) {
        const evidence = join(outDir, "runs", `${task.id}-${cell}-r${repeat}`);
        await mkdir(evidence, { recursive: true });
        await cp(base, evidence, { recursive: true });
      }
    } finally {
      if (!values.keep) await rm(base, { recursive: true, force: true });
    }
  }

  if (values["dry-run"]) { console.log("dry run complete"); return; }

  // ---- aggregate + report --------------------------------------------------
  const agg = {};
  for (const cell of CELLS) {
    const rows = runs.filter((r) => r.cell === cell);
    const taskRows = runs.filter((r) => r.cell === cell && r.testsFail === 0 && r.piExit === 0);
    agg[cell] = {
      runs: rows.length,
      tasksFullyPassing: taskRows.length,
      violationsTotal: rows.reduce((s, r) => s + r.violations.length, 0),
      steers: rows.reduce((s, r) => s + r.steerCount, 0),
      secondsMedian: median(rows.map((r) => r.seconds)),
    };
  }

  const md = [];
  md.push(`# pi-warden A/B eval — ${stamp}`);
  md.push("");
  md.push(`Model: ${values.model ?? "pi default"}${values.provider ? ` (${values.provider})` : ""} · repeats: ${REPEATS} · timeout: ${values["timeout-min"]} min/run · fixture: eval/fixture`);
  md.push("");
  md.push("## Summary");
  md.push("");
  md.push("| Cell | Runs | Tasks fully passing (0 failing tests) | Rule violations in diff | Steers sent | Median seconds |");
  md.push("| --- | --- | --- | --- | --- | --- |");
  for (const cell of CELLS) {
    const a = agg[cell];
    md.push(`| ${cell} | ${a.runs} | ${a.tasksFullyPassing} | ${a.violationsTotal} | ${a.steers} | ${a.secondsMedian} |`);
  }
  md.push("");
  md.push("## Per-run rows");
  md.push("");
  md.push("| Task | Cell | Tests pass/fail | Violations | Steers | Exit | Seconds |");
  md.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    md.push(`| ${r.task} | ${r.cell} | ${r.testsPass}/${r.testsFail} | ${r.violations.map((v) => v.id).join(", ") || "—"} | ${r.steerCount} | ${r.timedOut ? "timeout" : r.piExit} | ${r.seconds} |`);
  }
  md.push("");
  md.push("## Hold detail");
  md.push("");
  md.push("Per-question Jev probabilities for every guarded call (warden cell). `source` is `pattern` when no judgment was made — no TypeSafe key, budget spent, or a failed request under failOpen — so scores are absent there.");
  md.push("");
  const pct = (v) => (typeof v === "number" ? Math.round(v * 100) + "%" : "—");
  const scoreCell = (s) => s
    ? `irr ${pct(s.irreversible)} · off ${pct(s.offTask)} · scope ${s.scope ?? "—"}${s.mutates !== undefined ? ` · mut ${pct(s.mutates)}` : ""}${s.intentMismatch !== undefined ? ` · intent ${pct(s.intentMismatch)}` : ""}${s.visible !== undefined ? ` · vis ${pct(s.visible)}` : ""}${s.securityRisk !== undefined ? ` · sec ${pct(s.securityRisk)}` : ""}`
    : "no judgment";
  let holdRows = 0;
  for (const r of runs.filter((r) => r.holds.length)) {
    if (!holdRows) { md.push("| Task | Cell | # | Tool | Level | Source | Held | Jev scores | Reason(s) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"); }
    holdRows++;
    r.holds.forEach((h, i) => {
      md.push(`| ${r.task} | ${r.cell} r${r.repeat} | ${i + 1} | ${h.tool} | ${h.level} | ${h.source ?? "—"} | ${h.held ? "yes" : "no"} | ${scoreCell(h.scores)} | ${h.reasons.join("; ") || "—"} |`);
    });
  }
  if (!holdRows) md.push("_No guarded calls recorded._");
  md.push("");
  md.push("## Violation detail");
  md.push("");
  for (const r of runs.filter((r) => r.violations.length)) {
    md.push(`### ${r.task} · ${r.cell} r${r.repeat}`);
    md.push("");
    for (const v of r.violations) md.push(`- \`${v.id}\` ${v.file}:${v.line} — ${v.excerpt}`);
    md.push("");
  }
  md.push("Control cell = rules as prose in AGENTS.md. Warden cell = same AGENTS.md plus pi-warden enforcing pi-warden.md. Scoring is mechanical (eval/check.mjs), independent of Jev.");
  md.push("");

  await writeFile(join(outDir, "report.md"), md.join("\n"));
  await writeFile(join(outDir, "runs.json"), JSON.stringify({ stamp, args: values, runs }, null, 2));
  console.log(`\nreport: ${join(outDir, "report.md")}`);
  console.log(md.filter((l) => l.startsWith("|")).join("\n"));
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

main().catch((e) => { console.error(e); process.exit(1); });
