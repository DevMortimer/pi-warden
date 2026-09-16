import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Extension, RegisteredCommand } from "@earendil-works/pi-coding-agent";

let temporary: string;
let extension: Extension;
let command: RegisteredCommand;
const savedKey = process.env.TYPESAFE_API_KEY;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedEnabled = process.env.PI_WARDEN_ENABLED;
const savedHeadless = process.env.PI_WARDEN_HEADLESS;
const originalFetch = globalThis.fetch;

const notices: Array<{ text: string; level: string }> = [];
const widgets: Array<string[] | undefined> = [];
const confirms: Array<{ title: string; message: string }> = [];
let confirmResult = true;
let editorText: string | undefined;
let networkCalls = 0;
let nextAnswers = { irreversible: 0.1, off_task: 0.1, scope: "expected_step" };
let failNetwork = false;
let prompt: string | undefined = "Run the test suite";

const ui = {
  notify: (text: string, level = "info") => { notices.push({ text, level }); },
  confirm: async (title: string, message: string) => { confirms.push({ title, message }); return confirmResult; },
  editor: async () => editorText,
  setWidget: (_id: string, lines: string[] | undefined) => { widgets.push(lines); },
  custom: async () => { keyPrompts++; return keyInput; },
  input: async () => { throw new Error("input must not be used"); },
};
let keyPrompts = 0;
let keyInput: string | undefined;
let modelListCalls = 0;
const sessionManager = {
  getBranch: () => prompt === undefined ? [] : [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } },
    { type: "message", message: { role: "user", content: prompt } },
    { type: "message", message: { role: "assistant", content: [] } },
  ],
};
const context = (overrides: Record<string, unknown> = {}) => ({
  hasUI: true, ui, cwd: temporary, sessionManager, signal: undefined, isProjectTrusted: () => true, ...overrides,
});
const toolCall = (toolName: string, input: Record<string, unknown>, ctx = context()) => {
  const handlers = extension.handlers.get("tool_call") ?? [];
  assert.equal(handlers.length, 1);
  return Reflect.apply(handlers[0]!, undefined, [{ type: "tool_call", toolName, toolCallId: "call-1", input }, ctx]) as Promise<{ block?: boolean; reason?: string } | undefined>;
};
const sessionStart = (ctx = context()) => Reflect.apply((extension.handlers.get("session_start") ?? [])[0]!, undefined, [{ type: "session_start" }, ctx]);
const runCommand = (args: string, ctx = context()) => Reflect.apply(command.handler, command, [args, ctx]);
const configPath = () => join(temporary, "agent", "pi-warden", "config.json");
const grantConsent = () => writeFile(configPath(), JSON.stringify({ typesafe: true }));

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-warden-ext-"));
  await mkdir(join(temporary, "agent", "pi-warden"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(temporary, "agent");
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  delete process.env.PI_WARDEN_ENABLED;
  delete process.env.PI_WARDEN_HEADLESS;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/v1/models")) {
      modelListCalls++;
      return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }] });
    }
    networkCalls++;
    if (failNetwork) return new Response("upstream body must not leak", { status: 503 });
    return Response.json({
      model: "jev-test",
      answers: {
        irreversible: { type: "noul", noul: nextAnswers.irreversible },
        off_task: { type: "noul", noul: nextAnswers.off_task },
        scope: { type: "choice", choice: nextAnswers.scope, confidence: 0.8, probabilities: { expected_step: 0, plausible_side_step: 0, unrelated: 0, unclear: 0, [nextAnswers.scope]: 0.8 } },
      },
      usage: { input_tokens: 50, output_tokens: 0 },
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: temporary,
    agentDir: join(temporary, "agent"),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve("src/extension.ts")],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], "native Pi loader must accept the extension");
  const loaded = result.extensions[0];
  assert.ok(loaded);
  extension = loaded;
  const registered = extension.commands.get("warden");
  assert.ok(registered);
  command = registered;
  assert.equal(extension.tools.size, 0, "pi-warden registers no agent tools");
});

beforeEach(async () => {
  notices.length = 0; widgets.length = 0; confirms.length = 0;
  confirmResult = true; editorText = undefined; networkCalls = 0; failNetwork = false; prompt = "Run the test suite";
  keyPrompts = 0; keyInput = undefined; modelListCalls = 0;
  await rm(join(temporary, "agent", "pi-typesafe"), { recursive: true, force: true });
  nextAnswers = { irreversible: 0.1, off_task: 0.1, scope: "expected_step" };
  await rm(configPath(), { force: true });
  await sessionStart();
  widgets.length = 0;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedEnabled === undefined) delete process.env.PI_WARDEN_ENABLED; else process.env.PI_WARDEN_ENABLED = savedEnabled;
  if (savedHeadless === undefined) delete process.env.PI_WARDEN_HEADLESS; else process.env.PI_WARDEN_HEADLESS = savedHeadless;
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("read-only tools and read-only shell commands pass without network or dialogs", async () => {
  assert.equal(await toolCall("read", { path: "/etc/hosts" }), undefined);
  assert.equal(await toolCall("bash", { command: "git status && ls" }), undefined);
  assert.equal(networkCalls, 0);
  assert.equal(confirms.length, 0);
  assert.equal(widgets.length, 0, "read-only calls do not update the widget");
});

test("without consent, only pattern checks run: risky warns, destructive asks", async () => {
  assert.equal(await toolCall("bash", { command: "rm -rf dist" }), undefined);
  assert.equal(networkCalls, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /rm -rf on a project path/);
  assert.equal(notices[0]!.level, "warning");

  const allowed = await toolCall("bash", { command: "git push --force origin main" });
  assert.equal(allowed, undefined);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0]!.title, /allow this bash call/);
  assert.match(confirms[0]!.message, /git push --force origin main/);
  assert.match(confirms[0]!.message, /destructive: git force push/);

  confirmResult = false;
  const blocked = await toolCall("bash", { command: "git push --force origin main" });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /user declined/);
  assert.ok(!blocked?.reason?.includes("origin main"), "the block reason does not echo the command");
  assert.equal(networkCalls, 0);
});

test("with consent, Jev judgments drive warn and confirm, and the widget shows scores", async () => {
  await grantConsent();
  nextAnswers = { irreversible: 0.2, off_task: 0.1, scope: "expected_step" };
  assert.equal(await toolCall("bash", { command: "npm test" }), undefined);
  assert.equal(networkCalls, 1);
  assert.equal(confirms.length, 0);
  assert.deepEqual(widgets.at(-1), ["warden · bash · irreversible 0.20 · off-task 0.10 · expected step · allow"]);

  nextAnswers = { irreversible: 0.92, off_task: 0.3, scope: "plausible_side_step" };
  confirmResult = false;
  const blocked = await toolCall("bash", { command: "npm run db:reset" });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /irreversible 0\.92/);
  assert.match(confirms[0]!.message, /Jev: irreversible 0\.92/);
  assert.equal(networkCalls, 2);

  nextAnswers = { irreversible: 0.1, off_task: 0.95, scope: "unrelated" };
  confirmResult = true;
  await toolCall("write", { path: join(temporary, "poem.txt"), content: "roses" });
  assert.equal(confirms.length, 2);
  assert.match(confirms[1]!.message, /off-task 0\.95 \(unrelated to the request\)/);
  assert.match(confirms[1]!.message, /write poem\.txt \(new file\)/);
});

test("the request carries the latest user prompt and a redacted action summary", async () => {
  await grantConsent();
  let body: { state: { task: string; action: Record<string, unknown> }; questions: Record<string, unknown> } | undefined;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    body = JSON.parse(String(init?.body));
    return inner(input, init);
  };
  try {
    prompt = "Deploy the thing with TOKEN=sk-live-abcdefghijklmnop please";
    await toolCall("bash", { command: "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example/deploy" });
  } finally {
    globalThis.fetch = inner;
  }
  assert.ok(body);
  assert.equal(body.state.task, prompt, "the task is sent as the user wrote it; redaction covers the action");
  assert.deepEqual(Object.keys(body.questions).sort(), ["irreversible", "off_task", "scope"]);
  assert.equal(body.state.action.tool, "bash");
  assert.ok(!String(body.state.action.command).includes("abc.def.ghi"));
  assert.ok(String(body.state.action.command).includes("[redacted]"));
});

test("TypeSafe failures fail open with a warning and never leak the upstream body", async () => {
  await grantConsent();
  failNetwork = true;
  assert.equal(await toolCall("bash", { command: "npm test" }), undefined);
  assert.equal(confirms.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /^warden: /);
  assert.ok(!notices[0]!.text.includes("upstream body"), "upstream error bodies stay out of the UI");
  assert.deepEqual(widgets.at(-1), ["warden · bash · typesafe error · allow"]);
});

test("PI_WARDEN_ENABLED=1 grants consent for headless runs and headless confirms block by default", async () => {
  process.env.PI_WARDEN_ENABLED = "1";
  try {
    nextAnswers = { irreversible: 0.9, off_task: 0.1, scope: "expected_step" };
    const blocked = await toolCall("bash", { command: "npm run db:reset" }, context({ hasUI: false }));
    assert.equal(networkCalls, 1);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /no user is present/);
    assert.equal(confirms.length, 0);

    process.env.PI_WARDEN_HEADLESS = "allow";
    assert.equal(await toolCall("bash", { command: "npm run db:reset" }, context({ hasUI: false })), undefined);
  } finally {
    delete process.env.PI_WARDEN_ENABLED;
    delete process.env.PI_WARDEN_HEADLESS;
  }
});

test("a trusted project file can tune thresholds but an untrusted one is ignored", async () => {
  await grantConsent();
  await mkdir(join(temporary, ".pi"), { recursive: true });
  await writeFile(join(temporary, ".pi", "pi-warden.json"), JSON.stringify({ action: { irreversible: { warn: 0.1, confirm: 0.2 } } }));
  try {
    nextAnswers = { irreversible: 0.3, off_task: 0.1, scope: "expected_step" };
    await toolCall("bash", { command: "npm test" });
    assert.equal(confirms.length, 1, "project thresholds apply when trusted");
    await toolCall("bash", { command: "npm test" }, context({ isProjectTrusted: () => false }));
    assert.equal(confirms.length, 1, "untrusted project thresholds are ignored");
  } finally {
    await rm(join(temporary, ".pi"), { recursive: true, force: true });
  }
});

test("/warden status, enable, disable, and test report and persist consent", async () => {
  await runCommand("status");
  assert.match(notices[0]!.text, /TypeSafe judgments disabled \(run \/warden enable\)/);
  assert.match(notices[0]!.text, /key from TYPESAFE_API_KEY/);

  confirmResult = false;
  await runCommand("enable");
  assert.equal(confirms.length, 1);
  assert.match(confirms[0]!.message, /api\.typesafe\.ai/);
  await assert.rejects(readFile(configPath()), "declining the disclosure saves nothing");

  confirmResult = true;
  await runCommand("enable");
  assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), { typesafe: true });
  assert.match(notices.at(-1)!.text, /enabled and saved/);

  await runCommand("test");
  assert.equal(confirms.length, 4, "test asks before spending a request, then shows the demo dialog");
  assert.equal(networkCalls, 1);
  assert.match(notices.at(-2)!.text, /^warden · bash · irreversible/);
  assert.match(notices.at(-2)!.text, /rm-recursive-dangerous-target/);
  assert.match(confirms.at(-1)!.title, /\(demo\)/);
  assert.match(confirms.at(-1)!.message, /rm -rf \/tmp\/pi-warden-demo[\s\S]*nothing runs either way/);
  assert.match(notices.at(-1)!.text, /Demo: you chose Yes/);

  await runCommand("disable");
  assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), { typesafe: false });
  confirmResult = false;
  await runCommand("test");
  assert.equal(networkCalls, 1, "disabled: no request");
  assert.match(notices.at(-2)!.text, /pattern checks only/);
  assert.match(notices.at(-1)!.text, /Demo: you chose No/);

  await runCommand("bogus");
  assert.match(notices.at(-1)!.text, /Unknown action/);
});

test("/warden enable with an existing key does not prompt for one", async () => {
  await runCommand("enable");
  assert.equal(keyPrompts, 0);
  assert.match(notices.at(-1)!.text, /using the key from TYPESAFE_API_KEY/);
  assert.match(notices.at(-1)!.text, /stays on in new sessions/);
});

test("/warden enable without a key asks for one after consent, verifies it, stores it, and then judges with it", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const storedKeyPath = join(temporary, "agent", "pi-typesafe", "auth.json");
  try {
    keyInput = undefined;
    await runCommand("enable");
    assert.equal(confirms.length, 1, "disclosure comes first");
    assert.equal(keyPrompts, 1);
    assert.match(notices.at(-1)!.text, /No key entered/);
    await assert.rejects(readFile(configPath()), "consent is not saved without a key");

    keyInput = "nope";
    await runCommand("enable");
    assert.match(notices.at(-1)!.text, /does not look like a TypeSafe API key/);
    assert.ok(!notices.at(-1)!.text.includes("nope"));
    assert.equal(modelListCalls, 0);

    keyInput = "ts_live_key_0123456789abcdef";
    await runCommand("enable");
    assert.equal(modelListCalls, 1);
    assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), { typesafe: true });
    assert.deepEqual(JSON.parse(await readFile(storedKeyPath, "utf8")), { apiKey: keyInput });
    assert.match(notices.at(-1)!.text, /key verified \(1 model\) and stored at/);
    assert.ok(notices.every(notice => !notice.text.includes("ts_live_key")), "the key is never echoed");

    nextAnswers = { irreversible: 0.2, off_task: 0.1, scope: "expected_step" };
    await toolCall("bash", { command: "npm test" });
    assert.equal(networkCalls, 1, "the stored key powers judgments in the same session");

    await runCommand("status");
    assert.match(notices.at(-1)!.text, /enabled via \/warden enable; key stored \(shared with pi-typesafe\)/);
  } finally {
    process.env.TYPESAFE_API_KEY = "offline-test-key";
  }
});

test("/warden config validates JSON and saves the user file", async () => {
  editorText = "{ nope";
  await runCommand("config");
  assert.match(notices.at(-1)!.text, /Invalid JSON/);
  await assert.rejects(readFile(configPath()));

  editorText = JSON.stringify({ typesafe: true, action: { tools: ["bash"], irreversible: { warn: 0.4, confirm: 0.6 } } });
  await runCommand("config");
  assert.match(notices.at(-1)!.text, /tools bash, irreversible confirm ≥ 0\.6/);
  const saved = JSON.parse(await readFile(configPath(), "utf8"));
  assert.equal(saved.typesafe, true);

  nextAnswers = { irreversible: 0.65, off_task: 0.1, scope: "expected_step" };
  await toolCall("bash", { command: "npm test" });
  assert.equal(confirms.length, 1, "new thresholds apply immediately");
  assert.equal(await toolCall("write", { path: join(temporary, "a.txt"), content: "x" }), undefined);
  assert.equal(networkCalls, 1, "write is no longer a guarded tool");
});
