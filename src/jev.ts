import { TypeSafeIntegrationError } from "pi-typesafe";
import type { Evaluation, IntegrationErrorCode, Questions, SystemOneRequest, TypeSafe } from "pi-typesafe";

/** Anything with pi-typesafe's `evaluate`: the real client in a session, a stub in tests. */
export type Judge = Pick<TypeSafe, "evaluate">;

export interface AskOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type JevAnswer<Q extends Questions> =
  | { ok: true; answers: Evaluation<Q>["answers"]; model: string; elapsedMs: number }
  | { ok: false; error: string; errorCode?: IntegrationErrorCode };

const FALLBACK_MESSAGE = "TypeSafe request failed.";

/**
 * One Jev request with the per-guard timeout merged into the caller's abort signal. Never throws: a failure comes back as
 * `{ ok: false }` with pi-typesafe's own message (which carries no upstream body) and its code, so the caller can stop
 * asking after a `budget` error. Unknown errors get a fixed message so nothing from the transport reaches the user.
 */
export async function askJev<Q extends Questions>(judge: Judge, request: SystemOneRequest<Q>, options: AskOptions): Promise<JevAnswer<Q>> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  try {
    const result = await judge.evaluate(request, { signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    return { ok: true, answers: result.answers, model: result.model, elapsedMs: result.elapsedMs };
  } catch (error) {
    if (error instanceof TypeSafeIntegrationError) return { ok: false, error: error.message, errorCode: error.code };
    return { ok: false, error: FALLBACK_MESSAGE };
  }
}
