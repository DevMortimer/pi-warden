import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adaptHost } from "../src/host-compat.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A host API with the given extras; `on` and `registerCommand` record what the extension registers. */
function fakeHost(extras: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const api = {
    ...extras,
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) { commands.set(name, options); },
  };
  const emit = async (event: string, payload: unknown, ctx: unknown = {}, handlerTimeoutMs?: number) => {
    await Promise.resolve(); // omp finishes extension setup before dispatching an event.
    let result: unknown;
    let error: unknown;
    // omp's per-handler timeout: the host stops awaiting a handler that runs too long and
    // advances to the next one; the handler's promise keeps running.
    let onTimeout = (): void => {};
    const timeout = new Promise<void>(resolve => { onTimeout = resolve; });
    const timer = setTimeout(onTimeout, handlerTimeoutMs ?? 2 ** 30);
    timer.unref?.();
    const run = (handler: Handler) => Promise.race([Promise.resolve(handler(payload, ctx)), timeout]);
    for (const handler of handlers.get(event) ?? []) {
      try { result = await run(handler); } catch (failure) { error ??= failure; }
    }
    clearTimeout(timer);
    onTimeout();
    if (error !== undefined) throw error;
    return result;
  };
  return { api: api as unknown as ExtensionAPI, handlers, commands, emit };
}

const skillHost = () => fakeHost({
  pi: {
    getActiveSkills: () => [
      { name: "listed", description: "in the prompt", filePath: "/s/listed/SKILL.md", baseDir: "/s/listed", hide: false },
      { name: "hidden", description: "not in the prompt", filePath: "/s/hidden/SKILL.md", baseDir: "/s/hidden", hide: true },
    ],
  },
});

test("adaptHost: API members the adapter does not override keep the host's `this` binding", () => {
  const tools: unknown[] = [];
  let receiver: unknown;
  const { api } = fakeHost({
    tools,
    registerTool(this: { tools: unknown[] }, tool: { name: string }) { receiver = this; this.tools.push(tool); },
    pi: { getActiveSkills: () => [] },
  });
  const adapted = adaptHost(api);
  const tool = { name: "probe" } as unknown as Parameters<ExtensionAPI["registerTool"]>[0];
  adapted.registerTool(tool);
  assert.deepEqual(tools, [tool], "the host recorded the tool");
  assert.equal(receiver, api, "the method runs on the real host, not the proxy");
});

test("adaptHost: a host without a session skill catalog (upstream Pi) gets the API back unchanged", () => {
  const { api } = fakeHost();
  assert.equal(adaptHost(api), api);
});

test("adaptHost: before_agent_start sees the active skills, with hidden skills marked disableModelInvocation", async () => {
  const host = skillHost();
  let seen: { skills: Array<{ name: string; disableModelInvocation: boolean }> } | undefined;
  adaptHost(host.api).on("before_agent_start", (event: { systemPromptOptions?: typeof seen }) => { seen = event.systemPromptOptions; });
  await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] });
  assert.deepEqual(seen?.skills.map(skill => [skill.name, skill.disableModelInvocation]), [["listed", false], ["hidden", true]]);
});

test("adaptHost: appendSystemPrompt set by the handler becomes the host's systemPrompt array result", async () => {
  const host = skillHost();
  adaptHost(host.api).on("before_agent_start", (event: { systemPromptOptions?: { appendSystemPrompt?: string } }) => {
    event.systemPromptOptions!.appendSystemPrompt = "tip";
  });
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base", "rules"] });
  assert.deepEqual(result, { systemPrompt: ["base", "rules", "tip"] }, "the host prompt is kept and the tip appended");

  const quiet = skillHost();
  adaptHost(quiet.api).on("before_agent_start", () => undefined);
  assert.equal(await quiet.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] }), undefined, "no tip leaves the prompt alone");
});

test("adaptHost: the systemPrompt from appendSystemPrompt keeps the rest of the handler result", async () => {
  const message = { customType: "conscience", content: "use the skill", display: false };
  const host = skillHost();
  adaptHost(host.api).on("before_agent_start", (event: { systemPromptOptions?: { appendSystemPrompt?: string } }) => {
    event.systemPromptOptions!.appendSystemPrompt = "tip";
    return { message };
  });
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] });
  assert.deepEqual(result, { message, systemPrompt: ["base", "tip"] }, "the message is kept and the tip appended to the host prompt");

  const single = skillHost();
  adaptHost(single.api).on("before_agent_start", (event: { systemPromptOptions?: { appendSystemPrompt?: string } }) => {
    event.systemPromptOptions!.appendSystemPrompt = "tip";
    return { systemPrompt: "solo" };
  });
  const wrapped = await single.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] });
  assert.deepEqual(wrapped, { systemPrompt: ["solo", "tip"] }, "the handler's own prompt wins over the event's");
});

test("adaptHost: an input handled by the extension is also marked handled for the host", async () => {
  const host = skillHost();
  const adapted = adaptHost(host.api);
  adapted.on("input", (event: { text: string }) => (event.text === "busy" ? { action: "handled" as const } : { action: "continue" as const }));
  assert.deepEqual(await host.emit("input", { text: "busy" }), { action: "handled", handled: true });
  assert.deepEqual(await host.emit("input", { text: "go" }), { action: "continue" }, "continue is not marked handled");
});

test("adaptHost: agent_settled waits for both agent_end handlers, including delayed I/O", async () => {
  const host = skillHost();
  const adapted = adaptHost(host.api);
  const order: string[] = [];
  adapted.on("agent_settled", () => { order.push("settled"); });
  adapted.on("agent_end", () => { order.push("first"); });
  let finishIo = (): void => {};
  const io = new Promise<void>(resolve => { finishIo = resolve; });
  adapted.on("agent_end", async () => { await io; order.push("second"); });
  const ended = host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["first"], "no settle while second agent_end handler waits for I/O");
  finishIo();
  await ended;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["first", "second", "settled"]);
});

test("adaptHost: agent_settled runs after an agent_end registered first", async () => {
  const host = skillHost();
  const adapted = adaptHost(host.api);
  const order: string[] = [];
  let finishIo = (): void => {};
  const io = new Promise<void>(resolve => { finishIo = resolve; });
  adapted.on("agent_end", async () => { await io; order.push("end"); });
  adapted.on("agent_settled", () => { order.push("settled"); });
  const ended = host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, []);
  finishIo();
  await ended;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["end", "settled"]);
});

test("adaptHost: an agent_end that says the host will continue does not settle; queued messages alone do not stop the settle", async () => {
  const host = skillHost();
  let settled = 0;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  await host.emit("agent_end", { type: "agent_end", willContinue: true }, { isIdle: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0);
  // omp keeps a nextTurn message queued while idle until the next user prompt, so no continuation follows.
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true, hasPendingMessages: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: cancelled async work settles after draining without another agent_end", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const host = skillHost();
  let settled = 0;
  let running = true;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  const ctx = {
    isIdle: () => true,
    getAsyncJobSnapshot: () => ({ running: running ? [{ id: "job" }] : [], delivery: { queued: 0, delivering: false } }),
  };
  await host.emit("agent_end", { type: "agent_end", willContinue: true }, ctx);
  context.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0, "running work delays settle");
  running = false; // Cancelled or acknowledged job sends no follow-up and no terminal agent_end.
  context.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: cancellation during an earlier agent_end handler still settles", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const host = skillHost();
  const adapted = adaptHost(host.api);
  let settled = 0;
  let running = true;
  let finishIo = (): void => {};
  const io = new Promise<void>(resolve => { finishIo = resolve; });
  adapted.on("agent_settled", () => { settled++; });
  adapted.on("agent_end", () => io);
  const ctx = {
    isIdle: () => true,
    getAsyncJobSnapshot: () => ({ running: running ? [{ id: "job" }] : [], delivery: { queued: 0, delivering: false } }),
  };
  const ended = host.emit("agent_end", { type: "agent_end", willContinue: true }, ctx);
  await new Promise(resolve => setImmediate(resolve));
  running = false;
  finishIo();
  await ended;
  context.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: cancellation in an earlier extension can drain before warden sees agent_end", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const host = skillHost();
  let running = true;
  let settled = 0;
  host.handlers.set("agent_end", [() => { running = false; }]); // Earlier extension in omp's dispatch order.
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  const ctx = {
    isIdle: () => true,
    getAsyncJobSnapshot: () => ({ running: running ? [{ id: "job" }] : [], delivery: { queued: 0, delivering: false } }),
  };
  await host.emit("agent_end", { type: "agent_end", willContinue: true }, ctx);
  context.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: empty async snapshot does not settle a continuation that starts during grace period", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const host = skillHost();
  let settled = 0;
  let idle = true;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  const ctx = {
    isIdle: () => idle,
    getAsyncJobSnapshot: () => ({ running: [], delivery: { queued: 0, delivering: false } }),
  };
  await host.emit("agent_end", { type: "agent_end", willContinue: true }, ctx);
  idle = false;
  context.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0);
  idle = true;
  await host.emit("agent_end", { type: "agent_end" }, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: queued and delivering async results delay settlement", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const host = skillHost();
  let settled = 0;
  let queued = 1;
  let delivering = false;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  const ctx = {
    isIdle: () => true,
    getAsyncJobSnapshot: () => ({ running: [], delivery: { queued, delivering } }),
  };
  await host.emit("agent_end", { type: "agent_end", willContinue: true }, ctx);
  context.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0);
  queued = 0;
  delivering = true;
  context.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0);
  delivering = false;
  context.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: async work watcher does not settle after a later agent_end", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const host = skillHost();
  let settled = 0;
  let running = true;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  const ctx = {
    isIdle: () => true,
    getAsyncJobSnapshot: () => ({ running: running ? [{ id: "job" }] : [], delivery: { queued: 0, delivering: false } }),
  };
  await host.emit("agent_end", { type: "agent_end", willContinue: true }, ctx);
  running = false;
  await host.emit("agent_end", { type: "agent_end" }, ctx);
  context.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: an agent_end followed by a continuation does not settle; the run that ends idle does", async () => {
  const host = skillHost();
  let settled = 0;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0, "a queued follow-up keeps the host busy, so the prompt is not settled yet");
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: the host is checked for idle after agent_end returns, not while its handlers run", async () => {
  const host = skillHost();
  let settled = 0;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  let idle = false;
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => idle });
  idle = true; // omp's prompt is still in flight while agent_end handlers run and ends after they return.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: a continuation starting before the deferred idle check suppresses settle", async () => {
  const host = skillHost();
  let settled = 0;
  adaptHost(host.api).on("agent_settled", () => { settled++; });
  let idle = true;
  const ctx = { isIdle: () => idle };
  await host.emit("agent_end", { type: "agent_end" }, ctx);
  idle = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 0);
  idle = true;
  await host.emit("agent_end", { type: "agent_end" }, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
});

test("adaptHost: a rejected agent_end handler leaves host error handling intact and still settles", async () => {
  const host = skillHost();
  const adapted = adaptHost(host.api);
  const order: string[] = [];
  adapted.on("agent_settled", () => { order.push("settled"); });
  let failIo = (_error: Error): void => {};
  const io = new Promise<void>((_resolve, reject) => { failIo = reject; });
  adapted.on("agent_end", async () => { await io; });
  adapted.on("agent_end", () => { order.push("second"); });
  await Promise.resolve();
  const ended = host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, [], "do not settle while failed handler still waits");
  failIo(new Error("boom"));
  await assert.rejects(ended, /boom/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["second", "settled"]);
});

test("adaptHost: host timeout advances to settle even if an agent_end promise remains pending", async () => {
  const host = skillHost();
  const adapted = adaptHost(host.api);
  let settled = 0;
  let finishIo = (): void => {};
  const io = new Promise<void>(resolve => { finishIo = resolve; });
  adapted.on("agent_settled", () => { settled++; });
  adapted.on("agent_end", () => io);
  await Promise.resolve();
  // The host applies its per-handler timeout to every agent_end handler and still runs the
  // settle stand-in after the pending one is abandoned.
  await host.emit("agent_end", { type: "agent_end" }, { isIdle: () => true }, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, 1);
  finishIo();
  await io;
});

test("adaptHost: command contexts get getSystemPromptOptions with the active skills", async () => {
  const host = skillHost();
  let names: string[] = [];
  adaptHost(host.api).registerCommand("warden", {
    description: "test",
    handler: async (_args, ctx) => {
      names = ctx.getSystemPromptOptions().skills?.map(skill => skill.name) ?? [];
      seenCwd = ctx.cwd;
    },
  });
  let seenCwd: unknown;
  const ctx = { cwd: "/project", isIdle: () => true };
  await host.commands.get("warden")!.handler("index", ctx);
  assert.deepEqual(names, ["listed", "hidden"]);
  assert.equal(seenCwd, "/project", "plain ctx fields pass through the adapter");
});
