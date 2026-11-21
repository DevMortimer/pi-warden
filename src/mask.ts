import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ContextMaskConfig } from "./config.js";
import { classifyToolResult } from "./done.js";
import { commandFamily } from "./guard.js";
import { redact } from "./redact.js";
import { commandOf } from "./tools.js";

/**
 * Cache-aware epoch context masking: reclaims stale toolResult screenshots, superseded file reads,
 * and resolved bash check logs in memory before LLM calls without busting provider KV prompt caches.
 * Committed replacements freeze in a session map keyed by toolCallId and advance only at discrete
 * epoch boundaries once reclaimable bytes clear `minSweepBytes`, leaving the newest turns untouched.
 * Zero network requests, zero temp files, and never mutates user or custom messages.
 */

export interface MaskContentPart {
  type: string;
  text?: string | undefined;
  data?: string | undefined;
  mimeType?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
}

/** Structural slice of Pi's AgentMessage so this module stays independent of host runtime packages. */
export interface MaskMessage {
  role: string;
  content?: unknown;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  customType?: string | undefined;
}

export interface MaskSweepStats {
  /** Total items masked in this sweep (`images + reads + checks`); 0 when no sweep committed. */
  items: number;
  images: number;
  reads: number;
  checks: number;
  /** Newly reclaimed UTF-8 bytes committed in this sweep. */
  newBytesSaved: number;
  /** Total frozen toolResult replacements currently active in the prefix map. */
  totalFrozen: number;
  totalTurns: number;
  cutoffIndex: number;
}

export interface ContextMaskResult<T extends MaskMessage = MaskMessage> {
  messages: T[];
  /** True when at least one message in the returned list carries a masked replacement. */
  changed: boolean;
  /** True only when a new epoch sweep committed candidates on this call. */
  swept: boolean;
  /** True when an eligible epoch sweep was withheld by `silentTrial`. */
  suppressed: boolean;
  stats: MaskSweepStats;
}

export interface MaskApplyOptions {
  config: ContextMaskConfig;
  cwd: string;
  /** Optional silent-trial hook: returning true withholds the sweep and advances the epoch clock. */
  silentTrial?: ((summary: string) => boolean) | undefined;
}

interface ReadRange {
  full: boolean;
  offset: number;
  limit: number | undefined;
}

interface PathTouch {
  index: number;
  kind: "write" | "read";
  range?: ReadRange | undefined;
}

interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
}

interface Candidate {
  key: string;
  replacement: string | MaskContentPart[];
  bytesSaved: number;
  images: number;
  reads: number;
  checks: number;
}

const CHECK_HEAD_LINES = 5;
const CHECK_TAIL_LINES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentPart(value: unknown): value is MaskContentPart {
  return isRecord(value) && typeof value.type === "string";
}

function messageKey(message: MaskMessage): string {
  if (typeof message.toolCallId === "string" && message.toolCallId.length > 0) {
    return `id:${message.toolCallId}`;
  }
  const hash = createHash("sha256")
    .update(message.role)
    .update("\0")
    .update(typeof message.toolName === "string" ? message.toolName : "")
    .update("\0")
    .update(JSON.stringify(message.content ?? null))
    .digest("hex")
    .slice(0, 24);
  return `fallback:${hash}`;
}

function cloneContent(content: string | MaskContentPart[]): string | MaskContentPart[] {
  return typeof content === "string" ? content : content.map(part => ({ ...part }));
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function resolveToolPath(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim();
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? join(homedir(), trimmed.slice(2))
      : trimmed;
  return resolve(cwd, expanded);
}

function safePathLabel(resolvedPath: string, cwd: string): string {
  const rel = relative(resolve(cwd), resolvedPath);
  const inside = rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
  const label = inside ? rel.replace(/\\/g, "/") : basename(resolvedPath) || "file";
  return redact(label);
}

function pathOfInput(input: Record<string, unknown>): string | undefined {
  const raw = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
  return raw && raw.trim() ? raw : undefined;
}

function parseReadRange(input: Record<string, unknown>): ReadRange {
  const offset = typeof input.offset === "number" && Number.isFinite(input.offset) ? input.offset : undefined;
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0 ? input.limit : undefined;
  if (offset === undefined && limit === undefined) return { full: true, offset: 1, limit: undefined };
  return { full: false, offset: offset ?? 1, limit };
}

function readCovers(earlier: ReadRange, later: ReadRange): boolean {
  if (later.full) return true;
  if (earlier.full) return false;
  if (later.offset > earlier.offset) return false;
  if (later.limit === undefined) return true;
  if (earlier.limit === undefined) return false;
  return later.offset + later.limit >= earlier.offset + earlier.limit;
}

function formatKb(bytes: number): string {
  return bytes >= 1024 ? String(Math.round(bytes / 1024)) : (bytes / 1024).toFixed(1);
}

function replaceTextContent(content: unknown, replacement: string): string | MaskContentPart[] {
  if (typeof content === "string") return replacement;
  if (!Array.isArray(content)) return [{ type: "text", text: replacement }];
  const out: MaskContentPart[] = [];
  let inserted = false;
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      if (!inserted) {
        out.push({ type: "text", text: replacement });
        inserted = true;
      }
      continue;
    }
    if (isContentPart(part)) {
      out.push({ ...part });
    }
  }
  if (!inserted) out.push({ type: "text", text: replacement });
  return out;
}

function formatSweepSummary(images: number, reads: number, checks: number, bytesSaved: number): string {
  const items = images + reads + checks;
  const parts: string[] = [];
  if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  if (reads > 0) parts.push(`${reads} read${reads === 1 ? "" : "s"}`);
  if (checks > 0) parts.push(`${checks} check${checks === 1 ? "" : "s"}`);
  return `epoch mask sweep: ${items} item${items === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}, ${(bytesSaved / 1024).toFixed(1)} KB reclaimed`;
}

export class EpochMasker {
  private readonly frozen = new Map<string, string | MaskContentPart[]>();
  private _lastSweepTurn = 0;

  get frozenCount(): number {
    return this.frozen.size;
  }

  get lastSweepTurn(): number {
    return this._lastSweepTurn;
  }

  reset(): void {
    this.frozen.clear();
    this._lastSweepTurn = 0;
  }

  apply<T extends MaskMessage>(messages: readonly T[], options: MaskApplyOptions): ContextMaskResult<T> {
    const { config, cwd, silentTrial } = options;
    const emptyStats = (totalTurns: number, cutoffIndex: number): MaskSweepStats => ({
      items: 0,
      images: 0,
      reads: 0,
      checks: 0,
      newBytesSaved: 0,
      totalFrozen: this.frozen.size,
      totalTurns,
      cutoffIndex,
    });

    if (!config.enabled || messages.length === 0) {
      return { messages: messages as T[], changed: false, swept: false, suppressed: false, stats: emptyStats(0, 0) };
    }

    const assistantIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === "assistant") assistantIndices.push(i);
    }
    const totalTurns = assistantIndices.length;

    // Compaction or branch navigation shortened history: reset the epoch clock and drop stale frozen entries.
    if (totalTurns < this._lastSweepTurn) {
      this._lastSweepTurn = totalTurns;
      const present = new Set<string>();
      for (const message of messages) {
        if (message?.role === "toolResult") present.add(messageKey(message));
      }
      for (const key of this.frozen.keys()) {
        if (!present.has(key)) this.frozen.delete(key);
      }
    }

    const cutoffIndex = totalTurns <= config.keepRecentTurns
      ? 0
      : config.keepRecentTurns === 0
        ? messages.length
        : assistantIndices[totalTurns - config.keepRecentTurns]!;

    let swept = false;
    let sweepStats = emptyStats(totalTurns, cutoffIndex);

    if (totalTurns - this._lastSweepTurn >= config.epochTurns && cutoffIndex > 0) {
      const candidates = this.discoverCandidates(messages, cutoffIndex, totalTurns, config, cwd);
      const newBytesSaved = candidates.reduce((sum, c) => sum + c.bytesSaved, 0);
      const images = candidates.reduce((sum, c) => sum + c.images, 0);
      const reads = candidates.reduce((sum, c) => sum + c.reads, 0);
      const checks = candidates.reduce((sum, c) => sum + c.checks, 0);

      if (candidates.length > 0 && newBytesSaved >= config.minSweepBytes) {
        if (silentTrial?.(formatSweepSummary(images, reads, checks, newBytesSaved))) {
          // Advance the epoch clock so the silent arm records once per epoch and keeps messages whole.
          this._lastSweepTurn = totalTurns;
          return {
            messages: messages as T[],
            changed: false,
            swept: false,
            suppressed: true,
            stats: emptyStats(totalTurns, cutoffIndex),
          };
        }

        for (const candidate of candidates) {
          this.frozen.set(candidate.key, candidate.replacement);
        }
        this._lastSweepTurn = totalTurns;
        swept = true;
        sweepStats = {
          items: images + reads + checks,
          images,
          reads,
          checks,
          newBytesSaved,
          totalFrozen: this.frozen.size,
          totalTurns,
          cutoffIndex,
        };
      }
    }

    if (this.frozen.size === 0 || cutoffIndex === 0) {
      return { messages: messages as T[], changed: false, swept: false, suppressed: false, stats: sweepStats };
    }

    let changed = false;
    const out = messages.slice();
    for (let i = 0; i < cutoffIndex; i++) {
      const message = messages[i];
      if (!message || message.role !== "toolResult") continue;
      const replacement = this.frozen.get(messageKey(message));
      if (replacement === undefined) continue;
      changed = true;
      out[i] = { ...message, content: cloneContent(replacement) };
    }

    return {
      messages: changed ? out : (messages as T[]),
      changed,
      swept,
      suppressed: false,
      stats: sweepStats,
    };
  }

  /** Single O(N) index pass over `messages`, then evaluates only un-frozen `toolResult` messages before `cutoffIndex`. */
  private discoverCandidates(
    messages: readonly MaskMessage[],
    cutoffIndex: number,
    totalTurns: number,
    config: ContextMaskConfig,
    cwd: string,
  ): Candidate[] {
    const calls = new Map<string, ToolCallInfo>();
    const pathTouches = new Map<string, PathTouch[]>();
    const lastPassingCheckByFamily = new Map<string, number>();
    const bashCheckMeta = new Map<number, { family: string; isCheck: boolean }>();
    const assistantCountBefore = new Int32Array(messages.length);

    let seenAssistants = 0;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      assistantCountBefore[i] = seenAssistants;
      if (!message) continue;

      if (message.role === "assistant") {
        seenAssistants++;
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
            calls.set(part.id, { name: part.name, input: isRecord(part.arguments) ? part.arguments : {} });
          }
        }
        continue;
      }

      if (message.role !== "toolResult") continue;
      const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
      const toolName = call?.name ?? (typeof message.toolName === "string" ? message.toolName : "");
      const input = call?.input ?? {};

      if (config.supersededReads && !message.isError && (toolName === "read" || toolName === "write")) {
        const rawPath = pathOfInput(input);
        if (rawPath) {
          const resolved = resolveToolPath(rawPath, cwd);
          let list = pathTouches.get(resolved);
          if (!list) {
            list = [];
            pathTouches.set(resolved, list);
          }
          list.push(toolName === "write" ? { index: i, kind: "write" } : { index: i, kind: "read", range: parseReadRange(input) });
        }
      }

      if (config.resolvedChecks && toolName === "bash") {
        const command = commandOf("bash", input)?.command;
        const family = command ? commandFamily(command) : undefined;
        if (family) {
          const text = extractText(message.content);
          const outcome = classifyToolResult("bash", input, Boolean(message.isError), text, cwd);
          if (outcome === "check-pass") {
            lastPassingCheckByFamily.set(family, i);
          }
          if (i < cutoffIndex && (outcome === "check-fail" || outcome === "check-pass")) {
            bashCheckMeta.set(i, { family, isCheck: true });
          }
        }
      }
    }

    const candidates: Candidate[] = [];
    for (let i = 0; i < cutoffIndex; i++) {
      const message = messages[i];
      if (!message || message.role !== "toolResult") continue;
      const key = messageKey(message);
      if (this.frozen.has(key)) continue;

      const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
      const toolName = call?.name ?? (typeof message.toolName === "string" ? message.toolName : "");
      const input = call?.input ?? {};

      let workingContent: unknown = message.content;
      let bytesSaved = 0;
      let images = 0;
      let reads = 0;
      let checks = 0;

      // (a) Stale toolResult images only — user/custom messages are skipped above.
      if (config.images && Array.isArray(workingContent)) {
        const turnsAgo = Math.max(0, totalTurns - assistantCountBefore[i]!);
        let replacedAnyImage = false;
        const nextParts: MaskContentPart[] = [];
        for (const part of workingContent) {
          if (isRecord(part) && part.type === "image" && typeof part.data === "string") {
            const bytes = Buffer.byteLength(part.data, "utf8");
            const mime = typeof part.mimeType === "string" && part.mimeType.trim() ? part.mimeType.trim() : "image";
            const note = `[pi-warden: earlier tool image (~${formatKb(bytes)} KB ${mime}) masked after ${turnsAgo} turns; re-read or capture again if still needed]`;
            const saved = Math.max(0, bytes - Buffer.byteLength(note, "utf8"));
            nextParts.push({ type: "text", text: note });
            bytesSaved += saved;
            images++;
            replacedAnyImage = true;
          } else if (isContentPart(part)) {
            nextParts.push({ ...part });
          }
        }
        if (replacedAnyImage) workingContent = nextParts;
      }

      // (b) Superseded read results.
      if (config.supersededReads && !message.isError && toolName === "read") {
        const rawPath = pathOfInput(input);
        const text = extractText(message.content);
        if (rawPath && text.length >= config.minObsChars) {
          const resolved = resolveToolPath(rawPath, cwd);
          const earlierRange = parseReadRange(input);
          const touches = pathTouches.get(resolved) ?? [];
          const superseded = touches.some(touch => touch.index > i && (touch.kind === "write" || (touch.range !== undefined && readCovers(earlierRange, touch.range))));
          if (superseded) {
            const lines = text.split("\n").length;
            const note = `[pi-warden: superseded read of ${safePathLabel(resolved, cwd)} (${lines} lines, ${text.length} chars) masked; newer file content appears later in context]`;
            const saved = Buffer.byteLength(text, "utf8") - Buffer.byteLength(note, "utf8");
            if (saved > 0) {
              workingContent = replaceTextContent(workingContent, note);
              bytesSaved += saved;
              reads++;
            }
          }
        }
      }

      // (c) Resolved bash check outputs.
      if (config.resolvedChecks && toolName === "bash") {
        const meta = bashCheckMeta.get(i);
        const lastPass = meta ? lastPassingCheckByFamily.get(meta.family) : undefined;
        if (meta?.isCheck && lastPass !== undefined && lastPass > i) {
          const text = extractText(message.content);
          if (text.length >= config.minObsChars) {
            const allLines = text.split("\n");
            const omittedLines = allLines.length - (CHECK_HEAD_LINES + CHECK_TAIL_LINES);
            if (omittedLines > 0) {
              const head = allLines.slice(0, CHECK_HEAD_LINES).join("\n");
              const tail = allLines.slice(-CHECK_TAIL_LINES).join("\n");
              const note = `${head}\n[pi-warden: ${omittedLines} lines of superseded ${meta.family} output masked; a newer passing ${meta.family} check appears later in context]\n${tail}`;
              const saved = Buffer.byteLength(text, "utf8") - Buffer.byteLength(note, "utf8");
              if (saved > 0) {
                workingContent = replaceTextContent(workingContent, note);
                bytesSaved += saved;
                checks++;
              }
            }
          }
        }
      }

      if (images > 0 || reads > 0 || checks > 0) {
        candidates.push({
          key,
          replacement: typeof workingContent === "string" || Array.isArray(workingContent)
            ? (workingContent as string | MaskContentPart[])
            : [],
          bytesSaved,
          images,
          reads,
          checks,
        });
      }
    }

    return candidates;
  }
}

/** One-shot stateless helper for standalone evaluation and tests. */
export function maskContext<T extends MaskMessage>(messages: readonly T[], options: MaskApplyOptions): ContextMaskResult<T> {
  return new EpochMasker().apply(messages, options);
}
