import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ask, choice, noul } from "pi-typesafe";
import type { IntegrationErrorCode, Judge } from "pi-typesafe";
import type { DoneGuardConfig, VisualToolsConfig } from "./config.js";
import { isReadOnlyCommand, stripDataText } from "./guard.js";
import { redact } from "./redact.js";
import { matchGlob } from "./rules.js";
import { commandOf } from "./tools.js";
import { DEFAULT_TEMPLATES, doneTokens, renderTemplate } from "./widget.js";

export type ToolOutcome = "read" | "mutation" | "check-pass" | "check-fail" | "unknown";

/** A check runner invocation: a package-manager script, or a test, type-check, lint, or build tool. */
const RUNNER_SOURCE = String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify|ci)\b|(?:npx|pnpm|bunx)\s+(?:tsc|jest|vitest|mocha|eslint|biome|prettier\s+--check)\b|pytest|jest|vitest|mocha|tsc|eslint|biome\s+check|ruff|mypy|flake8|pylint|black\s+--check|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|make\s+(?:test|check|lint|build)|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build)|dotnet\s+(?:test|build)|node\s+--test|deno\s+(?:test|check|lint)|rspec|rake\s+test|mix\s+test|phpunit|swift\s+(?:test|build)|xcodebuild\s+test|ctest|zig\s+(?:test|build)`;

/** A runner name anywhere in the text: enough to say the run names a runner, never enough to count it as a check. */
const CHECK_COMMAND = new RegExp(`\\b(?:${RUNNER_SOURCE})\\b`);

/** The same runner anchored at the start of a shell segment: only then does the command actually run one. */
const RUNNER_START = new RegExp(`^(?:${RUNNER_SOURCE})\\b`);

/** Launch wrappers that may sit between the start of a segment and its runner. */
const WRAPPER_HEAD = /^(?:timeout\s+\S+|time(?:\s+-p)?|env|npx|pnpm\s+exec|bunx|yarn|uv\s+run|poetry\s+run|python\s+-m)\s+/;
const ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/** The runner's own report that nothing ran: a run of zero tests proves nothing about the change. */
const ZERO_TESTS = /Tests:\s+0 total\b|No tests found|\[no tests to run\]|running 0 tests\b|\u2139 tests 0\b|no tests ran/i;

/** A write or edit whose resolved path lies outside the project root (a scratch file, a note in the home directory). */
function isOutsideProject(input: Record<string, unknown>, cwd: string): boolean {
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
  if (!path) return false;
  const rel = relative(resolve(cwd), resolve(cwd, path));
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

/** Shell segments with the separator that follows each. The `&` of a `2>&1` redirect is not a separator. */
interface ShellPiece { text: string; sep: string | undefined; next: string }

function commandPieces(command: string): ShellPiece[] {
  const separators = /\n|;|&&|\|\||\||(?<!>)&/g;
  const pieces: ShellPiece[] = [];
  let start = 0;
  for (const match of command.matchAll(separators)) {
    const index = match.index ?? 0;
    pieces.push({ text: command.slice(start, index), sep: match[0], next: "" });
    start = index + match[0].length;
  }
  pieces.push({ text: command.slice(start), sep: undefined, next: "" });
  return pieces.map((piece, index) => ({ ...piece, next: pieces[index + 1]?.text ?? "" }));
}

/** Whether a check runner starts the segment, after environment assignments and launch wrappers. */
function startsRunner(segment: string): boolean {
  let rest = segment.replace(/^\(+/, "").replace(/\)+$/, "").trim();
  for (;;) {
    rest = rest.replace(ENV_ASSIGN, "").trimStart();
    const wrapper = WRAPPER_HEAD.exec(rest);
    if (!wrapper) break;
    rest = rest.slice(wrapper[0].length);
  }
  return RUNNER_START.test(rest);
}

/** The first segment a check runner starts, and the separator after it when that separator can hide its exit code. */
function runnerPiece(command: string): { hides: string | undefined; nextHead: string } | undefined {
  for (const piece of commandPieces(command)) {
    if (!startsRunner(piece.text)) continue;
    // A pipe (whose exit code is the last command's), `||`, and `;` with more commands all mask the runner's exit code.
    // A redirect to a file does not, and `&&` short-circuits on the runner's own status.
    const hides = piece.sep === "||" ? "||"
      : piece.sep === "|" && !/\bpipefail\b/.test(command) ? "|"
      : piece.sep === ";" && piece.next.trim() ? ";"
      : undefined;
    return { hides, nextHead: piece.next.trim().split(/\s+/)[0] ?? "" };
  }
  return undefined;
}

/**
 * What a finished tool call contributes to the run's evidence. Only write/edit inside the project count as code changes: shell side effects
 * (deleting a temp dir, installing a package) are too varied to demand a test run for. Custom tools are unknown. A shell command counts as a
 * check only when a check runner starts one of its shell segments; a runner name in an argument (`grep -n jest package.json`) does not.
 */
export function classifyToolResult(tool: string, input: Record<string, unknown>, failed: boolean, output?: string, cwd?: string): ToolOutcome {
  return classify(tool, input, failed, output, cwd).outcome;
}

/** Why a run that names a check runner is not counted as a check (for one trace detail); undefined when it counts or names no runner. */
export function checkSkipReason(tool: string, input: Record<string, unknown>, failed: boolean, output?: string, cwd?: string): string | undefined {
  return classify(tool, input, failed, output, cwd).reason;
}

interface Classification { outcome: ToolOutcome; reason?: string }

function classify(tool: string, input: Record<string, unknown>, failed: boolean, output: string | undefined, cwd: string | undefined): Classification {
  if (tool === "write" || tool === "edit") return { outcome: cwd !== undefined && isOutsideProject(input, cwd) ? "unknown" : "mutation" };
  if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") return { outcome: "read" };
  const view = commandOf(tool, input);
  if (!view) return { outcome: "unknown" };
  const namesRunner = CHECK_COMMAND.test(view.command);
  // A test runner launched from inside a script (ctx_execute JavaScript, a Python wrapper) leaves no runner name in the
  // command text, but its output still carries the runner's summary. Judge that summary instead.
  const summary = output === undefined ? undefined : checkSummary(output);
  const runner = view.shell ? runnerPiece(view.command) : undefined;
  if (runner !== undefined || summary !== undefined) {
    if (output !== undefined && ZERO_TESTS.test(output.slice(-6000))) return { outcome: "unknown", reason: "runner summary reports zero tests" };
    // The runner's own summary wins over the exit code.
    if (summary === "fail") return { outcome: "check-fail" };
    if (summary === "pass") return { outcome: "check-pass" };
    if (runner !== undefined) {
      if (runner.hides !== undefined) return { outcome: "unknown", reason: `exit code hidden by ${runner.hides}${runner.nextHead ? ` ${runner.nextHead}` : ""}; no runner summary` };
      return { outcome: failed ? "check-fail" : "check-pass" };
    }
  }
  const read: Classification = { outcome: view.shell && isReadOnlyCommand(view.command) ? "read" : "unknown" };
  return namesRunner ? { ...read, reason: "runner name in an argument does not make a check" } : read;
}

/**
 * Recognise a test/type-check runner's own summary in tool output: node:test, jest/vitest, pytest, cargo, go test,
 * tsc. Returns the outcome the summary reports, or undefined when no runner summary is present.
 */
export function checkSummary(output: string): "pass" | "fail" | undefined {
  const tail = output.slice(-6000);
  const nodeTest = /\u2139 (?:tests|pass|fail) \d+/.test(tail) && /\u2139 fail (\d+)/.exec(tail);
  if (nodeTest) return Number(nodeTest[1]) > 0 ? "fail" : "pass";
  const jest = /^Tests:\s+(?:(\d+) failed, )?.*?\d+ total/m.exec(tail);
  if (jest) return jest[1] && Number(jest[1]) > 0 ? "fail" : "pass";
  const pytest = /^=+ .*?(?:(\d+) failed|(\d+) error).*?in [\d.]+s/m.exec(tail) ?? /^=+ (\d+) passed.*? in [\d.]+s =+$/m.exec(tail);
  if (pytest) return /\d+ (?:failed|error)/.test(pytest[0]) ? "fail" : "pass";
  const cargoOrGo = /^test result: (ok|FAILED)\./m.exec(tail) ?? /^(ok|FAIL)\s+\S+\s+[\d.]+s$/m.exec(tail);
  if (cargoOrGo) return cargoOrGo[1] === "ok" ? "pass" : "fail";
  if (/\berror TS\d{4}:/.test(tail)) return "fail";
  return undefined;
}

export interface RunEvidence {
  mutations: number;
  checks: Array<{ call: string; passed: boolean }>;
  checksBeforeMutation?: number;
  /** The last UI file changed with no visual check after it. Tests and builds do not show what a page looks like. */
  unseenUi?: string;
}

export function emptyEvidence(): RunEvidence {
  return { mutations: 0, checks: [] };
}

export function recordOutcome(evidence: RunEvidence, outcome: ToolOutcome, input: Record<string, unknown>, tool = "bash"): string | undefined {
  if (outcome === "mutation") {
    evidence.mutations++;
    evidence.checksBeforeMutation = evidence.checks.length;
  }
  const command = commandOf(tool, input)?.command;
  const call = command !== undefined ? redact(command.length > 200 ? `${command.slice(0, 200)}…` : command) : undefined;
  if (outcome === "check-pass" || outcome === "check-fail") evidence.checks.push({ call: call ?? "check", passed: outcome === "check-pass" });
  return call;
}

// `{a,b}` alternatives, which the rules glob matcher does not read, as in the default `*.{css,html,…}` UI glob.
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  return match[1]!.split(",").flatMap(option => expandBraces(pattern.slice(0, match.index) + option + pattern.slice(match.index + match[0].length)));
}

/** A path matches when some glob matches it and no `!` glob does. */
export function isUiFile(path: string, globs: readonly string[]): boolean {
  const normalised = path.replace(/\\/g, "/");
  const include = globs.filter(glob => !glob.startsWith("!")).flatMap(expandBraces);
  const exclude = globs.filter(glob => glob.startsWith("!")).map(glob => glob.slice(1)).flatMap(expandBraces);
  return matchGlob(normalised, include) !== undefined && matchGlob(normalised, exclude) === undefined;
}

function shellSegments(command: string): string[] {
  return command.split(/\n|;|&&|\|\||\||&/).map(part => part.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")).filter(Boolean);
}

const BROWSER_HEADS = new Set(["chrome", "chromium", "google-chrome"]);

/**
 * Heads that also run work the user never sees. `flutter test` shows the UI only for integration or golden tests, and
 * `idb` only through its `screenshot` and `ui` subcommands; `idb list-targets` or a unit test proves nothing on screen.
 * A browser binary shows the page only when a command word asks for it (`chrome --headless --screenshot`), not for `--version`.
 */
function headShows(head: string, args: readonly string[]): boolean {
  if (/(?:^|\s)flutter test$/.test(head)) return args.some(arg => /(?:^|\/)integration_test(?:\/|$)/.test(arg) || arg.includes("golden"));
  if (head === "idb") return args.some(arg => arg === "screenshot" || arg === "ui");
  if (BROWSER_HEADS.has(head)) return false;
  return true;
}

/**
 * Whether a successful tool call showed the rendered UI to the agent: an image in the result, a page text snapshot, a browser or device test
 * run, or reading an image file. A test run proves the code runs; only this proves what the user will see. A screenshot command that only
 * writes a file shows nothing until something reads that file.
 */
export function isVisualCheck(tool: string, input: Record<string, unknown>, failed: boolean, visual: VisualToolsConfig, content?: ReadonlyArray<{ type: string }>): boolean {
  if (failed) return false;
  if (content?.some(part => part.type === "image")) return true;
  if (tool === "read") {
    const path = typeof input.path === "string" ? input.path.toLowerCase() : "";
    return visual.images.some(extension => path.endsWith(`.${extension.toLowerCase()}`));
  }
  const view = commandOf(tool, input);
  if (view) {
    if (!view.shell) return false;
    // A PR body, commit message, or heredoc note that mentions a screenshot is not one; nor is a `screenshots/` path.
    const segments = shellSegments(stripDataText(view.command).text.toLowerCase());
    const heads = visual.commands.map(command => command.toLowerCase());
    const words = new Set(visual.commandWords.map(word => word.toLowerCase()));
    // A command word counts only after a visual head: `grep -rn screenshot src` searches for the word.
    return segments.some(segment => heads.some(head => {
      if (segment !== head && !segment.startsWith(`${head} `)) return false;
      const args = segment.slice(head.length).split(/\s+/).filter(Boolean);
      return headShows(head, args) || args.some(arg => words.has(arg.replace(/^-+/, "").replace(/=.*$/, "")));
    }));
  }
  // An MCP proxy (`mcp`, `mcp__chrome_devtools`) names the real tool in its input.
  const names = [tool, /^mcp(?:__|$)/.test(tool) && typeof input.tool === "string" ? input.tool : ""].map(name => name.toLowerCase());
  return names.some(name => name && visual.tools.some(word => name.includes(word.toLowerCase())));
}

/** Paths a successful call changed that match the UI globs: `write`/`edit` paths, plus files a shell command writes. */
export function recordUi(evidence: RunEvidence, changed: readonly string[], visual: boolean, globs: readonly string[]): void {
  const ui = changed.filter(path => isUiFile(path, globs));
  if (ui.length) evidence.unseenUi = ui[ui.length - 1]!;
  else if (visual) delete evidence.unseenUi;
}

interface MessageLike { role: string; content?: unknown; stopReason?: unknown }

/** Text of the run's final assistant message, when it ended normally with text (not a tool call, error, or abort). */
export function finalAssistantText(messages: ReadonlyArray<MessageLike>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== undefined && message.stopReason !== "stop") return undefined;
    const content = message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? (content as Array<{ type?: unknown; text?: unknown }>).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text as string).join("\n")
      : "";
    return text.trim() || undefined;
  }
  return undefined;
}

/** The checks that ran after the latest change: only those ran on the code as it stands now. Earlier ones stay as history. */
export function freshChecks(evidence: RunEvidence): RunEvidence["checks"] {
  return evidence.checks.slice(evidence.checksBeforeMutation ?? 0);
}

/** The check only makes sense when something changed and nothing proved that change works. */
export function needsDoneCheck(evidence: RunEvidence): boolean {
  return (evidence.mutations > 0 && !freshChecks(evidence).some(check => check.passed)) || evidence.unseenUi !== undefined;
}

export const doneQuestions = {
  claims_done: noul(
    "Does `final_message` present the requested work as finished or working?",
    {
      true: "Yes: it says the task is done, fixed, implemented, complete, or working, or summarises the result as final.",
      false: "No: it reports partial progress, names remaining work, reports a blocker, asks the user a question, or only describes a plan.",
    },
  ),
  claims_verified: noul("Does `final_message` claim that tests, a build, or other checks were run and passed?"),
  verification_applies: noul(
    "Would running the project's tests, build, or lint be a meaningful way to check the work that `task` asks for?",
    {
      true: "Yes: `task` changes or adds code, configuration, or build logic that such checks exercise.",
      false: "No: `task` is about documentation, prose, file housekeeping, deleting or moving files, answering a question, or something the project's checks would not cover.",
    },
  ),
  outcome: choice("What does `final_message` report about `task`?", {
    complete: "The work is finished",
    partial: "Progress was made and remaining work is named",
    blocked: "A blocker is reported or the user is asked something",
    other: "None of these",
  }),
};

export interface DoneJudgment {
  claimsDone: number;
  claimsVerified: number;
  verificationApplies: number;
  outcome: "complete" | "partial" | "blocked" | "other";
  model: string;
  elapsedMs: number;
}

export interface DoneVerdict {
  unverified: boolean;
  /** The message says checks passed but none ran: stronger than an unverified claim. */
  falseClaim: boolean;
  reasons: string[];
  evidence: RunEvidence;
  judgment?: DoneJudgment;
  /** Set when the claim follows a UI change that nothing showed on screen. */
  unseenUi?: string;
  error?: string;
  errorCode?: IntegrationErrorCode;
}

export function buildDoneRequest(task: string | undefined, finalMessage: string, evidence: RunEvidence) {
  return {
    state: {
      task: task?.trim() ? (task.trim().length > 1500 ? `${task.trim().slice(0, 1500)}…` : task.trim()) : "(no user request recorded in this session)",
      final_message: redact(finalMessage.length > 2000 ? `${finalMessage.slice(0, 2000)}…` : finalMessage),
      run: { file_changes: evidence.mutations, checks_run: freshChecks(evidence).map(check => `${check.call} → ${check.passed ? "passed" : "failed"}`) },
    },
    questions: doneQuestions,
  };
}

const APPLIES_THRESHOLD = 0.5;

export interface DoneOptions {
  config: DoneGuardConfig;
  judge: Judge;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export async function evaluateDone(task: string | undefined, finalMessage: string, evidence: RunEvidence, options: DoneOptions): Promise<DoneVerdict> {
  const result = await ask(options.judge, buildDoneRequest(task, finalMessage, evidence), { timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
  if (!result.ok) return { unverified: false, falseClaim: false, reasons: [], evidence, error: result.error, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
  const judgment: DoneJudgment = {
    claimsDone: result.answers.claims_done.noul,
    claimsVerified: result.answers.claims_verified.noul,
    verificationApplies: result.answers.verification_applies.noul,
    outcome: result.answers.outcome.choice,
    model: result.model,
    elapsedMs: result.elapsedMs,
  };
  const claimed = judgment.claimsDone >= options.config.claimsDone && judgment.outcome !== "blocked";
  const checks = freshChecks(evidence);
  const codeUnverified = claimed && evidence.mutations > 0 && !checks.some(check => check.passed) && judgment.verificationApplies >= APPLIES_THRESHOLD;
  // The file type already says a visual check applies, so `verification_applies` (about tests and builds) does not gate it.
  const unseenUi = claimed ? evidence.unseenUi : undefined;
  const unverified = codeUnverified || unseenUi !== undefined;
  // Total checks, not fresh: a false claim is nothing ever run in the run; a stale check is unverified, not a lie.
  const falseClaim = unverified && judgment.claimsVerified >= 0.7 && evidence.checks.length === 0;
  const reasons: string[] = [];
  if (codeUnverified) {
    const failed = checks.filter(check => !check.passed).length;
    reasons.push(`reports completion (${judgment.claimsDone.toFixed(2)}) after ${evidence.mutations} file change${evidence.mutations === 1 ? "" : "s"} with ${failed ? `${failed} failed check${failed === 1 ? "" : "s"} and no passing one` : "no test, build, or lint run since the last change"}`);
  }
  if (unseenUi !== undefined) reasons.push(codeUnverified ? "no browser, screenshot, or device check since the last UI change" : `reports completion (${judgment.claimsDone.toFixed(2)}) after a UI change with no browser, screenshot, or device check since`);
  if (falseClaim) reasons.push(`claims checks passed (${judgment.claimsVerified.toFixed(2)}) but none ran`);
  return { unverified, falseClaim, reasons, evidence, judgment, ...(unseenUi !== undefined ? { unseenUi } : {}) };
}

/** The last local URL a tool result printed: the page the agent was told to open lives there. */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s)\]"']*)?/gi;

export function localUrl(text: string): string | undefined {
  let last: string | undefined;
  for (const match of text.matchAll(LOCAL_URL)) last = match[0];
  return last;
}

function readRootFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/** The package manager the project's lock file names, else npm. */
function packageManager(root: string): string {
  for (const [lock, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"]] as const) {
    if (existsSync(join(root, lock))) return manager;
  }
  return "npm";
}

/**
 * The project's own check command: the `check` then `test` script of its `package.json`, else the same Makefile targets. Only files in the
 * project root are read; a project with neither keeps the generic nudge.
 */
export function projectCheckCommand(root: string): string | undefined {
  const pkg = readRootFile(join(root, "package.json"));
  const scripts: Record<string, unknown> = (() => {
    if (!pkg) return {};
    try {
      const parsed: unknown = JSON.parse(pkg);
      const value = (parsed as { scripts?: unknown }).scripts;
      return value && typeof value === "object" ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  })();
  for (const name of ["check", "test"]) {
    if (typeof scripts[name] === "string") return `${packageManager(root)} run ${name}`;
  }
  for (const name of ["check", "test"]) {
    if (new RegExp(`^${name}\\s*:`, "m").test(readRootFile(join(root, "Makefile")))) return `make ${name}`;
  }
  return undefined;
}

/** Session facts the nudge can name instead of a generic ask. */
export interface NudgeHint {
  /** The last check command that passed earlier in this session in this project. */
  lastCheck?: string | undefined;
  /** The project's own check command (`projectCheckCommand`). */
  projectCheck?: string | undefined;
  /** The last local URL a tool result printed in this session. */
  localUrl?: string | undefined;
}

/** Follow-up for the agent: verify or say plainly that nothing was verified. */
export function doneNudge(verdict: DoneVerdict, hint: NudgeHint = {}): string {
  const failed = freshChecks(verdict.evidence).filter(check => !check.passed);
  const codeUnverified = verdict.unseenUi === undefined
    || (verdict.evidence.mutations > 0 && !freshChecks(verdict.evidence).some(check => check.passed) && (verdict.judgment?.verificationApplies ?? 1) >= APPLIES_THRESHOLD);
  const command = hint.lastCheck ?? hint.projectCheck;
  const detail = failed.length
    ? `The last check that ran failed: ${failed.at(-1)!.call}. Fix that first.`
    : command !== undefined
      ? `Run ${redact(command)} on what you changed.`
      : "Run the project's tests, build, or lint (whatever exists) on what you changed.";
  const code = codeUnverified ? ` ${detail} Then report the actual result. If no check exists or can run, say so explicitly instead of presenting the work as done.` : "";
  const open = hint.localUrl !== undefined ? `Open ${redact(hint.localUrl)} in a browser` : "Open it in a browser";
  const ui = verdict.unseenUi !== undefined ? ` You changed \`${redact(verdict.unseenUi)}\` but did not look at the result. ${open} or take a screenshot before calling it done, or say it is unverified.` : "";
  return `pi-warden: ${verdict.reasons.join("; ")}.${code}${ui}`;
}

export function formatDone(verdict: DoneVerdict, template: string = DEFAULT_TEMPLATES.done): string {
  return renderTemplate(template, doneTokens(verdict));
}
