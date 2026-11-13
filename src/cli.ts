#!/usr/bin/env node
import { FILE_BYTES, HostFileError } from "./hosts/io.js";
import type { HostName } from "./hosts/state.js";

async function readInput(signal: AbortSignal): Promise<unknown> {
  return new Promise((done, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      process.stdin.off("data", data).off("end", end).off("error", error).pause();
      signal.removeEventListener("abort", abort);
    };
    const error = (): void => { cleanup(); process.stdin.destroy(); reject(new Error("Cannot read hook input.")); };
    const abort = (): void => { cleanup(); process.stdin.destroy(); reject(new Error("Hook input deadline reached.")); };
    const data = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > FILE_BYTES) { error(); return; }
      chunks.push(chunk);
    };
    const end = (): void => {
      cleanup();
      try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Invalid hook JSON.")); }
    };
    if (signal.aborted) { abort(); return; }
    process.stdin.on("data", data).once("end", end).once("error", error);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const USAGE = "Usage: pi-warden hook <claude|codex> <event> | init <claude|codex> [--project] | uninstall <claude|codex> [--project]";

/** The events each host's installer registers; any other event is not implemented. */
const HOOK_EVENTS: Record<HostName, readonly string[]> = {
  claude: ["PreToolUse", "PostToolUse", "PostToolUseFailure"],
  codex: ["PostToolUse"],
};

async function main(): Promise<void> {
  const [command, agent, event] = process.argv.slice(2);
  try {
    if (command === "--help" || command === "-h") {
      process.stdout.write(`${USAGE}\nPer-edit rules: Claude Write/Edit, Codex apply_patch.\n`);
      return;
    }
    if (command === "hook") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        if ((agent !== "claude" && agent !== "codex") || !event || !HOOK_EVENTS[agent].includes(event) || process.argv.length !== 5) {
          process.stderr.write("pi-warden: unsupported hook; only Claude Write/Edit and Codex apply_patch rules are implemented.\n");
          return;
        }
        const input = await readInput(controller.signal);
        const { runHostHook } = await import("./hosts/headless.js");
        process.stdout.write(`${JSON.stringify(await runHostHook(agent, event, input, controller.signal))}\n`);
      }
      finally { clearTimeout(timer); }
      return;
    }
    if (agent !== "claude" && agent !== "codex") throw new Error("Expected the claude or codex host.");
    if ((command === "init" || command === "uninstall") && process.argv.slice(4).every(argument => argument === "--project") && process.argv.length <= 5) {
      const { CLAUDE_HOST, CODEX_HOST, hookSettingsPath, installHooks, uninstallHooks } = await import("./hosts/hook-settings.js");
      const host = agent === "claude" ? CLAUDE_HOST : CODEX_HOST;
      const path = hookSettingsPath(host, process.cwd(), process.argv.includes("--project"));
      if (command === "init") await installHooks(host, path);
      else if (await uninstallHooks(host, path)) process.stderr.write("pi-warden: user-modified or duplicated hook entries were retained.\n");
      return;
    }
    throw new Error(USAGE);
  } catch (error) {
    process.stderr.write(command === "hook" ? "pi-warden: rules check skipped; invalid input, unavailable state or judge, or hook deadline.\n"
      : error instanceof HostFileError ? `pi-warden: ${error.message}\n`
      : `pi-warden: ${agent === "codex" ? "hooks" : "settings"} could not be changed; check the JSON, receipt and file permissions.\n`);
    process.exitCode = command === "hook" ? 0 : 1;
  }
}

void main();
