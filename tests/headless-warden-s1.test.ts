import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getWardenS1DaemonStatus, stopWardenS1Daemon } from "../src/warden-s1-daemon.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

interface Fixture {
  readonly root: string;
  readonly project: string;
  readonly agent: string;
  readonly cache: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-warden-headless-s1-")));
  const project = join(root, "project");
  const agent = join(root, "agent");
  const cache = join(root, "cache");
  await mkdir(join(agent, "pi-warden"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "pi-warden.md"), "# No silent fallbacks\nNever swallow errors silently in production code.\n");
  await writeFile(join(project, "app.ts"), "export function run() {\n  return 1;\n}\n");
  return { root, project, agent, cache };
}

function runCliHook(
  fx: Fixture,
  host: "claude" | "codex",
  event: string,
  payload: unknown,
  envOverrides: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string; parsed: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: fx.agent,
      PI_WARDEN_CACHE_DIR: fx.cache,
    };
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const child = spawn(process.execPath, ["--import", TSX, CLI, "hook", host, event], {
      cwd: fx.project,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 25_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const parsed = stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {};
      resolve({ code, stdout, stderr, parsed });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Claude Code PreToolUse/PostToolUse/Stop hooks judge via local Warden-S1 daemon without PI_WARDEN_ENABLED or cloud key", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(
      join(fx.agent, "pi-warden", "config.json"),
      JSON.stringify({
        typesafeBackend: "warden-s1",
        rules: { enabled: true, system0: false },
        done: { enabled: true, nudge: true },
      }),
    );

    const env = {
      PI_WARDEN_S1_MOCK_WEIGHTS: "1",
      PI_WARDEN_ENABLED: undefined,
      TYPESAFE_API_KEY: undefined,
    };

    const promptRes = await runCliHook(
      fx,
      "claude",
      "UserPromptSubmit",
      { session_id: "claude-s1", cwd: fx.project, hook_event_name: "UserPromptSubmit", prompt: "Update app.ts" },
      env,
    );
    assert.equal(promptRes.code, 0, promptRes.stderr);

    const targetFile = join(fx.project, "app.ts");
    const preRes = await runCliHook(
      fx,
      "claude",
      "PreToolUse",
      {
        session_id: "claude-s1",
        cwd: fx.project,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_use_id: "edit-1",
        tool_input: { file_path: targetFile, old_string: "return 1;", new_string: "return 2;" },
      },
      env,
    );
    assert.equal(preRes.code, 0, preRes.stderr);
    assert.deepEqual(preRes.parsed, {});

    await writeFile(targetFile, "export function run() {\n  return 2;\n}\n");
    const postRes = await runCliHook(
      fx,
      "claude",
      "PostToolUse",
      {
        session_id: "claude-s1",
        cwd: fx.project,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "edit-1",
        tool_input: { file_path: targetFile, old_string: "return 1;", new_string: "return 2;" },
        tool_response: "File updated.",
      },
      env,
    );
    assert.equal(postRes.code, 0, postRes.stderr);
    const postCtx = (postRes.parsed.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    assert.equal(postCtx.includes("PI_WARDEN_ENABLED"), false);

    const afterEdit = await getWardenS1DaemonStatus(fx.cache);
    assert.equal(afterEdit.running, true, "Claude PostToolUse must start the local Warden-S1 daemon");
    assert.ok((afterEdit.stats?.requests_served ?? 0) >= 1, "Claude rules hook must send a local judgment");
    const reqsAfterEdit = afterEdit.stats!.requests_served;

    const stopRes = await runCliHook(
      fx,
      "claude",
      "Stop",
      {
        session_id: "claude-s1",
        cwd: fx.project,
        hook_event_name: "Stop",
        last_assistant_message: "Done! Updated app.ts and everything works.",
      },
      env,
    );
    assert.equal(stopRes.code, 0, stopRes.stderr);
    assert.equal(String(stopRes.parsed.systemMessage ?? "").includes("PI_WARDEN_ENABLED"), false);

    const afterStop = await getWardenS1DaemonStatus(fx.cache);
    assert.equal(afterStop.running, true);
    assert.ok(
      (afterStop.stats?.requests_served ?? 0) > reqsAfterEdit,
      "Claude Stop done-check hook must judge via the shared local daemon",
    );
  } finally {
    await stopWardenS1Daemon(fx.cache, 5000).catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("Codex PostToolUse apply_patch and Stop hooks judge via local Warden-S1 daemon without PI_WARDEN_ENABLED or cloud key", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(
      join(fx.agent, "pi-warden", "config.json"),
      JSON.stringify({
        typesafeBackend: "warden-s1",
        rules: { enabled: true, system0: false },
        done: { enabled: true, nudge: true },
      }),
    );

    const env = {
      PI_WARDEN_S1_MOCK_WEIGHTS: "1",
      PI_WARDEN_ENABLED: undefined,
      TYPESAFE_API_KEY: undefined,
    };

    const promptRes = await runCliHook(
      fx,
      "codex",
      "UserPromptSubmit",
      { session_id: "codex-s1", cwd: fx.project, hook_event_name: "UserPromptSubmit", prompt: "Patch app.ts" },
      env,
    );
    assert.equal(promptRes.code, 0, promptRes.stderr);

    const patch = [
      "*** Begin Patch",
      "*** Update File: app.ts",
      "@@ export function run() {",
      "-  return 1;",
      "+  return 42;",
      "*** End Patch",
      "",
    ].join("\n");
    const postRes = await runCliHook(
      fx,
      "codex",
      "PostToolUse",
      {
        session_id: "codex-s1",
        transcript_path: null,
        cwd: fx.project,
        hook_event_name: "PostToolUse",
        model: "gpt-test",
        permission_mode: "default",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_use_id: "patch-1",
        tool_input: { command: patch },
        tool_response: "Success. Updated the following files:",
      },
      env,
    );
    assert.equal(postRes.code, 0, postRes.stderr);
    const postCtx = (postRes.parsed.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    assert.equal(postCtx.includes("PI_WARDEN_ENABLED"), false);

    const afterPatch = await getWardenS1DaemonStatus(fx.cache);
    assert.equal(afterPatch.running, true, "Codex PostToolUse must start the local Warden-S1 daemon");
    assert.ok((afterPatch.stats?.requests_served ?? 0) >= 1, "Codex rules hook must judge locally");
    const reqsAfterPatch = afterPatch.stats!.requests_served;

    const stopRes = await runCliHook(
      fx,
      "codex",
      "Stop",
      {
        session_id: "codex-s1",
        cwd: fx.project,
        hook_event_name: "Stop",
        last_assistant_message: "All done, app.ts is updated and verified.",
      },
      env,
    );
    assert.equal(stopRes.code, 0, stopRes.stderr);
    assert.equal(String(stopRes.parsed.systemMessage ?? "").includes("PI_WARDEN_ENABLED"), false);

    const afterStop = await getWardenS1DaemonStatus(fx.cache);
    assert.ok(
      (afterStop.stats?.requests_served ?? 0) > reqsAfterPatch,
      "Codex Stop done-check hook must judge via the shared local daemon",
    );
  } finally {
    await stopWardenS1Daemon(fx.cache, 5000).catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("headless hooks with typesafeBackend warden-s1 and no downloaded model report the local-model notice and never fall back to cloud", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(
      join(fx.agent, "pi-warden", "config.json"),
      JSON.stringify({
        typesafeBackend: "warden-s1",
        localModel: { runtime: "onnx" },
        rules: { enabled: true, system0: false },
      }),
    );

    await writeFile(join(fx.project, "added.ts"), "export const ok = true;\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.ts",
      "+export const ok = true;",
      "*** End Patch",
      "",
    ].join("\n");
    const res = await runCliHook(
      fx,
      "codex",
      "PostToolUse",
      {
        session_id: "codex-missing",
        transcript_path: null,
        cwd: fx.project,
        hook_event_name: "PostToolUse",
        model: "gpt-test",
        permission_mode: "default",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_use_id: "patch-missing",
        tool_input: { command: patch },
        tool_response: "Success. Updated the following files:",
      },
      {
        PI_WARDEN_S1_MOCK_WEIGHTS: undefined,
        PI_WARDEN_ENABLED: "1",
        TYPESAFE_API_KEY: "unused-cloud-key",
      },
    );
    assert.equal(res.code, 0, res.stderr);
    const ctx = (res.parsed.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    assert.match(ctx, /download the local Warden-S1 model with \/warden model download in Pi/);
    assert.equal(existsSync(join(fx.cache, "warden-s1-daemon.json")), false, "no daemon may start without weights");
  } finally {
    await stopWardenS1Daemon(fx.cache, 5000).catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});
