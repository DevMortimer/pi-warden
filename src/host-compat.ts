// src/host-compat.ts - Maps a Pi-compatible host's extension API onto the Pi contract.
//
// pi-warden is written against the Pi extension API. Some hosts load Pi extensions through a
// compatibility layer whose contract differs in a few places. This module is the only place
// that knows about those differences, so the rest of pi-warden stays Pi-only.
//
// On upstream Pi, adaptHost() returns the API unchanged.
//
// The adapted host is one that exposes its session package as `pi.pi` with getActiveSkills()
// (oh-my-pi). Its differences, and what the adapter does:
//  - before_agent_start has no systemPromptOptions: the adapter adds one with the active skills,
//    and turns an appendSystemPrompt set by a handler into the host's systemPrompt array result.
//  - command contexts have no getSystemPromptOptions(): the adapter adds it.
//  - the input result is read as { handled }, not { action: "handled" }: the adapter adds `handled`.
//  - there is no agent_settled event: the adapter runs the handler after the host dispatches
//    this extension's agent_end handlers and becomes idle. It also watches async work that can
//    drain without another agent_end when cancelled.
//  - message_end results are ignored, and a finalized message cannot be replaced another way:
//    context.dedupeMessages has no effect on this host.
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

interface HostSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir?: string;
  /** Loaded but left out of the system prompt listing: Pi's disableModelInvocation. */
  hide?: boolean;
}

type PiSkill = Pick<Skill, "name" | "description" | "filePath" | "baseDir" | "disableModelInvocation">;
type SystemPromptOptions = { skills: PiSkill[]; appendSystemPrompt?: string };
// The wrapped handlers are generic over every event, so payloads stay unknown here.
type Handler = (event: unknown, ctx: unknown) => unknown;
type SystemPrompt = string | string[];

/** Bind-through view: overrides win, functions bind to the target so `this` keeps working. */
function overlay<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function adaptHost(pi: ExtensionAPI): ExtensionAPI {
  const session = (pi as unknown as { pi?: { getActiveSkills?: () => readonly HostSkill[] } }).pi;
  const getActiveSkills = session?.getActiveSkills;
  if (typeof getActiveSkills !== "function") return pi;
  const systemPromptOptions = (): SystemPromptOptions => ({ skills: getActiveSkills.call(session).map(toPiSkill) });

  const register = pi.on.bind(pi) as (event: string, handler: Handler) => void;
  const asyncWorkEnds = new WeakSet<object>();
  // Capture the async-work pause before later agent_end handlers can await I/O. A job may
  // cancel during one of those handlers and leave no snapshot or follow-up agent_end.
  register("agent_end", (event, ctx) => {
    if ((event as { willContinue?: unknown } | null)?.willContinue !== true) return;
    const snapshot = asyncJobSnapshot(ctx);
    if (snapshot && hasAsyncWork(snapshot)) asyncWorkEnds.add(event as object);
  });
  let endGeneration = 0;
  // Pi emits agent_settled once per prompt, after every agent_end handler and continuation.
  // Register its host stand-in after extension setup. omp then owns each callback's timeout
  // and error report, and advances to the stand-in even if one callback times out.
  // Other extensions may still have agent_end handlers after ours; the stand-in reads only
  // pi-warden's state.
  const on = (event: string, handler: Handler): void => {
    if (event === "before_agent_start") return register(event, (e, ctx) => beforeAgentStart(e, ctx, handler, systemPromptOptions()));
    if (event === "input") return register(event, async (e, ctx) => inputResult(await handler(e, ctx)));
    if (event === "agent_settled") {
      queueMicrotask(() => register("agent_end", (e, ctx) => {
        const generation = ++endGeneration;
        if ((e as { willContinue?: unknown } | null)?.willContinue === true) {
          // A cancelled background job can drain without another agent_end. The host drops
          // awaitingAsyncWork before extensions see the event, so an earlier extension may
          // drain it before our observer runs. Give an empty snapshot one host-dispatch grace
          // period; a later agent_end or a running continuation suppresses the fallback.
          const snapshot = asyncJobSnapshot(ctx);
          if (snapshot) {
            const hadAsyncWork = asyncWorkEnds.has(e as object) || hasAsyncWork(snapshot);
            watchAsyncWork(ctx, handler, () => generation === endGeneration, hadAsyncWork ? 500 : 1000);
          }
          return;
        }
        setImmediate(() => {
          if (generation === endGeneration) settle(handler, ctx);
        });
      }));
      return;
    }
    return register(event, handler);
  };

  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) =>
    pi.registerCommand(name, { ...options, handler: (args, ctx) => options.handler(args, withSystemPromptOptions(ctx, systemPromptOptions)) });

  return overlay(pi, { on, registerCommand });
}

function toPiSkill(skill: HostSkill): PiSkill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir ?? "",
    disableModelInvocation: skill.hide === true,
  };
}

async function beforeAgentStart(event: unknown, ctx: unknown, handler: Handler, options: SystemPromptOptions): Promise<unknown> {
  const result = await handler({ ...(event as object), systemPromptOptions: options }, ctx);
  if (!options.appendSystemPrompt) return result;
  const prompt = systemPromptOf(result) ?? systemPromptOf(event) ?? [];
  return { ...(result as object | undefined), systemPrompt: [...(Array.isArray(prompt) ? prompt : [prompt]), options.appendSystemPrompt] };
}

function systemPromptOf(value: unknown): SystemPrompt | undefined {
  if (!value || typeof value !== "object" || !("systemPrompt" in value)) return undefined;
  const prompt = value.systemPrompt;
  return typeof prompt === "string" || Array.isArray(prompt) ? prompt as SystemPrompt : undefined;
}

function inputResult(result: unknown): unknown {
  const action = (result as { action?: unknown } | undefined)?.action;
  return action === "handled" ? { ...(result as object), handled: true } : result;
}

type AsyncJobSnapshot = { running: readonly unknown[]; delivery: { queued: number; delivering: boolean } };

function asyncJobSnapshot(ctx: unknown): AsyncJobSnapshot | undefined {
  const get = (ctx as { getAsyncJobSnapshot?: unknown } | null)?.getAsyncJobSnapshot;
  if (typeof get !== "function") return undefined;
  const snapshot = get.call(ctx);
  return snapshot && Array.isArray(snapshot.running) ? snapshot as AsyncJobSnapshot : undefined;
}

function hasAsyncWork(snapshot: AsyncJobSnapshot): boolean {
  return snapshot.running.length > 0 || (snapshot.delivery?.queued ?? 0) > 0 || snapshot.delivery?.delivering === true;
}

function watchAsyncWork(ctx: unknown, handler: Handler, isCurrent: () => boolean, delayMs: number): void {
  const check = () => {
    if (!isCurrent()) return;
    const snapshot = asyncJobSnapshot(ctx);
    if (snapshot && hasAsyncWork(snapshot)) {
      setTimeout(check, 500).unref();
      return;
    }
    settle(handler, ctx);
  };
  setTimeout(check, delayMs).unref();
}

function settle(handler: Handler, ctx: unknown): void {
  if (!isIdle(ctx)) return;
  void Promise.resolve()
    .then(() => handler({ type: "agent_settled" }, ctx))
    .catch(error => console.error("pi-warden: agent_settled handler failed:", error));
}

/** A context without isIdle() cannot report a continuation, so it counts as idle. */
function isIdle(ctx: unknown): boolean {
  const check = (ctx as { isIdle?: unknown } | null)?.isIdle;
  return typeof check === "function" ? check.call(ctx) !== false : true;
}

function withSystemPromptOptions<T extends object>(ctx: T, options: () => SystemPromptOptions): T {
  if (typeof (ctx as { getSystemPromptOptions?: unknown }).getSystemPromptOptions === "function") return ctx;
  return overlay(ctx, { getSystemPromptOptions: options });
}
