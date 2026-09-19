import assert from "node:assert/strict";
import { test } from "node:test";
import { backendHost, disclosureFor, judgeOptions, keyAvailable, resolveBackend } from "../src/backend.js";

test("resolveBackend: valid values pass through, junk falls back to typesafe", () => {
  assert.equal(resolveBackend("typesafe"), "typesafe");
  assert.equal(resolveBackend("openrouter"), "openrouter");
  assert.equal(resolveBackend(undefined), "typesafe");
  assert.equal(resolveBackend(null), "typesafe");
  assert.equal(resolveBackend(""), "typesafe");
  assert.equal(resolveBackend("azure"), "typesafe");
  assert.equal(resolveBackend(42), "typesafe");
});

test("backendHost returns the right host for each backend", () => {
  assert.equal(backendHost("typesafe"), "api.typesafe.ai");
  assert.equal(backendHost("openrouter"), "openrouter.ai");
});

test("disclosureFor: typesafe returns the original text unchanged", () => {
  const text = "pi-warden sends to api.typesafe.ai: your latest request";
  assert.equal(disclosureFor("typesafe", text), text);
});

test("disclosureFor: openrouter replaces the host in the disclosure", () => {
  const text = "pi-warden sends to api.typesafe.ai: your latest request";
  const result = disclosureFor("openrouter", text);
  assert.match(result, /openrouter\.ai/);
  assert.doesNotMatch(result, /api\.typesafe\.ai/);
  assert.equal(result, "pi-warden sends to openrouter.ai: your latest request");
});

test("keyAvailable: typesafe uses the keystore callback", () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(keyAvailable("typesafe", env, () => true), true);
  assert.equal(keyAvailable("typesafe", env, () => false), false);
});

test("keyAvailable: openrouter uses the OPENROUTER_API_KEY env var", () => {
  const usable = () => true;
  assert.equal(keyAvailable("openrouter", { OPENROUTER_API_KEY: "sk-or-abc" }, usable), true);
  assert.equal(keyAvailable("openrouter", { OPENROUTER_API_KEY: "  " }, usable), false, "whitespace-only is not a key");
  assert.equal(keyAvailable("openrouter", {}, usable), false, "missing env var");
  assert.equal(keyAvailable("openrouter", { OPENROUTER_API_KEY: "" }, usable), false, "empty string");
});

test("keyAvailable: openrouter ignores the keystore", () => {
  assert.equal(keyAvailable("openrouter", { OPENROUTER_API_KEY: "key" }, () => false), true, "keystore failure is irrelevant");
});

test("judgeOptions: typesafe backend omits the backend field", () => {
  const opts = judgeOptions({ maxRequests: 10, timeoutMs: 3000, typesafeBackend: "typesafe" });
  assert.equal(opts.maxRequests, 10);
  assert.equal(opts.timeoutMs, 3000);
  assert.equal("backend" in opts, false, "default backend should not be forwarded");
});

test("judgeOptions: openrouter includes the backend field", () => {
  const opts = judgeOptions({ maxRequests: 10, timeoutMs: 3000, typesafeBackend: "openrouter" });
  assert.equal(opts.maxRequests, 10);
  assert.equal(opts.timeoutMs, 3000);
  assert.equal((opts as Record<string, unknown>).backend, "openrouter");
});
