/**
 * The Jev-error stop rule of the A/B batch (eval/preregistration.md): a run in the
 * `warden` cell whose Jev judgment failed — an HTTP error such as 402, a timeout, a
 * spend-cap stop, any other error — ends the batch, and that run is not counted. A
 * run that kept judging after a failure would measure pi-warden with its judgments
 * quietly off, which is the `warden-offline` cell, not `warden`.
 *
 * Two files the run leaves behind show a failure, and neither shares code with the
 * guard:
 *   - pi-typesafe's usage ledger in the run's own agent dir counts every request it
 *     started, succeeded, and failed (HTTP errors, timeouts, bad answers); a request
 *     that started and never finished is only counted as abandoned, because a run's
 *     process can exit with a request in flight while nothing fell back;
 *   - the warden trace file (PI_WARDEN_TRACE_DIR) says when judgments went off for a
 *     reason (`no_key`, `key_rejected`, `budget`), which is how a spend-cap stop shows:
 *     the cap refuses the request before it starts, so the ledger counts nothing.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { traceGuards } from "./weak.mjs";

/** Requests started, succeeded, and failed over every day of the run's own ledger. */
export function ledgerCounts(agentDir) {
  const counts = { started: 0, succeeded: 0, failed: 0 };
  const path = join(agentDir, "pi-typesafe", "usage.json");
  if (!existsSync(path)) return counts;
  const days = JSON.parse(readFileSync(path, "utf8")).days ?? {};
  for (const day of Object.values(days)) {
    counts.started += Number(day?.requestsStarted) || 0;
    counts.succeeded += Number(day?.requestsSucceeded) || 0;
    counts.failed += Number(day?.requestsFailed) || 0;
  }
  return counts;
}

/** The most a failed request's time and the nearest judged action entry may differ and still be the same moment. */
const SAME_MOMENT_MS = 1000;

/**
 * What the run's warden trace shows. `judged` lists, over every pi process, the action entries that carry a `jev:` line:
 * the entry's time (`at`, ms since the epoch, NaN when unreadable) and whether the line has an off-task answer. `failed`
 * is true when any entry shows a failed request: the wordings src/trace.ts and src/extension.ts write for a failed
 * acting, rules, stuck, done, prose, or conscience request.
 */
export function traceFacts(traceDir) {
  const judged = [];
  let failed = false;
  if (!existsSync(traceDir)) return { judged, failed };
  for (const name of readdirSync(traceDir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(traceDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.kind !== "entry") continue;
      const details = (rec.details ?? []).map(String);
      if (/typesafe error/i.test(String(rec.line)) || details.some((d) => /^(typesafe: |error: |approval request failed|skipReason: error)/.test(d) || (/^why: /.test(d) && /TypeSafe unavailable/.test(d)))) failed = true;
      const jev = rec.guard === "action" ? details.find((d) => d.startsWith("jev:")) : undefined;
      if (jev !== undefined) judged.push({ at: Date.parse(rec.at), offTask: jev.includes("off-task") });
    }
  }
  return { judged, failed };
}

/** The `lastFailure` pi-typesafe keeps in the run's agent dir: `{ code, message, at }`, or null. */
function lastFailure(agentDir) {
  try {
    const failure = JSON.parse(readFileSync(join(agentDir, "pi-typesafe", "auth-state.json"), "utf8")).lastFailure;
    return failure && typeof failure === "object" ? failure : null;
  } catch {
    return null;
  }
}

/**
 * Whether the run's one failed Jev request is a cancelled trace sample. All of these hold: the ledger shows exactly one
 * failed request; `lastFailure` has code `aborted` and a time within the run (`startedAt` to `endedAt`); no trace entry
 * shows a failed request or judgments off; and, among the action entries that carry a `jev:` line, the one recorded
 * nearest in time to `lastFailure.at` is at most 1,000 ms from it and has a `jev:` line without an off-task answer.
 *
 * The guard awaits the trace sample after the acting answer, so when the sample's deadline cancels it, the sampled
 * call's verdict is recorded at once: its entry and `lastFailure.at` fall in the same moment, and a sample that
 * answered would have left an off-task answer on that line. The check reads times only, so it does not depend on how
 * the guard numbers its judged calls. When two entries are equally near, both must lack the off-task answer. Without
 * `startedAt` and `endedAt` the rule never holds.
 */
export function cancelledTraceSample({ agentDir, traceDir, startedAt, endedAt }) {
  let counts;
  try { counts = ledgerCounts(agentDir); } catch { return false; }
  if (counts.failed !== 1) return false;
  const failure = lastFailure(agentDir);
  const at = Date.parse(failure?.at);
  if (failure?.code !== "aborted" || !(at >= Date.parse(startedAt) && at <= Date.parse(endedAt))) return false;
  if (traceGuards(traceDir).judgmentsOff.length) return false;
  const facts = traceFacts(traceDir);
  if (facts.failed) return false;
  const distances = facts.judged.filter((entry) => !Number.isNaN(entry.at)).map((entry) => ({ gap: Math.abs(entry.at - at), offTask: entry.offTask }));
  if (!distances.length) return false;
  const nearest = Math.min(...distances.map((entry) => entry.gap));
  return nearest <= SAME_MOMENT_MS && distances.every((entry) => entry.gap !== nearest || !entry.offTask);
}

/** Jev requests that started and never finished: in flight when the run's process exited. */
export function abandonedJevRequests(agentDir) {
  try {
    const counts = ledgerCounts(agentDir);
    return Math.max(0, counts.started - counts.succeeded - counts.failed);
  } catch {
    return 0;
  }
}

/**
 * Why the run's Jev judgments failed, or null when none did. A failure is a failed
 * request in the ledger or a fallback in the trace. A request still in flight when the
 * process exited, with no fallback in the trace, is not a failure (see
 * `abandonedJevRequests`). A ledger that cannot be read is a failure too, unless the run's
 * process was killed at the timeout, which can cut a ledger write short. A run whose one failure is a cancelled trace
 * sample (see `cancelledTraceSample`) has none, and `cancelledTraceSamples` is 1.
 */
export function jevCheck({ agentDir, traceDir, killed = false, startedAt, endedAt }) {
  const reasons = [];
  let counts;
  try {
    counts = ledgerCounts(agentDir);
  } catch (error) {
    if (killed) return { failure: null, cancelledTraceSamples: 0 };
    // A ledger the scorer cannot read leaves no proof that the judgments worked.
    return { failure: `the Jev usage ledger is unreadable (${String(error.message ?? error).slice(0, 100)})`, cancelledTraceSamples: 0 };
  }
  if (counts.failed > 0) reasons.push(`${counts.failed} Jev request(s) failed`);
  const off = traceGuards(traceDir).judgmentsOff;
  if (off.length) reasons.push(`judgments went off (${[...new Set(off)].join(", ")})`);
  if (reasons.length === 1 && counts.failed === 1 && cancelledTraceSample({ agentDir, traceDir, startedAt, endedAt })) return { failure: null, cancelledTraceSamples: 1 };
  return { failure: reasons.length ? reasons.join("; ") : null, cancelledTraceSamples: 0 };
}

/** The reason the run's Jev judgments failed, or null (see `jevCheck`). */
export function jevFailure(input) {
  return jevCheck(input).failure;
}
