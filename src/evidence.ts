// Structured evidence for the stuck judge: what a run failed on, and what an edit changed, in a shape a judge can
// compare across attempts. The parser is generic: it knows the shapes of common runners and compilers (node test/TAP,
// jest, vitest, pytest, tsc, eslint, cargo, go, a `make test` script, Playwright, Python and Node tracebacks) and
// falls back to an error line (`generic`) or to the head and tail of the raw output (`unparsed`).
//
// Nothing here depends on the Pi runtime, and nothing here redacts: the caller redacts what it keeps, and every string
// in the built evidence is redacted before it enters a request.
import { redact } from "./redact.js";
import type { Attempt } from "./stuck.js";

const MAX_ITEMS = 6;
const DIFF_CAP = 600;
const FALLBACK_HEAD = 300;
const FALLBACK_TAIL = 300;
/** Byte cap for the whole `evidence` object; over it, the oldest runs go first, then the oldest edits. */
export const EVIDENCE_LIMIT = 4096;

/** Test, build, lint and type-check runners, and the ad-hoc scripts a project uses as checks. */
const RUNNER = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|e2e)|(?:npx|pnpm|bunx)\s+(?:tsc|jest|vitest|eslint|playwright)|node\s+--test|pytest|jest|vitest|tsc|eslint|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|make\s+\w+|sbcl\s+--script)\b/;

const EDIT_TOOLS = new Set(["edit", "write"]);

function clip(value: string | undefined, limit = 200): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}
function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => clip(value, 160)).filter(Boolean))];
}
function headTail(text: string, head: number, tail: number): string {
  return text.length <= head + tail ? text : `${text.slice(0, head)}… [${text.length - head - tail} middle chars] …${text.slice(-tail)}`;
}
function tailOf(text: string, limit: number): string {
  return text.length <= limit ? text : `[${text.length - limit} earlier chars] …${text.slice(-limit)}`;
}

/** A failed or check output parsed into failing tests, error lines, a location, a summary and an exit code. */
export type ParsedFailure = {
  format: string;
  failing: string[];
  failing_more?: number;
  errors: string[];
  location?: string;
  summary?: string;
  exit?: number;
};

function exitCode(text: string): number | undefined {
  const matches = [...text.matchAll(/(?:exited with code|exit code:?|exit status|Error)\s+(\d+)\s*$/gim)];
  return matches.length ? Number(matches.at(-1)![1]) : undefined;
}

type ParsedFields = {
  failing?: string[];
  errors?: string[];
  location?: string;
  summary?: string;
};

function result(format: string, fields: ParsedFields, exit: number | undefined): ParsedFailure {
  const failing = uniq(fields.failing ?? []);
  const errors = uniq(fields.errors ?? []);
  return {
    format,
    failing: failing.slice(0, MAX_ITEMS),
    ...(failing.length > MAX_ITEMS ? { failing_more: failing.length - MAX_ITEMS } : {}),
    errors: errors.slice(0, MAX_ITEMS),
    ...(fields.location ? { location: clip(fields.location, 160) } : {}),
    ...(fields.summary ? { summary: clip(fields.summary, 160) } : {}),
    ...(exit !== undefined ? { exit } : {}),
  };
}

/** Lines after index `from`, up to (not including) the first line that matches `stop`. */
function blockAfter(lines: readonly string[], from: number, stop: RegExp): string[] {
  const out: string[] = [];
  for (let i = from + 1; i < lines.length && !stop.test(lines[i]!); i++) out.push(lines[i]!);
  return out;
}

type Parser = (text: string) => ParsedFields | undefined;

const PARSERS: Array<[string, Parser]> = [
  ["tsc", text => {
    const matches = [...text.matchAll(/^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)];
    if (!matches.length) return undefined;
    return { errors: matches.map(m => `${m[4]} ${m[1]}: ${m[5]}`), location: `${matches[0]![1]}:${matches[0]![2]}:${matches[0]![3]}`, summary: `${matches.length} type error${matches.length === 1 ? "" : "s"}` };
  }],
  ["cargo", text => {
    const tests = [...text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map(m => m[1]!);
    const compile = [...text.matchAll(/^error(\[E\d+\])?: (.+)\n\s*--> (\S+)/gm)];
    if (!tests.length && !compile.length) return undefined;
    const panics = [...text.matchAll(/panicked at (\S+?):\n((?:.+\n?){1,3})/g)].map(m => ({ at: m[1]!, msg: m[2]!.split("\n").filter(line => line.trim() && !/^note:/.test(line)).join(" ") }));
    const summary = /^test result: FAILED\. (.+?); finished/m.exec(text)?.[1];
    return {
      failing: tests,
      errors: [...compile.map(m => `${m[1] ?? ""}${m[2]}`), ...panics.map(p => p.msg)],
      location: compile[0]?.[3] ?? panics[0]?.at,
      summary: summary ?? (compile.length ? "build failed" : undefined),
    };
  }],
  ["go", text => {
    const fails = [...text.matchAll(/^\s*--- FAIL: (\S+)/gm)].map(m => m[1]!);
    const build = [...text.matchAll(/^(\S+\.go):(\d+):(\d+): (.+)$/gm)];
    if (!fails.length && !build.length) return undefined;
    const details = [...text.matchAll(/^\s+(\S+_test\.go:\d+): (.+)$/gm)];
    const packages = [...text.matchAll(/^FAIL\t(\S+)(?:\t| \[)/gm)].map(m => m[1]!);
    return {
      failing: fails,
      errors: details.length ? details.map(m => m[2]!) : build.map(m => `${m[1]}: ${m[4]}`),
      location: details[0]?.[1] ?? (build.length ? `${build[0]![1]}:${build[0]![2]}` : undefined),
      summary: packages.length ? `FAIL ${[...new Set(packages)].join(", ")}${/\[build failed\]/.test(text) ? " [build failed]" : ""}` : undefined,
    };
  }],
  ["pytest", text => {
    const failed = [...text.matchAll(/^(?:FAILED|ERROR) (\S+)(?: - (.+))?$/gm)];
    const summary = /(\d+ failed(?:, \d+ passed)?(?:, \d+ errors?)?) in [\d.]+s/.exec(text)?.[1];
    if (!failed.length && !summary) return undefined;
    // The short summary carries one message per failure; the `E` lines are the fallback when it is off (-rN).
    const messages = failed.map(m => m[2]).filter((message): message is string => Boolean(message));
    const eLines = [...text.matchAll(/^E[ \t]+(\S.*)$/gm)].map(m => m[1]!);
    const loc = /^(\S+\.py):(\d+): \w+/m.exec(text);
    return { failing: failed.map(m => m[1]!), errors: messages.length ? messages : eLines.slice(0, 3), location: loc ? `${loc[1]}:${loc[2]}` : undefined, summary };
  }],
  ["eslint", text => {
    const lines = text.split("\n");
    const errors: string[] = [];
    let file: string | undefined;
    for (const line of lines) {
      if (/^\/?\S+\.\w+$/.test(line.trim()) && !/^\s/.test(line)) file = line.trim();
      const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)$/.exec(line);
      if (m && m[3] === "error") errors.push(`${file ? `${file.split("/").slice(-2).join("/")}:${m[1]}` : m[1]} ${m[5]}: ${m[4]}`);
    }
    if (!errors.length) return undefined;
    return { errors, summary: /✖ (\d+ problems? \(.+?\))/.exec(text)?.[1] };
  }],
  ["tap", text => {
    const lines = text.split("\n");
    const failing: string[] = [];
    const errors: string[] = [];
    let location: string | undefined;
    lines.forEach((line, i) => {
      const m = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line);
      if (!m) return;
      failing.push(m[1]!);
      const block = blockAfter(lines, i, /^\s*(?:\.\.\.|ok \d+|not ok \d+|# Subtest)/);
      const errorAt = block.findIndex(candidate => /^\s+error:/.test(candidate));
      if (errorAt >= 0) {
        const inline = /^\s+error:\s*(?:\|-?)?\s*(.*)$/.exec(block[errorAt]!)![1]!;
        const message = inline && !/^\|/.test(inline) ? inline.replace(/^['"]|['"]$/g, "") : block.slice(errorAt + 1).map(candidate => candidate.trim()).filter(candidate => candidate && !/^[+-] (?:actual|expected)|^\^$/.test(candidate)).slice(0, 3).join(" ");
        errors.push(message);
      }
      location ??= /^\s+location:\s*'?(.+?)'?$/m.exec(block.join("\n"))?.[1];
    });
    const spec = [...text.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)].map(m => m[1]!).filter(name => !/^failing tests:?$|^\d+ problems? \(/i.test(name));
    if (!failing.length && !spec.length) return undefined;
    const fail = /^# fail (\d+)$/m.exec(text)?.[1];
    const tests = /^# tests (\d+)$/m.exec(text)?.[1];
    return { failing: failing.length ? failing : spec, errors, location, summary: fail ? `${fail} of ${tests} tests failed` : undefined };
  }],
  ["playwright", text => {
    const heads = [...text.matchAll(/^\s+\d+\) \[([^\]]+)\] › (.+?) ─+$/gm)];
    if (!heads.length) return undefined;
    const lines = text.split("\n");
    const errors: string[] = [];
    lines.forEach((line, i) => {
      if (!/^\s+\d+\) \[[^\]]+\] › /.test(line)) return;
      const block = blockAfter(lines, i, /^\s+\d+\) \[|^\s+\d+ failed$/);
      const error = block.find(candidate => /^\s+Error: /.test(candidate));
      const detail = block.filter(candidate => /^\s+(?:Expected|Received)(?: string)?:/.test(candidate)).map(candidate => candidate.trim());
      if (error) errors.push([error.trim(), ...detail].join(" "));
    });
    const loc = /^\s+at (\S+:\d+:\d+)$/m.exec(text)?.[1];
    const failed = /^\s+(\d+) failed$/m.exec(text)?.[1];
    const passed = /^\s+(\d+) passed/m.exec(text)?.[1];
    return { failing: heads.map(m => `[${m[1]}] ${m[2]}`), errors, location: loc, summary: failed ? `${failed} failed${passed ? `, ${passed} passed` : ""}` : undefined };
  }],
  ["jest", text => {
    const bullets = [...text.matchAll(/^\s*● (.+)$/gm)].map(m => m[1]!.trim()).filter(name => name !== "Console");
    if (!bullets.length) return undefined;
    const lines = text.split("\n");
    const errors: string[] = [];
    lines.forEach((line, i) => {
      if (!/^\s*● /.test(line) || /● Console/.test(line)) return;
      const block = blockAfter(lines, i, /^\s*● |^(?:PASS|FAIL) |^Test Suites:/).map(candidate => candidate.trim()).filter(Boolean);
      const first = block.find(candidate => !/^\d+ \||^>|^\|/.test(candidate));
      const detail = block.filter(candidate => /^(?:Expected|Received):|^[-+] {2,}"/.test(candidate)).slice(0, 4);
      if (first) errors.push([first, ...detail].join(" "));
    });
    const suiteFail = [...text.matchAll(/^FAIL (\S+)/gm)].map(m => m[1]!);
    const failing = bullets.map(bullet => (bullet === "Test suite failed to run" ? `${suiteFail[0] ?? "suite"} (suite failed to run)` : bullet));
    const loc = /at .*?\(?((?:[\w.\-~]+\/)*[\w.\-]+\.[cm]?[jt]sx?:\d+:\d+)\)?/.exec(text)?.[1];
    const summary = /^Tests:\s+(.+)$/m.exec(text)?.[1];
    return { failing, errors, location: loc, summary };
  }],
  ["vitest", text => {
    const fails = [...text.matchAll(/^ FAIL {1,2}(\S+ > .+)$/gm)].map(m => m[1]!);
    const crosses = [...text.matchAll(/^\s+× (.+?)(?: \d+m?s)?$/gm)].map(m => m[1]!);
    if (!fails.length && !crosses.length) return undefined;
    const errors = [...text.matchAll(/^(\w*Error: .+)$/gm)].map(m => m[1]!);
    const loc = /❯ (\S+:\d+:\d+)/.exec(text)?.[1];
    const summary = /^\s+Tests\s+(.+)$/m.exec(text)?.[1];
    return { failing: fails.length ? fails : crosses, errors, location: loc, summary };
  }],
  ["test-script", text => {
    const fails = [...text.matchAll(/^FAIL (\S+?): (.+)$/gm)];
    if (!fails.length) return undefined;
    return { failing: fails.map(m => m[1]!), errors: fails.map(m => m[2]!), summary: /^(\d+ passed, \d+ failed)$/m.exec(text)?.[1] };
  }],
  ["python-traceback", text => {
    if (!/^Traceback \(most recent call last\):/m.test(text)) return undefined;
    const last = [...text.matchAll(/^([\w.]*(?:Error|Exception|Exit|Interrupt)\w*): (.*)$/gm)].at(-1);
    const frames = [...text.matchAll(/^\s+File "(.+?)", line (\d+)/gm)];
    return { errors: last ? [`${last[1]}: ${last[2]}`] : [], location: frames.length ? `${frames.at(-1)![1]}:${frames.at(-1)![2]}` : undefined };
  }],
  ["lisp-condition", text => {
    const m = /^Unhandled (\S+)(?: in thread[^\n]*)?\n(?:\s+\{[^}]*\}>:\n)?\s*(.+)$/m.exec(text);
    if (!m) return undefined;
    return { errors: [`${m[1]}: ${m[2]}`] };
  }],
  ["node-error", text => {
    const m = /^(\w*Error)(?: \[\w+\])?: (.+)$/m.exec(text);
    if (!m || !/^\s+at /m.test(text)) return undefined;
    const loc = /^\s+at (?:.*?\()?((?:file:\/\/)?\S+?:\d+:\d+)\)?$/m.exec(text.split("\n").filter(line => !/node:/.test(line)).join("\n"))?.[1];
    return { errors: [`${m[1]}: ${m[2]}`], location: loc };
  }],
];

/** Parses a failed or check output into failing tests, error lines, a location, a summary and an exit code. */
export function parseFailure(text: string): ParsedFailure {
  const t = text.replace(/\r/g, "");
  const exit = exitCode(t);
  for (const [format, parse] of PARSERS) {
    const found = parse(t);
    if (found) return result(format, found, exit);
  }
  const line = t.split("\n").map(candidate => candidate.trim()).find(candidate => /\b(?:\w*Error|ERR!|error|FAIL(?:ED)?|Exception|panic|fatal|cannot|not found|No such file|denied)\b/.test(candidate) && !/^Command exited with code/.test(candidate));
  if (line) return result("generic", { errors: [line] }, exit);
  return result("unparsed", {}, exit);
}

/**
 * Normalises what changes between identical runs: durations, clock times and dates, addresses, long numbers, thread
 * ids, temp paths, and line:column positions. Other digits stay, so "expected 3" and "expected 4" still differ.
 */
export function normaliseFailureText(value: string | undefined): string {
  return (value ?? "")
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'"):]+/g, "<tmp>")
    .replace(/\bpytest-\d+\b/g, "pytest-#")
    .replace(/\.tmp[0-9a-zA-Z]+/g, ".tmp#")
    .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?Z?/g, "<time>")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<time>")
    .replace(/\brun=[0-9a-f]{6,}\b/g, "run=#")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|µs|us|ns)\b/g, "#t")
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/\(\d+\)/g, "(#)")
    .replace(/\d{5,}/g, "#")
    .replace(/:\d+(?::\d+)?\b/g, ":#")
    .replace(/\(\d+,\d+\)/g, "(#)")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Order-free signature of a failure: which tests failed and with which errors, both normalised. Pass counts are left
 * out, so a run narrowed by a flag (`-x`, a test filter) still matches the full run that failed the same way.
 */
export function failureSignature(parsed: ParsedFailure, raw = ""): string {
  if (parsed.format === "unparsed") return JSON.stringify(["unparsed", normaliseFailureText(raw.slice(-400))]);
  return JSON.stringify([[...parsed.failing].map(normaliseFailureText).sort(), [...parsed.errors].map(normaliseFailureText).sort()]);
}

/** The edit pairs of an `edit` input, as `[oldText, newText]`: the `edits` array, or one top-level pair. */
export function editPairs(input: Record<string, unknown>): Array<[string, string]> {
  if (Array.isArray(input.edits)) return input.edits.map(edit => {
    const pair = (edit ?? {}) as { oldText?: unknown; newText?: unknown };
    return [String(pair.oldText ?? ""), String(pair.newText ?? "")] as [string, string];
  });
  if (input.oldText !== undefined || input.newText !== undefined) return [[String(input.oldText ?? ""), String(input.newText ?? "")]];
  return [];
}

/** Removed and added lines of one edit, as a multiset difference, so unchanged context lines drop out. */
export function lineDelta(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const count = new Map<string, number>();
  for (const line of oldText.split("\n")) count.set(line, (count.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of newText.split("\n")) {
    const n = count.get(line) ?? 0;
    if (n > 0) count.set(line, n - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const [line, n] of count) for (let i = 0; i < n; i++) removed.push(line);
  return { removed, added };
}

/** What an `edit` or `write` changed: the path, the line counts, and a diff capped at `DIFF_CAP` characters. */
export type EditDiff = {
  path: string;
  added: number;
  removed: number;
  removedLines: string[];
  addedLines: string[];
  diff: string;
};

/**
 * The change an `edit` or `write` made. Every string is as the agent wrote it: the caller redacts what leaves the
 * machine. The diff is the whole added and removed text, not a line-by-line patch, because the judge compares one
 * change against the next.
 */
export function editDiff(tool: string, input: Record<string, unknown>): EditDiff {
  const path = String(input.path ?? "?");
  if (tool === "write") {
    const lines = String(input.content ?? "").split("\n");
    const text = lines.map(line => `+${line}`).join("\n");
    return { path, added: lines.length, removed: 0, removedLines: [], addedLines: lines, diff: text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}… [diff capped]` : text };
  }
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  for (const [oldText, newText] of editPairs(input)) {
    const delta = lineDelta(oldText, newText);
    removedLines.push(...delta.removed);
    addedLines.push(...delta.added);
  }
  const text = [...removedLines.map(line => `-${line}`), ...addedLines.map(line => `+${line}`)].join("\n");
  return { path, added: addedLines.length, removed: removedLines.length, removedLines, addedLines, diff: text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}… [diff capped]` : text };
}

/** One run in the evidence: a failed call, or a call that ran a test, build or lint command and passed. */
export type EvidenceRun = {
  n: number;
  outcome: "failed" | "ok";
  parser?: string;
  failing_tests?: string[];
  failing_tests_more?: number;
  errors?: string[];
  location?: string;
  summary?: string;
  output_tail?: string;
  output_head_tail?: string;
  /** The run number of the earlier run whose failure matches, after normalising times, temp paths and line numbers. */
  same_failure_as_run?: number | null;
  exit_code?: number;
};

/** One `edit`/`write` call in the evidence. */
export type EvidenceEdit = {
  n: number;
  path: string;
  added_lines: number;
  removed_lines: number;
  diff: string;
};

/** The counts a judge can weigh without reading every run. */
export type EvidenceDigest = {
  failed_runs: number;
  distinct_failures: number;
  /** Runs whose command repeats an earlier run's command, whatever the outcome. */
  same_command_runs: number[];
  latest_failure_seen_before: boolean;
  edits_between_failed_runs: number;
  information_calls_between_failed_runs: number;
};

export type StuckEvidence = {
  runs: EvidenceRun[];
  edits: EvidenceEdit[];
  digest: EvidenceDigest;
};

/** The parsed view of one failed run, keyed as the judge reads it. Every string is redacted. */
function failureView(output: string, parsed: ParsedFailure): Omit<EvidenceRun, "n" | "outcome" | "same_failure_as_run"> {
  if (parsed.format === "unparsed") return { output_head_tail: redact(headTail(output.trim(), FALLBACK_HEAD, FALLBACK_TAIL)) };
  const view: Omit<EvidenceRun, "n" | "outcome" | "same_failure_as_run"> = { parser: parsed.format };
  if (parsed.failing.length) view.failing_tests = parsed.failing.map(redact);
  if (parsed.failing_more) view.failing_tests_more = parsed.failing_more;
  if (parsed.errors.length) view.errors = parsed.errors.map(redact);
  if (parsed.location) view.location = redact(parsed.location);
  if (parsed.summary) view.summary = redact(parsed.summary);
  if (parsed.format === "generic") view.output_tail = redact(tailOf(output.trim(), FALLBACK_TAIL));
  return view;
}

/** A run plus the private data the digest needs: its signature, and whether its command repeated an earlier one. */
type PendingRun = {
  view: EvidenceRun;
  signature?: string;
  repeatCommand: boolean;
};

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The digest over the runs and edits that are still in the evidence. */
function digestOf(runs: readonly PendingRun[], edits: readonly EvidenceEdit[], informationCalls: readonly number[]): EvidenceDigest {
  const failures = runs.filter(run => run.signature !== undefined).map(run => ({ n: run.view.n, signature: run.signature! }));
  const first = failures[0]?.n ?? 0;
  const last = failures.at(-1)?.n ?? 0;
  const latest = failures.at(-1)?.signature;
  return {
    failed_runs: failures.length,
    distinct_failures: new Set(failures.map(failure => failure.signature)).size,
    same_command_runs: runs.filter(run => run.repeatCommand).map(run => run.view.n),
    latest_failure_seen_before: failures.length > 1 && failures.slice(0, -1).some(failure => failure.signature === latest),
    edits_between_failed_runs: edits.filter(edit => edit.n > first && edit.n < last).length,
    information_calls_between_failed_runs: failures.length ? informationCalls.filter(n => n > first).length : 0,
  };
}

/**
 * Builds the evidence for one stuck window: a run per failed call and per passing check command, an edit per
 * `edit`/`write`, and a digest. The oldest runs are dropped first when the whole object is over `EVIDENCE_LIMIT`
 * bytes, then the oldest edits; the digest is then recomputed over what is left, and a run that pointed at a dropped
 * run points at nothing. The floor is one run plus the digest, which is far under the cap.
 */
export function buildStuckEvidence(attempts: readonly Attempt[], limit: number = EVIDENCE_LIMIT): StuckEvidence {
  let runs: PendingRun[] = [];
  let edits: EvidenceEdit[] = [];
  const informationCalls: number[] = [];
  const firstCommandRun = new Map<string, number>();
  attempts.forEach((attempt, index) => {
    const n = index + 1;
    if (EDIT_TOOLS.has(attempt.tool)) {
      const change = attempt.change;
      if (change) edits.push({ n, path: change.path, added_lines: change.added, removed_lines: change.removed, diff: change.diff });
      return;
    }
    if (!attempt.failed && !RUNNER.test(attempt.call)) {
      if (runs.some(run => run.signature !== undefined)) informationCalls.push(n);
      return;
    }
    const command = normaliseFailureText(attempt.call);
    const seen = firstCommandRun.get(command);
    const run: PendingRun = { view: { n, outcome: attempt.failed ? "failed" : "ok" }, repeatCommand: seen !== undefined };
    if (seen === undefined) firstCommandRun.set(command, n);
    if (attempt.failed) {
      const parsed = parseFailure(attempt.text);
      const signature = failureSignature(parsed, attempt.text);
      const earlier = runs.find(candidate => candidate.signature === signature);
      Object.assign(run.view, failureView(attempt.text, parsed), { same_failure_as_run: earlier?.view.n ?? null });
      if (parsed.exit !== undefined) run.view.exit_code = parsed.exit;
      run.signature = signature;
    }
    runs.push(run);
  });
  for (;;) {
    const present = new Set(runs.map(run => run.view.n));
    const kept: StuckEvidence = {
      runs: runs.map(run => {
        const reference = run.view.same_failure_as_run;
        return reference !== undefined && reference !== null && !present.has(reference) ? { ...run.view, same_failure_as_run: null } : run.view;
      }),
      edits,
      digest: digestOf(runs, edits, informationCalls),
    };
    if (byteLength(kept) <= limit || (runs.length <= 1 && edits.length <= 1)) return kept;
    if (runs.length > 1) runs = runs.slice(1);
    else edits = edits.slice(1);
  }
}
