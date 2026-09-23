import type { IntegrationErrorCode } from "pi-typesafe";

/** A failed judge request, as a category safe to name (never an exception body). */
export type JudgeFailureKind = "timeout" | "network" | "auth" | "configuration" | "other";

export interface JudgeCooldownSettings {
  /** Consecutive transient failures that start the cooldown. */
  failuresBeforeCooldown: number;
  /** How long the judge is left alone once the cooldown starts. */
  cooldownMs: number;
}

/** Classify a judge error into a safe category (spec §6: never exception bodies). */
export function classifyJudgeError(err: unknown): JudgeFailureKind {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code as IntegrationErrorCode;
    if (code === "timeout") return "timeout";
    if (code === "http" || code === "connection" || code === "response") return "network";
    if (code === "configuration" || code === "validation") return "configuration";
    if (code === "budget" || code === "aborted") return "other";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out/i.test(msg)) return "timeout";
  if (/auth|key|credential|401|403/i.test(msg)) return "auth";
  if (/network|fetch|connect|ECONNREFUSED|ENOTFOUND/i.test(msg)) return "network";
  return "other";
}

/**
 * What a failure says about the backend, or `undefined` when it says nothing.
 *
 * `budget` already stops judgments for the session on its own. `aborted` is ambiguous: pi-warden's own per-request
 * deadline reaches the SDK as an abort, so a hung backend surfaces as `aborted`, not `timeout`. The signal's reason
 * tells the two apart; only a user's cancel is left out.
 */
export function cooldownFailureKind(err: unknown, signal?: AbortSignal): JudgeFailureKind | undefined {
  const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
  if (code === "budget") return undefined;
  if (code === "aborted") return (signal?.reason as { name?: unknown } | undefined)?.name === "TimeoutError" ? "timeout" : undefined;
  const status = err && typeof err === "object" && "status" in err ? (err as { status: unknown }).status : undefined;
  if (status === 401 || status === 403) return "auth";
  return classifyJudgeError(err);
}

export type CooldownEvent =
  | { type: "started"; kind: JudgeFailureKind; ms: number }
  | { type: "recovered" };

/**
 * Session-scoped pause on a failing judge, so a dead backend costs one notice instead of one timeout per action.
 * Nothing is persisted; a new session starts with the judge trusted again.
 */
export class JudgeCooldown {
  private failures = 0;
  private until = 0;
  /** A window has started and no judgment has succeeded since, so the user was told and not yet told it recovered. */
  private cooled = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** True while judgments are paused. */
  active(): boolean {
    return this.now() < this.until;
  }

  failure(kind: JudgeFailureKind, settings: JudgeCooldownSettings): CooldownEvent | undefined {
    // A request that was already in flight when the window opened adds nothing the user has not been told.
    if (this.active()) return undefined;
    // The probe after a window failed too: the judge is still down, which the open notice already says.
    if (this.cooled) { this.open(settings); return undefined; }
    this.failures++;
    const persistent = kind === "auth" || kind === "configuration";
    if (!persistent && this.failures < settings.failuresBeforeCooldown) return undefined;
    this.open(settings);
    return { type: "started", kind, ms: settings.cooldownMs };
  }

  success(): CooldownEvent | undefined {
    this.failures = 0;
    if (!this.cooled) return undefined;
    this.cooled = false;
    return { type: "recovered" };
  }

  reset(): void {
    this.failures = 0;
    this.until = 0;
    this.cooled = false;
  }

  private open(settings: JudgeCooldownSettings): void {
    this.failures = 0;
    this.cooled = true;
    this.until = this.now() + settings.cooldownMs;
  }
}
