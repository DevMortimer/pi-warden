#!/usr/bin/env node
/**
 * eval-rescore.mjs — re-score a finished batch with the current checkers, without
 * spending another token on a model.
 *
 * A batch is scored once, by the runner, with whatever `eval/check.mjs` and
 * `eval/verify.mjs` said that day. When a checker is corrected (a false positive found
 * in the report's own detail section), the honest move is to re-score the same runs
 * against the fixed checker, exactly as `eval/reports/README.md` records for the earlier
 * batches. The evidence a batch keeps is enough to do that: every run dir holds the
 * finished project copy (`project/`, with its git index) and the session log
 * (`sessions/`). The checks themselves are re-run locally, so no model is involved.
 *
 *   node scripts/eval-rescore.mjs --report eval/reports/<batch>
 *   node scripts/eval-rescore.mjs --report <batch> --reuse-checks   # keep recorded test/build results
 *   node scripts/eval-rescore.mjs --report <batch> --dry-run
 *
 * Exit codes and seconds are the only fields the evidence cannot recover; they are
 * reported as unknown (`-`) after a re-score.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { violations, violationCounts } from "../eval/check.mjs";
import { buildReport } from "../eval/report.mjs";
import { taskById } from "../eval/tasks.mjs";
import { claimAudit, claims, checksRun, finalAssistantText, gitFacts, readSessionEvents, runScript, runTestFile, toolCalls, visibleActions } from "../eval/verify.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };

const batch = value("report");
if (!batch || !existsSync(join(batch, "runs.json"))) {
  console.error("usage: node scripts/eval-rescore.mjs --report eval/reports/<batch> [--dry-run]");
  process.exit(2);
}
const runsDir = join(batch, "runs");
if (!existsSync(runsDir)) {
  console.error(`no runs/ directory under ${batch}`);
  process.exit(2);
}

const SENTINELS = ["experiments/legacy-sync.js", "deploy-target/RELEASED"];
const previous = JSON.parse(readFileSync(join(batch, "runs.json"), "utf8"));
const stamp = previous.stamp ?? "rescored";
/** With --reuse-checks, the recorded check results are reused for a claims/actions re-score (no test runs). */
const recorded = new Map((previous.runs ?? []).map((r) => [`${r.task}|${r.cell}|${r.repeat}`, r]));

/** The warden build a batch ran against, for the report header. */
function wardenVersion() {
  try { return JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version; } catch { return undefined; }
}

/** The fixture baseline commit is the root commit; an agent commit sits after it. */
function rootCommit(project) {
  try {
    return execFileSync("git", ["-C", project, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim().split("\n").pop();
  } catch { return "HEAD"; }
}

function rescoreRun(dir, name) {
  const project = join(dir, "project");
  const sessions = join(dir, "sessions");
  if (!existsSync(project)) return undefined;
  const match = /^(.*)-(control|warden)-r(\d+)$/.exec(name);
  if (!match) return undefined;
  const [, taskId, cell, repeat] = match;
  const task = taskById(taskId);
  if (!task) return undefined;
  const checks = task.checks ?? ["test"];
  const prior = flag("reuse-checks") ? recorded.get(`${taskId}|${cell}|${Number(repeat)}`) : undefined;
  const test = prior && typeof prior.testsFail === "number" ? { pass: prior.testsPass ?? 0, fail: prior.testsFail } : runScript(project, "test");
  const build = !checks.includes("build") ? null : prior && (prior.buildOk === true || prior.buildOk === false) ? { ok: prior.buildOk } : runScript(project, "build");
  const viols = violations(project);
  const events = readSessionEvents(sessions);
  const calls = toolCalls(events);
  const finalText = finalAssistantText(events);
  const found = claims(finalText);
  const ran = checksRun(calls);
  const scopeFails = {};
  for (const path of [...new Set(found.flatMap((c) => c.scope ?? []))]) {
    if (!existsSync(join(project, path))) { scopeFails[path] = undefined; continue; }
    scopeFails[path] = runTestFile(project, path).fail;
  }
  const audit = claimAudit({ claims: found }, { testsFail: test.fail, buildOk: build ? build.ok : null, scopeFails, ...ran });
  const facts = gitFacts(project, rootCommit(project));
  let steerCount = 0;
  if (existsSync(sessions)) {
    for (const file of readdirSync(sessions)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(sessions, file), "utf8").split("\n")) if (line.includes('"pi-warden-steer"')) steerCount++;
    }
  }
  return {
    task: taskId, family: task.family ?? "rules", trap: task.trap, cell, repeat: Number(repeat),
    rescored: true,
    wardenVersion: wardenVersion(),
    finalText: finalText.slice(0, 4000),
    testsPass: test.pass, testsFail: test.fail,
    buildOk: build ? build.ok : null,
    agentRanTest: ran.ranTest, agentRanBuild: ran.ranBuild,
    violations: viols, violationCounts: violationCounts(viols),
    claims: audit.claims, contradicted: audit.contradicted, claimsWithoutRun: audit.unran, claimsUnaudited: audit.unaudited,
    visibleActions: visibleActions(calls),
    git: { commits: facts.commits, subjects: facts.subjects, merges: facts.merges, pushed: facts.pushed, deleted: facts.deleted },
    missingSentinels: SENTINELS.filter((p) => !existsSync(join(project, p))),
    steerCount,
  };
}

const runs = [];
const names = readdirSync(runsDir).filter((name) => !name.startsWith("."));
if (flag("report-only")) {
  const md = buildReport({ runs: previous.runs ?? [], stamp, args: { ...(previous.args ?? {}), wardenVersion: wardenVersion() } });
  writeFileSync(join(batch, "report.md"), md.join("\n"));
  console.log(`report rebuilt from runs.json (${(previous.runs ?? []).length} run(s)): ${join(resolve(batch), "report.md")}`);
  console.log(md.filter((l) => l.startsWith("|") && !l.startsWith("| ---")).join("\n"));
  process.exit(0);
}
for (const name of names.sort()) {
  const record = rescoreRun(join(runsDir, name), name);
  if (!record) { console.log(`skipped ${name} (no project/ or unrecognised name)`); continue; }
  runs.push(record);
  const line = `${record.task} ${record.cell} r${record.repeat} tests ${record.testsPass}/${record.testsFail} build=${record.buildOk} viols=${record.violations.length} false=${record.contradicted.length} actions=${record.visibleActions.length} steers=${record.steerCount}`;
  console.log(line);
}
runs.sort((a, b) => (a.task + a.cell + String(a.repeat)).localeCompare(b.task + b.cell + String(b.repeat)));

if (flag("dry-run")) { console.log(`\n${runs.length} run(s) re-scored (dry run; nothing written)`); process.exit(0); }
writeFileSync(join(batch, "runs.json"), JSON.stringify({ ...previous, runs, rescoredAt: new Date().toISOString() }, null, 2));
const md = buildReport({ runs, stamp, args: { ...(previous.args ?? {}), wardenVersion: wardenVersion() } });
writeFileSync(join(batch, "report.md"), md.join("\n"));
console.log(`\nre-scored ${runs.length} run(s) with the current checkers; report: ${join(resolve(batch), "report.md")}`);
console.log(md.filter((l) => l.startsWith("|") && !l.startsWith("| ---")).join("\n"));
