/**
 * The silent-half trial: a field comparison between two arms of the same guards. A session is put in arm `live` or
 * `silent` from its id, 50/50 and reproducible, so the two arms are random over many sessions and a resumed session
 * keeps its arm. A `silent` session judges as usual but records what it would have told the agent instead of telling
 * it, so a later script can compare the arms from the session logs.
 *
 * The setting weakens guarding in half the sessions, so it is user-config only (like `mode` and `steerBudget`): a
 * project file must not be able to turn it on. Everything that protects data stays live in both arms.
 */

export type TrialArm = "live" | "silent";

/** The custom session entry Pi stores for extensions: it never reaches the model's context. */
export const TRIAL_ENTRY_TYPE = "pi-warden-trial";

/**
 * Every agent-facing delivery a guard makes, split by what the silent arm does with it.
 *
 * Suppressed: the intervention the trial measures. Live: the safety controls, which must not weaken in either arm.
 * A kind is a delivery, not a guard: one guard can carry several (the action guard steers slop, off-task, and more).
 */
export const SUPPRESSED_KINDS = [
  "rules",
  "sensitive-path",
  "slop",
  "prose",
  "stuck",
  "repeat",
  "done",
  "cause",
  "loops",
  "intent-mismatch",
  "off-task",
  "should-proceed",
  "large-output",
  "warn-headless",
  "action-notes",
  "conscience",
  "prefs",
  "turn-rules",
  "compact-evidence",
  "context-compression",
  "subagent",
  "waste",
] as const;

/** Deliveries the silent arm keeps: holds, secret masking, security and injection notices, runaway stops, UI warnings. */
export const LIVE_KINDS = [
  "hold",
  "secret-mask",
  "security",
  "injection",
  "runaway",
  "ui-warning",
] as const;

export type SuppressedKind = (typeof SUPPRESSED_KINDS)[number];
export type LiveKind = (typeof LIVE_KINDS)[number];
export type TrialDeliveryKind = SuppressedKind | LiveKind;

const SUPPRESSED: ReadonlySet<string> = new Set(SUPPRESSED_KINDS);

/** Whether the silent arm withholds this delivery. Unknown kinds are live: a delivery the trial cannot classify must not be dropped silently. */
export function isSuppressed(kind: TrialDeliveryKind | string): kind is SuppressedKind {
  return SUPPRESSED.has(kind);
}

/** The kind of a steer from the guard that asked for it, when the call site has no finer label. */
export function steerDeliveryKind(guard: string): TrialDeliveryKind {
  return guard === "security" ? "security" : guard === "runaway" ? "runaway" : guard === "subagent" ? "subagent" : guard === "action" ? "action-notes" : (guard as TrialDeliveryKind);
}

/**
 * The arm for a session id. A stable hash, so the same id always lands in the same arm and a resumed session keeps
 * its arm; the low bit is taken after a finalizer because a plain FNV-1a low bit is not uniform for short ids.
 */
export function armFor(sessionId: string): TrialArm {
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909);
  hash ^= hash >>> 16;
  return (hash >>> 0) % 2 === 0 ? "live" : "silent";
}

/** One line of the record: the arm at session start. Read back from the session log by a later comparison script. */
export interface TrialArmRecord {
  v: 1;
  record: "arm";
  arm: TrialArm;
  sessionId: string;
  at: number;
}

/** One line per suppressed delivery: its kind, the guard that made it, the time, and the redacted text. */
export interface TrialSuppressedRecord {
  v: 1;
  record: "suppressed";
  kind: SuppressedKind;
  guard: string;
  at: number;
  text: string;
}

export type TrialRecord = TrialArmRecord | TrialSuppressedRecord;

/** The delivered text as the record keeps it: already redacted by the caller, clipped so one entry stays small. */
export const TRIAL_TEXT_LIMIT = 300;

export function trialText(text: string): string {
  return text.length <= TRIAL_TEXT_LIMIT ? text : `${text.slice(0, TRIAL_TEXT_LIMIT - 1)}…`;
}
