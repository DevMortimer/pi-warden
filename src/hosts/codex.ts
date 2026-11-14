import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { redact } from "../redact.js";
import { describeTarget, EDIT_TEXT_LIMIT, MAX_EDITS, projectPath } from "../rules.js";
import type { EditView, RulesTarget } from "../rules.js";
import { parsePatch } from "./apply-patch.js";
import type { PatchHunk } from "./apply-patch.js";
import { checkRecord, promptHook, sessionOf, stopHook } from "./done-check.js";
import type { OwnerOutput } from "./done-check.js";
import { feedback, globalConfig, RulesRun } from "./headless.js";
import type { HookOutput } from "./headless.js";
import { HostState } from "./state.js";
import { object } from "./io.js";

/** Codex's hook result: context for the model after a call, or the owner-facing message the model never sees. */
export type CodexOutput = HookOutput & OwnerOutput;

const CODEX_EVENTS = ["PostToolUse", "UserPromptSubmit", "Stop"] as const;

/** Files of one patch judged together, in parallel, inside the hook deadline; the rest are named, not judged. */
const MAX_PATCH_FILES = 4;

const sample = (lines: readonly string[]): string => redact(lines.join("\n")).slice(0, EDIT_TEXT_LIMIT);

/**
 * The change one hunk made, read from the patch alone. `PostToolUse` runs only after the whole patch applied, so each
 * chunk's lines are what the file held and now holds there; the context is the patch's own context lines. A deleted
 * file has nothing to judge, and a path that no longer resolves into the project is skipped.
 */
async function hunkTarget(hunk: PatchHunk, cwd: string, project: string): Promise<RulesTarget | undefined> {
  if (hunk.kind === "delete") return undefined;
  const file = await realpath(resolve(cwd, hunk.kind === "update" ? hunk.movePath ?? hunk.path : hunk.path)).catch(() => undefined);
  const path = file === undefined ? undefined : projectPath(file, project);
  if (!path) return undefined;
  if (hunk.kind === "add") return describeTarget("write", { path: file, content: hunk.contents }, project);
  // Empty additions stay edits, so a chunk that only deletes required content can be judged.
  const edits: EditView[] = hunk.chunks.slice(0, MAX_EDITS).map((chunk, index) => ({
    id: `edit_${index + 1}`, before: sample(chunk.oldLines), after: sample(chunk.newLines), newText: sample(chunk.added),
  }));
  const more = hunk.chunks.length - MAX_EDITS;
  return { tool: "edit", path, edits, ...(more > 0 ? { moreEdits: more } : {}) };
}

/** A patch changes the project when a file it adds, updates, moves or deletes lies inside it, judged by path as Pi judges a write. */
const changesProject = (hunk: PatchHunk, cwd: string): boolean =>
  [hunk.path, hunk.kind === "update" ? hunk.movePath : undefined].some(path => path !== undefined && projectPath(path, cwd) !== undefined);

export async function codexHook(event: string, raw: unknown, signal: AbortSignal): Promise<CodexOutput> {
  if (!(CODEX_EVENTS as readonly string[]).includes(event) || !object(raw) || raw.hook_event_name !== event) return {};
  if (event === "UserPromptSubmit") return promptHook("codex", raw, signal);
  if (event === "Stop") return stopHook("codex", raw, signal);
  if ((raw.tool_name !== "apply_patch" && raw.tool_name !== "Bash") || !object(raw.tool_input)) return {};
  const { cwd, session } = sessionOf(raw);
  const toolId = raw.tool_use_id;
  if (typeof toolId !== "string" || !toolId || toolId.length > 512) throw new Error("Invalid Codex tool identity.");
  if (raw.agent_id !== undefined && (typeof raw.agent_id !== "string" || !raw.agent_id || raw.agent_id.length > 512)) throw new Error("Invalid Codex actor identity.");
  const command = raw.tool_input.command;
  if (typeof command !== "string") throw new Error(`Invalid Codex ${raw.tool_name} input.`);
  const config = await globalConfig(signal);
  const rules = config.enabled && config.rules.enabled && raw.tool_name === "apply_patch";
  const done = config.enabled && config.done.enabled && config.done.nudge;
  if (!rules && !done) return {};
  const state = new HostState("codex", session, config.maxRequests, signal);
  await state.prepare();
  const identity = JSON.stringify([raw.agent_id ?? null, toolId]);
  if (raw.tool_name === "Bash") {
    // Codex sends a finished command's output and no exit status, so only the output can make the run a check.
    const record = typeof raw.tool_response === "string" ? checkRecord({ command }, undefined, raw.tool_response, cwd) : undefined;
    if (record) state.recordEvidence(identity, record);
    return {};
  }
  const hunks = parsePatch(command);
  if (done && hunks.some(hunk => changesProject(hunk, cwd))) state.recordEvidence(identity, { outcome: "mutation" });
  if (!rules || !state.once("processed", identity)) return {};
  const project = await realpath(cwd);
  const targets: RulesTarget[] = [];
  for (const hunk of hunks) {
    const target = await hunkTarget(hunk, cwd, project);
    if (target) targets.push(target);
  }
  const run = new RulesRun(project, config, state, signal);
  const notes = (await Promise.all(targets.slice(0, MAX_PATCH_FILES).map(target => run.notes(target)))).flat();
  const skipped = targets.length - MAX_PATCH_FILES;
  if (skipped > 0) notes.push(`pi-warden: ${skipped} more ${skipped === 1 ? "file" : "files"} in this patch ${skipped === 1 ? "was" : "were"} not judged against the rules; one patch is judged for its first ${MAX_PATCH_FILES} files.`);
  return feedback(notes);
}
