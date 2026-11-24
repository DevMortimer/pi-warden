import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { writeFileAtomicSync } from "./atomic.js";

export const LINEAR_LAYERS = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22] as const;
export const FULL_LAYERS = [3, 7, 11, 15, 19, 23] as const;
export const MAX_CHUNK_LEN = 64;
export const HIDDEN_SIZE = 1024;
export const DEFAULT_ABSTAIN_BAND: readonly [number, number] = [0.42, 0.58];

export interface OrtTensorLike {
  readonly type: string;
  readonly data: Float32Array | BigInt64Array | Int32Array | Uint8Array;
  readonly dims: readonly number[];
}

export interface OrtSessionLike {
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}

export interface OrtLike {
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array | Int32Array | Uint8Array,
    dims: readonly number[],
  ) => OrtTensorLike;
  InferenceSession: {
    create(modelPathOrBuf: string | Uint8Array, options?: Record<string, unknown>): Promise<OrtSessionLike>;
  };
}

export interface OnnxModelManifest {
  readonly architecture: {
    readonly hidden_size?: number;
    readonly max_chunk_len?: number;
    readonly linear_layers?: readonly number[];
    readonly full_layers?: readonly number[];
    readonly linear_conv_dim?: number;
    readonly linear_conv_kernel?: number;
    readonly linear_num_heads?: number;
    readonly linear_head_dim?: number;
    readonly full_num_kv_heads?: number;
    readonly full_head_dim?: number;
    readonly score_bins?: number;
  };
  readonly models: {
    readonly embed: { readonly onnx: string };
    readonly backbone: { readonly onnx: string; readonly outputs: readonly string[] };
    readonly heads: { readonly onnx: string };
  };
  readonly auxiliary?: { readonly tokenizer?: string };
}

export interface ChunkInput {
  readonly label?: string;
  readonly char_start?: number;
  readonly char_end?: number;
  readonly token_start?: number;
  readonly token_end?: number;
}

export interface ChunkDescriptor {
  readonly index: number;
  readonly label: string;
  readonly token_start: number;
  readonly token_end: number;
  readonly salience?: number;
}

export interface LocusSummary {
  readonly top_chunk: number;
  readonly top_prob: number;
  readonly chunk_probs: readonly number[];
}

export interface S1Metadata {
  readonly session_id: string;
  readonly runtime: "mlx" | "onnx";
  readonly cache_mode: "exact" | "delta" | "miss";
  readonly boundary_healed: boolean;
  readonly page_tier: "L1" | "L2_RAM" | "L3_DISK" | "NEW";
  readonly prefix_reuse_tokens: number;
  readonly delta_tokens: number;
  readonly state_tokens: number;
  readonly swap_ms: number;
  readonly prefill_ms: number;
  readonly probe_ms: number;
  readonly total_ms: number;
  readonly chunks: readonly ChunkDescriptor[];
  readonly salience: readonly number[];
  readonly locus: LocusSummary & { readonly by_question: Readonly<Record<string, LocusSummary>> };
  readonly abstentions: Readonly<Record<string, boolean>>;
}

export interface SystemOneResponse {
  readonly model: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly answers: Record<string, unknown>;
  readonly s1: S1Metadata;
}

export interface PrewarmResponse {
  readonly ok: true;
  readonly session_id: string;
  readonly runtime: "mlx" | "onnx";
  readonly state_tokens: number;
  readonly prefix_reuse_tokens: number;
  readonly delta_tokens: number;
  readonly cache_mode: "exact" | "delta" | "miss";
  readonly boundary_healed: boolean;
  readonly page_tier: "L1" | "L2_RAM" | "L3_DISK" | "NEW";
  readonly recheckpointed: boolean;
  readonly swap_ms: number;
  readonly prefill_ms: number;
  readonly salience: readonly number[];
  readonly chunks: readonly ChunkDescriptor[];
}

export interface SalienceResponse {
  readonly ok: true;
  readonly session_id: string;
  readonly runtime: "mlx" | "onnx";
  readonly state_tokens: number;
  readonly cache_mode: "exact" | "delta" | "miss";
  readonly boundary_healed: boolean;
  readonly page_tier: "L1" | "L2_RAM" | "L3_DISK" | "NEW";
  readonly swap_ms: number;
  readonly salience: readonly number[];
  readonly chunks: readonly ChunkDescriptor[];
}

export interface DaemonStats {
  readonly status: "ok";
  readonly runtime: "mlx" | "onnx";
  readonly pid: number;
  readonly instance_id: string;
  readonly model: string;
  readonly model_dir: string;
  readonly idle_shutdown_sec: number;
  readonly idle_sec: number;
  readonly in_flight: number;
  readonly rss_mb?: number;
  readonly weights_active_mb?: number;
  readonly metal_active_mb?: number;
  readonly metal_max_active_mb?: number;
  readonly under_1024_mib?: boolean;
  readonly active_session_id: string | null;
  readonly active_prefix_tokens: number;
  readonly l2_ram_sessions: number;
  readonly l3_disk_sessions: number;
  readonly zstd_enabled: boolean;
  readonly requests_served: number;
  readonly prewarms_served: number;
  readonly cache_exact_hits: number;
  readonly cache_delta_hits: number;
  readonly cache_boundary_healed_hits: number;
  readonly cache_misses: number;
  readonly l1_hits: number;
  readonly l2_ram_swaps: number;
  readonly l3_disk_swaps: number;
  readonly swap_ms_p50: number;
  readonly swap_ms_p95: number;
  readonly latency_ms_p50: number;
  readonly latency_ms_p95: number;
}

const QWEN_PRETOKEN_RE =
  /(?:'s|'t|'re|'ve|'m|'ll|'d|'S|'T|'RE|'VE|'M|'LL|'D)|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const UTF8_ENCODER = new TextEncoder();

function buildBytesToUnicode(): readonly string[] {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const map: string[] = new Array<string>(256);
  for (let i = 0; i < bs.length; i++) {
    map[bs[i]!] = String.fromCharCode(cs[i]!);
  }
  return map;
}

export const BYTES_TO_UNICODE: readonly string[] = buildBytesToUnicode();

export interface TokenizerJsonLike {
  readonly model?: {
    readonly vocab?: Record<string, number>;
    readonly merges?: readonly (string | readonly [string, string])[];
  };
  readonly added_tokens?: readonly { readonly content?: string; readonly id?: number }[];
}

export class ByteLevelBPETokenizer {
  readonly vocab: Map<string, number>;
  readonly bpeRanks: Map<string, number>;
  readonly addedTokens: Map<string, number>;
  private readonly addedRegex: RegExp | null;
  private readonly bpeCache = new Map<string, readonly string[]>();

  constructor(tokenizerJson: TokenizerJsonLike) {
    const model = tokenizerJson.model ?? {};
    this.vocab = new Map(Object.entries(model.vocab ?? {}));
    this.bpeRanks = new Map();
    const merges = model.merges ?? [];
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i]!;
      const key = typeof m === "string" ? m : `${m[0]} ${m[1]}`;
      this.bpeRanks.set(key, i);
    }
    this.addedTokens = new Map();
    const addedList: string[] = [];
    for (const tok of tokenizerJson.added_tokens ?? []) {
      if (tok && typeof tok.content === "string" && typeof tok.id === "number") {
        this.addedTokens.set(tok.content, tok.id);
        addedList.push(tok.content);
      }
    }
    addedList.sort((a, b) => b.length - a.length);
    this.addedRegex =
      addedList.length > 0
        ? new RegExp(addedList.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
        : null;
  }

  bpe(token: string): readonly string[] {
    const cached = this.bpeCache.get(token);
    if (cached !== undefined) return cached;
    let word = Array.from(token);
    if (word.length <= 1) {
      this.bpeCache.set(token, word);
      return word;
    }
    while (word.length > 1) {
      let bestRank = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < word.length - 1; i++) {
        const rank = this.bpeRanks.get(`${word[i]} ${word[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      const first = word[bestIdx]!;
      const second = word[bestIdx + 1]!;
      const merged = first + second;
      const next: string[] = [];
      let i = 0;
      while (i < word.length) {
        if (i < word.length - 1 && word[i] === first && word[i + 1] === second) {
          next.push(merged);
          i += 2;
        } else {
          next.push(word[i]!);
          i += 1;
        }
      }
      word = next;
    }
    if (this.bpeCache.size < 65536) this.bpeCache.set(token, word);
    return word;
  }

  private encodeSegmentWithOffsets(
    segment: string,
    baseCharOffset: number,
    outIds: number[],
    outOffsets: Array<[number, number]> | null,
  ): void {
    const normalized = segment.normalize("NFC");
    const sameLen = normalized.length === segment.length;
    QWEN_PRETOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QWEN_PRETOKEN_RE.exec(normalized)) !== null) {
      const pieceText = match[0];
      const bytes = UTF8_ENCODER.encode(pieceText);
      let unicodeStr = "";
      for (let i = 0; i < bytes.length; i++) unicodeStr += BYTES_TO_UNICODE[bytes[i]!]!;
      const pieces = this.bpe(unicodeStr);
      if (outOffsets === null) {
        for (let i = 0; i < pieces.length; i++) {
          const id = this.vocab.get(pieces[i]!);
          if (id !== undefined) outIds.push(id);
        }
        continue;
      }
      // Map each UTF-8 byte boundary back to a JS UTF-16 code unit offset inside match[0].
      const byteToChar = new Int32Array(bytes.length + 1);
      let bPos = 0;
      for (let cPos = 0; cPos < pieceText.length; ) {
        const cp = pieceText.codePointAt(cPos)!;
        const charLen = cp > 0xffff ? 2 : 1;
        const utf8Len = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
        for (let k = 0; k < utf8Len && bPos + k <= bytes.length; k++) {
          byteToChar[bPos + k] = cPos;
        }
        bPos += utf8Len;
        cPos += charLen;
      }
      byteToChar[bytes.length] = pieceText.length;

      const matchStart = baseCharOffset + (sameLen ? match.index : Math.floor((match.index * segment.length) / Math.max(1, normalized.length)));
      let byteCursor = 0;
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]!;
        const byteLen = piece.length;
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          const startC = matchStart + (byteToChar[Math.min(byteCursor, bytes.length)] ?? 0);
          const endC = matchStart + (byteToChar[Math.min(byteCursor + byteLen, bytes.length)] ?? pieceText.length);
          outIds.push(id);
          outOffsets.push([startC, Math.max(startC, endC)]);
        }
        byteCursor += byteLen;
      }
    }
  }

  encode(text: string): number[] {
    return this.encodeWithOffsets(text).ids;
  }

  encodeWithOffsets(text: string): { ids: number[]; offsets: Array<[number, number]> } {
    const str = String(text || "");
    if (!str) return { ids: [], offsets: [] };
    const ids: number[] = [];
    const offsets: Array<[number, number]> = [];
    if (!this.addedRegex) {
      this.encodeSegmentWithOffsets(str, 0, ids, offsets);
      return { ids, offsets };
    }
    this.addedRegex.lastIndex = 0;
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = this.addedRegex.exec(str)) !== null) {
      if (m.index > lastIndex) {
        this.encodeSegmentWithOffsets(str.slice(lastIndex, m.index), lastIndex, ids, offsets);
      }
      const addedId = this.addedTokens.get(m[0]);
      if (addedId !== undefined) {
        ids.push(addedId);
        offsets.push([m.index, m.index + m[0].length]);
      }
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < str.length) {
      this.encodeSegmentWithOffsets(str.slice(lastIndex), lastIndex, ids, offsets);
    }
    return { ids, offsets };
  }
}

export function createByteLevelFallbackTokenizer(extraMerges: readonly string[] = ["Ċ Ċ"]): ByteLevelBPETokenizer {
  const vocab: Record<string, number> = {};
  let nextId = 0;
  for (let b = 0; b < 256; b++) {
    vocab[BYTES_TO_UNICODE[b]!] = nextId++;
  }
  const merges: string[] = [];
  for (const merge of extraMerges) {
    const parts = merge.split(" ");
    if (parts.length === 2) {
      const combined = `${parts[0]}${parts[1]}`;
      if (vocab[combined] === undefined) vocab[combined] = nextId++;
      merges.push(merge);
    }
  }
  return new ByteLevelBPETokenizer({ model: { vocab, merges } });
}

function serializeEntry(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

export function serializeState(stateInput: unknown): string {
  if (typeof stateInput === "string") return stateInput;
  if (stateInput && typeof stateInput === "object" && !Array.isArray(stateInput)) {
    const rec = stateInput as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (
      typeof rec.trajectory === "string" &&
      keys.every((k) => k === "trajectory" || k === "session_id" || k === "repo" || k === "domain")
    ) {
      return rec.trajectory;
    }
    const parts: string[] = [];
    for (const [k, v] of Object.entries(rec)) {
      const body = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      parts.push(`## ${k}\n${body}`);
    }
    return parts.join("\n\n");
  }
  return JSON.stringify(stateInput, null, 2);
}

export interface RawCharChunk {
  readonly index: number;
  readonly label: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
}

export function extractStateChunks(stateInput: unknown): { text: string; chunks: RawCharChunk[] } {
  const rawText = serializeState(stateInput);
  const chunks: RawCharChunk[] = [];
  const turnRe = /<turn\b([^>]*)>[\s\S]*?<\/turn>/g;
  let m: RegExpExecArray | null;
  while ((m = turnRe.exec(rawText)) !== null) {
    const attrs = m[1] ?? "";
    const titleMatch = attrs.match(/title="([^"]+)"/);
    const roleMatch = attrs.match(/role="([^"]+)"/);
    const idxMatch = attrs.match(/index="([^"]+)"/);
    const label = [
      idxMatch ? `Turn ${idxMatch[1]}` : `Turn ${chunks.length}`,
      roleMatch ? roleMatch[1] : null,
      titleMatch ? titleMatch[1] : null,
    ]
      .filter((x): x is string => Boolean(x))
      .join(" | ");
    chunks.push({
      index: chunks.length,
      label,
      charStart: m.index,
      charEnd: m.index + m[0].length,
      text: m[0],
    });
  }

  if (chunks.length === 0) {
    const sectionRe = /^##\s+([^\n]+)\n[\s\S]*?(?=^##\s+|\s*$)/gm;
    const matches: RegExpExecArray[] = [];
    while ((m = sectionRe.exec(rawText)) !== null) matches.push(m);
    if (matches.length > 0) {
      const firstStart = matches[0]!.index;
      if (firstStart > 0 && rawText.slice(0, firstStart).trim().length > 0) {
        chunks.push({
          index: 0,
          label: "Block 0",
          charStart: 0,
          charEnd: firstStart,
          text: rawText.slice(0, firstStart),
        });
      }
      for (const sm of matches) {
        chunks.push({
          index: chunks.length,
          label: (sm[1] ?? "").trim(),
          charStart: sm.index,
          charEnd: sm.index + sm[0].length,
          text: sm[0],
        });
      }
    }
  }

  if (chunks.length === 0) {
    const blocks = rawText.split(/\n{2,}/);
    let cursor = 0;
    for (const block of blocks) {
      const pos = rawText.indexOf(block, cursor);
      if (block.trim().length > 0 && pos >= 0) {
        chunks.push({
          index: chunks.length,
          label: `Block ${chunks.length}`,
          charStart: pos,
          charEnd: pos + block.length,
          text: block,
        });
        cursor = pos + block.length;
      }
    }
  }

  if (chunks.length === 0) {
    chunks.push({
      index: 0,
      label: "State",
      charStart: 0,
      charEnd: rawText.length,
      text: rawText,
    });
  }

  return { text: rawText, chunks };
}

function charSpanToTokens(
  cs: number,
  ce: number,
  textLen: number,
  seqLen: number,
  offsets: readonly [number, number][],
): [number, number] {
  if (offsets.length !== seqLen) {
    const ts = Math.max(0, Math.min(Math.floor((cs * seqLen) / Math.max(1, textLen)), seqLen - 1));
    const te = Math.max(ts + 1, Math.min(Math.ceil((ce * seqLen) / Math.max(1, textLen)), seqLen));
    return [ts, te];
  }
  let first = -1;
  let last = -1;
  for (let i = 0; i < offsets.length; i++) {
    const [os, oe] = offsets[i]!;
    if (os >= cs && os < ce) {
      if (first < 0) first = i;
      last = i + 1;
    } else if (first < 0 && oe > cs && os < ce) {
      first = i;
      last = i + 1;
    } else if (os >= ce && first >= 0) {
      break;
    }
  }
  if (first < 0) {
    first = Math.max(0, Math.min(Math.floor((cs * seqLen) / Math.max(1, textLen)), seqLen - 1));
    last = Math.min(seqLen, first + 1);
  }
  return [first, Math.max(first + 1, Math.min(last, seqLen))];
}

export function mapCharChunksToTokenSpans(
  rawText: string,
  chunks: readonly RawCharChunk[],
  seqLen: number,
  offsets: readonly [number, number][],
  explicitChunks?: readonly ChunkInput[],
): { meta: ChunkDescriptor[]; spans: Array<[number, number]> } {
  if (seqLen <= 0) {
    return {
      meta: [{ index: 0, label: "State", token_start: 0, token_end: 1 }],
      spans: [[0, 1]],
    };
  }
  const meta: ChunkDescriptor[] = [];
  const spans: Array<[number, number]> = [];
  if (explicitChunks && explicitChunks.length > 0) {
    for (let i = 0; i < explicitChunks.length; i++) {
      const c = explicitChunks[i]!;
      const label = c.label ?? `Chunk ${i}`;
      let ts: number;
      let te: number;
      if (typeof c.token_start === "number" && typeof c.token_end === "number") {
        ts = Math.max(0, Math.min(Math.floor(c.token_start), seqLen - 1));
        te = Math.max(ts + 1, Math.min(Math.floor(c.token_end), seqLen));
      } else {
        [ts, te] = charSpanToTokens(c.char_start ?? 0, c.char_end ?? rawText.length, Math.max(1, rawText.length), seqLen, offsets);
      }
      meta.push({ index: i, label, token_start: ts, token_end: te });
      spans.push([ts, te]);
    }
    return { meta, spans };
  }
  const textLen = Math.max(1, rawText.length);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const [ts, te] = charSpanToTokens(c.charStart, c.charEnd, textLen, seqLen, offsets);
    meta.push({ index: i, label: c.label, token_start: ts, token_end: te });
    spans.push([ts, te]);
  }
  return { meta, spans };
}

export interface NormalizedQuestion {
  readonly type: "noul" | "choice" | "score" | "locus";
  readonly instructions: string;
  readonly choiceCriteria?: Record<string, string>;
  readonly scoreCriteria?: string[];
}

export function normalizeQuestion(raw: Record<string, unknown>): NormalizedQuestion {
  const qtype = String(raw.type ?? "noul").toLowerCase();
  let instr = serializeEntry(raw.instructions).trim();
  if (qtype === "noul") {
    const crit = raw.criteria;
    if (crit && typeof crit === "object" && !Array.isArray(crit)) {
      const rec = crit as Record<string, unknown>;
      const extras: string[] = [];
      if (rec.true !== undefined && rec.true !== null) extras.push(`Yes: ${serializeEntry(rec.true)}`);
      if (rec.false !== undefined && rec.false !== null) extras.push(`No: ${serializeEntry(rec.false)}`);
      if (extras.length > 0) {
        const suffix = extras.join(" | ");
        instr = instr ? `${instr} (${suffix})` : suffix;
      }
    }
    return { type: "noul", instructions: instr || "Does the condition hold?" };
  }
  if (qtype === "choice") {
    const rawCrit = (raw.criteria && typeof raw.criteria === "object" && !Array.isArray(raw.criteria)
      ? raw.criteria
      : {}) as Record<string, unknown>;
    const choiceCriteria: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawCrit)) {
      choiceCriteria[k] = v !== undefined && v !== null ? serializeEntry(v) : k;
    }
    return { type: "choice", instructions: instr || "Select the best option.", choiceCriteria };
  }
  if (qtype === "score") {
    const rawCrit = Array.isArray(raw.criteria) ? raw.criteria : [];
    const scoreCriteria = rawCrit.map((c) => serializeEntry(c));
    return { type: "score", instructions: instr || "Rate on the rubric scale.", scoreCriteria };
  }
  if (qtype === "locus") {
    return { type: "locus", instructions: instr || "Locate the chunk most responsible for the verdict." };
  }
  throw new Error(`Unsupported question type: ${qtype}`);
}

export function formatProbePrompt(
  headType: "noul" | "choice" | "score" | "locus" | "salience",
  question: { instructions?: string; criteria?: Record<string, string> | readonly string[] },
): { prompt: string; optionStrings: string[]; optionKeys?: string[] } {
  const instr = String(question.instructions ?? "").trim();
  if (headType === "noul") {
    return { prompt: `\n[S1:NOUL] ${instr}\n[ANS]`, optionStrings: [] };
  }
  if (headType === "choice") {
    const criteria = (question.criteria && !Array.isArray(question.criteria) ? question.criteria : {}) as Record<string, string>;
    const optionKeys = Object.keys(criteria);
    const optionStrings = optionKeys.map((k) => `${k}: ${criteria[k] ?? k}`);
    return {
      prompt: `\n[S1:CHOICE] ${instr}\nOptions: ${optionStrings.join(" | ")}\n[ANS]`,
      optionStrings,
      optionKeys,
    };
  }
  if (headType === "score") {
    const criteria = Array.isArray(question.criteria) ? question.criteria : [];
    const scaleBlock = criteria.map((c, i) => `${i}=${c}`).join(" | ");
    return { prompt: `\n[S1:SCORE] ${instr}\nScale(${criteria.length}): ${scaleBlock}\n[ANS]`, optionStrings: [] };
  }
  if (headType === "locus") {
    return { prompt: `\n[S1:LOCUS] ${instr}\n[ANS]`, optionStrings: [] };
  }
  return { prompt: `\n[S1:SALIENCE] ${instr}\n[ANS]`, optionStrings: [] };
}

export function projectScoreBins(
  binProbs: ArrayLike<number>,
  numLevelsRaw: number,
): { score: number; expected01: number; confidence: number; probabilities: Record<string, number> } {
  const numLevels = Math.max(2, Math.floor(numLevelsRaw));
  const nBins = binProbs.length;
  const probs = new Float64Array(nBins);
  let sum = 0;
  for (let i = 0; i < nBins; i++) {
    const v = Math.max(0, Math.min(1, Number(binProbs[i]) || 0));
    probs[i] = v;
    sum += v;
  }
  for (let i = 0; i < nBins; i++) {
    probs[i] = sum > 0 ? probs[i]! / sum : 1 / Math.max(1, nBins);
  }
  let expected01 = 0;
  const levelProbs = new Float64Array(numLevels);
  for (let b = 0; b < nBins; b++) {
    const center = nBins > 1 ? b / (nBins - 1) : 0;
    const pb = probs[b]!;
    expected01 += pb * center;
    const pos = center * (numLevels - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(numLevels - 1, lo + 1);
    const frac = pos - lo;
    levelProbs[lo] = levelProbs[lo]! + pb * (1 - frac);
    levelProbs[hi] = levelProbs[hi]! + pb * frac;
  }
  let lsum = 0;
  for (let i = 0; i < numLevels; i++) lsum += levelProbs[i]!;
  const probabilities: Record<string, number> = {};
  let maxP = 0;
  for (let i = 0; i < numLevels; i++) {
    const v = lsum > 0 ? levelProbs[i]! / lsum : 1 / numLevels;
    probabilities[String(i)] = Number(v.toFixed(6));
    if (v > maxP) maxP = v;
  }
  const score = Math.max(0, Math.min(numLevels - 1, expected01 * (numLevels - 1)));
  return {
    score: Number(score.toFixed(6)),
    expected01: Number(Math.max(0, Math.min(1, expected01)).toFixed(6)),
    confidence: Number(maxP.toFixed(6)),
    probabilities,
  };
}

export interface OnnxState {
  readonly prefixLen: number;
  readonly tensors: Record<string, OrtTensorLike>;
}

export interface ChunkAccumulatorState {
  readonly spans: Array<[number, number]>;
  readonly sums: Array<Float64Array | null>;
  readonly counts: number[];
  readonly meta: ChunkDescriptor[];
}

export interface SessionPageRecord {
  readonly ids: number[];
  readonly state: OnnxState;
  readonly ckptRec: Record<string, OrtTensorLike> | null;
  readonly ckptLen: number;
  readonly fullChunks: ChunkAccumulatorState;
  readonly ckptChunks: ChunkAccumulatorState | null;
  readonly chunkReprs: OrtTensorLike;
}

function toBigInt64Array(ids: readonly number[]): BigInt64Array {
  const out = new BigInt64Array(ids.length);
  for (let i = 0; i < ids.length; i++) out[i] = BigInt(ids[i]!);
  return out;
}

function cloneFloat32Tensor(ort: OrtLike, t: OrtTensorLike): OrtTensorLike {
  const src = t.data as Float32Array;
  return new ort.Tensor("float32", new Float32Array(src), [...t.dims]);
}

function sliceKvTensor(ort: OrtLike, t: OrtTensorLike, targetLen: number): OrtTensorLike {
  const dims = t.dims;
  const b = dims[0] ?? 1;
  const heads = dims[1] ?? 2;
  const seqLen = dims[2] ?? 0;
  const headDim = dims[3] ?? 256;
  const clamped = Math.max(0, Math.min(targetLen, seqLen));
  const src = t.data as Float32Array;
  if (clamped === seqLen) {
    return new ort.Tensor("float32", new Float32Array(src), [b, heads, clamped, headDim]);
  }
  const out = new Float32Array(b * heads * clamped * headDim);
  const srcStride = seqLen * headDim;
  const dstStride = clamped * headDim;
  for (let bi = 0; bi < b; bi++) {
    for (let hi = 0; hi < heads; hi++) {
      const srcOff = (bi * heads + hi) * srcStride;
      const dstOff = (bi * heads + hi) * dstStride;
      out.set(src.subarray(srcOff, srcOff + dstStride), dstOff);
    }
  }
  return new ort.Tensor("float32", out, [b, heads, clamped, headDim]);
}

function cloneChunkAccumulators(src: ChunkAccumulatorState): ChunkAccumulatorState {
  return {
    spans: src.spans.map(([s, e]) => [s, e]),
    sums: src.sums.map((a) => (a ? new Float64Array(a) : null)),
    counts: [...src.counts],
    meta: src.meta.map((m) => ({ ...m })),
  };
}

function buildReusedAccumulators(
  targetSpans: readonly [number, number][],
  resumeOffset: number,
  base: ChunkAccumulatorState | null,
): { sums: Array<Float64Array | null>; counts: number[] } | null {
  if (!base) return null;
  const exactMap = new Map<string, number>();
  const startMap = new Map<number, number>();
  for (let bi = 0; bi < base.spans.length; bi++) {
    const [bs, be] = base.spans[bi]!;
    exactMap.set(`${bs}:${be}`, bi);
    if (be >= resumeOffset && base.counts[bi] === Math.max(0, resumeOffset - bs)) {
      startMap.set(bs, bi);
    }
  }
  const sums: Array<Float64Array | null> = [];
  const counts: number[] = [];
  for (const [cs, ce] of targetSpans) {
    if (cs >= resumeOffset) {
      sums.push(null);
      counts.push(0);
    } else if (ce <= resumeOffset) {
      const bi = exactMap.get(`${cs}:${ce}`);
      if (bi === undefined || base.counts[bi] !== ce - cs || !base.sums[bi]) return null;
      sums.push(new Float64Array(base.sums[bi]!));
      counts.push(base.counts[bi]!);
    } else {
      const bi = startMap.get(cs);
      if (bi === undefined) return null;
      sums.push(base.sums[bi] ? new Float64Array(base.sums[bi]!) : null);
      counts.push(base.counts[bi]!);
    }
  }
  return { sums, counts };
}

export async function loadOrtModule(ortPath?: string, stateDir?: string): Promise<OrtLike> {
  const candidates: string[] = [];
  if (ortPath) candidates.push(ortPath);
  candidates.push("onnxruntime-node");
  if (stateDir) {
    const localOrtPkg = join(stateDir, "runtime", "node_modules", "onnxruntime-node", "dist", "index.js");
    const localOrtCjs = join(stateDir, "runtime", "node_modules", "onnxruntime-node", "bin", "napi-v3", "index.js");
    const localOrtRoot = join(stateDir, "runtime", "node_modules", "onnxruntime-node", "package.json");
    if (existsSync(localOrtPkg)) candidates.push(pathToFileURL(localOrtPkg).href);
    else if (existsSync(localOrtCjs)) candidates.push(pathToFileURL(localOrtCjs).href);
    else if (existsSync(localOrtRoot)) {
      const pkg = JSON.parse(readFileSync(localOrtRoot, "utf8")) as { main?: string };
      if (pkg.main) candidates.push(pathToFileURL(join(dirname(localOrtRoot), pkg.main)).href);
    }
  }
  let lastErr: unknown = null;
  for (const spec of candidates) {
    try {
      const target = spec.startsWith("/") || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec;
      const mod = (await import(target)) as { default?: OrtLike } & OrtLike;
      const ort = mod.default ?? mod;
      if (ort && ort.Tensor && ort.InferenceSession) return ort;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `onnxruntime-node could not be loaded (tried ${candidates.join(", ")}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

export class WardenS1OnnxBackend {
  readonly ort: OrtLike;
  readonly manifest: OnnxModelManifest;
  readonly tokenizer: ByteLevelBPETokenizer;
  readonly embedSession: OrtSessionLike;
  readonly backboneSession: OrtSessionLike;
  readonly headsSession: OrtSessionLike;
  readonly hiddenSize: number;
  readonly maxChunkLen: number;
  readonly linearLayers: readonly number[];
  readonly fullLayers: readonly number[];
  readonly convDim: number;
  readonly convKernel: number;
  readonly linearNumHeads: number;
  readonly linearHeadDim: number;
  readonly fullNumKvHeads: number;
  readonly fullHeadDim: number;
  readonly scoreBins: number;
  readonly backboneOutputs: readonly string[];

  constructor(params: {
    ort: OrtLike;
    manifest: OnnxModelManifest;
    tokenizer: ByteLevelBPETokenizer;
    embedSession: OrtSessionLike;
    backboneSession: OrtSessionLike;
    headsSession: OrtSessionLike;
  }) {
    this.ort = params.ort;
    this.manifest = params.manifest;
    this.tokenizer = params.tokenizer;
    this.embedSession = params.embedSession;
    this.backboneSession = params.backboneSession;
    this.headsSession = params.headsSession;
    const arch = params.manifest.architecture;
    this.hiddenSize = arch.hidden_size ?? HIDDEN_SIZE;
    this.maxChunkLen = arch.max_chunk_len ?? MAX_CHUNK_LEN;
    this.linearLayers = arch.linear_layers ?? LINEAR_LAYERS;
    this.fullLayers = arch.full_layers ?? FULL_LAYERS;
    this.convDim = arch.linear_conv_dim ?? 6144;
    this.convKernel = arch.linear_conv_kernel ?? 4;
    this.linearNumHeads = arch.linear_num_heads ?? 16;
    this.linearHeadDim = arch.linear_head_dim ?? 128;
    this.fullNumKvHeads = arch.full_num_kv_heads ?? 2;
    this.fullHeadDim = arch.full_head_dim ?? 256;
    this.scoreBins = arch.score_bins ?? 5;
    this.backboneOutputs = params.manifest.models.backbone.outputs;
  }

  static async loadFromLocalDir(params: {
    modelDir: string;
    ortPath?: string;
    stateDir?: string;
    providers?: readonly string[];
  }): Promise<WardenS1OnnxBackend> {
    const ort = await loadOrtModule(params.ortPath, params.stateDir);
    const manifestRaw = await readFile(join(params.modelDir, "onnx_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as OnnxModelManifest;
    const tokFile = manifest.auxiliary?.tokenizer ?? "tokenizer.json";
    const tokRaw = await readFile(join(params.modelDir, tokFile), "utf8");
    const tokenizer = new ByteLevelBPETokenizer(JSON.parse(tokRaw) as TokenizerJsonLike);
    const providers = params.providers && params.providers.length > 0 ? [...params.providers] : ["cpu"];
    const opts = { executionProviders: providers, graphOptimizationLevel: "all" };
    const embedSession = await ort.InferenceSession.create(join(params.modelDir, manifest.models.embed.onnx), opts);
    const backboneSession = await ort.InferenceSession.create(join(params.modelDir, manifest.models.backbone.onnx), opts);
    const headsSession = await ort.InferenceSession.create(join(params.modelDir, manifest.models.heads.onnx), opts);
    return new WardenS1OnnxBackend({ ort, manifest, tokenizer, embedSession, backboneSession, headsSession });
  }

  initEmptyState(): OnnxState {
    const tensors: Record<string, OrtTensorLike> = {};
    for (const li of this.linearLayers) {
      tensors[`past_conv_${li}`] = new this.ort.Tensor("float32", new Float32Array(this.convDim * this.convKernel), [
        1,
        this.convDim,
        this.convKernel,
      ]);
      tensors[`past_rec_${li}`] = new this.ort.Tensor(
        "float32",
        new Float32Array(this.linearNumHeads * this.linearHeadDim * this.linearHeadDim),
        [1, this.linearNumHeads, this.linearHeadDim, this.linearHeadDim],
      );
    }
    for (const fi of this.fullLayers) {
      tensors[`past_key_${fi}`] = new this.ort.Tensor("float32", new Float32Array(0), [1, this.fullNumKvHeads, 0, this.fullHeadDim]);
      tensors[`past_value_${fi}`] = new this.ort.Tensor("float32", new Float32Array(0), [
        1,
        this.fullNumKvHeads,
        0,
        this.fullHeadDim,
      ]);
    }
    return { prefixLen: 0, tensors };
  }

  snapshotRecurrentState(state: OnnxState): Record<string, OrtTensorLike> {
    const snap: Record<string, OrtTensorLike> = {};
    for (const li of this.linearLayers) {
      snap[`past_conv_${li}`] = cloneFloat32Tensor(this.ort, state.tensors[`past_conv_${li}`]!);
      snap[`past_rec_${li}`] = cloneFloat32Tensor(this.ort, state.tensors[`past_rec_${li}`]!);
    }
    return snap;
  }

  restoreFromBoundaryCheckpoint(fullState: OnnxState, ckptRec: Record<string, OrtTensorLike>, ckptLen: number): OnnxState {
    const tensors: Record<string, OrtTensorLike> = {};
    for (const li of this.linearLayers) {
      tensors[`past_conv_${li}`] = cloneFloat32Tensor(this.ort, ckptRec[`past_conv_${li}`]!);
      tensors[`past_rec_${li}`] = cloneFloat32Tensor(this.ort, ckptRec[`past_rec_${li}`]!);
    }
    for (const fi of this.fullLayers) {
      tensors[`past_key_${fi}`] = sliceKvTensor(this.ort, fullState.tensors[`past_key_${fi}`]!, ckptLen);
      tensors[`past_value_${fi}`] = sliceKvTensor(this.ort, fullState.tensors[`past_value_${fi}`]!, ckptLen);
    }
    return { prefixLen: ckptLen, tensors };
  }

  cloneState(state: OnnxState): OnnxState {
    const tensors: Record<string, OrtTensorLike> = {};
    for (const [k, t] of Object.entries(state.tensors)) {
      tensors[k] = cloneFloat32Tensor(this.ort, t);
    }
    return { prefixLen: state.prefixLen, tensors };
  }

  async embedIds(ids: readonly number[]): Promise<OrtTensorLike> {
    const safeIds = ids.length > 0 ? ids : [0];
    const input = new this.ort.Tensor("int64", toBigInt64Array(safeIds), [1, safeIds.length]);
    const res = await this.embedSession.run({ input_ids: input });
    return res.inputs_embeds!;
  }

  async stepChunk(chunkIds: readonly number[], state: OnnxState, mutate: boolean): Promise<{ hidden: OrtTensorLike; state: OnnxState }> {
    const seqLen = chunkIds.length;
    if (seqLen < 1 || seqLen > this.maxChunkLen) {
      throw new Error(`Chunk length ${seqLen} must be in [1, ${this.maxChunkLen}]`);
    }
    const embeds = await this.embedIds(chunkIds);
    const pos = new BigInt64Array(seqLen);
    for (let i = 0; i < seqLen; i++) pos[i] = BigInt(state.prefixLen + i);
    const feeds: Record<string, OrtTensorLike> = {
      inputs_embeds: embeds,
      position_ids: new this.ort.Tensor("int64", pos, [seqLen]),
      ...state.tensors,
    };
    const outs = await this.backboneSession.run(feeds);
    const hidden = outs.hidden_states!;
    if (!mutate) return { hidden, state };
    const nextTensors: Record<string, OrtTensorLike> = {};
    for (const outName of this.backboneOutputs.slice(1)) {
      const pastName = outName.replace(/^present_/, "past_");
      nextTensors[pastName] = outs[outName]!;
    }
    return { hidden, state: { prefixLen: state.prefixLen + seqLen, tensors: nextTensors } };
  }

  buildChunkReprsTensor(spans: readonly [number, number][], sums: readonly (Float64Array | null)[], counts: readonly number[]): OrtTensorLike {
    const nChunks = Math.max(1, spans.length);
    const buf = new Float32Array(nChunks * this.hiddenSize);
    for (let ci = 0; ci < spans.length; ci++) {
      const cnt = counts[ci] ?? 0;
      const sum = sums[ci];
      if (cnt > 0 && sum) {
        const inv = 1 / cnt;
        const base = ci * this.hiddenSize;
        for (let d = 0; d < this.hiddenSize; d++) buf[base + d] = sum[d]! * inv;
      }
    }
    return new this.ort.Tensor("float32", buf, [nChunks, this.hiddenSize]);
  }

  async encodeSlice(
    tokenIds: readonly number[],
    prevState: OnnxState | null,
    chunkSpans: readonly [number, number][],
    spanSums: Array<Float64Array | null>,
    spanCounts: number[],
  ): Promise<{ state: OnnxState; chunkReprs: OrtTensorLike }> {
    let state = prevState ?? this.initEmptyState();
    const startOffset = state.prefixLen;
    for (let s = 0; s < tokenIds.length; s += this.maxChunkLen) {
      const e = Math.min(s + this.maxChunkLen, tokenIds.length);
      const step = await this.stepChunk(tokenIds.slice(s, e), state, true);
      state = step.state;
      const hData = step.hidden.data as Float32Array;
      const absS = startOffset + s;
      const absE = startOffset + e;
      for (let ci = 0; ci < chunkSpans.length; ci++) {
        const [cs, ce] = chunkSpans[ci]!;
        const ovS = Math.max(cs, absS);
        const ovE = Math.min(ce, absE);
        if (ovE > ovS) {
          let dst = spanSums[ci];
          if (!dst) {
            dst = new Float64Array(this.hiddenSize);
            spanSums[ci] = dst;
          }
          for (let t = ovS - absS; t < ovE - absS; t++) {
            const base = t * this.hiddenSize;
            for (let d = 0; d < this.hiddenSize; d++) dst[d] = dst[d]! + hData[base + d]!;
          }
          spanCounts[ci] = (spanCounts[ci] ?? 0) + (ovE - ovS);
        }
      }
    }
    const chunkReprs = this.buildChunkReprsTensor(chunkSpans, spanSums, spanCounts);
    return { state, chunkReprs };
  }

  async scoreProbes(
    state: OnnxState,
    chunkReprs: OrtTensorLike,
    queryIdsList: readonly (readonly number[])[],
    choiceQueryIndices: readonly number[],
    choiceOptionIdsList: readonly (readonly (readonly number[])[])[],
  ): Promise<{
    noulProbs: number[];
    scoreProbs: OrtTensorLike;
    locusProbs: OrtTensorLike;
    salienceProbs: number[];
    choiceProbs: OrtTensorLike;
  }> {
    const numQ = Math.max(1, queryIdsList.length);
    const qMat = new Float32Array(numQ * this.hiddenSize);
    for (let qi = 0; qi < queryIdsList.length; qi++) {
      const qIds = queryIdsList[qi]!;
      let lastHidden: OrtTensorLike;
      if (qIds.length <= this.maxChunkLen) {
        const step = await this.stepChunk(qIds, state, false);
        lastHidden = step.hidden;
      } else {
        let cur = this.cloneState(state);
        let chunkHidden: OrtTensorLike | null = null;
        for (let s = 0; s < qIds.length; s += this.maxChunkLen) {
          const e = Math.min(s + this.maxChunkLen, qIds.length);
          const step = await this.stepChunk(qIds.slice(s, e), cur, e < qIds.length);
          cur = step.state;
          chunkHidden = step.hidden;
        }
        lastHidden = chunkHidden!;
      }
      const seqLen = lastHidden.dims[1] ?? 1;
      const srcOff = (seqLen - 1) * this.hiddenSize;
      qMat.set((lastHidden.data as Float32Array).subarray(srcOff, srcOff + this.hiddenSize), qi * this.hiddenSize);
    }

    let cQTensor: OrtTensorLike;
    let optReprsTensor: OrtTensorLike;
    let optMaskTensor: OrtTensorLike;
    if (choiceQueryIndices.length > 0 && choiceOptionIdsList.length > 0) {
      const numC = choiceQueryIndices.length;
      const maxOpts = Math.max(1, ...choiceOptionIdsList.map((o) => o.length));
      const cqBuf = new Float32Array(numC * this.hiddenSize);
      const optBuf = new Float32Array(numC * maxOpts * this.hiddenSize);
      const maskBuf = new Float32Array(numC * maxOpts);
      for (let ci = 0; ci < numC; ci++) {
        const qi = choiceQueryIndices[ci]!;
        cqBuf.set(qMat.subarray(qi * this.hiddenSize, (qi + 1) * this.hiddenSize), ci * this.hiddenSize);
        const opts = choiceOptionIdsList[ci]!;
        for (let oi = 0; oi < opts.length; oi++) {
          const emb = await this.embedIds(opts[oi]!);
          const embData = emb.data as Float32Array;
          const tokCount = Math.max(1, opts[oi]!.length);
          const dstBase = (ci * maxOpts + oi) * this.hiddenSize;
          for (let t = 0; t < tokCount; t++) {
            const srcBase = t * this.hiddenSize;
            for (let d = 0; d < this.hiddenSize; d++) {
              optBuf[dstBase + d] = optBuf[dstBase + d]! + embData[srcBase + d]! / tokCount;
            }
          }
          maskBuf[ci * maxOpts + oi] = 1.0;
        }
      }
      cQTensor = new this.ort.Tensor("float32", cqBuf, [numC, this.hiddenSize]);
      optReprsTensor = new this.ort.Tensor("float32", optBuf, [numC, maxOpts, this.hiddenSize]);
      optMaskTensor = new this.ort.Tensor("float32", maskBuf, [numC, maxOpts]);
    } else {
      cQTensor = new this.ort.Tensor("float32", new Float32Array(this.hiddenSize), [1, this.hiddenSize]);
      optReprsTensor = new this.ort.Tensor("float32", new Float32Array(2 * this.hiddenSize), [1, 2, this.hiddenSize]);
      optMaskTensor = new this.ort.Tensor("float32", new Float32Array([1, 1]), [1, 2]);
    }

    const headsOut = await this.headsSession.run({
      query_repr: new this.ort.Tensor("float32", qMat, [numQ, this.hiddenSize]),
      chunk_reprs: chunkReprs,
      choice_query_repr: cQTensor,
      option_reprs: optReprsTensor,
      option_mask: optMaskTensor,
    });

    return {
      noulProbs: Array.from(headsOut.noul_probs!.data as Float32Array),
      scoreProbs: headsOut.score_probs!,
      locusProbs: headsOut.locus_probs!,
      salienceProbs: Array.from(headsOut.salience_probs!.data as Float32Array),
      choiceProbs: headsOut.choice_probs!,
    };
  }
}

export function createSyntheticOnnxBackend(options?: {
  tokenizer?: ByteLevelBPETokenizer;
  hiddenSize?: number;
  stepDelayMs?: number;
}): WardenS1OnnxBackend {
  const hiddenSize = options?.hiddenSize ?? 16;
  const convDim = 8;
  const convKernel = 4;
  const linearNumHeads = 2;
  const linearHeadDim = 4;
  const fullNumKvHeads = 2;
  const fullHeadDim = 8;
  const scoreBins = 5;
  const stepDelayMs = options?.stepDelayMs ?? 0;

  class SyntheticTensor implements OrtTensorLike {
    readonly type: string;
    readonly data: Float32Array | BigInt64Array | Int32Array | Uint8Array;
    readonly dims: readonly number[];
    constructor(type: string, data: Float32Array | BigInt64Array | Int32Array | Uint8Array, dims: readonly number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }

  const ort: OrtLike = {
    Tensor: SyntheticTensor,
    InferenceSession: {
      async create() {
        throw new Error("Synthetic ORT does not load external ONNX files");
      },
    },
  };

  const outputs: string[] = ["hidden_states"];
  for (const li of LINEAR_LAYERS) {
    outputs.push(`present_conv_${li}`, `present_rec_${li}`);
  }
  for (const fi of FULL_LAYERS) {
    outputs.push(`present_key_${fi}`, `present_value_${fi}`);
  }

  const manifest: OnnxModelManifest = {
    architecture: {
      hidden_size: hiddenSize,
      max_chunk_len: MAX_CHUNK_LEN,
      linear_layers: LINEAR_LAYERS,
      full_layers: FULL_LAYERS,
      linear_conv_dim: convDim,
      linear_conv_kernel: convKernel,
      linear_num_heads: linearNumHeads,
      linear_head_dim: linearHeadDim,
      full_num_kv_heads: fullNumKvHeads,
      full_head_dim: fullHeadDim,
      score_bins: scoreBins,
    },
    models: {
      embed: { onnx: "synthetic_embed.onnx" },
      backbone: { onnx: "synthetic_backbone.onnx", outputs },
      heads: { onnx: "synthetic_heads.onnx" },
    },
  };

  const embedSession: OrtSessionLike = {
    async run(feeds) {
      const ids = feeds.input_ids!.data as BigInt64Array;
      const seqLen = ids.length;
      const out = new Float32Array(seqLen * hiddenSize);
      for (let t = 0; t < seqLen; t++) {
        const id = Number(ids[t]!);
        for (let d = 0; d < hiddenSize; d++) {
          out[t * hiddenSize + d] = Math.sin((id + 1) * 0.37 + (d + 1) * 0.53) * 0.5 + Math.cos((id + 3) * (d + 1) * 0.11) * 0.25;
        }
      }
      return { inputs_embeds: new SyntheticTensor("float32", out, [1, seqLen, hiddenSize]) };
    },
  };

  // Stateful causal hybrid backbone: updates conv window, gated DeltaNet recurrence, and GQA KV cache.
  const backboneSession: OrtSessionLike = {
    async run(feeds) {
      if (stepDelayMs > 0) await new Promise((r) => setTimeout(r, stepDelayMs));
      const embeds = feeds.inputs_embeds!.data as Float32Array;
      const posIds = feeds.position_ids!.data as BigInt64Array;
      const seqLen = posIds.length;
      const hidden = new Float32Array(seqLen * hiddenSize);

      const nextConv: Record<number, Float32Array> = {};
      const nextRec: Record<number, Float32Array> = {};
      for (const li of LINEAR_LAYERS) {
        nextConv[li] = new Float32Array(feeds[`past_conv_${li}`]!.data as Float32Array);
        nextRec[li] = new Float32Array(feeds[`past_rec_${li}`]!.data as Float32Array);
      }

      const pastLen = feeds[`past_key_${FULL_LAYERS[0]}`]!.dims[2] ?? 0;
      const newLen = pastLen + seqLen;
      const nextKey: Record<number, Float32Array> = {};
      const nextVal: Record<number, Float32Array> = {};
      for (const fi of FULL_LAYERS) {
        const pk = feeds[`past_key_${fi}`]!.data as Float32Array;
        const pv = feeds[`past_value_${fi}`]!.data as Float32Array;
        const nk = new Float32Array(fullNumKvHeads * newLen * fullHeadDim);
        const nv = new Float32Array(fullNumKvHeads * newLen * fullHeadDim);
        for (let h = 0; h < fullNumKvHeads; h++) {
          nk.set(pk.subarray(h * pastLen * fullHeadDim, (h + 1) * pastLen * fullHeadDim), h * newLen * fullHeadDim);
          nv.set(pv.subarray(h * pastLen * fullHeadDim, (h + 1) * pastLen * fullHeadDim), h * newLen * fullHeadDim);
        }
        nextKey[fi] = nk;
        nextVal[fi] = nv;
      }

      const conv0 = nextConv[LINEAR_LAYERS[0]]!;
      const rec0 = nextRec[LINEAR_LAYERS[0]]!;
      const key0 = nextKey[FULL_LAYERS[0]]!;
      const val0 = nextVal[FULL_LAYERS[0]]!;

      for (let t = 0; t < seqLen; t++) {
        const pos = Number(posIds[t]!);
        const eBase = t * hiddenSize;
        for (let c = 0; c < convDim; c++) {
          const row = c * convKernel;
          conv0[row] = conv0[row + 1]!;
          conv0[row + 1] = conv0[row + 2]!;
          conv0[row + 2] = conv0[row + 3]!;
          conv0[row + 3] = embeds[eBase + (c % hiddenSize)]!;
        }
        for (let r = 0; r < linearNumHeads * linearHeadDim * linearHeadDim; r++) {
          const a = embeds[eBase + (r % hiddenSize)]!;
          const b = embeds[eBase + ((r * 3 + 1) % hiddenSize)]!;
          rec0[r] = rec0[r]! * 0.92 + a * b * 0.08;
        }
        const kvPos = pastLen + t;
        for (let h = 0; h < fullNumKvHeads; h++) {
          const off = (h * newLen + kvPos) * fullHeadDim;
          for (let d = 0; d < fullHeadDim; d++) {
            const x = embeds[eBase + ((h * fullHeadDim + d) % hiddenSize)]!;
            key0[off + d] = x * Math.cos((pos + 1) * 0.07 + d * 0.13);
            val0[off + d] = x * Math.sin((pos + 1) * 0.05 + d * 0.19) + 0.1 * x;
          }
        }
        const attnOut = new Float32Array(fullHeadDim);
        const kvCount = kvPos + 1;
        let wSum = 0;
        const weights = new Float32Array(kvCount);
        const qOff = kvPos * fullHeadDim;
        for (let j = 0; j < kvCount; j++) {
          let dot = 0;
          const kOff = j * fullHeadDim;
          for (let d = 0; d < fullHeadDim; d++) dot += key0[qOff + d]! * key0[kOff + d]!;
          const w = Math.exp(Math.max(-10, Math.min(10, dot * 0.25)));
          weights[j] = w;
          wSum += w;
        }
        for (let j = 0; j < kvCount; j++) {
          const w = weights[j]! / Math.max(1e-9, wSum);
          const vOff = j * fullHeadDim;
          for (let d = 0; d < fullHeadDim; d++) attnOut[d] = attnOut[d]! + w * val0[vOff + d]!;
        }
        for (let d = 0; d < hiddenSize; d++) {
          const cRow = (d % convDim) * convKernel;
          const convSum = (conv0[cRow]! + conv0[cRow + 1]! + conv0[cRow + 2]! + conv0[cRow + 3]!) * 0.25;
          const recVal = rec0[d % rec0.length]!;
          const attVal = attnOut[d % fullHeadDim]!;
          hidden[eBase + d] = Math.tanh(embeds[eBase + d]! * 0.5 + convSum * 0.35 + recVal * 0.4 + attVal * 0.45);
        }
      }

      const res: Record<string, OrtTensorLike> = {
        hidden_states: new SyntheticTensor("float32", hidden, [1, seqLen, hiddenSize]),
      };
      for (const li of LINEAR_LAYERS) {
        res[`present_conv_${li}`] = new SyntheticTensor("float32", nextConv[li]!, [1, convDim, convKernel]);
        res[`present_rec_${li}`] = new SyntheticTensor("float32", nextRec[li]!, [1, linearNumHeads, linearHeadDim, linearHeadDim]);
      }
      for (const fi of FULL_LAYERS) {
        res[`present_key_${fi}`] = new SyntheticTensor("float32", nextKey[fi]!, [1, fullNumKvHeads, newLen, fullHeadDim]);
        res[`present_value_${fi}`] = new SyntheticTensor("float32", nextVal[fi]!, [1, fullNumKvHeads, newLen, fullHeadDim]);
      }
      return res;
    },
  };

  const sigmoid = (x: number): number => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
  const softmax = (arr: Float32Array, offset: number, len: number): void => {
    let mx = -Infinity;
    for (let i = 0; i < len; i++) if (arr[offset + i]! > mx) mx = arr[offset + i]!;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const v = Math.exp(arr[offset + i]! - mx);
      arr[offset + i] = v;
      sum += v;
    }
    for (let i = 0; i < len; i++) arr[offset + i] = sum > 0 ? arr[offset + i]! / sum : 1 / Math.max(1, len);
  };

  const headsSession: OrtSessionLike = {
    async run(feeds) {
      const q = feeds.query_repr!.data as Float32Array;
      const numQ = feeds.query_repr!.dims[0] ?? 1;
      const c = feeds.chunk_reprs!.data as Float32Array;
      const numC = feeds.chunk_reprs!.dims[0] ?? 1;
      const cq = feeds.choice_query_repr!.data as Float32Array;
      const numChoice = feeds.choice_query_repr!.dims[0] ?? 1;
      const opt = feeds.option_reprs!.data as Float32Array;
      const maxOpts = feeds.option_reprs!.dims[1] ?? 2;
      const optMask = feeds.option_mask!.data as Float32Array;

      const noulLogits = new Float32Array(numQ);
      const noulProbs = new Float32Array(numQ);
      const scoreLogits = new Float32Array(numQ * scoreBins);
      const scoreProbs = new Float32Array(numQ * scoreBins);
      const scoreExpected = new Float32Array(numQ);
      const locusLogits = new Float32Array(numQ * numC);
      const locusProbs = new Float32Array(numQ * numC);

      for (let qi = 0; qi < numQ; qi++) {
        let s = 0;
        for (let d = 0; d < hiddenSize; d++) s += q[qi * hiddenSize + d]! * ((d % 2 === 0 ? 1 : -0.7) * 0.35);
        noulLogits[qi] = s;
        noulProbs[qi] = sigmoid(s);

        for (let b = 0; b < scoreBins; b++) {
          let sb = 0;
          for (let d = 0; d < hiddenSize; d++) sb += q[qi * hiddenSize + d]! * Math.cos((b + 1) * (d + 1) * 0.23) * 0.25;
          scoreLogits[qi * scoreBins + b] = sb;
          scoreProbs[qi * scoreBins + b] = sb;
        }
        softmax(scoreProbs, qi * scoreBins, scoreBins);
        let exp = 0;
        for (let b = 0; b < scoreBins; b++) exp += scoreProbs[qi * scoreBins + b]! * (b / (scoreBins - 1));
        scoreExpected[qi] = exp;

        for (let ci = 0; ci < numC; ci++) {
          let dot = 0;
          for (let d = 0; d < hiddenSize; d++) dot += q[qi * hiddenSize + d]! * c[ci * hiddenSize + d]!;
          locusLogits[qi * numC + ci] = dot;
          locusProbs[qi * numC + ci] = dot;
        }
        softmax(locusProbs, qi * numC, numC);
      }

      const salienceLogits = new Float32Array(numC);
      const salienceProbs = new Float32Array(numC);
      for (let ci = 0; ci < numC; ci++) {
        let sc = 0;
        for (let d = 0; d < hiddenSize; d++) sc += c[ci * hiddenSize + d]! * (0.2 + 0.05 * (d % 5));
        const posBias = numC > 1 ? (ci / (numC - 1) - 0.5) * 0.3 : 0;
        salienceLogits[ci] = sc + posBias;
        salienceProbs[ci] = sigmoid(sc + posBias);
      }

      const choiceLogits = new Float32Array(numChoice * maxOpts);
      const choiceProbs = new Float32Array(numChoice * maxOpts);
      const choiceConfidence = new Float32Array(numChoice);
      for (let ci = 0; ci < numChoice; ci++) {
        for (let oi = 0; oi < maxOpts; oi++) {
          if (optMask[ci * maxOpts + oi]! <= 0) {
            choiceLogits[ci * maxOpts + oi] = -1e9;
            choiceProbs[ci * maxOpts + oi] = -1e9;
          } else {
            let dot = 0;
            for (let d = 0; d < hiddenSize; d++) {
              dot += cq[ci * hiddenSize + d]! * opt[(ci * maxOpts + oi) * hiddenSize + d]!;
            }
            choiceLogits[ci * maxOpts + oi] = dot;
            choiceProbs[ci * maxOpts + oi] = dot;
          }
        }
        softmax(choiceProbs, ci * maxOpts, maxOpts);
        let best = 0;
        for (let oi = 0; oi < maxOpts; oi++) {
          if (choiceProbs[ci * maxOpts + oi]! > best) best = choiceProbs[ci * maxOpts + oi]!;
        }
        choiceConfidence[ci] = best;
      }

      return {
        noul_logits: new SyntheticTensor("float32", noulLogits, [numQ]),
        noul_probs: new SyntheticTensor("float32", noulProbs, [numQ]),
        score_logits: new SyntheticTensor("float32", scoreLogits, [numQ, scoreBins]),
        score_probs: new SyntheticTensor("float32", scoreProbs, [numQ, scoreBins]),
        score_expected: new SyntheticTensor("float32", scoreExpected, [numQ]),
        locus_logits: new SyntheticTensor("float32", locusLogits, [numQ, numC]),
        locus_probs: new SyntheticTensor("float32", locusProbs, [numQ, numC]),
        salience_logits: new SyntheticTensor("float32", salienceLogits, [numC]),
        salience_probs: new SyntheticTensor("float32", salienceProbs, [numC]),
        choice_logits: new SyntheticTensor("float32", choiceLogits, [numChoice, maxOpts]),
        choice_probs: new SyntheticTensor("float32", choiceProbs, [numChoice, maxOpts]),
        choice_confidence: new SyntheticTensor("float32", choiceConfidence, [numChoice]),
      };
    },
  };

  return new WardenS1OnnxBackend({
    ort,
    manifest,
    tokenizer: options?.tokenizer ?? createByteLevelFallbackTokenizer(),
    embedSession,
    backboneSession,
    headsSession,
  });
}

const PAGE_MAGIC = Buffer.from("WS1P", "ascii");

interface SerializedTensorSpec {
  readonly group: "state" | "ckptRec" | "chunkReprs" | "fullSum" | "ckptSum";
  readonly name: string;
  readonly dims: readonly number[];
  readonly dtype: "float32" | "float64";
  readonly byteLength: number;
}

interface SerializedPageMeta {
  readonly version: 1;
  readonly ids: number[];
  readonly prefixLen: number;
  readonly ckptLen: number;
  readonly fullSpans: Array<[number, number]>;
  readonly fullCounts: number[];
  readonly fullMeta: ChunkDescriptor[];
  readonly ckptSpans: Array<[number, number]> | null;
  readonly ckptCounts: number[] | null;
  readonly ckptMeta: ChunkDescriptor[] | null;
  readonly tensors: SerializedTensorSpec[];
}

export class OnnxSessionPager {
  readonly ramSlots: number;
  readonly pageDir: string;
  readonly ramPages = new Map<string, SessionPageRecord>();
  readonly diskPages = new Map<string, string>();
  l2Swaps = 0;
  l3Swaps = 0;
  readonly swapLatenciesMs: number[] = [];

  constructor(options?: { ramSlots?: number; pageDir?: string }) {
    this.ramSlots = Math.max(1, options?.ramSlots ?? 12);
    this.pageDir = options?.pageDir ?? join(homedir(), ".cache", "pi-warden", "pages");
    mkdirSync(this.pageDir, { recursive: true, mode: 0o700 });
  }

  private safePagePath(sid: string): string {
    const hash = createHash("sha256").update(sid, "utf8").digest("hex").slice(0, 24);
    return join(this.pageDir, `${hash}.ws1page`);
  }

  private serializePage(rec: SessionPageRecord): Buffer {
    const specs: SerializedTensorSpec[] = [];
    const blobs: Buffer[] = [];
    const pushTyped = (
      group: SerializedTensorSpec["group"],
      name: string,
      dims: readonly number[],
      arr: Float32Array | Float64Array,
    ): void => {
      const dtype = arr instanceof Float64Array ? "float64" : "float32";
      const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
      specs.push({ group, name, dims: [...dims], dtype, byteLength: buf.byteLength });
      blobs.push(buf);
    };

    for (const [k, t] of Object.entries(rec.state.tensors)) {
      pushTyped("state", k, t.dims, t.data as Float32Array);
    }
    if (rec.ckptRec) {
      for (const [k, t] of Object.entries(rec.ckptRec)) {
        pushTyped("ckptRec", k, t.dims, t.data as Float32Array);
      }
    }
    pushTyped("chunkReprs", "chunkReprs", rec.chunkReprs.dims, rec.chunkReprs.data as Float32Array);
    for (let i = 0; i < rec.fullChunks.sums.length; i++) {
      const s = rec.fullChunks.sums[i];
      if (s) pushTyped("fullSum", String(i), [s.length], s);
    }
    if (rec.ckptChunks) {
      for (let i = 0; i < rec.ckptChunks.sums.length; i++) {
        const s = rec.ckptChunks.sums[i];
        if (s) pushTyped("ckptSum", String(i), [s.length], s);
      }
    }

    const meta: SerializedPageMeta = {
      version: 1,
      ids: [...rec.ids],
      prefixLen: rec.state.prefixLen,
      ckptLen: rec.ckptLen,
      fullSpans: rec.fullChunks.spans.map(([a, b]) => [a, b]),
      fullCounts: [...rec.fullChunks.counts],
      fullMeta: rec.fullChunks.meta.map((m) => ({ ...m })),
      ckptSpans: rec.ckptChunks ? rec.ckptChunks.spans.map(([a, b]) => [a, b]) : null,
      ckptCounts: rec.ckptChunks ? [...rec.ckptChunks.counts] : null,
      ckptMeta: rec.ckptChunks ? rec.ckptChunks.meta.map((m) => ({ ...m })) : null,
      tensors: specs,
    };
    const metaBuf = Buffer.from(JSON.stringify(meta), "utf8");
    const padLen = (8 - ((8 + metaBuf.byteLength) % 8)) % 8;
    const header = Buffer.allocUnsafe(8);
    PAGE_MAGIC.copy(header, 0);
    header.writeUInt32LE(metaBuf.byteLength, 4);
    const pad = padLen > 0 ? Buffer.alloc(padLen) : Buffer.alloc(0);
    return Buffer.concat([header, metaBuf, pad, ...blobs]);
  }

  private deserializePage(raw: Buffer, ort: OrtLike): SessionPageRecord {
    if (raw.byteLength < 8 || !raw.subarray(0, 4).equals(PAGE_MAGIC)) {
      throw new Error("Invalid Warden-S1 disk page header");
    }
    const metaLen = raw.readUInt32LE(4);
    const metaStart = 8;
    const metaEnd = metaStart + metaLen;
    const meta = JSON.parse(raw.subarray(metaStart, metaEnd).toString("utf8")) as SerializedPageMeta;
    const padLen = (8 - ((8 + metaLen) % 8)) % 8;
    let cursor = metaEnd + padLen;

    const stateTensors: Record<string, OrtTensorLike> = {};
    let ckptRec: Record<string, OrtTensorLike> | null = null;
    let chunkReprs: OrtTensorLike | null = null;
    const fullSums: Array<Float64Array | null> = new Array<Float64Array | null>(meta.fullSpans.length).fill(null);
    const ckptSums: Array<Float64Array | null> | null = meta.ckptSpans
      ? new Array<Float64Array | null>(meta.ckptSpans.length).fill(null)
      : null;

    for (const spec of meta.tensors) {
      const slice = raw.subarray(cursor, cursor + spec.byteLength);
      cursor += spec.byteLength;
      // Copy into a dedicated ArrayBuffer so TypedArray views are guaranteed 8-byte aligned.
      const ab = new ArrayBuffer(spec.byteLength);
      new Uint8Array(ab).set(slice);
      if (spec.dtype === "float64") {
        const f64 = new Float64Array(ab);
        const idx = Number(spec.name);
        if (spec.group === "fullSum") fullSums[idx] = f64;
        else if (spec.group === "ckptSum" && ckptSums) ckptSums[idx] = f64;
      } else {
        const tensor = new ort.Tensor("float32", new Float32Array(ab), spec.dims);
        if (spec.group === "state") stateTensors[spec.name] = tensor;
        else if (spec.group === "ckptRec") {
          if (!ckptRec) ckptRec = {};
          ckptRec[spec.name] = tensor;
        } else if (spec.group === "chunkReprs") {
          chunkReprs = tensor;
        }
      }
    }

    if (!chunkReprs) {
      throw new Error("Corrupted Warden-S1 disk page: missing chunkReprs");
    }
    return {
      ids: meta.ids,
      state: { prefixLen: meta.prefixLen, tensors: stateTensors },
      ckptRec,
      ckptLen: meta.ckptLen,
      fullChunks: {
        spans: meta.fullSpans,
        sums: fullSums,
        counts: meta.fullCounts,
        meta: meta.fullMeta,
      },
      ckptChunks:
        meta.ckptSpans && meta.ckptCounts && meta.ckptMeta && ckptSums
          ? { spans: meta.ckptSpans, sums: ckptSums, counts: meta.ckptCounts, meta: meta.ckptMeta }
          : null,
      chunkReprs,
    };
  }

  writeDiskPage(sid: string, rec: SessionPageRecord): { path: string; rawBytes: number; compBytes: number; writeMs: number } {
    const t0 = performance.now();
    const raw = this.serializePage(rec);
    const comp = zstdCompressSync(raw, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 },
    });
    const outPath = this.safePagePath(sid);
    mkdirSync(this.pageDir, { recursive: true, mode: 0o700 });
    const binTmp = `${outPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeBinaryAtomicSync(binTmp, outPath, comp);
    this.diskPages.set(sid, outPath);
    return {
      path: outPath,
      rawBytes: raw.byteLength,
      compBytes: comp.byteLength,
      writeMs: Number((performance.now() - t0).toFixed(2)),
    };
  }

  pageOut(sid: string, rec: SessionPageRecord): number {
    const t0 = performance.now();
    this.ramPages.delete(sid);
    this.ramPages.set(sid, rec);
    while (this.ramPages.size > this.ramSlots) {
      const oldestKey = this.ramPages.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestRec = this.ramPages.get(oldestKey)!;
      this.ramPages.delete(oldestKey);
      this.writeDiskPage(oldestKey, oldestRec);
    }
    return performance.now() - t0;
  }

  pageIn(sid: string, ort: OrtLike): { tier: "L2_RAM" | "L3_DISK" | "NEW"; record: SessionPageRecord | null; ms: number } {
    const ram = this.ramPages.get(sid);
    if (ram) {
      const t0 = performance.now();
      this.ramPages.delete(sid);
      this.ramPages.set(sid, ram);
      const ms = performance.now() - t0;
      this.l2Swaps += 1;
      return { tier: "L2_RAM", record: ram, ms };
    }
    const diskPath = this.diskPages.get(sid);
    if (diskPath && existsSync(diskPath)) {
      const t0 = performance.now();
      const comp = readFileSync(diskPath);
      const raw = zstdDecompressSync(comp);
      const rec = this.deserializePage(Buffer.from(raw), ort);
      const ms = performance.now() - t0;
      this.l3Swaps += 1;
      return { tier: "L3_DISK", record: rec, ms };
    }
    return { tier: "NEW", record: null, ms: 0 };
  }

  evictRamToDisk(targetSid?: string | null): Array<{ sid: string; raw_mb: number; disk_mb: number; write_ms: number }> {
    const sids = targetSid ? [targetSid] : [...this.ramPages.keys()];
    const evicted: Array<{ sid: string; raw_mb: number; disk_mb: number; write_ms: number }> = [];
    for (const sid of sids) {
      const rec = this.ramPages.get(sid);
      if (!rec) continue;
      this.ramPages.delete(sid);
      const info = this.writeDiskPage(sid, rec);
      evicted.push({
        sid,
        raw_mb: Number((info.rawBytes / (1024 * 1024)).toFixed(3)),
        disk_mb: Number((info.compBytes / (1024 * 1024)).toFixed(3)),
        write_ms: info.writeMs,
      });
    }
    return evicted;
  }

  dropSession(sid: string): boolean {
    let dropped = this.ramPages.delete(sid);
    const diskPath = this.diskPages.get(sid);
    if (diskPath) {
      this.diskPages.delete(sid);
      try {
        unlinkSync(diskPath);
      } catch {
        // Ignore already removed disk page.
      }
      dropped = true;
    }
    return dropped;
  }

  clearAll(): void {
    this.ramPages.clear();
    for (const p of this.diskPages.values()) {
      try {
        unlinkSync(p);
      } catch {
        // Ignore already removed disk page.
      }
    }
    this.diskPages.clear();
  }
}

function writeBinaryAtomicSync(tmpPath: string, finalPath: string, data: Buffer): void {
  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
  writeFileSync(tmpPath, data, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, finalPath);
}

interface QueuedTask<T> {
  readonly fn: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly isInference: boolean;
}

class PriorityTaskQueue {
  private readonly high: Array<QueuedTask<unknown>> = [];
  private readonly low: Array<QueuedTask<unknown>> = [];
  private running = false;
  inFlight = 0;
  lastActivityAt = performance.now();

  get pendingCount(): number {
    return this.high.length + this.low.length;
  }

  idleSeconds(): number {
    if (this.inFlight > 0 || this.running || this.pendingCount > 0) return 0;
    return Math.max(0, (performance.now() - this.lastActivityAt) / 1000);
  }

  enqueue<T>(priority: 0 | 1, isInference: boolean, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolveP, rejectP) => {
      const task: QueuedTask<unknown> = {
        fn: fn as () => Promise<unknown>,
        resolve: resolveP as (v: unknown) => void,
        reject: rejectP,
        isInference,
      };
      if (priority === 0) this.high.push(task);
      else this.low.push(task);
      if (!this.running) void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.high.length > 0 || this.low.length > 0) {
        const next = this.high.shift() ?? this.low.shift()!;
        if (next.isInference) {
          this.inFlight += 1;
          this.lastActivityAt = performance.now();
        }
        try {
          const result = await next.fn();
          next.resolve(result);
        } catch (err) {
          next.reject(err);
        } finally {
          if (next.isInference) {
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.lastActivityAt = performance.now();
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function idsEqual(a: readonly number[], b: readonly number[], len?: number): boolean {
  const n = len ?? a.length;
  if (len === undefined && a.length !== b.length) return false;
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function spansEqual(a: readonly [number, number][], b: readonly [number, number][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  }
  return true;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return Number(sorted[idx]!.toFixed(2));
}

export interface WardenS1OnnxEngineOptions {
  readonly backend: WardenS1OnnxBackend;
  readonly modelId: string;
  readonly modelDir: string;
  readonly instanceId?: string;
  readonly idleShutdownSec?: number;
  readonly maxTokens?: number;
  readonly ramSlots?: number;
  readonly pageDir?: string;
  readonly boundaryGuard?: number;
}

export class WardenS1OnnxEngine {
  readonly backend: WardenS1OnnxBackend;
  readonly modelId: string;
  readonly modelDir: string;
  readonly instanceId: string;
  readonly idleShutdownSec: number;
  readonly maxTokens: number;
  readonly boundaryGuard: number;
  readonly pager: OnnxSessionPager;
  readonly queue = new PriorityTaskQueue();

  private activeSid: string | null = null;
  private activeRecord: SessionPageRecord | null = null;

  requestsServed = 0;
  prewarmsServed = 0;
  cacheExactHits = 0;
  cacheDeltaHits = 0;
  cacheBoundaryHealedHits = 0;
  cacheMisses = 0;
  l1Hits = 0;
  readonly recentTelemetry: Array<Record<string, unknown>> = [];

  constructor(options: WardenS1OnnxEngineOptions) {
    this.backend = options.backend;
    this.modelId = options.modelId;
    this.modelDir = options.modelDir;
    this.instanceId = options.instanceId ?? randomUUID();
    this.idleShutdownSec = Math.max(0, options.idleShutdownSec ?? 1800);
    this.maxTokens = options.maxTokens ?? 131072;
    this.boundaryGuard = Math.max(1, options.boundaryGuard ?? 2);
    this.pager = new OnnxSessionPager({
      ...(options.ramSlots !== undefined ? { ramSlots: options.ramSlots } : {}),
      ...(options.pageDir !== undefined ? { pageDir: options.pageDir } : {}),
    });
  }

  idleSeconds(): number {
    return this.queue.idleSeconds();
  }

  private resolveSessionId(explicitSid: string | undefined, payload: Record<string, unknown>, ids: readonly number[]): string {
    const raw = explicitSid ?? (typeof payload.session_id === "string" ? payload.session_id : undefined);
    if (raw && raw.trim().length > 0) return raw.trim();
    const head = ids.slice(0, 64).join(",");
    return `pfx-${createHash("sha256").update(head, "utf8").digest("hex").slice(0, 16)}`;
  }

  private truncateIds(ids: number[], offsets: Array<[number, number]>): { ids: number[]; offsets: Array<[number, number]> } {
    if (ids.length <= this.maxTokens) return { ids, offsets };
    const head = Math.min(4096, Math.floor(this.maxTokens / 8));
    const tail = this.maxTokens - head;
    return {
      ids: [...ids.slice(0, head), ...ids.slice(ids.length - tail)],
      offsets: [...offsets.slice(0, head), ...offsets.slice(offsets.length - tail)],
    };
  }

  private prepareState(
    payload: Record<string, unknown>,
    explicitSid?: string,
  ): { sid: string; ids: number[]; chunkMeta: ChunkDescriptor[]; chunkSpans: Array<[number, number]> } {
    const { text, chunks } = extractStateChunks(payload.state);
    const enc = this.backend.tokenizer.encodeWithOffsets(text);
    let { ids, offsets } = this.truncateIds(enc.ids, enc.offsets);
    if (ids.length === 0) {
      ids = [0];
      offsets = [[0, text.length]];
    }
    const explicitChunks = Array.isArray(payload.chunks) ? (payload.chunks as ChunkInput[]) : undefined;
    const mapped = mapCharChunksToTokenSpans(text, chunks, ids.length, offsets, explicitChunks);
    const sid = this.resolveSessionId(explicitSid, payload, ids);
    return { sid, ids, chunkMeta: mapped.meta, chunkSpans: mapped.spans };
  }

  private evictL1ToL2(): number {
    if (!this.activeSid || !this.activeRecord) return 0;
    const ms = this.pager.pageOut(this.activeSid, this.activeRecord);
    this.activeSid = null;
    this.activeRecord = null;
    return ms;
  }

  private activateSessionSlot(sid: string): { tier: "L1" | "L2_RAM" | "L3_DISK" | "NEW"; swapMs: number } {
    if (this.activeSid === sid && this.activeRecord !== null) {
      this.l1Hits += 1;
      return { tier: "L1", swapMs: 0 };
    }
    const outMs = this.evictL1ToL2();
    const res = this.pager.pageIn(sid, this.backend.ort);
    const swapMs = outMs + res.ms;
    if (res.record) {
      this.activeSid = sid;
      this.activeRecord = res.record;
      this.pager.swapLatenciesMs.push(swapMs);
      if (this.pager.swapLatenciesMs.length > 500) this.pager.swapLatenciesMs.splice(0, this.pager.swapLatenciesMs.length - 500);
    }
    return { tier: res.tier, swapMs };
  }

  private async encodeWithBoundaryCkpt(
    deltaIds: readonly number[],
    chunkSpans: Array<[number, number]>,
    chunkMeta: ChunkDescriptor[],
    initState: OnnxState | null,
    spanSums: Array<Float64Array | null>,
    spanCounts: number[],
    prevCkptRec: Record<string, OrtTensorLike> | null,
    prevCkptLen: number,
    prevCkptChunks: ChunkAccumulatorState | null,
  ): Promise<{
    state: OnnxState;
    ckptRec: Record<string, OrtTensorLike> | null;
    ckptLen: number;
    fullChunks: ChunkAccumulatorState;
    ckptChunks: ChunkAccumulatorState | null;
    chunkReprs: OrtTensorLike;
  }> {
    const startOffset = initState?.prefixLen ?? 0;
    const totalLen = startOffset + deltaIds.length;
    const guard = this.boundaryGuard;

    if (deltaIds.length > guard && totalLen > guard) {
      const body = deltaIds.slice(0, deltaIds.length - guard);
      const tail = deltaIds.slice(deltaIds.length - guard);
      const ckptLen = startOffset + body.length;
      const step1 = await this.backend.encodeSlice(body, initState, chunkSpans, spanSums, spanCounts);
      const ckptRec = this.backend.snapshotRecurrentState(step1.state);
      const ckptChunks = cloneChunkAccumulators({ spans: chunkSpans, sums: spanSums, counts: spanCounts, meta: chunkMeta });
      const step2 = await this.backend.encodeSlice(tail, step1.state, chunkSpans, spanSums, spanCounts);
      const fullChunks = cloneChunkAccumulators({ spans: chunkSpans, sums: spanSums, counts: spanCounts, meta: chunkMeta });
      return {
        state: step2.state,
        ckptRec,
        ckptLen,
        fullChunks,
        ckptChunks,
        chunkReprs: step2.chunkReprs,
      };
    }

    const step = await this.backend.encodeSlice(deltaIds, initState, chunkSpans, spanSums, spanCounts);
    const fullChunks = cloneChunkAccumulators({ spans: chunkSpans, sums: spanSums, counts: spanCounts, meta: chunkMeta });
    return {
      state: step.state,
      ckptRec: initState ? prevCkptRec : null,
      ckptLen: initState ? prevCkptLen : 0,
      fullChunks,
      ckptChunks: initState ? prevCkptChunks : null,
      chunkReprs: step.chunkReprs,
    };
  }

  private async encodeIncremental(
    sid: string,
    ids: number[],
    chunkSpans: Array<[number, number]>,
    chunkMeta: ChunkDescriptor[],
    forceRecheckpoint = false,
  ): Promise<{
    prefixReuse: number;
    deltaLen: number;
    cacheMode: "exact" | "delta" | "miss";
    boundaryHealed: boolean;
    pageTier: "L1" | "L2_RAM" | "L3_DISK" | "NEW";
    swapMs: number;
    prefillMs: number;
  }> {
    if (forceRecheckpoint) {
      if (this.activeSid === sid) {
        this.activeSid = null;
        this.activeRecord = null;
      }
      this.pager.dropSession(sid);
    }
    const { tier, swapMs } = this.activateSessionSlot(sid);
    const t0 = performance.now();
    const cur = this.activeRecord;
    const oldLen = cur?.ids.length ?? 0;

    if (cur && idsEqual(ids, cur.ids) && spansEqual(chunkSpans, cur.fullChunks.spans)) {
      this.activeRecord = {
        ...cur,
        fullChunks: { ...cur.fullChunks, meta: chunkMeta.map((m) => ({ ...m })) },
      };
      this.cacheExactHits += 1;
      return {
        prefixReuse: oldLen,
        deltaLen: 0,
        cacheMode: "exact",
        boundaryHealed: false,
        pageTier: tier,
        swapMs,
        prefillMs: performance.now() - t0,
      };
    }

    if (cur && oldLen > 0 && ids.length > oldLen && idsEqual(ids, cur.ids, oldLen)) {
      const reused = buildReusedAccumulators(chunkSpans, oldLen, cur.fullChunks);
      if (reused) {
        const deltaIds = ids.slice(oldLen);
        const enc = await this.encodeWithBoundaryCkpt(
          deltaIds,
          chunkSpans,
          chunkMeta,
          cur.state,
          reused.sums,
          reused.counts,
          cur.ckptRec,
          cur.ckptLen,
          cur.ckptChunks,
        );
        this.activeSid = sid;
        this.activeRecord = { ids: [...ids], ...enc };
        this.cacheDeltaHits += 1;
        return {
          prefixReuse: oldLen,
          deltaLen: deltaIds.length,
          cacheMode: "delta",
          boundaryHealed: false,
          pageTier: tier,
          swapMs,
          prefillMs: performance.now() - t0,
        };
      }
    }

    // 2-token BPE boundary healing: roll back to ckptLen = oldLen - 2 when trailing tokens merge (e.g. '\n' + '\n' -> '\n\n').
    if (cur && cur.ckptRec && cur.ckptLen > 0 && ids.length > cur.ckptLen && idsEqual(ids, cur.ids, cur.ckptLen)) {
      const reused = buildReusedAccumulators(chunkSpans, cur.ckptLen, cur.ckptChunks);
      if (reused) {
        const restored = this.backend.restoreFromBoundaryCheckpoint(cur.state, cur.ckptRec, cur.ckptLen);
        const deltaIds = ids.slice(cur.ckptLen);
        const enc = await this.encodeWithBoundaryCkpt(
          deltaIds,
          chunkSpans,
          chunkMeta,
          restored,
          reused.sums,
          reused.counts,
          cur.ckptRec,
          cur.ckptLen,
          cur.ckptChunks,
        );
        this.activeSid = sid;
        this.activeRecord = { ids: [...ids], ...enc };
        this.cacheDeltaHits += 1;
        this.cacheBoundaryHealedHits += 1;
        return {
          prefixReuse: cur.ckptLen,
          deltaLen: deltaIds.length,
          cacheMode: "delta",
          boundaryHealed: true,
          pageTier: tier,
          swapMs,
          prefillMs: performance.now() - t0,
        };
      }
    }

    const freshSums = new Array<Float64Array | null>(chunkSpans.length).fill(null);
    const freshCounts = new Array<number>(chunkSpans.length).fill(0);
    const enc = await this.encodeWithBoundaryCkpt(ids, chunkSpans, chunkMeta, null, freshSums, freshCounts, null, 0, null);
    this.activeSid = sid;
    this.activeRecord = { ids: [...ids], ...enc };
    this.cacheMisses += 1;
    return {
      prefixReuse: 0,
      deltaLen: ids.length,
      cacheMode: "miss",
      boundaryHealed: false,
      pageTier: tier,
      swapMs,
      prefillMs: performance.now() - t0,
    };
  }

  private async runSalienceHead(chunkReprs: OrtTensorLike, nChunks: number): Promise<number[]> {
    const dummyQ = new this.backend.ort.Tensor("float32", new Float32Array(this.backend.hiddenSize), [1, this.backend.hiddenSize]);
    const dummyOpt = new this.backend.ort.Tensor("float32", new Float32Array(2 * this.backend.hiddenSize), [
      1,
      2,
      this.backend.hiddenSize,
    ]);
    const dummyMask = new this.backend.ort.Tensor("float32", new Float32Array([1, 1]), [1, 2]);
    const out = await this.backend.headsSession.run({
      query_repr: dummyQ,
      chunk_reprs: chunkReprs,
      choice_query_repr: dummyQ,
      option_reprs: dummyOpt,
      option_mask: dummyMask,
    });
    const raw = out.salience_probs!.data as Float32Array;
    return Array.from(raw.subarray(0, nChunks), (v) => Number(Math.max(0, Math.min(1, v)).toFixed(6)));
  }

  evaluate(payload: Record<string, unknown>, explicitSid?: string): Promise<{ response: SystemOneResponse; telemetry: Record<string, unknown> }> {
    return this.queue.enqueue(0, true, async () => {
      if (payload.state === undefined || payload.state === null) throw new Error("state is required");
      const questions = payload.questions;
      if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
        throw new Error("questions must be a non-empty object");
      }
      const reqModel = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : this.modelId;
      const bandRaw = payload.abstain_band;
      const abstainLo = Array.isArray(bandRaw) && typeof bandRaw[0] === "number" ? bandRaw[0] : DEFAULT_ABSTAIN_BAND[0];
      const abstainHi = Array.isArray(bandRaw) && typeof bandRaw[1] === "number" ? bandRaw[1] : DEFAULT_ABSTAIN_BAND[1];

      const { sid, ids, chunkMeta, chunkSpans } = this.prepareState(payload, explicitSid);
      const qEntries = Object.entries(questions as Record<string, Record<string, unknown>>);
      const qKeys: string[] = [];
      const qNorms: NormalizedQuestion[] = [];
      const qRaw: Record<string, unknown>[] = [];
      const qIdsList: number[][] = [];
      const choiceIndices: number[] = [];
      const choiceOptKeys: string[][] = [];
      const choiceOptIds: number[][][] = [];
      let qTokTotal = 0;

      for (let qi = 0; qi < qEntries.length; qi++) {
        const [qid, qobj] = qEntries[qi]!;
        const norm = normalizeQuestion(qobj);
        const fmt = formatProbePrompt(norm.type, {
          instructions: norm.instructions,
          ...(norm.choiceCriteria !== undefined ? { criteria: norm.choiceCriteria } : {}),
          ...(norm.scoreCriteria !== undefined ? { criteria: norm.scoreCriteria } : {}),
        });
        const qIds = this.backend.tokenizer.encode(fmt.prompt);
        const safeQIds = qIds.length > 0 ? qIds : [0];
        qKeys.push(qid);
        qNorms.push(norm);
        qRaw.push(qobj);
        qIdsList.push(safeQIds);
        qTokTotal += safeQIds.length;
        if (norm.type === "choice") {
          choiceIndices.push(qi);
          choiceOptKeys.push(fmt.optionKeys ?? []);
          choiceOptIds.push(
            fmt.optionStrings.map((s) => {
              const oids = this.backend.tokenizer.encode(s);
              return oids.length > 0 ? oids : [0];
            }),
          );
        }
      }

      const tStart = performance.now();
      const inc = await this.encodeIncremental(sid, ids, chunkSpans, chunkMeta);
      const rec = this.activeRecord!;

      const tProbe0 = performance.now();
      const rawHeads = await this.backend.scoreProbes(rec.state, rec.chunkReprs, qIdsList, choiceIndices, choiceOptIds);
      const probeMs = performance.now() - tProbe0;
      const totalMs = performance.now() - tStart;
      this.requestsServed += 1;

      const nChunks = chunkMeta.length;
      const scoreBins = rawHeads.scoreProbs.dims[1] ?? this.backend.scoreBins;
      const scoreData = rawHeads.scoreProbs.data as Float32Array;
      const locusData = rawHeads.locusProbs.data as Float32Array;
      const choiceData = rawHeads.choiceProbs.data as Float32Array;
      const maxOpts = rawHeads.choiceProbs.dims[1] ?? 2;

      const answers: Record<string, unknown> = {};
      const abstentions: Record<string, boolean> = {};
      const locusByQ: Record<string, LocusSummary> = {};
      let cPos = 0;

      for (let qi = 0; qi < qKeys.length; qi++) {
        const qid = qKeys[qi]!;
        const norm = qNorms[qi]!;
        const rawQ = qRaw[qi]!;
        const lRow = Array.from(locusData.subarray(qi * nChunks, (qi + 1) * nChunks), (v) =>
          Number(Math.max(0, Math.min(1, v)).toFixed(6)),
        );
        let lTop = 0;
        for (let ci = 1; ci < lRow.length; ci++) {
          if (lRow[ci]! > lRow[lTop]!) lTop = ci;
        }
        locusByQ[qid] = { top_chunk: lTop, top_prob: lRow[lTop] ?? 0, chunk_probs: lRow };

        if (norm.type === "noul") {
          const p = Number(Math.max(0, Math.min(1, rawHeads.noulProbs[qi] ?? 0.5)).toFixed(6));
          answers[qid] = { type: "noul", noul: p };
          abstentions[qid] = p >= abstainLo && p <= abstainHi;
        } else if (norm.type === "choice") {
          const keys = choiceOptKeys[cPos] ?? [];
          const baseOff = cPos * maxOpts;
          const probsArr: number[] = [];
          let rsum = 0;
          for (let oi = 0; oi < keys.length; oi++) {
            const v = Math.max(0, Math.min(1, choiceData[baseOff + oi] ?? 0));
            probsArr.push(v);
            rsum += v;
          }
          const probs: Record<string, number> = {};
          let bestIdx = 0;
          for (let oi = 0; oi < keys.length; oi++) {
            const pv = rsum > 0 ? probsArr[oi]! / rsum : 1 / Math.max(1, keys.length);
            probs[keys[oi]!] = Number(pv.toFixed(6));
            if (pv > (probs[keys[bestIdx]!] ?? -1)) bestIdx = oi;
          }
          answers[qid] = {
            type: "choice",
            choice: keys[bestIdx] ?? "",
            confidence: probs[keys[bestIdx] ?? ""] ?? 0,
            probabilities: probs,
          };
          cPos += 1;
        } else if (norm.type === "score") {
          const legend = Array.isArray(rawQ.criteria) ? rawQ.criteria : [];
          const proj = projectScoreBins(scoreData.subarray(qi * scoreBins, (qi + 1) * scoreBins), legend.length);
          answers[qid] = {
            type: "score",
            score: proj.score,
            confidence: proj.confidence,
            probabilities: proj.probabilities,
            legend,
          };
        } else {
          answers[qid] = { type: "locus", ...locusByQ[qid]! };
        }
      }

      const salience = rawHeads.salienceProbs.slice(0, nChunks).map((v) => Number(Math.max(0, Math.min(1, v)).toFixed(6)));
      const chunksOut: ChunkDescriptor[] = chunkMeta.map((m, i) => ({ ...m, salience: salience[i] ?? 0 }));
      const primaryLocus = (qKeys[0] ? locusByQ[qKeys[0]] : undefined) ?? { top_chunk: 0, top_prob: 0, chunk_probs: [] };

      const telemetry: Record<string, unknown> = {
        ts: Date.now() / 1000,
        req_num: this.requestsServed,
        session_id: sid,
        state_tokens: ids.length,
        prefix_reuse_tokens: inc.prefixReuse,
        delta_tokens: inc.deltaLen,
        cache_mode: inc.cacheMode,
        boundary_healed: inc.boundaryHealed,
        page_tier: inc.pageTier,
        swap_ms: Number(inc.swapMs.toFixed(2)),
        num_questions: qKeys.length,
        q_tokens: qTokTotal,
        prefill_ms: Number(inc.prefillMs.toFixed(2)),
        probe_ms: Number(probeMs.toFixed(2)),
        total_ms: Number(totalMs.toFixed(2)),
      };
      this.recentTelemetry.push(telemetry);
      if (this.recentTelemetry.length > 500) this.recentTelemetry.splice(0, this.recentTelemetry.length - 500);

      const response: SystemOneResponse = {
        model: reqModel,
        usage: { input_tokens: ids.length + qTokTotal, output_tokens: qKeys.length },
        answers,
        s1: {
          session_id: sid,
          runtime: "onnx",
          cache_mode: inc.cacheMode,
          boundary_healed: inc.boundaryHealed,
          page_tier: inc.pageTier,
          prefix_reuse_tokens: inc.prefixReuse,
          delta_tokens: inc.deltaLen,
          state_tokens: ids.length,
          swap_ms: Number(inc.swapMs.toFixed(2)),
          prefill_ms: Number(inc.prefillMs.toFixed(2)),
          probe_ms: Number(probeMs.toFixed(2)),
          total_ms: Number(totalMs.toFixed(2)),
          chunks: chunksOut,
          salience,
          locus: { ...primaryLocus, by_question: locusByQ },
          abstentions,
        },
      };
      return { response, telemetry };
    });
  }

  prewarm(payload: Record<string, unknown>, explicitSid?: string): Promise<PrewarmResponse> {
    return this.queue.enqueue(1, true, async () => {
      if (payload.state === undefined || payload.state === null) throw new Error("state is required");
      const recheckpoint = Boolean(payload.recheckpoint);
      const { sid, ids, chunkMeta, chunkSpans } = this.prepareState(payload, explicitSid);
      const inc = await this.encodeIncremental(sid, ids, chunkSpans, chunkMeta, recheckpoint);
      const salience = await this.runSalienceHead(this.activeRecord!.chunkReprs, chunkMeta.length);
      this.prewarmsServed += 1;
      const chunksOut: ChunkDescriptor[] = chunkMeta.map((m, i) => ({ ...m, salience: salience[i] ?? 0 }));
      return {
        ok: true,
        session_id: sid,
        runtime: "onnx",
        state_tokens: ids.length,
        prefix_reuse_tokens: inc.prefixReuse,
        delta_tokens: inc.deltaLen,
        cache_mode: inc.cacheMode,
        boundary_healed: inc.boundaryHealed,
        page_tier: inc.pageTier,
        recheckpointed: recheckpoint,
        swap_ms: Number(inc.swapMs.toFixed(2)),
        prefill_ms: Number(inc.prefillMs.toFixed(2)),
        salience,
        chunks: chunksOut,
      };
    });
  }

  salience(payload: Record<string, unknown>, explicitSid?: string): Promise<SalienceResponse> {
    return this.queue.enqueue(0, true, async () => {
      let sid: string;
      let stateTokens: number;
      let cacheMode: "exact" | "delta" | "miss";
      let boundaryHealed: boolean;
      let pageTier: "L1" | "L2_RAM" | "L3_DISK" | "NEW";
      let swapMs: number;
      let chunkMeta: ChunkDescriptor[];

      if (payload.state !== undefined && payload.state !== null) {
        const prep = this.prepareState(payload, explicitSid);
        sid = prep.sid;
        stateTokens = prep.ids.length;
        chunkMeta = prep.chunkMeta;
        const inc = await this.encodeIncremental(sid, prep.ids, prep.chunkSpans, prep.chunkMeta);
        cacheMode = inc.cacheMode;
        boundaryHealed = inc.boundaryHealed;
        pageTier = inc.pageTier;
        swapMs = inc.swapMs;
      } else {
        const rawSid = explicitSid ?? (typeof payload.session_id === "string" ? payload.session_id : undefined);
        if (!rawSid || !rawSid.trim()) throw new Error("state or session_id is required");
        sid = rawSid.trim();
        const act = this.activateSessionSlot(sid);
        if (!this.activeRecord) throw new Error(`session not found in cache: ${sid}`);
        stateTokens = this.activeRecord.ids.length;
        chunkMeta = this.activeRecord.fullChunks.meta;
        cacheMode = "exact";
        boundaryHealed = false;
        pageTier = act.tier;
        swapMs = act.swapMs;
      }

      const salience = await this.runSalienceHead(this.activeRecord!.chunkReprs, chunkMeta.length);
      const chunksOut: ChunkDescriptor[] = chunkMeta.map((m, i) => ({ ...m, salience: salience[i] ?? 0 }));
      return {
        ok: true,
        session_id: sid,
        runtime: "onnx",
        state_tokens: stateTokens,
        cache_mode: cacheMode,
        boundary_healed: boundaryHealed,
        page_tier: pageTier,
        swap_ms: Number(swapMs.toFixed(2)),
        salience,
        chunks: chunksOut,
      };
    });
  }

  evictToDisk(sessionId?: string | null): Promise<{ evicted: unknown[]; ram_slots_used: number; disk_pages: number }> {
    return this.queue.enqueue(0, false, async () => {
      if (this.activeSid && (!sessionId || sessionId === this.activeSid)) {
        this.evictL1ToL2();
      }
      const evicted = this.pager.evictRamToDisk(sessionId);
      return { evicted, ram_slots_used: this.pager.ramPages.size, disk_pages: this.pager.diskPages.size };
    });
  }

  dropSession(sessionId: string): Promise<{ dropped: boolean; session_id: string }> {
    return this.queue.enqueue(0, false, async () => {
      let dropped = false;
      if (this.activeSid === sessionId) {
        this.activeSid = null;
        this.activeRecord = null;
        dropped = true;
      }
      if (this.pager.dropSession(sessionId)) dropped = true;
      return { dropped, session_id: sessionId };
    });
  }

  resetCache(): Promise<{ reset: true }> {
    return this.queue.enqueue(0, false, async () => {
      this.activeSid = null;
      this.activeRecord = null;
      this.pager.clearAll();
      return { reset: true };
    });
  }

  stats(): DaemonStats {
    const lats = this.recentTelemetry.map((r) => Number(r.total_ms ?? 0));
    const swaps = this.pager.swapLatenciesMs.slice(-200);
    const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    return {
      status: "ok",
      runtime: "onnx",
      pid: process.pid,
      instance_id: this.instanceId,
      model: this.modelId,
      model_dir: this.modelDir,
      idle_shutdown_sec: this.idleShutdownSec,
      idle_sec: Number(this.idleSeconds().toFixed(2)),
      in_flight: this.queue.inFlight,
      rss_mb: rssMb,
      active_session_id: this.activeSid,
      active_prefix_tokens: this.activeRecord?.ids.length ?? 0,
      l2_ram_sessions: this.pager.ramPages.size - (this.activeSid && this.pager.ramPages.has(this.activeSid) ? 1 : 0),
      l3_disk_sessions: this.pager.diskPages.size,
      zstd_enabled: true,
      requests_served: this.requestsServed,
      prewarms_served: this.prewarmsServed,
      cache_exact_hits: this.cacheExactHits,
      cache_delta_hits: this.cacheDeltaHits,
      cache_boundary_healed_hits: this.cacheBoundaryHealedHits,
      cache_misses: this.cacheMisses,
      l1_hits: this.l1Hits,
      l2_ram_swaps: this.pager.l2Swaps,
      l3_disk_swaps: this.pager.l3Swaps,
      swap_ms_p50: percentile(swaps, 50),
      swap_ms_p95: percentile(swaps, 95),
      latency_ms_p50: percentile(lats, 50),
      latency_ms_p95: percentile(lats, 95),
    };
  }
}

export interface OnnxWorkerServerOptions {
  readonly modelDir?: string;
  readonly mockWeights?: boolean;
  readonly backend?: WardenS1OnnxBackend;
  readonly ortPath?: string;
  readonly stateDir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly modelId?: string;
  readonly maxTokens?: number;
  readonly ramSlots?: number;
  readonly pageDir?: string;
  readonly idleShutdownSec?: number;
  readonly token?: string;
  readonly instanceId?: string;
  readonly stateFile?: string;
  readonly stepDelayMs?: number;
}

export interface OnnxWorkerServerHandle {
  readonly server: Server;
  readonly engine: WardenS1OnnxEngine;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly token: string;
  readonly instanceId: string;
  readonly close: () => Promise<void>;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ba, bb);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX_BODY = 64 * 1024 * 1024;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY) {
        rejectP(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolveP({});
        return;
      }
      try {
        resolveP(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        rejectP(err);
      }
    });
    req.on("error", rejectP);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", String(raw.byteLength));
  res.setHeader("x-typesafe-request-id", `ws1-${randomBytes(6).toString("hex")}`);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(raw);
}

function removeStateFileIfOwned(stateFile: string | undefined, instanceId: string): void {
  if (!stateFile || !existsSync(stateFile)) return;
  try {
    const cur = JSON.parse(readFileSync(stateFile, "utf8")) as { instanceId?: string };
    if (cur && cur.instanceId === instanceId) unlinkSync(stateFile);
  } catch {
    // Ignore already removed or unreadable metadata.
  }
}

export async function startOnnxWorkerServer(options: OnnxWorkerServerOptions): Promise<OnnxWorkerServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const instanceId = options.instanceId || randomUUID();
  const token = options.token ?? randomBytes(32).toString("hex");
  const idleShutdownSec = options.idleShutdownSec ?? 1800;
  const modelDir = options.modelDir ? resolve(options.modelDir) : options.mockWeights ? "mock-weights" : "";
  const modelId = options.modelId ?? (options.mockWeights ? "warden-s1-mock-onnx" : "warden-s1-752m-onnx-int4");
  const pageDir =
    options.pageDir ??
    (options.stateFile
      ? join(dirname(options.stateFile), "pages")
      : options.stateDir
        ? join(options.stateDir, "pages")
        : join(homedir(), ".cache", "pi-warden", "pages"));

  const backend =
    options.backend ??
    (options.mockWeights
      ? createSyntheticOnnxBackend(options.stepDelayMs !== undefined ? { stepDelayMs: options.stepDelayMs } : undefined)
      : await WardenS1OnnxBackend.loadFromLocalDir({
          modelDir,
          ...(options.ortPath !== undefined ? { ortPath: options.ortPath } : {}),
          ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
        }));

  const engine = new WardenS1OnnxEngine({
    backend,
    modelId,
    modelDir,
    instanceId,
    idleShutdownSec,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.ramSlots !== undefined ? { ramSlots: options.ramSlots } : {}),
    pageDir,
  });

  const expectedAuth = token ? `Bearer ${token}` : "";
  let closed = false;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      if (expectedAuth) {
        const auth = String(req.headers.authorization ?? "");
        if (!constantTimeEquals(auth, expectedAuth)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }
      const path = (req.url ?? "/").split("?", 1)[0] ?? "/";
      const method = req.method ?? "GET";
      const sidHeader = req.headers["x-warden-session-id"];
      const explicitSid = typeof sidHeader === "string" ? sidHeader : undefined;

      if (method === "GET") {
        if (path === "/health") {
          sendJson(res, 200, engine.stats());
          return;
        }
        if (path === "/stats") {
          sendJson(res, 200, { ...engine.stats(), recent: engine.recentTelemetry.slice(-100) });
          return;
        }
        if (path === "/v1/models") {
          sendJson(res, 200, {
            models: [
              {
                name: engine.modelId,
                id: engine.modelId,
                object: "model",
                runtime: "onnx",
                description: "Warden-S1 752M ONNX-Int4 singleton local System-One verifier with tiered session paging",
              },
            ],
          });
          return;
        }
        sendJson(res, 404, { error: `Not found: ${path}` });
        return;
      }

      if (method !== "POST") {
        sendJson(res, 405, { error: `Method not allowed: ${method}` });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      try {
        if (path === "/v1/systemone") {
          const { response, telemetry } = await engine.evaluate(body, explicitSid);
          sendJson(res, 200, response, {
            "X-Warden-S1-Latency-Ms": String(telemetry.total_ms),
            "X-Warden-S1-Swap-Ms": String(telemetry.swap_ms),
            "X-Warden-S1-Page-Tier": String(telemetry.page_tier),
            "X-Warden-S1-Cache-Mode": String(telemetry.cache_mode),
            "X-Warden-S1-Boundary-Healed": telemetry.boundary_healed ? "1" : "0",
            "X-Warden-S1-Delta-Tokens": String(telemetry.delta_tokens),
          });
          return;
        }
        if (path === "/v1/prewarm") {
          sendJson(res, 200, await engine.prewarm(body, explicitSid));
          return;
        }
        if (path === "/v1/salience") {
          sendJson(res, 200, await engine.salience(body, explicitSid));
          return;
        }
        if (path === "/admin/reset_cache") {
          sendJson(res, 200, await engine.resetCache());
          return;
        }
        if (path === "/admin/evict_to_disk") {
          const targetSid = typeof body.session_id === "string" ? body.session_id : null;
          sendJson(res, 200, await engine.evictToDisk(targetSid));
          return;
        }
        if (path === "/admin/drop_session") {
          const targetSid = (typeof body.session_id === "string" ? body.session_id : undefined) ?? explicitSid;
          if (!targetSid) {
            sendJson(res, 422, { error: "session_id is required" });
            return;
          }
          sendJson(res, 200, await engine.dropSession(targetSid));
          return;
        }
        if (path === "/admin/shutdown") {
          sendJson(res, 200, { shutting_down: true });
          setImmediate(() => {
            void close();
          });
          return;
        }
        sendJson(res, 404, { error: `Not found: ${path}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isClientErr = /required|non-empty|Unsupported|not found in cache/i.test(msg);
        sendJson(res, isClientErr ? 422 : 500, { error: msg });
      }
    })();
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (idleTimer !== null) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    removeStateFileIfOwned(options.stateFile, instanceId);
    await new Promise<void>((resolveP) => {
      server.close(() => resolveP());
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    });
  };

  await new Promise<void>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(port, host, () => {
      server.off("error", rejectP);
      resolveP();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const boundHost = typeof addr === "object" && addr ? addr.address : host;

  if (idleShutdownSec > 0) {
    const pollMs = Math.max(100, Math.min(1000, Math.floor((idleShutdownSec * 1000) / 4)));
    idleTimer = setInterval(() => {
      if (engine.idleSeconds() >= idleShutdownSec) {
        void close();
      }
    }, pollMs);
    idleTimer.unref();
  }

  if (options.stateFile) {
    const metadata = {
      pid: process.pid,
      instanceId,
      host: boundHost,
      port: boundPort,
      runtime: "onnx" as const,
      modelId,
      modelDir,
      startedAt: new Date().toISOString(),
      idleShutdownSec,
      token,
    };
    writeFileAtomicSync(options.stateFile, `${JSON.stringify(metadata, null, 2)}\n`);
  }

  return {
    server,
    engine,
    host: boundHost,
    port: boundPort,
    url: `http://${boundHost}:${boundPort}`,
    token,
    instanceId,
    close,
  };
}

function parseCliArgs(argv: readonly string[]): OnnxWorkerServerOptions {
  let modelDir: string | undefined;
  let mockWeights = false;
  let ortPath: string | undefined;
  let stateDir: string | undefined;
  let host = "127.0.0.1";
  let port = 0;
  let modelId: string | undefined;
  let maxTokens: number | undefined;
  let ramSlots: number | undefined;
  let pageDir: string | undefined;
  let idleShutdownSec = 1800;
  let token: string | undefined;
  let instanceId: string | undefined;
  let stateFile: string | undefined;
  let stepDelayMs: number | undefined;

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => argv[++i] ?? "";
    if (flag === "--model-dir") modelDir = next();
    else if (flag === "--mock-weights") mockWeights = true;
    else if (flag === "--ort-path") ortPath = next();
    else if (flag === "--state-dir") stateDir = next();
    else if (flag === "--host") host = next();
    else if (flag === "--port") port = Number(next());
    else if (flag === "--model-id") modelId = next();
    else if (flag === "--max-tokens") maxTokens = Number(next());
    else if (flag === "--ram-slots") ramSlots = Number(next());
    else if (flag === "--page-dir") pageDir = next();
    else if (flag === "--idle-shutdown-sec") idleShutdownSec = Number(next());
    else if (flag === "--token") token = next();
    else if (flag === "--instance-id") instanceId = next();
    else if (flag === "--state-file") stateFile = next();
    else if (flag === "--step-delay-ms") stepDelayMs = Number(next());
  }

  return {
    ...(modelDir !== undefined ? { modelDir } : {}),
    mockWeights,
    ...(ortPath !== undefined ? { ortPath } : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    host,
    port,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(ramSlots !== undefined ? { ramSlots } : {}),
    ...(pageDir !== undefined ? { pageDir } : {}),
    idleShutdownSec,
    ...(token !== undefined ? { token } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(stateFile !== undefined ? { stateFile } : {}),
    ...(stepDelayMs !== undefined ? { stepDelayMs } : {}),
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseCliArgs(process.argv);
  startOnnxWorkerServer(opts)
    .then((handle) => {
      const onSignal = (): void => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
      process.stdout.write(
        `${JSON.stringify({
          ready: true,
          pid: process.pid,
          instanceId: handle.instanceId,
          host: handle.host,
          port: handle.port,
          url: handle.url,
          runtime: "onnx",
          modelId: handle.engine.modelId,
          modelDir: handle.engine.modelDir,
          idleShutdownSec: handle.engine.idleShutdownSec,
        })}\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`warden-s1-onnx-worker failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
