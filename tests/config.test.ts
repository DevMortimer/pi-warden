import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ArmingTracker } from "../src/arming.js";
import { applyProjectOverrides, applyUserOverrides, defaultConfig, loadConfig, setUserSetting, userConfigPath } from "../src/config.js";
import { completeConfig } from "../src/shape.js";

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
  assert.deepEqual(config.action.irreversible, { warn: 0.5, confirm: 0.9 }, "0.9 is the surveyed hold threshold");
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
  assert.deepEqual(base.action.shouldProceed, { threshold: 0.6, steer: false });
  for (const apply of [applyUserOverrides, applyProjectOverrides]) {
    assert.deepEqual(apply(base, { action: { shouldProceed: { steer: true, threshold: 0.3 } } }).action.shouldProceed, { threshold: 0.3, steer: true });
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
  assert.equal(applyUserOverrides(defaultConfig(), { judge: { cooldownMs: 3_600_000 } }).judge.cooldownMs, 600_000, "the judge cooldown is capped at 10 minutes");
  assert.equal(applyUserOverrides(defaultConfig(), { judge: { cooldownMs: 30_000 } }).judge.cooldownMs, 30_000);
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
  assert.equal(config.done.uiProof, true);
  assert.ok(config.done.uiFiles.includes("**/web/**/*.js"));
  const ui = applyUserOverrides(defaultConfig(), { done: { uiProof: false, uiFiles: ["**/*.css", 3], visualTools: { commands: ["cypress"], images: [".gif"] } } }).done;
  assert.equal(ui.uiProof, false);
  assert.deepEqual(ui.uiFiles, ["**/*.css"]);
  assert.deepEqual(ui.visualTools, { ...defaultConfig().done.visualTools, commands: ["cypress"], images: ["gif"] }, "unset lists keep their defaults; a leading dot is dropped");
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
  const config = applyProjectOverrides(defaultConfig(), { typesafe: true, mode: "advise", maxRequests: 9999, timeoutMs: 1, action: { tools: ["bash"], irreversible: { confirm: 0.95 } }, stuck: { enabled: false } });
  assert.equal(config.typesafe, false);
  assert.equal(config.mode, "steer");
  assert.equal(config.maxRequests, 500);
  assert.equal(config.action.timeoutMs, 5000);
  assert.deepEqual(config.action.tools, defaultConfig().action.tools, "a project cannot remove guarded tools");
  assert.equal(config.action.irreversible.confirm, 0.9, "nor raise the hold threshold");
  assert.equal(applyProjectOverrides(defaultConfig(), { action: { irreversible: { confirm: 0.8 } } }).action.irreversible.confirm, 0.8, "a project override still lowers the hold threshold");
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
  const config = applyProjectOverrides(userBase, { action: { tools: ["bash", "write", "read"] } });
  assert.deepEqual(config.action.tools, [...defaultConfig().action.tools, "read"], "the project override applied where it may: it added read");
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

test("a project file with security.maskOutput false leaves output masking on", () => {
  const project = applyProjectOverrides(defaultConfig(), { security: { maskOutput: false, threshold: 0.5 } });
  assert.equal(project.security.maskOutput, true, "the project file cannot turn masking off");
  assert.equal(project.security.threshold, 0.5, "other security keys still apply from a project file");
  assert.equal(applyUserOverrides(defaultConfig(), { security: { maskOutput: false } }).security.maskOutput, false, "the user file can");
  const userOff = applyUserOverrides(defaultConfig(), { security: { maskOutput: false } });
  assert.equal(applyProjectOverrides(userOff, { security: { maskOutput: true } }).security.maskOutput, false, "nor can a project file turn it back on over the user's choice");
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
  assert.equal(defaultConfig().backendRefusal, undefined);
});

test("user overrides: typesafeBackend accepts names and endpoint objects and refuses junk", () => {
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: "openrouter" }).typesafeBackend, "openrouter");
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: "commandcode" }).typesafeBackend, "commandcode");
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: "typesafe" }).typesafeBackend, "typesafe");
  const gateway = { label: "Acme judge gateway", host: "https://gw.acme.example", path: "/judge/v1/decide", keyEnv: "ACME_JUDGE_KEY", defaultModel: "jev-1.13" };
  assert.deepEqual(applyUserOverrides(defaultConfig(), { typesafeBackend: gateway }).typesafeBackend, gateway, "an endpoint object is kept as written");
  const refusedName = applyUserOverrides(defaultConfig(), { typesafeBackend: "azure" });
  assert.equal(refusedName.typesafeBackend, undefined, "an unknown name no longer falls back to typesafe");
  assert.match(refusedName.backendRefusal!, /Unknown judgment backend "azure"/);
  const refusedObject = applyUserOverrides(defaultConfig(), { typesafeBackend: { label: "Acme judge gateway", host: "http://gw.acme.example", keyEnv: "ACME_JUDGE_KEY" } });
  assert.equal(refusedObject.typesafeBackend, undefined, "an object pi-typesafe refuses turns judgments off");
  assert.match(refusedObject.backendRefusal!, /absolute https/);
  assert.equal(applyUserOverrides(defaultConfig(), { typesafeBackend: null }).typesafeBackend, "typesafe", "null falls back");
  assert.equal(applyUserOverrides(defaultConfig(), {}).typesafeBackend, "typesafe", "missing falls back");
});

test("project overrides cannot set typesafeBackend in either form", () => {
  const gateway = { label: "Evil gateway", host: "https://evil.example", keyEnv: "EVIL_KEY", defaultModel: "jev-1.13" };
  assert.equal(applyProjectOverrides(defaultConfig(), { typesafeBackend: "openrouter" }).typesafeBackend, "typesafe", "project file cannot redirect judgments");
  assert.deepEqual(applyProjectOverrides(defaultConfig(), { typesafeBackend: gateway }).typesafeBackend, "typesafe", "project file cannot redirect judgments with an endpoint object");
});

test("floor: user 'level' persists through project override without floor key", () => {
  const base = applyUserOverrides(defaultConfig(), { action: { floor: "level" } });
  const project = applyProjectOverrides(base, {});
  assert.equal(project.action.floor, "level", "user floor survives project override");
});

test("floor: project file cannot change user 'level' to 'evidence'", () => {
  const base = applyUserOverrides(defaultConfig(), { action: { floor: "level" } });
  const project = applyProjectOverrides(base, { action: { floor: "evidence" } });
  assert.equal(project.action.floor, "level", "project cannot lower user's protective floor setting");
});

test("floor: invalid value falls back to base", () => {
  const base = applyUserOverrides(defaultConfig(), { action: { floor: "level" } });
  const project = applyProjectOverrides(base, { action: { floor: "bogus" } });
  assert.equal(project.action.floor, "level", "invalid value does not override user setting");
});

test("conscience.skipTools defaults to the core tools and accepts an override", () => {
  assert.deepEqual(defaultConfig().conscience.skipTools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(applyUserOverrides(defaultConfig(), { conscience: { skipTools: [] } }).conscience.skipTools, []);
  assert.deepEqual(applyUserOverrides(defaultConfig(), { conscience: { skipTools: ["bash", 3] } }).conscience.skipTools, ["bash"]);
  assert.deepEqual(applyUserOverrides(defaultConfig(), { conscience: { skipTools: "bash" } }).conscience.skipTools, defaultConfig().conscience.skipTools);
});

test("conscience.advanceThreshold defaults to 0.70", () => {
  const config = defaultConfig();
  assert.equal(config.conscience.advanceThreshold, 0.70);
});

test("conscience.advanceThreshold clamps to [0, 1]", () => {
  const config1 = applyUserOverrides(defaultConfig(), { conscience: { advanceThreshold: -0.5 } });
  assert.equal(config1.conscience.advanceThreshold, 0, "negative clamps to 0");
  const config2 = applyUserOverrides(defaultConfig(), { conscience: { advanceThreshold: 1.5 } });
  assert.equal(config2.conscience.advanceThreshold, 1, "above 1 clamps to 1");
  const config3 = applyUserOverrides(defaultConfig(), { conscience: { advanceThreshold: 0.85 } });
  assert.equal(config3.conscience.advanceThreshold, 0.85, "valid value passes through");
});

test("prefs: on for /warden prefs, injection on by default; invalid values fall back", () => {
  assert.deepEqual(defaultConfig().prefs, { enabled: true, inject: true });
  assert.deepEqual(applyUserOverrides(defaultConfig(), { prefs: { inject: false } }).prefs, { enabled: true, inject: false });
  assert.deepEqual(applyUserOverrides(defaultConfig(), { prefs: { enabled: "no", inject: 1 } }).prefs, { enabled: true, inject: true });
  assert.deepEqual(applyProjectOverrides(defaultConfig(), { prefs: { enabled: false } }).prefs, { enabled: false, inject: true });
});

test("every rule kind reads deny and block as the same value, with no warning", () => {
  const config = applyUserOverrides(defaultConfig(), { action: {
    commandRules: [{ id: "c-block", pattern: "a", severity: "block" }, { id: "c-deny", pattern: "b", severity: "deny" }],
    commandDenyRules: [{ id: "d-block", pattern: "c", severity: "block" }],
    pathRules: [{ id: "p-deny", paths: ["~/.ssh/*"], action: "deny" }, { id: "p-block", paths: ["~/.aws/*"], action: "block" }],
    armingRules: [
      { id: "a-deny", when: { edited: ["**/x"] }, arms: { command: "apply" }, action: "deny" },
      { id: "a-block", when: { edited: ["**/y"] }, arms: { command: "apply" }, action: "block" },
    ],
  } });
  assert.deepEqual(config.action.commandRules.map(rule => rule.severity), ["deny", "deny"]);
  assert.equal(config.action.commandRules[0]!.action, undefined, "a deny rule carries no dialog action");
  assert.deepEqual(config.action.commandDenyRules.map(rule => rule.severity), ["deny"]);
  assert.deepEqual(config.action.pathRules.map(rule => rule.action), ["block", "block"]);
  assert.deepEqual(config.action.armingRules.map(rule => rule.action), ["block", "block"]);
  assert.deepEqual(config.warnings, []);
});

test("an unknown rule value applies at confirm, never weaker, and warns once naming the rule, the value, and the valid values", () => {
  const config = applyUserOverrides(defaultConfig(), { action: {
    commandRules: [{ id: "c-typo", pattern: "a", severity: "blok" }, { id: "c-missing", pattern: "b" }],
    commandDenyRules: [{ id: "d-typo", pattern: "c", severity: "stop" }],
    pathRules: [{ id: "p-typo", paths: ["~/.ssh/*"], action: "forbid" }, { id: "p-missing", paths: ["~/.aws/*"] }],
    armingRules: [{ id: "a-typo", when: { edited: ["**/x"] }, arms: { command: "apply", for: "5m" }, action: "halt" }],
  } });
  assert.equal(config.action.commandRules[0]!.severity, "confirm", "an unknown severity holds instead of warning");
  assert.equal(config.action.commandRules[0]!.action, "dialog", "the hold is one the user can approve");
  assert.equal(config.action.commandRules[1]!.severity, "warn", "a missing severity keeps the documented default");
  assert.equal(config.action.commandDenyRules[0]!.severity, "deny", "a deny rule never drops below its own list's level");
  assert.equal(config.action.pathRules[0]!.action, "confirm", "an unknown path action holds instead of noting");
  assert.equal(config.action.pathRules[1]!.action, "note", "a missing action keeps the documented default");
  assert.equal(config.action.armingRules.length, 1, "an unknown arming action no longer drops the rule");
  assert.equal(config.action.armingRules[0]!.action, "confirm");
  assert.deepEqual(config.warnings, [
    'command rule "c-typo": severity "blok" is not one of warn, confirm, deny, block; the rule applies at confirm',
    'command rule "d-typo": severity "stop" is not one of warn, confirm, deny, block; the rule applies at deny',
    'path rule "p-typo": action "forbid" is not one of note, warn, confirm, block, deny; the rule applies at confirm',
    'arming rule "a-typo": action "halt" is not one of confirm, hold, block, deny; the rule applies at confirm',
  ]);
  assert.deepEqual(defaultConfig().warnings, [], "the defaults carry no warning");
});

test("arming durations: a number is milliseconds, a string takes a unit or means minutes, and surprises warn", () => {
  const rule = (id: string, forValue: unknown) => ({ id, when: { edited: ["**/x"] }, arms: { command: "apply", for: forValue }, action: "confirm" });
  const config = applyUserOverrides(defaultConfig(), { action: { armingRules: [
    rule("ms-number", 30), rule("bare-string", "30"), rule("hours", "1.5h"), rule("half-second", "500ms"), rule("seconds", "45s"),
  ] } });
  assert.deepEqual(config.action.armingRules.map(entry => entry.arms.for), [30, 1_800_000, 5_400_000, 500, 45_000]);
  assert.deepEqual(config.warnings, [
    'arming rule "ms-number": arms for 30 ms, under one second; a number in arms.for is milliseconds, "10m" is ten minutes',
    'arming rule "bare-string": arms.for "30" has no unit and is read as minutes; write it with ms, s, m, or h',
    'arming rule "half-second": arms for 500 ms, under one second; a number in arms.for is milliseconds, "10m" is ten minutes',
  ]);
});

test("arming durations: the tracker reads a string duration the same way the config does", () => {
  let now = 0;
  const tracker = new ArmingTracker([{ id: "bare", when: { edited: ["**/x.yaml"] }, arms: { command: "apply", for: "30" }, action: "confirm" }], () => now);
  tracker.arm("write", "/p/x.yaml", "/p");
  now = 29 * 60_000;
  assert.equal(tracker.checkArmed("apply").length, 1, "a unitless string is minutes in the tracker too");
  now = 31 * 60_000;
  assert.equal(tracker.checkArmed("apply").length, 0);
});

test("project file: the action guard and security keys take a stricter value and ignore a weaker one with one warning each", () => {
  const cases: Array<{ key: string; raw: Record<string, unknown>; read: (config: ReturnType<typeof defaultConfig>) => unknown; user?: Record<string, unknown>; tighter: unknown; weaker: Record<string, unknown>; kept: unknown }> = [
    { key: "enabled", raw: { enabled: true }, user: { enabled: false }, read: c => c.enabled, tighter: true, weaker: { enabled: false }, kept: true },
    { key: "action.enabled", raw: { action: { enabled: true } }, user: { action: { enabled: false } }, read: c => c.action.enabled, tighter: true, weaker: { action: { enabled: false } }, kept: true },
    { key: "security.enabled", raw: { security: { enabled: true } }, user: { security: { enabled: false } }, read: c => c.security.enabled, tighter: true, weaker: { security: { enabled: false } }, kept: true },
    { key: "action.irreversible.warn", raw: { action: { irreversible: { warn: 0.3 } } }, read: c => c.action.irreversible.warn, tighter: 0.3, weaker: { action: { irreversible: { warn: 0.6 } } }, kept: 0.5 },
    { key: "action.irreversible.confirm", raw: { action: { irreversible: { confirm: 0.8 } } }, read: c => c.action.irreversible.confirm, tighter: 0.8, weaker: { action: { irreversible: { confirm: 0.95 } } }, kept: 0.9 },
    { key: "security.threshold", raw: { security: { threshold: 0.5 } }, read: c => c.security.threshold, tighter: 0.5, weaker: { security: { threshold: 0.9 } }, kept: 0.7 },
    { key: "action.failOpen", raw: { action: { failOpen: false } }, user: { action: { failOpen: false } }, read: c => c.action.failOpen, tighter: false, weaker: { action: { failOpen: true } }, kept: false },
  ];
  for (const { key, raw, user, read, tighter, weaker, kept } of cases) {
    const userBase = applyUserOverrides(defaultConfig(), user ?? {});
    const stricter = applyProjectOverrides(userBase, raw);
    assert.equal(read(stricter), tighter, `${key}: the stricter project value is taken`);
    assert.deepEqual(stricter.warnings, [], `${key}: no warning for a stricter value`);
    // Weaker is measured against the user's value: for the switches and failOpen that is the default (on, closed).
    const weakerBase = key === "action.failOpen" ? userBase : defaultConfig();
    const ignored = applyProjectOverrides(weakerBase, weaker);
    assert.equal(read(ignored), kept, `${key}: the weaker project value is ignored`);
    assert.equal(ignored.warnings.length, 1, `${key}: one warning`);
    assert.match(ignored.warnings[0]!, new RegExp(`^project file: ${key.replace(/\./g, "\\.")} `));
  }
  // A project on a user file that already failed open changes nothing and says nothing.
  assert.deepEqual(applyProjectOverrides(defaultConfig(), { action: { failOpen: true } }).warnings, []);
});

test("project file: action.tools may add a tool but a left-out tool stays guarded, with one warning", () => {
  const added = applyProjectOverrides(defaultConfig(), { action: { tools: [...defaultConfig().action.tools, "read"] } });
  assert.deepEqual(added.action.tools, [...defaultConfig().action.tools, "read"]);
  assert.deepEqual(added.warnings, []);
  const shrunk = applyProjectOverrides(defaultConfig(), { action: { tools: [] } });
  assert.deepEqual(shrunk.action.tools, defaultConfig().action.tools, "an empty list removes nothing");
  assert.deepEqual(shrunk.warnings, [`project file: action.tools leaves out ${defaultConfig().action.tools.join(", ")}; a project file may add tools but not remove them, so they stay guarded`]);
  assert.deepEqual(applyUserOverrides(defaultConfig(), { action: { tools: ["bash"] } }).action.tools, ["bash"], "the user file still sets the list");
});

test("project file: other guards stay tunable both ways, and the user file is never limited", () => {
  const loose = applyProjectOverrides(defaultConfig(), { stuck: { enabled: false }, rules: { threshold: 0.95 }, action: { offTask: { warn: 0.9, steer: 0.95 } } });
  assert.equal(loose.stuck.enabled, false);
  assert.equal(loose.rules.threshold, 0.95);
  assert.deepEqual(loose.action.offTask, { warn: 0.9, steer: 0.95 });
  assert.deepEqual(loose.warnings, []);
  const user = applyUserOverrides(defaultConfig(), { enabled: false, action: { enabled: false, failOpen: true, irreversible: { warn: 0.8, confirm: 0.99 } }, security: { enabled: false, threshold: 0.9 } });
  assert.equal(user.enabled, false);
  assert.equal(user.action.enabled, false);
  assert.deepEqual(user.action.irreversible, { warn: 0.8, confirm: 0.99 });
  assert.deepEqual([user.security.enabled, user.security.threshold], [false, 0.9]);
  assert.deepEqual(user.warnings, []);
});

test("project warnings follow the user file's own warnings", () => {
  const user = applyUserOverrides(defaultConfig(), { action: { commandRules: [{ id: "x", pattern: "x", severity: "nope" }] } });
  const project = applyProjectOverrides(user, { security: { enabled: false } });
  assert.equal(project.warnings.length, 2);
  assert.match(project.warnings[0]!, /^command rule "x"/);
  assert.match(project.warnings[1]!, /^project file: security\.enabled false is ignored/);
});

test("learning.retentionDays 0 keeps every record, as documented; invalid values keep the default", () => {
  assert.equal(applyUserOverrides(defaultConfig(), { learning: { retentionDays: 0 } }).learning.retentionDays, 0);
  assert.equal(applyUserOverrides(defaultConfig(), { learning: { retentionDays: 30 } }).learning.retentionDays, 30);
  for (const junk of [-1, 1.5, "0", null]) {
    assert.equal(applyUserOverrides(defaultConfig(), { learning: { retentionDays: junk } }).learning.retentionDays, 365, JSON.stringify(junk));
  }
});

test("action.shouldProceed.hold, the deprecated name of threshold, still sets it through 1.x", () => {
  assert.equal(applyUserOverrides(defaultConfig(), { action: { shouldProceed: { hold: 0.3 } } }).action.shouldProceed.threshold, 0.3);
  assert.equal(applyProjectOverrides(defaultConfig(), { action: { shouldProceed: { hold: 0.4 } } }).action.shouldProceed.threshold, 0.4);
  assert.equal(applyUserOverrides(defaultConfig(), { action: { shouldProceed: { hold: 0.3, threshold: 0.2 } } }).action.shouldProceed.threshold, 0.2, "the new name wins");
  // A config module from before the rename hands the extension `hold`.
  const stale = { ...defaultConfig(), action: { ...defaultConfig().action, shouldProceed: { hold: 0.45, steer: true } } };
  assert.deepEqual(completeConfig(stale as never).config.action.shouldProceed, { threshold: 0.45, steer: true });
});

test("a config file that still sets the removed keys loads cleanly", async () => {
  const path = userConfigPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({
    learning: { adaptiveThresholds: false, patternAnalysis: false, minHoldsForAdaptive: 3, adaptationRate: 0.5, retentionDays: 30 },
    conscience: { loadThreshold: 0.2, recommendThreshold: 0.9 },
  }));
  try {
    const config = loadConfig();
    assert.deepEqual(config.learning, { patternAnalysis: false, retentionDays: 30 });
    assert.equal("loadThreshold" in config.conscience, false);
    assert.equal(config.conscience.recommendThreshold, 0.9, "the rest of the section still applies");
    assert.deepEqual(config.warnings, []);
  } finally {
    await rm(path, { force: true });
  }
});

test("an arming rule with no action is still ignored, now with one config warning naming it", () => {
  const config = applyUserOverrides(defaultConfig(), { action: { armingRules: [
    { id: "no-action", when: { edited: ["**/x"] }, arms: { command: "apply", for: "5m" } },
    { id: "kept", when: { edited: ["**/y"] }, arms: { command: "apply", for: "5m" }, action: "hold" },
  ] } });
  assert.deepEqual(config.action.armingRules.map(rule => rule.id), ["kept"]);
  assert.deepEqual(config.warnings, ['arming rule "no-action": has no action and is ignored; set action to confirm, hold, or block']);
});
