import {
  DEFAULT_BACKEND_LIMITS,
  TypeSafeIntegrationError,
  evaluateAll,
  evaluateMany,
  localDay,
  prepareEvaluationRequest,
  type BackendLimits,
  type BatchEvaluation,
  type BatchOptions,
  type Evaluation,
  type EvaluationOptions,
  type Questions,
  type SpendReport,
  type SystemOneRequest,
  type TypeSafe,
  type Usage,
  type UsageSnapshot,
} from "pi-typesafe";
import type { LocalModelConfig } from "./config.js";
import type { HostDirs } from "./host-dirs.js";
import { getWardenS1Status } from "./local-model.js";
import type { WardenS1Status } from "./local-model.js";
import { redact } from "./redact.js";
import { ensureWardenS1Daemon } from "./warden-s1-daemon.js";
import type { DaemonEndpoint, EnsureDaemonOptions } from "./warden-s1-daemon.js";

export const MAX_PREFIX_TOKENS = 120_000;
export const COMPACT_UNPINNED_BLOCK_TOKENS = 48_000;
export const COMPACT_KEEP_BUDGET_TOKENS = 8_000;
export const SALIENCE_KEEP_THRESHOLD = 0.80;
export const ABSTENTION_HALF_BAND = 0.08;
export const LOCAL_MAX_INPUT_BYTES = 2_097_152;
export const ABSTENTION_REASON = "insufficient evidence in transcript";

const EXCERPT_MAX_CHARS = 140;
const FLOAT_EPSILON = 1e-12;
const MAX_COMPACTION_ITERATIONS = 32;
const MAX_COALESCED_PREWARM_PASSES = 16;
// A daemon that failed to start is left alone this long, so a broken install costs one spawn per window, not one per turn.
const DAEMON_RETRY_MS = 30_000;
export const MOCK_WEIGHTS_ENV = "PI_WARDEN_S1_MOCK_WEIGHTS";

export interface WardenS1Endpoint {
  readonly url: string;
  readonly token: string;
  readonly modelId: string;
}

export type ResolveWardenS1Endpoint = (signal?: AbortSignal) => Promise<WardenS1Endpoint | null | undefined>;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SessionTurnInput {
  readonly turnIndex: number;
  readonly role: "user" | "assistant" | "tool";
  readonly tool?: string | undefined;
  readonly text: string;
  readonly excerpt?: string | undefined;
  readonly tokenEstimate?: number | undefined;
}

export interface SessionChunk {
  index: number;
  readonly turnIndex: number;
  readonly role: string;
  readonly tool?: string | undefined;
  readonly label: string;
  readonly excerpt: string;
  charStart: number;
  charEnd: number;
  readonly pinned: boolean;
  readonly tokens: number;
  readonly rendered: string;
  salience?: number | undefined;
}

export interface SessionChunkDescriptor {
  readonly index: number;
  readonly turnIndex: number;
  readonly role: string;
  readonly tool?: string | undefined;
  readonly label: string;
  readonly charStart: number;
  readonly charEnd: number;
  /** The daemon workers read spans in snake_case; without them every chunk falls back to the whole state. */
  readonly char_start: number;
  readonly char_end: number;
}

function describeChunk(chunk: { index: number; turnIndex: number; role: string; tool?: string | undefined; label: string; charStart: number; charEnd: number }): SessionChunkDescriptor {
  return {
    index: chunk.index,
    turnIndex: chunk.turnIndex,
    role: chunk.role,
    ...(chunk.tool ? { tool: chunk.tool } : {}),
    label: chunk.label,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    char_start: chunk.charStart,
    char_end: chunk.charEnd,
  };
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly cycles: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly droppedCount: number;
  readonly keptCount: number;
}

export interface PrewarmResult {
  readonly ok: boolean;
  readonly skipped?: boolean | undefined;
  readonly recheckpointed?: boolean | undefined;
  readonly prefixTokens: number;
  readonly cacheMode?: string | undefined;
  readonly boundaryHealed?: boolean | undefined;
  readonly error?: string | undefined;
}

export interface SessionTrackerOptions {
  readonly sessionId: string;
  readonly pinnedHeader?: string | undefined;
  readonly resolveEndpoint?: ResolveWardenS1Endpoint | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly maxPrefixTokens?: number | undefined;
  readonly compactUnpinnedBlockTokens?: number | undefined;
  readonly compactKeepBudgetTokens?: number | undefined;
  readonly salienceKeepThreshold?: number | undefined;
}

export type NoulAbstentionPolarity = "risk" | "proceed" | "approval";

export interface LocusCitation {
  readonly turnIndex: number;
  readonly chunkIndex: number;
  readonly role: string;
  readonly tool?: string | undefined;
  readonly probability: number;
  readonly excerpt: string;
  readonly summary: string;
}

export interface WardenS1EvalMeta {
  readonly locusByQuestion: Readonly<Record<string, LocusCitation>>;
  readonly topLocus?: LocusCitation | undefined;
  readonly abstentions: Readonly<Record<string, string>>;
  readonly rawNoul: Readonly<Record<string, number>>;
  readonly cacheMode?: string | undefined;
  readonly boundaryHealed?: boolean | undefined;
  readonly prefixTokens: number;
  readonly deltaTokens?: number | undefined;
}

export interface WardenS1JudgeOptions {
  readonly sessionTracker: WardenS1SessionTracker;
  readonly resolveEndpoint: ResolveWardenS1Endpoint;
  readonly fetchImpl?: FetchLike | undefined;
  readonly fallbackJudge?: TypeSafe | undefined;
  readonly maxInputBytes?: number | undefined;
  readonly limits?: BackendLimits | undefined;
  readonly noulPolarity?: Readonly<Record<string, NoulAbstentionPolarity>> | undefined;
}

export interface WardenS1Judge extends TypeSafe {
  readonly sessionTracker: WardenS1SessionTracker;
  getLastEvaluationMeta(): WardenS1EvalMeta | undefined;
  getMetaForAnswers(answers: unknown): WardenS1EvalMeta | undefined;
}

const ANSWER_META = new WeakMap<object, WardenS1EvalMeta>();

export function getMetaForAnswers(answers: unknown): WardenS1EvalMeta | undefined {
  return answers !== null && typeof answers === "object" ? ANSWER_META.get(answers) : undefined;
}

/** Carries the Warden-S1 meta of each part onto an answers object merged from them; a cloud answer has none and adds nothing. */
export function mergeAnswerMeta(merged: object, parts: readonly unknown[]): void {
  const metas = parts.map(getMetaForAnswers).filter((meta): meta is WardenS1EvalMeta => meta !== undefined);
  const first = metas[0];
  if (!first) return;
  if (metas.length === 1) {
    ANSWER_META.set(merged, first);
    return;
  }
  let topLocus: LocusCitation | undefined;
  for (const meta of metas) {
    if (meta.topLocus && (!topLocus || meta.topLocus.probability > topLocus.probability)) topLocus = meta.topLocus;
  }
  ANSWER_META.set(merged, {
    ...first,
    locusByQuestion: Object.assign({}, ...metas.map(meta => meta.locusByQuestion)) as Record<string, LocusCitation>,
    ...(topLocus ? { topLocus } : {}),
    abstentions: Object.assign({}, ...metas.map(meta => meta.abstentions)) as Record<string, string>,
    rawNoul: Object.assign({}, ...metas.map(meta => meta.rawNoul)) as Record<string, number>,
  });
}

/** What a guard shows of a Warden-S1 answer: the turn its flag points at, and the probes that abstained. */
export interface WardenS1Notes {
  readonly locus?: string;
  readonly abstained?: string;
}

/**
 * The notes of one judged answer, or undefined for a cloud answer. `flaggedBy` names the questions behind a flag, most
 * telling first; leave it out when the guard flagged nothing, and no turn is cited.
 */
export function wardenS1Notes(answers: unknown, flaggedBy?: readonly string[]): WardenS1Notes | undefined {
  const meta = getMetaForAnswers(answers);
  if (!meta) return undefined;
  const abstainedIds = Object.keys(meta.abstentions);
  const abstained = abstainedIds.length
    ? `abstained: ${ABSTENTION_REASON} (${abstainedIds.map(id => `${id} ${(meta.rawNoul[id] ?? 0.5).toFixed(2)}`).join(", ")})`
    : undefined;
  const cited = flaggedBy === undefined
    ? undefined
    : flaggedBy.map(id => meta.locusByQuestion[id]).find(citation => citation !== undefined) ?? meta.topLocus;
  if (!cited && !abstained) return undefined;
  return { ...(cited ? { locus: `Locus: ${cited.summary}` } : {}), ...(abstained ? { abstained } : {}) };
}

/** The notes as trace detail lines. */
export function wardenS1NoteLines(notes: WardenS1Notes | undefined): string[] {
  return [notes?.locus, notes?.abstained].filter((line): line is string => line !== undefined);
}

export function isEpistemicAbstention(probability: number): boolean {
  // Subtract FLOAT_EPSILON so IEEE-754 representation of 0.58 - 0.5 does not make the (0.42, 0.58) band asymmetric.
  return Number.isFinite(probability) && Math.abs(probability - 0.5) < ABSTENTION_HALF_BAND - FLOAT_EPSILON;
}

const PROCEED_NOUL_IDS = new Set(["should_proceed", "progress", "checked", "has_material_progress"]);
const APPROVAL_NOUL_RE = /^(?:approved?|reply_points_at_action|clean|safe|declassif\w*|allow\w*|is_safe_\w+)$/i;

export function resolveNoulPolarity(
  questionId: string,
  overrides?: Readonly<Record<string, NoulAbstentionPolarity>>,
): NoulAbstentionPolarity {
  const explicit = overrides?.[questionId];
  if (explicit !== undefined) return explicit;
  if (PROCEED_NOUL_IDS.has(questionId)) return "proceed";
  if (APPROVAL_NOUL_RE.test(questionId)) return "approval";
  return "risk";
}

function neutralizeAbstainedProbability(polarity: NoulAbstentionPolarity): number {
  if (polarity === "proceed") return 1.0;
  if (polarity === "approval") return 0.5;
  return 0.0;
}

function sanitizeAttr(value: string): string {
  return value.replace(/["\r\n]/g, " ").trim();
}

function clipExcerpt(redactedText: string, maxChars = EXCERPT_MAX_CHARS): string {
  const sample = redactedText.length > maxChars * 8 ? redactedText.slice(0, maxChars * 8) : redactedText;
  const clean = sample.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function makeExcerpt(text: string, maxChars = EXCERPT_MAX_CHARS): string {
  return clipExcerpt(redact(text), maxChars);
}

export function formatLocusCitation(locus: Omit<LocusCitation, "summary"> | LocusCitation): string {
  const source = locus.tool ? sanitizeAttr(locus.tool) : locus.role;
  const excerpt = makeExcerpt(locus.excerpt, EXCERPT_MAX_CHARS).replace(/"/g, "'");
  return `Turn #${locus.turnIndex} (${source}, locus ${locus.probability.toFixed(2)}): "${excerpt}"`;
}

function estimateTokens(text: string, explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function formatTurnBlock(turnIndex: number, role: string, redactedBody: string, tool?: string, pinned?: boolean): string {
  const attrs = [`index="${turnIndex}"`, `role="${sanitizeAttr(role)}"`];
  if (tool) attrs.push(`tool="${sanitizeAttr(tool)}"`);
  if (pinned) attrs.push(`pinned="true"`);
  return `<turn ${attrs.join(" ")}>\n${redactedBody}\n</turn>`;
}

function fallbackSalienceScore(chunk: SessionChunk): number {
  if (chunk.pinned) return 1.0;
  const text = chunk.rendered;
  if (/\b(?:ignore previous instructions|prompt injection|exfiltrat|credential|secret|taint|untrusted|override|bypass|--no-verify|rm -rf|drop table|force push)\b/i.test(text)) {
    return 0.92;
  }
  if (/\b(?:must not|never |constraint|policy|rule|skip(?:ped)? test|failed|error:|blocked|denied)\b/i.test(text)) {
    return 0.84;
  }
  if (chunk.role === "user") return 0.82;
  return 0.20;
}

function extractSalienceArray(body: unknown, expectedCount: number): number[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  const s1 = obj.s1 && typeof obj.s1 === "object" ? (obj.s1 as Record<string, unknown>) : undefined;
  const candidates: unknown[] = [
    s1?.salience,
    obj.salience,
    obj.chunk_probs,
    obj.chunkProbs,
    obj.scores,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      const parsed = candidate.map((entry) => {
        if (typeof entry === "number" && Number.isFinite(entry)) return entry;
        if (entry && typeof entry === "object") {
          const rec = entry as Record<string, unknown>;
          const v = rec.score ?? rec.probability ?? rec.salience;
          if (typeof v === "number" && Number.isFinite(v)) return v;
        }
        return Number.NaN;
      });
      if (parsed.some(Number.isFinite)) return parsed.slice(0, expectedCount);
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const rec = candidate as Record<string, unknown>;
      const nested = rec.chunkProbs ?? rec.chunk_probs ?? rec.scores;
      if (Array.isArray(nested) && nested.length > 0) {
        const parsed = nested.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN));
        if (parsed.some(Number.isFinite)) return parsed.slice(0, expectedCount);
      }
    }
  }
  return undefined;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class WardenS1SessionTracker {
  private _sessionId: string;
  private readonly resolveEndpoint?: ResolveWardenS1Endpoint | undefined;
  private readonly fetchImpl: FetchLike;
  readonly maxPrefixTokens: number;
  readonly compactUnpinnedBlockTokens: number;
  readonly compactKeepBudgetTokens: number;
  readonly salienceKeepThreshold: number;

  private _chunks: SessionChunk[] = [];
  private _prefixText = "";
  private _totalTokens = 0;
  private _needsRecheckpoint = false;
  private _compactionCount = 0;
  private _prewarmCount = 0;
  private _prewarmVersion = 0;
  private _lastPrewarmedVersion = -1;
  private _prewarmDirty = false;
  private _prewarmInFlight: Promise<PrewarmResult> | null = null;
  private _compactionInFlight: Promise<CompactionResult> | null = null;
  private _lastPrewarmError: string | undefined;

  constructor(options: SessionTrackerOptions) {
    this._sessionId = options.sessionId;
    this.resolveEndpoint = options.resolveEndpoint;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxPrefixTokens = options.maxPrefixTokens ?? MAX_PREFIX_TOKENS;
    this.compactUnpinnedBlockTokens = options.compactUnpinnedBlockTokens ?? COMPACT_UNPINNED_BLOCK_TOKENS;
    this.compactKeepBudgetTokens = options.compactKeepBudgetTokens ?? COMPACT_KEEP_BUDGET_TOKENS;
    this.salienceKeepThreshold = options.salienceKeepThreshold ?? SALIENCE_KEEP_THRESHOLD;
    if (options.pinnedHeader !== undefined && options.pinnedHeader.length > 0) {
      this.setPinnedHeader(options.pinnedHeader);
    }
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get prefixText(): string {
    return this._prefixText;
  }

  get chunks(): readonly SessionChunk[] {
    return this._chunks;
  }

  get totalTokens(): number {
    return this._totalTokens;
  }

  get needsRecheckpoint(): boolean {
    return this._needsRecheckpoint;
  }

  get compactionCount(): number {
    return this._compactionCount;
  }

  get prewarmCount(): number {
    return this._prewarmCount;
  }

  get prewarmVersion(): number {
    return this._prewarmVersion;
  }

  get lastPrewarmError(): string | undefined {
    return this._lastPrewarmError;
  }

  reset(newSessionId?: string): void {
    if (newSessionId !== undefined && newSessionId.trim().length > 0) {
      this._sessionId = newSessionId.trim();
    }
    this._chunks = [];
    this._prefixText = "";
    this._totalTokens = 0;
    this._needsRecheckpoint = true;
    this._compactionCount += 1;
    this._prewarmVersion += 1;
    this._lastPrewarmedVersion = -1;
    this._prewarmDirty = false;
    this._lastPrewarmError = undefined;
  }

  setPinnedHeader(text: string, options?: { role?: string | undefined; label?: string | undefined; tokenEstimate?: number | undefined }): SessionChunk {
    const redactedText = redact(text);
    const role = options?.role ?? "system";
    const rendered = formatTurnBlock(0, role, redactedText, undefined, true);
    const existing = this._chunks[0];
    if (existing && existing.pinned && existing.rendered === rendered) {
      return existing;
    }

    const headerChunk: SessionChunk = {
      index: 0,
      turnIndex: 0,
      role,
      label: options?.label ?? "Turn 0 | pinned",
      excerpt: clipExcerpt(redactedText),
      charStart: 0,
      charEnd: rendered.length,
      pinned: true,
      tokens: estimateTokens(rendered, options?.tokenEstimate),
      rendered,
      salience: 1.0,
    };

    if (this._chunks.length === 0) {
      this._chunks = [headerChunk];
      this._prefixText = rendered;
      this._totalTokens = headerChunk.tokens;
      this._prewarmVersion += 1;
      return headerChunk;
    }

    const rest = existing?.pinned ? this._chunks.slice(1) : this._chunks;
    this.rebuildFromChunks([headerChunk, ...rest]);
    this._needsRecheckpoint = true;
    this._compactionCount += 1;
    this._prewarmVersion += 1;
    return headerChunk;
  }

  appendTurn(turn: SessionTurnInput): SessionChunk {
    const redactedText = redact(turn.text);
    const rendered = formatTurnBlock(turn.turnIndex, turn.role, redactedText, turn.tool, false);
    const excerpt = turn.excerpt !== undefined ? makeExcerpt(turn.excerpt) : clipExcerpt(redactedText);
    const tokens = estimateTokens(rendered, turn.tokenEstimate);
    const label = [
      `Turn #${turn.turnIndex}`,
      turn.role,
      turn.tool ? sanitizeAttr(turn.tool) : undefined,
    ].filter(Boolean).join(" | ");

    // Strict append preserves token #0..prevEnd byte-for-byte on every non-compaction turn.
    const separator = this._chunks.length === 0 ? "" : "\n\n";
    const charStart = this._prefixText.length + separator.length;
    this._prefixText = `${this._prefixText}${separator}${rendered}`;
    const charEnd = this._prefixText.length;

    const chunk: SessionChunk = {
      index: this._chunks.length,
      turnIndex: turn.turnIndex,
      role: turn.role,
      ...(turn.tool ? { tool: sanitizeAttr(turn.tool) } : {}),
      label,
      excerpt,
      charStart,
      charEnd,
      pinned: false,
      tokens,
      rendered,
    };
    this._chunks.push(chunk);
    this._totalTokens += tokens;
    this._prewarmVersion += 1;
    return chunk;
  }

  describeChunks(): SessionChunkDescriptor[] {
    return this._chunks.map(describeChunk);
  }

  applySalienceScores(scores: readonly number[], expectedVersion: number): void {
    if (expectedVersion !== this._prewarmVersion) return;
    const count = Math.min(scores.length, this._chunks.length);
    for (let i = 0; i < count; i++) {
      const score = scores[i];
      const chunk = this._chunks[i];
      if (chunk && score !== undefined && Number.isFinite(score)) {
        chunk.salience = Math.max(0, Math.min(1, score));
      }
    }
  }

  async compactIfNeeded(signal?: AbortSignal): Promise<CompactionResult> {
    if (this._totalTokens <= this.maxPrefixTokens) {
      return {
        compacted: false,
        cycles: 0,
        tokensBefore: this._totalTokens,
        tokensAfter: this._totalTokens,
        droppedCount: 0,
        keptCount: this._chunks.length,
      };
    }
    if (this._compactionInFlight) return this._compactionInFlight;
    const run = this.runCompaction(signal).finally(() => {
      this._compactionInFlight = null;
    });
    this._compactionInFlight = run;
    return run;
  }

  private async runCompaction(signal?: AbortSignal): Promise<CompactionResult> {
    const tokensBefore = this._totalTokens;
    let totalDropped = 0;
    let cycles = 0;

    while (this._totalTokens > this.maxPrefixTokens && cycles < MAX_COMPACTION_ITERATIONS) {
      const unpinned = this._chunks.filter((c) => !c.pinned);
      if (unpinned.length === 0) break;

      await this.refreshSalienceScores(signal);

      const pinned = this._chunks.filter((c) => c.pinned);
      const currentUnpinned = this._chunks.filter((c) => !c.pinned);
      if (currentUnpinned.length === 0) break;

      const block: SessionChunk[] = [];
      let blockTokens = 0;
      for (const chunk of currentUnpinned) {
        block.push(chunk);
        blockTokens += chunk.tokens;
        if (blockTokens >= this.compactUnpinnedBlockTokens) break;
      }
      const tail = currentUnpinned.slice(block.length);

      const scored = block.map((chunk, pos) => ({
        chunk,
        pos,
        score: chunk.salience ?? fallbackSalienceScore(chunk),
      }));

      const highSalience = scored
        .filter((item) => item.score >= this.salienceKeepThreshold)
        .sort((a, b) => (b.score - a.score) || (a.pos - b.pos));

      const keptItems: typeof scored = [];
      let keptTokens = 0;
      for (const item of highSalience) {
        if (keptTokens + item.chunk.tokens <= this.compactKeepBudgetTokens) {
          keptItems.push(item);
          keptTokens += item.chunk.tokens;
        }
      }

      // Guarantee strict token reduction even when every chunk in a small block passes the salience threshold.
      if (keptItems.length === block.length && block.length > 0) {
        if (keptItems.length > 1) {
          keptItems.pop();
        } else if (tail.length === 0) {
          break;
        } else {
          keptItems.length = 0;
        }
      }

      keptItems.sort((a, b) => a.pos - b.pos);
      const kept = keptItems.map((item) => item.chunk);
      const droppedThisCycle = block.length - kept.length;
      if (droppedThisCycle <= 0) break;

      const cycleTokensBefore = this._totalTokens;
      this.rebuildFromChunks([...pinned, ...kept, ...tail]);
      this._needsRecheckpoint = true;
      this._compactionCount += 1;
      this._prewarmVersion += 1;
      totalDropped += droppedThisCycle;
      cycles += 1;

      if (this._totalTokens >= cycleTokensBefore) break;
    }

    return {
      compacted: cycles > 0,
      cycles,
      tokensBefore,
      tokensAfter: this._totalTokens,
      droppedCount: totalDropped,
      keptCount: this._chunks.length,
    };
  }

  private async refreshSalienceScores(signal?: AbortSignal): Promise<void> {
    if (!this.resolveEndpoint) return;
    let endpoint: WardenS1Endpoint | null | undefined;
    try {
      endpoint = await this.resolveEndpoint(signal);
    } catch {
      return;
    }
    if (!endpoint) return;

    const version = this._prewarmVersion;
    const chunks = this.describeChunks();
    const state = this._prefixText;
    try {
      const response = await this.fetchImpl(`${trimTrailingSlash(endpoint.url)}/v1/salience`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${endpoint.token}`,
          "X-Warden-Session-Id": this._sessionId,
        },
        body: JSON.stringify({ model: endpoint.modelId, state, chunks }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      const scores = extractSalienceArray(body, chunks.length);
      if (scores) this.applySalienceScores(scores, version);
    } catch {
      // Fall back to cached salience scores or deterministic salience heuristic.
    }
  }

  private rebuildFromChunks(nextChunks: SessionChunk[]): void {
    const parts: string[] = [];
    let offset = 0;
    let totalTokens = 0;
    const rebuilt: SessionChunk[] = [];
    for (let i = 0; i < nextChunks.length; i++) {
      const chunk = nextChunks[i]!;
      if (i > 0) offset += 2;
      const charStart = offset;
      const charEnd = offset + chunk.rendered.length;
      offset = charEnd;
      parts.push(chunk.rendered);
      totalTokens += chunk.tokens;
      rebuilt.push({
        ...chunk,
        index: i,
        charStart,
        charEnd,
      });
    }
    this._chunks = rebuilt;
    this._prefixText = parts.join("\n\n");
    this._totalTokens = totalTokens;
  }

  /** A judged request left the daemon's record at prefix plus candidate, so the prefix it holds is warmed again. */
  rearmPrewarm(): void {
    this._lastPrewarmedVersion = -1;
    this.schedulePrewarm();
  }

  schedulePrewarm(): void {
    this._prewarmDirty = true;
    if (this._prewarmInFlight !== null) return;
    const run = this.runPrewarmLoop().finally(() => {
      if (this._prewarmInFlight === run) this._prewarmInFlight = null;
    });
    this._prewarmInFlight = run;
    run.catch(() => {
      // Background pre-warming must never surface unhandled rejections to Pi's event loop.
    });
  }

  async prewarmNow(signal?: AbortSignal): Promise<PrewarmResult> {
    this._prewarmDirty = true;
    while (this._prewarmInFlight !== null) {
      const inflight = this._prewarmInFlight;
      await inflight;
      if (!this._prewarmDirty && this._lastPrewarmedVersion === this._prewarmVersion && !this._needsRecheckpoint) {
        return {
          ok: this._lastPrewarmError === undefined,
          prefixTokens: this._totalTokens,
          ...(this._lastPrewarmError ? { error: this._lastPrewarmError } : {}),
        };
      }
    }
    const run = this.runPrewarmLoop(signal).finally(() => {
      if (this._prewarmInFlight === run) this._prewarmInFlight = null;
    });
    this._prewarmInFlight = run;
    return run;
  }

  private async runPrewarmLoop(signal?: AbortSignal): Promise<PrewarmResult> {
    let lastResult: PrewarmResult = { ok: true, skipped: true, prefixTokens: this._totalTokens };
    let passes = 0;

    while (this._prewarmDirty && passes < MAX_COALESCED_PREWARM_PASSES) {
      this._prewarmDirty = false;
      passes += 1;

      if (this._chunks.length === 0) {
        lastResult = { ok: true, skipped: true, prefixTokens: 0 };
        break;
      }

      if (this._totalTokens > this.maxPrefixTokens) {
        await this.compactIfNeeded(signal);
      }

      if (this._prewarmVersion === this._lastPrewarmedVersion && !this._needsRecheckpoint) {
        lastResult = { ok: true, skipped: true, prefixTokens: this._totalTokens };
        break;
      }

      if (!this.resolveEndpoint) {
        lastResult = { ok: true, skipped: true, prefixTokens: this._totalTokens };
        break;
      }

      let endpoint: WardenS1Endpoint | null | undefined;
      try {
        endpoint = await this.resolveEndpoint(signal);
      } catch (error) {
        const message = safeErrorMessage(error);
        this._lastPrewarmError = message;
        lastResult = { ok: false, prefixTokens: this._totalTokens, error: message };
        break;
      }

      if (!endpoint) {
        lastResult = { ok: true, skipped: true, prefixTokens: this._totalTokens };
        break;
      }

      const snapshotVersion = this._prewarmVersion;
      const snapshotCompaction = this._compactionCount;
      const recheckpoint = this._needsRecheckpoint;
      const state = this._prefixText;
      const chunks = this.describeChunks();
      const prefixTokens = this._totalTokens;

      try {
        this._prewarmCount += 1;
        const response = await this.fetchImpl(`${trimTrailingSlash(endpoint.url)}/v1/prewarm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${endpoint.token}`,
            "X-Warden-Session-Id": this._sessionId,
          },
          body: JSON.stringify({ model: endpoint.modelId, state, chunks, recheckpoint }),
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          const message = `Warden-S1 prewarm returned HTTP ${response.status}.`;
          this._lastPrewarmError = message;
          lastResult = { ok: false, prefixTokens, error: message };
          break;
        }
        let body: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = await response.json();
          if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
        } catch {
          body = undefined;
        }
        if (body) {
          const scores = extractSalienceArray(body, chunks.length);
          if (scores) this.applySalienceScores(scores, snapshotVersion);
        }
        if (recheckpoint && this._compactionCount === snapshotCompaction) {
          this._needsRecheckpoint = false;
        }
        this._lastPrewarmedVersion = Math.max(this._lastPrewarmedVersion, snapshotVersion);
        this._lastPrewarmError = undefined;

        const s1 = body?.s1 && typeof body.s1 === "object" ? (body.s1 as Record<string, unknown>) : undefined;
        const cacheMode = typeof s1?.cache_mode === "string"
          ? s1.cache_mode
          : typeof body?.cache_mode === "string"
            ? body.cache_mode
            : response.headers.get("x-warden-s1-cache-mode") ?? undefined;
        const boundaryHealed = typeof s1?.boundary_healed === "boolean"
          ? s1.boundary_healed
          : typeof body?.boundary_healed === "boolean"
            ? body.boundary_healed
            : undefined;
        lastResult = {
          ok: true,
          recheckpointed: recheckpoint,
          prefixTokens,
          ...(cacheMode !== undefined ? { cacheMode } : {}),
          ...(boundaryHealed !== undefined ? { boundaryHealed } : {}),
        };
      } catch (error) {
        const message = safeErrorMessage(error);
        this._lastPrewarmError = message;
        lastResult = { ok: false, prefixTokens, error: message };
        break;
      }
    }

    return lastResult;
  }
}

function serializeCandidateState(state: unknown): string {
  if (typeof state === "string") return redact(state);
  if (state !== null && typeof state === "object" && !Array.isArray(state)) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
      const body = typeof value === "string" ? redact(value) : redact(JSON.stringify(value, null, 2));
      parts.push(`## ${key}\n${body}`);
    }
    return parts.join("\n\n");
  }
  return redact(JSON.stringify(state, null, 2));
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
  return false;
}

interface ParsedLocusEntry {
  readonly chunkProbs?: readonly number[] | undefined;
  readonly topChunkIdx?: number | undefined;
  readonly topProb?: number | undefined;
}

function parseLocusEntry(raw: unknown): ParsedLocusEntry | undefined {
  if (Array.isArray(raw)) {
    const probs = raw.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
    return probs.length > 0 ? { chunkProbs: probs } : undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const rawProbs = obj.chunk_probs ?? obj.chunkProbs ?? obj.probs;
  const chunkProbs = Array.isArray(rawProbs)
    ? rawProbs.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0))
    : undefined;
  const rawIdx = obj.top_chunk ?? obj.top_chunk_idx ?? obj.topChunkIdx;
  const topChunkIdx = typeof rawIdx === "number" && Number.isInteger(rawIdx) ? rawIdx : undefined;
  const rawProb = obj.top_prob ?? obj.topProb;
  const topProb = typeof rawProb === "number" && Number.isFinite(rawProb) ? rawProb : undefined;
  if (!chunkProbs && topChunkIdx === undefined) return undefined;
  return { chunkProbs, topChunkIdx, topProb };
}

function selectLocusCitation(entry: ParsedLocusEntry, historyChunks: readonly SessionChunk[]): LocusCitation | undefined {
  if (historyChunks.length === 0) return undefined;
  let bestIdx = -1;
  let bestProb = 0;

  if (entry.chunkProbs && entry.chunkProbs.length > 0) {
    const limit = Math.min(historyChunks.length, entry.chunkProbs.length);
    for (let i = 0; i < limit; i++) {
      const prob = entry.chunkProbs[i] ?? 0;
      if (Number.isFinite(prob) && prob > bestProb) {
        bestProb = prob;
        bestIdx = i;
      }
    }
  } else if (entry.topChunkIdx !== undefined && entry.topChunkIdx >= 0 && entry.topChunkIdx < historyChunks.length) {
    bestIdx = entry.topChunkIdx;
    bestProb = entry.topProb ?? 0;
  }

  if (bestIdx < 0 || bestProb <= 0) return undefined;
  const chunk = historyChunks[bestIdx];
  if (!chunk) return undefined;
  const base = {
    turnIndex: chunk.turnIndex,
    chunkIndex: chunk.index,
    role: chunk.role,
    ...(chunk.tool ? { tool: chunk.tool } : {}),
    probability: bestProb,
    excerpt: chunk.excerpt,
  };
  return { ...base, summary: formatLocusCitation(base) };
}

function extractLocusMap(
  body: Record<string, unknown>,
  questionIds: readonly string[],
  historyChunks: readonly SessionChunk[],
): { locusByQuestion: Record<string, LocusCitation>; topLocus?: LocusCitation | undefined } {
  const s1 = body.s1 && typeof body.s1 === "object" ? (body.s1 as Record<string, unknown>) : undefined;
  const rawLocus = s1?.locus ?? body.locus;
  const locusByQuestion: Record<string, LocusCitation> = {};
  if (!rawLocus || typeof rawLocus !== "object" || historyChunks.length === 0) {
    return { locusByQuestion };
  }

  const locusObj = rawLocus as Record<string, unknown>;
  const byQuestion = locusObj.by_question && typeof locusObj.by_question === "object" && !Array.isArray(locusObj.by_question)
    ? (locusObj.by_question as Record<string, unknown>)
    : undefined;
  const perQuestion = byQuestion && Object.keys(byQuestion).length > 0 ? byQuestion : undefined;
  const singleEntry = perQuestion ? undefined : parseLocusEntry(locusObj);
  if (singleEntry) {
    const citation = selectLocusCitation(singleEntry, historyChunks);
    if (citation) {
      for (const qid of questionIds) locusByQuestion[qid] = citation;
      return { locusByQuestion, topLocus: citation };
    }
    return { locusByQuestion };
  }

  const entries = perQuestion ?? locusObj;
  let topLocus: LocusCitation | undefined;
  for (const qid of questionIds) {
    const entry = parseLocusEntry(entries[qid]);
    if (!entry) continue;
    const citation = selectLocusCitation(entry, historyChunks);
    if (!citation) continue;
    locusByQuestion[qid] = citation;
    if (!topLocus || citation.probability > topLocus.probability) {
      topLocus = citation;
    }
  }

  return topLocus ? { locusByQuestion, topLocus } : { locusByQuestion };
}

function validateWireAnswers(rawAnswers: unknown, questions: Questions): Record<string, Record<string, unknown>> {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new TypeSafeIntegrationError("response", "Local Warden-S1 returned an unexpected answers object.");
  }
  const answersObj = rawAnswers as Record<string, unknown>;
  const validated: Record<string, Record<string, unknown>> = {};
  for (const [qid, question] of Object.entries(questions)) {
    const ans = answersObj[qid];
    if (!ans || typeof ans !== "object" || Array.isArray(ans)) {
      throw new TypeSafeIntegrationError("response", `Local Warden-S1 omitted answer for question "${qid}".`);
    }
    const rec = ans as Record<string, unknown>;
    if (rec.type !== question.type) {
      throw new TypeSafeIntegrationError("response", `Local Warden-S1 returned mismatched answer type for "${qid}".`);
    }
    if (question.type === "noul") {
      if (typeof rec.noul !== "number" || !Number.isFinite(rec.noul) || rec.noul < 0 || rec.noul > 1) {
        throw new TypeSafeIntegrationError("response", `Local Warden-S1 returned invalid noul probability for "${qid}".`);
      }
    } else if (question.type === "choice") {
      if (typeof rec.choice !== "string" || rec.choice.length === 0) {
        throw new TypeSafeIntegrationError("response", `Local Warden-S1 returned invalid choice answer for "${qid}".`);
      }
    } else if (question.type === "score") {
      if (typeof rec.score !== "number" || !Number.isFinite(rec.score)) {
        throw new TypeSafeIntegrationError("response", `Local Warden-S1 returned invalid score answer for "${qid}".`);
      }
    }
    validated[qid] = rec;
  }
  return validated;
}

function parseUsage(rawUsage: unknown): Usage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { input_tokens: 0, output_tokens: 0 };
  }
  const rec = rawUsage as Record<string, unknown>;
  const inputTokens = typeof rec.input_tokens === "number" && Number.isFinite(rec.input_tokens) ? rec.input_tokens : 0;
  const outputTokens = typeof rec.output_tokens === "number" && Number.isFinite(rec.output_tokens) ? rec.output_tokens : 0;
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

function parseHeaderNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function createWardenS1Judge(options: WardenS1JudgeOptions): WardenS1Judge {
  const tracker = options.sessionTracker;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const maxInputBytes = options.maxInputBytes ?? LOCAL_MAX_INPUT_BYTES;
  const limits: BackendLimits = options.limits ?? DEFAULT_BACKEND_LIMITS;

  const usage = {
    requestsStarted: 0,
    requestsSucceeded: 0,
    requestsFailed: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  let lastMeta: WardenS1EvalMeta | undefined;

  const snapshot = (): UsageSnapshot => ({ ...usage, estimatedUsd: 0 });

  const tryResolveLocal = async (signal?: AbortSignal): Promise<WardenS1Endpoint | undefined> => {
    try {
      const resolved = await options.resolveEndpoint(signal);
      return resolved ?? undefined;
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new TypeSafeIntegrationError("aborted", "Local Warden-S1 request cancelled before submission.");
      }
      if (options.fallbackJudge) return undefined;
      throw new TypeSafeIntegrationError("connection", `Local Warden-S1 daemon is unavailable: ${safeErrorMessage(error)}`);
    }
  };

  const judge: WardenS1Judge = {
    limits,
    sessionTracker: tracker,

    getUsage: snapshot,

    getSpend(): SpendReport {
      const current = snapshot();
      return {
        session: current,
        today: {
          ...current,
          day: localDay(),
          estimatedUsd: 0,
        },
        caps: {},
        usdPerMTok: 0,
        budget: {
          status: "within_budget",
          remainingRequests: Number.MAX_SAFE_INTEGER,
        },
      };
    },

    getLastEvaluationMeta(): WardenS1EvalMeta | undefined {
      return lastMeta;
    },

    getMetaForAnswers(answers: unknown): WardenS1EvalMeta | undefined {
      return getMetaForAnswers(answers);
    },

    async listModels(callOptions: EvaluationOptions = {}): Promise<string[]> {
      if (callOptions.signal?.aborted) {
        throw new TypeSafeIntegrationError("aborted", "Local Warden-S1 model listing cancelled.");
      }
      const endpoint = await tryResolveLocal(callOptions.signal);
      if (!endpoint) {
        if (options.fallbackJudge) return options.fallbackJudge.listModels(callOptions);
        throw new TypeSafeIntegrationError("connection", "Local Warden-S1 daemon is unavailable.");
      }
      try {
        const response = await fetchImpl(`${trimTrailingSlash(endpoint.url)}/v1/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${endpoint.token}` },
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        });
        if (!response.ok) {
          throw new TypeSafeIntegrationError("http", `Local Warden-S1 returned HTTP ${response.status}.`, response.status);
        }
        const body = (await response.json()) as { models?: Array<{ name?: unknown; id?: unknown }> };
        if (!Array.isArray(body.models)) return [endpoint.modelId];
        const names = body.models
          .map((m) => (typeof m?.name === "string" ? m.name : typeof m?.id === "string" ? m.id : undefined))
          .filter((name): name is string => typeof name === "string" && name.length > 0);
        return names.length > 0 ? names : [endpoint.modelId];
      } catch (error) {
        if (error instanceof TypeSafeIntegrationError) throw error;
        if (isAbortError(error, callOptions.signal)) {
          throw new TypeSafeIntegrationError("aborted", "Local Warden-S1 model listing cancelled.");
        }
        if (options.fallbackJudge) return options.fallbackJudge.listModels(callOptions);
        throw new TypeSafeIntegrationError("connection", "Could not reach local Warden-S1 daemon.");
      }
    },

    async evaluate<Q extends Questions>(
      request: SystemOneRequest<Q>,
      callOptions: EvaluationOptions = {},
    ): Promise<Evaluation<Q>> {
      if (callOptions.signal?.aborted) {
        throw new TypeSafeIntegrationError("aborted", "Local Warden-S1 request cancelled before submission.");
      }

      const endpoint = await tryResolveLocal(callOptions.signal);
      if (!endpoint) {
        if (options.fallbackJudge) {
          return options.fallbackJudge.evaluate(request, callOptions);
        }
        throw new TypeSafeIntegrationError("connection", "Local Warden-S1 daemon is unavailable.");
      }

      const validated = prepareEvaluationRequest(request, { maxInputBytes, limits });

      if (tracker.totalTokens > tracker.maxPrefixTokens) {
        await tracker.compactIfNeeded(callOptions.signal);
      }

      const snapshotVersion = tracker.prewarmVersion;
      const historyChunks = [...tracker.chunks];
      const historyDescriptors = tracker.describeChunks();
      const prefixText = tracker.prefixText;
      const prefixTokens = tracker.totalTokens;

      const candidateBody = serializeCandidateState(validated.state);
      const candidateBlock = `<turn index="current" role="candidate">\n${candidateBody}\n</turn>`;
      const composedState = prefixText.length > 0 ? `${prefixText}\n\n${candidateBlock}` : candidateBlock;
      const candidateStart = prefixText.length > 0 ? prefixText.length + 2 : 0;
      const requestChunks: SessionChunkDescriptor[] = [
        ...historyDescriptors,
        describeChunk({
          index: historyDescriptors.length,
          turnIndex: -1,
          role: "candidate",
          label: "Current candidate",
          charStart: candidateStart,
          charEnd: composedState.length,
        }),
      ];

      const sentModel = validated.model ?? endpoint.modelId;
      const wireBody = JSON.stringify({
        model: sentModel,
        state: composedState,
        chunks: requestChunks,
        questions: validated.questions,
      });

      const wireBytes = Buffer.byteLength(wireBody, "utf8");
      if (wireBytes > maxInputBytes) {
        throw new TypeSafeIntegrationError(
          "validation",
          `Local Warden-S1 request exceeds ${maxInputBytes} byte limit (${wireBytes} bytes).`,
        );
      }

      usage.requestsStarted += 1;
      const startedAt = performance.now();

      let response: Response;
      try {
        response = await fetchImpl(`${trimTrailingSlash(endpoint.url)}/v1/systemone`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${endpoint.token}`,
            "X-Warden-Session-Id": tracker.sessionId,
          },
          body: wireBody,
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        });
      } catch (error) {
        if (isAbortError(error, callOptions.signal)) {
          usage.requestsFailed += 1;
          throw new TypeSafeIntegrationError("aborted", "Local Warden-S1 request cancelled.");
        }
        if (options.fallbackJudge) {
          usage.requestsStarted -= 1;
          return options.fallbackJudge.evaluate(request, callOptions);
        }
        usage.requestsFailed += 1;
        throw new TypeSafeIntegrationError("connection", "Could not connect to local Warden-S1 daemon.");
      }

      if (!response.ok) {
        usage.requestsFailed += 1;
        throw new TypeSafeIntegrationError(
          "http",
          `Local Warden-S1 returned HTTP ${response.status}.`,
          response.status,
        );
      }

      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await response.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Response root is not a JSON object.");
        }
        body = parsed as Record<string, unknown>;
      } catch {
        usage.requestsFailed += 1;
        throw new TypeSafeIntegrationError("response", "Local Warden-S1 returned unreadable JSON.");
      }

      let rawAnswers: Record<string, Record<string, unknown>>;
      try {
        rawAnswers = validateWireAnswers(body.answers, validated.questions);
      } catch (error) {
        usage.requestsFailed += 1;
        throw error;
      }

      const rawNoul: Record<string, number> = {};
      const abstentions: Record<string, string> = {};
      const processedAnswers: Record<string, Record<string, unknown>> = {};

      for (const [qid, ans] of Object.entries(rawAnswers)) {
        if (ans.type === "noul" && typeof ans.noul === "number") {
          rawNoul[qid] = ans.noul;
          if (isEpistemicAbstention(ans.noul)) {
            abstentions[qid] = ABSTENTION_REASON;
            const polarity = resolveNoulPolarity(qid, options.noulPolarity);
            processedAnswers[qid] = { ...ans, noul: neutralizeAbstainedProbability(polarity) };
          } else {
            processedAnswers[qid] = { ...ans };
          }
        } else {
          processedAnswers[qid] = { ...ans };
        }
      }

      const salienceScores = extractSalienceArray(body, historyChunks.length);
      if (salienceScores) {
        tracker.applySalienceScores(salienceScores, snapshotVersion);
      }

      const questionIds = Object.keys(validated.questions);
      const { locusByQuestion, topLocus } = extractLocusMap(body, questionIds, historyChunks);

      const s1 = body.s1 && typeof body.s1 === "object" ? (body.s1 as Record<string, unknown>) : undefined;
      const cacheMode = typeof s1?.cache_mode === "string"
        ? s1.cache_mode
        : response.headers.get("x-warden-s1-cache-mode") ?? undefined;
      const boundaryHealed = typeof s1?.boundary_healed === "boolean"
        ? s1.boundary_healed
        : undefined;
      const deltaTokens = typeof s1?.delta_tokens === "number" && Number.isFinite(s1.delta_tokens)
        ? s1.delta_tokens
        : parseHeaderNumber(response.headers, "x-warden-s1-delta-tokens");
      const reportedPrefixTokens = typeof s1?.prefix_tokens === "number" && Number.isFinite(s1.prefix_tokens)
        ? s1.prefix_tokens
        : prefixTokens;

      const meta: WardenS1EvalMeta = {
        locusByQuestion,
        ...(topLocus ? { topLocus } : {}),
        abstentions,
        rawNoul,
        ...(cacheMode !== undefined ? { cacheMode } : {}),
        ...(boundaryHealed !== undefined ? { boundaryHealed } : {}),
        prefixTokens: reportedPrefixTokens,
        ...(deltaTokens !== undefined ? { deltaTokens } : {}),
      };

      ANSWER_META.set(processedAnswers, meta);
      lastMeta = meta;
      tracker.rearmPrewarm();

      const parsedUsage = parseUsage(body.usage);
      usage.requestsSucceeded += 1;
      usage.inputTokens += parsedUsage.input_tokens ?? 0;
      usage.outputTokens += parsedUsage.output_tokens ?? 0;

      const model = typeof body.model === "string" && body.model.length > 0 ? body.model : sentModel;
      const elapsedMs = Math.round(performance.now() - startedAt);

      return {
        model,
        usage: parsedUsage,
        answers: processedAnswers as unknown as Evaluation<Q>["answers"],
        elapsedMs,
      };
    },

    evaluateMany<Q extends Questions>(
      requests: readonly SystemOneRequest<Q>[],
      batchOptions: BatchOptions = {},
    ): Promise<BatchEvaluation<Q>> {
      return evaluateMany(judge, requests, batchOptions);
    },

    evaluateAll<Q extends Questions>(
      request: SystemOneRequest<Q>,
      batchOptions: BatchOptions & { maxQuestions?: number } = {},
    ): Promise<BatchEvaluation<Q>> {
      return evaluateAll(judge, request, batchOptions);
    },
  };

  return judge;
}

/** The local model as one session reads it: whether it can judge, and how its daemon is started. */
export interface LocalWardenS1 {
  readonly status: WardenS1Status;
  /** The synthetic weights stand in for the download, for a proof that must not fetch 461 MiB. */
  readonly mock: boolean;
  readonly ready: boolean;
  readonly daemon: EnsureDaemonOptions;
}

export function resolveLocalWardenS1(
  localModel: LocalModelConfig,
  options: { readonly dirs?: HostDirs; readonly env?: NodeJS.ProcessEnv } = {},
): LocalWardenS1 {
  const env = options.env ?? process.env;
  const status = getWardenS1Status(localModel, { ...(options.dirs ? { dirs: options.dirs } : {}), env });
  const idle = localModel.idleShutdownSec === undefined ? {} : { idleShutdownSec: localModel.idleShutdownSec };
  if (env[MOCK_WEIGHTS_ENV] === "1") {
    return { status, mock: true, ready: true, daemon: { runtime: "onnx", mockWeights: true, ...idle } };
  }
  return {
    status,
    mock: false,
    ready: status.ready,
    daemon: {
      runtime: status.runtime,
      modelDir: status.modelDir,
      modelId: status.modelId,
      ...(status.mlxPython ? { pythonBin: status.mlxPython } : {}),
      ...(status.ortRuntimePath ? { ortPath: status.ortRuntimePath } : {}),
      ...idle,
    },
  };
}

export interface WardenS1Connection {
  readonly resolveEndpoint: ResolveWardenS1Endpoint;
  readonly fetchImpl: FetchLike;
  /** Starts the daemon without waiting for it, so the first judged call finds it up. */
  warm(): void;
}

function abortable<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return start();
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const promise = start();
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * One session's line to the shared daemon. The endpoint is kept until a request fails to connect or is refused, so a
 * judged call costs no health probe; a start in progress is shared, and a failed start is not retried for 30 s.
 */
export function connectWardenS1(
  daemon: EnsureDaemonOptions,
  ensure: (options: EnsureDaemonOptions) => Promise<DaemonEndpoint> = ensureWardenS1Daemon,
): WardenS1Connection {
  let endpoint: DaemonEndpoint | undefined;
  let starting: Promise<DaemonEndpoint> | undefined;
  let retryAfter = 0;
  let lastError = "Warden-S1 daemon failed to start.";
  const start = (): Promise<DaemonEndpoint> => {
    if (endpoint) return Promise.resolve(endpoint);
    if (starting) return starting;
    if (Date.now() < retryAfter) return Promise.reject(new Error(lastError));
    const attempt = ensure(daemon).then(
      (started) => {
        endpoint = started;
        return started;
      },
      (error: unknown) => {
        retryAfter = Date.now() + DAEMON_RETRY_MS;
        lastError = safeErrorMessage(error);
        throw error;
      },
    ).finally(() => {
      if (starting === attempt) starting = undefined;
    });
    starting = attempt;
    return attempt;
  };
  return {
    resolveEndpoint: (signal) => abortable(start, signal),
    fetchImpl: async (input, init) => {
      let response: Response;
      try {
        response = await globalThis.fetch(input, init);
      } catch (error) {
        if (!isAbortError(error, init?.signal ?? undefined)) endpoint = undefined;
        throw error;
      }
      // A restarted daemon answers on a new port with a new token; a refusal means this endpoint is the old one.
      if (response.status === 401 || response.status === 403) endpoint = undefined;
      return response;
    },
    warm: () => {
      start().catch(() => undefined);
    },
  };
}
