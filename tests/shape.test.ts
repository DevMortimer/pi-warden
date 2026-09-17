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
  assert.match(shapeWarning(result.missing, undefined), /security, context, slop\.prose .* schema pre-3, extension expects 5.*restart Pi/);
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
