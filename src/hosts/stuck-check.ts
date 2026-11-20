import type { WardenConfig } from "../config.js";
import { redact } from "../redact.js";
import { AttemptWindow, evaluateStuck, quickRepeatNudge, stuckNudge } from "../stuck.js";
import type { Attempt } from "../stuck.js";
import { ownerNotice } from "./done-check.js";
import type { OwnerOutput } from "./done-check.js";
import { headlessJudge } from "./headless.js";
import { ATTEMPT_TEXT_LIMIT } from "./state.js";
import type { HostState } from "./state.js";

/** As for the done-check: with `stuck.nudge` off nothing would be shown, and this host has no trace to record it in. */
export const stuckActive = (config: WardenConfig): boolean => config.enabled && config.stuck.enabled && config.stuck.nudge;

/** Failure summaries usually close an output and failing tests often open it, so both ends are kept. */
const HEAD = 2000;
const GAP = "\n…\n";

/** The output an attempt keeps on disk: redacted before the cut, so no clipped secret slips past the redactor. */
function storedText(text: string): string {
  const redacted = redact(text);
  return redacted.length <= ATTEMPT_TEXT_LIMIT ? redacted : `${redacted.slice(0, HEAD)}${GAP}${redacted.slice(-(ATTEMPT_TEXT_LIMIT - HEAD - GAP.length))}`;
}

/** The rules answer and the done-check evidence are the hook's work; a stuck notice is a bonus that must not hold them. */
const STUCK_RESERVE_MS = 500;

/** The owner's notice, or nothing once `until` has passed: a stuck-check that throws or overruns costs only its notice. */
async function ownerOnly(work: Promise<OwnerOutput>, until: number): Promise<OwnerOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<OwnerOutput>(done => { timer = setTimeout(() => done({}), Math.max(0, until - Date.now())); });
  try { return await Promise.race([work.catch(() => ({}) as OwnerOutput), expired]); }
  finally { clearTimeout(timer); }
}

/**
 * Pi's stuck guard for one tool result of a host whose hooks run in separate processes. Each agent of a prompt has its
 * own numbered results, so the window is rebuilt from the latest `stuck.window` of that agent's; a marker per judged
 * result carries the cooldown, and a marker per call key keeps the quick repeat to once per call per prompt. A stuck
 * verdict, else a quick repeat, goes to the owner only, as Pi reports both on the status line and never to the agent.
 */
async function stuckCheck(config: WardenConfig, state: HostState, agent: string | undefined, identity: string, attempt: Attempt, signal: AbortSignal): Promise<OwnerOutput> {
  const record = await state.prompt();
  const prompt = record?.id ?? "no prompt recorded";
  const scope = JSON.stringify([prompt, agent ?? null]);
  const stored: Attempt = { ...attempt, text: storedText(attempt.text) };
  const index = state.recordAttempt(prompt, agent, identity, stored);
  if (index === undefined) return {};
  const window = new AttemptWindow(config.stuck.window);
  for (const earlier of await state.attempts(prompt, agent, index - config.stuck.window + 1, index - 1)) window.push(earlier);
  window.push(stored);
  const judged = (at: number): string => JSON.stringify([scope, at]);
  for (let ago = 1; ago < config.stuck.cooldown && ago <= index; ago++) {
    if (state.claimed("stuck", judged(index - ago))) { window.markJudged(ago); break; }
  }
  const candidate = config.stuck.repeatSteer ? window.quickRepeat() : undefined;
  const repeat = candidate && state.once("repeat", JSON.stringify([scope, candidate.attempt.key])) ? candidate : undefined;
  if (!window.shouldJudge(config.stuck)) return ownerNotice(repeat && quickRepeatNudge(repeat));
  const judge = await headlessJudge(config, state, signal);
  // Claim every result the cooldown covers, oldest first: a claim that loses leaves only numbers behind the winner's,
  // which the winner's own claim already covers, so two hook processes cannot judge this stretch twice.
  const claim = (): boolean => {
    for (let at = Math.max(0, index - config.stuck.cooldown + 1); at <= index; at++) if (!state.once("stuck", judged(at))) return false;
    return true;
  };
  const verdict = await evaluateStuck(window, record?.task, { config: config.stuck, judge: "reason" in judge ? undefined : judge, timeoutMs: config.timeoutMs, signal, claim });
  // A stuck verdict on the same result carries its own notice; the quick one would say the same thing twice.
  if (verdict.stuck) return ownerNotice(stuckNudge(verdict));
  const notice = (reason: string, text: string): string | undefined => state.once("notice", `stuck-${reason}`) ? `pi-warden: ${text}` : undefined;
  const problem = "reason" in judge ? notice(judge.reason, `stuck-check judgments are off; ${judge.problem}. Exact repeats are still caught.`)
    : verdict.error === undefined ? undefined
    : verdict.errorCode === "budget" ? notice("budget", "stuck-check request budget reached or unavailable; no further request was submitted.")
    : notice("judge-error", "stuck-check judgment failed; this call continues.");
  return ownerNotice([repeat && quickRepeatNudge(repeat), problem].filter(Boolean).join("\n") || undefined);
}

/** The stuck-check of one result, given what is left of the hook's `deadline`, so it can run beside the hook's other work. */
export function stuckNotice(config: WardenConfig, state: HostState, agent: string | undefined, identity: string, attempt: Attempt, signal: AbortSignal, deadline: number): Promise<OwnerOutput> {
  return ownerOnly(stuckCheck(config, state, agent, identity, attempt, signal), deadline - STUCK_RESERVE_MS);
}
