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
  assert.equal(config.notices, false, "per-call warning notices are hidden from the transcript by default");
  assert.equal(config.timeoutMs, config.action.timeoutMs);
});

test("should-proceed steer parser accepts booleans and defaults invalid or missing values", () => {
  const base = defaultConfig();
  assert.deepEqual(base.action.shouldProceed, { hold: 0.6, steer: false });
  for (const apply of [applyUserOverrides, applyProjectOverrides]) {
    assert.deepEqual(apply(base, { action: { shouldProceed: { steer: true, hold: 0.3 } } }).action.shouldProceed, { hold: 0.3, steer: true });
    for (const steer of [undefined, "true", 1, null, false]) {
      assert.equal(apply(base, { action: { shouldProceed: { steer } } }).action.shouldProceed.steer, false);
    }
  }
});

test("user overrides accept valid values and ignore junk", () => {
  const config = applyUserOverrides(defaultConfig(), {
    typesafe: true, mode: "advise", enabled: "yes", headless: "allow",
    action: { tools: ["bash", 7, ""], irreversible: { warn: 0.9, confirm: 0.6 }, offTask: { confirm: 2 }, timeoutMs: -1, failOpen: false, unknown: 1 },
    stuck: { minFailures: 20, window: 5, sameStrategy: 0.9, nudge: false },
    done: { claimsDone: 0.5 },
    slop: { placeholder: 0.6, prose: { audience: "plain", trend: 9, threshold: 2 } },
    runaway: { repeats: 1, thinkingRepeats: 0.5, minChars: 100, recover: false },
    notify: { enabled: false, cooldownMs: 0, command: ["my-notifier", "{title}", "{body}"] },
  });
  assert.deepEqual(config.notify, { enabled: false, cooldownMs: 0, command: ["my-notifier", "{title}", "{body}"] });
  assert.deepEqual(applyUserOverrides(defaultConfig(), { notify: { cooldownMs: -5, command: ["", "x"] } }).notify, defaultConfig().notify, "a negative cooldown and a blank executable are junk");
  assert.deepEqual(applyUserOverrides(defaultConfig(), { notify: { command: ["ok", 7] } }).notify.command, [], "a non-string argument rejects the whole command");
  assert.deepEqual(config.runaway, { enabled: true, repeats: 2, thinkingRepeats: 10, minChars: 100, recover: false }, "one occurrence is not a repeat; a fraction is junk");
  assert.equal(config.typesafe, true);
  assert.equal(config.mode, "advise");
  assert.equal(config.enabled, true, "non-boolean falls back");
  assert.deepEqual(config.action.tools, ["bash"]);
  assert.deepEqual(config.action.irreversible, { warn: 0.6, confirm: 0.6 }, "warn is clamped to confirm");
  assert.equal(config.action.offTask.steer, 0.85);
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
  assert.equal(applyUserOverrides(defaultConfig(), { notices: true }).notices, true);
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
  const quiet = applyProjectOverrides(defaultConfig(), { notify: { enabled: false, command: ["evil"] } });
  assert.equal(quiet.notify.enabled, false, "a project may switch notifications off");
  assert.deepEqual(quiet.notify.command, [], "but never names a command to run");
});

test("project overrides cannot set command rules, deny rules, or exempt rules", () => {
  const config = applyProjectOverrides(defaultConfig(), { action: { commandRules: [{ id: "evil", pattern: ".", severity: "deny" }], commandDenyRules: [{ id: "evil-deny", pattern: ".", severity: "deny" }], exemptRules: ["infra-destroy"] } });
  assert.deepEqual(config.action.commandRules, [], "project file cannot declare command rules");
  assert.deepEqual(config.action.commandDenyRules, [], "project file cannot declare deny rules");
  assert.deepEqual(config.action.exemptRules, [], "project file cannot exempt built-ins");
});

test("a trusted project action block cannot wipe the user's command rules", () => {
  // The user's rules survive a project file that sets other action keys — action.tools is the documented case.
  const userBase = applyUserOverrides(defaultConfig(), { action: {
    commandRules: [{ id: "kubectl-delete", pattern: "\\bkubectl\\s+delete\\b", severity: "confirm" }],
    commandDenyRules: [{ id: "never-reset", pattern: "\\btalosctl\\s+reset\\b" }],
    exemptRules: ["sudo"],
  } });
  const config = applyProjectOverrides(userBase, { action: { tools: ["bash", "write"] } });
  assert.deepEqual(config.action.tools, ["bash", "write"], "the project override applied where it may");
  assert.equal(config.action.commandRules.length, 1, "user command rules survive the project override");
  assert.equal(config.action.commandRules[0]!.id, "kubectl-delete");
  assert.equal(config.action.commandDenyRules.length, 1, "user deny rules survive the project override");
  assert.equal(config.action.commandDenyRules[0]!.id, "never-reset");
  assert.deepEqual(config.action.exemptRules, ["sudo"], "user exemptions survive the project override");
});

test("user config accepts command rules, deny rules, and exempt rules", () => {
  const config = applyUserOverrides(defaultConfig(), { action: { commandRules: [{ id: "kubectl-delete", pattern: "\\bkubectl\\s+delete\\b", severity: "confirm" }], commandDenyRules: [{ id: "never-reset", pattern: "\\btalosctl\\s+reset\\b" }], exemptRules: ["infra-destroy", "sudo"] } });
  assert.equal(config.action.commandRules.length, 1);
  assert.equal(config.action.commandRules[0]!.id, "kubectl-delete");
  assert.equal(config.action.commandRules[0]!.severity, "confirm");
  assert.equal(config.action.commandDenyRules.length, 1);
  assert.equal(config.action.commandDenyRules[0]!.id, "never-reset");
  assert.deepEqual(config.action.exemptRules, ["infra-destroy", "sudo"]);
  const messy = applyUserOverrides(defaultConfig(), { action: { commandRules: [{ id: "x", pattern: ".", severity: "warn" }, { id: "x", pattern: ".", severity: "warn" }, { id: "", pattern: "." }, { id: "y", pattern: "" }] } });
  assert.equal(messy.action.commandRules.length, 1, "duplicate ids and invalid entries are skipped");
  assert.equal(messy.action.commandRules[0]!.id, "x");
});

test("project overrides cannot set path rules", () => {
  const config = applyProjectOverrides(defaultConfig(), { action: { pathRules: [{ id: "evil", paths: ["**/*"], access: "none", tools: ["*"], action: "block" }] } });
  assert.deepEqual(config.action.pathRules, [], "a project file cannot declare path rules");
});

test("a trusted project action block cannot wipe the user's path rules", () => {
  const userBase = applyUserOverrides(defaultConfig(), { action: {
    pathRules: [{ id: "ssh-keys", paths: ["~/.ssh/id_*"], access: "write", tools: ["*"], action: "block" }],
  } });
  const config = applyProjectOverrides(userBase, { action: { tools: ["bash", "write"] } });
  assert.equal(config.action.pathRules.length, 1, "user path rules survive the project override");
  assert.equal(config.action.pathRules[0]!.id, "ssh-keys");
});

test("user config accepts path rules; invalid entries and duplicate ids are skipped", () => {
  const config = applyUserOverrides(defaultConfig(), { action: { pathRules: [
    { id: "env-files", paths: ["**/.env", "**/.env.*"], access: "none", tools: ["*"], action: "confirm", onlyIfExists: true },
    { id: "env-files", paths: ["**/.env"], access: "none", tools: ["*"], action: "note" },
    { id: "", paths: ["**/.env"] },
    { id: "no-paths", paths: [] },
    { id: "bad-tool", paths: ["**/.env"], tools: ["made-up-tool"], access: "none", action: "block" },
    { id: "defaults", paths: ["~/.ssh/*"], },
  ] } });
  assert.equal(config.action.pathRules.length, 2, "duplicate ids, missing fields, and inert tools are skipped");
  const env = config.action.pathRules[0]!;
  assert.equal(env.id, "env-files");
  assert.equal(env.access, "none");
  assert.equal(env.action, "confirm");
  assert.equal(env.onlyIfExists, undefined, "onlyIfExists defaults to true and is omitted at the default");
  const defaults = config.action.pathRules[1]!;
  assert.equal(defaults.id, "defaults");
  assert.equal(defaults.access, "none", "access defaults to none");
  assert.equal(defaults.action, "note", "action defaults to note");
  assert.deepEqual(defaults.tools, ["*"], "tools default to the bash surface");
  assert.equal(defaults.onlyIfExists, undefined, "onlyIfExists defaults to true and is omitted when not overridden");
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
  assert.deepEqual(trusted.action.offTask, { warn: 0.3, steer: 0.4 }, "the pre-0.12 name `confirm` still sets the upper off-task threshold");
  assert.deepEqual(applyUserOverrides(defaultConfig(), { action: { offTask: { warn: 0.5, steer: 0.4 } } }).action.offTask, { warn: 0.4, steer: 0.4 }, "warn is clamped to steer");
  const untrusted = loadConfig({ cwd: project, projectTrusted: false });
  assert.equal(untrusted.action.offTask.warn, 0.6, "untrusted projects are ignored");

  await writeFile(path, "{ not json");
  assert.equal(loadConfig().typesafe, false, "malformed user file falls back to defaults");
  setUserSetting("typesafe", true);
  setUserSetting("enabled", false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { typesafe: true, enabled: false });
});

// Legacy and malformed config sections must preserve the objects dereferenced by event handlers.
test("regression: hostile config files cannot leave a guard's `.enabled` dereference undefined", () => {
  const hostile = [undefined, null, false, 0, "yes", [], { enabled: null }, { prose: null }, { prose: false }, { prose: 3 }, { prose: [] }];
  const guards = [
    { path: ["action"], raw: [undefined, null, false, "x", [], { enabled: null }] },
    { path: ["stuck"], raw: [undefined, null, true, 7, "x", [], { enabled: null }] },
    { path: ["done"], raw: [undefined, null, true, 7, "x", [], { enabled: null }] },
    { path: ["runaway"], raw: [undefined, null, true, 7, "x", [], { enabled: null }] },
    { path: ["notify"], raw: [undefined, null, true, 7, "x", [], { enabled: null, command: "x" }] },
    { path: ["slop"], raw: hostile },
    { path: ["widget"], raw: [undefined, null, true, 7, "x", [], { enabled: null }] },
  ] as const;
  for (const guard of guards) {
    for (const value of guard.raw) {
      for (const apply of [applyUserOverrides, applyProjectOverrides]) {
        const config = apply(defaultConfig(), { [guard.path[0]]: value });
        const section = config[guard.path[0]];
        assert.equal(typeof section.enabled, "boolean", `${apply.name} ${guard.path[0]}: ${JSON.stringify(value)}`);
      }
    }
  }
  // The exact crash-site chain: agent_end reads `config.slop.enabled && config.slop.prose.enabled && config.slop.prose.minChars`.
  for (const value of hostile) {
    const config = applyUserOverrides(defaultConfig(), { slop: value });
    assert.equal(typeof config.slop.enabled, "boolean");
    assert.equal(typeof config.slop.prose.enabled, "boolean");
    assert.equal(typeof config.slop.prose.minChars, "number");
  }
});

test("project overrides cannot set arming rules", () => {
  const config = applyProjectOverrides(defaultConfig(), { action: { armingRules: [{ id: "evil", when: { edited: ["**/*"] }, arms: { command: ".*" }, action: "block" }] } });
  assert.deepEqual(config.action.armingRules, [], "a project file cannot declare arming rules");
});

test("a trusted project action block cannot wipe the user's arming rules", () => {
  const userBase = applyUserOverrides(defaultConfig(), { action: {
    armingRules: [{ id: "gitops", when: { edited: ["**/kustomization.yaml"] }, arms: { command: "\\bflux\\b", for: "10m" }, action: "confirm" }],
  } });
  const config = applyProjectOverrides(userBase, { action: { tools: ["bash", "write"] } });
  assert.equal(config.action.armingRules.length, 1, "user arming rules survive the project override");
  assert.equal(config.action.armingRules[0]!.id, "gitops");
});

test("user config accepts arming rules; invalid entries and duplicate ids are skipped", () => {
  const config = applyUserOverrides(defaultConfig(), { action: { armingRules: [
    { id: "gitops", when: { edited: ["**/kustomization.yaml"] }, arms: { command: "\\bflux\\b", for: "10m" }, action: "confirm" },
    { id: "gitops", when: { edited: ["**/x.yaml"] }, arms: { command: "." }, action: "hold" },
    { id: "", when: { edited: ["**/x.yaml"] }, arms: { command: "." }, action: "confirm" },
    { id: "no-edited", when: { edited: [] }, arms: { command: "." }, action: "confirm" },
    { id: "no-command", when: { edited: ["**/x.yaml"] }, arms: { command: "" }, action: "confirm" },
    { id: "no-action", when: { edited: ["**/x.yaml"] }, arms: { command: "." } },
    { id: "bad-when-tools", when: { edited: ["**/x.yaml"], tools: ["bash"] }, arms: { command: "." }, action: "confirm" },
  ] } });
  assert.equal(config.action.armingRules.length, 1, "only the valid rule survives");
  assert.equal(config.action.armingRules[0]!.id, "gitops");
  assert.equal(config.action.armingRules[0]!.when.tools, undefined);
});

test("arming rules parse duration strings and numbers", () => {
  const config = applyUserOverrides(defaultConfig(), { action: { armingRules: [
    { id: "string-minutes", when: { edited: ["**/x"] }, arms: { command: ".", for: "10m" }, action: "confirm" },
    { id: "string-seconds", when: { edited: ["**/x"] }, arms: { command: ".", for: "30s" }, action: "confirm" },
    { id: "string-hours", when: { edited: ["**/x"] }, arms: { command: ".", for: "2h" }, action: "confirm" },
    { id: "number-ms", when: { edited: ["**/x"] }, arms: { command: ".", for: 5000 }, action: "confirm" },
    { id: "default", when: { edited: ["**/x"] }, arms: { command: "." }, action: "confirm" },
  ] } });
  assert.equal(config.action.armingRules.length, 5);
  assert.equal(typeof config.action.armingRules[0]!.arms.for, "number");
  assert.equal(config.action.armingRules[0]!.arms.for, 600_000);
  assert.equal(config.action.armingRules[1]!.arms.for, 30_000);
  assert.equal(config.action.armingRules[2]!.arms.for, 7_200_000);
  assert.equal(config.action.armingRules[3]!.arms.for, 5000);
  assert.equal(config.action.armingRules[4]!.arms.for, 600_000, "default is 10 minutes");
});

test("defaults: typesafeBackend is typesafe", () => {
  assert.equal(defaultConfig().typesafeBackend, "typesafe");
});

test("user overrides: typesafeBackend accepts valid values and ignores junk", () => {
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: "openrouter" }).typesafeBackend, "openrouter");
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: "typesafe" }).typesafeBackend, "typesafe");
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: "azure" }).typesafeBackend, "typesafe", "invalid backend falls back");
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: null }).typesafeBackend, "typesafe", "null falls back");
  assert.equal(applyUserOverrides(defaultConfig(), {}).typesafeBackend, "typesafe", "missing falls back");
});

test("project overrides cannot set typesafeBackend", () => {
  const config = applyProjectOverrides(defaultConfig(), { typesafeBackend: "openrouter" });
  assert.equal(config.typesafeBackend, "typesafe", "project file cannot redirect judgments");
});
