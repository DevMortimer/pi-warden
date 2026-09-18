/**
 * The environment a headless eval run is allowed to see.
 *
 * A run is a real agent process with `bash`; whatever the operator's shell exports
 * reaches the model's context the moment a run dumps its environment. Two of fifty
 * deepseek runs on 2026-09-17 did exactly that with a live-format Supabase token
 * (.local/shift-2026-09-18-eval-env-leak.md), so the harness filters instead of
 * forwarding: a variable whose NAME is credential-shaped is dropped when its VALUE
 * is credential-shaped, judged by the same predicate the guard uses, so a value the
 * guard would warn about never reaches a model. PATH, HOME, TMPDIR, PI_* and the
 * provider model catalogs do not match and keep working.
 */

const PI_IDENTITY = [
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_SUBAGENT_PARENT_SESSION",
];

/** Names that carry credentials often enough to check the value. Bare provider names are excluded on purpose. */
const SECRET_NAME = /(?:^|_)(?:API|ACCESS|APP|AUTH|BEARER|CLIENT|CONN(?:ECTION)?|CREDENTIALS?|DATABASE|DB|DSN|ENCRYPTION|GH|GITHUB|KEY|LINEAR|NPM|OPENAI|ANTHROPIC|PASSWORD|PASSWD|PRIVATE|PUBLISH|REGISTRY|SECRET|SIGNING|SLACK|SSH|STRIPE|SUPABASE|TOKEN|TYPESAFE|VAULT)(?:$|_)/i;

/**
 * dist/ is optional for this module: without it every credential-named variable is
 * dropped on the name alone. That direction fails safe (a run loses a variable it
 * never needed) and never leaks, where the opposite default would.
 */
let isSecretValue = () => true;
try {
  const guard = await import("../dist/index.js");
  if (typeof guard.looksLikeSecretValue === "function") isSecretValue = guard.looksLikeSecretValue;
} catch { /* not built: name-only filtering */ }

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ agentDir: string, isSecretValue?: (value: string) => boolean }} options
 * @returns {Record<string, string | undefined>} a copy; `env` is never mutated
 */
export function filterEnv(env, { agentDir, isSecretValue: predicate = isSecretValue }) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (PI_IDENTITY.includes(name)) continue;
    if (SECRET_NAME.test(name) && value && predicate(String(value))) continue;
    out[name] = value;
  }
  out.PI_CODING_AGENT_DIR = agentDir;
  return out;
}

/** Names dropped from an environment, for the run log. Never returns values. */
export function filteredNames(env, options) {
  const kept = filterEnv(env, options);
  return Object.keys(env).filter((name) => !(name in kept) && name !== "PI_CODING_AGENT_DIR");
}

export const childEnv = (env, agentDir) => filterEnv(env, { agentDir });
