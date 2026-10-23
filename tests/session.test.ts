import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension, SessionManager as AgentSessionManager } from "@earendil-works/pi-coding-agent";
import { armFor } from "../src/trial.js";
import { sessionFileId } from "../src/holds.js";

// This file loads pi-warden exactly as Pi does: `package.json` → `pi.extensions` → `extensions/index.js` →
// `dist/extension.js`. `tests/extension.test.ts` mounts `src/extension.ts` by hand, which cannot catch a broken
// shipped entry, and `tests/steer-delivery.test.ts` runs a real session with its own probe extension, not pi-warden.
// The TypeSafe transport is the same `fetch` stub the extension tests use: no key leaves the process, no request runs.
const wardenEntry = fileURLToPath(new URL("../extensions/index.js", import.meta.url));
const distEntry = fileURLToPath(new URL("../dist/extension.js", import.meta.url));
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { pi?: { extensions?: string[] } };
assert.ok(existsSync(distEntry), "run npm run build first");
assert.equal(packageManifest.pi?.extensions?.[0], "./extensions/index.js");

// pi-ai ships inside pi-coding-agent; the faux provider answers from a script, so no request leaves the process.
const agentRoot = fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent")));
const nested = join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
const faux = await import(existsSync(nested) ? pathToFileURL(nested).href : "@earendil-works/pi-ai/providers/faux");

const originalFetch = globalThis.fetch;
const saved = {
  key: process.env.TYPESAFE_API_KEY,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  enabled: process.env.PI_WARDEN_ENABLED,
  mode: process.env.PI_WARDEN_MODE,
  db: process.env.PI_WARDEN_DB,
};
const dirs: string[] = [];
let root = "";
let agentDir = "";
let nextAnswers: Record<string, number | string> = {};

/** The same answer table the extension tests use, so one stub covers the action, stuck, and done questions. */
async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (String(input).endsWith("/v1/models")) {
    return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }] });
  }
  const body = JSON.parse(String(init?.body)) as { model?: string; questions: Record<string, { type: string; criteria?: unknown }> };
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    const value = nextAnswers[id];
    if (question.type === "noul") answers[id] = { type: "noul", noul: typeof value === "number" ? value : (id === "should_proceed" ? 1.0 : 0.1) };
    else if (question.type === "choice") {
      const keys = Object.keys(question.criteria as Record<string, unknown>);
      const pick = typeof value === "string" ? value : keys[0]!;
      answers[id] = { type: "choice", choice: pick, confidence: 0.8, probabilities: Object.fromEntries(keys.map(key => [key, key === pick ? 0.8 : 0.2 / (keys.length - 1)])) };
    } else {
      const levels = (question.criteria as unknown[]).length;
      const score = typeof value === "number" ? value : 0;
      answers[id] = {
        type: "score", score, confidence: 0.8,
        legend: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), `level ${index}`])),
        probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === Math.round(score) ? 0.8 : 0.2 / (levels - 1)])),
      };
    }
  }
  return Response.json({ model: body.model ?? "jev-latest", answers, usage: { input_tokens: 50, output_tokens: 0 } });
}

interface Recorded { bashRan: boolean; bashCommand: string | undefined; readCalls: number; written: string[] }
/** Where the session's stub tools resolve relative paths. Set by runSession to the session dir; undefined falls back to process cwd (the old behavior for tests that pass absolute paths). */
let toolCwd: string | undefined;

/** The session's own tools. `bash` records a run and returns ok; `read` always fails with the same message. */
function recordingTools(record: Recorded): InlineExtension {
  return ((pi: ExtensionAPI) => {
    pi.registerTool({
      name: "bash", label: "bash", description: "Records the command, then reports it ran.",
      parameters: Type.Object({ command: Type.String() }),
      async execute(_id, params) {
        record.bashRan = true;
        record.bashCommand = (params as { command: string }).command;
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    });
    pi.registerTool({
      name: "read", label: "read", description: "Always fails the same way.",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        record.readCalls++;
        throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
      },
    });
    pi.registerTool({
      name: "write", label: "write", description: "Writes a file.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id, params) {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname, resolve } = await import("node:path");
        const target = resolve(toolCwd ?? ".", (params as { path: string }).path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, (params as { content: string }).content);
        record.written.push(target);
        return { content: [{ type: "text", text: "wrote" }], details: undefined };
      },
    });
  }) as unknown as InlineExtension;
}

type ScriptedReply = ReturnType<typeof faux.fauxAssistantMessage> | ((context: { messages: unknown[] }) => ReturnType<typeof faux.fauxAssistantMessage>);

/** One project, one session, pi-warden loaded through Pi's loader from the package's own entry. `sessionId` picks the trial arm. */
async function runSession(script: ScriptedReply[], record: Recorded, options: { sessionId?: string } = {}): Promise<{ session: { prompt: (text: string) => Promise<unknown>; sessionManager: AgentSessionManager }; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-session-project-"));
  dirs.push(dir);
  const provider = faux.fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider.provider);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "offline");
  toolCwd = dir;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [wardenEntry],
    extensionFactories: [recordingTools(record)],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], "Pi's native loader must accept the shipped pi-warden entry");
  const { session } = await createAgentSession({ cwd: dir, agentDir, modelRuntime, model: provider.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(dir, options.sessionId ? { id: options.sessionId } : undefined), settingsManager: SettingsManager.inMemory(), noTools: "builtin" });
  // `createAgentSession` builds the session but does not fire `session_start`; the host modes call `bindExtensions`.
  // Firing it here is what makes this a real session: pi-warden initialises its database and reads the running build.
  await session.bindExtensions({ mode: "print" });
  provider.setResponses(script);
  return { session, dir };
}

/** The trace file this session wrote: where a guard report goes when the host has no terminal UI. */
async function traceText(session: { sessionManager: AgentSessionManager }): Promise<string> {
  const dir = process.env.PI_WARDEN_TRACE_DIR;
  if (!dir) return "";
  const id = session.sessionManager.getSessionId();
  const file = join(dir, `${sessionFileId(id)}.jsonl`);
  // A trace the host has not written yet is not an error; an unreadable one raises.
  return existsSync(file) ? readFile(file, "utf8") : "";
}

/** Waits for the trace write, which the host does not await, and returns the whole file text. */
async function waitForTrace(session: { sessionManager: AgentSessionManager }, pattern: RegExp, what: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const text = await traceText(session);
    if (pattern.test(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what} in the trace`);
}

/** The text of every custom message the session recorded, so a test asserts on what the model was shown. */
function customMessages(session: { sessionManager: AgentSessionManager }): string {
  return session.sessionManager.getBranch()
    .filter(entry => entry.type === "custom_message")
    .map(entry => String((entry as { content?: unknown }).content ?? ""))
    .join("\n");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-warden-session-"));
  agentDir = join(root, "agent");
  await mkdir(join(agentDir, "pi-warden"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  process.env.PI_WARDEN_DB = join(agentDir, "pi-warden", "holds.db");
  process.env.PI_WARDEN_TRACE_DIR = join(root, "trace");
  delete process.env.PI_WARDEN_ENABLED;
  delete process.env.PI_WARDEN_MODE;
  // `action.floor: "level"` is a user-only key: it makes the offline pattern floor decide the level, which is what
  // holds a destructive command (CONTRIBUTING.md: a built-in pattern holds only when no judge answers or floor is level).
  const config = {
    typesafe: true,
    notices: false,
    prefs: { enabled: false },
    rules: { enabled: false },
    rulesAtTurnStart: { enabled: false },
    slop: { enabled: false },
    security: { enabled: false },
    context: { enabled: false },
    action: { floor: "level" },
    widget: { barMode: "stack" },
  };
  await writeFile(join(agentDir, "pi-warden", "config.json"), JSON.stringify(config));
  globalThis.fetch = stubFetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.key;
  if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  if (saved.enabled === undefined) delete process.env.PI_WARDEN_ENABLED; else process.env.PI_WARDEN_ENABLED = saved.enabled;
  if (saved.mode === undefined) delete process.env.PI_WARDEN_MODE; else process.env.PI_WARDEN_MODE = saved.mode;
  if (saved.db === undefined) delete process.env.PI_WARDEN_DB; else process.env.PI_WARDEN_DB = saved.db;
  delete process.env.PI_WARDEN_TRACE_DIR;
  if (root) await rm(root, { recursive: true, force: true });
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("the shipped pi-warden holds a destructive bash call: the tool never runs and the model reads the hold", async () => {
  nextAnswers = { irreversible: 0.1, off_task: 0.1, scope: "expected_step", should_proceed: 1.0 };
  const record: Recorded = { bashRan: false, bashCommand: undefined, readCalls: 0, written: [] };
  let seenAfterHold = "";
  const { session } = await runSession([
    faux.fauxAssistantMessage(faux.fauxToolCall("bash", { command: "git push --force origin main" })),
    (context: { messages: unknown[] }) => { seenAfterHold = JSON.stringify(context.messages); return faux.fauxAssistantMessage("Stopped."); },
  ], record);
  await session.prompt("push my branch");
  assert.equal(record.bashRan, false, "the held command never reached the tool");
  assert.match(seenAfterHold, /pi-warden held this bash call before it ran/, "the tool result the model reads carries the hold text");
});

test("the shipped pi-warden records an unverified done claim in the trace and keeps it out of the model's context", async () => {
  nextAnswers = { irreversible: 0.1, off_task: 0.1, scope: "expected_step", should_proceed: 1.0, claims_done: 0.95, claims_verified: 0.1, verification_applies: 0.95, outcome: "complete" };
  const record: Recorded = { bashRan: false, bashCommand: undefined, readCalls: 0, written: [] };
  let seenAfterNudge = "";
  const { session } = await runSession([
    faux.fauxAssistantMessage(faux.fauxToolCall("write", { path: "note.txt", content: "hello" })),
    (context: { messages: unknown[] }) => { seenAfterNudge = JSON.stringify(context.messages); return faux.fauxAssistantMessage("Done."); },
  ], record);
  await session.prompt("add a note");
  assert.equal(record.written.length, 1, "the edit ran once");
  assert.ok(record.written[0]!.endsWith("note.txt"), "the edit ran");
  assert.doesNotMatch(seenAfterNudge, /no test, build, or lint run/, "the done-check notice never enters the model's context");
  assert.match(await waitForTrace(session, /no test, build, or lint run/, "the done-check notice"), /warden · done-check/, "the trace file holds the notice");
  assert.doesNotMatch(customMessages(session), /no test, build, or lint run/, "the session records no warden custom message");
});

test("the shipped pi-warden records the repeat note in the trace after the same failing read twice", async () => {
  nextAnswers = { irreversible: 0.1, off_task: 0.1, scope: "expected_step", should_proceed: 1.0 };
  const record: Recorded = { bashRan: false, bashCommand: undefined, readCalls: 0, written: [] };
  let seenAfterRepeat = "";
  const { session } = await runSession([
    faux.fauxAssistantMessage(faux.fauxToolCall("read", { path: "missing.txt" })),
    (context: { messages: unknown[] }) => { seenAfterRepeat = JSON.stringify(context.messages); return faux.fauxAssistantMessage(faux.fauxToolCall("read", { path: "missing.txt" })) },
    (context: { messages: unknown[] }) => { seenAfterRepeat = JSON.stringify(context.messages); return faux.fauxAssistantMessage("Stopped."); },
  ], record);
  await session.prompt("read the missing file");
  assert.equal(record.readCalls, 2, "the same failing read ran twice");
  assert.doesNotMatch(seenAfterRepeat, /you already ran/, "the repeat note never enters the model's context");
  assert.match(await waitForTrace(session, /you already ran/, "the repeat note"), /warden/, "the trace file holds the repeat notice");
  assert.doesNotMatch(customMessages(session), /you already ran/, "the session records no warden custom message");
});

test("/warden init in a real session injects its prompt, waits for the agent, and reports the file created", async () => {
  nextAnswers = { irreversible: 0.1, off_task: 0.1, scope: "expected_step", should_proceed: 1.0 };
  const record: Recorded = { bashRan: false, bashCommand: undefined, readCalls: 0, written: [] };
  const { session, dir } = await runSession([
    // The injected prompt reaches the model (this factory runs only for the init prompt).
    (context: { messages: unknown[] }) => {
      assert.ok(JSON.stringify(context.messages).includes("pi-warden.md"), "the model's request carries the init prompt");
      return faux.fauxAssistantMessage(faux.fauxToolCall("write", { path: "pi-warden.md", content: "# Project rules\nWrite real tests.\n" }));
    },
    // One request after the tool call is enough: the file exists, the run loop has no reason to continue,
    // and the command's status message should land only after this run ended.
    () => faux.fauxAssistantMessage("Done."),
  ], record);
  await session.prompt("/warden init");
  assert.deepEqual(record.written, [join(dir, "pi-warden.md")], "the agent ran the init task and called write");
  assert.ok(existsSync(join(dir, "pi-warden.md")), "the rules file exists after the run");
  assert.match(await waitForTrace(session, /pi-warden\.md created/, "the init report"), /headless warning/, "the command reported the file created through the trace, after the run ended");
  assert.doesNotMatch(customMessages(session), /pi-warden\.md created/, "the report is not a custom message in the session");
});

/** The trial records of a session, in order. */
function trialEntries(session: { sessionManager: AgentSessionManager }): Array<Record<string, unknown>> {
  return session.sessionManager.getBranch()
    .filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === "pi-warden-trial")
    .map(entry => (entry as { data?: unknown }).data as Record<string, unknown>);
}

/** The first session id that lands in the wanted trial arm. */
function idFor(arm: "live" | "silent"): string {
  for (let index = 0; index < 5000; index++) {
    const id = `session-arm-${arm}-${index}`;
    if (armFor(id) === arm) return id;
  }
  throw new Error(`no id landed in the ${arm} arm`);
}

test("with the silent-half setting on, one arm records the arm and withholds the done-check steer", async () => {
  const path = join(agentDir, "pi-warden", "config.json");
  const previous = readFileSync(path, "utf8");
  const reply = [
    faux.fauxAssistantMessage(faux.fauxToolCall("write", { path: "note.txt", content: "hello" })),
    faux.fauxAssistantMessage("Done."),
    faux.fauxAssistantMessage("Understood."),
  ];
  try {
    await writeFile(path, JSON.stringify({ ...JSON.parse(previous) as Record<string, unknown>, trial: { silentHalf: true } }));
    nextAnswers = { irreversible: 0.1, off_task: 0.1, scope: "expected_step", should_proceed: 1.0, claims_done: 0.95, claims_verified: 0.1, verification_applies: 0.95, outcome: "complete" };
    for (const arm of ["silent", "live"] as const) {
      const record: Recorded = { bashRan: false, bashCommand: undefined, readCalls: 0, written: [] };
      const { session } = await runSession([...reply], record, { sessionId: idFor(arm) });
      await session.prompt("add a note");
      const entries = trialEntries(session);
      assert.equal(entries[0]?.record, "arm", `${arm}: the session log carries the arm entry`);
      assert.equal(entries[0]?.arm, arm, `${arm}: the entry names the arm the id hashes to`);
      const suppressed = entries.slice(1).filter(entry => entry.record === "suppressed");
      if (arm === "silent") {
        assert.ok(suppressed.some(entry => entry.kind === "done"), "the suppressed done-check steer is recorded with its kind");
        assert.doesNotMatch(await traceText(session), /"guards: done"/, "the silent arm writes no notice entry");
        assert.doesNotMatch(customMessages(session), /no test, build, or lint run/, "no arm puts the notice in a custom message");
      } else {
        assert.deepEqual(suppressed, [], "the live arm suppresses nothing");
        assert.match(await waitForTrace(session, /"guards: done"/, "the live arm's done-check notice"), /warden · done-check/, "the live arm reports the done-check notice on the trace");
        assert.doesNotMatch(customMessages(session), /no test, build, or lint run/, "no arm puts the notice in a custom message");
      }
    }
  } finally {
    await writeFile(path, previous);
  }
});
