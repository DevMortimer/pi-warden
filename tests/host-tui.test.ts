/**
 * Host-TUI capability guard: the extension loads and mounts all guards even
 * when the host's bundled pi-tui lacks the MouseRegion component.
 *
 * Every guard mounts under both hosts — identical event hooks, commands, and
 * shortcuts. The omp-notice fixture (tests/fixtures/extension-omp-notice-child.mts)
 * covers the host without MouseRegion: it stubs pi-tui without that component.
 *
 * No network. No live host. No TypeSafe requests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { before, after, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedEnv: Record<string, string | undefined> = {};
let agentTemp = "";

/** Build dist/ so extensions/index.js (which re-exports ../dist/extension.js) is loadable, and
 *  point the agent directory at a temp dir so session_start never touches the developer's data. */
before(() => {
  execFileSync("npm", ["run", "build"], { cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  agentTemp = mkdtempSync(join(tmpdir(), "pi-warden-tui-"));
  for (const key of ["PI_CODING_AGENT_DIR", "PI_WARDEN_DB", "PI_WARDEN_TRACE_DIR", "PI_WARDEN_HOST_PATHS", "PI_WARDEN_ENABLED", "PI_WARDEN_MODE", "PI_WARDEN_INDEX_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = agentTemp;
  process.env.PI_WARDEN_DB = join(agentTemp, "holds.db");
  for (const key of ["PI_WARDEN_TRACE_DIR", "PI_WARDEN_HOST_PATHS", "PI_WARDEN_ENABLED", "PI_WARDEN_MODE", "PI_WARDEN_INDEX_DIR"]) {
    delete process.env[key];
  }
});

after(() => {
  for (const key of Object.keys(savedEnv)) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (agentTemp) rmSync(agentTemp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared mock host
// ---------------------------------------------------------------------------

function createHost() {
  const events: Array<{ type: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
  const commands = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();
  const shortcuts = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();

  const pi = {
    on(type: string, handler: (event: unknown, ctx: unknown) => unknown) { events.push({ type, handler }); },
    registerCommand(name: string, def: { description: string; handler: (...args: unknown[]) => unknown }) { commands.set(name, def); },
    registerShortcut(_key: string, def: { description: string; handler: (...args: unknown[]) => unknown }) { shortcuts.set("ctrl+shift+w", def); },
    registerTool() {},
    sendMessage() {},
  };

  const ctx = {
    hasUI: true,
    ui: {
      notify() {},
      confirm() { return Promise.resolve(true); },
      editor() { return Promise.resolve(undefined); },
      setWidget() {},
    },
    cwd: tmpdir(),
    sessionManager: { getBranch() { return []; }, getSessionId() { return "test-session"; } },
    signal: undefined,
    isProjectTrusted() { return true; },
  };

  return { pi, ctx, events, commands, shortcuts };
}

// ---------------------------------------------------------------------------
// All guards mount under the real host
// ---------------------------------------------------------------------------

test("every guard mounts on a host whose TUI has a mouse region", async () => {
  // @ts-expect-error — extensions/index.js has no type declarations; it re-exports the built dist.
  const ext = await import("../extensions/index.js");
  const defaultExport = (ext as { default: (pi: unknown) => void }).default;
  const host = createHost();
  defaultExport(host.pi);
  const sessionEvent = host.events.find(e => e.type === "session_start");
  assert.ok(sessionEvent);
  await sessionEvent.handler({}, host.ctx);

  assert.equal(host.events.length, 14, "14 event hooks registered");
  assert.deepEqual([...host.commands.keys()], ["warden"], "1 command: /warden");
  assert.ok(host.shortcuts.size >= 1, "at least 1 shortcut registered");
  // session_start opened the isolated database, not the developer's ~/.pi/agent/pi-warden.
  assert.ok(existsSync(join(agentTemp, "holds.db")), "the temp holds.db was created");
});
