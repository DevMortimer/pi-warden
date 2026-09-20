import type { TypeSafeOptions } from "pi-typesafe";
import { authState } from "pi-typesafe";

/** The judgment backend that receives pi-warden's Jev requests. */
export type JudgmentBackend = "typesafe" | "openrouter" | "laya";

const BACKENDS: Record<JudgmentBackend, { host: string; keyEnv?: string }> = {
  typesafe: { host: "api.typesafe.ai" },
  openrouter: { host: "openrouter.ai", keyEnv: "OPENROUTER_API_KEY" },
  laya: { host: "(local)" },
};

/** True when the backend runs locally (no network, no API key, no consent required). */
export function isLocalBackend(backend: JudgmentBackend): boolean {
  return backend === "laya";
}

/** The host the consent disclosure names as the destination. */
export function backendHost(backend: JudgmentBackend): string {
  return BACKENDS[backend].host;
}

/** Adapt the consent text to the active backend by substituting the destination host. Laya needs no disclosure. */
export function disclosureFor(backend: JudgmentBackend, disclosure: string): string {
  if (backend === "laya") return "Laya-MLX runs fully on your machine. No data leaves your device.";
  return backend === "typesafe" ? disclosure : disclosure.replace(BACKENDS.typesafe.host, BACKENDS[backend].host);
}

/**
 * Whether the right credential exists for the chosen backend.
 * TypeSafe uses the pi-typesafe keystore; other backends use an environment variable.
 * Laya runs locally and needs no credential.
 */
export function keyAvailable(
  backend: JudgmentBackend,
  env: Record<string, string | undefined>,
  keystoreUsable: () => boolean,
): boolean {
  if (backend === "laya") return true;
  const keyEnv = BACKENDS[backend].keyEnv;
  return keyEnv ? (env[keyEnv]?.trim() ?? "") !== "" : keystoreUsable();
}

/**
 * Build the options forwarded to `createTypeSafe`.
 * The caller must gate on `keyAvailable` before calling `createTypeSafe`.
 */
export function judgeOptions(config: { maxRequests: number; timeoutMs: number; typesafeBackend: JudgmentBackend }): TypeSafeOptions {
  // Laya never reaches this function (laya is handled separately in extension.ts),
  // but guard against it to satisfy strict types.
  const backend = config.typesafeBackend;
  return {
    maxRequests: config.maxRequests,
    timeoutMs: config.timeoutMs,
    ...(backend === "openrouter" ? { backend } : {}),
  };
}

/** Resolve the effective backend from a raw config value; invalid values fall back to "typesafe". */
export function resolveBackend(raw: unknown): JudgmentBackend {
  return raw === "typesafe" || raw === "openrouter" || raw === "laya" ? raw : "typesafe";
}
