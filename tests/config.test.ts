import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { applyProjectOverrides, applyUserOverrides, defaultConfig, loadConfig, setUserSetting, userConfigPath } from "../src/config.js";

let temporary: string;
let project: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-warden-config-"));
  project = join(temporary, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(temporary, "agent");
});
after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await rm(temporary, { recursive: true, force: true });
});

test("defaults: guards on, steer mode, TypeSafe consent off, nudges on", () => {
  const config = defaultConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.typesafe, false);
  assert.equal(config.mode, "steer");
  assert.deepEqual(config.action.tools, ["bash", "powershell", "ctx_execute", "ctx_batch_execute", "ctx_execute_file", "write", "edit"]);
  assert.equal(config.action.failOpen, true);
  assert.ok(config.action.irreversible.warn < config.action.irreversible.confirm);
  assert.equal(config.stuck.nudge, true);
  assert.equal(config.done.nudge, true);
  assert.equal(config.slop.enabled, true);
  assert.equal(config.slop.prose.enabled, true);
  assert.equal(config.steerVisible, false, "steers are hidden from the transcript by default; the trace shows them");
  assert.equal(config.timeoutMs, config.action.timeoutMs);
});

test("user overrides accept valid values and ignore junk", () => {
  const config = applyUserOverrides(defaultConfig(), {
    typesafe: true, mode: "advise", enabled: "yes", headless: "allow",
    action: { tools: ["bash", 7, ""], irreversible: { warn: 0.9, confirm: 0.6 }, offTask: { confirm: 2 }, timeoutMs: -1, failOpen: false, unknown: 1 },
    stuck: { minFailures: 20, window: 5, sameStrategy: 0.9, nudge: false },
    done: { claimsDone: 0.5 },
    slop: { placeholder: 0.6, prose: { audience: "plain", trend: 9, threshold: 2 } },
  });
  assert.equal(config.typesafe, true);
  assert.equal(config.mode, "advise");
  assert.equal(config.enabled, true, "non-boolean falls back");
  assert.deepEqual(config.action.tools, ["bash"]);
  assert.deepEqual(config.action.irreversible, { warn: 0.6, confirm: 0.6 }, "warn is clamped to confirm");
  assert.equal(config.action.offTask.confirm, 0.85);
  assert.equal(config.action.timeoutMs, 5000);
  assert.equal(config.action.failOpen, false);
  assert.equal(config.stuck.window, 5);
  assert.equal(config.stuck.minFailures, 5, "minFailures is clamped to the window");
  assert.equal(config.stuck.sameStrategy, 0.9);
  assert.equal(config.stuck.nudge, false);
  assert.equal(config.done.claimsDone, 0.5);
  assert.equal(config.slop.threshold, 0.6, "0.2.x placeholder key sets the shared threshold");
  assert.equal(config.slop.prose.audience, "plain");
  assert.equal(config.slop.prose.trend, 3, "trend is capped at the 3-reply window");
  assert.equal(config.slop.prose.threshold, 0.7, "out-of-range probability falls back");
  assert.equal(applyUserOverrides(defaultConfig(), { steerVisible: true }).steerVisible, true);
  assert.equal(applyUserOverrides(defaultConfig(), { mode: "loud" }).mode, "steer");
});

test("0.1.x files keep working: action.timeoutMs and action.maxRequests are read as shared settings", () => {
  const config = applyUserOverrides(defaultConfig(), { action: { timeoutMs: 8000, maxRequests: 50 } });
  assert.equal(config.timeoutMs, 8000);
  assert.equal(config.action.timeoutMs, 8000);
  assert.equal(config.maxRequests, 50);
  const explicit = applyUserOverrides(defaultConfig(), { timeoutMs: 3000, action: { timeoutMs: 8000 } });
  assert.equal(explicit.timeoutMs, 3000, "top-level wins");
});

test("project overrides cannot grant consent, change the mode, or raise budgets", () => {
  const config = applyProjectOverrides(defaultConfig(), { typesafe: true, mode: "advise", maxRequests: 9999, timeoutMs: 1, action: { tools: ["bash"], irreversible: { confirm: 0.9 } }, stuck: { enabled: false } });
  assert.equal(config.typesafe, false);
  assert.equal(config.mode, "steer");
  assert.equal(config.maxRequests, 500);
  assert.equal(config.action.timeoutMs, 5000);
  assert.deepEqual(config.action.tools, ["bash"]);
  assert.equal(config.action.irreversible.confirm, 0.9);
  assert.equal(config.stuck.enabled, false);
});

test("loadConfig merges user then trusted project file, and survives malformed files", async () => {
  assert.equal(loadConfig({ cwd: project, projectTrusted: true }).typesafe, false, "no files yet");
  const path = setUserSetting("typesafe", true);
  assert.equal(path, userConfigPath());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { typesafe: true });

  await writeFile(join(project, ".pi", "pi-warden.json"), JSON.stringify({ typesafe: false, action: { offTask: { warn: 0.3, confirm: 0.4 } } }));
  const trusted = loadConfig({ cwd: project, projectTrusted: true });
  assert.equal(trusted.typesafe, true, "project file cannot flip consent");
  assert.deepEqual(trusted.action.offTask, { warn: 0.3, confirm: 0.4 });
  const untrusted = loadConfig({ cwd: project, projectTrusted: false });
  assert.equal(untrusted.action.offTask.warn, 0.6, "untrusted projects are ignored");

  await writeFile(path, "{ not json");
  assert.equal(loadConfig().typesafe, false, "malformed user file falls back to defaults");
  setUserSetting("typesafe", true);
  setUserSetting("enabled", false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { typesafe: true, enabled: false });
});
