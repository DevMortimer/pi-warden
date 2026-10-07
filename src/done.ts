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

/** A package-manager script: `ci` installs, so it counts only after an explicit `run`. */
const PM_SCRIPT = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+-{1,2}[^\s]+(?:\s+[^\s]+)?)*\s+(?:run\s+(?:test|check|lint|typecheck|build|verify|ci)|(?:test|check|lint|typecheck|build|verify))\b`;
const YARN_WORKSPACE = String.raw`yarn\s+workspace\s+\S+\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify|ci)\b`;
const MAKE_TARGET = String.raw`make(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:test|check|lint|build)\b`;

/** A check runner invocation: a package-manager script, or a test, type-check, lint, or build tool. */
const RUNNER_SOURCE = String.raw`${PM_SCRIPT}|${YARN_WORKSPACE}|(?:npx|pnpm|bunx)\s+(?:tsc|jest|vitest|mocha|eslint|biome|prettier\s+--check)\b|pytest|jest|vitest|mocha|tsc|eslint|biome\s+check|ruff|mypy|flake8|pylint|black\s+--check|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|${MAKE_TARGET}|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build)|dotnet\s+(?:test|build)|node\s+--test|deno\s+(?:test|check|lint)|rspec|rake\s+test|mix\s+test|phpunit|swift\s+(?:test|build)|xcodebuild\s+test|ctest|zig\s+(?:test|build)|unittest`;

/** A runner name anywhere in the text: enough to say the run names a runner, never enough to count it as a check. */
const CHECK_COMMAND = new RegExp(`\\b(?:${RUNNER_SOURCE})\\b`);

/** The same runner anchored at the start of a shell segment, after any path prefix (`.venv/bin/pytest`). */
const RUNNER_START = new RegExp(String.raw`^(?:[^\s;&|()]*\/)?(?:${RUNNER_SOURCE})\b`);

/** Launch wrappers that may sit between the start of a segment and its runner, with the options they take. */
const WRAPPER_HEAD = /^(?:timeout(?:\s+(?:-s|--signal|-k|--kill-after)(?:=|\s+)\S+)*(?:\s+-{1,2}\S+)*\s+\S+|time(?:\s+-p)?|env(?:\s+-{1,2}\S+)*|npx(?:\s+-{1,2}[^\s]+)*|bunx(?:\s+-{1,2}[^\s]+)*|pnpm\s+exec|yarn|uv\s+run(?:\s+--with\s+\S+|\s+-{1,2}[^\s]+)*|poetry\s+run|(?:[^\s;&|()]*\/)?python[\d.]*\s+-m)\s+/;
const ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/** A shell sink run with `-c` executes the quoted script; the runner inside it is the check. */
const SHELL_C = /^(?:bash|sh|zsh|dash|ksh|fish)\s+-[a-zA-Z]*c\s+(?:'([\s\S]*)'|"([\s\S]*)")\s*$/;

/** The runner's own report that nothing ran: a run of zero tests proves nothing about the change. */
const ZERO_TESTS = /Tests:\s+0 total\b|No tests found|\[no tests to run\]|running 0 tests\b|\u2139 tests 0\b|no tests ran/i;

/**
 * Whether the summary reports zero tests with no sign of a real run: `cargo test` prints `running 0 tests` for the
 * doc-tests after real results, and `go test -run X` prints `[no tests to run]` for the packages its filter skipped.
 */
function ranNoTests(output: string): boolean {
  if (!ZERO_TESTS.test(output.slice(-6000))) return false;
  return !output.split("\n").some(line => /^\s*running [1-9]\d* tests?\b/.test(line) || (/^\s*ok\s/.test(line) && !line.includes("[no tests to run]")));
}

/** Runners that print nothing when they pass, so an empty result behind a pass-through pipe is the whole report. */
const SILENT_RUNNER = /\b(?:tsc|eslint|flake8)\b|\bgo\s+(?:vet|build)\b/;

/** Commands that only relay what the runner printed, so empty output is the runner's own silence, not a filter's cut. */
const PASS_THROUGH = new Set(["tail", "head", "tee", "cat"]);

/** True when the output holds nothing but blank lines and npm's `> name` script headers. */
function silentOutput(output: string): boolean {
  return output.split("\n").map(line => line.trim()).filter(line => line && !/^> /.test(line) && !/^\(no output\)$/i.test(line)).length === 0;
}

/** Failure lines a runner's script wrapper prints; they decide a check only when a runner starts the command. */
const GENERIC_FAILURE = /^(?:make(?:\[\d+\])?:\s+\*\*\*.*Error \d+|npm error (?:Lifecycle script .* failed|code ELIFECYCLE)|npm ERR! code ELIFECYCLE|ELIFECYCLE\s+Command failed with exit code \d+|error Command failed with exit code \d+)/m;

function genericCheckFailure(output: string): boolean {
  return GENERIC_FAILURE.test(output.slice(-6000));
}

/** Backslash-newline is a line continuation inside one command, so it joins before the shell splits on newlines. */
function joinContinuations(command: string): string {
  return command.replace(/\\\r?\n/g, "");
}

/**
 * Drop the quotes around an `echo`/`printf` argument that prints the exit code (`echo "EXIT=$?"`). The data-text
 * stripper blanks quoted arguments of data commands, but a printed exit code is the runner's own report, not data.
 */
function unquoteExitEcho(command: string): string {
  return command.replace(/\b(echo|printf)\s+((['"])([\s\S]*?)\3)/g, (whole, head: string, _quoted: string, _quote: string, inner: string) =>
    /\$\?|\$\{PIPESTATUS\[0\]\}/.test(inner) ? `${head} ${inner}` : whole);
}

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

/** Whether a check runner starts the segment, after environment assignments, launch wrappers, and a shell `-c` script. */
function startsRunner(segment: string, depth = 0): boolean {
  let rest = segment.replace(/^\(+/, "").replace(/\)+$/, "").trim();
  for (;;) {
    rest = rest.replace(ENV_ASSIGN, "").trimStart();
    // The runner pattern is tested first at every step: `yarn test` runs a script, so the `yarn` wrapper is not stripped
    // before the test; a wrapper is stripped only when what follows does not start a runner.
    if (RUNNER_START.test(rest)) return true;
    if (depth < 4) {
      const shell = SHELL_C.exec(rest);
      const inner = shell?.[1] ?? shell?.[2];
      if (inner !== undefined && commandPieces(inner).some(piece => startsRunner(piece.text, depth + 1))) return true;
    }
    const wrapper = WRAPPER_HEAD.exec(rest);
    if (!wrapper) return false;
    rest = rest.slice(wrapper[0].length);
  }
}

/** The separator that can hide a runner's exit code, and the segment it feeds. */
interface HiddenCause { sep: string; after: string }

/** Every segment a check runner starts, with the separator that hides its exit code and any echo that prints it. */
function runnerSegments(command: string): Array<{ hides: HiddenCause | undefined; printed: RegExp | undefined }> {
  const pieces = commandPieces(command);
  const runners: Array<{ hides: HiddenCause | undefined; printed: RegExp | undefined }> = [];
  for (let index = 0; index < pieces.length; index++) {
    if (!startsRunner(pieces[index]!.text)) continue;
    runners.push({ hides: hiddenCause(pieces, index, command), printed: printedCodePattern(pieces, index) });
  }
  return runners;
}

/**
 * How the shell can hide one runner's exit code: a pipe right after its segment that the command does not make
 * fail-fast, or a `||`, `;`, or newline with more commands anywhere after it. A redirect to a file does not hide the
 * exit code, and `&&` short-circuits on the runner's own status.
 */
function hiddenCause(pieces: ShellPiece[], index: number, command: string): HiddenCause | undefined {
  const own = pieces[index]!;
  // A `&` backgrounds the runner: the call returns before it finishes, so its exit code never reaches the result.
  if (own.sep === "&") return { sep: "&", after: own.next };
  if (own.sep === "|" && !/\bpipefail\b/.test(command)) return { sep: "|", after: own.next };
  for (let at = index; at < pieces.length; at++) {
    const sep = pieces[at]!.sep;
    if (sep === "||") return { sep: "||", after: pieces[at]!.next };
    // A `;` or newline hides only with more commands after it; a trailing one changes nothing.
    if ((sep === ";" || sep === "\n") && pieces.slice(at + 1).some(piece => piece.text.trim())) return { sep: ";", after: pieces[at]!.next };
  }
  return undefined;
}

function hiddenReason(cause: HiddenCause): string {
  const word = cause.after.trim().split(/\s+/)[0] ?? "";
  // Reasons name patterns and scores, never commands: only a bare command word after the separator is named.
  return `exit code hidden by ${cause.sep}${/^[A-Za-z][\w.-]*$/.test(word) ? ` ${word}` : ""}; no runner summary`;
}

/**
 * The pattern of the number an `echo`/`printf` printed for a runner's own exit code. A runner followed by `;` or a
 * newline whose next command prints `$?` is visible; after a pipe only `${PIPESTATUS[0]}` gives the runner's status.
 */
function printedCodePattern(pieces: ShellPiece[], index: number): RegExp | undefined {
  const own = pieces[index]!;
  if (own.sep === ";" || own.sep === "\n") {
    const next = pieces[index + 1];
    if (next && !/PIPESTATUS/.test(next.text)) return codeEcho(next.text);
  }
  if (own.sep === "|" && !(index > 0 && pieces[index - 1]!.sep === "|")) {
    let at = index;
    while (pieces[at]!.sep === "|") at++;
    const next = pieces[at + 1];
    if ((pieces[at]!.sep === ";" || pieces[at]!.sep === "\n") && next && /PIPESTATUS/.test(next.text)) return codeEcho(next.text);
  }
  return undefined;
}

const EXIT_VARIABLE = /\$\?|\$\{PIPESTATUS\[0\]\}/;

/** The line pattern the echo prints for its exit code: the literal around the variable becomes a number capture. */
function codeEcho(text: string): RegExp | undefined {
  const match = /^(?:echo|printf)\b([\s\S]*)$/.exec(text.trim());
  if (!match) return undefined;
  const rest = match[1]!;
  if (!EXIT_VARIABLE.test(rest)) return undefined;
  const quoted = /(['"])([\s\S]*?)\1/.exec(rest);
  let literal: string;
  if (quoted && EXIT_VARIABLE.test(quoted[2]!)) literal = quoted[2]!;
  else if (quoted && /%[sd]/.test(quoted[2]!) && EXIT_VARIABLE.test(rest.replace(quoted[0], ""))) literal = quoted[2]!.replace(/%[sd]/, "\u0000");
  else literal = rest.trim();
  const parts = literal.replace(/\u0000/g, "$?").replace(/\\n/g, "").split(EXIT_VARIABLE);
  if (parts.length < 2) return undefined;
  const escaped = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(\\d+)");
  return new RegExp(`^\\s*${escaped}\\s*$`, "m");
}

/** The number a visible exit-code echo printed, or undefined when the output does not show it. */
function printedCode(pattern: RegExp, output: string): number | undefined {
  const match = pattern.exec(output.slice(-6000));
  return match ? Number(match[1]) : undefined;
}

/** True when a silent runner's exit code is hidden only by a pass-through pipe, so empty output is its own report. */
function silentRunnerPass(runner: { hides: HiddenCause | undefined }, output: string | undefined, command: string): boolean {
  if (runner.hides?.sep !== "|" || output === undefined) return false;
  const head = runner.hides.after.trim().split(/\s+/)[0]?.replace(/^-+/, "") ?? "";
  return PASS_THROUGH.has(head) && SILENT_RUNNER.test(command) && silentOutput(output);
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
  // Shell text is data until a sink runs it: a commit message or heredoc body that names a runner is not a command.
  const command = view.shell ? stripDataText(unquoteExitEcho(joinContinuations(view.command))).text : view.command;
  const namesRunner = CHECK_COMMAND.test(command);
  // A test runner launched from inside a script (ctx_execute JavaScript, a Python wrapper) leaves no runner name in the
  // command text, but its output still carries the runner's summary. Judge that summary instead.
  const summary = output === undefined ? undefined : checkSummary(output, command);
  const runners = view.shell ? runnerSegments(command) : [];
  if (runners.length > 0 || summary !== undefined) {
    if (output !== undefined && ranNoTests(output)) return { outcome: "unknown", reason: "runner summary reports zero tests" };
    const printed = output === undefined ? [] : runners.map(runner => (runner.printed === undefined ? undefined : printedCode(runner.printed, output)));
    const printedFail = printed.some(code => code !== undefined && code !== 0);
    const printedPass = printed.some(code => code === 0);
    const silent = runners.some(runner => silentRunnerPass(runner, output, command));
    // The generic failure lines of npm, make and friends name a script that failed; without a runner they are not a check.
    const generic = runners.length > 0 && output !== undefined && genericCheckFailure(output);
    const verdict = summary ?? (generic ? "fail" : undefined);
    const hidden = runners.map(runner => runner.hides).find(cause => cause !== undefined);
    if (hidden !== undefined && verdict === undefined && !printedPass && !printedFail && !silent) {
      // A visible failure stays a failed check when another runner in the same call had a visible exit code.
      if (failed && runners.some(runner => runner.hides === undefined)) return { outcome: "check-fail" };
      return { outcome: "unknown", reason: hiddenReason(hidden) };
    }
    // A failure summary wins over exit code 0; a visible failure stays a failed check, also with a passing summary.
    return { outcome: verdict === "fail" || failed || printedFail ? "check-fail" : "check-pass" };
  }
  const read: Classification = { outcome: view.shell && isReadOnlyCommand(view.command) ? "read" : "unknown" };
  return namesRunner ? { ...read, reason: "runner name in an argument does not make a check" } : read;
}

/**
 * Recognise a test/type-check runner's own summary in tool output: node:test, jest/vitest, pytest, cargo, go test,
 * tsc. Returns the outcome the summary reports, or undefined when no runner summary is present.
 */
export function checkSummary(output: string, command = ""): "pass" | "fail" | undefined {
  const tail = output.slice(-6000);
  const nodeTest = /\u2139 (?:tests|pass|fail) \d+/.test(tail) && /\u2139 fail (\d+)/.exec(tail);
  if (nodeTest) return Number(nodeTest[1]) > 0 ? "fail" : "pass";
  const jest = /^Tests:\s+(?:(\d+) failed, )?.*?\d+ total/m.exec(tail);
  if (jest) return jest[1] && Number(jest[1]) > 0 ? "fail" : "pass";
  const pytest = /^=+ .*?(?:(\d+) failed|(\d+) error).*?in [\d.]+s/m.exec(tail) ?? /^=+ (\d+) passed.*? in [\d.]+s =+$/m.exec(tail);
  if (pytest) return /\d+ (?:failed|error)/.test(pytest[0]) ? "fail" : "pass";
  // pytest without the `===` frame (`-q`).
  const pytestQuiet = /^(\d+) (?:failed|errors?)\b.*? in [\d.]+s/m.exec(tail);
  if (pytestQuiet && Number(pytestQuiet[1]) > 0) return "fail";
  if (/^\d+ passed\b.* in [\d.]+s/m.test(tail)) return "pass";
  const cargoOrGo = /^test result: (ok|FAILED)\./m.exec(tail) ?? /^(ok|FAIL)\s+\S+\s+[\d.]+s$/m.exec(tail);
  if (cargoOrGo) return cargoOrGo[1] === "ok" ? "pass" : "fail";
  if (/\berror TS\d{4}:/.test(tail)) return "fail";
  // vitest
  if (/^(?:Tests|Test Files)\s+[^\n]*?\b[1-9]\d* failed\b/m.test(tail)) return "fail";
  if (/^Tests\s+\d+ passed\b/m.test(tail) || /^Test Files\s+[^\n]*?\b\d+ passed\b/m.test(tail)) return "pass";
  // mypy
  if (/^Success: no issues found\b/m.test(tail)) return "pass";
  // ruff with --fix: every error fixed is a pass; a remainder is not.
  const ruffFixed = /^Found (\d+) errors? \((\d+) fixed, (\d+) remaining\)/m.exec(tail);
  if (ruffFixed) return Number(ruffFixed[3]) === 0 ? "pass" : "fail";
  // tsc pretty, mypy, ruff and biome: "Found N errors"
  if (/^Found [1-9]\d* errors?\b/m.test(tail)) return "fail";
  if (/^All checks passed!/m.test(tail)) return "pass";
  if (/\b\d+ files? already formatted\b/.test(tail) || /\b\d+ files? would be left unchanged\./.test(tail)) return "pass";
  if (/All matched files use Prettier code style!/.test(tail)) return "pass";
  if (/^Checked \d+ files?\b.*No fixes applied\./m.test(tail)) return "pass";
  if (/\bWould reformat\b/.test(tail) || /\bwould reformat\b/.test(tail) || /\b\d+ files? would be reformatted\b/.test(tail)) return "fail";
  if (/Code style issues found/.test(tail)) return "fail";
  // eslint: --max-warnings moves the threshold, so its problem count says nothing on its own.
  const eslint = /\u2716 (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(tail);
  if (eslint) {
    if (/--max-warnings/.test(command)) return undefined;
    return Number(eslint[2]) > 0 ? "fail" : "pass";
  }
  // mocha
  if (/^\s*\d+ failing\s*$/m.test(tail)) return "fail";
  if (/^\s*\d+ passing \(/m.test(tail)) return "pass";
  // playwright
  if (/^\s*[1-9]\d* failed\s*$/m.test(tail)) return "fail";
  if (/^\s*\d+ passed \(/m.test(tail)) return "pass";
  // flutter
  if (/Some tests failed\./.test(tail)) return "fail";
  if (/All tests passed!/.test(tail)) return "pass";
  // bun test
  if (/^\s*[1-9]\d* fail\s*$/m.test(tail)) return "fail";
  if (/^\s*\d+ pass\s*$/m.test(tail) || /^Ran \d+ tests? across \d+ files?\./m.test(tail)) return "pass";
  // deno
  const deno = /\b(?:ok|FAILED)\s*\|[^\n]*?(\d+) passed\s*\|\s*(\d+) failed/.exec(tail);
  if (deno) return Number(deno[2]) > 0 ? "fail" : "pass";
  // cargo build, check and clippy
  if (/error: could not compile/m.test(tail)) return "fail";
  if (/^\s*Finished\b.*\bin \d+(?:\.\d+)?s\b/m.test(tail)) return "pass";
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
