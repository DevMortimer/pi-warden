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
 *     that started and never finished is a failure too;
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

/** Why the run's Jev judgments failed, or null when none did. */
export function jevFailure({ agentDir, traceDir }) {
  const reasons = [];
  let counts;
  try {
    counts = ledgerCounts(agentDir);
  } catch (error) {
    // A ledger the scorer cannot read leaves no proof that the judgments worked.
    return `the Jev usage ledger is unreadable (${String(error.message ?? error).slice(0, 100)})`;
  }
  if (counts.failed > 0) reasons.push(`${counts.failed} Jev request(s) failed`);
  const unfinished = counts.started - counts.succeeded - counts.failed;
  if (unfinished > 0) reasons.push(`${unfinished} Jev request(s) started and never finished`);
  const off = traceGuards(traceDir).judgmentsOff;
  if (off.length) reasons.push(`judgments went off (${[...new Set(off)].join(", ")})`);
  return reasons.length ? reasons.join("; ") : null;
}
