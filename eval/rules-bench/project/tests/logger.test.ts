import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "../src/logger.js";

test("format names the level", () => {
  assert.equal(format("warn", "x"), "[warn] x");
  assert.ok(!format("warn", "console.log").includes("undefined"));
});
