// The bench runner. `main` takes pi-warden's API and a judge factory as arguments, so the offline tests can drive it
// with src/ and a judge that must never be called. scripts/judge-bench.mjs wires it to dist/ and pi-typesafe.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArms } from "./arms.mjs";
import { loadCases } from "./cases.mjs";
import { ARMS, percentile, score, tables, thresholds } from "./score.mjs";

const USAGE = `node scripts/judge-bench.mjs [--dry-run] [--repeats N] [--concurrency N] [--budget N] [--out DIR] [--seed N] [--timeout MS]
       node scripts/judge-bench.mjs --rescore DIR`;

export function parseArgs(argv) {
  const opts = { dryRun: false, repeats: 1, concurrency: 4, budget: undefined, out: undefined, seed: 20260926, timeout: 20_000, rescore: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    const int = () => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error(`${arg} must be a positive integer`);
      return n;
    };
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--repeats") opts.repeats = int();
    else if (arg === "--concurrency") opts.concurrency = int();
    else if (arg === "--budget") opts.budget = int();
    else if (arg === "--seed") opts.seed = int();
    else if (arg === "--timeout") opts.timeout = int();
    else if (arg === "--out") opts.out = value();
    else if (arg === "--rescore") opts.rescore = value();
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return opts;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function shuffle(xs, rand) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const flatten = answers => Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.noul ?? v.score ?? v.choice ?? null]));
const count = (xs, key) => xs.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});

/** Builds every case's three requests and the job list: repeats x cases (shuffled) x arms (shuffled per case). */
export function plan(lib, opts) {
  const cases = loadCases();
  const built = new Map(cases.map(c => [c.id, buildArms(lib, c)]));
  const meta = Object.fromEntries(cases.map(c => {
    const b = built.get(c.id);
    return [c.id, c.guard === "stuck" ? (b.codeDecided ? { codeDecided: b.codeDecided } : {}) : { reached: b.reached }];
  }));
  const rand = rng(opts.seed);
  const jobs = [];
  for (let repeat = 1; repeat <= opts.repeats; repeat++) {
    for (const c of shuffle(cases, rand)) {
      for (const arm of shuffle(ARMS, rand)) {
        const request = built.get(c.id)[arm];
        jobs.push({ guard: c.guard, id: c.id, arm, repeat, request, bytes: Buffer.byteLength(JSON.stringify(request.state)) });
      }
    }
  }
  return { cases, built, meta, jobs };
}

function describePlan(cases, jobs, opts, budget, log) {
  for (const guard of ["stuck", "done"]) {
    const subset = cases.filter(c => c.guard === guard);
    log(`${guard}: ${subset.length} cases; label ${JSON.stringify(count(subset, c => c.label))}; source ${JSON.stringify(count(subset, c => c.source))}`);
    log(`  categories ${JSON.stringify(count(subset, c => c.category))}`);
    log(`  formats ${JSON.stringify(count(subset, c => c.format))}`);
  }
  for (const arm of ARMS) {
    const bytes = jobs.filter(j => j.arm === arm && j.repeat === 1).map(j => j.bytes);
    log(`arm ${arm}: state bytes p50 ${percentile(bytes, 0.5)}, p95 ${percentile(bytes, 0.95)}, max ${Math.max(...bytes)}`);
  }
  log(`requests planned: ${jobs.length} (${cases.length} cases x ${ARMS.length} arms x ${opts.repeats} repeats); budget ${budget}${jobs.length > budget ? `; only the first ${budget} would be sent` : ""}`);
}

export async function main(argv, deps) {
  const log = deps.log ?? console.log;
  const opts = parseArgs(argv);
  const t = thresholds(deps.lib.defaultConfig());

  if (opts.rescore) {
    const file = join(opts.rescore, "results.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const cases = loadCases();
    saved.scores = score(cases, saved.results, saved.requests, saved.meta, t);
    saved.labels = cases.map(c => ({ id: c.id, label: c.label }));
    writeFileSync(file, `${JSON.stringify(saved, null, 1)}\n`);
    log(tables(saved.scores));
    return { sent: 0, rescored: true };
  }

  const { cases, meta, jobs } = plan(deps.lib, opts);
  const budget = opts.budget ?? jobs.length;
  if (opts.dryRun) {
    for (const c of cases) {
      const own = jobs.filter(j => j.id === c.id && j.repeat === 1).sort((x, y) => x.arm.localeCompare(y.arm));
      log(`${c.id} ${c.guard} ${c.label} ${c.category} ${c.format} ${c.source}${meta[c.id].codeDecided ? " code-decided" : ""}${meta[c.id].reached === false ? " gate-blocked" : ""}  ${own.map(j => `${j.arm} ${j.bytes}B`).join("  ")}`);
    }
    describePlan(cases, jobs, opts, budget, log);
    log("dry run: 0 requests sent");
    return { sent: 0, planned: jobs.length };
  }

  const date = new Date().toISOString().slice(0, 10);
  const out = opts.out ?? join(import.meta.dirname, "..", "reports", `${date}-judge-bench`);
  mkdirSync(out, { recursive: true });
  const requestLog = join(out, "requests.jsonl");
  if (existsSync(requestLog)) throw new Error(`${requestLog} exists; choose another --out or move it`);
  describePlan(cases, jobs, opts, budget, log);

  const judge = deps.createJudge({ maxRequests: budget, timeoutMs: opts.timeout });
  const queue = jobs.slice(0, budget);
  const requests = [];
  const results = [];
  let sent = 0;
  const started = performance.now();
  const send = async job => {
    const n = ++sent;
    const t0 = performance.now();
    const res = await deps.ask(judge, job.request, { timeoutMs: opts.timeout });
    const ms = Math.round(performance.now() - t0);
    const entry = { n, guard: job.guard, id: job.id, arm: job.arm, repeat: job.repeat, bytes: job.bytes, ms, ok: res.ok, ...(res.ok ? { model: res.model } : { error: res.errorCode ?? "error" }) };
    requests.push(entry);
    appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
    if (res.ok) results.push({ id: job.id, arm: job.arm, repeat: job.repeat, answers: flatten(res.answers) });
    return res.ok;
  };
  const failed = [];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!(await send(job))) failed.push(job);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  // One retry per failed request, inside the same budget.
  const retries = failed.slice(0, Math.max(0, budget - sent));
  queue.push(...retries);
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const wallMs = Math.round(performance.now() - started);

  const scores = score(cases, results, requests, meta, t);
  const saved = {
    date,
    command: `node scripts/judge-bench.mjs ${argv.join(" ")}`.trim(),
    thresholds: t,
    repeats: opts.repeats, concurrency: opts.concurrency, budget, seed: opts.seed, timeout_ms: opts.timeout,
    wall_ms: wallMs,
    requests_sent: sent,
    requests_failed: requests.filter(r => !r.ok).length,
    retried: retries.length,
    models: [...new Set(requests.filter(r => r.ok).map(r => r.model))],
    labels: cases.map(c => ({ id: c.id, label: c.label })),
    meta,
    requests,
    results,
    scores,
  };
  writeFileSync(join(out, "results.json"), `${JSON.stringify(saved, null, 1)}\n`);
  log(`sent ${sent} requests (${saved.requests_failed} failed, ${retries.length} retried) in ${(wallMs / 1000).toFixed(1)} s; results in ${join(out, "results.json")}`);
  log(tables(scores));
  return { sent, wallMs };
}
