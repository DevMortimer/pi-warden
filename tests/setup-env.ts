/**
 * Loaded with `--import` before any test module: `node --test` passes it to every test file's process. A shell inside
 * Pi sets `PI_*` variables that point pi-warden at the developer's trace directory, database, index, and agent
 * directory, and turn consent or a mode on; a test run must neither read nor write them. Every `PI_*` variable and every
 * judge key is cleared, so no test can reach a real judge, and each process gets its own empty agent directory, removed
 * when it exits. A test that needs a variable sets it itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Debug switches for the tests themselves, not settings pi-warden reads. */
const KEPT = new Set(["PI_WARDEN_PRINT_SAMPLE"]);
const JUDGE_KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "COMMANDCODE_API_KEY"];

for (const name of Object.keys(process.env)) {
  if ((name.startsWith("PI_") && !KEPT.has(name)) || JUDGE_KEYS.includes(name)) delete process.env[name];
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-warden-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
