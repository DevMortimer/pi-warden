import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { redact } from "../redact.js";
import { describeTarget, EDIT_CONTEXT_LINES, EDIT_TEXT_LIMIT, MAX_EDITS, projectPath } from "../rules.js";
import type { EditView, RulesTarget } from "../rules.js";
import { feedback, globalConfig, RulesRun } from "./headless.js";
import type { HookOutput } from "./headless.js";
import { digest, HostState } from "./state.js";
import { FILE_BYTES, object, readText } from "./io.js";

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

export async function claudeHook(event: string, raw: unknown, signal: AbortSignal): Promise<HookOutput> {
  if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event)) return {};
  if (!object(raw) || raw.hook_event_name !== event || (raw.tool_name !== "Write" && raw.tool_name !== "Edit") || !object(raw.tool_input)) return {};
  const { cwd, session_id: session, tool_use_id: toolId } = raw;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof session !== "string" || !session || session.length > 512 || typeof toolId !== "string" || !toolId || toolId.length > 512) throw new Error("Invalid Claude tool identity.");
  if (raw.agent_id !== undefined && (typeof raw.agent_id !== "string" || !raw.agent_id || raw.agent_id.length > 512)) throw new Error("Invalid Claude actor identity.");
  const input = { ...raw.tool_input };
  if (typeof input.file_path !== "string" || !isAbsolute(input.file_path)) throw new Error("Invalid Claude file path.");
  const shownPath = input.file_path;
  const config = await globalConfig(signal);
  if (!config.enabled || !config.rules.enabled) return {};
  const state = new HostState("claude", session, config.maxRequests, signal);
  await state.prepare();
  const identity = JSON.stringify([raw.agent_id ?? null, toolId, raw.tool_name]);
  if (event === "PostToolUseFailure") { await state.consume(identity); return {}; }
  const project = await realpath(cwd);
  const file = await realpath(shownPath);
  if (!projectPath(file, project)) return {};
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
