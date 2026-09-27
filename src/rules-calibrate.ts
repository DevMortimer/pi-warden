import { execFileSync } from "node:child_process";
import { ask } from "pi-typesafe";
import type { Judge } from "pi-typesafe";
import type { RulesConfig } from "./config.js";
import { redact } from "./redact.js";
import { checkReasons } from "./rules-lint.js";
import type { RuleCheck, RulesCheckResult } from "./rules-lint.js";
import type { RuleRecord } from "./rules-log.js";
import { buildRulesReport } from "./rules-report.js";
import type { RuleFlag } from "./rules-report.js";
import {
  buildRulesRequest, EDIT_CONTEXT_LINES, EDIT_TEXT_LIMIT, gitIgnored, matchGlob, MAX_EDITS, scoreRuleAnswers,
} from "./rules.js";
import type { EditView, Rule, RuleAnswer, RuleSet, RulesTarget } from "./rules.js";

/**
 * `/warden rules calibrate`: replay recent git history through the project rules and find the rules that fire on
 * everything or cannot decide. A rule the sample never caught shows `no violation in sample` and is not flagged: the
 * replayed commits are mostly reviewed, compliant code, so a rule that never fires there is often a rule people follow. The core is a plain function of the history and the rule set: the history in, per-rule
 * results out. The caller collects the history (`collectHistory`, read-only `git log -p`), shows the confirm dialog, and
 * writes the scores to the local rules log; nothing here sends anything on its own and nothing here writes a file.
 *
 * Each changed file of each commit becomes one `edit` input: the hunk's removed lines are `oldText`, its added lines are
 * `newText`, and the file after the commit supplies the surrounding context (`before`/`after` around the change). Binary,
 * generated, gitignored files and anything under `rules.exclude` or `rules.skip` are skipped, and the requests are capped
 * at `--max`. `/warden rules tune` reads the flagged rules from the result (and from `/warden rules check`) and asks the
 * session's agent to rewrite them; that prompt is the only thing tune sends.
 */

/** Non-merge commits read when `--commits` is absent. */
export const CALIBRATE_DEFAULT_COMMITS = 20;
/** Requests sent when `--max` is absent. */
export const CALIBRATE_DEFAULT_MAX = 40;
/** The marker a generated source file carries, the standard spelling from every code generator. */
const GENERATED_MARKER = /code generated .* do not edit/i;

/** Paths a build or a package manager writes: their changes say nothing about the rules. */
const GENERATED_PATHS = [
  /(^|\/)(?:node_modules|dist|build|out|vendor|coverage|target)\//,
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|poetry\.lock|go\.sum)$/,
  /\.min\.(?:js|css)$/,
  /(?:^|\/)[^/]+\.map$/,
  /(?:^|\/)[^/]+\.snap$/,
  /(?:^|\/)[^/]+\.jsonl$/,
  /(?:^|\/)[^/]+\.generated\.[^/]+$/,
  /_generated\.[^/]+$/,
  /\.pb\.go$/,
  /_pb2\.py$/,
];

// ---------------------------------------------------------------------------
// History: `git log -p` in, changed files out.

export interface HistoryHunk {
  /** Removed lines of the hunk, newline-joined: the edit's `oldText`. */
  oldText: string;
  /** Added lines of the hunk, newline-joined: the edit's `newText`. */
  newText: string;
  /** The hunk as the diff shows it: context plus removed lines, the file before the change. */
  before: string;
  /** The hunk as the diff shows it: context plus added lines, the file after the change. */
  after: string;
  /** 1-based first line of the hunk on the file's after side. */
  start: number;
  /** Lines the hunk has on the after side (context plus added). */
  count: number;
}

export interface HistoryFile {
  /** Project-relative path with forward slashes, as the commit changed it. */
  path: string;
  /** A binary patch carries no lines to judge. */
  binary: boolean;
  hunks: HistoryHunk[];
  /** The file's text after the commit, when it still exists there; the edit's context. */
  after?: string;
}

export interface HistoryCommit {
  hash: string;
  /** ISO timestamp of the commit. */
  at: string;
  files: HistoryFile[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_HEADER = /^diff --git /;

/** Git quotes a path with spaces or unusual characters; undo the quoting it used. */
function unquoteGitPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith(`"`)) return value;
  const inner = value.slice(1, value.endsWith(`"`) ? -1 : undefined);
  return inner.replace(/\\(\d{1,3}|.)/g, (_match, code: string) => {
    if (/^\d+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return code === "n" ? "\n" : code === "t" ? "\t" : code === "r" ? "\r" : code;
  });
}

/** The `b/` side of a `+++` line, falling back to the `a/` side when the file was deleted. */
function pathFromHeader(line: string, fallback: string | undefined): string | undefined {
  const raw = unquoteGitPath(line.slice(4).trim());
  if (raw === "/dev/null") return fallback;
  return raw.replace(/^[ab]\//, "");
}

/** The `b/` side of a `diff --git a/x b/y` line; quoted pairs are split at the closing quote. */
function pathFromDiffLine(line: string): string | undefined {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith(`"`)) {
    const end = rest.indexOf(`" `, 1);
    if (end < 0) return undefined;
    return unquoteGitPath(rest.slice(end + 2)).replace(/^[ab]\//, "");
  }
  const match = /^.*? b\/(.*)$/.exec(rest);
  return match ? match[1] : undefined;
}

/**
 * The changed files of each commit in one `git log -p` output: one record per commit, one per changed file, and one
 * `oldText`/`newText` pair per hunk. Pure: the caller runs git and passes the text.
 */
export function parseHistory(log: string): HistoryCommit[] {
  const commits: HistoryCommit[] = [];
  for (const chunk of log.split("\x01")) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf("\n");
    const header = (newline < 0 ? chunk : chunk.slice(0, newline)).split("\x02");
    const hash = header[0]!.trim();
    const at = (header[1] ?? "").trim();
    if (!hash) continue;
    const commit: HistoryCommit = { hash, at, files: [] };
    commits.push(commit);
    let file: HistoryFile | undefined;
    let oldSide: string | undefined;
    let hunk: { oldLines: string[]; newLines: string[]; contextBefore: string[]; contextAfter: string[]; start: number; count: number } | undefined;
    const closeHunk = () => {
      if (!file || !hunk) return;
      const before = [...hunk.contextBefore, ...hunk.oldLines, ...hunk.contextAfter].join("\n");
      const after = [...hunk.contextBefore, ...hunk.newLines, ...hunk.contextAfter].join("\n");
      file.hunks.push({
        oldText: hunk.oldLines.join("\n"),
        newText: hunk.newLines.join("\n"),
        before,
        after,
        start: hunk.start,
        count: hunk.count,
      });
      hunk = undefined;
    };
    for (const line of (newline < 0 ? "" : chunk.slice(newline + 1)).split("\n")) {
      if (DIFF_HEADER.test(line)) {
        closeHunk();
        oldSide = undefined;
        file = { path: pathFromDiffLine(line) ?? "unknown", binary: false, hunks: [] };
        commit.files.push(file);
        continue;
      }
      if (!file) continue;
      if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) { file.binary = true; closeHunk(); continue; }
      // `---`/`+++` are file headers only between `diff --git` and the first hunk; inside a hunk they are content.
      const minus = !hunk ? /^--- (.*)$/.exec(line) : null;
      if (minus) { oldSide = unquoteGitPath(minus[1]!).replace(/^[ab]\//, ""); continue; }
      const plus = !hunk ? /^\+\+\+ (.*)$/.exec(line) : null;
      if (plus) {
        const path = pathFromHeader(line, oldSide === "/dev/null" ? undefined : oldSide);
        if (path) file.path = path;
        continue;
      }
      const hunkHeader = HUNK_HEADER.exec(line);
      if (hunkHeader) {
        closeHunk();
        hunk = {
          oldLines: [], newLines: [], contextBefore: [], contextAfter: [],
          start: Number(hunkHeader[3]), count: hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]),
        };
        continue;
      }
      if (!hunk) continue;
      if (line.startsWith("\\")) continue;
      const text = line.slice(1);
      if (line.startsWith("+")) { hunk.newLines.push(text); continue; }
      if (line.startsWith("-")) { hunk.oldLines.push(text); continue; }
      if (line.startsWith(" ") || line === "") {
        if (hunk.newLines.length || hunk.oldLines.length) hunk.contextAfter.push(text);
        else hunk.contextBefore.push(text);
      }
    }
    closeHunk();
  }
  return commits;
}

/**
 * The last `commits` non-merge commits with their patches, and the file after each commit as the edit's context. Read-only:
 * `git log -p` and `git show`, nothing else. Throws when git cannot read the history (no commits yet, not a repository).
 */
export function collectHistory(cwd: string, commits: number): HistoryCommit[] {
  const log = execFileSync("git", ["log", "--no-merges", "-n", String(commits), "-p", "--format=%x01%H%x02%aI"], {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const history = parseHistory(log);
  for (const commit of history) {
    for (const file of commit.files) {
      if (file.binary || !file.hunks.length) continue;
      try {
        const text = execFileSync("git", ["show", `${commit.hash}:${file.path}`], {
          cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
        });
        if (!text.includes("\u0000")) file.after = text;
      } catch {
        // A deleted file, or a path that no longer exists at that commit: the hunk's own before/after images stand.
      }
    }
  }
  return history;
}

// ---------------------------------------------------------------------------
// From a changed file to the guard's `edit` input.

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more chars]`;
}

/** A file the history replay skips, with the same reason wording the live guard reports. */
export interface CalibrateSkip {
  path: string;
  commit: string;
  reason: string;
}

/** Why a changed file is not replayed, or undefined when it is judged. Binary and generated are decided here. */
export function changeSkipReason(file: HistoryFile): string | undefined {
  if (file.binary) return "binary file";
  if (!file.hunks.length) return "no content change";
  const added = file.hunks.map(hunk => hunk.newText).join("\n");
  if (GENERATED_PATHS.some(pattern => pattern.test(file.path))) return "generated file";
  if (GENERATED_MARKER.test(added)) return "generated file";
  return undefined;
}

/** The hunk's `oldText`/`newText` pairs as one `edit` input: the file after the commit around each change is the context. */
export function editViews(file: HistoryFile, contextLines = EDIT_CONTEXT_LINES, maxEdits = MAX_EDITS): { edits: EditView[]; moreEdits: number } {
  const edits: EditView[] = [];
  const kept = file.hunks.filter(hunk => hunk.newText.trim().length > 0);
  const afterLines = file.after === undefined ? undefined : file.after.split("\n");
  for (const [index, hunk] of kept.entries()) {
    if (edits.length >= maxEdits) break;
    let before = hunk.before;
    let after = hunk.after;
    if (afterLines) {
      // Wide window from the file after the commit: the hunk's own images only show three lines around the change.
      const from = Math.max(0, hunk.start - 1 - contextLines);
      const to = Math.min(afterLines.length, hunk.start - 1 + hunk.count + contextLines);
      const oldLines = hunk.oldText ? hunk.oldText.split("\n") : [];
      after = afterLines.slice(from, to).join("\n");
      before = [...afterLines.slice(from, hunk.start - 1), ...oldLines, ...afterLines.slice(hunk.start - 1 + hunk.count, to)].join("\n");
    }
    edits.push({
      id: `edit_${index + 1}`,
      before: redact(clip(before, EDIT_TEXT_LIMIT)),
      after: redact(clip(after, EDIT_TEXT_LIMIT)),
      newText: redact(clip(hunk.newText, EDIT_TEXT_LIMIT)),
    });
  }
  return { edits, moreEdits: Math.max(0, kept.length - maxEdits) };
}

// ---------------------------------------------------------------------------
// The plan: what would be sent, and what is skipped. Nothing is sent here.

export interface CalibrateSample {
  commit: string;
  /** ISO timestamp of the commit the change came from. */
  at: string;
  path: string;
  target: RulesTarget;
}

export interface CalibratePlan {
  /** One `edit` input per judged change, in history order (newest first), at most `maxRequests`. */
  samples: CalibrateSample[];
  /** Samples past `maxRequests`, not sent. */
  dropped: CalibrateSample[];
  /** Requests the run would send: `samples.length`. */
  requests: number;
  skipped: CalibrateSkip[];
}

export interface PlanOptions {
  set: RuleSet;
  config: RulesConfig;
  /** The project root the paths are relative to; also decides `gitignore` skips. */
  cwd: string;
  maxRequests: number;
}

/** Which changed files of the history are judged, in what shape, and which are skipped and why. Pure apart from `git check-ignore`. */
export function planCalibration(history: readonly HistoryCommit[], options: PlanOptions): CalibratePlan {
  const samples: CalibrateSample[] = [];
  const skipped: CalibrateSkip[] = [];
  for (const commit of history) {
    for (const file of commit.files) {
      const skip = changeSkipReason(file);
      if (skip) { skipped.push({ path: file.path, commit: commit.hash, reason: skip }); continue; }
      const excluded = matchGlob(file.path, options.config.exclude);
      if (excluded) { skipped.push({ path: file.path, commit: commit.hash, reason: `excluded from Jev by rules.exclude (${excluded})` }); continue; }
      const skippedByConfig = matchGlob(file.path, options.config.skip);
      if (skippedByConfig) { skipped.push({ path: file.path, commit: commit.hash, reason: `rules do not apply by rules.skip (${skippedByConfig})` }); continue; }
      if (gitIgnored(file.path, options.cwd, true)) { skipped.push({ path: file.path, commit: commit.hash, reason: "gitignored by the project" }); continue; }
      const { edits, moreEdits } = editViews(file);
      if (!edits.length) { skipped.push({ path: file.path, commit: commit.hash, reason: "nothing written in this change" }); continue; }
      samples.push({
        commit: commit.hash,
        at: commit.at,
        path: file.path,
        target: { tool: "edit", path: file.path, edits, ...(moreEdits ? { moreEdits } : {}) },
      });
    }
  }
  const keep = Math.max(0, options.maxRequests);
  return { samples: samples.slice(0, keep), dropped: samples.slice(keep), requests: Math.min(samples.length, keep), skipped };
}

// ---------------------------------------------------------------------------
// The core: history in, per-rule results out.

export interface RuleCalibration {
  id: string;
  name: string;
  /** How often the rule was asked: its `paths` matched a judged file. */
  applied: number;
  fired: number;
  /** fired / applied. */
  firedRate: number;
  meanViolation: number;
  /**
   * True when the sample held no violation of this rule. Not a flag: replayed commits are mostly reviewed, compliant
   * code, so a rule that never fires there is often a rule people follow. The line says `no violation in sample`.
   */
  unfired: boolean;
  /** The `/warden report` flags with the same thresholds, without `never fires`: see `unfired`. */
  flags: RuleFlag[];
}

export interface Calibration {
  rows: RuleCalibration[];
  /** Rules in the current rule set that no judged file reached. */
  neverApplied: Array<{ id: string; name: string }>;
  /** Requests sent. */
  requests: number;
  /** Requests that came back without an answer; their files are not scored. */
  failed: number;
  skipped: CalibrateSkip[];
  /** Judged changes past the cap, not sent. */
  dropped: number;
  /** One record per scored rule, `source: "calibrate"`, for the local rules log. */
  records: RuleRecord[];
  commits: number;
}

export interface CalibrateOptions extends PlanOptions {
  judge?: Judge | undefined;
  timeoutMs: number;
  /** Session id for the log records; replays default to `calibrate`. */
  session?: string;
  signal?: AbortSignal | undefined;
}

/**
 * Replay the history through every rule of the set and return per-rule results, worst first: how often the rule applied,
 * fired, its mean score, and the flags `/warden report` uses. The rules the sample never reached are listed apart. Each
 * score also comes back as a `RuleRecord` with `source: "calibrate"` for the local rules log. Never throws; a request
 * that fails is counted in `failed` and leaves its file unscored. With no judge nothing is sent and nothing is scored.
 */
export async function calibrate(history: readonly HistoryCommit[], options: CalibrateOptions): Promise<Calibration> {
  const plan = planCalibration(history, options);
  const records: RuleRecord[] = [];
  let failed = 0;
  const aggregate = options.set.aggregate !== undefined && !options.set.rules.length
    ? `the project's ${options.set.sources[0]}`
    : undefined;
  if (options.judge) {
    for (const sample of plan.samples) {
      const request = buildRulesRequest(sample.target, options.set);
      const result = await ask(options.judge, { state: request.state, questions: request.questions }, {
        timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!result.ok) { failed++; continue; }
      const { scores } = scoreRuleAnswers(request.applicable, (result.answers ?? {}) as Record<string, RuleAnswer>, options.config, aggregate);
      const softThreshold = options.config.softThreshold ?? 0;
      for (const score of scores) {
        const cutoff = score.threshold ?? options.config.threshold;
        const finding = score.violation >= cutoff;
        records.push({
          at: sample.at,
          session: options.session ?? "calibrate",
          path: sample.path,
          tool: "edit",
          id: score.id,
          name: score.name,
          outcome: score.outcome,
          violation: score.violation,
          threshold: cutoff,
          finding,
          ...(!finding && softThreshold > 0 && score.violation >= softThreshold ? { soft: true as const } : {}),
          source: "calibrate",
        });
      }
    }
  }
  const stamps = history.map(commit => Date.parse(commit.at)).filter(stamp => Number.isFinite(stamp));
  const until = stamps.length ? Math.max(...stamps) : Date.now();
  const since = stamps.length ? Math.min(...stamps) : until;
  const days = Math.max(1, Math.ceil((until - since) / (24 * 60 * 60 * 1000)) + 1);
  const report = buildRulesReport(records, {
    days,
    now: until + 1,
    currentRules: options.set.rules.map(rule => ({ id: rule.id, name: rule.name })),
    source: "calibrate",
  });
  return {
    rows: report.rows.map(row => ({
      id: row.id, name: row.name, applied: row.judged, fired: row.fired, firedRate: row.firedRate,
      meanViolation: row.meanViolation,
      // `never fires` means something different in the live report; on a replayed history it mostly means people
      // follow the rule, so it is not carried as a flag here.
      unfired: row.fired === 0,
      flags: row.flags.filter(flag => flag !== "never fires"),
    })),
    neverApplied: report.unheard,
    requests: options.judge ? plan.requests : 0,
    failed,
    skipped: plan.skipped,
    dropped: plan.dropped.length,
    records,
    commits: history.length,
  };
}

// ---------------------------------------------------------------------------
// The report.

function shortName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length <= 40 ? clean : `${clean.slice(0, 39)}…`;
}

/** One line per rule, worst first: how often it applied and fired, the mean score, and the flags; then the unheard rules. */
export function formatCalibration(result: Calibration): string {
  const lines: string[] = [];
  const parts = [
    `${result.requests} request${result.requests === 1 ? "" : "s"}`,
    `${result.commits} commit${result.commits === 1 ? "" : "s"}`,
  ];
  if (result.failed) parts.push(`${result.failed} without an answer`);
  if (result.skipped.length) parts.push(`${result.skipped.length} change${result.skipped.length === 1 ? "" : "s"} skipped`);
  if (result.dropped) parts.push(`${result.dropped} past the cap, not sent`);
  lines.push(`Rules calibrate: ${parts.join(", ")}.`);
  if (result.rows.length) {
    lines.push("Worst first:");
    result.rows.forEach((row, index) => {
      const notes = [...(row.unfired ? ["no violation in sample"] : []), ...row.flags];
      const suffix = notes.length ? ` · ${notes.join(" · ")}` : "";
      lines.push(`${index + 1}. ${shortName(row.name)} · ${row.applied} applied · ${row.fired} fired ${Math.round(row.firedRate * 100)}% · mean ${row.meanViolation.toFixed(2)}${suffix}`);
    });
  } else {
    lines.push("No rule was applied to any file in the sample.");
  }
  if (result.neverApplied.length) {
    lines.push(`Never applied to any file in the sample (${result.neverApplied.length}): ${result.neverApplied.map(rule => shortName(rule.name)).join(", ")}.`);
  }
  if (result.skipped.length) {
    lines.push(`Skipped: ${result.skipped.map(skip => `${skip.path} (${skip.reason})`).join(", ")}.`);
  }
  lines.push(`${result.records.length} score${result.records.length === 1 ? "" : "s"} saved to the local rules log with source "calibrate"; /warden report counts them apart from live verdicts.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The confirm dialog and the `--yes` path.

export type CalibrateGate = { kind: "send" } | { kind: "confirm" } | { kind: "refuse"; reason: string };

/**
 * Nothing leaves the machine before the user sees what it is: a UI shows the confirm dialog, and a headless run needs the
 * explicit `--yes`. `--yes` stands in for the dialog in either case.
 */
export function calibrateGate(options: { hasUI: boolean; yes: boolean }): CalibrateGate {
  if (options.yes) return { kind: "send" };
  if (options.hasUI) return { kind: "confirm" };
  return { kind: "refuse", reason: "Nothing was sent: a headless run needs an explicit --yes to send calibration requests." };
}

const NOTICE_SAMPLES = 3;
const NOTICE_SAMPLE_LIMIT = 200;

/** What the confirm dialog shows: how many requests go out and what leaves the machine, as redacted diff samples. */
export function calibrationNotice(plan: CalibratePlan): string {
  const lines = [
    `${plan.requests} request${plan.requests === 1 ? "" : "s"} will go to the judgment backend, one per changed file in the sample. Each carries the project-relative path, the added and removed lines of the change with about ${EDIT_CONTEXT_LINES * 2} lines of the file after the commit around them, and the rule text. Everything is redacted first. The diffs, first ${Math.min(NOTICE_SAMPLES, plan.samples.length)} of ${plan.requests}:`,
    "",
  ];
  for (const sample of plan.samples.slice(0, NOTICE_SAMPLES)) {
    const edit = sample.target.edits?.[0];
    const removed = edit?.before ? edit.before.split("\n").length : 0;
    lines.push(`${sample.path} (${sample.commit.slice(0, 8)}):`);
    if (edit) lines.push(`  ${clip((edit.newText ?? "").replace(/\n/g, "\n  "), NOTICE_SAMPLE_LIMIT)}`);
    lines.push(`  (${removed} lines around the change)`);
    lines.push("");
  }
  if (plan.dropped.length) lines.push(`${plan.dropped.length} further change${plan.dropped.length === 1 ? "" : "s"} ${plan.dropped.length === 1 ? "stays" : "stay"} outside the --max cap and ${plan.dropped.length === 1 ? "is" : "are"} not sent.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// `/warden rules tune`: the flagged rules and the one prompt that asks for rewrites.

export interface TuneRule {
  id: string;
  name: string;
  /** The rule's current text as the agent sees it in the rules file. */
  body: string;
  /** One line per flag: why this rule is up for a rewrite. */
  reasons: string[];
}

/** The rules the latest calibrate flagged, plus the ones `/warden rules check` flagged this session, with the reasons. */
export function tuneTargets(options: { calibration?: Calibration | undefined; check?: RulesCheckResult | undefined; rules: readonly Rule[] }): TuneRule[] {
  const targets = new Map<string, TuneRule>();
  const ruleById = new Map(options.rules.map(rule => [rule.id, rule]));
  const add = (id: string, reason: string) => {
    const rule = ruleById.get(id);
    if (!rule) return;
    const entry = targets.get(id) ?? { id, name: rule.name, body: redact(rule.body), reasons: [] };
    entry.reasons.push(reason);
    targets.set(id, entry);
  };
  for (const row of options.calibration?.rows ?? []) {
    // Only noise and indecision ask for a rewrite. A rule with no violation in the sample is not flagged: replayed
    // commits are mostly compliant code, so it is often a rule people follow.
    const flags = row.flags.filter(flag => flag === "fires on everything" || flag === "undecided");
    if (!flags.length) continue;
    add(row.id, `flagged ${flags.join(", ")} in the latest calibrate: ${row.applied} applied, ${row.fired} fired (${Math.round(row.firedRate * 100)}%), mean ${row.meanViolation.toFixed(2)}`);
  }
  for (const flagged of options.check?.attention ?? []) {
    add(flagged.id, `flagged by the rules check: ${checkReasons(flagged as RuleCheck).join("; ")}`);
  }
  return [...targets.values()];
}

/** One prompt for the session's agent: each flagged rule, why it was flagged, and the ask for a concrete rewrite. */
export function buildTunePrompt(targets: readonly TuneRule[]): string {
  const lines = [
    "Rewrite the flagged project rules in `pi-warden.md` with your file tools, so the user can review the edit. Each `#` heading is one rule; the text under it is what the guard judges against.",
    "",
    "For each rule below, rewrite it so a violation is concrete and judgeable from the content of one changed file alone: name the exact pattern that makes a change a violation (a call, a literal, a comment or naming shape, a file layout), and keep or add a `paths:` line when it only holds for some files. Keep a `threshold:` or `severity:` header line when the rule still needs one. When no single-file pattern exists, remove the rule instead of leaving it vague. Change only the rules named here; leave the rest of the file as it is.",
    "",
  ];
  for (const target of targets) {
    lines.push(`## ${target.name} (${target.id})`, `Flagged: ${target.reasons.join("; ")}.`, "Current text:", target.body, "");
  }
  return lines.join("\n").trimEnd();
}

export type TuneRequest = { prompt: string } | { reason: string };

/** The prompt to send, or the reason to say so and send nothing when no rule is flagged. */
export function tuneRequest(options: { calibration?: Calibration | undefined; check?: RulesCheckResult | undefined; rules: readonly Rule[] }): TuneRequest {
  const targets = tuneTargets(options);
  if (targets.length) return { prompt: buildTunePrompt(targets) };
  if (!options.rules.length) return { reason: "Nothing to tune: there are no separate rules here to rewrite." };
  if (!options.calibration && !options.check) return { reason: "Nothing flagged: run /warden rules calibrate or /warden rules check first, then /warden rules tune." };
  return { reason: "Nothing flagged: the latest calibrate and the rules check found no rule that needs a rewrite. Nothing was sent." };
}
