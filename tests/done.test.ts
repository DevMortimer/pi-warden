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

test("the runner's own summary wins over the exit code", () => {
  const failingJest = "FAIL src/a.test.ts\nTests: 2 failed, 5 total";
  const passingJest = "PASS src/a.test.ts\nTests: 5 total";
  assert.equal(done.classifyToolResult("bash", { command: "npm test" }, false, failingJest), "check-fail", "exit code 0, failing summary");
  assert.equal(done.classifyToolResult("bash", { command: "cd app && npm test" }, false, failingJest), "check-fail");
  assert.equal(done.classifyToolResult("bash", { command: "npm test 2>&1 | tail -20" }, false, failingJest), "check-fail", "masked exit code, failing summary");
  assert.equal(done.classifyToolResult("bash", { command: "npm test 2>&1 | tail -20" }, false, passingJest), "check-pass", "masked exit code, passing summary");
  assert.equal(done.classifyToolResult("bash", { command: "npm test || true" }, false, failingJest), "check-fail", "masked exit code by ||, failing summary");
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
