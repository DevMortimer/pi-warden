import type { TypeSafeOptions } from "pi-typesafe";
import { DECISIONS_BACKENDS, DEFAULT_BACKEND } from "pi-typesafe";

/** The judgment backend that receives pi-warden's Jev requests. */
export type JudgmentBackend = "typesafe" | "openrouter";

/** The host the consent disclosure names as the destination, without scheme: `api.typesafe.ai`, `openrouter.ai`. */
export function backendHost(backend: JudgmentBackend): string {
  return new URL(DECISIONS_BACKENDS[backend].host).host;
}

/** The environment variable that carries the backend's key, for messages that tell the user what to set. */
export function keyEnvFor(backend: JudgmentBackend): string {
  return DECISIONS_BACKENDS[backend].keyEnv ?? DECISIONS_BACKENDS[DEFAULT_BACKEND].keyEnv ?? "TYPESAFE_API_KEY";
}

/** Adapt the consent text to the active backend by substituting the destination host. */
export function disclosureFor(backend: JudgmentBackend, disclosure: string): string {
  return backend === DEFAULT_BACKEND ? disclosure : disclosure.replace(backendHost(DEFAULT_BACKEND), backendHost(backend));
}

/**
 * Build the options forwarded to `createTypeSafe`.
 * The caller must gate on `authState({ backend }).usable` before calling `createTypeSafe`.
 */
export function judgeOptions(config: { maxRequests: number; timeoutMs: number; typesafeBackend: JudgmentBackend }): TypeSafeOptions {
  return {
    maxRequests: config.maxRequests,
    timeoutMs: config.timeoutMs,
    ...(config.typesafeBackend === DEFAULT_BACKEND ? {} : { backend: config.typesafeBackend }),
  };
}

/** Resolve the effective backend from a raw config value; invalid values fall back to "typesafe". */
export function resolveBackend(raw: unknown): JudgmentBackend {
  return raw === "typesafe" || raw === "openrouter" ? raw : DEFAULT_BACKEND;
}
