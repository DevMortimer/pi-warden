import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userConfigPath } from "./config.js";
import type { SteersConfig } from "./config.js";

/**
 * Per-model steer adaptation. A steer kind that a model follows rarely or disputes often becomes trace-only for that
 * model: on recorded sessions intent-mismatch notices were followed 8% of the time, the done-check 77%, and strong
 * models dispute noise ("as I said …"). Holds and per-call judgments never change; only whether a note is sent.
 */

/** One kind of note to the agent. Finer than the steer guard: the `action` guard sends several unrelated notes. */
export type SteerKind =
  | "intent-mismatch" | "off-task" | "should-proceed" | "warn-headless" | "large-output"
  | "slop" | "rules" | "sensitive-path" | "security-write"
  | "stuck" | "repeat" | "done" | "prose" | "conscience" | "loops" | "runaway" | "subagent"
  | "hold" | "confirm" | "deny" | "masking" | "credential-notice";

export const STEER_KINDS: readonly SteerKind[] = [
  "intent-mismatch", "off-task", "should-proceed", "warn-headless", "large-output", "slop", "rules", "sensitive-path",
  "security-write", "stuck", "repeat", "done", "prose", "conscience", "loops", "runaway", "subagent",
  "hold", "confirm", "deny", "masking", "credential-notice",
];

/**
 * Never trace-only, whatever a model does with them: holds, confirm and deny verdicts, security masking, the credential
 * notice on masked output, and the done-check. Runaway recovery and subagent wakes start a turn of their own; muting
 * them would change what the run does, not only what the agent is told.
 */
export const NEVER_MUTED: ReadonlySet<SteerKind> = new Set<SteerKind>([
  "hold", "confirm", "deny", "masking", "credential-notice", "done", "runaway", "subagent",
]);

interface Counts { sent: number; followed: number; disputed: number }

export interface PairState extends Counts {
  muted: boolean;
  /** Steers asked for since the pair became trace-only or was last re-checked. */
  asked: number;
  /** Outcomes of the probe steers sent since then. */
  probe: Counts;
}

interface StoreFile { version: 1; models: Record<string, Partial<Record<SteerKind, PairState>>> }

export interface MutedPair { model: string; kind: SteerKind; sent: number; followed: number; disputed: number }

/** Where the counts live: next to the user config, in pi-warden's data folder. */
export function steerStatsPath(): string {
  return process.env.PI_WARDEN_STEER_STATS ?? join(dirname(userConfigPath()), "steer-stats.json");
}

export const DEFAULT_STEERS: SteersConfig = { adaptive: true, minSteers: 30, minFollowed: 0.2, maxDisputed: 0.4, recheckEvery: 30, probeEvery: 5 };

const zero = (): Counts => ({ sent: 0, followed: 0, disputed: 0 });
const fresh = (): PairState => ({ ...zero(), muted: false, asked: 0, probe: zero() });

/** Kinds whose "followed" can be read from the next calls or text; the rest are judged by disputes alone. */
const FOLLOW_MEASURED: ReadonlySet<SteerKind> = new Set<SteerKind>([
  "intent-mismatch", "off-task", "should-proceed", "warn-headless", "large-output", "slop", "rules", "security-write",
  "stuck", "repeat", "done", "conscience", "loops",
]);

/** True when the counts put the pair under the follow floor or over the dispute ceiling. */
export function failing(kind: SteerKind, counts: Counts, config: SteersConfig): boolean {
  if (!counts.sent) return false;
  return (FOLLOW_MEASURED.has(kind) && counts.followed / counts.sent < config.minFollowed) || counts.disputed / counts.sent > config.maxDisputed;
}

export type SteerDecision = "send" | "probe" | "trace-only";

/** The counts per (model, kind) pair, read once and written after every change. */
export class SteerStats {
  private data: StoreFile | undefined;
  constructor(private readonly path: string = steerStatsPath()) {}

  private load(): StoreFile {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
      this.data = raw?.version === 1 && typeof raw.models === "object" && raw.models ? raw : { version: 1, models: {} };
    } catch {
      this.data = { version: 1, models: {} };
    }
    return this.data;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      console.warn("pi-warden: steer stats write failed:", error instanceof Error ? error.message : String(error));
    }
  }

  pair(model: string, kind: SteerKind): PairState | undefined {
    return this.load().models[model]?.[kind];
  }

  private ensure(model: string, kind: SteerKind): PairState {
    const models = this.load().models;
    const kinds = models[model] ??= {};
    return kinds[kind] ??= fresh();
  }

  /**
   * Called before a steer of this kind goes out. A trace-only pair still sends the first of every `probeEvery` steers;
   * after `recheckEvery` steers the probes decide: rates within the thresholds end trace-only, and the probe counts
   * become the pair's new counts, so a fresh `minSteers` must pass before it can be muted again.
   */
  request(model: string, kind: SteerKind, config: SteersConfig): SteerDecision {
    if (!config.adaptive || NEVER_MUTED.has(kind)) return "send";
    const pair = this.pair(model, kind);
    if (!pair?.muted) return "send";
    const probe = pair.asked % Math.max(1, config.probeEvery) === 0;
    pair.asked++;
    if (pair.asked >= config.recheckEvery) {
      if (pair.probe.sent > 0 && !failing(kind, pair.probe, config)) Object.assign(pair, { ...pair.probe, muted: false, asked: 0, probe: zero() });
      else Object.assign(pair, { asked: 0, probe: zero() });
    }
    this.save();
    return probe ? "probe" : "trace-only";
  }

  /**
   * The outcome of one sent steer. Crossing the thresholds at `minSteers` or later makes the pair trace-only. Kinds in
   * NEVER_MUTED are counted, for the status, and never muted.
   */
  observe(model: string, kind: SteerKind, outcome: { followed: boolean; disputed: boolean }, config: SteersConfig): void {
    if (!config.adaptive) return;
    const pair = this.ensure(model, kind);
    const add = (counts: Counts) => {
      counts.sent++;
      if (outcome.followed) counts.followed++;
      if (outcome.disputed) counts.disputed++;
    };
    add(pair);
    if (pair.muted) add(pair.probe);
    else if (!NEVER_MUTED.has(kind) && pair.sent >= config.minSteers && failing(kind, pair, config)) Object.assign(pair, { muted: true, asked: 0, probe: zero() });
    this.save();
  }

  /** Drops the pair's counts; its steers are sent again. True when there was something to reset. */
  unmute(model: string, kind: SteerKind): boolean {
    const kinds = this.load().models[model];
    if (!kinds?.[kind]) return false;
    delete kinds[kind];
    if (!Object.keys(kinds).length) delete this.load().models[model];
    this.save();
    return true;
  }

  /** Every trace-only pair, per model. */
  muted(): MutedPair[] {
    const out: MutedPair[] = [];
    for (const [model, kinds] of Object.entries(this.load().models)) {
      for (const [kind, pair] of Object.entries(kinds) as Array<[SteerKind, PairState]>) {
        if (pair.muted) out.push({ model, kind, sent: pair.sent, followed: pair.followed, disputed: pair.disputed });
      }
    }
    return out.sort((a, b) => a.model.localeCompare(b.model) || a.kind.localeCompare(b.kind));
  }

  /** Models with a pair of this kind, for `/warden unmute` without a model. */
  modelsWith(kind: SteerKind): string[] {
    return Object.entries(this.load().models).filter(([, kinds]) => kinds[kind]).map(([model]) => model);
  }
}

const percent = (part: number, whole: number) => `${whole ? Math.round((part / whole) * 100) : 0}%`;

export function formatMuted(pairs: readonly MutedPair[], config: SteersConfig): string {
  if (!config.adaptive) return "Adaptive steers: off.";
  if (!pairs.length) return "Adaptive steers: no steer kind is trace-only for any model.";
  const byModel = new Map<string, MutedPair[]>();
  for (const pair of pairs) byModel.set(pair.model, [...(byModel.get(pair.model) ?? []), pair]);
  const models = [...byModel].map(([model, list]) => `${model}: ${list.map(pair => `${pair.kind} (${pair.sent} steers, ${percent(pair.followed, pair.sent)} followed, ${percent(pair.disputed, pair.sent)} disputed)`).join(", ")}`);
  return `Adaptive steers, trace-only per model: ${models.join("; ")}. /warden unmute <kind> resets a pair.`;
}

// ── Outcome of a sent steer ──

/** One assistant message after the steer: its text and its tool calls. */
export interface AssistantView { text: string; calls: Array<{ name: string; input: Record<string, unknown> }> }

/** What the steer was about, for the follow check. */
export interface SteerSubject {
  /** The file the note named (rules, slop, security). */
  path?: string;
  /** The call the note was about (stuck, repeat): a different next call is a course change. */
  call?: { name: string; input: Record<string, unknown> };
  /** The tool or skill the conscience named. */
  capability?: { kind: "tool" | "skill"; id: string };
}

/** Agent replies that argue with a note instead of acting on it. The same pattern the field replays used. */
export const DISPUTE = /false positive|false alarm|no (real )?(credentials|secrets)|not (a |real )?(secret|credential|token)s?|(only|just) (placeholder|fixture|test|dummy|fake)|as (I )?(said|planned|stated)|matches (what I said|the plan)|this is expected|warden (is wrong|misfired|misread)|misfire|spurious|harmless|benign|nothing sensitive|not sensitive|was intended|intended/i;
const CHECK = /\b(test|tests|vitest|jest|pytest|build|lint|tsc|check|make|cargo|go test|flutter (test|analyze)|npm run|eslint|typecheck)\b/i;
const UNVERIFIED = /not (yet )?(verified|tested)|unverified|did not run|didn't run/i;
const REPLAN = /\b(instead|re-?plan(ned|ning)?|ask(ing)? (you|the user|first|before)|should I|do you want)\b/i;

const commandText = (input: Record<string, unknown>) => typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : JSON.stringify(input);

/**
 * Whether the next assistant messages (at most two) changed course after a steer of this kind, and whether they
 * disputed it. A port of the heuristic the field replays used; it is a proxy and does not prove the note caused the change.
 */
export function steerOutcome(kind: SteerKind, subject: SteerSubject, views: readonly AssistantView[]): { followed: boolean; disputed: boolean } {
  const text = views.map(view => view.text).join("\n");
  const calls = views.flatMap(view => view.calls);
  const disputed = DISPUTE.test(text);
  let followed = false;
  switch (kind) {
    case "done":
      followed = calls.some(call => call.name === "bash" && CHECK.test(commandText(call.input))) || UNVERIFIED.test(text);
      break;
    case "rules": case "slop": case "security-write": {
      const path = subject.path;
      followed = !!path && calls.some(call => /edit|write/i.test(call.name) ? commandText(call.input).endsWith(path) : call.name === "bash" && commandText(call.input).includes(path));
      break;
    }
    case "stuck": case "repeat": {
      const next = calls[0];
      followed = !!next && (!subject.call || next.name !== subject.call.name || commandText(next.input) !== commandText(subject.call.input));
      break;
    }
    case "intent-mismatch": case "off-task": case "should-proceed": case "warn-headless": case "large-output":
      followed = (!calls.length && /\?\s*$/.test(views[0]?.text ?? "")) || REPLAN.test(text);
      break;
    case "conscience": {
      const target = subject.capability;
      followed = !!target && calls.some(call => target.kind === "tool" ? call.name === target.id || call.name.endsWith(target.id) : commandText(call.input).includes(`/${target.id}/`));
      break;
    }
    case "loops":
      followed = calls.some(call => call.name === "warden_loops");
      break;
    default:
      followed = false;
  }
  return { followed, disputed };
}

interface Pending { model: string; kinds: SteerKind[]; subject: SteerSubject; views: AssistantView[]; waitUser: boolean }

/**
 * Sent steers waiting for the agent's next two messages. A steer queued for the next turn waits past the next user
 * message; any other steer that meets a user message first is settled on what it saw, or dropped when it saw nothing.
 */
export class SteerWatch {
  private pending: Pending[] = [];

  add(model: string, kinds: readonly SteerKind[], subject: SteerSubject = {}, options: { nextTurn?: boolean } = {}): void {
    if (!kinds.length) return;
    this.pending.push({ model, kinds: [...kinds], subject, views: [], waitUser: options.nextTurn === true });
    if (this.pending.length > 50) this.pending.shift();
  }

  /** Feeds one assistant message; returns the steers it settled. */
  assistant(view: AssistantView): Array<{ model: string; kind: SteerKind; followed: boolean; disputed: boolean }> {
    const settled: Array<{ model: string; kind: SteerKind; followed: boolean; disputed: boolean }> = [];
    const keep: Pending[] = [];
    for (const item of this.pending) {
      if (item.waitUser) { keep.push(item); continue; }
      item.views.push(view);
      const outcomes = item.kinds.map(kind => ({ kind, ...steerOutcome(kind, item.subject, item.views) }));
      if (item.views.length >= 2 || outcomes.every(outcome => outcome.followed || outcome.disputed)) {
        for (const outcome of outcomes) settled.push({ model: item.model, ...outcome });
      } else keep.push(item);
    }
    this.pending = keep;
    return settled;
  }

  /** A user message arrived. */
  user(): Array<{ model: string; kind: SteerKind; followed: boolean; disputed: boolean }> {
    const settled: Array<{ model: string; kind: SteerKind; followed: boolean; disputed: boolean }> = [];
    const keep: Pending[] = [];
    for (const item of this.pending) {
      if (item.waitUser) { item.waitUser = false; keep.push(item); continue; }
      if (item.views.length) for (const kind of item.kinds) settled.push({ model: item.model, kind, ...steerOutcome(kind, item.subject, item.views) });
    }
    this.pending = keep;
    return settled;
  }

  clear(): void { this.pending = []; }
}

/** The text and tool calls of an assistant message as Pi stores it. */
export function assistantView(content: unknown): AssistantView {
  if (typeof content === "string") return { text: content, calls: [] };
  if (!Array.isArray(content)) return { text: "", calls: [] };
  const text: string[] = [];
  const calls: AssistantView["calls"] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part?.type === "toolCall" && typeof part.name === "string") calls.push({ name: part.name, input: (part.arguments && typeof part.arguments === "object" ? part.arguments : {}) as Record<string, unknown> });
  }
  return { text: text.join("\n"), calls };
}
