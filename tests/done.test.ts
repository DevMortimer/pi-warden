import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import * as done from "../src/done.js";

const visual = () => defaultConfig().done.visualTools;

test("a shell command is a check only when a check runner starts one of its shell segments", () => {
  for (const command of ["grep -n jest package.json", "which eslint", "ls node_modules/.bin/vitest", "npm view vitest version", "git log --oneline -- tsc.json", "echo 'run pytest later'"]) {
    const outcome = done.classifyToolResult("bash", { command }, false);
    assert.ok(outcome === "read" || outcome === "unknown", `${command} → ${outcome}`);
  }
  for (const command of ["npm test", "cd app && npm test", "FOO=1 npm test", "timeout 30 npm test", "time cargo test", "env NODE_ENV=test npm test", "npx jest", "pnpm exec tsc --noEmit", "bunx vitest run", "yarn vitest", "uv run pytest", "poetry run pytest", "python -m pytest"]) {
    assert.equal(done.classifyToolResult("bash", { command }, false), "check-pass", command);
    assert.equal(done.classifyToolResult("bash", { command }, true), "check-fail", command);
  }
  assert.equal(done.classifyToolResult("bash", { command: "npm install ajv" }, false), "unknown", "a runner name in an argument does not make a check");
});

test("a failure summary wins over exit code 0; a visible failure stays a failed check", () => {
  const failingJest = "FAIL src/a.test.ts\nTests: 2 failed, 5 total";
  const passingJest = "PASS src/a.test.ts\nTests: 5 total";
  assert.equal(done.classifyToolResult("bash", { command: "npm test" }, false, failingJest), "check-fail", "exit code 0, failing summary");
  assert.equal(done.classifyToolResult("bash", { command: "cd app && npm test" }, false, failingJest), "check-fail");
  assert.equal(done.classifyToolResult("bash", { command: "npm test 2>&1 | tail -20" }, false, failingJest), "check-fail", "masked exit code, failing summary");
  assert.equal(done.classifyToolResult("bash", { command: "npm test 2>&1 | tail -20" }, false, passingJest), "check-pass", "masked exit code, passing summary");
  assert.equal(done.classifyToolResult("bash", { command: "npm test || true" }, false, failingJest), "check-fail", "masked exit code by ||, failing summary");
  assert.equal(done.classifyToolResult("bash", { command: "npm run check" }, true, passingJest), "check-fail", "a failed run whose tests passed: a passing summary does not rescue it");
  assert.equal(done.classifyToolResult("bash", { command: "npm test 2>&1 | tail -20" }, true, passingJest), "check-fail", "a visible failure behind a pipe stays failed");
  assert.equal(done.classifyToolResult("ctx_execute", { language: "javascript", code: "runAll()" }, true, passingJest), "check-fail", "a script with a passing summary and a failed run");
  assert.equal(done.classifyToolResult("ctx_execute", { language: "javascript", code: "runAll()" }, false, passingJest), "check-pass");
});

test("every runner segment is checked, and every separator after it", () => {
  assert.equal(done.classifyToolResult("bash", { command: "npm run typecheck && npm test 2>&1 | tail -30" }, false), "unknown", "a pipe after a later runner segment hides that runner's exit code");
  assert.equal(done.classifyToolResult("bash", { command: "npm test\necho ok" }, false), "unknown", "a newline with more commands after the runner hides its exit code");
  assert.equal(done.classifyToolResult("bash", { command: "npm test && echo ok || true" }, false), "unknown", "a || anywhere after the runner hides its exit code");
  assert.equal(done.classifyToolResult("bash", { command: "npm test && npm run build; echo done" }, false), "unknown", "; with more commands after a later segment hides the test's exit code");
  assert.equal(done.classifyToolResult("bash", { command: "npm test && echo ok | cat" }, false), "check-pass", "a pipe after a segment no runner starts hides nothing");
});

test("a package-manager script is a check whatever runs it", () => {
  for (const command of ["yarn test", "yarn run lint", "yarn jest", "yarn build"]) {
    assert.equal(done.classifyToolResult("bash", { command }, false), "check-pass", command);
    assert.equal(done.classifyToolResult("bash", { command }, true), "check-fail", command);
  }
});

test("a zero-test line next to a real run is not a zero-test run", () => {
  const cargo = "running 3 tests\ntest result: ok. 3 passed; 0 failed\n\nDoc-tests crate:\n\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed";
  assert.equal(done.classifyToolResult("bash", { command: "cargo test" }, false, cargo), "check-pass", "cargo prints running 0 tests for the doc-tests after real results");
  const go = "ok  \texample.com/a\t0.2s\nexample.com/b [no tests to run]";
  assert.equal(done.classifyToolResult("bash", { command: "go test ./... -run X" }, false, go), "check-pass", "a package the filter skipped reports no tests while another ran");
  const cargoOnly = "running 0 tests\ntest result: ok. 0 passed; 0 failed";
  assert.equal(done.classifyToolResult("bash", { command: "cargo test" }, false, cargoOnly), "unknown", "only zero-test lines: no real run");
});

test("the hidden-exit reason names only a bare command word", () => {
  assert.equal(done.checkSkipReason("bash", { command: "npm test 2>&1 | tail -20" }, false), "exit code hidden by | tail; no runner summary");
  assert.equal(done.checkSkipReason("bash", { command: "npm test | (cd out && cat)" }, false), "exit code hidden by |; no runner summary", "the word after the separator is not a bare command name");
});

test("when the shell hides the runner's exit code and there is no summary, the run is not a check", () => {
  assert.equal(done.classifyToolResult("bash", { command: "npm test 2>&1 | tail -20" }, false, "PASS only, no summary"), "unknown");
  assert.equal(done.classifyToolResult("bash", { command: "npm test 2>&1 | tail -20" }, true), "unknown", "a hidden exit code is no proof either way");
  assert.equal(done.classifyToolResult("bash", { command: "npm test || true" }, false), "unknown");
  assert.equal(done.classifyToolResult("bash", { command: "make check > log 2>&1; echo exit $?" }, false), "unknown");
  assert.equal(done.classifyToolResult("bash", { command: "cd app && npm test" }, false), "check-pass", "exit 0 and no summary: the exit code decides");
  assert.equal(done.classifyToolResult("bash", { command: "cd app && npm test" }, true), "check-fail");
  assert.equal(done.classifyToolResult("bash", { command: "npm test > log 2>&1" }, false), "check-pass", "a redirect alone does not hide the exit code");
  assert.equal(done.classifyToolResult("bash", { command: "set -o pipefail; npm test | tee log" }, false), "check-pass", "pipefail keeps the exit code visible");
});

test("a run whose summary reports zero tests is not a check", () => {
  for (const summary of ["Tests: 0 total", "No tests found", "[no tests to run]", "running 0 tests", "\u2139 tests 0", "no tests ran"]) {
    const outcome = done.classifyToolResult("bash", { command: "npm test" }, false, `runner output\n${summary}`);
    assert.ok(outcome !== "check-pass" && outcome !== "check-fail", `${summary} → ${outcome}`);
    assert.equal(done.checkSkipReason("bash", { command: "npm test" }, false, `runner output\n${summary}`), "runner summary reports zero tests", summary);
  }
});

test("each run that names a runner but does not count gets the reason", () => {
  assert.equal(done.checkSkipReason("bash", { command: "npm test 2>&1 | tail -20" }, false, "no summary in here"), "exit code hidden by | tail; no runner summary");
  assert.equal(done.checkSkipReason("bash", { command: "npm test || true" }, false), "exit code hidden by || true; no runner summary");
  assert.equal(done.checkSkipReason("bash", { command: "make check > log 2>&1; echo exit $?" }, false), "exit code hidden by ; echo; no runner summary");
  assert.match(done.checkSkipReason("bash", { command: "grep -n jest package.json" }, false) ?? "", /runner name in an argument/);
  assert.match(done.checkSkipReason("ctx_execute", { language: "javascript", code: "// later: run pytest" }, false) ?? "", /runner name in an argument/);
  assert.equal(done.checkSkipReason("bash", { command: "npm test" }, false), undefined, "a counted run gets no reason");
  assert.equal(done.checkSkipReason("bash", { command: "git status" }, false), undefined, "a run that names no runner gets no reason");
});

test("UI proof counts only when the agent saw the page", () => {
  const shows = (tool: string, input: Record<string, unknown>, failed = false, content?: ReadonlyArray<{ type: string }>) => done.isVisualCheck(tool, input, failed, visual(), content);
  assert.equal(shows("bash", { command: "agent-browser snapshot -i" }), true, "a page text snapshot");
  assert.equal(shows("bash", { command: "agent-browser get text \"#app\"" }), true, "a page text snapshot");
  assert.equal(shows("bash", { command: "agent-browser open http://localhost:3000" }), false, "opening a page shows nothing");
  assert.equal(shows("bash", { command: "agent-browser close" }), false);
  assert.equal(shows("bash", { command: "agent-browser click @e3" }), false);
  assert.equal(shows("bash", { command: "agent-browser fill @e4 \"text\"" }), false);
  assert.equal(shows("bash", { command: "agent-browser set value x" }), false);
  assert.equal(shows("bash", { command: "agent-browser wait 5" }), false);
  assert.equal(shows("bash", { command: "agent-browser eval \"document.title\"" }), false);
  assert.equal(shows("bash", { command: "agent-browser screenshot /tmp/s.png" }), false, "a screenshot that only writes a file");
  assert.equal(shows("read", { path: "/tmp/s.png" }), true, "reading the saved screenshot counts");
  assert.equal(shows("bash", { command: "idb screenshot /tmp/s.png" }), false);
  assert.equal(shows("bash", { command: "xcrun simctl io booted screenshot /tmp/s.png" }), false);
  assert.equal(shows("bash", { command: "chrome --headless --screenshot=/tmp/s.png http://localhost:3000" }), false);
  assert.equal(shows("mcp", { tool: "navigate_page", args: {} }), false, "a navigation tool");
  assert.equal(shows("mcp__chrome_devtools", { tool: "take_snapshot" }), true);
  assert.equal(shows("mcp__chrome_devtools", { tool: "take_screenshot" }), false, "a screenshot tool name alone");
  assert.equal(shows("mcp__chrome_devtools", { tool: "take_screenshot" }, false, [{ type: "image" }]), true, "a successful result with an image");
  assert.equal(shows("bash", { command: "agent-browser open http://localhost:3000" }, true, [{ type: "image" }]), false, "a failed call showed nothing");
  assert.equal(shows("bash", { command: "npx playwright test" }), true, "a browser test run");
  assert.equal(shows("bash", { command: "flutter test integration_test/app_test.dart" }), true, "a device test run");
  assert.equal(shows("bash", { command: "flutter test test/goldens/x_golden_test.dart" }), true);
  assert.equal(shows("bash", { command: "flutter test test/unit/x_test.dart" }), false, "a unit test shows no UI");
});

test("the UI nudge names the last local URL a tool result printed", () => {
  assert.equal(done.localUrl("Server running at http://localhost:5173/\nready"), "http://localhost:5173/");
  assert.equal(done.localUrl("a http://127.0.0.1:8080/x then http://[::1]:3000/y"), "http://[::1]:3000/y", "the last one wins");
  assert.equal(done.localUrl("see https://example.com/docs"), undefined, "not a local URL");
  const verdict: done.DoneVerdict = {
    unverified: true,
    falseClaim: false,
    reasons: ["reports completion (0.90) after a UI change with no browser, screenshot, or device check since"],
    evidence: { mutations: 0, checks: [] },
    unseenUi: "web/app.css",
  };
  assert.match(done.doneNudge(verdict, { localUrl: "http://localhost:5173" }), /Open http:\/\/localhost:5173 in a browser/);
  assert.match(done.doneNudge(verdict), /Open it in a browser/);
});

test("the done nudge names one check command instead of 'whatever exists'", () => {
  const verdict: done.DoneVerdict = {
    unverified: true,
    falseClaim: false,
    reasons: ["reports completion (0.90) after 1 file change with no test, build, or lint run since the last change"],
    evidence: { mutations: 1, checks: [] },
  };
  assert.match(done.doneNudge(verdict, { lastCheck: "npm run lint", projectCheck: "npm run check" }), /Run npm run lint on what you changed\./, "the last passing check of this session wins");
  assert.match(done.doneNudge(verdict, { projectCheck: "npm run check" }), /Run npm run check on what you changed\./);
  assert.match(done.doneNudge(verdict), /Run the project's tests, build, or lint \(whatever exists\) on what you changed\./, "no command found: today's text");
  assert.match(done.doneNudge(verdict), /Then report the actual result\. If no check exists or can run, say so explicitly instead of presenting the work as done\./);
});

test("projectCheckCommand reads the project root only: check script, test script, Makefile targets", () => {
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "warden-done-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  };
  assert.equal(done.projectCheckCommand(project({ "package.json": '{"scripts":{"check":"tsc --noEmit","test":"node --test"}}' })), "npm run check");
  assert.equal(done.projectCheckCommand(project({ "package.json": '{"scripts":{"test":"node --test"}}' })), "npm run test");
  assert.equal(done.projectCheckCommand(project({ "package.json": '{"scripts":{"check":"x"}}', "pnpm-lock.yaml": "lockfileVersion: 9" })), "pnpm run check");
  assert.equal(done.projectCheckCommand(project({ "package.json": '{"scripts":{"check":"x"}}', "yarn.lock": "" })), "yarn run check");
  assert.equal(done.projectCheckCommand(project({ "package.json": '{"scripts":{"check":"x"}}', "bun.lockb": "" })), "bun run check");
  assert.equal(done.projectCheckCommand(project({ "package.json": '{"scripts":{"check":"x"}}', "bun.lock": "" })), "bun run check");
  assert.equal(done.projectCheckCommand(project({ "Makefile": "check:\n\t./check.sh\n" })), "make check");
  assert.equal(done.projectCheckCommand(project({ "Makefile": "test:\n\tnode --test\n" })), "make test");
  assert.equal(done.projectCheckCommand(project({ "package.json": '{"scripts":{"build":"tsc"}}', "Makefile": "check:\n\ttrue\n" })), "make check", "no script: the Makefile target");
  assert.equal(done.projectCheckCommand(project({ "README.md": "no check here" })), undefined);
});

// ---------------------------------------------------------------------------
// Summary lines, printed exit codes, runner forms, and shell text.

const verdict = (command: string, output?: string, failed = false) => done.classifyToolResult("bash", { command }, failed, output);

test("vitest and pytest -q summary lines decide a check", () => {
  assert.equal(done.checkSummary("Test Files  1 failed | 3 passed (4)"), "fail");
  assert.equal(done.checkSummary("Tests  2 failed | 10 passed (12)"), "fail");
  assert.equal(done.checkSummary("Tests  12 passed (12)"), "pass");
  assert.equal(done.checkSummary(" Test Files  4 passed (4)"), "pass", "vitest indents its summary");
  assert.equal(done.checkSummary("pkg:test:  Test Files  4 passed (4)"), "pass", "a runner prefix such as turbo's");
  assert.equal(done.checkSummary("pkg:test:  Test Files  1 failed | 3 passed (4)"), "fail");
  assert.equal(done.checkSummary("1 failed, 2 passed in 0.31s"), "fail");
  assert.equal(done.checkSummary("1 error in 0.20s"), "fail");
  assert.equal(done.checkSummary("2 passed, 1 warning in 0.12s"), "pass");
  assert.equal(verdict("npx vitest run", "Tests  2 failed | 10 passed (12)"), "check-fail", "a failing summary wins over exit code 0");
});

test("mypy, ruff, tsc and format-check summary lines decide a check", () => {
  assert.equal(done.checkSummary("Success: no issues found in 12 source files"), "pass");
  assert.equal(done.checkSummary("Found 2 errors in 1 file (checked 12 source files)"), "fail");
  assert.equal(done.checkSummary("All checks passed!"), "pass");
  assert.equal(done.checkSummary("Found 3 errors."), "fail");
  assert.equal(done.checkSummary("Found 3 errors (3 fixed, 0 remaining)."), "pass");
  assert.equal(done.checkSummary("Found 3 errors in 2 files."), "fail");
  assert.equal(done.checkSummary("Found 1 error in src/a.ts:4"), "fail");
  assert.equal(done.checkSummary("5 files already formatted"), "pass");
  assert.equal(done.checkSummary("5 files would be left unchanged."), "pass");
  assert.equal(done.checkSummary("Would reformat: a.py"), "fail");
  assert.equal(done.checkSummary("would reformat a.py"), "fail");
  assert.equal(done.checkSummary("2 files would be reformatted"), "fail");
});

test("eslint, bun, mocha, playwright, flutter and deno summary lines decide a check", () => {
  assert.equal(done.checkSummary("\u2716 5 problems (2 errors, 3 warnings)"), "fail");
  assert.equal(done.checkSummary("\u2716 3 problems (0 errors, 3 warnings)"), "pass");
  assert.equal(done.checkSummary("\u2716 3 problems (0 errors, 3 warnings)", "eslint . --max-warnings 0"), undefined, "--max-warnings gives no verdict");
  assert.equal(done.checkSummary("12 pass\n0 fail\nRan 12 tests across 3 files."), "pass");
  assert.equal(done.checkSummary("2 fail"), "fail");
  assert.equal(done.checkSummary("12 passing (40ms)"), "pass");
  assert.equal(done.checkSummary("2 failing"), "fail");
  assert.equal(done.checkSummary("12 passed (3.1s)"), "pass");
  assert.equal(done.checkSummary("2 failed"), "fail");
  assert.equal(done.checkSummary("All tests passed!"), "pass");
  assert.equal(done.checkSummary("Some tests failed."), "fail");
  assert.equal(done.checkSummary("ok | 3 passed | 0 failed"), "pass");
  assert.equal(done.checkSummary("FAILED | 2 passed | 1 failed"), "fail");
});

test("prettier, biome and cargo build-style summary lines decide a check", () => {
  assert.equal(done.checkSummary("All matched files use Prettier code style!"), "pass");
  assert.equal(done.checkSummary("Code style issues found"), "fail");
  assert.equal(done.checkSummary("Checked 5 files in 2ms. No fixes applied."), "pass");
  assert.equal(done.checkSummary("Found 2 errors."), "fail");
  assert.equal(done.checkSummary("    Finished dev [unoptimized + debuginfo] target(s) in 1.20s", "cargo build"), "pass");
  assert.equal(done.checkSummary("    Finished dev [unoptimized + debuginfo] target(s) in 1.20s", "cargo check"), "pass");
  assert.equal(done.checkSummary("    Finished dev [unoptimized + debuginfo] target(s) in 1.20s", "cargo clippy"), "pass");
  assert.equal(done.checkSummary("    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.20s", "cargo test"), undefined, "Finished before cargo test's results proves nothing");
  assert.equal(done.checkSummary("Finished deploying in 3.2s", "make deploy"), undefined, "Finished without a cargo build is not a check");
  assert.equal(done.checkSummary("error: could not compile `app` due to 2 previous errors"), "fail");
});

test("generic wrapper failure lines decide only when a runner starts the command", () => {
  assert.equal(verdict("make test", "make: *** [Makefile:12: test] Error 2"), "check-fail");
  assert.equal(verdict("make test", "make[1]: *** [Makefile:12: test] Error 2"), "check-fail");
  assert.equal(verdict("npm test", 'npm error Lifecycle script "test" failed'), "check-fail");
  assert.equal(verdict("npm test", "npm ERR! code ELIFECYCLE"), "check-fail");
  assert.equal(verdict("pnpm test", "ELIFECYCLE  Command failed with exit code 1."), "check-fail");
  assert.equal(verdict("yarn test", "error Command failed with exit code 1."), "check-fail");
  assert.equal(verdict("npm install", "npm error code E404"), "unknown", "without a runner a failed install is not a failed check");
});

test("the exit code the agent printed decides the runner", () => {
  assert.equal(verdict('npm test; echo "EXIT=$?"', "EXIT=0"), "check-pass");
  assert.equal(verdict('npm test; echo "EXIT=$?"', "EXIT=1"), "check-fail");
  assert.equal(verdict("npm test\necho $?", "0"), "check-pass");
  assert.equal(verdict("npm test; echo $?", "1"), "check-fail");
  assert.equal(verdict("npm test | tail -5; echo $?", "0"), "unknown", "after a pipe $? is the last command's status");
  assert.equal(verdict("npm test | tail -5; echo ${PIPESTATUS[0]}", "1"), "check-fail", "PIPESTATUS[0] is the runner's status");
  assert.equal(verdict("npm test | tail -5; echo ${PIPESTATUS[0]}", "0"), "check-pass");
});

test("a silent runner behind a pass-through pipe is a passing check", () => {
  assert.equal(verdict("npx tsc --noEmit 2>&1 | tail -5", "> app@1.0.0 typecheck\n> tsc --noEmit"), "check-pass");
  assert.equal(verdict("eslint . | head -20", ""), "check-pass");
  assert.equal(verdict("go vet ./... | cat", ""), "check-pass");
  assert.equal(verdict("npx tsc --noEmit 2>&1 | grep error", ""), "unknown", "a filter can cut the output: empty proves nothing");
  assert.equal(verdict("npx tsc --noEmit 2>&1 | tail -5", "note: something"), "unknown", "non-empty output is not the runner's own silence");
});

test("runner forms: a path, python -m, wrapper options, manager options, make options and shell -c", () => {
  for (const command of [
    ".venv/bin/pytest -q",
    "./node_modules/.bin/vitest run",
    "node_modules/.bin/tsc --noEmit",
    "python3 -m pytest",
    "python3.12 -m pytest",
    ".venv/bin/python -m pytest",
    "python3 -m unittest",
    "timeout -s KILL 60 npm test",
    "timeout 5m npm test",
    "uv run --with httpx pytest",
    "npx -y tsc --noEmit",
    "npx --no-install tsc --noEmit",
    "poetry run pytest",
    "pnpm -C web test",
    "pnpm --filter api test",
    "npm --prefix web test",
    "npm -w api run test",
    "yarn workspace api test",
    "make -C web test",
    "make -j4 check",
    'bash -c "npm test"',
    "bash -lc 'npm test'",
  ]) {
    assert.equal(verdict(command), "check-pass", command);
    assert.equal(verdict(command, undefined, true), "check-fail", command);
  }
});

test("a backgrounded runner and a bare ci install are not checks", () => {
  assert.equal(verdict("nohup npm test > log 2>&1 &"), "unknown");
  assert.equal(verdict("npm test &"), "unknown");
  assert.equal(verdict("npm ci"), "unknown");
  assert.equal(verdict("bun ci"), "unknown");
  for (const command of ["npm run ci", "pnpm run ci", "yarn run ci", "bun run ci"]) assert.equal(verdict(command), "check-pass", command);
});

test("shell text is data until a sink runs it, and a continuation is one command", () => {
  assert.equal(verdict('git commit -m "fix: x\n\nnpm test passes"'), "unknown", "a runner word in a commit message is not a command");
  assert.equal(verdict("npm test \\\n-- --coverage"), "check-pass", "a backslash-newline continuation is one command");
  assert.equal(verdict("cat > run.sh <<'EOF'\npytest -q\nEOF"), "unknown", "a heredoc body written to a file is not a command");
  assert.equal(verdict('bash -c "npm test"'), "check-pass", "a shell sink runs the runner inside the quotes");
});

test("a visible failure stays visible when another runner's exit code is hidden", () => {
  assert.equal(verdict("npm run lint; npm test", undefined, true), "check-fail", "the test's visible failure is a failed check even though the lint exit code is hidden");
});

test("a failure marker anywhere in the output wins over a passing one", () => {
  assert.equal(verdict("black --check . 2>&1 | tail -5", "would reformat src/a.py\n\nOh no! \u{1F4A5} \u{1F494} \u{1F4A5}\n1 file would be reformatted, 4 files would be left unchanged.\n"), "check-fail");
  assert.equal(verdict("ruff format --check . | tail -3", "Would reformat: src/a.py\n1 file would be reformatted, 4 files already formatted\n"), "check-fail");
  assert.equal(verdict("go test ./... 2>&1 | tail -20", "ok  \texample.com/a\t0.12s\n--- FAIL: TestB (0.00s)\n    b_test.go:9: boom\nFAIL\nFAIL\texample.com/b\t0.20s\nFAIL\n"), "check-fail");
  assert.equal(verdict("cargo test 2>&1 | tail -30", "running 3 tests\ntest a ... ok\n\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests x\n\nrunning 1 test\ntest src/lib.rs - f (line 3) ... FAILED\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n"), "check-fail");
  assert.equal(verdict("cargo test 2>&1 | head -5", "   Compiling x v0.1.0 (/p)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.20s\n     Running unittests src/lib.rs (target/debug/deps/x-1)\n\nrunning 3 tests\n"), "unknown");
  assert.equal(verdict("make deploy", "Finished deploying in 3.2s\n"), "unknown");
  assert.equal(verdict("npx vitest run 2>&1 | tail -8", " Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 10 passed (12)\n   Start at  10:00:00\n   Duration  1.23s\n"), "check-fail");
  assert.equal(verdict("npx vitest run 2>&1 | tail -8", " Test Files  4 passed (4)\n      Tests  12 passed (12)\n   Start at  10:00:00\n   Duration  1.23s\n"), "check-pass");
  assert.equal(verdict("npm test 2>&1 | tail -15", "Tests  12 passed (12)\n\n> app@1.0.0 lint\n> eslint .\n\n/src/a.ts\n  1:1  error  'x' is not defined  no-undef\n\n\u2716 1 problem (1 error, 0 warnings)\n\nnpm error Lifecycle script `test` failed with error:\nnpm error code 1\n"), "check-fail", "a passing summary does not cover a generic failure line");
  assert.equal(verdict("npm test; echo $?", "> app@1.0.0 test\n> node t.js\n\n0\nFAIL something\n1\n"), "check-fail", "the last printed exit code is the one the echo wrote");
  assert.equal(verdict("npm test; echo \"rc=$?\"; npm run build 2>&1 | tail -3", "> app test\nok\nrc=0\n> app build\nsrc/a.ts(1,1): something broke\n"), "unknown", "the test's printed code does not vouch for the hidden build");
  assert.equal(verdict("pytest -q 2>&1 | tail -3", "..E\n2 passed, 1 error in 0.20s\n"), "check-fail", "an error count above 0 wins over the passed count");
});
