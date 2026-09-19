import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SCHEMA, defaultConfig } from "../src/config.js";
import { completeConfig, EXPECTED_SCHEMA, shapeWarning } from "../src/shape.js";

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
