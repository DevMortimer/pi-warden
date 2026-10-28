import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

async function fixture(): Promise<{ root: string; project: string; agent: string; settings: string }> {
  // macOS hands out /var, a symlink to /private/var; the CLI reports the resolved cwd, so the fixture must too.
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-warden-claude-")));
  const project = join(root, "project");
  const agent = join(root, "agent");
  await mkdir(join(project, ".claude"), { recursive: true });
  return { root, project, agent, settings: join(project, ".claude", "settings.json") };
}

async function receiptPath(fx: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const directory = join(fx.agent, "pi-warden", "hosts", "claude");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  return join(directory, files[0]!);
}

async function cli(fx: Awaited<ReturnType<typeof fixture>>, args: string[], input = "{}", env: NodeJS.ProcessEnv = {}, entry = CLI): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const preload = new URL("./fixtures/claude-transport.ts", import.meta.url).href;
    const transport = env.CLAUDE_TEST_REAL_FETCH === "1" ? [] : ["--import", preload];
    const child = spawn(process.execPath, ["--import", TSX, ...transport, entry, ...args], {
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
    if (env.CLAUDE_TEST_KEEP_STDIN === "1") child.stdin.write(input);
    else child.stdin.end(input);
  });
}

test("init claude --project installs rules hooks and keeps unrelated settings", async () => {
  const fx = await fixture();
  try {
    const userHook = { matcher: "Write", hooks: [{ type: "command", command: "echo user-hook" }] };
    await writeFile(fx.settings, JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PostToolUse: [userHook] } }));
    const result = await cli(fx, ["init", "claude", "--project"]);
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(fx.settings, "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Read"] });
    assert.deepEqual(settings.hooks.PostToolUse[0], userHook);
    assert.ok(settings.hooks.PostToolUse.some((group: { hooks: Array<{ command: string }> }) => group.hooks.some(hook => hook.command === "pi-warden hook claude PostToolUse")));
    assert.ok(settings.hooks.PreToolUse.some((group: { matcher: string }) => group.matcher === "Edit"));
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("the CLI runs through an npm-style bin symlink", async () => {
  const fx = await fixture();
  try {
    const linked = join(fx.root, "pi-warden");
    await symlink(CLI, linked);
    const result = await cli(fx, ["init", "claude", "--project"], "{}", {}, linked);
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(fx.settings, "utf8"));
    assert.ok(settings.hooks.PostToolUse.some((group: { hooks: Array<{ command: string }> }) => group.hooks.some(hook => hook.command === "pi-warden hook claude PostToolUse")));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("symlinked Claude settings are refused with their path and reason without changing the link or target", { skip: process.platform === "win32" }, async () => {
  for (const project of [false, true]) {
    for (const command of ["init", "uninstall"]) {
      for (const dangling of [false, true]) {
        const fx = await fixture();
        try {
          await mkdir(join(fx.root, ".claude"));
          const settings = project ? fx.settings : join(fx.root, ".claude", "settings.json");
          const args = [command, "claude", ...(project ? ["--project"] : [])];
          const env = { HOME: fx.root };
          await writeFile(settings, JSON.stringify({ permissions: { allow: ["Read"] }, private: "PRIVATE_SETTINGS_VALUE" }));
          if (command === "uninstall") assert.equal((await cli(fx, ["init", ...args.slice(1)], "{}", env)).code, 0);
          const receipt = command === "uninstall" ? await receiptPath(fx) : undefined;
          const priorReceipt = receipt ? await readFile(receipt, "utf8") : undefined;
          const text = await readFile(settings, "utf8");
          const target = join(fx.root, "dotfiles-settings.json");
          if (!dangling) await writeFile(target, text);
          await rm(settings);
          await symlink(target, settings);
          const result = await cli(fx, args, "{}", env);
          assert.notEqual(result.code, 0);
          assert.equal(result.stdout, "");
          assert.equal(await readlink(settings), target);
          if (dangling) await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
          else assert.equal(await readFile(target, "utf8"), text);
          if (receipt) assert.equal(await readFile(receipt, "utf8"), priorReceipt);
          else await assert.rejects(readdir(join(fx.agent, "pi-warden", "hosts", "claude")), { code: "ENOENT" });
          assert.match(result.stderr, /symbolic link/i);
          assert.ok(result.stderr.includes(JSON.stringify(settings)));
          assert.doesNotMatch(result.stderr, /PRIVATE_SETTINGS_VALUE/);
        } finally { await rm(fx.root, { recursive: true, force: true }); }
      }
    }
  }
});

test("invalid installation receipts are diagnosed by their path without echoing their contents", async () => {
  for (const corrupt of ["PRIVATE_RECEIPT_JSON", '{"version":2,"private":"PRIVATE_RECEIPT_JSON"}']) {
    for (const command of ["init", "uninstall"]) {
      const fx = await fixture();
      try {
        assert.equal((await cli(fx, ["init", "claude", "--project"])).code, 0);
        const receipt = await receiptPath(fx);
        const settings = await readFile(fx.settings, "utf8");
        await writeFile(receipt, corrupt);
        const result = await cli(fx, [command, "claude", "--project"]);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /invalid.*installation receipt/i);
        assert.ok(result.stderr.includes(JSON.stringify(receipt)));
        assert.doesNotMatch(result.stderr, /PRIVATE_RECEIPT/);
        assert.equal(await readFile(receipt, "utf8"), corrupt);
        assert.equal(await readFile(fx.settings, "utf8"), settings);
      } finally { await rm(fx.root, { recursive: true, force: true }); }
    }
  }
});

test("invalid settings groups are rejected before a pending receipt can change", async () => {
  for (const command of ["init", "uninstall"]) {
    const fx = await fixture();
    try {
      assert.equal((await cli(fx, ["init", "claude", "--project"])).code, 0);
      const receipt = await receiptPath(fx);
      const settings = JSON.stringify({ hooks: { PostToolUse: "PRIVATE_INVALID_HOOKS" } });
      const pending = { before: "unmatched-before", after: createHash("sha256").update(JSON.stringify([settings])).digest("hex"), added: [] };
      const prior = JSON.stringify({ ...JSON.parse(await readFile(receipt, "utf8")), pending });
      await writeFile(fx.settings, settings);
      await writeFile(receipt, prior);
      const result = await cli(fx, [command, "claude", "--project"]);
      assert.notEqual(result.code, 0);
      assert.equal(await readFile(fx.settings, "utf8"), settings);
      assert.equal(await readFile(receipt, "utf8"), prior);
      assert.match(result.stderr, /invalid.*settings hooks/i);
      assert.ok(result.stderr.includes(JSON.stringify(fx.settings)));
      assert.doesNotMatch(result.stderr, /PRIVATE_INVALID_HOOKS/);
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

async function judgeProject(fx: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(fx.agent, "pi-warden"), { recursive: true });
  await writeFile(join(fx.agent, "pi-warden", "config.json"), JSON.stringify({
    typesafeBackend: { label: "offline fixture", host: "https://judge.example", keyEnv: "CLAUDE_TEST_JUDGE_KEY", defaultModel: "jev-test" },
    ...overrides,
  }));
  await writeFile(join(fx.project, "pi-warden.md"), "# No BAD marker\nNever introduce the BAD marker.\n");
  return { PI_WARDEN_ENABLED: "1", CLAUDE_TEST_JUDGE_KEY: "fixture-not-a-real-key", CLAUDE_TEST_CAPTURE: join(fx.root, "requests.jsonl") };
}

function payload(fx: Awaited<ReturnType<typeof fixture>>, tool: string, input: Record<string, unknown>, id = "tool-1", event = "PostToolUse"): string {
  return JSON.stringify({ session_id: "session-1", tool_use_id: id, cwd: fx.project, hook_event_name: event, tool_name: tool, tool_input: input });
}

test("a real Claude Write hook returns a rules steer in PostToolUse JSON and exits zero", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const file = join(fx.project, "a.ts");
    await writeFile(file, "const BAD = 1;\n");
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "const BAD = 1;\n" }), env);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout || "{}");
    assert.equal(output.hookSpecificOutput?.hookEventName, "PostToolUse");
    assert.match(output.hookSpecificOutput.additionalContext, /No BAD marker/);
    assert.equal(output.continue, undefined);
    assert.equal(output.decision, undefined);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a Claude Write hook reads a split HTTP response through the real judge transport", async () => {
  const fx = await fixture();
  const seen: { requests: number; url?: string; body?: { state: { content: string } } } = { requests: 0 };
  let finish: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((request, response) => {
    seen.requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.url = request.url ?? "";
      seen.body = body;
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, raw]) => {
        const question = raw as { criteria: Record<string, unknown> };
        return [id, { type: "choice", choice: "violation", confidence: 0.95, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === "violation" ? 0.95 : 0.05 / (Object.keys(question.criteria).length - 1)])) }];
      }));
      const answer = JSON.stringify({ model: "jev-test", usage: { input_tokens: 1, output_tokens: 0 }, answers });
      const split = Math.floor(answer.length / 2);
      response.writeHead(200, { "content-type": "application/json" });
      response.write(answer.slice(0, split));
      finish = setTimeout(() => response.end(answer.slice(split)), 10);
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const env = await judgeProject(fx, { typesafeBackend: { label: "local judge", host: `http://127.0.0.1:${port}`, keyEnv: "CLAUDE_TEST_JUDGE_KEY", defaultModel: "jev-test" } });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "const BAD = 1;\n");
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "const BAD = 1;\n" }), { ...env, CLAUDE_TEST_REAL_FETCH: "1" });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout || "{}");
    assert.equal(output.hookSpecificOutput?.hookEventName, "PostToolUse");
    assert.match(output.hookSpecificOutput.additionalContext, /No BAD marker/);
    assert.equal(output.continue, undefined);
    assert.equal(output.decision, undefined);
    assert.equal(seen.body?.state.content, "const BAD = 1;\n");
    assert.equal(seen.url, "/v1/systemone");
    assert.equal(seen.requests, 1);
  } finally {
    clearTimeout(finish);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a Claude Write hook fails open on a stalled HTTP body before the whole hook deadline", async () => {
  const fx = await fixture();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const env = await judgeProject(fx, { timeoutMs: 150, typesafeBackend: { label: "local stalled judge", host: `http://127.0.0.1:${port}`, keyEnv: "CLAUDE_TEST_JUDGE_KEY", defaultModel: "jev-test" } });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), { ...env, CLAUDE_TEST_REAL_FETCH: "1" });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout || "{}");
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /rules judgment failed; this call continues/);
    assert.doesNotMatch(result.stderr, /hook deadline/);
    assert.equal(output.continue, undefined);
    assert.equal(output.decision, undefined);
    assert.equal(requests, 1, "the SDK timeout fails open without retrying the judgment");
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("Edit uses captured real context, keeps an existing JSDoc, and judges only its new violation", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "pi-warden.md"), "# No BAD marker\nNever introduce the BAD marker.\n\n# Exported function documents its return\nEvery exported function needs a JSDoc @returns tag.\n");
    const file = join(fx.project, "a.ts");
    const before = "/** @returns a number */\nexport function value() {\n  return 1;\n}\n";
    const after = "/** @returns a number */\nexport function value() {\n  return BAD;\n}\n";
    const input = { file_path: file, old_string: "return 1;", new_string: "return BAD;", replace_all: false };
    await writeFile(file, before);
    assert.equal((await cli(fx, ["hook", "claude", "PreToolUse"], payload(fx, "Edit", input, "edit-1", "PreToolUse"), env)).code, 0);
    await writeFile(file, after);
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Edit", input, "edit-1"), env);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout || "{}");
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /No BAD marker/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Exported function documents/);
    const sent = JSON.parse((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim());
    assert.equal(sent.state.edits[0].before, before.trimEnd());
    assert.equal(sent.state.edits[0].after, after.trimEnd());
    assert.equal(sent.state.content, undefined, "an Edit remains an Edit");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("the hook exits zero within its own deadline even when stdin never ends", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const start = Date.now();
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), { ...env, CLAUDE_TEST_KEEP_STDIN: "1" });
    assert.equal(result.code, 0, "the hook must finish itself rather than needing the test's SIGKILL");
    assert.ok(Date.now() - start < 11_000);
    assert.match(result.stderr, /pi-warden/);
    await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("the whole hook deadline also stops a transport that ignores cancellation", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { timeoutMs: 30 });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const start = Date.now();
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), { ...env, CLAUDE_TEST_HANG: "ignore" });
    assert.equal(result.code, 0, "the test must not have to kill the hook");
    assert.ok(Date.now() - start < 11_000);
    assert.match(result.stderr, /pi-warden/);
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("sensitive path notes are local and shown once while excluded content never reaches the judge", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { rules: { exclude: ["a.ts"], sensitivePaths: { "a.ts": "Review data access." } } });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const first = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "sensitive-1"), env);
    assert.match(JSON.parse(first.stdout || "{}").hookSpecificOutput?.additionalContext ?? "", /Review data access/);
    const second = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "sensitive-2"), env);
    assert.equal(JSON.parse(second.stdout || "{}").hookSpecificOutput, undefined);
    await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("the rules cap notice appears once without suppressing later new findings", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await writeFile(join(fx.project, "pi-warden.md"), Array.from({ length: 32 }, (_, i) => `# Rule ${i + 1}\nNever introduce BAD.\n`).join("\n"));
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const first = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "cap-1"), env);
    assert.match(JSON.parse(first.stdout || "{}").hookSpecificOutput?.additionalContext ?? "", /not judged.*31-question cap/);
    const second = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "cap-2"), env);
    const context = JSON.parse(second.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
    assert.match(context, /Rule 1/);
    assert.doesNotMatch(context, /not judged.*31-question cap/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("concurrent replay of the same Write produces one request and one feedback", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const event = payload(fx, "Write", { file_path: file, content: "BAD" });
    const results = await Promise.all(Array.from({ length: 4 }, () => cli(fx, ["hook", "claude", "PostToolUse"], event, env)));
    assert.ok(results.every(result => result.code === 0));
    assert.equal(results.filter(result => JSON.parse(result.stdout || "{}").hookSpecificOutput).length, 1);
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 1);
    const next = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "another-write"), env);
    assert.match(JSON.parse(next.stdout || "{}").hookSpecificOutput?.additionalContext ?? "", /No BAD marker/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("two processes racing at a barrier for the last session slot cannot exceed the request cap", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { maxRequests: 2 });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    assert.equal((await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "OK" }, "warm"), env)).code, 0);
    const barrier = join(fx.root, "barrier");
    await mkdir(barrier);
    const results = await Promise.all(["race-a", "race-b"].map(id => cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, id), { ...env, CLAUDE_TEST_BARRIER: barrier })));
    assert.ok(results.every(result => result.code === 0));
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 2);
    assert.equal(results.filter(result => /No BAD marker/.test(result.stdout)).length, 1);
    assert.equal(results.filter(result => /budget/.test(result.stdout)).length, 1);
    await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "after-cap"), env);
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 2);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("an unpersistable request claim sends nothing and a crashed claim is never refunded", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { maxRequests: 1 });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const denied = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "denied"), { ...env, CLAUDE_TEST_DENY_CLAIM: "1" });
    assert.equal(denied.code, 0);
    await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
    const crashed = join(fx.root, "engine-crashed.txt");
    const killed = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "killed"), { ...env, CLAUDE_TEST_CRASH_CLAIM: "1", CLAUDE_TEST_CRASHED: crashed });
    assert.equal(killed.code, 0, "even engine death must fail open at the CLI boundary");
    assert.match(await readFile(crashed, "utf8"), /killed after claim/);
    const next = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "after-death"), env);
    assert.equal(next.code, 0);
    await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("slow response bodies are cancelled and failed requests are not retried", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { timeoutMs: 40 });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const cancelled = join(fx.root, "cancelled.txt");
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "slow-body"), { ...env, CLAUDE_TEST_HANG: "body", CLAUDE_TEST_CANCELLED: cancelled });
    assert.equal(result.code, 0);
    assert.match(await readFile(cancelled, "utf8"), /cancelled/);
    const failed = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "http-failure"), { ...env, CLAUDE_TEST_HTTP_FAIL: "1" });
    assert.equal(failed.code, 0);
    assert.doesNotMatch(failed.stdout + failed.stderr, /upstream body/);
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 2, "one SDK attempt per call, no automatic retry");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("uninstall preserves pre-existing empty hook groups", async () => {
  const fx = await fixture();
  try {
    const empty = { matcher: "Other", hooks: [] };
    await writeFile(fx.settings, JSON.stringify({ hooks: { PreToolUse: [empty] } }));
    assert.equal((await cli(fx, ["init", "claude", "--project"])).code, 0);
    assert.equal((await cli(fx, ["uninstall", "claude", "--project"])).code, 0);
    assert.deepEqual(JSON.parse(await readFile(fx.settings, "utf8")).hooks.PreToolUse, [empty]);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a project symlink to an outside file is not judged against project rules", { skip: process.platform === "win32" }, async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const outside = join(fx.root, "outside.ts");
    const file = join(fx.project, "a.ts");
    await writeFile(outside, "BAD");
    await symlink(outside, file);
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), env);
    assert.equal(result.code, 0);
    await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("global headless consent and active backend environment key are required independently", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { typesafe: true });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const noConsent = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "no-consent"), { ...env, PI_WARDEN_ENABLED: "" });
    assert.equal(noConsent.code, 0);
    assert.match(noConsent.stdout, /PI_WARDEN_ENABLED/);
    await mkdir(join(fx.agent, "pi-typesafe"));
    await writeFile(join(fx.agent, "pi-typesafe", "auth.json"), JSON.stringify({ keys: { CLAUDE_TEST_JUDGE_KEY: "fixture-stored-key-only" } }), { mode: 0o600 });
    const noKey = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "no-env-key"), { ...env, CLAUDE_TEST_JUDGE_KEY: "" });
    assert.equal(noKey.code, 0);
    assert.match(noKey.stdout, /backend key/);
    await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("project overrides do not grant trust or disable global rules", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    await mkdir(join(fx.project, ".pi"));
    await writeFile(join(fx.project, ".pi", "pi-warden.json"), JSON.stringify({ enabled: false, rules: { enabled: false }, typesafeBackend: "refused-project" }));
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    assert.equal((await cli(fx, ["init", "claude", "--project"])).code, 0);
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), env);
    assert.match(result.stdout, /No BAD marker/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("disabled rules and gitignored files send no request", async () => {
  for (const disabled of [true, false]) {
    const fx = await fixture();
    try {
      const env = await judgeProject(fx, disabled ? { rules: { enabled: false } } : {});
      const file = join(fx.project, "a.ts");
      await writeFile(file, "BAD");
      if (!disabled) {
        execFileSync("git", ["init", "-q", fx.project], { stdio: "ignore" });
        await writeFile(join(fx.project, ".gitignore"), "a.ts\n");
      }
      const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), env);
      assert.equal(result.code, 0);
      await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

test("invalid settings JSON is preserved and invalid or oversized hook input is never echoed", async () => {
  const fx = await fixture();
  try {
    const broken = "PRIVATE_SETTINGS_JSON";
    await writeFile(fx.settings, broken);
    for (const command of ["init", "uninstall"]) {
      const result = await cli(fx, [command, "claude", "--project"]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /invalid.*JSON/i);
      assert.ok(result.stderr.includes(JSON.stringify(fx.settings)));
      assert.doesNotMatch(result.stderr, /PRIVATE_SETTINGS/);
      assert.equal(await readFile(fx.settings, "utf8"), broken);
    }
    for (const input of ["{secret: sk-fixture-not-a-secret}", "x".repeat(1024 * 1024 + 1)]) {
      const result = await cli(fx, ["hook", "claude", "PostToolUse"], input);
      assert.equal(result.code, 0);
      assert.match(result.stderr, /skipped/);
      assert.doesNotMatch(result.stdout + result.stderr, /sk-fixture/);
    }
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("replace_all and deletion preserve real before and after state", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const file = join(fx.project, "a.ts");
    const input = { file_path: file, old_string: "1", new_string: "BAD", replace_all: true };
    const before = "const first = 1;\nconst second = 1;\n";
    const after = "const first = BAD;\nconst second = BAD;\n";
    await writeFile(file, before);
    await cli(fx, ["hook", "claude", "PreToolUse"], payload(fx, "Edit", input, "all", "PreToolUse"), env);
    await writeFile(file, after);
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Edit", input, "all"), env);
    assert.match(result.stdout, /No BAD marker/);
    const request = JSON.parse((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim());
    assert.equal(request.state.edits.length, 2);
    assert.ok(request.state.edits.every((edit: { before: string; after: string }) => edit.before === before.trimEnd() && edit.after === after.trimEnd()));
    await writeFile(join(fx.project, "pi-warden.md"), "# Export documents its return\nEvery exported function needs a JSDoc @returns tag.\n");
    await writeFile(file, "/** @returns value */\nexport function value() { return 1; }\n");
    const deletion = { file_path: file, old_string: "/** @returns value */\n", new_string: "", replace_all: false };
    await cli(fx, ["hook", "claude", "PreToolUse"], payload(fx, "Edit", deletion, "deletion", "PreToolUse"), env);
    await writeFile(file, "export function value() { return 1; }\n");
    const deleted = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Edit", deletion, "deletion"), env);
    assert.match(deleted.stdout, /Export documents its return/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("missing Pre, changed inputs and concurrent file changes are skipped without invented context", async () => {
  for (const scenario of ["missing", "input", "file"]) {
    const fx = await fixture();
    try {
      const env = await judgeProject(fx);
      const file = join(fx.project, "a.ts");
      const input = { file_path: file, old_string: "1", new_string: "BAD", replace_all: false };
      await writeFile(file, "const value = 1;\n");
      if (scenario !== "missing") await cli(fx, ["hook", "claude", "PreToolUse"], payload(fx, "Edit", input, "mismatch", "PreToolUse"), env);
      await writeFile(file, scenario === "file" ? "const value = 2;\n" : "const value = BAD;\n");
      const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Edit", scenario === "input" ? { ...input, replace_all: true } : input, "mismatch"), env);
      assert.equal(result.code, 0);
      assert.match(result.stderr, /skipped/);
      await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

test("installation recovers after settings or final receipt persistence fails", async () => {
  for (const failure of ["CLAUDE_TEST_SETTINGS_FAIL", "CLAUDE_TEST_RECEIPT_FAIL"]) {
    const fx = await fixture();
    try {
      await writeFile(fx.settings, JSON.stringify({ preserved: true }));
      const result = await cli(fx, ["init", "claude", "--project"], "{}", { [failure]: "1" });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /permission denied/i);
      assert.ok(result.stderr.includes(JSON.stringify(failure === "CLAUDE_TEST_SETTINGS_FAIL" ? fx.settings : await receiptPath(fx))));
      assert.doesNotMatch(result.stderr, /Fixture (?:settings|receipt) failure/);
      assert.equal((await cli(fx, ["init", "claude", "--project"])).code, 0);
      assert.equal((await cli(fx, ["uninstall", "claude", "--project"])).code, 0);
      assert.deepEqual(JSON.parse(await readFile(fx.settings, "utf8")), { preserved: true });
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

test("an outside settings edit detected before replacement is preserved", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.settings, JSON.stringify({ preserved: true }));
    const result = await cli(fx, ["init", "claude", "--project"], "{}", { CLAUDE_TEST_SETTINGS_RACE: "1" });
    assert.notEqual(result.code, 0);
    assert.deepEqual(JSON.parse(await readFile(fx.settings, "utf8")), { preserved: true, outsideEdit: true });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("growing rule files and partial Edit captures send no request", async () => {
  for (const scenario of ["growing", "partial"]) {
    const fx = await fixture();
    try {
      const env = await judgeProject(fx);
      const file = join(fx.project, "a.ts");
      await writeFile(file, "const value = 1;");
      let result;
      if (scenario === "growing") result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), { ...env, CLAUDE_TEST_GROW_RULES: "1" });
      else {
        const input = { file_path: file, old_string: "1", new_string: "BAD", replace_all: false };
        await cli(fx, ["hook", "claude", "PreToolUse"], payload(fx, "Edit", input, "partial", "PreToolUse"), { ...env, CLAUDE_TEST_PARTIAL_TARGET: "1" });
        await writeFile(file, "const value = BAD;");
        result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Edit", input, "partial"), env);
      }
      assert.equal(result.code, 0);
      assert.match(result.stderr, /skipped/);
      await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

test("FIFO config and rules are rejected without blocking or sending a request", { skip: process.platform === "win32" }, async () => {
  for (const source of ["config", "rules"]) {
    const fx = await fixture();
    try {
      const env = await judgeProject(fx);
      const path = source === "config" ? join(fx.agent, "pi-warden", "config.json") : join(fx.project, "pi-warden.md");
      await rm(path);
      execFileSync("mkfifo", [path]);
      const file = join(fx.project, "a.ts");
      await writeFile(file, "BAD");
      const start = Date.now();
      const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), env);
      assert.equal(result.code, 0);
      assert.ok(Date.now() - start < 3000);
      await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

test("a synchronous SDK auth-state FIFO cannot outlive the whole hook deadline", { skip: process.platform === "win32" }, async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const start = Date.now();
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), { ...env, CLAUDE_TEST_AUTH_FIFO: "1" });
    assert.equal(result.code, 0);
    assert.ok(Date.now() - start < 11_000);
    assert.match(result.stderr, /deadline/);
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("backend question chunks each consume a session slot across fresh hooks", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { maxRequests: 1, typesafeBackend: { label: "offline chunks", host: "https://judge.example", keyEnv: "CLAUDE_TEST_JUDGE_KEY", defaultModel: "jev-test", limits: { maxQuestions: 1 } } });
    await writeFile(join(fx.project, "pi-warden.md"), "# First\nNever introduce BAD.\n\n# Second\nNever introduce BAD.\n");
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const first = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "chunks"), env);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /budget/);
    const request = JSON.parse((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim());
    assert.equal(Object.keys(request.questions).length, 1);
    await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }, "fresh-hook"), env);
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a stalled direct git ignore child is killed and reaped before the hook returns", { skip: process.platform === "win32" }, async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx);
    const bin = join(fx.root, "bin");
    const pid = join(fx.root, "git.pid");
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid)); setInterval(() => {}, 60000);\n`, { mode: 0o700 });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const start = Date.now();
    const result = await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Write", { file_path: file, content: "BAD" }), { ...env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.code, 0);
    assert.ok(Date.now() - start < 5000);
    const child = Number(await readFile(pid, "utf8"));
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    await assert.rejects(readFile(env.CLAUDE_TEST_CAPTURE!, "utf8"), { code: "ENOENT" });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("actor or cwd changes and capture expiry do not reset session budget or replay receipts", async () => {
  const fx = await fixture();
  try {
    const env = await judgeProject(fx, { maxRequests: 1 });
    const file = join(fx.project, "a.ts");
    await writeFile(file, "BAD");
    const original = payload(fx, "Write", { file_path: file, content: "BAD" }, "original");
    await cli(fx, ["hook", "claude", "PostToolUse"], original, env);
    const edit = { file_path: file, old_string: "BAD", new_string: "OK", replace_all: false };
    await cli(fx, ["hook", "claude", "PreToolUse"], payload(fx, "Edit", edit, "expired", "PreToolUse"), env);
    const future = { ...env, CLAUDE_TEST_CLOCK_OFFSET: "600001" };
    const replay = await cli(fx, ["hook", "claude", "PostToolUse"], original, future);
    assert.equal(JSON.parse(replay.stdout || "{}").hookSpecificOutput, undefined);
    const other = { ...fx, project: join(fx.root, "other-project") };
    await mkdir(other.project);
    await writeFile(join(other.project, "pi-warden.md"), "# No BAD marker\nNever introduce BAD.\n");
    await writeFile(join(other.project, "a.ts"), "BAD");
    const event = JSON.parse(payload(other, "Write", { file_path: join(other.project, "a.ts"), content: "BAD" }, "other-tool"));
    event.agent_id = "another-actor";
    const result = await cli(other, ["hook", "claude", "PostToolUse"], JSON.stringify(event), future);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /budget/);
    assert.equal((await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).trim().split("\n").length, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("persisted Edit facts and judgment requests contain redacted samples only", async () => {
  const fx = await fixture();
  const contents = async (path: string): Promise<string> => {
    let result = "";
    for (const item of await readdir(path, { withFileTypes: true })) result += item.isDirectory() ? await contents(join(path, item.name)) : await readFile(join(path, item.name), "utf8");
    return result;
  };
  try {
    const env = await judgeProject(fx);
    const file = join(fx.project, "a.ts");
    const token = "sk-fixture1234567890SECRET";
    await writeFile(file, `const token = "${token}";\nconst value = 1;\n`);
    const input = { file_path: file, old_string: "value = 1", new_string: "value = 2", replace_all: false };
    await cli(fx, ["hook", "claude", "PreToolUse"], payload(fx, "Edit", input, "redacted", "PreToolUse"), env);
    const stored = await contents(join(fx.agent, "pi-warden", "state"));
    assert.ok(stored.includes("[redacted]"));
    assert.ok(!stored.includes(token));
    await writeFile(file, `const token = "${token}";\nconst value = 2;\n`);
    assert.equal((await cli(fx, ["hook", "claude", "PostToolUse"], payload(fx, "Edit", input, "redacted"), env)).code, 0);
    assert.ok(!(await readFile(env.CLAUDE_TEST_CAPTURE!, "utf8")).includes(token));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("uninstall removes only entries installed in this scope and keeps user edits", async () => {
  const fx = await fixture();
  try {
    const existing = { matcher: "Write|Edit", hooks: [{ type: "command", command: "pi-warden hook claude PostToolUse", timeout: 10 }] };
    await writeFile(fx.settings, JSON.stringify({ enabledPlugins: { sample: true }, hooks: { PostToolUse: [existing] } }));
    assert.equal((await cli(fx, ["init", "claude", "--project"])).code, 0);
    const installed = await readFile(fx.settings, "utf8");
    assert.equal((await cli(fx, ["init", "claude", "--project"])).code, 0);
    assert.equal(await readFile(fx.settings, "utf8"), installed, "repeat init is idempotent");
    const settings = JSON.parse(installed);
    settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "echo another-owner" });
    settings.hooks.PostToolUseFailure[0].hooks[0].timeout = 20;
    await writeFile(fx.settings, JSON.stringify(settings));
    const result = await cli(fx, ["uninstall", "claude", "--project"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /retained/);
    const remaining = JSON.parse(await readFile(fx.settings, "utf8"));
    assert.deepEqual(remaining.hooks.PostToolUse, [existing], "a pre-existing identical command is not ours");
    assert.deepEqual(remaining.hooks.PreToolUse[0].hooks, [{ type: "command", command: "echo another-owner" }]);
    assert.equal(remaining.hooks.PostToolUseFailure[0].hooks[0].timeout, 20, "a user-modified handler remains");
    assert.deepEqual(remaining.enabledPlugins, { sample: true });
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
