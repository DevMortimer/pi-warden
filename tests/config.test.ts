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

test("defaults are conservative: guard on, TypeSafe consent off, headless blocks", () => {
  const config = defaultConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.typesafe, false);
  assert.equal(config.headless, "block");
  assert.deepEqual(config.action.tools, ["bash", "write", "edit"]);
  assert.equal(config.action.failOpen, true);
  assert.ok(config.action.irreversible.warn < config.action.irreversible.confirm);
});

test("user overrides accept valid values and ignore junk", () => {
  const config = applyUserOverrides(defaultConfig(), {
    typesafe: true, headless: "allow", enabled: "yes",
    action: { tools: ["bash", 7, ""], irreversible: { warn: 0.9, confirm: 0.6 }, offTask: { confirm: 2 }, timeoutMs: -1, failOpen: false, unknown: 1 },
  });
  assert.equal(config.typesafe, true);
  assert.equal(config.headless, "allow");
  assert.equal(config.enabled, true, "non-boolean falls back");
  assert.deepEqual(config.action.tools, ["bash"]);
  assert.deepEqual(config.action.irreversible, { warn: 0.6, confirm: 0.6 }, "warn is clamped to confirm");
  assert.equal(config.action.offTask.confirm, 0.85);
  assert.equal(config.action.timeoutMs, 5000);
  assert.equal(config.action.failOpen, false);
});

test("project overrides cannot grant consent or change headless policy", () => {
  const config = applyProjectOverrides(defaultConfig(), { typesafe: true, headless: "allow", action: { tools: ["bash"], irreversible: { confirm: 0.9 } } });
  assert.equal(config.typesafe, false);
  assert.equal(config.headless, "block");
  assert.deepEqual(config.action.tools, ["bash"]);
  assert.equal(config.action.irreversible.confirm, 0.9);
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
