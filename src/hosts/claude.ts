import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { classifyToolResult, doneNudge, emptyEvidence, evaluateDone, needsDoneCheck, projectCheckCommand, recordOutcome } from "../done.js";
import { redact } from "../redact.js";
import { describeTarget, EDIT_CONTEXT_LINES, EDIT_TEXT_LIMIT, MAX_EDITS, projectPath } from "../rules.js";
import type { EditView, RulesTarget } from "../rules.js";
import { feedback, globalConfig, headlessJudge, RulesRun } from "./headless.js";
import type { HookOutput } from "./headless.js";
import { digest, HostState, TASK_LIMIT } from "./state.js";
import type { EvidenceRecord } from "./state.js";
import { FILE_BYTES, object, readText } from "./io.js";

/** Claude's hook result: context for the model after a call, or the owner-facing message the model never sees. */
export interface ClaudeOutput extends HookOutput { systemMessage?: string }

const CLAUDE_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop"] as const;

/** Pi's done-check tells the owner, never the model, so the notice is Claude's user-facing message, not a Stop block. */
function ownerNotice(text: string | undefined): ClaudeOutput {
  return text ? { systemMessage: redact(text).slice(0, 9000) } : {};
}

const sampleEdit = (text: string): string => redact(text).slice(0, EDIT_TEXT_LIMIT);

function around(text: string, at: number, length: number): string {
  const lines = text.split("\n");
  const first = text.slice(0, at).split("\n").length - 1;
  const last = first + text.slice(at, at + length).split("\n").length - 1;
  return sampleEdit(lines.slice(Math.max(0, first - EDIT_CONTEXT_LINES), last + EDIT_CONTEXT_LINES + 1).join("\n").trimEnd());
}

async function captureEdit(input: Record<string, unknown>, cwd: string, identity: string, inputHash: string, state: HostState, signal: AbortSignal): Promise<void> {
  if (typeof input.old_string !== "string" || !input.old_string || typeof input.new_string !== "string" || (input.replace_all !== undefined && typeof input.replace_all !== "boolean")) throw new Error("Invalid Claude Edit input.");
  const oldText = input.old_string;
  const newText = input.new_string;
  const path = projectPath(input.file_path as string, cwd);
  if (!path) return;
  const before = await readText(input.file_path as string, signal);
  if (before === undefined) return;
  const positions: number[] = [];
  for (let at = before.indexOf(oldText); at >= 0; at = before.indexOf(oldText, at + oldText.length)) positions.push(at);
  if (!positions.length || (!input.replace_all && positions.length !== 1)) throw new Error("Cannot prove the Claude Edit replacement.");
  if (Buffer.byteLength(before) + positions.length * (Buffer.byteLength(newText) - Buffer.byteLength(oldText)) > FILE_BYTES) throw new Error("Claude Edit result exceeds the byte limit.");
  const after = before.split(oldText).join(newText);
  const edits: EditView[] = positions.slice(0, MAX_EDITS).map((at, index) => ({
    id: `edit_${index + 1}`, before: around(before, at, oldText.length),
    after: around(after, at + index * (newText.length - oldText.length), newText.length),
    newText: sampleEdit(newText),
  }));
  const target: RulesTarget = { tool: "edit", path: redact(path), edits, ...(positions.length > MAX_EDITS ? { moreEdits: positions.length - MAX_EDITS } : {}) };
  await state.capture(identity, { version: 1, expires: Date.now() + 600_000, inputHash, afterHash: digest(after), target });
}

async function consumeEdit(input: Record<string, unknown>, cwd: string, identity: string, inputHash: string, state: HostState, signal: AbortSignal): Promise<RulesTarget> {
  const record = await state.consume(identity);
  const path = projectPath(input.file_path as string, cwd);
  if (!object(record) || record.version !== 1 || typeof record.expires !== "number" || !Number.isSafeInteger(record.expires) || record.expires < Date.now() || record.inputHash !== inputHash || !object(record.target)
    || record.target.tool !== "edit" || record.target.path !== redact(path ?? "") || !Array.isArray(record.target.edits) || !record.target.edits.length || record.target.edits.length > MAX_EDITS) throw new Error("Claude Edit capture is missing or no longer matches; rules skipped.");
  const after = await readText(input.file_path as string, signal);
  if (after === undefined || digest(after) !== record.afterHash) throw new Error("Claude Edit changed concurrently; rules skipped.");
  const edits: EditView[] = [];
  for (const [index, raw] of record.target.edits.entries()) {
    if (!object(raw) || raw.id !== `edit_${index + 1}` || typeof raw.before !== "string" || typeof raw.after !== "string" || typeof raw.newText !== "string"
      || [raw.before, raw.after, raw.newText].some(text => text.length > EDIT_TEXT_LIMIT)) throw new Error("Invalid Claude Edit capture.");
    edits.push({ id: raw.id as string, before: redact(raw.before), after: redact(raw.after), newText: redact(raw.newText) });
  }
  const more = record.target.moreEdits;
  if (more !== undefined && (typeof more !== "number" || !Number.isSafeInteger(more) || more < 1 || more > FILE_BYTES)) throw new Error("Invalid Claude Edit count.");
  return { tool: "edit", path: path!, edits, ...(typeof more === "number" ? { moreEdits: more } : {}) };
}

function sessionOf(raw: Record<string, unknown>): { cwd: string; session: string } {
  const { cwd, session_id: session } = raw;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof session !== "string" || !session || session.length > 512) throw new Error("Invalid Claude session identity.");
  return { cwd, session };
}

/**
 * A Bash result as Pi's done-check reads it. A background run returns before the runner does, and an interrupted one
 * reports neither a pass nor a failure of the code, so neither is a check.
 */
function bashOutcome(event: string, raw: Record<string, unknown>, input: Record<string, unknown>, cwd: string): EvidenceRecord | undefined {
  if (typeof input.command !== "string" || input.run_in_background === true) return undefined;
  let output: string;
  if (event === "PostToolUseFailure") {
    if (raw.is_interrupt === true || typeof raw.error !== "string") return undefined;
    output = raw.error;
  } else {
    const response = object(raw.tool_response) ? raw.tool_response : {};
    if (response.interrupted === true) return undefined;
    output = [response.stdout, response.stderr].filter((part): part is string => typeof part === "string" && part !== "").join("\n");
  }
  const outcome = classifyToolResult("bash", input, event === "PostToolUseFailure", output, cwd);
  if (outcome !== "check-pass" && outcome !== "check-fail") return undefined;
  const call = recordOutcome(emptyEvidence(), outcome, input);
  return { outcome, ...(call !== undefined ? { call } : {}) };
}

async function promptHook(raw: Record<string, unknown>, signal: AbortSignal): Promise<ClaudeOutput> {
  const { session } = sessionOf(raw);
  if (typeof raw.prompt !== "string") throw new Error("Invalid Claude prompt.");
  const config = await globalConfig(signal);
  if (!config.enabled || !config.done.enabled || !config.done.nudge) return {};
  const state = new HostState("claude", session, config.maxRequests, signal);
  await state.prepare();
  await state.recordPrompt(redact(raw.prompt.trim()).slice(0, TASK_LIMIT));
  return {};
}

/** Pi's run-end done-check: one judgment per prompt, only when files changed and no check passed since the last change. */
async function stopHook(raw: Record<string, unknown>, signal: AbortSignal): Promise<ClaudeOutput> {
  const { cwd, session } = sessionOf(raw);
  const finalMessage = typeof raw.last_assistant_message === "string" ? raw.last_assistant_message.trim() : "";
  if (!finalMessage) return {};
  const config = await globalConfig(signal);
  // An unverified claim with `done.nudge` off shows nothing here, and this host has no trace to record it in.
  if (!config.enabled || !config.done.enabled || !config.done.nudge) return {};
  const state = new HostState("claude", session, config.maxRequests, signal);
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
  const notice = (reason: string, text: string): ClaudeOutput => ownerNotice(state.once("notice", `done-${reason}`) ? `pi-warden: ${text}` : undefined);
  const judge = await headlessJudge(config, state, signal);
  if ("reason" in judge) return notice(judge.reason, `done-check is off; ${judge.problem}.`);
  const project = await realpath(cwd);
  const verdict = await evaluateDone(prompt?.task, finalMessage, evidence, { config: config.done, judge, timeoutMs: config.timeoutMs, signal });
  if (verdict.error !== undefined) return verdict.errorCode === "budget" ? notice("budget", "done-check request budget reached or unavailable; no further request was submitted.") : notice("judge-error", "done-check judgment failed; the reply stands unchecked.");
  return verdict.unverified ? ownerNotice(doneNudge(verdict, { lastCheck, projectCheck: projectCheckCommand(project) })) : {};
}

export async function claudeHook(event: string, raw: unknown, signal: AbortSignal): Promise<ClaudeOutput> {
  if (!(CLAUDE_EVENTS as readonly string[]).includes(event) || !object(raw) || raw.hook_event_name !== event) return {};
  if (event === "UserPromptSubmit") return promptHook(raw, signal);
  if (event === "Stop") return stopHook(raw, signal);
  if ((raw.tool_name !== "Write" && raw.tool_name !== "Edit" && raw.tool_name !== "Bash") || !object(raw.tool_input)) return {};
  const { cwd, session } = sessionOf(raw);
  const toolId = raw.tool_use_id;
  if (typeof toolId !== "string" || !toolId || toolId.length > 512) throw new Error("Invalid Claude tool identity.");
  if (raw.agent_id !== undefined && (typeof raw.agent_id !== "string" || !raw.agent_id || raw.agent_id.length > 512)) throw new Error("Invalid Claude actor identity.");
  const input = { ...raw.tool_input };
  if (raw.tool_name !== "Bash" && (typeof input.file_path !== "string" || !isAbsolute(input.file_path))) throw new Error("Invalid Claude file path.");
  const config = await globalConfig(signal);
  const rules = config.enabled && config.rules.enabled;
  const done = config.enabled && config.done.enabled && config.done.nudge;
  if (!rules && !done) return {};
  const state = new HostState("claude", session, config.maxRequests, signal);
  await state.prepare();
  const identity = JSON.stringify([raw.agent_id ?? null, toolId, raw.tool_name]);
  if (raw.tool_name === "Bash") {
    const record = done && event !== "PreToolUse" ? bashOutcome(event, raw, input, await realpath(cwd)) : undefined;
    if (record) state.recordEvidence(identity, record);
    return {};
  }
  // A failed Write or Edit left the file as it was, so it is no change for the done-check.
  if (event === "PostToolUseFailure") { await state.consume(identity); return {}; }
  const shownPath = input.file_path as string;
  const project = await realpath(cwd);
  const file = await realpath(shownPath);
  if (!projectPath(file, project)) return {};
  if (done && event === "PostToolUse") state.recordEvidence(identity, { outcome: "mutation" });
  if (!rules) return {};
  input.file_path = file;
  const inputHash = digest(JSON.stringify([cwd, project, shownPath, file, input.old_string, input.new_string, input.replace_all ?? false]));
  if (event === "PreToolUse") {
    if (raw.tool_name === "Edit") await captureEdit(input, project, identity, inputHash, state, signal);
    return {};
  }
  if (!state.once("processed", identity)) return {};
  const target = raw.tool_name === "Write" ? describeTarget("write", { path: input.file_path, content: input.content }, project)
    : await consumeEdit(input, project, identity, inputHash, state, signal);
  if (!target) return {};
  return feedback(await new RulesRun(project, config, state, signal).notes(target));
}
