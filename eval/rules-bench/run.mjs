// The rules bench runner. `main` takes pi-warden's API and a judge factory as arguments, so an offline test can
// drive it with a stub judge; scripts/rules-bench.mjs wires it to dist/ and pi-typesafe.
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputFor, loadCases, RULES_FIXTURE, SEED_DIR, SPLITS } from "./cases.mjs";
import { score, tables } from "./score.mjs";

const USAGE = `node scripts/rules-bench.mjs [--dry-run] [--split tune|holdout|all] [--concurrency N] [--budget N] [--out DIR] [--timeout MS]
       node scripts/rules-bench.mjs --rescore DIR`;

export function parseArgs(argv) {
  const opts = { dryRun: false, split: "all", concurrency: 4, budget: undefined, out: undefined, timeout: 20_000, rescore: undefined };
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
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--split") opts.split = value();
    else if (arg === "--concurrency") opts.concurrency = int();
    else if (arg === "--budget") opts.budget = int();
    else if (arg === "--timeout") opts.timeout = int();
    else if (arg === "--out") opts.out = value();
    else if (arg === "--rescore") opts.rescore = value();
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!SPLITS.includes(opts.split)) throw new Error(`--split must be one of ${SPLITS.join(", ")}`);
  return opts;
}

/** A temp project with the rules fixture installed as `pi-warden.md` and the seed files copied in. */
export function prepareProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-warden-rules-bench-"));
  cpSync(SEED_DIR, cwd, { recursive: true });
  copyFileSync(RULES_FIXTURE, join(cwd, "pi-warden.md"));
  return cwd;
}

const count = (items, key) => items.reduce((map, item) => ({ ...map, [key(item)]: (map[key(item)] ?? 0) + 1 }), {});

function describePlan(cases, opts, budget, log) {
  const perRule = new Map();
  for (const item of cases) {
    const entry = perRule.get(item.rule) ?? { total: 0, tune: 0, holdout: 0, violation: 0, clean: 0 };
    entry.total++;
    entry[item.split]++;
    entry[item.label]++;
    perRule.set(item.rule, entry);
  }
  log(`cases per rule (total, tune/holdout, violation/clean):`);
  for (const [rule, entry] of perRule) log(`  ${rule.padEnd(52)} ${String(entry.total).padStart(2)}  ${entry.tune}/${entry.holdout}  ${entry.violation}/${entry.clean}`);
  log(`cases: ${cases.length}; split ${opts.split}; tune ${count(cases, item => item.split).tune ?? 0}, holdout ${count(cases, item => item.split).holdout ?? 0}; violation ${count(cases, item => item.label).violation ?? 0}, clean ${count(cases, item => item.label).clean ?? 0}`);
  log(`tool shapes: ${JSON.stringify(count(cases, item => item.tool))}; kinds: ${JSON.stringify(count(cases, item => item.kind))}`);
  log(`requests planned: ${cases.length} (one per case); budget ${budget}${cases.length > budget ? `; only the first ${budget} would be sent` : ""}`);
}

/** Which cases the guard would ask about the target rule, judged locally with no request. */
function askedTargets(lib, cases, cwd) {
  const config = lib.defaultConfig();
  const set = new lib.RuleStore().load(cwd, config.rules);
  const answer = new Map();
  for (const item of cases) {
    const target = lib.describeTarget(item.tool, inputFor(item), cwd);
    const reason = lib.skipReason(target, set, config.rules);
    const rules = target && set ? lib.rulesFor(set, target.path).map(rule => rule.id) : [];
    answer.set(item.id, { asked: rules.includes(item.rule), rules: rules.length, skipped: reason ?? null });
  }
  return answer;
}

export async function main(argv, deps) {
  const log = deps.log ?? console.log;
  const opts = parseArgs(argv);

  if (opts.rescore) {
    const file = join(opts.rescore, "results.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const cases = loadCases().filter(item => opts.split === "all" || item.split === opts.split);
    saved.scores = score(cases, saved.cases);
    writeFileSync(file, `${JSON.stringify(saved, null, 1)}\n`);
    log(tables(saved.scores));
    return { sent: 0, rescored: true };
  }

  const all = loadCases();
  const cases = all.filter(item => opts.split === "all" || item.split === opts.split);
  const budget = opts.budget ?? cases.length;
  const cwd = prepareProject();
  try {
    const asked = askedTargets(deps.lib, cases, cwd);
    if (opts.dryRun) {
      for (const item of cases) {
        const state = asked.get(item.id);
        log(`${item.id} ${item.split.padEnd(7)} ${item.label.padEnd(9)} ${item.kind.padEnd(14)} ${item.tool.padEnd(5)} ${item.path.padEnd(28)} ${item.rule.padEnd(52)} target ${state.asked ? "asked" : "not asked"}${state.skipped ? ` (${state.skipped})` : ""}`);
      }
      describePlan(cases, opts, budget, log);
      const flagged = [...asked.values()].filter(state => !state.asked).length;
      log(`target rule not asked for ${flagged} of ${cases.length} cases (scoped rules outside their paths, excluded from the metrics)`);
      log("dry run: 0 requests sent");
      return { sent: 0, planned: cases.length };
    }

    const date = new Date().toISOString().slice(0, 10);
    const out = opts.out ?? join(import.meta.dirname, "..", "reports", `${date}-rules-bench`);
    mkdirSync(out, { recursive: true });
    const requestLog = join(out, "requests.jsonl");
    if (existsSync(requestLog)) throw new Error(`${requestLog} exists; choose another --out or move it`);
    describePlan(cases, opts, budget, log);

    const judge = deps.createJudge({ maxRequests: budget, timeoutMs: opts.timeout });
    const config = deps.lib.defaultConfig();
    const set = new deps.lib.RuleStore().load(cwd, config.rules);
    if (!set) throw new Error("no rules file resolved in the temp project");

    const queue = cases.slice(0, budget);
    const requests = [];
    const answers = new Map();
    let sent = 0;
    const started = performance.now();
    const send = async item => {
      const n = ++sent;
      const t0 = performance.now();
      const verdict = await deps.lib.evaluateRules(item.tool, inputFor(item), { cwd, config: config.rules, set, judge, timeoutMs: opts.timeout });
      const ms = Math.round(performance.now() - t0);
      const ok = verdict.source === "typesafe";
      const entry = { n, id: item.id, rule: item.rule, split: item.split, tool: item.tool, path: item.path, ms, source: verdict.source, asked: verdict.asked ?? 0, ok, ...(verdict.model ? { model: verdict.model } : {}), ...(verdict.errorCode ? { error: verdict.errorCode } : {}) };
      requests.push(entry);
      appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
      if (ok) answers.set(item.id, verdict);
      return ok;
    };
    const failed = [];
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!(await send(item))) failed.push(item);
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
    // One retry per failed case, inside the same budget.
    const retries = failed.slice(0, Math.max(0, budget - sent));
    queue.push(...retries);
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
    const wallMs = Math.round(performance.now() - started);

    const rows = cases.map(item => {
      const verdict = answers.get(item.id);
      const target = verdict?.scores?.find(score => score.id === item.rule);
      return {
        id: item.id, rule: item.rule, label: item.label, kind: item.kind, split: item.split, tool: item.tool, path: item.path,
        source: verdict?.source ?? "missing",
        asked: verdict?.asked ?? 0,
        targetAsked: target !== undefined,
        ...(target === undefined ? {} : { target: { outcome: target.outcome, violation: target.violation } }),
        ...(verdict?.editId ? { editId: verdict.editId } : {}),
        scores: verdict?.scores ?? [],
        findings: (verdict?.findings ?? []).map(finding => finding.id),
        ...(verdict?.model ? { model: verdict.model } : {}),
        ...(verdict?.elapsedMs === undefined ? {} : { elapsedMs: verdict.elapsedMs }),
        ...(verdict?.error ? { error: verdict.error } : {}),
        ...(verdict?.skippedReason ? { skippedReason: verdict.skippedReason } : {}),
      };
    });
    const saved = {
      date,
      command: `node scripts/rules-bench.mjs ${argv.join(" ")}`.trim(),
      split: opts.split,
      concurrency: opts.concurrency,
      budget,
      timeout_ms: opts.timeout,
      wall_ms: wallMs,
      requests_sent: sent,
      requests_failed: requests.filter(entry => !entry.ok).length,
      retried: retries.length,
      models: [...new Set(requests.filter(entry => entry.model).map(entry => entry.model))],
      rules_fixture: set.rules.map(rule => ({ id: rule.id, paths: rule.paths, ...(rule.threshold === undefined ? {} : { threshold: rule.threshold }), ...(rule.severity === undefined ? {} : { severity: rule.severity }) })),
      usage: judge.getUsage(),
      cases: rows,
      scores: score(cases, rows),
    };
    writeFileSync(join(out, "results.json"), `${JSON.stringify(saved, null, 1)}\n`);
    log(`sent ${sent} requests (${saved.requests_failed} failed, ${retries.length} retried) in ${(wallMs / 1000).toFixed(1)} s; results in ${join(out, "results.json")}`);
    log(`usage: ${JSON.stringify(saved.usage)}`);
    log(tables(saved.scores));
    return { sent, wallMs };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
