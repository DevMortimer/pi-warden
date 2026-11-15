import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { WardenConfig } from "../config.js";
import { redact } from "../redact.js";
import { describeTarget, EDIT_CONTEXT_LINES, EDIT_TEXT_LIMIT, MAX_EDITS, projectPath } from "../rules.js";
import type { EditView, RulesTarget } from "../rules.js";
import { makeAttempt } from "../stuck.js";
import type { Attempt } from "../stuck.js";
import { checkRecord, doneActive, promptHook, sessionOf, stopHook } from "./done-check.js";
import type { OwnerOutput } from "./done-check.js";
import { feedback, globalConfig, RulesRun } from "./headless.js";
import type { HookOutput } from "./headless.js";
import { digest, HostState } from "./state.js";
import type { EvidenceRecord } from "./state.js";
import { stuckActive, stuckCheck } from "./stuck-check.js";
import { FILE_BYTES, object, readText } from "./io.js";

/** Claude's hook result: context for the model after a call, or the owner-facing message the model never sees. */
export type ClaudeOutput = HookOutput & OwnerOutput;

const CLAUDE_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop"] as const;

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

/**
 * A Bash run's output as Claude reports it. A background run returns before the command does, and an interrupted one
 * reports neither a pass nor a failure of the code, so neither has a result to read.
 */
function bashOutput(event: string, raw: Record<string, unknown>, input: Record<string, unknown>): string | undefined {
  if (typeof input.command !== "string" || input.run_in_background === true) return undefined;
  if (event === "PostToolUseFailure") return raw.is_interrupt === true || typeof raw.error !== "string" ? undefined : raw.error;
  const response = object(raw.tool_response) ? raw.tool_response : {};
  if (response.interrupted === true) return undefined;
  return [response.stdout, response.stderr].filter((part): part is string => typeof part === "string" && part !== "").join("\n");
}

/** A Bash run as Pi's done-check reads it. */
function bashOutcome(event: string, raw: Record<string, unknown>, input: Record<string, unknown>, cwd: string): EvidenceRecord | undefined {
  const output = bashOutput(event, raw, input);
  return output === undefined ? undefined : checkRecord(input, event === "PostToolUseFailure", output, cwd);
}

/**
 * A tool result in the shape of Pi's own tools, so the stuck guard keys, classifies and diffs it as in Pi. A successful
 * Write or Edit has no output worth comparing; a failed one keeps Claude's error.
 */
function claudeAttempt(event: string, raw: Record<string, unknown>, input: Record<string, unknown>): Attempt | undefined {
  const failed = event === "PostToolUseFailure";
  if (raw.tool_name === "Bash") {
    const output = bashOutput(event, raw, input);
    return output === undefined ? undefined : makeAttempt("bash", { command: input.command }, [{ type: "text", text: output }], failed);
  }
  if (failed && (raw.is_interrupt === true || typeof raw.error !== "string")) return undefined;
  const view = raw.tool_name === "Write" ? { path: input.file_path, content: input.content }
    : { path: input.file_path, oldText: input.old_string, newText: input.new_string, ...(input.replace_all === true ? { replaceAll: true } : {}) };
  return makeAttempt(raw.tool_name === "Write" ? "write" : "edit", view, [{ type: "text", text: failed ? raw.error as string : "" }], failed);
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

export async function claudeHook(event: string, raw: unknown, signal: AbortSignal, deadline: number): Promise<ClaudeOutput> {
  if (!(CLAUDE_EVENTS as readonly string[]).includes(event) || !object(raw) || raw.hook_event_name !== event) return {};
  if (event === "UserPromptSubmit") return promptHook("claude", raw, signal, config => doneActive(config) || stuckActive(config));
  if (event === "Stop") return stopHook("claude", raw, signal);
  if ((raw.tool_name !== "Write" && raw.tool_name !== "Edit" && raw.tool_name !== "Bash") || !object(raw.tool_input)) return {};
  const { cwd, session } = sessionOf(raw);
  const toolId = raw.tool_use_id;
  if (typeof toolId !== "string" || !toolId || toolId.length > 512) throw new Error("Invalid Claude tool identity.");
  if (raw.agent_id !== undefined && (typeof raw.agent_id !== "string" || !raw.agent_id || raw.agent_id.length > 512)) throw new Error("Invalid Claude actor identity.");
  const input = { ...raw.tool_input };
  if (raw.tool_name !== "Bash" && (typeof input.file_path !== "string" || !isAbsolute(input.file_path))) throw new Error("Invalid Claude file path.");
  const config = await globalConfig(signal);
  const rules = config.enabled && config.rules.enabled;
  const done = doneActive(config);
  const stuck = stuckActive(config);
  if (!rules && !done && !stuck) return {};
  const state = new HostState("claude", session, config.maxRequests, signal);
  await state.prepare();
  const agent = raw.agent_id as string | undefined;
  const identity = JSON.stringify([agent ?? null, toolId, raw.tool_name]);
  const attempt = stuck && event !== "PreToolUse" ? claudeAttempt(event, raw, input) : undefined;
  // Both may wait for a judgment, so they share the hook's deadline instead of taking turns at it.
  const [notice, output] = await Promise.all([
    attempt ? ownerOnly(stuckCheck(config, state, agent, identity, attempt, signal), deadline - STUCK_RESERVE_MS) : {},
    afterCall(event, raw, input, cwd, config, state, identity, signal),
  ]);
  return { ...output, ...notice };
}

/** The rules judgment and the done-check's evidence for one call; the stuck-check runs beside it. */
async function afterCall(event: string, raw: Record<string, unknown>, input: Record<string, unknown>, cwd: string, config: WardenConfig, state: HostState, identity: string, signal: AbortSignal): Promise<HookOutput> {
  const rules = config.enabled && config.rules.enabled;
  const done = doneActive(config);
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
