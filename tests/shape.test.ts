import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SCHEMA, defaultConfig } from "../src/config.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { completeConfig, EXPECTED_SCHEMA, shapeWarning, taskSpine } from "../src/shape.js";

test("a complete config passes through untouched", () => {
  const config = defaultConfig();
  const result = completeConfig(config);
  assert.deepEqual(result.missing, []);
  assert.strictEqual(result.config.slop, config.slop);
  assert.equal(CONFIG_SCHEMA, EXPECTED_SCHEMA, "bump both when WardenConfig gains a section");
});

test("regression: the live crash shape (slop without prose) and older module shapes are disabled and named, never thrown", () => {
  const legacy = defaultConfig() as unknown as Record<string, unknown>;
  delete legacy.security;
  delete legacy.context;
  legacy.slop = { enabled: true, threshold: 0.7 };
  const result = completeConfig(legacy as never);
  assert.deepEqual(result.missing, ["security", "context", "slop.prose"]);
  assert.equal(result.config.slop.prose.enabled, false);
  assert.equal(result.config.security.enabled, false);
  assert.equal(result.config.context.enabled, false);
  assert.equal(result.config.action.enabled, true, "present sections keep working");
  // The exact expression that threw in Ryan's sessions.
  assert.doesNotThrow(() => result.config.slop.enabled && result.config.slop.prose.enabled && 300 >= result.config.slop.prose.minChars);
  assert.match(shapeWarning(result.missing, undefined), new RegExp(`security, context, slop\\.prose .* schema pre-3, extension expects ${EXPECTED_SCHEMA}.*restart Pi`));
  const empty = completeConfig(undefined);
  assert.ok(empty.missing.length >= 9);
  assert.equal(empty.config.enabled, true);
});

test("a 0.7 config module without the runaway and notify sections disables both and renders the default widget line", () => {
  const older = defaultConfig() as unknown as Record<string, unknown>;
  delete older.runaway;
  delete older.notify;
  const widget = { ...(older.widget as Record<string, unknown>) };
  delete widget.runaway;
  older.widget = widget;
  const result = completeConfig(older as never);
  assert.deepEqual(result.missing, ["runaway", "notify"]);
  assert.equal(result.config.runaway.enabled, false);
  assert.equal(result.config.notify.enabled, false);
  assert.equal(result.config.widget.runaway, defaultConfig().widget.runaway);
});

test("a config module whose rules section predates the soft tier leaves it off, and a set value is kept", () => {
  const older = defaultConfig() as unknown as Record<string, unknown>;
  const rules = { ...(older.rules as Record<string, unknown>) };
  delete rules.softThreshold;
  older.rules = rules;
  const result = completeConfig(older as never);
  assert.deepEqual(result.missing, [], "the section is present, only the new key is missing");
  assert.equal(result.config.rules.softThreshold, 0);
  const kept = completeConfig({ ...defaultConfig(), rules: { ...defaultConfig().rules, softThreshold: 0.5 } } as never);
  assert.equal(kept.config.rules.softThreshold, 0.5);
});

test("a config module whose rules section predates rules.maxRequests sends the one request it always did, and a set value is kept", () => {
  const older = defaultConfig() as unknown as Record<string, unknown>;
  const rules = { ...(older.rules as Record<string, unknown>) };
  delete rules.maxRequests;
  older.rules = rules;
  const result = completeConfig(older as never);
  assert.deepEqual(result.missing, []);
  assert.equal(result.config.rules.maxRequests, 1);
  const kept = completeConfig({ ...defaultConfig(), rules: { ...defaultConfig().rules, maxRequests: 2 } } as never);
  assert.equal(kept.config.rules.maxRequests, 2);
});

test("a config module whose rules section predates rules.auditExtensions adds none, and a set value is kept", () => {
  const older = defaultConfig() as unknown as Record<string, unknown>;
  const rules = { ...(older.rules as Record<string, unknown>) };
  delete rules.auditExtensions;
  older.rules = rules;
  const result = completeConfig(older as never);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.config.rules.auditExtensions, []);
  const kept = completeConfig({ ...defaultConfig(), rules: { ...defaultConfig().rules, auditExtensions: ["astro"] } } as never);
  assert.deepEqual(kept.config.rules.auditExtensions, ["astro"]);
  const junk = completeConfig({ ...defaultConfig(), rules: { ...defaultConfig().rules, auditExtensions: ["astro", 4] } } as never);
  assert.deepEqual(junk.config.rules.auditExtensions, ["astro"], "an entry that is not a string is dropped");
});

test("a 0.8 config module without the rules section disables the rules guard and renders its default widget line", () => {
  const older = defaultConfig() as unknown as Record<string, unknown>;
  delete older.rules;
  const widget = { ...(older.widget as Record<string, unknown>) };
  delete widget.rules;
  older.widget = widget;
  const result = completeConfig(older as never);
  assert.deepEqual(result.missing, ["rules"]);
  assert.equal(result.config.rules.enabled, false);
  assert.deepEqual(result.config.rules.sensitivePaths, {});
  assert.equal(result.config.widget.rules, defaultConfig().widget.rules);
});

test("a pre-0.14 config module without the subagent section defers the section and keeps its widget line", async () => {
  const { guardCurrentSections } = await import("../src/extension.js");
  const older = defaultConfig() as unknown as Record<string, unknown>;
  delete older.subagent;
  const widget = { ...(older.widget as Record<string, unknown>) };
  delete widget.subagent;
  older.widget = widget;
  const complete = completeConfig(older as never);
  assert.deepEqual(complete.missing, ["subagent"]);
  assert.equal(complete.config.subagent.enabled, false, "triage is off, not a crash");
  assert.equal(complete.config.widget.subagent, defaultConfig().widget.subagent);
  // A stale shape module does not defer the section: the extension guards what it reads itself.
  const stale = guardCurrentSections({ config: older as never, missing: [] });
  assert.deepEqual(stale.missing, ["subagent"]);
  assert.equal(stale.config.subagent.wake, false);
  assert.doesNotThrow(() => stale.config.subagent.enabled && stale.config.subagent.cooldownMs >= 0);
  assert.equal(stale.config.widget.subagent, defaultConfig().widget.subagent);
});

test("older nested subagent config without the key turns the observer off through both shape guards", async () => {
  const { guardCurrentSections } = await import("../src/extension.js");
  const old = defaultConfig();
  delete (old.subagent as unknown as Record<string, unknown>).observer;
  assert.equal(completeConfig(old).config.subagent.observer, false);
  assert.equal(guardCurrentSections({ config: old, missing: [] }).config.subagent.observer, false);
});

test("regression: the 0.9.0 live crash. A stale shape module returns a config without rules; the extension guards the sections it reads itself", async () => {
  const { guardCurrentSections } = await import("../src/extension.js");
  const stale = defaultConfig() as unknown as Record<string, unknown>;
  delete stale.rules;
  const widget = { ...(stale.widget as Record<string, unknown>) };
  delete widget.rules;
  stale.widget = widget;
  // What an 0.8 completeConfig hands back: every section it knows, nothing it does not.
  const result = guardCurrentSections({ config: stale as never, missing: [] });
  assert.deepEqual(result.missing, ["rules"]);
  assert.equal(result.config.rules.enabled, false);
  assert.deepEqual(result.config.rules.exclude, []);
  assert.equal(result.config.widget.rules, defaultConfig().widget.rules);
  // The expression that threw in the live session.
  assert.doesNotThrow(() => result.config.rules.enabled && result.config.rules.sensitivePaths);
  const complete = guardCurrentSections(completeConfig(defaultConfig()));
  assert.deepEqual(complete.missing, []);
  assert.equal(complete.config.rules.enabled, true);
});

test("an action section without commandRules leaves them empty, never undefined", () => {
  const older = defaultConfig() as unknown as Record<string, unknown>;
  const action = { ...(older.action as Record<string, unknown>) };
  delete action.commandRules;
  delete action.commandDenyRules;
  delete action.exemptRules;
  older.action = action;
  const result = completeConfig(older as never);
  // The shape fallback keeps the arrays present so pattern matching cannot dereference undefined.
  assert.ok(Array.isArray(result.config.action.commandRules));
  assert.ok(Array.isArray(result.config.action.commandDenyRules));
  assert.ok(Array.isArray(result.config.action.exemptRules));
  assert.doesNotThrow(() => result.config.action.commandRules.length + result.config.action.commandDenyRules.length + result.config.action.exemptRules.length);
});

/* ─── Task spine ────────────────────────────────────────────────────── */

const userTurn = (text: string) => ({ type: "message", message: { role: "user", content: text } });

test("one turn: no spine, so no goal repeats the task", () => {
  assert.equal(taskSpine([userTurn("fix the login bug")]), undefined);
  assert.equal(taskSpine([userTurn("fix the login bug")], "fix the login bug"), undefined, "the supplied copy of the only turn");
  assert.equal(taskSpine([], "fix the login bug"), undefined, "a first prompt not yet in the branch");
  assert.deepEqual(taskSpine([userTurn("fix the login bug"), userTurn("go")]), { goal: "fix the login bug", task: "go", history: [] });
});

test("after compaction the goal is still the first user turn, never the compaction summary", () => {
  const session = SessionManager.inMemory("/project");
  const user = (text: string) => session.appendMessage({ role: "user", content: text, timestamp: Date.now() } as never);
  user("add a rate limiter");
  user("wire it into the app");
  const kept = user("now the tests");
  user("run the suite");
  session.appendCompaction("Summary: the user asked for something else entirely", kept, 50000);
  user("check the coverage");
  const branch = session.getBranch();
  assert.ok(branch.some(entry => entry.type === "compaction"), "the branch carries the compaction entry");
  const spine = taskSpine(branch as never);
  assert.equal(spine?.goal, "add a rate limiter");
  assert.equal(spine?.task, "check the coverage");
  assert.deepEqual(spine?.history, ["run the suite", "now the tests", "wire it into the app"]);
});

test("no user turn: no spine", () => {
  assert.equal(taskSpine([]), undefined);
  assert.equal(taskSpine([userTurn("   ")]), undefined);
  assert.equal(taskSpine(undefined), undefined);
});

test("six turns: goal is the first, task the latest, history the four between, newest first", () => {
  const entries = ["one", "two", "three", "four", "five", "six"].map(userTurn);
  const spine = taskSpine(entries);
  assert.equal(spine?.goal, "one");
  assert.equal(spine?.task, "six");
  assert.deepEqual(spine?.history, ["five", "four", "three", "two"]);
});

test("oversized turns: history is clipped first, then goal, and task is never clipped", () => {
  const goal = "g".repeat(500);
  const task = "t".repeat(100);
  const entries = [userTurn(goal), userTurn("a".repeat(400)), userTurn("b".repeat(400)), userTurn("c".repeat(400)), userTurn(task)];
  const spine = taskSpine(entries);
  assert.equal(spine?.task, task, "task untouched");
  assert.equal(spine?.goal, goal, "goal untouched while history can still give way");
  assert.deepEqual(spine?.history, ["c".repeat(400), "b".repeat(200)], "newest turns keep their text, the oldest give way");
  assert.ok(spine!.goal.length + spine!.task.length + spine!.history.join("").length <= 1200);
  // A goal that cannot fit even with an empty history is clipped; task still is not.
  const huge = taskSpine([userTurn("h".repeat(2000)), userTurn("m".repeat(300)), userTurn("t".repeat(50))]);
  assert.equal(huge?.task, "t".repeat(50));
  assert.deepEqual(huge?.history, [], "history empties before the goal is touched");
  assert.equal(huge?.goal, "h".repeat(1150), "goal clipped to the remaining budget");
});

test("non-text content parts are skipped and blank turns dropped", () => {
  const entries = [
    userTurn("build the search feature"),
    { type: "message", message: { role: "user", content: [{ type: "image", data: "x" }, { type: "text", text: "now add tests" }] } },
    { type: "message", message: { role: "user", content: [{ type: "image", data: "y" }] } },
    { type: "model_change" },
    userTurn("run the suite"),
  ];
  const spine = taskSpine(entries as never);
  assert.equal(spine?.goal, "build the search feature");
  assert.equal(spine?.task, "run the suite");
  assert.deepEqual(spine?.history, ["now add tests"]);
});

test("a supplied latest turn replaces the branch copy instead of doubling", () => {
  const entries = [userTurn("first goal"), userTurn("check the logs")];
  assert.deepEqual(taskSpine(entries, "check the logs"), { goal: "first goal", task: "check the logs", history: [] });
  // A prompt not yet in the branch keeps every earlier turn as history.
  assert.deepEqual(taskSpine(entries, "new prompt"), { goal: "first goal", task: "new prompt", history: ["check the logs"] });
});

test("goal and history leave redacted; the raw task is bounded by the request paths", () => {
  const spine = taskSpine([userTurn("use TOKEN=supersecretvalue1 to log in"), userTurn("go")]);
  assert.ok(!spine?.goal.includes("supersecretvalue1"));
  assert.equal(spine?.task, "go");
});

test("completeConfig fills Wave 2 cadence, inline feedback, autonomous gate, duplicateNote, and traceSample defaults", () => {
  const partial = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
  delete partial.rules!.cadence;
  delete partial.rules!.inlineFeedback;
  delete partial.rules!.autonomousGate;
  delete partial.stuck!.inlineFeedback;
  delete partial.done!.autonomousGate;
  delete partial.context!.duplicateNote;
  delete partial.action!.traceSample;
  const { config } = completeConfig(partial as never);
  assert.equal(config.rules.cadence, "turn");
  assert.equal(config.rules.inlineFeedback, true);
  assert.equal(config.rules.autonomousGate, true);
  assert.equal(config.stuck.inlineFeedback, true);
  assert.equal(config.done.autonomousGate, true);
  assert.equal(config.context.duplicateNote, false);
  assert.equal(config.action.traceSample, 0);
});

test("schema 18 and missing context.mask / Wave 4 fields fill safe defaults in both completeConfig and guardCurrentSections", async () => {
  const { guardCurrentSections } = await import("../src/extension.js");
  assert.equal(CONFIG_SCHEMA, 18);
  assert.equal(EXPECTED_SCHEMA, 18);

  const stale = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
  const ctxSection = { ...stale.context };
  delete ctxSection.mask;
  stale.context = ctxSection;
  const rulesSection = { ...stale.rules };
  delete rulesSection.system0;
  stale.rules = rulesSection;
  const stuckSection = { ...stale.stuck };
  delete stuckSection.editRevert;
  delete stuckSection.fileThrashThreshold;
  delete stuckSection.longCycleThreshold;
  stale.stuck = stuckSection;

  const completed = completeConfig(stale as never);
  assert.deepEqual(completed.missing, ["context.mask"]);
  assert.equal(completed.config.rules.system0, true);
  assert.equal(completed.config.stuck.editRevert, true);
  assert.equal(completed.config.stuck.fileThrashThreshold, 6);
  assert.equal(completed.config.stuck.longCycleThreshold, 4);
  assert.deepEqual(completed.config.context.mask, {
    enabled: false,
    epochTurns: 8,
    keepRecentTurns: 6,
    minSweepBytes: 32768,
    minObsChars: 2000,
    images: false,
    supersededReads: false,
    resolvedChecks: false,
  });

  const staleForExt = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
  const ctxSection2 = { ...staleForExt.context };
  delete ctxSection2.mask;
  staleForExt.context = ctxSection2;
  const rulesSection2 = { ...staleForExt.rules };
  delete rulesSection2.system0;
  staleForExt.rules = rulesSection2;
  const stuckSection2 = { ...staleForExt.stuck };
  delete stuckSection2.editRevert;
  delete stuckSection2.fileThrashThreshold;
  delete stuckSection2.longCycleThreshold;
  staleForExt.stuck = stuckSection2;
  const guarded = guardCurrentSections({ config: staleForExt as never, missing: [] });
  assert.deepEqual(guarded.missing, ["context.mask"]);
  assert.equal(guarded.config.context.mask.enabled, false);
  assert.equal(guarded.config.context.mask.images, false);
  assert.equal(guarded.config.rules.system0, true);
  assert.equal(guarded.config.stuck.editRevert, true);
  assert.equal(guarded.config.stuck.fileThrashThreshold, 6);
  assert.equal(guarded.config.stuck.longCycleThreshold, 4);
  assert.doesNotThrow(() => guarded.config.context.mask.enabled && guarded.config.context.mask.epochTurns > 0);
});
