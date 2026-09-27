import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Judge } from "pi-typesafe";
import type { RulesConfig } from "./config.js";
import { discoverSourceFiles } from "./discover.js";
import { evaluateRules, gitIgnored, projectPath, skipReason } from "./rules.js";
import type { RuleSet, RulesTarget, RulesVerdict } from "./rules.js";

/**
 * `/warden rules audit` and `/warden bench`: two plain functions over the rules guard.
 *
 * The audit judges existing files against the project rules as if each had just been written, one `write` request per
 * file. Nothing leaves the machine without the confirm dialog (or `--yes` in a headless run), the results never reach
 * the rules log, and the only file written is the Markdown copy under `.pi-warden/`. The bench measures what one of
 * those requests costs on this machine with a fixed built-in sample, so no project content is sent for it at all.
 */

/** Files the audit judges unless `--max` says otherwise. */
export const AUDIT_DEFAULT_MAX = 50;
/** Requests in flight at once; small so a big audit cannot burst the backend. */
export const AUDIT_CONCURRENCY = 4;
/** Source files the discovery walk collects before it stops; the cap counts what it found. */
export const AUDIT_DISCOVERY_MAX = 5000;
export const AUDIT_REPORT_FILE = ".pi-warden/rules-audit.md";
export const RULES_AUDIT_USAGE = "Usage: /warden rules audit [paths...] [--max N] [--yes], where N is a positive integer (default 50) and paths default to the project.";
export const BENCH_USAGE = "Usage: /warden bench [--runs N], where N is a positive integer (default 10).";

// ---------------------------------------------------------------------------
// Arguments

export interface RulesAuditArgs {
  /** Project-relative paths to audit; `["."]` when none were given. */
  paths: string[];
  max: number;
  yes: boolean;
  error?: string;
}

export function parseRulesAuditArgs(tokens: readonly string[]): RulesAuditArgs {
  const paths: string[] = [];
  let max = AUDIT_DEFAULT_MAX;
  let yes = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--yes") { yes = true; continue; }
    if (token === "--max") {
      const value = tokens[++index];
      const count = Number(value);
      if (value === undefined || !Number.isInteger(count) || count < 1) return { paths, max, yes, error: `--max needs a positive integer. ${RULES_AUDIT_USAGE}` };
      max = count;
      continue;
    }
    if (token.startsWith("-")) return { paths, max, yes, error: `Unknown option ${token}. ${RULES_AUDIT_USAGE}` };
    paths.push(token);
  }
  return { paths: paths.length ? paths : ["."], max, yes };
}

export interface BenchArgs {
  runs: number;
  error?: string;
}

export function parseBenchArgs(tokens: readonly string[]): BenchArgs {
  let runs = 10;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--runs") {
      const value = tokens[++index];
      const count = Number(value);
      if (value === undefined || !Number.isInteger(count) || count < 1) return { runs, error: `--runs needs a positive integer. ${BENCH_USAGE}` };
      runs = count;
      continue;
    }
    return { runs, error: `Unknown option ${token}. ${BENCH_USAGE}` };
  }
  return { runs };
}

// ---------------------------------------------------------------------------
// Discovery

export interface AuditFilePlan {
  /** Project-relative paths to judge, in sorted order, capped at `max`. */
  files: string[];
  /** Files that passed every filter (git, `rules.exclude`, `rules.skip`, and at least one applicable rule). */
  matched: number;
  /** Matched files left out at the cap. */
  leftOut: number;
  /** Given paths that are not a file or directory inside the project. */
  missing: string[];
}

/**
 * The source files under `paths` the audit will judge: found by `discoverSourceFiles`, inside the project, not ignored
 * by git, not kept out by `rules.exclude` or `rules.skip`, and with at least one rule that applies to them. Capped in
 * sorted order so the same command judges the same files twice.
 */
export function collectAuditFiles(cwd: string, paths: readonly string[], set: RuleSet | undefined, config: RulesConfig, max: number): AuditFilePlan {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const missing: string[] = [];
  for (const raw of paths) {
    const abs = resolve(cwd, raw);
    let stat: ReturnType<typeof statSync> | undefined;
    try { stat = statSync(abs); } catch { stat = undefined; }
    const rel = stat ? relative(resolve(cwd), abs).split(sep).join("/") : undefined;
    // The project root is the one path `projectPath` rejects: it is not inside itself.
    if (!stat || rel === undefined || rel.startsWith("..") || isAbsolute(rel)) { missing.push(raw); continue; }
    const found = stat.isDirectory()
      ? discoverSourceFiles(abs, AUDIT_DISCOVERY_MAX).map(name => projectPath(join(abs, name), cwd)).filter((path): path is string => path !== undefined)
      : rel ? [rel] : [];
    if (!stat.isDirectory() && !stat.isFile()) missing.push(raw);
    for (const candidate of found) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (gitIgnored(candidate, cwd)) continue;
      if (skipReason({ tool: "write", path: candidate } satisfies RulesTarget, set, config)) continue;
      candidates.push(candidate);
    }
  }
  candidates.sort();
  return { files: candidates.slice(0, max), matched: candidates.length, leftOut: Math.max(0, candidates.length - max), missing };
}

// ---------------------------------------------------------------------------
// Results

export interface RulesAuditFileResult {
  /** Project-relative path. */
  path: string;
  verdict: RulesVerdict;
}

export interface RulesAuditRow {
  id: string;
  name: string;
  /** Files whose request asked about this rule. */
  judged: number;
  /** Files where the rule scored at or above its cutoff. */
  flagged: number;
  /** Mean P(violation) over the files judged. */
  mean: number;
}

export interface RulesAuditOutcome {
  paths: string[];
  max: number;
  /** Files selected for judgment. */
  selected: number;
  judged: number;
  leftOut: number;
  missing: string[];
  /** Selected files that could not be read or were empty. */
  unreadable: string[];
  /** Files whose judgment came back as an error. */
  errors: string[];
  results: RulesAuditFileResult[];
  rows: RulesAuditRow[];
  /** Files with at least one finding. */
  flagged: number;
  sources: string[];
  /** Distinct rules asked across the audit. */
  rules: number;
  aggregate: boolean;
  reportPath: string;
  elapsedMs: number;
}

export type RulesAuditResult =
  | { status: "no-judge" }
  | { status: "no-files"; reason: string }
  | { status: "needs-yes"; files: number; leftOut: number }
  | { status: "cancelled" }
  | { status: "done"; outcome: RulesAuditOutcome };

export interface RulesAuditOptions {
  cwd: string;
  paths: readonly string[];
  max: number;
  /** Headless runs pass `--yes`; without it and without a dialog nothing is sent. */
  yes: boolean;
  config: RulesConfig;
  set: RuleSet | undefined;
  judge?: Judge | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Where the samples go, named in the confirm dialog. */
  destination: string;
  confirm?: ((title: string, body: string) => boolean | Promise<boolean>) | undefined;
}

/**
 * One `write` request per selected file, at most AUDIT_CONCURRENCY at a time, after the confirm dialog (or `--yes`).
 * With no judge nothing is sent and no dialog is shown. The Markdown copy is written to `AUDIT_REPORT_FILE`; the rules
 * log is never touched.
 */
export async function runRulesAudit(options: RulesAuditOptions): Promise<RulesAuditResult> {
  if (!options.judge) return { status: "no-judge" };
  const { set } = options;
  if (!set) return { status: "no-files", reason: "no rules file resolved, so there is nothing to judge the files against" };
  if (set.proseOnly) return { status: "no-files", reason: `no rules found in ${set.sources.join(", ")} (prose only)` };
  const plan = collectAuditFiles(options.cwd, options.paths, set, options.config, options.max);
  if (!plan.files.length) return { status: "no-files", reason: `no source file under ${options.paths.join(", ")} has a rule that applies to it` };
  if (!options.yes) {
    if (!options.confirm) return { status: "needs-yes", files: plan.files.length, leftOut: plan.leftOut };
    const title = `Send ${plan.files.length} file${plan.files.length === 1 ? "" : "s"} to ${options.destination} for a rules audit?`;
    const body = [
      `Each file is judged against the project rules as if it had just been written.`,
      `What leaves the machine: a redacted sample of each file (up to 6000 characters per file) and the rule text, sent to ${options.destination}.`,
      plan.leftOut ? `${plan.leftOut} file${plan.leftOut === 1 ? "" : "s"} left out at the --max ${options.max} cap.` : "",
      "Nothing is written to the rules log.",
    ].filter(Boolean).join("\n");
    if (!await options.confirm(title, body)) return { status: "cancelled" };
  }
  const queue = plan.files.map((path, index) => ({ path, index }));
  const results: Array<RulesAuditFileResult | undefined> = Array.from({ length: plan.files.length });
  const unreadable: string[] = [];
  const errors: string[] = [];
  const started = Date.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      let content: string;
      try { content = readFileSync(join(options.cwd, next.path), "utf8"); } catch { unreadable.push(next.path); continue; }
      if (!content.trim()) { unreadable.push(next.path); continue; }
      const verdict = await evaluateRules("write", { path: next.path, content }, {
        cwd: options.cwd, config: options.config, set, judge: options.judge, timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}),
      });
      if (verdict.source === "error") errors.push(next.path);
      results[next.index] = { path: next.path, verdict };
    }
  };
  await Promise.all(Array.from({ length: AUDIT_CONCURRENCY }, worker));
  const judged: RulesAuditFileResult[] = results.filter((entry): entry is RulesAuditFileResult => entry !== undefined);
  const rows = ruleAuditRows(judged);
  const outcome: RulesAuditOutcome = {
    paths: [...options.paths],
    max: options.max,
    selected: plan.files.length,
    judged: judged.length,
    leftOut: plan.leftOut,
    missing: plan.missing,
    unreadable,
    errors,
    results: judged,
    rows,
    flagged: judged.filter(entry => entry.verdict.findings.length > 0).length,
    sources: set.sources,
    rules: rows.length,
    aggregate: set.aggregate !== undefined && !set.rules.length,
    reportPath: AUDIT_REPORT_FILE,
    elapsedMs: Date.now() - started,
  };
  writeRulesAuditReport(options.cwd, rulesAuditMarkdown(outcome));
  return { status: "done", outcome };
}

// ---------------------------------------------------------------------------
// The Markdown copy

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function ruleCell(id: string): string {
  return id.length <= 44 ? id : `${id.slice(0, 43)}…`;
}

/** The per-rule table body, flagged rules first. */
export function formatRulesAuditRows(rows: readonly RulesAuditRow[]): string {
  const lines = [`${"rule".padEnd(44)}${"judged".padStart(6)}${"flagged".padStart(8)}${"mean".padStart(7)}`];
  for (const row of rows) {
    lines.push(`${ruleCell(row.id).padEnd(44)}${String(row.judged).padStart(6)}${String(row.flagged).padStart(8)}${row.mean.toFixed(2).padStart(7)}`);
  }
  return lines.join("\n");
}

export interface RulesAuditFlag {
  name: string;
  score: number;
}

export interface RulesAuditFileFlags {
  path: string;
  findings: RulesAuditFlag[];
  soft: RulesAuditFlag[];
}

/** Files with findings, worst first (most findings, then the strongest score). */
export function flaggedAuditFiles(results: readonly RulesAuditFileResult[]): RulesAuditFileFlags[] {
  return results
    .map(entry => ({
      path: entry.path,
      findings: entry.verdict.findings.map(finding => ({ name: finding.name, score: finding.violation })),
      soft: (entry.verdict.softFindings ?? []).map(finding => ({ name: finding.name, score: finding.violation })),
    }))
    .filter(entry => entry.findings.length > 0 || entry.soft.length > 0)
    .sort((a, b) => (b.findings.length - a.findings.length)
      || (Math.max(0, ...b.findings.map(finding => finding.score)) - Math.max(0, ...a.findings.map(finding => finding.score)))
      || a.path.localeCompare(b.path));
}

/** One line per file, rule names with scores indented under the path. */
export function formatRulesAuditFiles(results: readonly RulesAuditFileResult[]): string {
  const flagged = flaggedAuditFiles(results);
  if (!flagged.length) return "no file flagged";
  const lines: string[] = [];
  for (const entry of flagged) {
    lines.push(entry.path);
    for (const finding of entry.findings) lines.push(`  ${finding.name} ${finding.score.toFixed(2)}`);
    for (const finding of entry.soft) lines.push(`  ${finding.name} ${finding.score.toFixed(2)} (double-check)`);
  }
  return lines.join("\n");
}

/** The terminal output: summary, the table by rule, the file list, and where the Markdown copy went. */
export function formatRulesAudit(outcome: RulesAuditOutcome): string {
  const lines = [
    `Rules audit: ${outcome.judged} file${outcome.judged === 1 ? "" : "s"} judged as new writes against ${outcome.sources.join(", ")} (${outcome.rules} rule${outcome.rules === 1 ? "" : "s"} in play); ${outcome.leftOut} left out at the --max ${outcome.max} cap; ${outcome.flagged} of ${outcome.judged} flagged.`,
  ];
  if (outcome.aggregate) lines.push("The rules document has no rule headings, so each file is judged against it as one document.");
  lines.push(formatRulesAuditRows(outcome.rows));
  lines.push("flagged files, worst first:");
  lines.push(formatRulesAuditFiles(outcome.results));
  if (outcome.missing.length) lines.push(`not found in the project: ${outcome.missing.join("; ")}.`);
  if (outcome.unreadable.length) lines.push(`not judged (unreadable or empty): ${outcome.unreadable.join("; ")}.`);
  if (outcome.errors.length) lines.push(`judgment failed for ${outcome.errors.length} file${outcome.errors.length === 1 ? "" : "s"}: ${outcome.errors.join("; ")}.`);
  lines.push(`Markdown copy: ${outcome.reportPath}. Nothing was recorded in the rules log.`);
  return lines.join("\n");
}

/** The Markdown copy of one audit run. */
export function rulesAuditMarkdown(outcome: RulesAuditOutcome, date: Date = new Date()): string {
  const lines = [
    "# Rules audit",
    "",
    `- Date: ${date.toISOString()}`,
    `- Paths: ${outcome.paths.join(", ")}`,
    `- Judged: ${outcome.judged} of ${outcome.selected} selected files as new writes (${outcome.leftOut} left out at the --max ${outcome.max} cap)`,
    `- Rules in force: ${outcome.sources.join(", ")} (${outcome.rules} rule${outcome.rules === 1 ? "" : "s"} in play${outcome.aggregate ? ", judged as one document" : ""})`,
    `- Flagged: ${outcome.flagged} of ${outcome.judged} files`,
    "",
    "## By rule",
    "",
    "| rule | judged | flagged | mean |",
    "| --- | ---: | ---: | ---: |",
    ...outcome.rows.map(row => `| \`${row.id}\` | ${row.judged} | ${row.flagged} | ${row.mean.toFixed(2)} |`),
    "",
    "## Flagged files, worst first",
    "",
    ...(flaggedAuditFiles(outcome.results).length
      ? flaggedAuditFiles(outcome.results).map(entry => `- \`${entry.path}\` — ${[
          ...entry.findings.map(finding => `${finding.name} ${finding.score.toFixed(2)}`),
          ...entry.soft.map(finding => `${finding.name} ${finding.score.toFixed(2)} (double-check)`),
        ].join("; ")}`)
      : ["- no file flagged"]),
    "",
  ];
  if (outcome.missing.length) lines.push(`Not found in the project: ${outcome.missing.join("; ")}.`, "");
  if (outcome.unreadable.length) lines.push(`Not judged (unreadable or empty): ${outcome.unreadable.join("; ")}.`, "");
  if (outcome.errors.length) lines.push(`Judgment failed for ${outcome.errors.length} file${outcome.errors.length === 1 ? "" : "s"}: ${outcome.errors.join("; ")}.`, "");
  lines.push("Nothing was recorded in the rules log.");
  return `${lines.join("\n")}\n`;
}

/** Write the Markdown copy and return the path it went to. */
export function writeRulesAuditReport(cwd: string, markdown: string): string {
  const path = join(cwd, ...AUDIT_REPORT_FILE.split("/"));
  mkdirSync(join(cwd, ".pi-warden"), { recursive: true });
  writeFileSync(path, markdown);
  return path;
}

// ---------------------------------------------------------------------------
// Per-rule rows

/** One row per rule asked anywhere in the audit: files judged, files flagged, mean score; flagged first. */
export function ruleAuditRows(results: readonly RulesAuditFileResult[]): RulesAuditRow[] {
  const rows = new Map<string, RulesAuditRow & { sum: number }>();
  for (const entry of results) {
    for (const score of entry.verdict.scores ?? []) {
      const row = rows.get(score.id) ?? { id: score.id, name: score.name, judged: 0, flagged: 0, mean: 0, sum: 0 };
      row.judged += 1;
      row.sum += score.violation;
      if (entry.verdict.findings.some(finding => finding.id === score.id)) row.flagged += 1;
      rows.set(score.id, row);
    }
  }
  return [...rows.values()]
    .map(row => ({ id: row.id, name: row.name, judged: row.judged, flagged: row.flagged, mean: row.judged ? row.sum / row.judged : 0 }))
    .sort((a, b) => (b.flagged - a.flagged) || (b.mean - a.mean) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Bench

/**
 * The one fixed sample the bench judges. It is built in, so no project content is sent for a bench run; only the
 * active rule text travels with it.
 */
export const BENCH_SAMPLE = {
  path: "src/warden-bench-sample.ts",
  content: [
    "// Built-in so /warden bench measures a rules check without sending project content.",
    "export interface Sample { id: string; label: string }",
    "",
    "export function groupByLabel(items: readonly Sample[]): Map<string, Sample[]> {",
    "  const groups = new Map<string, Sample[]>();",
    "  for (const item of items) {",
    "    const bucket = groups.get(item.label);",
    "    if (bucket) bucket.push(item);",
    "    else groups.set(item.label, [item]);",
    "  }",
    "  return groups;",
    "}",
    "",
    "export function labels(items: readonly Sample[]): string[] {",
    "  return [...new Set(items.map((item) => item.label))].sort();",
    "}",
    "",
  ].join("\n"),
};

/** The session counters a bench run diffs; what pi-typesafe's `getUsage()` returns. */
export interface BenchUsage {
  requestsStarted: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface BenchOptions {
  runs: number;
  cwd: string;
  config: RulesConfig;
  set: RuleSet | undefined;
  judge?: Judge | undefined;
  getUsage?: (() => BenchUsage) | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Clock for the latency measurements; injected by tests. */
  now?: () => number;
}

export type BenchResult =
  | { status: "no-judge" }
  | { status: "skipped"; reason: string }
  | {
      status: "done";
      runs: number;
      /** Rules asked per check. */
      asked: number;
      aggregate: boolean;
      /** Checks with at least one finding. */
      flagged: number;
      /** Checks that came back as an error. */
      errors: number;
      /** Requests sent, from `getUsage()`; the checks themselves without it. */
      requests: number;
      p50: number;
      p95: number;
      meanInputTokens?: number;
      costPerCheck?: number;
      costPer100?: number;
    };

/** Nearest-rank percentile of a sorted, non-empty list of numbers. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Judge the built-in sample `runs` times against the active rules, one request at a time so the latency numbers mean
 * something, and report what the checks cost on this machine. With no judge nothing is sent; a sample the rules keep
 * out (`rules.exclude`, `rules.skip`) is reported and never sent either.
 */
export async function runBench(options: BenchOptions): Promise<BenchResult> {
  if (!options.judge) return { status: "no-judge" };
  const target: RulesTarget = { tool: "write", path: BENCH_SAMPLE.path };
  const reason = skipReason(target, options.set, options.config);
  if (reason) return { status: "skipped", reason };
  const now = options.now ?? (() => Date.now());
  const before = options.getUsage?.();
  const timings: number[] = [];
  let flagged = 0;
  let errors = 0;
  let asked = 0;
  let aggregate = false;
  for (let run = 0; run < options.runs; run++) {
    const started = now();
    const verdict = await evaluateRules("write", { path: BENCH_SAMPLE.path, content: BENCH_SAMPLE.content }, {
      cwd: options.cwd, config: options.config, set: options.set, judge: options.judge, timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}),
    });
    timings.push(now() - started);
    if (verdict.source === "error") errors++;
    if (verdict.findings.length) flagged++;
    asked = verdict.asked;
    aggregate = verdict.aggregate;
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const after = options.getUsage?.();
  const usage = before && after ? {
    requests: after.requestsStarted - before.requestsStarted,
    inputTokens: (after.inputTokens - before.inputTokens) / options.runs,
    usd: (after.estimatedUsd - before.estimatedUsd) / options.runs,
  } : undefined;
  return {
    status: "done",
    runs: options.runs,
    asked,
    aggregate,
    flagged,
    errors,
    requests: usage?.requests ?? options.runs,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    ...(usage ? { meanInputTokens: usage.inputTokens, costPerCheck: usage.usd, costPer100: usage.usd * 100 } : {}),
  };
}

/** The bench output: the numbers, and the line that says no project content was sent. */
export function formatBench(result: Extract<BenchResult, { status: "done" }>): string {
  const lines = [
    `Bench: ${result.runs} check${result.runs === 1 ? "" : "s"} of one built-in sample file against the active rules (${result.asked} rule${result.asked === 1 ? "" : "s"} per check${result.aggregate ? ", document judged as one rule" : ""}).`,
    "The sample is built in and no project content is sent, so no confirmation was needed.",
    `Latency: p50 ${result.p50} ms, p95 ${result.p95} ms; requests ${result.requests}${result.errors ? ` (${result.errors} failed)` : ""}.`,
  ];
  if (result.flagged) lines.push(`Findings in ${result.flagged} of ${result.runs} checks (the sample is judged as written code, not as a fixture).`);
  lines.push(result.meanInputTokens === undefined
    ? "Input tokens per check: unknown (no usage counters)."
    : `Input tokens per check: ${Math.round(result.meanInputTokens)} (mean).`);
  const { costPerCheck, costPer100 } = result;
  lines.push(costPerCheck === undefined || costPer100 === undefined
    ? "Estimated cost per check: unknown (no usage counters)."
    : `Estimated cost per check: ${usd(costPerCheck)}; per 100 edits: ${usd(costPer100)}.`);
  return lines.join("\n");
}
