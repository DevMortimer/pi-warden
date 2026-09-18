import assert from "node:assert/strict";
import { test } from "node:test";
import { filterEnv, filteredNames } from "../eval/env.mjs";

// The evaluator imports dist (optional); these tests inject the predicate so they hold on a fresh clone.

const secretish = (value: string) => value.length >= 8 && /\d/.test(value) && /[a-zA-Z]/.test(value);
const options = { agentDir: "/tmp/agent-dir", isSecretValue: secretish };

test("a credential-named variable with a credential-shaped value is dropped", () => {
  const env = { SUPABASE_ACCESS_TOKEN: "sbp_ca129eb7deadbeef42", PATH: "/usr/bin" };
  assert.deepEqual(Object.keys(filterEnv(env, options)).sort(), ["PATH", "PI_CODING_AGENT_DIR"]);
});

test("a credential-named variable with a benign value is kept", () => {
  const env = { API_KEY: "your-key-here", AWS_PROFILE: "dev", SECRET_SAUCE: "yes" };
  assert.deepEqual(Object.keys(filterEnv(env, options)), ["API_KEY", "AWS_PROFILE", "SECRET_SAUCE", "PI_CODING_AGENT_DIR"]);
});

test("identity and catalog variables are kept", () => {
  const env = { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp", PI_CODING_AGENT_DIR: "/old", PI_WARDEN_DEBUG: "1", NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  const kept = filterEnv(env, options);
  assert.deepEqual(kept.PI_CODING_AGENT_DIR, "/tmp/agent-dir");
  assert.equal(kept.PATH, "/usr/bin");
  assert.equal(kept.PI_WARDEN_DEBUG, "1");
});

test("PI identity variables never reach a child run", () => {
  const env = { PI_SESSION_FILE: "/x/session.jsonl", PI_MODEL: "commands/deepseek", PI_PROVIDER: "commandcode", PI_SUBAGENT_PARENT_SESSION: "parent" };
  assert.deepEqual(Object.keys(filterEnv(env, options)), ["PI_CODING_AGENT_DIR"]);
});

test("filtering never mutates the input environment", () => {
  const env = { AWS_SECRET_ACCESS_KEY: "abcd1234efgh" };
  filterEnv(env, options);
  assert.deepEqual(Object.keys(env), ["AWS_SECRET_ACCESS_KEY"]);
});

test("filteredNames reports names without values", () => {
  const names = filteredNames({ GH_TOKEN: "ghp_abcd1234efgh", PATH: "/usr/bin", PI_MODEL: "m" }, options);
  assert.deepEqual(names.sort(), ["GH_TOKEN", "PI_MODEL"]);
  assert.equal(names.some((name) => name.includes("ghp_")), false);
});
