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

/**
 * Pi's stuck guard for one tool result of a host whose hooks run in separate processes. The prompt's results are
 * numbered files, so the window is rebuilt from the latest `stuck.window` of them; a marker per judged result carries
 * the cooldown, and a marker per call key keeps the quick repeat to once per call per prompt. A stuck verdict, else a
 * quick repeat, goes to the owner only, as Pi reports both on the status line and never to the agent.
 */
export async function stuckCheck(config: WardenConfig, state: HostState, identity: string, attempt: Attempt, signal: AbortSignal): Promise<OwnerOutput> {
  const prompt = await state.prompt();
  const scope = prompt?.id ?? "no prompt recorded";
  const stored: Attempt = { ...attempt, text: storedText(attempt.text) };
  const index = state.recordAttempt(scope, identity, stored);
  if (index === undefined) return {};
  const window = new AttemptWindow(config.stuck.window);
  for (const earlier of await state.attempts(scope, index - config.stuck.window + 1, index - 1)) window.push(earlier);
  window.push(stored);
  const judged = (at: number): string => JSON.stringify([scope, at]);
  for (let ago = 1; ago < config.stuck.cooldown && ago <= index; ago++) {
    if (state.claimed("stuck", judged(index - ago))) { window.markJudged(ago); break; }
  }
  const candidate = config.stuck.repeatSteer ? window.quickRepeat() : undefined;
  const repeat = candidate && state.once("repeat", JSON.stringify([scope, candidate.attempt.key])) ? candidate : undefined;
  if (!window.shouldJudge(config.stuck)) return ownerNotice(repeat && quickRepeatNudge(repeat));
  const judge = await headlessJudge(config, state, signal);
  const verdict = await evaluateStuck(window, prompt?.task, { config: config.stuck, judge: "reason" in judge ? undefined : judge, timeoutMs: config.timeoutMs, signal });
  if (verdict.source !== "repeat") state.once("stuck", judged(index));
  // A stuck verdict on the same result carries its own notice; the quick one would say the same thing twice.
  if (verdict.stuck) return ownerNotice(stuckNudge(verdict));
  const notice = (reason: string, text: string): string | undefined => state.once("notice", `stuck-${reason}`) ? `pi-warden: ${text}` : undefined;
  const problem = "reason" in judge ? notice(judge.reason, `stuck-check judgments are off; ${judge.problem}. Exact repeats are still caught.`)
    : verdict.error === undefined ? undefined
    : verdict.errorCode === "budget" ? notice("budget", "stuck-check request budget reached or unavailable; no further request was submitted.")
    : notice("judge-error", "stuck-check judgment failed; this call continues.");
  return ownerNotice([repeat && quickRepeatNudge(repeat), problem].filter(Boolean).join("\n") || undefined);
}
