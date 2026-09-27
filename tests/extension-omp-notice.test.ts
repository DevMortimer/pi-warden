/**
 * End-to-end omp-host check, in a child process where the Pi peer is a stub: the extension factory
 * builds `dirs` from the stub's `getAgentDir()`/`CONFIG_DIR_NAME`, an interactive first
 * `session_start` shows the migration notice once and writes the marker, and a second session is
 * silent. The legacy data lives under the fake `$HOME/.pi/agent` (the Pi default
 * `defaultHostDirs()` falls back to; `PI_CODING_AGENT_DIR` is cleared so it cannot redirect).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const child = new URL("./fixtures/extension-omp-notice-child.mts", import.meta.url).pathname;

test("extension on an omp-like host: notice once, marker written, headless silent", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-warden-extomp-"));
  try {
    // The stub's getAgentDir() returns OMP_DIR (the host dirs). defaultHostDirs() resolves the Pi
    // default from $HOME/.pi/agent, so the legacy data lives under the fake HOME. The fixture
    // creates the pi-warden subfolders and the omp dir itself; only `work` is needed here.
    const home = join(temp, "home");
    mkdirSync(join(temp, "work"), { recursive: true });
    const { stdout } = await run(process.execPath, ["--import", "tsx", child], {
      cwd: root,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: undefined,
        PI_WARDEN_DB: undefined,
        PI_WARDEN_INDEX_DIR: undefined,
        PI_WARDEN_STEER_STATS: undefined,
        PI_WARDEN_TRACE_DIR: undefined,
        PI_WARDEN_HOST_PATHS: undefined,
        PI_WARDEN_ENABLED: undefined,
        PI_WARDEN_MODE: undefined,
        EXT_PATH: join(root, "src", "extension.ts"),
        OMP_DIR: join(temp, "omp"),
        WORK_DIR: join(temp, "work"),
        HOME: home,
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    assert.match(stdout, /EXT_OMP_NOTICE_OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
