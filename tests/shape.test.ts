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
  assert.match(shapeWarning(result.missing, undefined), /security, context, slop\.prose .* schema pre-3, extension expects 3.*restart Pi/);
  const empty = completeConfig(undefined);
  assert.ok(empty.missing.length >= 7);
  assert.equal(empty.config.enabled, true);
});
