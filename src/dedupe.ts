/**
 * Repeated-run detection: a new tool result or message that pastes again a long block the agent already has in context
 * (a relayed report that quotes every earlier turn) keeps only its new part. Exact line matches only, after trimming
 * trailing spaces; near-duplicates are never collapsed. Deterministic; no requests.
 */

/** A run shorter than this, in lines or characters, is kept: a short repeat costs less than the pointer that replaces it. */
export const RUN_MIN_LINES = 20;
export const RUN_MIN_CHARS = 1500;
/** Errors and verdicts usually sit at the end of a result, so the last characters are never replaced. */
export const TAIL_KEEP_CHARS = 2000;
/**
 * Providers whose host swaps a tool result over its output limit for a "saved to file" message: the model never gets
 * that text, so it is not seen. claude-bridge runs Pi tools as Claude Code MCP tools, and nothing in the session marks the swap.
 */
const SWAPPING_PROVIDERS = new Set(["claude-bridge"]);
// Claude Code saves an MCP result over 50,000 characters or MAX_MCP_OUTPUT_TOKENS (25,000 by default) to a file; 20,000 stays under both even at 1.25 characters per token.
export const SWAP_LIMIT_CHARS = 20_000;
/** A file in a Claude Code session's tool-results directory, where it saves a swapped result. */
const SAVED_RESULT = /\/projects\/[^/\s"'\\]+\/[^/\s"'\\]+\/tool-results\/[^/\s"'\\]+/;

export interface RepeatedRun {
  /** First line of the run in the new text, 0-based. */
  start: number;
  lines: number;
  chars: number;
  /** Where the earlier copy is, e.g. "an earlier bash result". */
  where: string;
}

/** One text the agent has in context, with a stable identity so a sync adds it once. */
export interface SeenItem {
  key: unknown;
  where: string;
  texts: string[];
}

const BASE = 1_000_003;
/** BASE^(RUN_MIN_LINES - 1) mod 2^32, for the rolling window hash. */
const TOP = (() => { let power = 1; for (let index = 1; index < RUN_MIN_LINES; index++) power = Math.imul(power, BASE); return power; })();
/** Several earlier copies of one window are enough to find the longest match; more only cost memory. */
const MAX_POSITIONS = 4;

/** Hash of every RUN_MIN_LINES-line window, by start line. */
function windowHashes(ids: number[]): number[] {
  const hashes: number[] = [];
  if (ids.length < RUN_MIN_LINES) return hashes;
  let hash = 0;
  for (let index = 0; index < RUN_MIN_LINES; index++) hash = (Math.imul(hash, BASE) + ids[index]!) | 0;
  hashes.push(hash);
  for (let index = RUN_MIN_LINES; index < ids.length; index++) {
    hash = (Math.imul((hash - Math.imul(ids[index - RUN_MIN_LINES]!, TOP)) | 0, BASE) + ids[index]!) | 0;
    hashes.push(hash);
  }
  return hashes;
}

export class SeenText {
  /** Interned normalized lines; ids start at 1 so 0 marks a line never seen. */
  private readonly lineIds = new Map<string, number>();
  private readonly docs: Array<{ where: string; ids: number[] }> = [];
  private readonly windows = new Map<number, Array<[doc: number, line: number]>>();
  private readonly keys = new Set<unknown>();

  clear(): void {
    this.lineIds.clear();
    this.docs.length = 0;
    this.windows.clear();
    this.keys.clear();
  }

  /** Match the index to what is in context now: a compaction or a move to another branch drops texts, so it rebuilds. */
  sync(items: SeenItem[]): void {
    const current = new Set(items.map(item => item.key));
    for (const key of this.keys) if (!current.has(key)) { this.clear(); break; }
    for (const item of items) {
      if (this.keys.has(item.key)) continue;
      this.keys.add(item.key);
      for (const text of item.texts) this.add(text, item.where);
    }
  }

  add(text: string, where: string): void {
    const lines = text.split("\n");
    if (lines.length < RUN_MIN_LINES) return;
    const ids = lines.map(line => {
      const normalized = line.trimEnd();
      let id = this.lineIds.get(normalized);
      if (id === undefined) { id = this.lineIds.size + 1; this.lineIds.set(normalized, id); }
      return id;
    });
    const doc = this.docs.push({ where, ids }) - 1;
    windowHashes(ids).forEach((hash, line) => {
      const positions = this.windows.get(hash);
      if (!positions) this.windows.set(hash, [[doc, line]]);
      else if (positions.length < MAX_POSITIONS) positions.push([doc, line]);
    });
  }

  /** Runs of `text` that repeat one earlier text exactly, longest match first at each position, outside the kept tail. */
  find(text: string): RepeatedRun[] {
    const lines = text.split("\n");
    const cutoff = text.length - TAIL_KEEP_CHARS;
    let limit = 0;
    for (let offset = 0; limit < lines.length; limit++) {
      const end = offset + lines[limit]!.length + 1;
      if (end > cutoff) break;
      offset = end;
    }
    if (limit < RUN_MIN_LINES) return [];
    const ids = lines.slice(0, limit).map(line => this.lineIds.get(line.trimEnd()) ?? 0);
    const hashes = windowHashes(ids);
    const runs: RepeatedRun[] = [];
    let index = 0;
    while (index + RUN_MIN_LINES <= limit) {
      let best: { doc: number; length: number } | undefined;
      for (const [doc, line] of this.windows.get(hashes[index]!) ?? []) {
        const seen = this.docs[doc]!.ids;
        let length = 0;
        while (index + length < limit && line + length < seen.length && ids[index + length] !== 0 && ids[index + length] === seen[line + length]) length++;
        if (length >= RUN_MIN_LINES && (!best || length > best.length)) best = { doc, length };
      }
      if (best) {
        let chars = 0;
        for (let line = index; line < index + best.length; line++) chars += lines[line]!.length + 1;
        if (chars >= RUN_MIN_CHARS) {
          runs.push({ start: index, lines: best.length, chars, where: this.docs[best.doc]!.where });
          index += best.length;
          continue;
        }
      }
      index++;
    }
    return runs;
  }
}

/** Replaces each run with one pointer line; `path` holds the full original text. */
export function collapseRuns(text: string, runs: RepeatedRun[], path: string): string {
  if (!runs.length) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let index = 0;
  for (const run of runs) {
    kept.push(...lines.slice(index, run.start), `[pi-warden: the next ${run.lines} lines repeat ${run.where} — omitted; full text: ${path}]`);
    index = run.start + run.lines;
  }
  kept.push(...lines.slice(index));
  return kept.join("\n");
}

type Part = { type: string; text?: string };

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return (content as Part[]).filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text!);
}

/** Whether `text` (a tool input) names a result file that `provider` saved instead of giving it to the model. */
export function savedResultIn(text: string, provider: string | undefined): boolean {
  return provider !== undefined && SWAPPING_PROVIDERS.has(provider) && SAVED_RESULT.test(text);
}

/**
 * The seen items of a branch, without a tool result the model did not get: one over the output limit of the provider
 * of the assistant message that called it. `provider` stands in when no assistant message names one.
 */
export function seenItems(entries: unknown[], provider: string | undefined): SeenItem[] {
  const items: SeenItem[] = [];
  let caller = provider;
  for (const entry of entries) {
    const message = (entry as { message?: { role?: unknown; provider?: unknown } } | undefined)?.message;
    if (message?.role === "assistant") caller = typeof message.provider === "string" ? message.provider : provider;
    const item = seenItem(entry);
    if (!item) continue;
    if (message?.role === "toolResult" && caller !== undefined && SWAPPING_PROVIDERS.has(caller)
      && item.texts.reduce((sum, text) => sum + text.length, 0) > SWAP_LIMIT_CHARS) continue;
    items.push(item);
  }
  return items;
}

/** The texts a session entry puts in context and where the agent saw them. Thinking, images, and summaries are not indexed. */
export function seenItem(entry: unknown): SeenItem | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as { id?: unknown; type?: unknown; customType?: unknown; content?: unknown; message?: { role?: unknown; toolName?: unknown; customType?: unknown; content?: unknown } };
  const key = typeof record.id === "string" ? record.id : entry;
  if (record.type === "custom_message") return { key, where: `an earlier ${String(record.customType ?? "custom")} message`, texts: textsOf(record.content) };
  if (record.type !== "message" || !record.message) return undefined;
  const { role } = record.message;
  const where = role === "toolResult" ? `an earlier ${String(record.message.toolName ?? "tool")} result`
    : role === "user" ? "an earlier user message"
    : role === "assistant" ? "an earlier assistant reply"
    : role === "custom" ? `an earlier ${String(record.message.customType ?? "custom")} message`
    : undefined;
  return where ? { key, where, texts: textsOf(record.message.content) } : undefined;
}
