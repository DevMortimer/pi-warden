import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { WardenConfig } from "../config.js";
import { classifyToolResult, doneNudge, emptyEvidence, evaluateDone, needsDoneCheck, projectCheckCommand, recordOutcome } from "../done.js";
import { redact } from "../redact.js";
import { globalConfig, headlessJudge } from "./headless.js";
import { HostState, TASK_LIMIT } from "./state.js";
import type { EvidenceRecord, HostName } from "./state.js";

/**
 * The done-check's result on a host: a message for the owner that the model never sees. Claude Code and Codex both show
 * a `systemMessage` to the user, and Pi's done-check tells the owner only, so it is never a Stop block.
 */
export interface OwnerOutput { systemMessage?: string }

export function ownerNotice(text: string | undefined): OwnerOutput {
  return text ? { systemMessage: redact(text).slice(0, 9000) } : {};
}

export function sessionOf(raw: Record<string, unknown>): { cwd: string; session: string } {
  const { cwd, session_id: session } = raw;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof session !== "string" || !session || session.length > 512) throw new Error("Invalid hook session identity.");
  return { cwd, session };
}

/** A shell run as Pi's done-check counts it: a passed or failed check with its redacted, clipped command, or nothing. */
export function checkRecord(input: Record<string, unknown>, failed: boolean | undefined, output: string, cwd: string): EvidenceRecord | undefined {
  const outcome = classifyToolResult("bash", input, failed, output, cwd);
  if (outcome !== "check-pass" && outcome !== "check-fail") return undefined;
  const call = recordOutcome(emptyEvidence(), outcome, input);
  return { outcome, ...(call !== undefined ? { call } : {}) };
}

/** With `done.nudge` off an unverified claim would show nothing, and this host has no trace to record it in. */
export const doneActive = (config: WardenConfig): boolean => config.enabled && config.done.enabled && config.done.nudge;

/** The latest prompt, kept as the task of the checks `uses` names; its id also starts the stuck-check's window. */
export async function promptHook(host: HostName, raw: Record<string, unknown>, signal: AbortSignal, uses: (config: WardenConfig) => boolean = doneActive): Promise<OwnerOutput> {
  const { session } = sessionOf(raw);
  if (typeof raw.prompt !== "string") throw new Error("Invalid hook prompt.");
  const config = await globalConfig(signal);
  if (!uses(config)) return {};
  const state = new HostState(host, session, config.maxRequests, signal);
  await state.prepare();
  await state.recordPrompt(redact(raw.prompt.trim()).slice(0, TASK_LIMIT));
  return {};
}

/** Pi's run-end done-check: one judgment per prompt, only when files changed and no check passed since the last change. */
export async function stopHook(host: HostName, raw: Record<string, unknown>, signal: AbortSignal): Promise<OwnerOutput> {
  const { cwd, session } = sessionOf(raw);
  const finalMessage = typeof raw.last_assistant_message === "string" ? raw.last_assistant_message.trim() : "";
  if (!finalMessage) return {};
  const config = await globalConfig(signal);
  if (!doneActive(config)) return {};
  const state = new HostState(host, session, config.maxRequests, signal);
  await state.prepare();
  const evidence = emptyEvidence();
  let lastCheck: string | undefined;
  for (const record of await state.evidence()) {
    recordOutcome(evidence, record.outcome, record.call !== undefined ? { command: record.call } : {});
    if (record.outcome === "check-pass") lastCheck = record.call;
  }
  if (!needsDoneCheck(evidence)) return {};
  const prompt = await state.prompt();
  if (!state.once("done", prompt?.id ?? "no prompt recorded")) return {};
  const notice = (reason: string, text: string): OwnerOutput => ownerNotice(state.once("notice", `done-${reason}`) ? `pi-warden: ${text}` : undefined);
  const judge = await headlessJudge(config, state, signal);
  if ("reason" in judge) return notice(judge.reason, `done-check is off; ${judge.problem}.`);
  const project = await realpath(cwd);
  const verdict = await evaluateDone(prompt?.task, finalMessage, evidence, { config: config.done, judge, timeoutMs: config.timeoutMs, signal });
  if (verdict.error !== undefined) return verdict.errorCode === "budget" ? notice("budget", "done-check request budget reached or unavailable; no further request was submitted.") : notice("judge-error", "done-check judgment failed; the reply stands unchecked.");
  return verdict.unverified ? ownerNotice(doneNudge(verdict, { lastCheck, projectCheck: projectCheckCommand(project) })) : {};
}
