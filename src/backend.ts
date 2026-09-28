import type { BackendSpec, TypeSafeOptions } from "pi-typesafe";
import { DEFAULT_BACKEND, backendHost, resolveBackend } from "pi-typesafe";

/** The judgment backend: a registry name ("typesafe", "openrouter", "commandcode") or a caller-supplied endpoint object. */
export type JudgmentBackend = BackendSpec;

/** The judgment destination as the config carries it, plus the refusal that turns judgments off when the configured value was refused. */
export interface BackendSetting {
  /** The spec judgments go to; undefined only when the configured value was refused. */
  readonly typesafeBackend: JudgmentBackend | undefined;
  /** Why the configured value was refused: the once-per-session notice and `/warden status` quote it. */
  readonly backendRefusal: string | undefined;
}

/** What a raw `typesafeBackend` value resolves to: the spec judgments go to, or the refusal that turns them off. Exactly one is set. */
export type BackendResolution =
  | { readonly typesafeBackend: JudgmentBackend; readonly backendRefusal?: undefined }
  | { readonly typesafeBackend?: undefined; readonly backendRefusal: string };

/** Why no judge is available: consent not given, the backend refused, no key for the backend, a saved 401 or 403, or the request budget spent. */
export type JudgmentsOffReason = "no_consent" | "bad_backend" | "no_key" | "key_rejected" | "budget";

/**
 * Resolve a raw config value to the spec judgments go to, kept as written, or to the refusal that turns judgments off.
 * pi-typesafe validates the spec again on every call. An unknown name or an object it refuses is never silently mapped
 * to the default backend: a mistyped value must not send judgments to api.typesafe.ai.
 */
export function resolveJudgmentBackend(raw: unknown): BackendResolution {
  if (raw === undefined || raw === null) return { typesafeBackend: DEFAULT_BACKEND };
  try {
    resolveBackend(raw as BackendSpec);
  } catch (error) {
    return { backendRefusal: error instanceof Error ? error.message : String(error) };
  }
  return { typesafeBackend: raw as JudgmentBackend };
}

/** The name messages show for a backend: the registry name, or an endpoint's validated label. */
export function backendName(backend: JudgmentBackend | undefined): string {
  return backend === undefined ? DEFAULT_BACKEND : typeof backend === "string" ? backend : resolveBackend(backend).label;
}

/** Whether the backend takes the TypeSafe key, the only one `/typesafe login` stores; true only for "typesafe". */
export function loginStoresKey(backend: JudgmentBackend | undefined): boolean {
  return backend === DEFAULT_BACKEND;
}

/** One phrase naming where judgments go — the label, the host, and the model sent — for consent text and status lines. */
export function describeBackend(backend: JudgmentBackend | undefined): string {
  const resolved = resolveBackend(backend);
  return `${resolved.label} at ${backendHost(backend)}, model ${resolved.defaultModel ?? "none configured"}`;
}

/** Adapt the consent text to the active backend by substituting the destination host. */
export function disclosureFor(backend: JudgmentBackend | undefined, disclosure: string): string {
  return backend === undefined || backend === DEFAULT_BACKEND ? disclosure : disclosure.replace(backendHost(DEFAULT_BACKEND), backendHost(backend));
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
