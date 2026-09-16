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
const savedMode = process.env.PI_WARDEN_MODE;
const originalFetch = globalThis.fetch;

const notices: Array<{ text: string; level: string }> = [];
const widgets: Array<string[] | undefined> = [];
const confirms: Array<{ title: string; message: string }> = [];
let confirmResult = true;
let editorText: string | undefined;
let networkCalls = 0;
let nextAnswers: Record<string, number | string> = { irreversible: 0.1, off_task: 0.1, scope: "expected_step" };
let failNetwork = false;
const sentMessages: Array<{ message: { customType: string; content: string }; options?: Record<string, unknown> }> = [];
const requests: Array<{ state: Record<string, unknown>; questions: Record<string, { type: string }> }> = [];
let prompt: string | undefined = "Run the test suite";

const ui = {
  notify: (text: string, level = "info") => { notices.push({ text, level }); },
  confirm: async (title: string, message: string) => { confirms.push({ title, message }); return confirmResult; },
  editor: async () => editorText,
  setWidget: (_id: string, content: string[] | ((tui: unknown, theme: unknown) => { render(width: number): string[]; handleMouse?(event: unknown): unknown }) | undefined, options?: { placement?: string }) => {
    if (typeof content === "function") {
      widgetComponent = content({ requestRender() {} }, fakeTheme);
      widgets.push(widgetComponent.render(400).map(line => line.trimEnd()).filter(Boolean));
    } else {
      widgetComponent = undefined;
      widgets.push(content);
    }
    widgetPlacement = options?.placement;
  },
  custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown, options?: Record<string, unknown>) => {
    customCalls.push({ options });
    if (!options?.overlay) { keyPrompts++; return keyInput; }
    // Overlay: build the panel, drive it like the TUI would, and resolve when it closes itself.
    return new Promise(resolve => {
      const panel = factory({ requestRender() { renders++; }, terminal: { rows: 40 } }, fakeTheme, {}, resolve) as { render(width: number): string[]; handleInput(data: string): void; dispose?(): void };
      openPanels.push(panel);
    });
  },
  input: async () => { throw new Error("input must not be used"); },
};
let keyPrompts = 0;
let keyInput: string | undefined;
let modelListCalls = 0;
const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
let widgetComponent: { render(width: number): string[]; handleMouse?(event: unknown): unknown } | undefined;
let widgetPlacement: string | undefined;
const customCalls: Array<{ options?: Record<string, unknown> | undefined }> = [];
const openPanels: Array<{ render(width: number): string[]; handleInput(data: string): void; dispose?(): void }> = [];
let renders = 0;
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
const fire = (type: string, event: Record<string, unknown>, ctx = context()) => {
  const handlers = extension.handlers.get(type) ?? [];
  assert.equal(handlers.length, 1, `one ${type} handler`);
  return Reflect.apply(handlers[0]!, undefined, [{ type, ...event }, ctx]) as Promise<unknown>;
};
const sessionStart = (ctx = context()) => fire("session_start", {}, ctx);
const toolResult = (toolName: string, input: Record<string, unknown>, output: string, failed: boolean, ctx = context()) =>
  fire("tool_result", { toolName, toolCallId: "call-1", input, content: [{ type: "text", text: output }], isError: failed, details: toolName === "bash" ? { exitCode: failed ? 1 : 0 } : undefined }, ctx);
const agentEnd = (finalText: string, ctx = context()) => fire("agent_end", { messages: [{ role: "user", content: prompt ?? "" }, { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop" }] }, ctx);
const newPrompt = (text: string, ctx = context()) => { prompt = text; return fire("before_agent_start", { prompt: text }, ctx).then(() => fire("agent_start", {}, ctx)); };
const runCommand = (args: string, ctx = context()) => Reflect.apply(command.handler, command, [args, ctx]);
const configPath = () => join(temporary, "agent", "pi-warden", "config.json");
const grantConsent = () => writeFile(configPath(), JSON.stringify({ typesafe: true }));

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-warden-ext-"));
  await mkdir(join(temporary, "agent", "pi-warden"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(temporary, "agent");
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  delete process.env.PI_WARDEN_ENABLED;
  delete process.env.PI_WARDEN_MODE;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/v1/models")) {
      modelListCalls++;
      return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }] });
    }
    networkCalls++;
    if (failNetwork) return new Response("upstream body must not leak", { status: 503 });
    const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: unknown }> };
    requests.push(body);
    // Answer every asked question from nextAnswers so slop, approval, stuck, and done requests all work with one mock.
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const value = nextAnswers[id];
      if (question.type === "noul") answers[id] = { type: "noul", noul: typeof value === "number" ? value : 0.1 };
      else if (question.type === "choice") {
        const keys = Object.keys(question.criteria as Record<string, unknown>);
        const pick = typeof value === "string" ? value : keys[0]!;
        answers[id] = { type: "choice", choice: pick, confidence: 0.8, probabilities: Object.fromEntries(keys.map(key => [key, key === pick ? 0.8 : 0.2 / (keys.length - 1)])) };
      } else {
        const levels = (question.criteria as unknown[]).length;
        const scoreValue = typeof value === "number" ? value : 0;
        answers[id] = { type: "score", score: scoreValue, confidence: 0.8, legend: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), `level ${index}`])), probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === Math.round(scoreValue) ? 0.8 : 0.2 / (levels - 1)])) };
      }
    }
    return Response.json({ model: "jev-test", answers, usage: { input_tokens: 50, output_tokens: 0 } });
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
  // The runtime's action methods throw until Pi's runner binds them; capture steer messages instead.
  result.runtime.sendMessage = (message, options) => { sentMessages.push({ message: message as { customType: string; content: string }, ...(options ? { options: options as Record<string, unknown> } : {}) }); };
});

beforeEach(async () => {
  notices.length = 0; widgets.length = 0; confirms.length = 0;
  confirmResult = true; editorText = undefined; networkCalls = 0; failNetwork = false; prompt = "Run the test suite";
  keyPrompts = 0; keyInput = undefined; modelListCalls = 0; sentMessages.length = 0; requests.length = 0;
  widgetComponent = undefined; widgetPlacement = undefined; customCalls.length = 0; openPanels.length = 0; renders = 0;
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
  if (savedMode === undefined) delete process.env.PI_WARDEN_MODE; else process.env.PI_WARDEN_MODE = savedMode;
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("read-only tools and read-only shell commands pass without network or dialogs", async () => {
  assert.equal(await toolCall("read", { path: "/etc/hosts" }), undefined);
  assert.equal(await toolCall("bash", { command: "git status && ls" }), undefined);
  assert.equal(networkCalls, 0);
  assert.equal(confirms.length, 0);
  assert.equal(widgets.length, 0, "read-only calls do not update the widget");
});

test("without consent, only pattern checks run: risky warns, destructive is held with a steer reason", async () => {
  assert.equal(await toolCall("bash", { command: "rm -rf dist" }), undefined);
  assert.equal(networkCalls, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /rm -rf on a project path/);
  assert.equal(notices[0]!.level, "warning");

  const held = await toolCall("bash", { command: "git push --force origin main" });
  assert.equal(held?.block, true, "steer mode holds without a dialog");
  assert.equal(confirms.length, 0);
  assert.match(held?.reason ?? "", /^pi-warden held this bash call before it ran: destructive: git force push\./);
  assert.match(held?.reason ?? "", /Do not retry it unchanged/);
  assert.match(held?.reason ?? "", /once the user has replied with approval/);
  assert.ok(!held?.reason?.includes("origin main"), "the reason does not echo the command");
  assert.match(notices.at(-1)!.text, /held bash: destructive: git force push/);
  assert.equal(networkCalls, 0);
});

test("a held call retried after an approving reply is allowed; without a reply or approval it stays held", async () => {
  prompt = "push my branch";
  assert.equal((await toolCall("bash", { command: "git push --force" }))?.block, true);
  assert.equal((await toolCall("bash", { command: "git push --force" }))?.block, true, "same prompt: the user has not replied");
  prompt = "hmm, why is that needed?";
  assert.equal((await toolCall("bash", { command: "git push --force" }))?.block, true, "a question is not approval");
  prompt = "yes, go ahead and force push";
  assert.equal(await toolCall("bash", { command: "git push --force" }), undefined, "offline approval heuristic");
  assert.match(widgets.at(-1)![0]!, /user approved · allow$/);
  prompt = "push my branch";
  assert.equal((await toolCall("bash", { command: "git push --force" }))?.block, true, "approval is consumed; a new hold starts");

  await grantConsent();
  prompt = "yes do it";
  nextAnswers = { irreversible: 0.9, off_task: 0.1, scope: "expected_step", approved: 0.2 };
  assert.equal((await toolCall("bash", { command: "git push --force" }))?.block, true, "Jev decides on retry: 0.2 is not approval");
  assert.ok("approved" in requests.at(-1)!.questions, "the approval question was asked");
  assert.equal((await toolCall("bash", { command: "git push --force" }))?.block, true, "no new reply: not asked again");
  assert.ok(!("approved" in requests.at(-1)!.questions));
  prompt = "YES. Force push it now, I own that branch.";
  nextAnswers = { irreversible: 0.9, off_task: 0.1, scope: "expected_step", approved: 0.95 };
  assert.equal(await toolCall("bash", { command: "git push --force" }), undefined);
  assert.match(widgets.at(-1)![0]!, /user approved/);
});

test("mode confirm shows a dialog; mode advise only reports; PI_WARDEN_MODE overrides the file", async () => {
  await writeFile(configPath(), JSON.stringify({ mode: "confirm" }));
  const allowed = await toolCall("bash", { command: "git push --force origin main" });
  assert.equal(allowed, undefined);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0]!.title, /allow this bash call/);
  assert.match(confirms[0]!.message, /git push --force origin main/);
  confirmResult = false;
  const declined = await toolCall("bash", { command: "git push --force origin main" });
  assert.equal(declined?.block, true);
  assert.match(declined?.reason ?? "", /user declined/);

  const headless = await toolCall("bash", { command: "git push --force origin main" }, context({ hasUI: false }));
  assert.equal(headless?.block, true, "confirm without a UI falls back to steer");
  assert.match(headless?.reason ?? "", /pi-warden held/);
  assert.equal(confirms.length, 2);

  process.env.PI_WARDEN_MODE = "advise";
  try {
    assert.equal(await toolCall("bash", { command: "git push --force origin main" }), undefined, "advise never holds");
    assert.match(notices.at(-1)!.text, /advise mode, not held/);
  } finally {
    delete process.env.PI_WARDEN_MODE;
  }
});

test("with consent, Jev judgments drive warn and hold, and the widget shows scores", async () => {
  await grantConsent();
  nextAnswers = { irreversible: 0.2, off_task: 0.1, scope: "expected_step" };
  assert.equal(await toolCall("bash", { command: "npm test" }), undefined);
  assert.equal(networkCalls, 1);
  assert.deepEqual(widgets.at(-1), ["warden · bash · irreversible 0.20 · off-task 0.10 · expected step · allow"]);

  nextAnswers = { irreversible: 0.92, off_task: 0.3, scope: "plausible_side_step" };
  const held = await toolCall("bash", { command: "npm run db:reset" });
  assert.equal(held?.block, true);
  assert.match(held?.reason ?? "", /irreversible 0\.92/);
  assert.match(held?.reason ?? "", /retry the same call and pi-warden will let it through/);
  assert.equal(networkCalls, 2);

  nextAnswers = { irreversible: 0.1, off_task: 0.95, scope: "unrelated" };
  const offTask = await toolCall("write", { path: join(temporary, "poem.txt"), content: "roses" });
  assert.equal(offTask?.block, true);
  assert.match(offTask?.reason ?? "", /off-task 0\.95 \(unrelated to the request\)/);
});

test("slop symptoms steer the agent after the write without holding it; steers are hidden from the transcript by default and escalate on repeats", async () => {
  await grantConsent();
  nextAnswers = { irreversible: 0.05, off_task: 0.05, scope: "expected_step", slop_stub: 0.92, slop_hedging: 0.75, slop_comments: 0.1, slop_dead: 0.1 };
  assert.equal(await toolCall("write", { path: join(temporary, "src", "a.ts"), content: "// TODO: implement\nexport const a = () => null;" }), undefined);
  assert.deepEqual(Object.keys(requests.at(-1)!.questions).sort(), ["irreversible", "off_task", "scope", "slop_comments", "slop_dead", "slop_hedging", "slop_stub"]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]!.message.customType, "pi-warden-steer");
  assert.equal((sentMessages[0]!.message as { display?: boolean }).display, false, "hidden from the transcript by default");
  assert.match(sentMessages[0]!.message.content, /src\/a\.ts has stub or placeholder code where a working implementation is needed; hedging or vague notes\. Fix it in your next edit: replace stubs/);
  assert.deepEqual(sentMessages[0]!.options, { deliverAs: "steer" });
  assert.match(notices.at(-1)!.text, /warden · slop · src\/a\.ts/);
  assert.match(widgets.at(-1)![0]!, /slop: stub 0\.92, hedging 0\.75/);

  nextAnswers = { irreversible: 0.05, off_task: 0.05, scope: "expected_step", slop_stub: 0.1, slop_hedging: 0.1, slop_comments: 0.1, slop_dead: 0.1 };
  await toolCall("edit", { path: join(temporary, "src", "a.ts"), edits: [{ oldText: "a", newText: "b" }] });
  assert.equal(sentMessages.length, 1, "clean content: no steer");
  assert.match(widgets.at(-1)![0]!, /slop: none/);

  nextAnswers = { irreversible: 0.05, off_task: 0.05, scope: "expected_step", slop_stub: 0.9, slop_hedging: 0.1, slop_comments: 0.1, slop_dead: 0.1 };
  await toolCall("write", { path: join(temporary, "src", "b.ts"), content: "export const b = () => null; // TODO" });
  await toolCall("write", { path: join(temporary, "src", "c.ts"), content: "export const c = () => null; // TODO" });
  assert.equal(sentMessages.length, 3);
  assert.match(sentMessages[2]!.message.content, /\(3th time this session\)[\s\S]*standing rule/);

  await writeFile(configPath(), JSON.stringify({ typesafe: true, steerVisible: true }));
  await toolCall("write", { path: join(temporary, "src", "d.ts"), content: "export const d = () => null; // TODO" });
  assert.equal((sentMessages[3]!.message as { display?: boolean }).display, true);
});

test("prose: the final reply is scored against the audience and the agent is nudged for the next turn on a trend", async () => {
  await grantConsent();
  await newPrompt("explain the bug");
  nextAnswers = { wordy: 0.9, cliches: 0.95, jargon: 0.1 };
  const longReply = "Great question! Let me walk you through it. ".repeat(6);
  await agentEnd(longReply);
  assert.deepEqual(Object.keys(requests.at(-1)!.questions).sort(), ["cliches", "jargon", "wordy"]);
  assert.equal(requests.at(-1)!.state.audience, "a software developer who knows this codebase and its tools");
  assert.equal(sentMessages.length, 0, "one reply is not a trend");
  assert.match(widgets.at(-1)!.at(-1)!, /warden · prose · wordy 0\.90 · clichés 0\.95 · jargon 0\.10 · cliches, wordy$/, "strongest symptom first");

  await newPrompt("and the fix?");
  await agentEnd(longReply);
  assert.equal(sentMessages.length, 1, "two of the last three replies: nudge");
  assert.equal(sentMessages[0]!.options?.deliverAs, "nextTurn");
  assert.match(sentMessages[0]!.message.content, /longer than the content needs[\s\S]*assistant clichés[\s\S]*From the next reply on, lead with the answer/);
  assert.match(widgets.at(-1)!.at(-1)!, /nudged$/);
  assert.match(notices.at(-1)!.text, /warden · prose: wordy, cliches in 2 of the last 3 replies/);

  await newPrompt("ok");
  await agentEnd(longReply);
  assert.equal(sentMessages.length, 1, "cool-down after a nudge");
  await newPrompt("short one");
  await agentEnd("Short.");
  assert.equal(requests.filter(request => "wordy" in request.questions).length, 3, "replies under minChars are not judged");

  await writeFile(configPath(), JSON.stringify({ typesafe: true, slop: { prose: { audience: "plain" } } }));
  await newPrompt("status?");
  nextAnswers = { wordy: 0.1, cliches: 0.1, jargon: 0.95 };
  await agentEnd("The webhook handler lacked HMAC verification so the ORM upsert raced the mutex. ".repeat(3));
  assert.equal(requests.at(-1)!.state.audience, "a non-programmer who owns the product and reads the reply as a status update");
});

test("stuck detection: exact repeats are caught offline, varied failures ask Jev, and the agent is nudged once per cool-down", async () => {
  await newPrompt("make the tests pass");
  await toolResult("bash", { command: "npm test" }, "1 failing", true);
  await toolResult("bash", { command: "npm test" }, "1 failing", true);
  assert.equal(sentMessages.length, 0);
  await toolResult("bash", { command: "npm test" }, "1 failing", true);
  assert.equal(networkCalls, 0, "exact repeats need no network");
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]!.message.content, /the same call failed 3 times with the same output\. Stop retrying/);
  assert.match(widgets.at(-1)!.at(-1)!, /warden · stuck · 3 failures · exact repeat · stuck/);
  assert.match(notices.at(-1)!.text, /warden · stuck: .* \(agent nudged\)/);

  await newPrompt("make the tests pass, try harder");
  await grantConsent();
  nextAnswers = { same_strategy: 0.9, approach_change: 1, progress: 0.1 };
  await toolResult("bash", { command: "npm test" }, "1 failing: parser", true);
  await toolResult("bash", { command: "npm test -- --verbose" }, "1 failing: parser", true);
  await toolResult("bash", { command: "npx jest tests/parser.test.ts" }, "1 failing: parser", true);
  assert.equal(networkCalls, 1);
  const request = requests.at(-1)!;
  assert.deepEqual(Object.keys(request.questions).sort(), ["approach_change", "progress", "same_strategy"]);
  assert.equal(request.state.task, "make the tests pass, try harder");
  assert.equal((request.state.attempts as unknown[]).length, 3);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1]!.message.content, /3 failures with the same strategy \(0\.90\)/);

  await toolResult("bash", { command: "npm test -- tests/parser.test.ts" }, "1 failing", true);
  assert.equal(networkCalls, 1, "cool-down: no new check after one more result");
  nextAnswers = { same_strategy: 0.2, approach_change: 2, progress: 0.8 };
  await toolResult("bash", { command: "cat src/parser.ts" }, "…", false);
  await toolResult("bash", { command: "npm test" }, "1 failing", true);
  assert.equal(networkCalls, 2, "cool-down over and the latest result failed");
  assert.equal(sentMessages.length, 2, "Jev says the approach changed: no nudge");

  await newPrompt("something else");
  await toolResult("bash", { command: "npm test" }, "1 failing", true);
  assert.equal(networkCalls, 2, "a new prompt resets the window");
});

test("done-check: an unverified completion claim after file changes gets one follow-up per prompt", async () => {
  await grantConsent();
  await newPrompt("fix the parser bug");
  await agentEnd("I looked at the code; the bug is in parse().");
  assert.equal(networkCalls, 0, "no changes yet: nothing to verify");

  await toolResult("edit", { path: "src/parser.ts", edits: [] }, "ok", false);
  await toolResult("bash", { command: "git status" }, "…", false);
  nextAnswers = { claims_done: 0.92, claims_verified: 0.1, verification_applies: 0.9, outcome: "complete" };
  await agentEnd("Fixed the parser bug in src/parser.ts.");
  assert.equal(networkCalls, 1);
  const request = requests.at(-1)!;
  assert.deepEqual(Object.keys(request.questions).sort(), ["claims_done", "claims_verified", "outcome", "verification_applies"]);
  assert.deepEqual(request.state.run, { file_changes: 1, checks_run: [] });
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]!.message.content, /reports completion \(0\.92\) after 1 file change with no test, build, or lint run/);
  assert.deepEqual(sentMessages[0]!.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(widgets.at(-1)!.at(-1)!, /warden · done-check · 1 changes · 0\/0 checks passed · claims done 0\.92 .* unverified/);

  await fire("agent_start", {});
  await toolResult("edit", { path: "src/parser.ts", edits: [] }, "ok", false);
  await agentEnd("Done now.");
  assert.equal(networkCalls, 1, "at most one nudge per user prompt");

  await newPrompt("and the formatter");
  await toolResult("edit", { path: "src/format.ts", edits: [] }, "ok", false);
  await toolResult("bash", { command: "npm test" }, "31 passing", false);
  await agentEnd("Formatter updated; tests pass.");
  assert.equal(networkCalls, 1, "a passing check means no done-check request");

  await newPrompt("and the linter");
  await toolResult("edit", { path: "src/lint.ts", edits: [] }, "ok", false);
  await toolResult("bash", { command: "npm test" }, "1 failing", true);
  nextAnswers = { claims_done: 0.85, claims_verified: 0.8, verification_applies: 0.9, outcome: "complete" };
  await agentEnd("All done and tests pass.");
  assert.equal(networkCalls, 2);
  assert.match(sentMessages.at(-1)!.message.content, /1 failed check and no passing one\. The last check that ran failed: npm test/);

  await newPrompt("and docs");
  await toolResult("edit", { path: "README.md", edits: [] }, "ok", false);
  nextAnswers = { claims_done: 0.9, claims_verified: 0.1, verification_applies: 0.9, outcome: "blocked" };
  await agentEnd("I updated the README; do you also want the changelog touched?");
  assert.equal(networkCalls, 3);
  assert.equal(sentMessages.length, 2, "a question to the user is not an unverified claim");

  await newPrompt("delete the scratch files");
  await toolResult("bash", { command: "rm -rf /tmp/scratch" }, "", false);
  await agentEnd("Deleted /tmp/scratch.");
  assert.equal(networkCalls, 3, "shell side effects alone are not code changes");
});

test("the request carries the latest user prompt and a redacted action summary", async () => {
  await grantConsent();
  prompt = "Deploy the thing with TOKEN=sk-live-abcdefghijklmnop please";
  await toolCall("bash", { command: "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example/deploy" });
  const body = requests.at(-1) as { state: { task: string; action: Record<string, unknown> }; questions: Record<string, unknown> } | undefined;
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

test("PI_WARDEN_ENABLED=1 grants consent for headless runs", async () => {
  process.env.PI_WARDEN_ENABLED = "1";
  try {
    nextAnswers = { irreversible: 0.9, off_task: 0.1, scope: "expected_step" };
    const held = await toolCall("bash", { command: "npm run db:reset" }, context({ hasUI: false }));
    assert.equal(networkCalls, 1);
    assert.equal(held?.block, true);
    assert.match(held?.reason ?? "", /pi-warden held this bash call/);
    assert.equal(confirms.length, 0);
  } finally {
    delete process.env.PI_WARDEN_ENABLED;
  }
});

test("a trusted project file can tune thresholds but an untrusted one is ignored", async () => {
  await grantConsent();
  await mkdir(join(temporary, ".pi"), { recursive: true });
  await writeFile(join(temporary, ".pi", "pi-warden.json"), JSON.stringify({ action: { irreversible: { warn: 0.1, confirm: 0.2 } } }));
  try {
    nextAnswers = { irreversible: 0.3, off_task: 0.1, scope: "expected_step" };
    assert.equal((await toolCall("bash", { command: "npm test" }))?.block, true, "project thresholds apply when trusted");
    assert.equal(await toolCall("bash", { command: "npm test" }, context({ isProjectTrusted: () => false })), undefined, "untrusted project thresholds are ignored");
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
  assert.equal(confirms.length, 3, "test asks before spending a request; steer mode explains instead of a demo dialog");
  assert.equal(networkCalls, 1);
  assert.match(notices.at(-2)!.text, /^warden · bash · irreversible/);
  assert.match(notices.at(-2)!.text, /rm-recursive-dangerous-target/);
  assert.match(notices.at(-1)!.text, /In steer mode a real call would be held and the agent would read: "pi-warden held this bash call/);

  await runCommand("mode confirm");
  assert.match(notices.at(-1)!.text, /Mode set to confirm/);
  await runCommand("test");
  assert.match(confirms.at(-1)!.title, /\(demo\)/);
  assert.match(confirms.at(-1)!.message, /rm -rf \/tmp\/pi-warden-demo[\s\S]*nothing runs either way/);
  assert.match(notices.at(-1)!.text, /Demo: you chose Yes/);
  await runCommand("mode steer");
  await runCommand("mode");
  assert.match(notices.at(-1)!.text, /Mode is steer/);

  await runCommand("disable");
  assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), { typesafe: false, mode: "steer" });
  await runCommand("test");
  assert.equal(networkCalls, 2, "disabled: no new request");
  assert.match(notices.at(-2)!.text, /pattern checks only/);

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
  assert.match(notices.at(-1)!.text, /tools bash, irreversible hold ≥ 0\.6/);
  const saved = JSON.parse(await readFile(configPath(), "utf8"));
  assert.equal(saved.typesafe, true);

  nextAnswers = { irreversible: 0.65, off_task: 0.1, scope: "expected_step" };
  assert.equal((await toolCall("bash", { command: "npm test" }))?.block, true, "new thresholds apply immediately");
  assert.equal(await toolCall("write", { path: join(temporary, "a.txt"), content: "x" }), undefined);
  assert.equal(networkCalls, 1, "write is no longer a guarded tool");
});

test("the widget is a clickable component: a left click opens the trace panel as a right-hand overlay, live-updating", async () => {
  await grantConsent();
  nextAnswers = { irreversible: 0.2, off_task: 0.1, scope: "expected_step" };
  await toolCall("bash", { command: "npm test" });
  assert.equal(widgetPlacement, "aboveEditor");
  assert.ok(widgetComponent?.handleMouse, "widget handles mouse events");

  assert.equal(widgetComponent!.handleMouse!({ type: "move", button: "none", x: 1, y: 0 }), undefined, "moves are ignored");
  const result = widgetComponent!.handleMouse!({ type: "click", button: "left", x: 1, y: 0 });
  assert.deepEqual(result, { handled: true });
  assert.equal(customCalls.length, 1);
  assert.equal(customCalls[0]!.options?.overlay, true);
  assert.deepEqual((customCalls[0]!.options?.overlayOptions as Record<string, unknown>).anchor, "right-center");
  const panel = openPanels[0]!;
  let text = panel.render(120).join("\n");
  assert.match(text, /pi-warden trace · 1 event/);
  assert.match(text, /action\s+warden · bash · irreversible 0\.20/);
  assert.match(text, /· ran: npm test/);
  assert.match(text, /· jev: irreversible 0\.20 · off-task 0\.10 · expected step/);

  widgetComponent!.handleMouse!({ type: "click", button: "left", x: 1, y: 0 });
  assert.equal(customCalls.length, 1, "a second click does not open a second panel");

  nextAnswers = { irreversible: 0.92, off_task: 0.1, scope: "expected_step" };
  const rendersBefore = renders;
  await toolCall("bash", { command: "npm run db:reset" });
  assert.ok(renders > rendersBefore, "the open panel re-renders when the trace changes");
  text = panel.render(120).join("\n");
  assert.match(text, /2 events/);
  assert.ok(text.indexOf("db:reset") < text.indexOf("npm test"), "newest first");
  assert.match(text, /· mode: steer/);
  assert.match(text, /· agent told: pi-warden held this bash call/);

  panel.handleInput("\x1b");
  await new Promise(resolve => setTimeout(resolve, 0));
  widgetComponent!.handleMouse!({ type: "click", button: "left", x: 1, y: 0 });
  assert.equal(customCalls.length, 2, "after closing, the panel can be opened again");
  openPanels[1]!.handleInput("c");
  assert.match(openPanels[1]!.render(100).join("\n"), /No guarded activity yet/);
  openPanels[1]!.handleInput("q");
});

test("/warden trace opens the panel with a UI and prints the trace without one; stuck and done events carry details", async () => {
  await grantConsent();
  await runCommand("trace");
  assert.equal(customCalls.length, 1);
  openPanels[0]!.handleInput("\x1b");
  await new Promise(resolve => setTimeout(resolve, 0));

  await newPrompt("make the tests pass");
  for (let index = 0; index < 3; index++) await toolResult("bash", { command: "npm test" }, "1 failing", true);
  await toolResult("edit", { path: "src/a.ts", edits: [] }, "ok", false);
  nextAnswers = { claims_done: 0.9, claims_verified: 0.1, verification_applies: 0.9, outcome: "complete" };
  await agentEnd("Fixed it.");
  await runCommand("trace");
  const text = openPanels[1]!.render(140).join("\n");
  assert.match(text, /stuck\s+warden · stuck · 3 failures · exact repeat · stuck/);
  assert.match(text, /· 1\. ✗ npm test → 1 failing/);
  assert.match(text, /· agent told: pi-warden: the same call failed 3 times/);
  assert.match(text, /done\s+warden · done-check · 1 changes/);
  assert.match(text, /· final message: Fixed it\./);
  assert.match(text, /· evidence: 1 code change; checks: npm test → failed/);
  openPanels[1]!.handleInput("q");

  const headless = context({ hasUI: false });
  const messages: string[] = [];
  const originalSend = sentMessages.length;
  await runCommand("trace", headless);
  const printed = sentMessages.slice(originalSend).map(entry => entry.message.content);
  messages.push(...printed);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /stuck: warden · stuck/);
  assert.match(messages[0]!, /done: warden · done-check/);
});

test("widget templates come from config and unknown or empty tokens drop their segment", async () => {
  await writeFile(configPath(), JSON.stringify({ typesafe: true, widget: { action: "{time} {tool} → {level} · irr {irreversible} · pat {patterns} · {nonsense}", placement: "belowEditor" } }));
  nextAnswers = { irreversible: 0.33, off_task: 0.1, scope: "expected_step" };
  await toolCall("bash", { command: "npm test" });
  assert.equal(widgetPlacement, "belowEditor");
  assert.match(widgets.at(-1)![0]!, /^\d{2}:\d{2}:\d{2} bash → allow · irr 0\.33$/);

  await writeFile(configPath(), JSON.stringify({ widget: { enabled: false } }));
  await toolCall("bash", { command: "rm -rf dist" });
  assert.equal(widgets.at(-1), undefined, "widget disabled clears the line");
});
