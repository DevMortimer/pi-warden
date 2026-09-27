// The end-of-run rules bench: `when: turn` rules judged against a task plus a whole-run diff (one request per case),
// and shell-changed files judged with the edit rules on their diff through the production end-of-run pass. The report
// sweeps the cutoffs in `CUTOFFS`; the shipped cutoff is 0.7. `main` takes pi-warden's API and a judge factory as
// arguments, so an offline test can drive it with a stub judge; scripts/rules-turn-bench.mjs wires it to dist/.
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CUTOFFS, loadShellCases, loadTurnCases, SEED_DIR, SHELL_RULES_FIXTURE, SPLITS, TURN_RULES_FIXTURE } from "./turn-cases.mjs";
import { metrics } from "./score.mjs";

const USAGE = `node scripts/rules-turn-bench.mjs [--dry-run] [--split tune|holdout|all] [--only turn|shell] [--concurrency N] [--budget N] [--out DIR] [--timeout MS]
       node scripts/rules-turn-bench.mjs --rescore DIR`;

export function parseArgs(argv) {
  const opts = { dryRun: false, split: "all", only: "all", concurrency: 2, budget: undefined, out: undefined, timeout: 20_000, rescore: undefined };
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
    else if (arg === "--only") opts.only = value();
    else if (arg === "--concurrency") opts.concurrency = int();
    else if (arg === "--budget") opts.budget = int();
    else if (arg === "--timeout") opts.timeout = int();
    else if (arg === "--out") opts.out = value();
    else if (arg === "--rescore") opts.rescore = value();
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!SPLITS.includes(opts.split)) throw new Error(`--split must be one of ${SPLITS.join(", ")}`);
  if (!["all", "turn", "shell"].includes(opts.only)) throw new Error("--only must be turn or shell");
  return opts;
}

const count = (items, key) => items.reduce((map, item) => ({ ...map, [key(item)]: (map[key(item)] ?? 0) + 1 }), {});

/** Recall and false alarms at every cutoff, per question and split; rows carry raw probabilities, so this is offline. */
export function tables(rows) {
  const share = (value, part, total) => value === null ? "     –   " : `${value.toFixed(3)} (${part}/${total})`;
  const lines = [];
  for (const source of ["turn", "shell"]) {
    const ofSource = rows.filter(row => row.source === source);
    if (!ofSource.length) continue;
    lines.push(`${source === "turn" ? "turn question" : "shell-changed files"} (${ofSource.length} cases):`);
    lines.push("split     cutoff  recall            false alarm       violations/clean");
    for (const split of SPLITS) {
      const ofSplit = ofSource.filter(row => split === "all" || row.split === split);
      if (!ofSplit.length) continue;
      for (const cutoff of CUTOFFS) {
        const result = metrics(ofSplit, cutoff);
        lines.push(`${split.padEnd(9)} ${cutoff.toFixed(1)}     ${share(result.recall, result.tp, result.positives)}    ${share(result.falseAlarmRate, result.fp, result.negatives)}    ${result.positives}/${result.negatives}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function describePlan(turn, shell, opts, budget, log) {
  for (const [name, cases] of [["turn", turn], ["shell", shell]]) {
    if (!cases.length) continue;
    const perRule = new Map();
    for (const item of cases) {
      const entry = perRule.get(item.rule) ?? { total: 0, tune: 0, holdout: 0, violation: 0, clean: 0 };
      entry.total++;
      entry[item.split]++;
      entry[item.label]++;
      perRule.set(item.rule, entry);
    }
    log(`${name} cases per rule (total, tune/holdout, violation/clean):`);
    for (const [rule, entry] of perRule) log(`  ${rule.padEnd(42)} ${String(entry.total).padStart(2)}  ${entry.tune}/${entry.holdout}  ${entry.violation}/${entry.clean}`);
    log(`${name}: ${cases.length} cases; tune ${count(cases, item => item.split).tune ?? 0}, holdout ${count(cases, item => item.split).holdout ?? 0}; violation ${count(cases, item => item.label).violation ?? 0}, clean ${count(cases, item => item.label).clean ?? 0}`);
  }
  const total = turn.length + shell.length;
  log(`requests planned: ${total} (one per case); budget ${budget}${total > budget ? `; only the first ${budget} would be sent` : ""}`);
}

/** A temp project for one shell case: the seed files, the case's own files, and the per-edit rules fixture. */
function prepareShellProject(item) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-warden-turn-bench-"));
  cpSync(SEED_DIR, cwd, { recursive: true });
  copyFileSync(SHELL_RULES_FIXTURE, join(cwd, "pi-warden.md"));
  for (const [path, content] of Object.entries(item.files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "seed");
  return cwd;
}

export async function main(argv, deps) {
  const log = deps.log ?? console.log;
  const opts = parseArgs(argv);

  if (opts.rescore) {
    const file = join(opts.rescore, "results.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.tables = tables(saved.cases);
    writeFileSync(file, `${JSON.stringify(saved, null, 1)}\n`);
    log(saved.tables);
    return { sent: 0, rescored: true };
  }

  const inSplit = item => opts.split === "all" || item.split === opts.split;
  const turn = (opts.only === "shell" ? [] : loadTurnCases().filter(inSplit));
  const shell = (opts.only === "turn" ? [] : loadShellCases().filter(inSplit));
  const total = turn.length + shell.length;
  const budget = opts.budget ?? total;
  if (opts.dryRun) {
    for (const item of turn) log(`turn  ${item.id} ${item.split.padEnd(7)} ${item.label.padEnd(9)} ${item.rule.padEnd(42)} ${item.diff.match(/^diff --git /gm).length} files`);
    for (const item of shell) log(`shell ${item.id} ${item.split.padEnd(7)} ${item.label.padEnd(9)} ${item.rule.padEnd(42)} ${item.command}`);
    describePlan(turn, shell, opts, budget, log);
    log("dry run: 0 requests sent");
    return { sent: 0, planned: total };
  }

  const date = new Date().toISOString().slice(0, 10);
  const out = opts.out ?? join(import.meta.dirname, "..", "reports", `${date}-turn-rules`);
  mkdirSync(out, { recursive: true });
  const requestLog = join(out, "requests.jsonl");
  if (existsSync(requestLog)) throw new Error(`${requestLog} exists; choose another --out or move it`);
  describePlan(turn, shell, opts, budget, log);

  const judge = deps.createJudge({ maxRequests: budget, timeoutMs: opts.timeout });
  const config = deps.lib.defaultConfig().rules;
  const turnRules = deps.lib.parseRules(readFileSync(TURN_RULES_FIXTURE, "utf8"));
  const rows = [];
  const requests = [];
  let sent = 0;
  const started = performance.now();

  const queue = [
    ...turn.map(item => ({ source: "turn", item })),
    ...shell.map(item => ({ source: "shell", item })),
  ].slice(0, budget);
  const send = async ({ source, item }) => {
    const n = ++sent;
    const t0 = performance.now();
    let target;
    let verdictSource;
    if (source === "turn") {
      const verdict = await deps.lib.evaluateTurnRules(item.task, item.diff, turnRules, { judge, config, timeoutMs: opts.timeout, sources: ["turn-rules.md"] });
      verdictSource = verdict.source;
      target = verdict.scores?.find(score => score.id === item.rule);
    } else {
      const cwd = prepareShellProject(item);
      try {
        const snapshot = deps.lib.snapshotTree(cwd);
        if (!snapshot.tree) throw new Error(`snapshot failed: ${snapshot.reason}`);
        execFileSync("bash", ["-c", item.command], { cwd, stdio: "pipe" });
        const set = new deps.lib.RuleStore().load(cwd, config);
        const run = await deps.lib.evaluateTurnRun({ cwd, config, set, judge, timeoutMs: opts.timeout, task: item.task, startTree: snapshot.tree, alreadyJudged: new Set() });
        const verdict = run.verdicts.find(found => found.path === item.path);
        verdictSource = verdict?.source ?? "missing";
        target = verdict?.scores?.find(score => score.id === item.rule);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
    const ms = Math.round(performance.now() - t0);
    const entry = { n, id: item.id, source, rule: item.rule, split: item.split, label: item.label, ms, verdictSource, ...(target ? { outcome: target.outcome, violation: target.violation } : {}) };
    requests.push(entry);
    appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
    rows.push({
      id: item.id, source, rule: item.rule, split: item.split, label: item.label, kind: item.kind,
      verdictSource,
      ...(target ? { outcome: target.outcome, violation: target.violation } : {}),
    });
    log(`${item.id} ${item.split} ${item.label} → ${target ? `${target.outcome} ${target.violation.toFixed(2)}` : `not asked (${verdictSource})`}`);
  };
  const worker = async () => {
    while (queue.length) await send(queue.shift());
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const wallMs = Math.round(performance.now() - started);

  const saved = {
    date,
    command: `node scripts/rules-turn-bench.mjs ${argv.join(" ")}`.trim(),
    split: opts.split,
    only: opts.only,
    concurrency: opts.concurrency,
    budget,
    timeout_ms: opts.timeout,
    wall_ms: wallMs,
    requests_sent: sent,
    models: [...new Set(requests.map(entry => entry.model).filter(Boolean))],
    usage: judge.getUsage?.() ?? {},
    cases: rows,
  };
  saved.tables = tables(rows);
  writeFileSync(join(out, "results.json"), `${JSON.stringify(saved, null, 1)}\n`);
  log(`sent ${sent} requests in ${(wallMs / 1000).toFixed(1)} s; results in ${join(out, "results.json")}`);
  log(`usage: ${JSON.stringify(saved.usage)}`);
  log(saved.tables);
  return { sent, wallMs };
}
