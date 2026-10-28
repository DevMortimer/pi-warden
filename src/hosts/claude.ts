import { execFile, fork } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authStatePath, createTypeSafe, openUsageLedger, resolveBackend, usagePath } from "pi-typesafe";
import { judgeOptions } from "../backend.js";
import { loadConfig, userConfigPath } from "../config.js";
import type { RulesConfig } from "../config.js";
import { redact } from "../redact.js";
import { describeTarget, EDIT_CONTEXT_LINES, EDIT_TEXT_LIMIT, evaluateRulesTarget, FALLBACK_FILES, MAX_EDITS, pathNotes, pathNoteSteer, projectPath, RuleStore, RULES_FILE, rulesCapNotice, rulesSteer, skipReason } from "../rules.js";
import type { EditView, RulesTarget, RuleSet } from "../rules.js";
import { ClaudeState, digest } from "./claude-state.js";
import { FILE_BYTES, object, readText } from "./io.js";

export interface ClaudeOutput { hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext: string } }

function feedback(notes: string[]): ClaudeOutput {
  return notes.length ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: redact(notes.join("\n")).slice(0, 9000) } } : {};
}

/** A child process makes the deadline enforceable during native synchronous SDK reads as well. */
export async function runClaudeHook(event: string, input: unknown, signal: AbortSignal): Promise<ClaudeOutput> {
  signal.throwIfAborted();
  return new Promise((done, reject) => {
    const engine = fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, PI_WARDEN_CLAUDE_CHILD: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    });
    let output: ClaudeOutput | undefined;
    let failed = false;
    let terminate: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (engine.connected) engine.send("abort", () => undefined);
      // Git is awaited before entering the SDK. Allow its async cancellation and close callback first.
      terminate = setTimeout(() => {
        // This native ChildProcess handle still owns an unreaped leader; no numeric group is signalled.
        if (engine.pid !== undefined && engine.exitCode === null && engine.signalCode === null) engine.kill("SIGKILL");
      }, 100);
    };
    signal.addEventListener("abort", abort, { once: true });
    engine.on("message", (message: unknown) => {
      if (object(message) && message.ok === true && object(message.output)) output = message.output as ClaudeOutput;
      else failed = true;
    });
    engine.on("error", () => { failed = true; });
    engine.once("close", code => {
      clearTimeout(terminate);
      signal.removeEventListener("abort", abort);
      if (signal.aborted || failed || code !== 0 || output === undefined) reject(new Error("Claude hook did not finish within its limits."));
      else done(output);
    });
    engine.send({ event, input }, error => { if (error) failed = true; });
    if (signal.aborted) abort();
  });
}

const sampleEdit = (text: string): string => redact(text).slice(0, EDIT_TEXT_LIMIT);

function around(text: string, at: number, length: number): string {
  const lines = text.split("\n");
  const first = text.slice(0, at).split("\n").length - 1;
  const last = first + text.slice(at, at + length).split("\n").length - 1;
  return sampleEdit(lines.slice(Math.max(0, first - EDIT_CONTEXT_LINES), last + EDIT_CONTEXT_LINES + 1).join("\n").trimEnd());
}

async function captureEdit(input: Record<string, unknown>, cwd: string, identity: string, inputHash: string, state: ClaudeState, signal: AbortSignal): Promise<void> {
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

async function consumeEdit(input: Record<string, unknown>, cwd: string, identity: string, inputHash: string, state: ClaudeState, signal: AbortSignal): Promise<RulesTarget> {
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

async function loadRules(cwd: string, config: RulesConfig, signal: AbortSignal): Promise<RuleSet | undefined> {
  const sources = new Map<string, string>();
  const read = async (file: string): Promise<string | undefined> => {
    const path = resolve(cwd, file);
    const text = await readText(path, signal);
    if (text !== undefined) sources.set(path, text);
    return text;
  };
  if (await read(RULES_FILE) === undefined) {
    for (const file of config.files) await read(file);
    if (!sources.size && config.fallback) {
      for (const file of FALLBACK_FILES) if ((await read(file))?.trim()) break;
    }
  }
  return new RuleStore(path => sources.get(path)).load(cwd, config);
}

async function ignored(path: string, cwd: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((done, reject) => {
    execFile("git", ["check-ignore", "-q", "--", path], {
      cwd, signal, timeout: 1500, killSignal: "SIGKILL", maxBuffer: 4096, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }, error => {
      if (signal.aborted || error?.killed) reject(new Error("Git ignore check exceeded the hook deadline."));
      else done(!error);
    });
  });
}

export async function claudeHook(event: string, raw: unknown, signal: AbortSignal): Promise<ClaudeOutput> {
  if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event)) return {};
  if (!object(raw) || raw.hook_event_name !== event || (raw.tool_name !== "Write" && raw.tool_name !== "Edit") || !object(raw.tool_input)) return {};
  const { cwd, session_id: session, tool_use_id: toolId } = raw;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof session !== "string" || !session || session.length > 512 || typeof toolId !== "string" || !toolId || toolId.length > 512) throw new Error("Invalid Claude tool identity.");
  if (raw.agent_id !== undefined && (typeof raw.agent_id !== "string" || !raw.agent_id || raw.agent_id.length > 512)) throw new Error("Invalid Claude actor identity.");
  const input = { ...raw.tool_input };
  if (typeof input.file_path !== "string" || !isAbsolute(input.file_path)) throw new Error("Invalid Claude file path.");
  const shownPath = input.file_path;
  const user = await readText(userConfigPath(), signal);
  const userRaw: unknown = user === undefined ? {} : JSON.parse(user);
  if (!object(userRaw)) throw new Error("Invalid global Warden configuration.");
  const config = loadConfig({ userRaw: { value: userRaw } });
  if (!config.enabled || !config.rules.enabled) return {};
  const state = new ClaudeState(session, config.maxRequests, signal);
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
  const notes: string[] = [];
  const sensitive = pathNotes(target.path, config.rules.sensitivePaths).filter(hit => state.once("sensitive", JSON.stringify([project, target.path, hit.glob])));
  if (sensitive.length) notes.push(pathNoteSteer(target.path, sensitive));
  const set = await loadRules(project, config.rules, signal);
  if (skipReason(target, set, config.rules) || await ignored(target.path, project, signal)) return feedback(notes);
  const unavailable = (reason: string, message: string): ClaudeOutput => {
    if (state.once("notice", reason)) notes.push(`pi-warden: ${message}`);
    return feedback(notes);
  };
  if (process.env.PI_WARDEN_ENABLED !== "1") return unavailable("no-consent", "rules judgments are off; set PI_WARDEN_ENABLED=1 for this headless host.");
  const backend = config.typesafeBackend;
  if (backend === undefined) return unavailable("bad-backend", "rules judgments are off; fix typesafeBackend in the global user config.");
  const key = process.env[resolveBackend(backend).keyEnv]?.trim();
  if (!key) return unavailable("no-key", "rules judgments are off; set the active backend key in the environment.");
  await readText(authStatePath(), signal);
  await readText(usagePath(), signal);
  const observed = openUsageLedger();
  const judge = createTypeSafe({ ...judgeOptions({ ...config, typesafeBackend: backend }), apiKey: key,
    ledger: { ...observed, recordStart: () => { state.reserveRequest(); observed.recordStart(); } },
  });
  const verdict = await evaluateRulesTarget(target, target.tool, target.path, { cwd: project, config: config.rules, set, judge, timeoutMs: config.timeoutMs, signal });
  if (verdict.source === "error") return unavailable(verdict.errorCode === "budget" ? "budget" : "judge-error", verdict.errorCode === "budget" ? "rules request budget reached or unavailable; no further request was submitted." : "rules judgment failed; this call continues.");
  const cap = rulesCapNotice(verdict);
  if (cap && state.once("notice", "rules-cap")) notes.push(cap);
  if (verdict.findings.length || verdict.softFindings?.length) notes.push(rulesSteer(verdict, new Map()));
  return feedback(notes);
}

if (process.env.PI_WARDEN_CLAUDE_CHILD === "1" && process.send) {
  const controller = new AbortController();
  let started = false;
  const send = (message: unknown): void => {
    if (process.connected) process.send!(message, () => { if (process.connected) process.disconnect(); });
  };
  process.on("disconnect", () => controller.abort());
  process.on("message", (message: unknown) => {
    if (message === "abort") { controller.abort(); return; }
    if (started || !object(message) || typeof message.event !== "string") return;
    started = true;
    void claudeHook(message.event, message.input, controller.signal).then(
      output => send({ ok: true, output }),
      () => send({ ok: false }),
    );
  });
}
