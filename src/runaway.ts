import type { RunawayConfig } from "./config.js";
import { DEFAULT_TEMPLATES, renderTemplate, runawayTokens } from "./widget.js";

/**
 * Runaway guard: a model that degenerates mid-reply repeats the same block of text over and over without calling a tool,
 * and nothing else stops it before the token limit. The guard reads the stream, counts identical blocks with code only,
 * and stops the run when a block repeats past the threshold. No request leaves the machine.
 *
 * Calibration over 675 local sessions (2634 assistant text blocks of 300+ characters): the most repeated paragraph in an
 * ordinary reply occurs twice at most; the one runaway repeated its block 28 times. Thinking drafts code and repeats
 * paragraphs up to 7 times legitimately, so it has its own higher threshold.
 */

export type StreamKind = "text" | "thinking";

export interface RepeatSignal {
  count: number;
  /** Normalised block that repeated; empty when nothing qualified. */
  block: string;
}

export interface RunawayVerdict {
  kind: StreamKind;
  count: number;
  block: string;
  /** Characters streamed for this kind when the run was stopped. */
  chars: number;
  /** block: an identical paragraph; phrase: the text ends with one unit repeated back to back. */
  signal: "block" | "phrase";
}

/** Paragraphs shorter than this (normalised) are ignored: code fences, list markers, and short labels repeat legitimately. */
export const BLOCK_MIN_CHARS = 24;
/** Length of the trailing phrase whose recurrence is counted. */
export const PHRASE_CHARS = 60;
/** Characters streamed between two checks; keeps the per-token cost to a string append. */
export const CHECK_EVERY = 256;

const normalise = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The paragraph (blank-line separated, normalised, at least `minChars`) that occurs most often. */
export function repeatedBlock(text: string, minChars = BLOCK_MIN_CHARS): RepeatSignal {
  const counts = new Map<string, number>();
  let best: RepeatSignal = { count: 0, block: "" };
  for (const raw of text.split(/\n\s*\n/)) {
    const block = normalise(raw);
    if (block.length < minChars) continue;
    const count = (counts.get(block) ?? 0) + 1;
    counts.set(block, count);
    if (count > best.count) best = { count, block };
  }
  return best;
}

/**
 * Run-on repetition without paragraph breaks: the text ends with one unit repeated back to back. The trailing `chars`
 * locate the period (distance to their previous occurrence); the whole unit must match on every step back, so templated
 * sentences that share only a suffix ("item 3 … see below.", "item 4 … see below.") count once. Units shorter than
 * `minPeriod` (table separators, ellipses) are ignored.
 */
export function repeatedTail(text: string, chars = PHRASE_CHARS, minPeriod = BLOCK_MIN_CHARS): RepeatSignal {
  const normal = normalise(text);
  if (normal.length < chars * 2) return { count: 0, block: "" };
  const start = normal.length - chars;
  const phrase = normal.slice(start);
  const previous = normal.lastIndexOf(phrase, start - 1);
  if (previous === -1) return { count: 1, block: phrase };
  const period = start - previous;
  if (period < minPeriod) return { count: 1, block: phrase };
  const unit = normal.slice(-period);
  let count = 1;
  for (let end = normal.length - period; end >= period && normal.slice(end - period, end) === unit; end -= period) count++;
  return { count, block: unit };
}

/** The stronger of the two signals for one stream. */
export function findRepeats(text: string): RepeatSignal & { signal: "block" | "phrase" } {
  const block = repeatedBlock(text);
  const phrase = repeatedTail(text);
  return block.count >= phrase.count ? { ...block, signal: "block" } : { ...phrase, signal: "phrase" };
}

interface StreamState {
  text: string;
  checkedAt: number;
}

interface StreamEvent {
  type: string;
  delta?: string;
}

const fresh = (): Record<StreamKind, StreamState> => ({ text: { text: "", checkedAt: 0 }, thinking: { text: "", checkedAt: 0 } });

/** Follows one assistant message as it streams. `feed` is called per token and only appends; `check` runs every CHECK_EVERY characters. */
export class RunawayMonitor {
  private streams = fresh();
  private stoppedKind: StreamKind | undefined;

  reset(): void {
    this.streams = fresh();
    this.stoppedKind = undefined;
  }

  /** True once this message triggered a stop; later deltas from the same stream are ignored. */
  get stopped(): boolean {
    return this.stoppedKind !== undefined;
  }

  /** Text seen so far for one stream kind. */
  streamed(kind: StreamKind): string {
    return this.streams[kind].text;
  }

  /** Feeds one AssistantMessageEvent; returns the stream kind that has grown enough for a check, else undefined. */
  feed(event: StreamEvent): StreamKind | undefined {
    if (event.type === "start") { this.reset(); return undefined; }
    const kind: StreamKind | undefined = event.type.startsWith("text_") ? "text" : event.type.startsWith("thinking_") ? "thinking" : undefined;
    if (!kind) return undefined;
    const stream = this.streams[kind];
    if (event.type.endsWith("_start")) {
      if (stream.text) stream.text += "\n\n";
      return undefined;
    }
    if (!event.type.endsWith("_delta") || typeof event.delta !== "string") return undefined;
    stream.text += event.delta;
    return stream.text.length - stream.checkedAt >= CHECK_EVERY ? kind : undefined;
  }

  /** Judges one stream against the config; at most one verdict per message. */
  check(kind: StreamKind, config: RunawayConfig): RunawayVerdict | undefined {
    const stream = this.streams[kind];
    stream.checkedAt = stream.text.length;
    if (this.stoppedKind || stream.text.length < config.minChars) return undefined;
    const limit = kind === "text" ? config.repeats : config.thinkingRepeats;
    const found = findRepeats(stream.text);
    if (found.count < limit) return undefined;
    this.stoppedKind = kind;
    return { kind, count: found.count, block: found.block, chars: stream.text.length, signal: found.signal };
  }
}

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

/** Follow-up for the agent after its run was stopped. `recover` true: this message starts the next turn. */
export function runawayNudge(verdict: RunawayVerdict, recover: boolean): string {
  const what = `pi-warden stopped your reply: the same ${verdict.kind} block repeated ${verdict.count} times ("${clip(verdict.block, 80)}") and no tool was called.`;
  if (!recover) return `${what} The run was stopped again for this prompt and was not restarted. Wait for the user.`;
  return `${what} Do not restate what you are about to do. If a command is the next step, call the tool with it now. Otherwise answer in at most three sentences: the current state and the one next action, or a question for the user.`;
}

export function formatRunaway(verdict: RunawayVerdict, recovering: boolean, template: string = DEFAULT_TEMPLATES.runaway): string {
  return renderTemplate(template, runawayTokens(verdict, recovering));
}
