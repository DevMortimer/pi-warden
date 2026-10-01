/**
 * Working memory without Jev: a tool result that a later call made out of date is replaced, in the model's context only,
 * by a one-line stub that says how to get the current content. Pi stores nothing of the change; the session keeps the
 * full result. Rules only, no requests.
 *
 * Three classes:
 *  - superseded: a later call of the same read-only tool (or read-only bash command) with the same input returned a newer result;
 *  - replaced: a later successful `write` of the same path, for earlier `read` results of that path;
 *  - edited: a later successful `edit` of the same path, for earlier `read` results of that path.
 *
 * Prompt cache: a change to an earlier message makes the cached prefix invalid from that message on, so the set of stubs
 * grows only at a cold point (the first model call after a compaction, or the first call of a run whose cache entry has
 * expired). Between those points every call gets the same stubs, so the prefix stays the same.
 */

export type StaleClass = "superseded" | "replaced" | "edited";

/** A stub is only worth its own length when the result is clearly longer than it. */
export const STUB_MIN_CHARS = 600;
/** Pi's own estimate: four characters per token. */
export const CHARS_PER_TOKEN = 4;

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
const READ_ONLY_HEADS: ReadonlySet<string> = new Set(["cat", "head", "tail", "ls", "wc", "grep", "rg", "pwd", "stat", "file", "du", "df", "which", "tree", "sort", "uniq", "cut", "echo", "date", "cd", "jq", "diff", "realpath", "basename", "dirname"]);
const GIT_READ_ONLY: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "describe", "shortlog", "ls-tree", "cat-file"]);

/** True for a command that only reads: every segment starts with a known reading program and nothing redirects or substitutes. */
export function readOnlyCommand(command: string): boolean {
  if (/[>`]|\$\(|<\(/.test(command) || /\btee\b/.test(command)) return false;
  const segments = command.split(/&&|\|\||[;|\n]/).map(segment => segment.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every(segment => {
    const words = segment.split(/\s+/);
    const head = words[0]!;
    if (head === "git") {
      const sub = words.slice(1).find(word => !word.startsWith("-"));
      return sub !== undefined && GIT_READ_ONLY.has(sub) && !words.includes("--output");
    }
    if (head === "find") return !words.some(word => /^-(exec|execdir|delete|ok|fprint|fprintf|fls)$/.test(word));
    return READ_ONLY_HEADS.has(head);
  });
}

type Part = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
type Message = { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown };

interface Call { tool: string; input: Record<string, unknown> }
export interface StubInfo { reason: StaleClass; text: string; chars: number; charsSaved: number }

/** The tool-call blocks of an assistant message, by id. */
function callsOf(message: Message, into: Map<string, Call>): void {
  if (!Array.isArray(message.content)) return;
  for (const part of message.content as Part[]) {
    if (part && part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
      into.set(part.id, { tool: part.name, input: part.arguments && typeof part.arguments === "object" ? part.arguments as Record<string, unknown> : {} });
    }
  }
}

/** Characters of a tool result's text, and whether it is text only (an image result is never stubbed). */
function sizeOf(content: unknown): { chars: number; plain: boolean } {
  if (typeof content === "string") return { chars: content.length, plain: true };
  if (!Array.isArray(content)) return { chars: 0, plain: false };
  let chars = 0;
  for (const part of content as Part[]) {
    if (part && part.type === "text" && typeof part.text === "string") chars += part.text.length;
    else return { chars, plain: false };
  }
  return { chars, plain: true };
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1))
  : item);

function pathOf(input: Record<string, unknown>, cwd: string | undefined): string | undefined {
  const raw = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
  if (!raw) return undefined;
  const text = raw.replace(/^@/, "").replace(/^\.\//, "");
  return text.startsWith("/") || !cwd ? text : `${cwd.replace(/\/+$/, "")}/${text}`;
}

const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

function describe(call: Call): string {
  const path = pathOf(call.input, undefined);
  if (path) return `${call.tool} of ${clip(path, 120)}`;
  const command = typeof call.input.command === "string" ? call.input.command : undefined;
  if (command) return `${call.tool} \`${clip(command, 100)}\``;
  return `${call.tool} call`;
}

function stubText(call: Call, reason: StaleClass, chars: number): string {
  const size = `about ${Math.ceil(chars / CHARS_PER_TOKEN)} tokens`;
  const what = describe(call);
  if (reason === "superseded") return `[pi-warden: stale result omitted (${size}): this ${what} was run again later, and the newer result is further down. To get the current output, run the call again.]`;
  if (reason === "replaced") return `[pi-warden: stale result omitted (${size}): this ${what} came before a later write that replaced the whole file, so none of it is current. Read the path again to get the current content.]`;
  return `[pi-warden: stale result omitted (${size}): this ${what} came before a later edit of the file, so part of it is still true and part is not. Read the path again when you need the text.]`;
}

export interface StaleOptions {
  /** Working directory, to match a relative path with an absolute one. */
  cwd?: string | undefined;
  /** Classes to apply; all when omitted. */
  classes?: readonly StaleClass[] | undefined;
}

/**
 * Every result in `messages` that a later call made out of date, with its stub. A result the model has not seen yet
 * (after the last assistant message) is never stubbed, and neither is a failed result. Never throws: an item it
 * cannot read is skipped.
 */
export function findStale(messages: readonly unknown[], options: StaleOptions = {}): Map<string, StubInfo> {
  const stale = new Map<string, StubInfo>();
  try {
    const classes = new Set<StaleClass>(options.classes ?? ["superseded", "replaced", "edited"]);
    const calls = new Map<string, Call>();
    let lastAssistant = -1;
    const results: Array<{ index: number; id: string; call: Call; failed: boolean; chars: number; plain: boolean }> = [];
    messages.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Message;
      if (message.role === "assistant") { lastAssistant = index; callsOf(message, calls); }
      else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        const call = calls.get(message.toolCallId);
        if (!call) return;
        const { chars, plain } = sizeOf(message.content);
        results.push({ index, id: message.toolCallId, call, failed: message.isError === true, chars, plain });
      }
    });
    // Last position of a successful call per key, and of a successful write or edit per path.
    const lastSame = new Map<string, number>();
    const lastWrite = new Map<string, number>();
    const lastEdit = new Map<string, number>();
    const keyOf = (call: Call): string | undefined => {
      if (READ_ONLY_TOOLS.has(call.tool)) return `${call.tool}\u0000${stable(call.input)}`;
      if (call.tool === "bash" && typeof call.input.command === "string" && readOnlyCommand(call.input.command)) return `bash\u0000${stable(call.input)}`;
      return undefined;
    };
    for (const result of results) {
      if (result.failed) continue;
      const key = keyOf(result.call);
      if (key) lastSame.set(key, result.index);
      const path = pathOf(result.call.input, options.cwd);
      if (path && result.call.tool === "write") lastWrite.set(path, result.index);
      if (path && result.call.tool === "edit") lastEdit.set(path, result.index);
    }
    for (const result of results) {
      if (result.failed || !result.plain || result.chars < STUB_MIN_CHARS || result.index > lastAssistant) continue;
      const key = keyOf(result.call);
      const path = result.call.tool === "read" ? pathOf(result.call.input, options.cwd) : undefined;
      let reason: StaleClass | undefined;
      if (classes.has("superseded") && key && (lastSame.get(key) ?? -1) > result.index) reason = "superseded";
      else if (classes.has("replaced") && path && (lastWrite.get(path) ?? -1) > result.index) reason = "replaced";
      else if (classes.has("edited") && path && (lastEdit.get(path) ?? -1) > result.index) reason = "edited";
      if (!reason) continue;
      const text = stubText(result.call, reason, result.chars);
      stale.set(result.id, { reason, text, chars: result.chars, charsSaved: Math.max(0, result.chars - text.length) });
    }
  } catch {
    // Fail open: nothing is stubbed.
  }
  return stale;
}

export interface StaleOutcome {
  /** The messages to send, or undefined when nothing changed. */
  messages: unknown[] | undefined;
  /** Set when the stub set grew at this call. */
  grew?: { stubbed: number; tokens: number; items: Array<{ id: string; reason: StaleClass; chars: number }> } | undefined;
}

export interface StaleTotals { points: number; stubbed: number; tokens: number }

/**
 * The stubs a session has committed to. A call at a cold point may add the results that are out of date now; any other
 * call applies only what was committed, so the messages stay the same between points. A committed result that is no
 * longer out of date (the branch changed) is sent in full.
 */
export class StaleResults {
  private committed = new Map<string, StaleClass>();
  readonly totals: StaleTotals = { points: 0, stubbed: 0, tokens: 0 };

  constructor(private readonly options: StaleOptions = {}) {}

  reset(): void {
    this.committed = new Map();
    this.totals.points = 0;
    this.totals.stubbed = 0;
    this.totals.tokens = 0;
  }

  apply(messages: readonly unknown[], cold: boolean): StaleOutcome {
    try {
      const stale = findStale(messages, this.options);
      let grew: StaleOutcome["grew"];
      if (cold) {
        let stubbed = 0;
        let chars = 0;
        const items: Array<{ id: string; reason: StaleClass; chars: number }> = [];
        for (const [id, info] of stale) {
          if (this.committed.has(id)) continue;
          this.committed.set(id, info.reason);
          stubbed++;
          chars += info.charsSaved;
          items.push({ id, reason: info.reason, chars: info.chars });
        }
        if (stubbed) {
          grew = { stubbed, tokens: Math.round(chars / CHARS_PER_TOKEN), items };
          this.totals.points++;
          this.totals.stubbed += stubbed;
          this.totals.tokens += grew.tokens;
        }
      }
      if (!this.committed.size) return { messages: undefined, grew };
      let changed = false;
      const next = messages.map(raw => {
        const message = raw as Message | null;
        if (!message || message.role !== "toolResult" || typeof message.toolCallId !== "string") return raw;
        const info = this.committed.has(message.toolCallId) ? stale.get(message.toolCallId) : undefined;
        if (!info) return raw;
        changed = true;
        return { ...message, content: [{ type: "text", text: info.text }] };
      });
      return { messages: changed ? next : undefined, grew };
    } catch {
      return { messages: undefined };
    }
  }
}

export interface ColdInput {
  /** Now, in milliseconds. */
  now: number;
  /** The newest time the prompt cache entry was written or read: the last model response, or the last cache-warming refresh. */
  lastTouch: number | undefined;
  /** The entry's lifetime, from the model's `promptCache`; undefined when the model has none (a provider cache of unknown lifetime, such as a disk cache, is not proven cold by any gap). */
  ttlMs: number | undefined;
}

/**
 * The first call of a run is cold when the entry's lifetime ran out since it was last touched. A warming refresh counts
 * as a touch, which is why a long gap alone does not prove a cold cache. With no time or no lifetime known, the call is
 * not cold: recorded sessions show disk and bridge caches that stay warm for an hour, so a guessed lifetime would
 * rewrite a warm cache.
 */
export function cacheIsCold(input: ColdInput): boolean {
  if (input.lastTouch === undefined || !Number.isFinite(input.lastTouch)) return false;
  if (input.ttlMs === undefined) return false;
  return input.now - input.lastTouch > input.ttlMs;
}
