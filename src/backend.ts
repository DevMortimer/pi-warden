import type { TypeSafeOptions } from "pi-typesafe";
import { authState } from "pi-typesafe";

/** The judgment backend that receives pi-warden's Jev requests. */
export type JudgmentBackend = "typesafe" | "openrouter";

const BACKENDS: Record<JudgmentBackend, { host: string; keyEnv?: string }> = {
  typesafe: { host: "api.typesafe.ai" },
  openrouter: { host: "openrouter.ai", keyEnv: "OPENROUTER_API_KEY" },
};

/** The host the consent disclosure names as the destination. */
export function backendHost(backend: JudgmentBackend): string {
  return BACKENDS[backend].host;
}

/** Adapt the consent text to the active backend by substituting the destination host. */
export function disclosureFor(backend: JudgmentBackend, disclosure: string): string {
  return backend === "typesafe" ? disclosure : disclosure.replace(BACKENDS.typesafe.host, BACKENDS[backend].host);
}

/**
 * Whether the right credential exists for the chosen backend.
 * TypeSafe uses the pi-typesafe keystore; other backends use an environment variable.
 */
export function keyAvailable(
  backend: JudgmentBackend,
  env: Record<string, string | undefined>,
  keystoreUsable: () => boolean,
): boolean {
  const keyEnv = BACKENDS[backend].keyEnv;
  return keyEnv ? (env[keyEnv]?.trim() ?? "") !== "" : keystoreUsable();
}

/**
 * Build the options forwarded to `createTypeSafe`.
 * The caller must gate on `keyAvailable` before calling `createTypeSafe`.
 */
export function judgeOptions(config: { maxRequests: number; timeoutMs: number; typesafeBackend: JudgmentBackend }): TypeSafeOptions {
  return {
    maxRequests: config.maxRequests,
    timeoutMs: config.timeoutMs,
    ...(config.typesafeBackend === "typesafe" ? {} : { backend: config.typesafeBackend }),
  };
}

/** Resolve the effective backend from a raw config value; invalid values fall back to "typesafe". */
export function resolveBackend(raw: unknown): JudgmentBackend {
  return raw === "typesafe" || raw === "openrouter" ? raw : "typesafe";
}
