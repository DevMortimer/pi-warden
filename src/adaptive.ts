import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "./atomic.js";
import { userConfigPath } from "./config.js";
import type { HostDirs } from "./host-dirs.js";
import { defaultHostDirs } from "./host-dirs.js";

/**
 * What the agent does after a notice: a course change, an argument, or nothing. Kept per model and kind, so
 * `/warden status` can say which notices the agent acts on. Nothing here changes whether a notice is reported.
 */

/** One kind of note to the agent. Finer than the steer guard: the `action` guard sends several unrelated notes. */
export type SteerKind =
  | "intent-mismatch" | "off-task" | "should-proceed" | "warn-headless" | "large-output"
  | "slop" | "rules" | "sensitive-path" | "security-write"
  | "stuck" | "repeat" | "done" | "cause" | "prose" | "conscience" | "loops" | "runaway" | "subagent"
  | "hold" | "confirm" | "deny" | "masking" | "credential-notice";

export const STEER_KINDS: readonly SteerKind[] = [
  "intent-mismatch", "off-task", "should-proceed", "warn-headless", "large-output", "slop", "rules", "sensitive-path",
  "security-write", "stuck", "repeat", "done", "cause", "prose", "conscience", "loops", "runaway", "subagent",
  "hold", "confirm", "deny", "masking", "credential-notice",
];

interface Counts { sent: number; followed: number; disputed: number }

export type PairState = Counts;

interface StoreFile { version: 1; models: Record<string, Partial<Record<SteerKind, PairState>>> }

export interface CountedPair extends Counts { model: string; kind: SteerKind }

/** Where the counts live: next to the user config, in pi-warden's data folder. `PI_WARDEN_STEER_STATS` overrides it. */
export function steerStatsPath(dirs: HostDirs = defaultHostDirs()): string {
  return process.env.PI_WARDEN_STEER_STATS ?? join(dirname(userConfigPath(dirs)), "steer-stats.json");
}

const zero = (): Counts => ({ sent: 0, followed: 0, disputed: 0 });

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
      writeFileAtomicSync(this.path, `${JSON.stringify(this.data)}\n`);
    } catch (error) {
      console.warn("pi-warden: steer stats write failed:", error instanceof Error ? error.message : String(error));
    }
  }

  /** The counts for one (model, kind) pair, for the trace line that says which notice this is. */
  pair(model: string, kind: SteerKind): PairState | undefined {
    return this.load().models[model]?.[kind];
  }

  private ensure(model: string, kind: SteerKind): PairState {
    const models = this.load().models;
    const kinds = models[model] ??= {};
    return kinds[kind] ??= zero();
  }

  /** One notice the agent was shown; `followed` and `disputed` read its next two messages. */
  observe(model: string, kind: SteerKind, outcome: { followed: boolean; disputed: boolean }): void {
    const pair = this.ensure(model, kind);
    pair.sent++;
    if (outcome.followed) pair.followed++;
    if (outcome.disputed) pair.disputed++;
    this.save();
  }

  /** Every pair with counts, per model and kind. */
  counts(): CountedPair[] {
    const out: CountedPair[] = [];
    for (const [model, kinds] of Object.entries(this.load().models)) {
      for (const [kind, pair] of Object.entries(kinds) as Array<[SteerKind, PairState]>) out.push({ model, kind, ...pair });
    }
    return out.sort((a, b) => a.model.localeCompare(b.model) || a.kind.localeCompare(b.kind));
  }
}

const percent = (part: number, whole: number) => `${whole ? Math.round((part / whole) * 100) : 0}%`;

export function formatSteerCounts(pairs: readonly CountedPair[]): string {
  if (!pairs.length) return "Notices followed: no notice has been shown to this model yet.";
  const byModel = new Map<string, CountedPair[]>();
  for (const pair of pairs) byModel.set(pair.model, [...(byModel.get(pair.model) ?? []), pair]);
  const models = [...byModel].map(([model, list]) => `${model}: ${list.map(pair => `${pair.kind} (${pair.sent} shown, ${percent(pair.followed, pair.sent)} followed, ${percent(pair.disputed, pair.sent)} disputed)`).join(", ")}`);
  return `Notices followed, per model: ${models.join("; ")}.`;
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
