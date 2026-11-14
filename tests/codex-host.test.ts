import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePatch } from "../src/hosts/apply-patch.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

type Fixture = { root: string; project: string; agent: string; hooks: string };

async function fixture(): Promise<Fixture> {
  // macOS hands out /var, a symlink to /private/var; the CLI reports the resolved cwd, so the fixture must too.
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-warden-codex-")));
  const project = join(root, "project");
  const agent = join(root, "agent");
  await mkdir(join(project, ".codex"), { recursive: true });
  return { root, project, agent, hooks: join(project, ".codex", "hooks.json") };
}

async function cli(fx: Fixture, args: string[], input = "{}", env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const preload = new URL("./fixtures/claude-transport.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", TSX, "--import", preload, CLI, ...args], {
      cwd: fx.project, env: { ...process.env, PI_CODING_AGENT_DIR: fx.agent, ...env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 15_000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.stdin.on("error", () => undefined);
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function judgeProject(fx: Fixture, overrides: Record<string, unknown> = {}): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(fx.agent, "pi-warden"), { recursive: true });
  await writeFile(join(fx.agent, "pi-warden", "config.json"), JSON.stringify({
    typesafeBackend: { label: "offline fixture", host: "https://judge.example", keyEnv: "CODEX_TEST_JUDGE_KEY", defaultModel: "jev-test" },
    ...overrides,
  }));
  await writeFile(join(fx.project, "pi-warden.md"), "# No BAD marker\nNever introduce the BAD marker.\n");
  return { PI_WARDEN_ENABLED: "1", CODEX_TEST_JUDGE_KEY: "fixture-not-a-real-key", CLAUDE_TEST_CAPTURE: join(fx.root, "requests.jsonl") };
}

/** A Codex `PostToolUse` payload for `apply_patch`, with the fields its hook schema requires. */
function payload(fx: Fixture, patch: string, id = "call-1", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session-1", transcript_path: null, cwd: fx.project, hook_event_name: "PostToolUse", model: "gpt-test", permission_mode: "default",
    turn_id: "turn-1", tool_name: "apply_patch", tool_use_id: id, tool_input: { command: patch }, tool_response: "Success. Updated the following files:", ...extra,
  });
}

const patchOf = (...hunks: string[]): string => ["*** Begin Patch", ...hunks, "*** End Patch", ""].join("\n");

async function requests(env: NodeJS.ProcessEnv): Promise<Array<{ state: { path: string; content?: string; edits?: Array<{ before: string; after: string; newText: string }> } }>> {
  const text = await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
}

const context = (result: { stdout: string }): string => JSON.parse(result.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";

test("parsePatch reads Add, Delete, Update and Move hunks as Codex does", () => {
  assert.deepEqual(parsePatch(patchOf(
    "*** Add File: path/add.py", "+abc", "+def",
    "*** Delete File: path/delete.py",
    "*** Update File: path/update.py", "*** Move to: path/update2.py", "@@ def f():", "-    pass", "+    return 123",
  )), [
    { kind: "add", path: "path/add.py", contents: "abc\ndef\n" },
    { kind: "delete", path: "path/delete.py" },
    { kind: "update", path: "path/update.py", movePath: "path/update2.py", chunks: [{ oldLines: ["    pass"], newLines: ["    return 123"], added: ["    return 123"] }] },
  ]);
  // A first chunk needs no @@ header, an empty line is empty context, and End of File closes a chunk.
  assert.deepEqual(parsePatch(patchOf("*** Update File: a.ts", " import foo", "", "-old", "+new", "*** End of File", "@@", "+tail")), [
    { kind: "update", path: "a.ts", chunks: [
      { oldLines: ["import foo", "", "old"], newLines: ["import foo", "", "new"], added: ["new"] },
      { oldLines: [], newLines: ["tail"], added: ["tail"] },
    ] },
  ]);
  assert.deepEqual(parsePatch(patchOf()), []);
});

test("parsePatch accepts the heredoc wrapper and CRLF lines, and rejects what Codex rejects", () => {
  const expected = [{ kind: "add", path: "a.txt", contents: "hi\n" }];
  assert.deepEqual(parsePatch(`<<'EOF'\n${patchOf("*** Add File: a.txt", "+hi")}EOF\n`), expected);
  assert.deepEqual(parsePatch(patchOf("*** Add File: a.txt", "+hi").replaceAll("\n", "\r\n")), expected);
  assert.deepEqual(parsePatch(`  *** Begin Patch \n*** Add File: a.txt\n+hi\n *** End Patch  `), expected);
  for (const bad of [
    "bad",
    "*** Begin Patch\nbad",
    patchOf("*** Update File: a.ts"),
    patchOf("*** Update File: a.ts", "@@", "*** Add File: b.ts", "+x"),
    patchOf("*** Update File: a.ts", "@@", "@@", "+x"),
    patchOf("*** Update File: a.ts", "-old", "+new", "*** End of File", "+more"),
    patchOf("*** Update File: a.ts", "not a diff line"),
    patchOf("*** Add File: a.ts", "missing plus"),
    patchOf("*** Delete File: a.ts", "+x"),
    patchOf("*** Frobnicate File: a.ts"),
    `${patchOf("*** Add File: a.ts", "+x")}*** Add File: b.ts\n+y\n*** End Patch`,
  ]) assert.throws(() => parsePatch(bad), /Invalid apply_patch input/, JSON.stringify(bad));
});

test("init codex --project adds the rules and done-check hooks, keeps user hooks, and uninstall restores the file", async () => {
  const fx = await fixture();
  try {
    const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] };
    const original = { description: "team hooks", hooks: { PostToolUse: [userHook] } };
    await writeFile(fx.hooks, JSON.stringify(original));
    assert.equal((await cli(fx, ["init", "codex", "--project"])).code, 0);
    const installed = JSON.parse(await readFile(fx.hooks, "utf8"));
    assert.equal(installed.description, "team hooks");
    const handler = (event: string) => ({ type: "command", command: `pi-warden hook codex ${event}`, timeout: 10 });
    assert.deepEqual(installed.hooks.PostToolUse, [userHook, { matcher: "apply_patch", hooks: [handler("PostToolUse")] }, { matcher: "Bash", hooks: [handler("PostToolUse")] }]);
    for (const event of ["UserPromptSubmit", "Stop"]) assert.deepEqual(installed.hooks[event], [{ hooks: [handler(event)] }], "Codex takes no matcher on this event");
    assert.deepEqual(Object.keys(installed.hooks), ["PostToolUse", "UserPromptSubmit", "Stop"], "Codex needs no PreToolUse capture");
    const text = await readFile(fx.hooks, "utf8");
    assert.equal((await cli(fx, ["init", "codex", "--project"])).code, 0);
    assert.equal(await readFile(fx.hooks, "utf8"), text, "a second init adds nothing");
    assert.equal((await readdir(join(fx.agent, "pi-warden", "hosts", "codex"))).length, 1);
    assert.equal((await cli(fx, ["uninstall", "codex", "--project"])).code, 0);
    assert.deepEqual(JSON.parse(await readFile(fx.hooks, "utf8")), original);
    await assert.rejects(readFile(join(fx.project, ".claude", "settings.json"), "utf8"), { code: "ENOENT" });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("init codex writes $CODEX_HOME/hooks.json, and an empty file is left as {} after uninstall", async () => {
  const fx = await fixture();
  try {
    const codexHome = join(fx.root, "codex-home");
    await mkdir(codexHome);
    const env = { CODEX_HOME: codexHome, HOME: fx.root };
    assert.equal((await cli(fx, ["init", "codex"], "{}", env)).code, 0);
    const path = join(codexHome, "hooks.json");
    assert.equal(JSON.parse(await readFile(path, "utf8")).hooks.PostToolUse[0].matcher, "apply_patch");
    await assert.rejects(readFile(fx.hooks, "utf8"), { code: "ENOENT" }, "user scope leaves the project alone");
    assert.equal((await cli(fx, ["uninstall", "codex"], "{}", env)).code, 0);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("invalid Codex hooks JSON is named by its path, never echoed, and left as it was", async () => {
  const fx = await fixture();
  try {
    for (const broken of ["PRIVATE_HOOKS_JSON", JSON.stringify({ hooks: { PostToolUse: "PRIVATE_HOOKS_JSON" } })]) {
      await writeFile(fx.hooks, broken);
      for (const command of ["init", "uninstall"]) {
        const result = await cli(fx, [command, "codex", "--project"]);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /invalid codex hook/i);
        assert.ok(result.stderr.includes(JSON.stringify(fx.hooks)));
        assert.doesNotMatch(result.stderr, /PRIVATE_HOOKS_JSON/);
        assert.equal(await readFile(fx.hooks, "utf8"), broken);
      }
    }
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("an added file is judged as a write and its finding returns as PostToolUse context", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await mkdir(join(fx.project, "src"));
    await writeFile(join(fx.project, "src", "a.ts"), "const BAD = 1;\n");
    const result = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Add File: src/a.ts", "+const BAD = 1;")), env);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(output.hookSpecificOutput.additionalContext, /No BAD marker/);
    assert.equal(output.decision, undefined, "a finding never blocks or replaces the tool result");
    assert.equal(output.continue, undefined);
    const [request, ...rest] = await requests(env);
    assert.equal(rest.length, 0);
    assert.equal(request!.state.path, "src/a.ts");
    assert.equal(request!.state.content, "const BAD = 1;\n");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("an updated file is judged per chunk from the patch, and a violation already in its context is not new", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "a.ts"), "const first = BAD;\nconst second = 2;\n\nconst third = 3;\n");
    const keeps = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Update File: a.ts", " const first = BAD;", "-const second = 1;", "+const second = 2;"), "keeps"), env);
    assert.equal(keeps.code, 0, keeps.stderr);
    assert.equal(context(keeps), "");
    const [kept] = await requests(env);
    assert.deepEqual(kept!.state.edits, [{ id: "edit_1", before: "const first = BAD;\nconst second = 1;", after: "const first = BAD;\nconst second = 2;", newText: "const second = 2;" }]);
    await writeFile(join(fx.project, "a.ts"), "const first = BAD;\nconst second = 2;\n\nconst third = BAD;\n");
    const adds = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Update File: a.ts", "@@", " const second = 2;", "@@", "-const third = 3;", "+const third = BAD;"), "adds"), env);
    assert.match(context(adds), /No BAD marker/);
    assert.equal((await requests(env))[1]!.state.edits!.length, 2);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a moved file is judged at its destination, and deletes or files outside the project send nothing", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "new.ts"), "const value = BAD;\n");
    const moved = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Update File: old.ts", "*** Move to: new.ts", "@@", "-const value = 1;", "+const value = BAD;"), "move"), env);
    assert.match(context(moved), /No BAD marker/);
    assert.equal((await requests(env))[0]!.state.path, "new.ts");
    const outside = join(fx.root, "outside.ts");
    await writeFile(outside, "BAD\n");
    const none = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Delete File: new.ts", `*** Add File: ${outside}`, "+BAD", "*** Add File: ../outside.ts", "+BAD", "*** Add File: gone.ts", "+BAD"), "none"), env);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(context(none), "");
    assert.equal((await requests(env)).length, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a patch judges its first four files together and names the rest", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const names = ["a", "b", "c", "d", "e", "f"].map(name => `${name}.ts`);
    for (const name of names) await writeFile(join(fx.project, name), "BAD\n");
    const result = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf(...names.flatMap(name => [`*** Add File: ${name}`, "+BAD"]))), env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await requests(env)).map(request => request.state.path).sort(), names.slice(0, 4));
    assert.equal(context(result).match(/No BAD marker/g)?.length, 4);
    assert.match(context(result), /2 more files in this patch were not judged/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a replayed apply_patch call is judged once, and a new call is judged again", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "a.ts"), "BAD\n");
    const event = payload(fx, patchOf("*** Add File: a.ts", "+BAD"));
    const results = await Promise.all(Array.from({ length: 3 }, () => cli(fx, ["hook", "codex", "PostToolUse"], event, env)));
    assert.ok(results.every(result => result.code === 0));
    assert.equal(results.filter(result => context(result)).length, 1);
    assert.equal((await requests(env)).length, 1);
    await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Add File: a.ts", "+BAD"), "call-2"), env);
    assert.equal((await requests(env)).length, 2);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("an invalid patch, another tool or another event fails open without a request", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "a.ts"), "BAD\n");
    const invalid = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, "*** Begin Patch\n*** Add File: a.ts\n+sk-fixture-not-a-secret BAD\n"), env);
    assert.equal(invalid.code, 0);
    assert.match(invalid.stderr, /skipped/);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /sk-fixture/);
    const bash = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, "", "bash", { tool_name: "Bash", tool_input: { command: "echo BAD > a.ts" } }), env);
    assert.deepEqual(JSON.parse(bash.stdout), {});
    const pre = await cli(fx, ["hook", "codex", "PreToolUse"], payload(fx, patchOf("*** Add File: a.ts", "+BAD"), "pre", { hook_event_name: "PreToolUse" }), env);
    assert.equal(pre.code, 0);
    assert.match(pre.stderr, /unsupported hook/);
    assert.equal(pre.stdout, "");
    assert.equal((await requests(env)).length, 0);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("missing consent is said once, and gitignored or disabled rules send nothing", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "a.ts"), "BAD\n");
    const add = patchOf("*** Add File: a.ts", "+BAD");
    const first = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, add, "consent-1"), { ...env, PI_WARDEN_ENABLED: "" });
    assert.match(context(first), /rules judgments are off; set PI_WARDEN_ENABLED=1/);
    const second = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, add, "consent-2"), { ...env, PI_WARDEN_ENABLED: "" });
    assert.equal(context(second), "");
    execFileSync("git", ["init", "-q"], { cwd: fx.project });
    await writeFile(join(fx.project, ".gitignore"), "ignored.ts\n");
    await writeFile(join(fx.project, "ignored.ts"), "BAD\n");
    await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Add File: ignored.ts", "+BAD"), "ignored"), env);
    await judgeProject(fx, { rules: { enabled: false } });
    await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, add, "disabled"), env);
    assert.equal((await requests(env)).length, 0);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

/** A Codex payload for another hook event, with the fields its hook schema requires. */
function eventPayload(fx: Fixture, event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: "session-1", transcript_path: null, cwd: fx.project, hook_event_name: event, model: "gpt-test", permission_mode: "default", turn_id: "turn-1", ...fields });
}

/** A finished Codex shell command: the hook gets its output text and no exit status. */
const bash = (fx: Fixture, command: string, output: string, id: string): string => eventPayload(fx, "PostToolUse", { tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: output });

const stop = (fx: Fixture, message: string | null): string => eventPayload(fx, "Stop", { stop_hook_active: false, last_assistant_message: message });

const owner = (result: { stdout: string }): string => JSON.parse(result.stdout || "{}").systemMessage ?? "";

/** The done-check requests sent so far; rules requests for the same patches are left out. */
async function doneRequests(env: NodeJS.ProcessEnv): Promise<Array<{ state: Record<string, unknown> }>> {
  const text = await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)).filter(request => "claims_done" in request.questions) : [];
}

/** One prompt and one applied patch: the session has a change and nothing has checked it yet. */
async function changedProject(fx: Fixture, env: NodeJS.ProcessEnv, prompt = "Add the value module"): Promise<void> {
  await writeFile(join(fx.project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.equal((await cli(fx, ["hook", "codex", "UserPromptSubmit"], eventPayload(fx, "UserPromptSubmit", { prompt }), env)).code, 0);
  await writeFile(join(fx.project, "value.ts"), "export const value = 1;\n");
  const patched = await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Add File: value.ts", "+export const value = 1;"), "patch-1"), env);
  assert.equal(patched.code, 0, patched.stderr);
}

const PASSING = "\u2139 tests 3\n\u2139 pass 3\n\u2139 fail 0\n";

test("init codex on an install from before the done-check adds only the new entries", async () => {
  const fx = await fixture();
  try {
    const legacy = { event: "PostToolUse", matcher: "apply_patch", hook: { type: "command", command: "pi-warden hook codex PostToolUse", timeout: 10 } };
    await writeFile(fx.hooks, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "apply_patch", hooks: [legacy.hook] }] } }));
    const settings = createHash("sha256").update(fx.hooks).digest("hex");
    await mkdir(join(fx.agent, "pi-warden", "hosts", "codex"), { recursive: true });
    await writeFile(join(fx.agent, "pi-warden", "hosts", "codex", `${settings}.json`), JSON.stringify({ version: 1, settings, owned: [legacy] }));
    const result = await cli(fx, ["init", "codex", "--project"]);
    assert.equal(result.code, 0, result.stderr);
    const installed = JSON.parse(await readFile(fx.hooks, "utf8"));
    assert.deepEqual(installed.hooks.PostToolUse.map((group: { matcher: string }) => group.matcher), ["apply_patch", "Bash"], "the reviewed hook keeps its position");
    assert.equal(installed.hooks.Stop.length, 1);
    assert.equal(installed.hooks.UserPromptSubmit.length, 1);
    assert.equal((await cli(fx, ["uninstall", "codex", "--project"])).code, 0);
    assert.deepEqual(JSON.parse(await readFile(fx.hooks, "utf8")), {}, "the old and the new entries are both owned");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a done claim after an unchecked patch tells the owner once, never the model", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await changedProject(fx, env, "Add the value module, token sk-fixture1234567890SECRET");
    const result = await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done: the value module is added."), env);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout || "{}");
    assert.match(output.systemMessage ?? "", /^pi-warden: reports completion \(0\.95\) after 1 file change with no test, build, or lint run since the last change\. Run npm run test on what you changed\./);
    assert.equal(output.decision, undefined, "the done-check never holds the stop");
    assert.equal(output.continue, undefined);
    assert.equal(output.hookSpecificOutput, undefined, "nothing reaches the model");
    const sent = await doneRequests(env);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.state.final_message, "Done: the value module is added.");
    assert.match(String(sent[0]!.state.task), /^Add the value module, token /);
    assert.doesNotMatch(String(sent[0]!.state.task), /sk-fixture1234567890SECRET/);
    assert.deepEqual(sent[0]!.state.run, { file_changes: 1, checks_run: [] });
    assert.equal((await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done again."), env)).stdout.trim(), "{}", "one judgment per prompt");
    assert.equal((await cli(fx, ["hook", "codex", "Stop"], stop(fx, null), env)).stdout.trim(), "{}", "a turn with no final message is not judged");
    assert.equal((await doneRequests(env)).length, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a shell run counts as a check only when its output shows the result", async () => {
  for (const scenario of ["passed", "silent", "printed-exit", "failed", "no-summary", "before"]) {
    const fx = await fixture();
    try {
      const env = await judgeProject(fx);
      if (scenario === "before") await cli(fx, ["hook", "codex", "PostToolUse"], bash(fx, "npm test", PASSING, "bash-before"), env);
      await changedProject(fx, env);
      const run = {
        passed: ["npm test", PASSING], silent: ["npx tsc --noEmit", ""], "printed-exit": ["npm run build; echo \"exit=$?\"", "built\nexit=0"],
        failed: ["npm test", "\u2139 tests 3\n\u2139 pass 2\n\u2139 fail 1\n"], "no-summary": ["npm run build", "built, maybe"], before: undefined,
      }[scenario];
      if (run) assert.equal((await cli(fx, ["hook", "codex", "PostToolUse"], bash(fx, run[0]!, run[1]!, "bash-1"), env)).stdout.trim(), "{}");
      const result = await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done: tests pass."), env);
      assert.equal(result.code, 0, result.stderr);
      const sent = await doneRequests(env);
      if (["passed", "silent", "printed-exit"].includes(scenario)) {
        assert.equal(result.stdout.trim(), "{}", scenario);
        assert.deepEqual(sent, [], `${scenario}: a passing check after the change sends nothing`);
        continue;
      }
      assert.equal(sent.length, 1, scenario);
      if (scenario === "failed") {
        assert.match(owner(result), /with 1 failed check and no passing one.*The last check that ran failed: npm test\. Fix that first\./);
        assert.deepEqual((sent[0]!.state.run as { checks_run: string[] }).checks_run, ["npm test \u2192 failed"]);
      } else {
        assert.match(owner(result), /no test, build, or lint run since the last change/, scenario);
        assert.deepEqual((sent[0]!.state.run as { checks_run: string[] }).checks_run, []);
      }
      if (scenario === "no-summary") assert.match(owner(result), /claims checks passed \(0\.95\) but none ran/, "a run that shows no result is not a check");
      if (scenario === "before") assert.match(owner(result), /Run npm test on what you changed/, "the last passing check is the one to run again");
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

test("a patch inside the project is a change even when it only deletes, and one outside is not", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "package.json"), "{}");
    await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Add File: ../outside.ts", "+x", `*** Add File: ${join(fx.root, "elsewhere.ts")}`, "+x"), "outside"), env);
    assert.equal((await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done."), env)).stdout.trim(), "{}");
    assert.deepEqual(await doneRequests(env), [], "a patch outside the project changes nothing here");
    await cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Delete File: old.ts"), "delete"), env);
    assert.match(owner(await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done."), env)), /after 1 file change/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("the done-check runs with rules off, needs consent, and records nothing when it is off", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { rules: { enabled: false } });
    await changedProject(fx, { ...env, PI_WARDEN_ENABLED: "" });
    const first = await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done."), { ...env, PI_WARDEN_ENABLED: "" });
    assert.equal(first.code, 0, first.stderr);
    assert.match(owner(first), /done-check is off; set PI_WARDEN_ENABLED=1/);
    await cli(fx, ["hook", "codex", "UserPromptSubmit"], eventPayload(fx, "UserPromptSubmit", { prompt: "Again" }), env);
    assert.match(owner(await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done."), env)), /reports completion/, "the change made with rules off still counts");
    assert.equal((await requests(env)).length, 1, "only the done-check request; no rules request");
    for (const done of [{ enabled: false }, { nudge: false }]) {
      const off = await fixture();
      try {
        const offEnv = await judgeProject(off, { done, rules: { enabled: false } });
        await changedProject(off, offEnv);
        await cli(off, ["hook", "codex", "PostToolUse"], bash(off, "npm test", PASSING, "bash-1"), offEnv);
        assert.equal((await cli(off, ["hook", "codex", "Stop"], stop(off, "Done."), offEnv)).stdout.trim(), "{}");
        assert.deepEqual(await requests(offEnv), []);
        await assert.rejects(readdir(join(off.agent, "pi-warden", "state", "codex")), { code: "ENOENT" }, "nothing is recorded for a check that is off");
      } finally { await rm(off.root, { recursive: true, force: true }); }
    }
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a replayed patch or shell result is one piece of evidence", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await changedProject(fx, env);
    await Promise.all(Array.from({ length: 2 }, () => cli(fx, ["hook", "codex", "PostToolUse"], payload(fx, patchOf("*** Add File: value.ts", "+export const value = 1;"), "patch-1"), env)));
    await Promise.all(Array.from({ length: 2 }, () => cli(fx, ["hook", "codex", "PostToolUse"], bash(fx, "npm test", "\u2139 tests 3\n\u2139 pass 2\n\u2139 fail 1\n", "bash-1"), env)));
    await cli(fx, ["hook", "codex", "Stop"], stop(fx, "Done."), env);
    assert.deepEqual((await doneRequests(env))[0]!.state.run, { file_changes: 1, checks_run: ["npm test \u2192 failed"] });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
