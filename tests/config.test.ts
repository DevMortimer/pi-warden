import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ArmingTracker } from "../src/arming.js";
import { applyProjectOverrides, applyUserOverrides, defaultConfig, loadConfig, loosenNotice, loosenRecordPath, loosenedChecks, readLoosenRecord, readProjectConfig, setUserSetting, userConfigPath, writeLoosenRecord } from "../src/config.js";
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
  assert.equal(config.notices, false, "per-call warning notices are hidden from the transcript by default");
  assert.equal(config.timeoutMs, config.action.timeoutMs);
});

test("subagent observer defaults on and accepts only boolean overrides", () => {
  const base = defaultConfig();
  assert.equal(base.subagent.observer, true);
  for (const apply of [applyUserOverrides, applyProjectOverrides]) {
    assert.equal(apply(base, { subagent: { observer: false } }).subagent.observer, false);
    for (const observer of [undefined, "false", 0, null]) {
      assert.equal(apply(base, { subagent: { observer } }).subagent.observer, true);
    }
  }
});

test("should-proceed keeps its threshold and drops the removed steer switch", () => {
  const base = defaultConfig();
  assert.deepEqual(base.action.shouldProceed, { threshold: 0.6 });
  for (const apply of [applyUserOverrides, applyProjectOverrides]) {
    assert.deepEqual(apply(base, { action: { shouldProceed: { threshold: 0.3 } } }).action.shouldProceed, { threshold: 0.3 });
  }
});

/** Every key the code no longer reads, with the shape that sets it. Proof that the warning fires and the value is gone. */
const REMOVED: ReadonlyArray<{ path: string; raw: Record<string, unknown> }> = [
  { path: "steerVisible", raw: { steerVisible: true } },
  { path: "steerBudget", raw: { steerBudget: 3 } },
  { path: "action.shouldProceed.steer", raw: { action: { shouldProceed: { steer: true } } } },
  { path: "action.offTask.steer", raw: { action: { offTask: { steer: 0.9 } } } },
  { path: "action.offTask.confirm", raw: { action: { offTask: { confirm: 0.7 } } } },
  { path: "action.intentTraceOnly", raw: { action: { intentTraceOnly: "none" } } },
  { path: "steers.adaptive", raw: { steers: { adaptive: false } } },
  { path: "steers.minSteers", raw: { steers: { minSteers: 5 } } },
  { path: "steers.minFollowed", raw: { steers: { minFollowed: 0.5 } } },
  { path: "steers.maxDisputed", raw: { steers: { maxDisputed: 0.5 } } },
  { path: "steers.recheckEvery", raw: { steers: { recheckEvery: 5 } } },
  { path: "steers.probeEvery", raw: { steers: { probeEvery: 2 } } },
];

for (const { path, raw } of REMOVED) {
  test(`a removed key ${path} is warned about once and changes nothing else`, () => {
    const config = applyUserOverrides(defaultConfig(), raw);
    const mine = (config.warnings ?? []).filter(warning => warning.startsWith(`${path} was removed`));
    assert.equal(mine.length, 1, `one warning for ${path}`);
    assert.match(mine[0]!, /was removed and is ignored; /, "the warning says the key is gone and ignored");
    assert.deepEqual({ ...config, warnings: [] }, { ...defaultConfig(), warnings: [] }, `${path} changes no setting`);
    assert.equal(applyProjectOverrides(defaultConfig(), raw).warnings?.filter(warning => warning.includes(path)).length, 1, "a project file is warned about too");
  });
}

test("user overrides accept valid values and ignore junk", () => {
  const config = applyUserOverrides(defaultConfig(), {
    typesafe: true, mode: "advise", enabled: "yes", headless: "allow",
    action: { tools: ["bash", 7, ""], irreversible: { warn: 0.9, confirm: 0.6 }, offTask: { warn: 2 }, timeoutMs: -1, failOpen: false, unknown: 1 },
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
  assert.equal(config.action.offTask.warn, 0.6, "a probability above 1 is junk and falls back");
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
  assert.equal((applyUserOverrides(defaultConfig(), { notices: true }) as { notices?: boolean }).notices, true, "notices is read");
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
  assert.deepEqual(trusted.action.offTask, { warn: 0.3 }, "the pre-0.12 name `confirm` no longer sets a second threshold");
  assert.match((trusted.warnings ?? []).join("; "), /project file: action\.offTask\.confirm was removed and is ignored/);
  assert.deepEqual(applyUserOverrides(defaultConfig(), { action: { offTask: { warn: 0.5 } } }).action.offTask, { warn: 0.5 }, "warn is the only off-task threshold");
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

test("a project file cannot name a security.shareLinkParams entry", () => {
  assert.deepEqual(applyProjectOverrides(defaultConfig(), { security: { shareLinkParams: ["xsec_token"] } }).security.shareLinkParams, [], "the project file cannot name a parameter");
  assert.deepEqual(applyUserOverrides(defaultConfig(), { security: { shareLinkParams: [" xsec_token ", 7, "", null] } }).security.shareLinkParams, ["xsec_token"], "the user file trims and drops non-strings and blanks");
  const user = applyUserOverrides(defaultConfig(), { security: { shareLinkParams: ["xsec_token"] } });
  assert.deepEqual(applyProjectOverrides(user, { security: { shareLinkParams: ["other"] } }).security.shareLinkParams, ["xsec_token"], "a project file cannot replace the user's list");
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
  const loose = applyProjectOverrides(defaultConfig(), { stuck: { enabled: false }, rules: { threshold: 0.95 }, action: { offTask: { warn: 0.9 } } });
  assert.equal(loose.stuck.enabled, false);
  assert.equal(loose.rules.threshold, 0.95);
  assert.deepEqual(loose.action.offTask, { warn: 0.9 });
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

test("learning.allowedRetentionDays defaults to 90 and takes 0 or a positive whole number", () => {
  assert.equal(defaultConfig().learning.allowedRetentionDays, 90);
  assert.equal(applyUserOverrides(defaultConfig(), { learning: { allowedRetentionDays: 0 } }).learning.allowedRetentionDays, 0);
  assert.equal(applyUserOverrides(defaultConfig(), { learning: { allowedRetentionDays: 30 } }).learning.allowedRetentionDays, 30);
  for (const junk of [-1, 1.5, "0", null]) {
    assert.equal(applyUserOverrides(defaultConfig(), { learning: { allowedRetentionDays: junk } }).learning.allowedRetentionDays, 90, JSON.stringify(junk));
  }
});

test("action.shouldProceed.hold, the deprecated name of threshold, still sets it through 1.x", () => {
  assert.equal(applyUserOverrides(defaultConfig(), { action: { shouldProceed: { hold: 0.3 } } }).action.shouldProceed.threshold, 0.3);
  assert.equal(applyProjectOverrides(defaultConfig(), { action: { shouldProceed: { hold: 0.4 } } }).action.shouldProceed.threshold, 0.4);
  assert.equal(applyUserOverrides(defaultConfig(), { action: { shouldProceed: { hold: 0.3, threshold: 0.2 } } }).action.shouldProceed.threshold, 0.2, "the new name wins");
  // A config module from before the rename hands the extension `hold`.
  const stale = { ...defaultConfig(), action: { ...defaultConfig().action, shouldProceed: { hold: 0.45 } } };
  assert.deepEqual(completeConfig(stale as never).config.action.shouldProceed, { threshold: 0.45 });
});

test("a config file that still sets the removed keys loads, ignores them, and warns once for each of the two documented keys", async () => {
  const path = userConfigPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({
    learning: { adaptiveThresholds: false, patternAnalysis: false, minHoldsForAdaptive: 3, adaptationRate: 0.5, retentionDays: 30 },
    conscience: { loadThreshold: 0.2, recommendThreshold: 0.9 },
  }));
  try {
    const config = loadConfig();
    assert.deepEqual(config.learning, { patternAnalysis: false, retentionDays: 30, allowedRetentionDays: 90 }, "the removed keys are gone; the allowed-call retention keeps its default");
    assert.equal("loadThreshold" in config.conscience, false);
    assert.equal(config.conscience.recommendThreshold, 0.9, "the rest of the section still applies");
    assert.equal(config.warnings.length, 2, "one warning for conscience.loadThreshold and one for learning.adaptiveThresholds; the two undocumented keys give none");
    assert.ok(config.warnings.some(warning => warning.startsWith("conscience.loadThreshold was removed and is ignored")));
    assert.ok(config.warnings.some(warning => warning.startsWith("learning.adaptiveThresholds was removed and is ignored")));
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

test("removed keys: conscience.loadThreshold and learning.adaptiveThresholds each give one warning, from the user file and from a project file", () => {
  const removed = [
    { section: "conscience", key: "loadThreshold", value: 0.9, now: /no score loads a skill by itself/ },
    { section: "learning", key: "adaptiveThresholds", value: true, now: /\/warden recommend suggests changes/ },
  ] as const;
  for (const { section, key, value, now } of removed) {
    const user = applyUserOverrides(defaultConfig(), { [section]: { [key]: value } });
    assert.equal(user.warnings.length, 1, `${key}: one warning from the user file`);
    assert.match(user.warnings[0]!, new RegExp(`^${section}\\.${key} was removed and is ignored; `));
    assert.match(user.warnings[0]!, now);
    const project = applyProjectOverrides(defaultConfig(), { [section]: { [key]: value } });
    assert.equal(project.warnings.length, 1, `${key}: one warning from a project file`);
    assert.match(project.warnings[0]!, new RegExp(`^project file: ${section}\\.${key} was removed and is ignored; `));
  }
  const both = applyUserOverrides(defaultConfig(), { conscience: { loadThreshold: 1 }, learning: { adaptiveThresholds: false } });
  assert.equal(both.warnings.length, 2, "two keys, two warnings");
  assert.deepEqual(applyUserOverrides(defaultConfig(), { conscience: { recommendThreshold: 0.9 }, learning: { patternAnalysis: false } }).warnings, [], "a config without them gives none");
  assert.deepEqual(applyProjectOverrides(defaultConfig(), { conscience: { enabled: true }, learning: {} }).warnings, []);
});

// --- the project file: read once per session, and what it loosens is named once ---

test("a session reads its project file once: a later edit waits for the next session, the user file stays live", async () => {
  const file = join(project, ".pi", "pi-warden.json");
  const user = userConfigPath();
  await mkdir(join(temporary, "agent", "pi-warden"), { recursive: true });
  await writeFile(user, JSON.stringify({ slop: { enabled: false } }));
  await writeFile(file, JSON.stringify({ done: { enabled: false } }));
  const snapshot = { value: readProjectConfig(project) };
  const opening = loadConfig({ cwd: project, projectTrusted: true, projectRaw: snapshot });
  assert.equal(opening.done.enabled, false);
  assert.equal(opening.slop.enabled, false);
  // A mid-session edit of either file: the project file holds, the user file is read again on every call.
  await writeFile(file, JSON.stringify({ done: { enabled: true } }));
  await writeFile(user, JSON.stringify({ slop: { enabled: true } }));
  const sameSession = loadConfig({ cwd: project, projectTrusted: true, projectRaw: snapshot });
  assert.equal(sameSession.done.enabled, false, "the snapshot decides for this session");
  assert.equal(sameSession.slop.enabled, true, "the user file keeps its live reading");
  const nextSession = loadConfig({ cwd: project, projectTrusted: true, projectRaw: { value: readProjectConfig(project) } });
  assert.equal(nextSession.done.enabled, true, "the next session reads the project file again");
  await rm(file, { force: true });
  await rm(user, { force: true });
});

test("loosenedChecks names every check a project file takes away, and nothing when it takes none", () => {
  const user = defaultConfig();
  const layered = (raw: unknown) => applyProjectOverrides(user, raw);
  assert.deepEqual(loosenedChecks(user, layered({})), [], "an empty project file loosens nothing");
  assert.deepEqual(loosenedChecks(user, layered({ done: { enabled: true } })), [], "a stricter value loosens nothing");
  const switched = loosenedChecks(user, layered({ done: { enabled: false }, cause: { enabled: false }, rules: { enabled: false } }));
  assert.deepEqual(switched, [{ name: "done-check" }, { name: "cause-check" }, { name: "rules-check" }]);
  assert.equal(loosenNotice(switched), "This project's .pi/pi-warden.json switches off: done-check, cause-check, rules-check.");
  const raised = loosenedChecks(user, layered({ done: { claimsDone: 0.95 }, rules: { threshold: 0.9 } }));
  assert.deepEqual(raised, [
    { name: "done-check", detail: "claims-done threshold 0.7 → 0.95" },
    { name: "rules-check", detail: "threshold 0.7 → 0.9" },
  ]);
  assert.match(loosenNotice(raised), /^This project's \.pi\/pi-warden\.json loosens: done-check \(claims-done threshold 0\.7 → 0\.95\), rules-check \(threshold 0\.7 → 0\.9\)\.$/);
  // A project file cannot weaken the action guard or security: the loader refuses those values, so nothing is loosened.
  assert.deepEqual(loosenedChecks(user, layered({ action: { irreversible: { confirm: 0.99 } }, security: { enabled: false } })), []);
  const narrowed = loosenedChecks(user, layered({ rules: { files: ["RULES.md"], exclude: ["vendor/**"] }, done: { uiFiles: ["**/*.tsx"] } }));
  assert.deepEqual(narrowed, [
    { name: "done-check", detail: `UI files left out: ${user.done.uiFiles.join(", ")}` },
    { name: "rules-check", detail: "excluded paths added: vendor/**" },
  ]);
});

test("the loosened set is recorded per project: a missing or unreadable record shows the line", async () => {
  const other = join(temporary, "other-project");
  await mkdir(other, { recursive: true });
  assert.equal(readLoosenRecord(project), undefined, "no record yet");
  writeLoosenRecord(project, [{ name: "done-check" }]);
  assert.deepEqual(readLoosenRecord(project), [{ name: "done-check" }]);
  writeLoosenRecord(project, [{ name: "cause-check", detail: "claims-cause threshold 0.7 → 0.95" }]);
  assert.deepEqual(readLoosenRecord(project), [{ name: "cause-check", detail: "claims-cause threshold 0.7 → 0.95" }], "the detail is kept, so a further loosening of a named check shows again");
  assert.equal(readLoosenRecord(other), undefined, "another project has its own record");
  await writeFile(loosenRecordPath(project), "{ not json");
  assert.equal(readLoosenRecord(project), undefined, "an unreadable record shows the line again");
  // A record written before details were kept is not the same set: the line shows once more after the upgrade.
  await writeFile(loosenRecordPath(project), JSON.stringify({ version: 1, loosened: ["cause-check"] }));
  assert.equal(readLoosenRecord(project), undefined, "a names-only record reads as differs");
  await rm(loosenRecordPath(project), { force: true });
  await rm(other, { recursive: true, force: true });
});

test("the notice names every real loosening: switches, thresholds, lists and visual tools", () => {
  const user = defaultConfig();
  const of = (raw: unknown) => loosenedChecks(user, applyProjectOverrides(user, raw));
  const named = (raw: unknown) => of(raw).map(check => check.name);
  for (const [raw, name] of [
    [{ slop: { prose: { enabled: false } } }, "slop-check"],
    [{ rules: { fallback: false } }, "rules-check"],
    [{ rules: { maxChars: 500 } }, "rules-check"],
    [{ stuck: { minFailures: 9 } }, "stuck-check"],
    [{ waste: { enabled: false } }, "waste note"],
    [{ context: { largeOutput: { enabled: false } } }, "large-output notice"],
    [{ cause: { windowDays: 1 } }, "cause-check"],
    [{ done: { claimsDone: 0.95 } }, "done-check"],
    [{ done: { uiProof: false } }, "done-check"],
  ] as const) assert.ok(named(raw).includes(name), JSON.stringify(raw));
  // A project file can switch notifications off only from an on user value.
  const notifyOn = applyUserOverrides(user, { notify: { enabled: true } });
  assert.ok(loosenedChecks(notifyOn, applyProjectOverrides(notifyOn, { notify: { enabled: false } })).some(check => check.name === "notify"), "notify");
  // A project list replaces the user's: an added visual tool loosens, a removed one tightens.
  const added = of({ done: { visualTools: { commands: [...user.done.visualTools.commands, "screenshot.sh"] } } });
  assert.equal(added.length, 1);
  assert.match(added[0]!.detail ?? "", /screenshot\.sh/);
  assert.deepEqual(of({ done: { visualTools: { tools: [] } } }), [], "no visual tool is stricter");
  // A stricter value loosens nothing.
  assert.deepEqual(of({ rules: { threshold: 0.5 }, stuck: { minFailures: 1 }, cause: { windowDays: 90 } }), []);
});

test("every key a project file can set is classified as loosening a check or not a check", async () => {
  const table = (await import("../src/config.js") as unknown as { PROJECT_KEYS?: Record<string, { kind: string; why?: string; check?: string }> }).PROJECT_KEYS;
  assert.ok(table, "the classification table is exported");
  const leaves: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value) || value === null || typeof value !== "object" || Object.keys(value).length === 0) { leaves.push(path); return; }
    for (const [key, inner] of Object.entries(value)) walk(inner, path ? `${path}.${key}` : key);
  };
  walk(defaultConfig(), "");
  // The top-level keys applyProjectOverrides can replace, or set for a project.
  const projectSections = new Set(["enabled", "action", "stuck", "done", "cause", "slop", "security", "rules", "rulesAtTurnStart", "context", "runaway", "notify", "judge", "subagent", "waste", "compaction", "prefs"]);
  const unclassified = leaves.filter(path => projectSections.has(path.split(".")[0]!) && table![path] === undefined);
  assert.deepEqual(unclassified, []);
  const stale = Object.keys(table!).filter(path => !leaves.includes(path));
  assert.deepEqual(stale, [], "a table row for a key that no longer exists");
  for (const [path, entry] of Object.entries(table!)) {
    assert.ok(entry.kind === "none" ? Boolean(entry.why && entry.why.length) : Boolean(entry.check), `${path} says why it is not a check, or which check it loosens`);
  }
});

test("a session reads its user file once too: an outside edit waits for the next session", async () => {
  const user = userConfigPath();
  await writeFile(user, JSON.stringify({ mode: "steer", slop: { enabled: false } }));
  // The snapshot the extension takes at session start: the file's content, read once.
  const snapshot = { value: JSON.parse(await readFile(user, "utf8")) as Record<string, unknown> };
  const opening = loadConfig({ userRaw: snapshot });
  assert.equal(opening.mode, "steer");
  assert.equal(opening.slop.enabled, false);
  await writeFile(user, JSON.stringify({ mode: "advise", slop: { enabled: true } }));
  const sameSession = loadConfig({ userRaw: snapshot });
  assert.equal(sameSession.mode, "steer", "the snapshot decides for this session");
  assert.equal(sameSession.slop.enabled, false, "an outside edit of any key waits");
  assert.equal(loadConfig().mode, "advise", "a library caller without a snapshot reads the file as before");
  await rm(user, { force: true });
});

test("each direction that loosens is named, both ways: window days, off-task threshold, judge cooldown", () => {
  const user = defaultConfig();
  const of = (base: typeof user, raw: unknown) => loosenedChecks(base, applyProjectOverrides(base, raw));
  // A shorter cause window forgets earlier causes, so the repeat question is asked less: it loosens. A longer one tightens.
  assert.deepEqual(of(user, { cause: { windowDays: 1 } }).map(check => check.name), ["cause-check"]);
  assert.deepEqual(of(user, { cause: { windowDays: 90 } }), []);
  assert.match(of(user, { cause: { windowDays: 1 } })[0]!.detail ?? "", /window days 7 → 1/);
  // A higher off-task threshold reports less, so raising it loosens; lowering it tightens.
  assert.deepEqual(of(user, { action: { offTask: { warn: 0.9 } } }).map(check => check.name), ["off-task threshold"]);
  assert.match(of(user, { action: { offTask: { warn: 0.9 } } })[0]!.detail ?? "", /warn threshold 0\.6 → 0\.9/);
  assert.deepEqual(of(user, { action: { offTask: { warn: 0.2 } } }), []);
  // Fewer failures cool the judge down sooner, so a lower value loosens.
  assert.deepEqual(of(user, { judge: { failuresBeforeCooldown: 1 } }).map(check => check.name), ["judge"]);
  assert.match(of(user, { judge: { failuresBeforeCooldown: 1 } })[0]!.detail ?? "", /failures before cooldown 3 → 1/);
  assert.deepEqual(of(user, { judge: { failuresBeforeCooldown: 9 } }), []);
});

test("an empty loosened set is a record of its own, so the same set coming back reads as different", () => {
  writeLoosenRecord(project, [{ name: "cause-check", detail: "window days 7 → 1" }]);
  writeLoosenRecord(project, []);
  assert.deepEqual(readLoosenRecord(project), [], "the empty set is recorded, not missing");
  assert.notEqual(readLoosenRecord(project), undefined, "a missing record and an empty one are different");
  // A set that comes back after the empty record is not the recorded set, so its line shows again.
  const recorded = readLoosenRecord(project)!;
  assert.notEqual(recorded.length, 1);
  writeLoosenRecord(project, []);
  assert.deepEqual(readLoosenRecord(project), []);
});
