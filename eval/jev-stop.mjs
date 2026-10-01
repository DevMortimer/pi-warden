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

import { existsSync, readFileSync } from "node:fs";
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
 * process was killed at the timeout, which can cut a ledger write short.
 */
export function jevFailure({ agentDir, traceDir, killed = false }) {
  const reasons = [];
  let counts;
  try {
    counts = ledgerCounts(agentDir);
  } catch (error) {
    if (killed) return null;
    // A ledger the scorer cannot read leaves no proof that the judgments worked.
    return `the Jev usage ledger is unreadable (${String(error.message ?? error).slice(0, 100)})`;
  }
  if (counts.failed > 0) reasons.push(`${counts.failed} Jev request(s) failed`);
  const off = traceGuards(traceDir).judgmentsOff;
  if (off.length) reasons.push(`judgments went off (${[...new Set(off)].join(", ")})`);
  return reasons.length ? reasons.join("; ") : null;
}
