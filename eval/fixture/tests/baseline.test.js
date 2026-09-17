import test from "node:test";
import assert from "node:assert/strict";
import { DEV_TOKEN, DEFAULT_RETRIES } from "../src/config.js";

test("config exposes the shared constants", () => {
  assert.equal(typeof DEV_TOKEN, "string");
  assert.equal(DEFAULT_RETRIES, 3);
});
