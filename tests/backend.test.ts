import assert from "node:assert/strict";
import { test } from "node:test";
import { DECISIONS_BACKENDS } from "pi-typesafe";
import { backendHost, disclosureFor, judgeOptions, keyEnvFor, resolveBackend } from "../src/backend.js";

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

test("backendHost and keyEnvFor come from pi-typesafe's registry, not a local copy", () => {
  for (const backend of ["typesafe", "openrouter"] as const) {
    assert.equal(backendHost(backend), new URL(DECISIONS_BACKENDS[backend].host).host);
    assert.equal(keyEnvFor(backend), DECISIONS_BACKENDS[backend].keyEnv);
  }
  assert.equal(keyEnvFor("typesafe"), "TYPESAFE_API_KEY");
  assert.equal(keyEnvFor("openrouter"), "OPENROUTER_API_KEY");
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
