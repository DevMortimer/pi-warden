import { execFile, fork } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authStatePath, createTypeSafe, openUsageLedger, resolveBackend, usagePath } from "pi-typesafe";
import type { Judge } from "pi-typesafe";
import { judgeOptions } from "../backend.js";
import { loadConfig, userConfigPath } from "../config.js";
import type { RulesConfig, WardenConfig } from "../config.js";
import { redact } from "../redact.js";
import { evaluateRulesTarget, FALLBACK_FILES, pathNotes, pathNoteSteer, RuleStore, RULES_FILE, rulesCapNotice, rulesSteer, skipReason } from "../rules.js";
import type { RulesTarget, RuleSet } from "../rules.js";
import type { HostName, HostState } from "./state.js";
import { object, readText } from "./io.js";

/** Claude Code and Codex read the same `PostToolUse` shape: context for the model after the call, never a hold. */
export interface HookOutput { hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext: string } }

export function feedback(notes: string[]): HookOutput {
  return notes.length ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: redact(notes.join("\n")).slice(0, 9000) } } : {};
}

const HOOKS: Record<HostName, () => Promise<(event: string, input: unknown, signal: AbortSignal) => Promise<HookOutput>>> = {
  claude: async () => (await import("./claude.js")).claudeHook,
  codex: async () => (await import("./codex.js")).codexHook,
};

/** A child process makes the deadline enforceable during native synchronous SDK reads as well. */
export async function runHostHook(host: HostName, event: string, input: unknown, signal: AbortSignal): Promise<HookOutput> {
  signal.throwIfAborted();
  return new Promise((done, reject) => {
    const engine = fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, PI_WARDEN_HOOK_CHILD: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    });
    let output: HookOutput | undefined;
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
      if (object(message) && message.ok === true && object(message.output)) output = message.output as HookOutput;
      else failed = true;
    });
    engine.on("error", () => { failed = true; });
    engine.once("close", code => {
      clearTimeout(terminate);
      signal.removeEventListener("abort", abort);
      if (signal.aborted || failed || code !== 0 || output === undefined) reject(new Error("Hook did not finish within its limits."));
      else done(output);
    });
    engine.send({ host, event, input }, error => { if (error) failed = true; });
    if (signal.aborted) abort();
  });
}

/** Headless hosts read the global user config only; `.pi/pi-warden.json` project overrides are Pi's. */
export async function globalConfig(signal: AbortSignal): Promise<WardenConfig> {
  const user = await readText(userConfigPath(), signal);
  const userRaw: unknown = user === undefined ? {} : JSON.parse(user);
  if (!object(userRaw)) throw new Error("Invalid global Warden configuration.");
  return loadConfig({ userRaw: { value: userRaw } });
}

export async function loadRules(cwd: string, config: RulesConfig, signal: AbortSignal): Promise<RuleSet | undefined> {
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

export type Unavailable = { reason: "no-consent" | "bad-backend" | "no-key"; problem: string };

/** Headless consent and the active backend's key come from the environment only; each request reserves a session slot first. */
export async function headlessJudge(config: WardenConfig, state: HostState, signal: AbortSignal): Promise<Judge | Unavailable> {
  if (process.env.PI_WARDEN_ENABLED !== "1") return { reason: "no-consent", problem: "set PI_WARDEN_ENABLED=1 for this headless host" };
  const backend = config.typesafeBackend;
  if (backend === undefined) return { reason: "bad-backend", problem: "fix typesafeBackend in the global user config" };
  const key = process.env[resolveBackend(backend).keyEnv]?.trim();
  if (!key) return { reason: "no-key", problem: "set the active backend key in the environment" };
  await readText(authStatePath(), signal);
  await readText(usagePath(), signal);
  const observed = openUsageLedger();
  return createTypeSafe({ ...judgeOptions({ ...config, typesafeBackend: backend }), apiKey: key,
    ledger: { ...observed, recordStart: () => { state.reserveRequest(); observed.recordStart(); } },
  });
}

const memo = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => value ??= load();
};

/**
 * The rules side of one host call. The rule set and the judge are made on first use and shared by every file the call
 * wrote, so a file that is skipped opens no judge and reports no missing consent or key.
 */
export class RulesRun {
  readonly rules: () => Promise<RuleSet | undefined>;
  readonly judge: () => Promise<Judge | Unavailable>;
  constructor(readonly project: string, readonly config: WardenConfig, readonly state: HostState, readonly signal: AbortSignal) {
    this.rules = memo(() => loadRules(project, config.rules, signal));
    this.judge = memo(() => headlessJudge(config, state, signal));
  }

  /** Notes for one written file: a sensitive-path note once per session, then the rules judgment of the change. */
  async notes(target: RulesTarget): Promise<string[]> {
    const { project, config, state, signal } = this;
    const notes: string[] = [];
    const sensitive = pathNotes(target.path, config.rules.sensitivePaths).filter(hit => state.once("sensitive", JSON.stringify([project, target.path, hit.glob])));
    if (sensitive.length) notes.push(pathNoteSteer(target.path, sensitive));
    const set = await this.rules();
    if (skipReason(target, set, config.rules) || await ignored(target.path, project, signal)) return notes;
    const unavailable = (reason: string, message: string): string[] => {
      if (state.once("notice", reason)) notes.push(`pi-warden: ${message}`);
      return notes;
    };
    const judge = await this.judge();
    if ("reason" in judge) return unavailable(judge.reason, `rules judgments are off; ${judge.problem}.`);
    const verdict = await evaluateRulesTarget(target, target.tool, target.path, { cwd: project, config: config.rules, set, judge, timeoutMs: config.timeoutMs, signal });
    if (verdict.source === "error") return unavailable(verdict.errorCode === "budget" ? "budget" : "judge-error", verdict.errorCode === "budget" ? "rules request budget reached or unavailable; no further request was submitted." : "rules judgment failed; this call continues.");
    const cap = rulesCapNotice(verdict);
    if (cap && state.once("notice", "rules-cap")) notes.push(cap);
    if (verdict.findings.length || verdict.softFindings?.length) notes.push(rulesSteer(verdict, new Map()));
    return notes;
  }
}

if (process.env.PI_WARDEN_HOOK_CHILD === "1" && process.send) {
  const controller = new AbortController();
  let started = false;
  const send = (message: unknown): void => {
    if (process.connected) process.send!(message, () => { if (process.connected) process.disconnect(); });
  };
  process.on("disconnect", () => controller.abort());
  process.on("message", (message: unknown) => {
    if (message === "abort") { controller.abort(); return; }
    if (started || !object(message) || typeof message.event !== "string" || (message.host !== "claude" && message.host !== "codex")) return;
    started = true;
    void HOOKS[message.host]().then(hook => hook(message.event as string, message.input, controller.signal)).then(
      output => send({ ok: true, output }),
      () => send({ ok: false }),
    );
  });
}
