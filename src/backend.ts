import type { BackendSpec, TypeSafeOptions } from "pi-typesafe";
import { DEFAULT_BACKEND, backendHost, resolveBackend } from "pi-typesafe";

/** Local judgment modes that run Warden-S1 on loopback (or prefer it with cloud fallback). */
export type LocalBackendMode = "warden-s1" | "auto";

/** The judgment backend: "cloud" (default TypeSafe), local modes ("warden-s1", "auto"), a registry name ("typesafe", "openrouter", "commandcode", "liquid", "subq", "nace"), or a caller-supplied endpoint object. */
export type JudgmentBackend = "cloud" | LocalBackendMode | BackendSpec;

/** True when the configured backend prefers or requires the local Warden-S1 daemon. */
export function isLocalBackendMode(backend: JudgmentBackend | undefined): backend is LocalBackendMode {
  return backend === "warden-s1" || backend === "auto";
}

/** Map a JudgmentBackend to a valid pi-typesafe BackendSpec for cloud fallback, auth, and host lookups. */
export function toCloudBackendSpec(backend: JudgmentBackend | undefined): BackendSpec {
  if (backend === undefined || backend === "cloud" || backend === "warden-s1" || backend === "auto") {
    return DEFAULT_BACKEND;
  }
  return backend;
}

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

/** Why no judge is available: consent not given, the backend refused, no key for the backend, a saved 401 still inside its 15-minute veto, or the request budget spent. */
export type JudgmentsOffReason = "no_consent" | "bad_backend" | "no_key" | "key_rejected" | "budget";

/**
 * Resolve a raw config value to the spec judgments go to, kept as written, or to the refusal that turns judgments off.
 * pi-typesafe validates the spec again on every call. An unknown name or an object it refuses is never silently mapped
 * to the default backend: a mistyped value must not send judgments to api.typesafe.ai.
 */
export function resolveJudgmentBackend(raw: unknown): BackendResolution {
  if (raw === undefined || raw === null) return { typesafeBackend: "cloud" };
  if (raw === "cloud" || raw === "warden-s1" || raw === "auto") return { typesafeBackend: raw };
  try {
    resolveBackend(raw as BackendSpec);
  } catch (error) {
    return { backendRefusal: error instanceof Error ? error.message : String(error) };
  }
  return { typesafeBackend: raw as JudgmentBackend };
}

/** The name messages show for a backend: the registry name, local mode name, or an endpoint's validated label. */
export function backendName(backend: JudgmentBackend | undefined): string {
  if (backend === undefined || backend === "cloud") return DEFAULT_BACKEND;
  return typeof backend === "string" ? backend : resolveBackend(backend).label;
}

/** Whether `/typesafe login <backend>` can store this backend's key. Local-only warden-s1 and endpoint objects cannot be named. */
export function loginStoresKey(backend: JudgmentBackend | undefined): boolean {
  if (backend === "warden-s1") return false;
  return typeof (backend ?? DEFAULT_BACKEND) === "string";
}

/** One phrase naming where judgments go — the label, the host, and the model sent — for consent text and status lines. */
export function describeBackend(backend: JudgmentBackend | undefined): string {
  if (backend === "warden-s1") return "Warden-S1 local loopback daemon at 127.0.0.1, model warden-s1-752m";
  if (backend === "auto") return `Auto (local Warden-S1 when installed, else TypeSafe at ${backendHost(DEFAULT_BACKEND)})`;
  const spec = toCloudBackendSpec(backend);
  const resolved = resolveBackend(spec);
  return `${resolved.label} at ${backendHost(spec)}, model ${resolved.defaultModel ?? "none configured"}`;
}

/** Adapt the consent text to the active backend by substituting the destination host. */
export function disclosureFor(backend: JudgmentBackend | undefined, disclosure: string): string {
  if (backend === undefined || backend === "cloud" || backend === DEFAULT_BACKEND || backend === "auto") return disclosure;
  if (backend === "warden-s1") return disclosure.replace(backendHost(DEFAULT_BACKEND), "127.0.0.1");
  return disclosure.replace(backendHost(DEFAULT_BACKEND), backendHost(backend));
}

/**
 * Build the options forwarded to `createTypeSafe`.
 * The caller must gate on `authState({ backend: toCloudBackendSpec(backend) }).usable` before calling `createTypeSafe`.
 * No transport: pi-typesafe 0.13.1 replays the body itself on Bun, which is the fix our own fetch restated.
 */
export function judgeOptions(config: { maxRequests: number; timeoutMs: number; typesafeBackend: JudgmentBackend }): TypeSafeOptions {
  const spec = toCloudBackendSpec(config.typesafeBackend);
  return {
    maxRequests: config.maxRequests,
    timeoutMs: config.timeoutMs,
    ...(spec === DEFAULT_BACKEND ? {} : { backend: spec }),
  };
}
