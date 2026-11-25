import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic.js";

export const WARDEN_S1_MLX_SCRIPT_NAME = "warden_s1_mlx_daemon.py";

const MLX_PY_PART_1 = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gc
import hashlib
import hmac
import itertools
import json
import math
import mmap
import os
import pickle
import queue
import re
import signal
import sys
import tempfile
import threading
import time
import uuid
import zlib
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import mlx.core as mx
import mlx.nn as nn
import mlx_lm
import numpy as np
from mlx_lm.models.cache import ArraysCache, KVCache, QuantizedKVCache, make_prompt_cache

try:
    import zstandard as zstd
except ImportError:
    zstd = None


def _serialize_entry(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    return json.dumps(val, ensure_ascii=False, separators=(", ", ": "))


def serialize_state(state: Any) -> str:
    if isinstance(state, str):
        return state
    if isinstance(state, dict):
        keys = list(state.keys())
        if isinstance(state.get("trajectory"), str) and all(
            k in ("trajectory", "session_id", "repo", "domain") for k in keys
        ):
            return state["trajectory"]
        parts = []
        for k, v in state.items():
            body = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, separators=(", ", ": "))
            parts.append(f"## {k}\n{body}")
        return "\n\n".join(parts)
    return json.dumps(state, ensure_ascii=False, separators=(", ", ": "))


_TURN_RE = re.compile(r"<turn\b([^>]*)>[\s\S]*?</turn>")
_SECTION_RE = re.compile(r"^##\s+([^\n]+)\n[\s\S]*?(?=^##\s+|\Z)", re.MULTILINE)
_TITLE_ATTR_RE = re.compile(r'title="([^"]+)"')
_ROLE_ATTR_RE = re.compile(r'role="([^"]+)"')
_IDX_ATTR_RE = re.compile(r'index="([^"]+)"')


def extract_state_chunks(state_input: Any) -> tuple[str, list[dict[str, Any]]]:
    raw_text = serialize_state(state_input)
    chunks: list[dict[str, Any]] = []

    for m in _TURN_RE.finditer(raw_text):
        attrs = m.group(1) or ""
        idx_m = _IDX_ATTR_RE.search(attrs)
        role_m = _ROLE_ATTR_RE.search(attrs)
        title_m = _TITLE_ATTR_RE.search(attrs)
        label_parts = [
            f"Turn {idx_m.group(1)}" if idx_m else f"Turn {len(chunks)}",
            role_m.group(1) if role_m else None,
            title_m.group(1) if title_m else None,
        ]
        chunks.append({
            "index": len(chunks),
            "label": " | ".join(p for p in label_parts if p),
            "char_start": m.start(),
            "char_end": m.end(),
        })

    if not chunks:
        matches = list(_SECTION_RE.finditer(raw_text))
        if matches:
            first_start = matches[0].start()
            if first_start > 0 and raw_text[:first_start].strip():
                chunks.append({
                    "index": 0,
                    "label": "Block 0",
                    "char_start": 0,
                    "char_end": first_start,
                })
            for m in matches:
                chunks.append({
                    "index": len(chunks),
                    "label": m.group(1).strip(),
                    "char_start": m.start(),
                    "char_end": m.end(),
                })

    if not chunks:
        cursor = 0
        for block in re.split(r"\n{2,}", raw_text):
            pos = raw_text.find(block, cursor)
            if block.strip() and pos >= 0:
                chunks.append({
                    "index": len(chunks),
                    "label": f"Block {len(chunks)}",
                    "char_start": pos,
                    "char_end": pos + len(block),
                })
                cursor = pos + len(block)

    if not chunks:
        chunks.append({
            "index": 0,
            "label": "State",
            "char_start": 0,
            "char_end": len(raw_text),
        })

    return raw_text, chunks


def encode_with_offsets(tokenizer: Any, text: str) -> tuple[list[int], list[tuple[int, int]] | None]:
    inner = getattr(tokenizer, "_tokenizer", tokenizer)
    try:
        enc = inner(text, add_special_tokens=False, return_offsets_mapping=True)
        ids = list(enc["input_ids"])
        offs = enc.get("offset_mapping")
        if offs is not None and len(offs) == len(ids):
            return ids, [(int(a), int(b)) for a, b in offs]
    except Exception:
        pass
    try:
        fast = getattr(inner, "_tokenizer", None)
        if fast is not None:
            enc = fast.encode(text, add_special_tokens=False)
            if len(enc.ids) == len(enc.offsets):
                return list(enc.ids), [(int(a), int(b)) for a, b in enc.offsets]
    except Exception:
        pass
    ids = list(tokenizer.encode(text, add_special_tokens=False))
    return ids, None


def map_chunks_to_token_spans(
    raw_text: str,
    chunks: list[dict[str, Any]],
    seq_len: int,
    offsets: list[tuple[int, int]] | None,
    explicit_chunks: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[tuple[int, int]]]:
    if seq_len <= 0:
        return [{"index": 0, "label": "State", "token_start": 0, "token_end": 1}], [(0, 1)]

    if explicit_chunks:
        out_meta: list[dict[str, Any]] = []
        spans: list[tuple[int, int]] = []
        for idx, c in enumerate(explicit_chunks):
            label = str(c.get("label") or f"Chunk {idx}")
            if "token_start" in c and "token_end" in c:
                ts = max(0, min(int(c["token_start"]), seq_len - 1))
                te = max(ts + 1, min(int(c["token_end"]), seq_len))
            else:
                cs = int(c.get("char_start", 0))
                ce = int(c.get("char_end", len(raw_text)))
                ts, te = _char_span_to_tokens(cs, ce, len(raw_text), seq_len, offsets)
            out_meta.append({"index": idx, "label": label, "token_start": ts, "token_end": te})
            spans.append((ts, te))
        return out_meta, spans

    out_meta = []
    spans = []
    text_len = max(1, len(raw_text))
    for idx, c in enumerate(chunks):
        cs = int(c["char_start"])
        ce = int(c["char_end"])
        ts, te = _char_span_to_tokens(cs, ce, text_len, seq_len, offsets)
        out_meta.append({"index": idx, "label": str(c["label"]), "token_start": ts, "token_end": te})
        spans.append((ts, te))
    return out_meta, spans


def _char_span_to_tokens(
    cs: int,
    ce: int,
    text_len: int,
    seq_len: int,
    offsets: list[tuple[int, int]] | None,
) -> tuple[int, int]:
    if offsets is None or len(offsets) != seq_len:
        ts = int((cs * seq_len) / max(1, text_len))
        te = int(math.ceil((ce * seq_len) / max(1, text_len)))
        ts = max(0, min(ts, seq_len - 1))
        te = max(ts + 1, min(te, seq_len))
        return ts, te

    first = -1
    last = -1
    for i, (os_, oe_) in enumerate(offsets):
        if os_ >= cs and os_ < ce:
            if first < 0:
                first = i
            last = i + 1
        elif first < 0 and oe_ > cs and os_ < ce:
            first = i
            last = i + 1
        elif os_ >= ce and first >= 0:
            break
    if first < 0:
        first = max(0, min(int((cs * seq_len) / max(1, text_len)), seq_len - 1))
        last = min(seq_len, first + 1)
    return first, max(first + 1, min(last, seq_len))


def format_probe_prompt(head_type: str, question: dict[str, Any]) -> tuple[str, list[str]]:
    instr = str(question["instructions"]).strip()
    if head_type == "noul":
        return f"\n[S1:NOUL] {instr}\n[ANS]", []
    if head_type == "choice":
        criteria = question["criteria"]
        opt_keys = list(criteria.keys())
        opt_strs = [f"{k}: {criteria[k]}" for k in opt_keys]
        opts_block = " | ".join(opt_strs)
        return f"\n[S1:CHOICE] {instr}\nOptions: {opts_block}\n[ANS]", opt_strs
    if head_type == "score":
        criteria = question["criteria"]
        scale_block = " | ".join(f"{i}={c}" for i, c in enumerate(criteria))
        return f"\n[S1:SCORE] {instr}\nScale({len(criteria)}): {scale_block}\n[ANS]", []
    if head_type == "locus":
        return f"\n[S1:LOCUS] {instr}\n[ANS]", []
    return f"\n[S1:SALIENCE] {instr}\n[ANS]", []


def normalize_question(q: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    qtype = str(q["type"]).lower()
    instr = _serialize_entry(q.get("instructions")).strip()
    if qtype == "noul":
        crit = q.get("criteria")
        if isinstance(crit, dict):
            extras = []
            if crit.get("true") is not None:
                extras.append(f"Yes: {_serialize_entry(crit['true'])}")
            if crit.get("false") is not None:
                extras.append(f"No: {_serialize_entry(crit['false'])}")
            if extras:
                suffix = " | ".join(extras)
                instr = f"{instr} ({suffix})" if instr else suffix
        return "noul", {"instructions": instr or "Does the condition hold?"}
    if qtype == "choice":
        raw_crit = q.get("criteria") or {}
        norm_crit = {
            str(k): (_serialize_entry(v) if v is not None else str(k))
            for k, v in raw_crit.items()
        }
        return "choice", {"instructions": instr or "Select the best option.", "criteria": norm_crit}
    if qtype == "score":
        raw_crit = q.get("criteria") or []
        norm_crit = [_serialize_entry(c) for c in raw_crit]
        return "score", {"instructions": instr or "Rate on the rubric scale.", "criteria": norm_crit}
    if qtype == "locus":
        return "locus", {"instructions": instr or "Locate the chunk most responsible for the verdict."}
    raise ValueError(f"Unsupported question type: {qtype}")


def project_score_bins(bin_probs: np.ndarray, num_levels: int) -> tuple[dict[str, float], float, float]:
    n_bins = int(bin_probs.shape[0])
    num_levels = max(2, int(num_levels))
    bin_centers = np.linspace(0.0, 1.0, n_bins, dtype=np.float64)
    p_bins = np.clip(bin_probs.astype(np.float64), 0.0, 1.0)
    s = float(p_bins.sum())
    p_bins = p_bins / s if s > 0.0 else np.full((n_bins,), 1.0 / n_bins, dtype=np.float64)

    expected_01 = float(np.clip(np.sum(p_bins * bin_centers), 0.0, 1.0))
    level_probs = np.zeros((num_levels,), dtype=np.float64)
    for b_idx, center in enumerate(bin_centers):
        pos = center * (num_levels - 1)
        lo = int(math.floor(pos))
        hi = min(num_levels - 1, lo + 1)
        frac = pos - lo
        level_probs[lo] += p_bins[b_idx] * (1.0 - frac)
        level_probs[hi] += p_bins[b_idx] * frac
    lsum = float(level_probs.sum())
    level_probs = level_probs / lsum if lsum > 0 else np.full((num_levels,), 1.0 / num_levels, dtype=np.float64)

    probs_dict = {str(i): round(float(level_probs[i]), 6) for i in range(num_levels)}
    score_val = float(np.clip(expected_01 * (num_levels - 1), 0.0, float(num_levels - 1)))
    conf = float(np.clip(np.max(level_probs), 0.0, 1.0))
    return probs_dict, round(score_val, 6), round(conf, 6)


def _ln(x: mx.array, w: mx.array, b: mx.array, eps: float = 1e-5) -> mx.array:
    xf = x.astype(mx.float32)
    mean = mx.mean(xf, axis=-1, keepdims=True)
    var = mx.mean((xf - mean) ** 2, axis=-1, keepdims=True)
    normed = (xf - mean) * mx.rsqrt(var + eps)
    return normed * w.astype(mx.float32) + b.astype(mx.float32)


def _linear(x: mx.array, w: mx.array, b: mx.array | None = None) -> mx.array:
    out = x.astype(mx.float32) @ w.astype(mx.float32).T
    if b is not None:
        out = out + b.astype(mx.float32)
    return out


class WardenS1MLXHeads:
    def __init__(self, weights_path: Path):
        self.w = {k: v.astype(mx.float32) for k, v in mx.load(str(weights_path)).items()}
        self.proj_dim = int(self.w["choice.q_proj.weight"].shape[0])
        self.score_bins = int(self.w["score.proj.3.weight"].shape[0])
        self.bin_grid = mx.linspace(0.0, 1.0, self.score_bins).astype(mx.float32)
        self.sal_d = int(self.w["salience.in_proj.weight"].shape[0])
        self.sal_heads = 4
        self.sal_hdim = self.sal_d // self.sal_heads
        self.sal_pos_dim = 32

    def _temp(self, prefix: str) -> mx.array:
        return mx.clip(mx.exp(self.w[f"{prefix}.log_temperature"]), 0.05, 20.0)

    def noul(self, query_repr: mx.array) -> tuple[mx.array, mx.array]:
        h = _ln(query_repr, self.w["noul.norm.weight"], self.w["noul.norm.bias"])
        h = nn.silu(_linear(h, self.w["noul.proj.0.weight"], self.w["noul.proj.0.bias"]))
        raw = _linear(h, self.w["noul.proj.3.weight"], self.w["noul.proj.3.bias"]).squeeze(-1)
        logits = raw / self._temp("noul")
        return logits, mx.sigmoid(logits)

    def choice(self, query_repr: mx.array, opt_reprs: mx.array, opt_mask: mx.array) -> tuple[mx.array, mx.array]:
        q = _linear(_ln(query_repr, self.w["choice.q_norm.weight"], self.w["choice.q_norm.bias"]), self.w["choice.q_proj.weight"])
        o = _linear(_ln(opt_reprs, self.w["choice.o_norm.weight"], self.w["choice.o_norm.bias"]), self.w["choice.o_proj.weight"])
        raw = mx.einsum("kd,kmd->km", q, o) * (self.proj_dim ** -0.5)
        logits = raw / self._temp("choice")
        logits = mx.where(opt_mask, logits, mx.array(-1e9, dtype=mx.float32))
        return logits, mx.softmax(logits, axis=-1)

    def score(self, query_repr: mx.array) -> tuple[mx.array, mx.array, mx.array]:
        h = _ln(query_repr, self.w["score.norm.weight"], self.w["score.norm.bias"])
        h = nn.silu(_linear(h, self.w["score.proj.0.weight"], self.w["score.proj.0.bias"]))
        raw = _linear(h, self.w["score.proj.3.weight"], self.w["score.proj.3.bias"])
        logits = raw / self._temp("score")
        probs = mx.softmax(logits, axis=-1)
        expected = mx.sum(probs * self.bin_grid, axis=-1)
        return logits, probs, expected

    def locus(self, query_repr: mx.array, chunk_reprs: mx.array) -> tuple[mx.array, mx.array]:
        q = _linear(_ln(query_repr, self.w["locus.q_norm.weight"], self.w["locus.q_norm.bias"]), self.w["locus.q_proj.weight"])
        c = _linear(_ln(chunk_reprs, self.w["locus.c_norm.weight"], self.w["locus.c_norm.bias"]), self.w["locus.c_proj.weight"])
        logits = (q @ c.T) * (self.proj_dim ** -0.5) / self._temp("locus")
        return logits, mx.softmax(logits, axis=-1)

    def salience(self, chunk_reprs: mx.array) -> tuple[mx.array, mx.array]:
        n_c = int(chunk_reprs.shape[0])
        x = _linear(
            _ln(chunk_reprs, self.w["salience.in_norm.weight"], self.w["salience.in_norm.bias"]),
            self.w["salience.in_proj.weight"],
            self.w["salience.in_proj.bias"],
        )
        a = _ln(x, self.w["salience.attn_norm.weight"], self.w["salience.attn_norm.bias"])
        q = _linear(a, self.w["salience.q_proj.weight"]).reshape(n_c, self.sal_heads, self.sal_hdim).transpose(1, 0, 2)
        k = _linear(a, self.w["salience.k_proj.weight"]).reshape(n_c, self.sal_heads, self.sal_hdim).transpose(1, 0, 2)
        v = _linear(a, self.w["salience.v_proj.weight"]).reshape(n_c, self.sal_heads, self.sal_hdim).transpose(1, 0, 2)
        scores = (q @ k.transpose(0, 2, 1)) * (self.sal_hdim ** -0.5)
        ctx = (mx.softmax(scores, axis=-1) @ v).transpose(1, 0, 2).reshape(n_c, self.sal_d)
        x = x + _linear(ctx, self.w["salience.o_proj.weight"])
        h = _ln(x, self.w["salience.out_norm.weight"], self.w["salience.out_norm.bias"])

        h_first = mx.broadcast_to(h[0:1], (n_c, self.sal_d))
        h_last = mx.broadcast_to(h[-1:], (n_c, self.sal_d))
        h_mean = mx.broadcast_to(mx.mean(h, axis=0, keepdims=True), (n_c, self.sal_d))

        pos = mx.linspace(0.0, 1.0, max(1, n_c)).astype(mx.float32)
        half = self.sal_pos_dim // 2
        freqs = mx.exp(mx.arange(half, dtype=mx.float32) * (-math.log(1000.0) / max(1, half - 1)))
        angles = pos[:, None] * freqs[None, :] * math.pi
        pos_feats = mx.concatenate([mx.sin(angles), mx.cos(angles)], axis=-1)

        feats = mx.concatenate([h, h_first, h_last, h_mean, pos_feats], axis=-1)
        f1 = nn.silu(_linear(feats, self.w["salience.proj.0.weight"], self.w["salience.proj.0.bias"]))
        raw = _linear(f1, self.w["salience.proj.2.weight"], self.w["salience.proj.2.bias"]).squeeze(-1)
        logits = raw / self._temp("salience")
        return logits, mx.sigmoid(logits)
`;

const MLX_PY_PART_2 = String.raw`

def quantize_cache_list(cache_list: list[Any], bits: int) -> list[Any]:
    out = []
    for c in cache_list:
        if isinstance(c, KVCache):
            out.append(c.to_quantized(group_size=64, bits=bits))
        elif isinstance(c, ArraysCache):
            nc = ArraysCache(size=len(c.cache))
            nc.cache = [mx.array(x) if x is not None else None for x in c.cache]
            if hasattr(c, "left_padding"):
                nc.left_padding = c.left_padding
            out.append(nc)
        else:
            out.append(c)
    mx.eval([x.state for x in out])
    return out


def requantize_kv_cache_list(cache_list: list[Any], target_bits: int) -> list[Any]:
    out = []
    for c in cache_list:
        if isinstance(c, QuantizedKVCache) and int(c.bits) != int(target_bits):
            nc = QuantizedKVCache(group_size=c.group_size, bits=target_bits)
            nc.offset = int(c.offset)
            if c.keys is not None and c.values is not None and c.offset > 0:
                k_f = mx.dequantize(*c.keys, group_size=c.group_size, bits=c.bits)[:, :, : c.offset, :]
                v_f = mx.dequantize(*c.values, group_size=c.group_size, bits=c.bits)[:, :, : c.offset, :]
                nc.keys = mx.quantize(k_f, group_size=nc.group_size, bits=target_bits)
                nc.values = mx.quantize(v_f, group_size=nc.group_size, bits=target_bits)
                del k_f, v_f
            out.append(nc)
        else:
            out.append(c)
    mx.eval([x.state for x in out])
    mx.clear_cache()
    return out


def clone_arrays_snapshots(cache_list: list[Any]) -> list[Any]:
    snaps = []
    for c in cache_list:
        if isinstance(c, ArraysCache):
            snaps.append([mx.array(x) if x is not None else None for x in c.cache])
        else:
            snaps.append(None)
    mx.eval([s for s in snaps if s is not None])
    return snaps


def restore_cache_from_prefix(cache_list: list[Any], array_snaps: list[Any], prefix_len: int) -> None:
    for c, snap in zip(cache_list, array_snaps):
        if isinstance(c, ArraysCache) and snap is not None:
            c.cache = [mx.array(x) if x is not None else None for x in snap]
        elif isinstance(c, (KVCache, QuantizedKVCache)):
            if c.offset > prefix_len:
                c.trim(c.offset - prefix_len)


class WardenS1MLX:
    def __init__(self, mlx_dir: Path):
        self.mlx_dir = mlx_dir
        self.model, self.tok = mlx_lm.load(str(mlx_dir))
        mx.eval(self.model.parameters())
        self.heads = WardenS1MLXHeads(mlx_dir / "s1_heads.safetensors")
        mx.eval(list(self.heads.w.values()))
        self.hidden_size = int(self.heads.w["noul.norm.weight"].shape[0])

    def encode_prefix(
        self,
        ids: list[int],
        chunk_spans: list[tuple[int, int]] | None,
        kv_bits: int | None = 8,
        prefill_step: int = 2048,
        init_cache: list[Any] | None = None,
        start_offset: int = 0,
        span_sums: list[np.ndarray | None] | None = None,
        span_counts: list[int] | None = None,
    ) -> dict[str, Any]:
        cache = init_cache if init_cache is not None else make_prompt_cache(self.model)
        if chunk_spans is not None:
            if span_sums is None:
                span_sums = [None] * len(chunk_spans)
            if span_counts is None:
                span_counts = [0] * len(chunk_spans)

        seq_len = len(ids)
        arr = mx.array([ids], dtype=mx.int32)
        for s in range(0, seq_len, prefill_step):
            e = min(s + prefill_step, seq_len)
            h = self.model.model(arr[:, s:e], cache=cache)
            mx.eval(h, [c.state for c in cache])
            if chunk_spans is not None and span_sums is not None and span_counts is not None:
                h0 = h[0].astype(mx.float32)
                abs_s = start_offset + s
                abs_e = start_offset + e
                for ci, (cs, ce) in enumerate(chunk_spans):
                    ov_s = max(cs, abs_s)
                    ov_e = min(ce, abs_e)
                    if ov_e > ov_s:
                        part = mx.sum(h0[ov_s - abs_s : ov_e - abs_s], axis=0)
                        mx.eval(part)
                        part_np = np.array(part, dtype=np.float64)
                        span_sums[ci] = part_np if span_sums[ci] is None else (span_sums[ci] + part_np)
                        span_counts[ci] += ov_e - ov_s
            del h

        if kv_bits is not None:
            q_cache = quantize_cache_list(cache, bits=kv_bits)
            del cache
            cache = q_cache
            gc.collect()
            mx.clear_cache()

        chunk_reprs = None
        if chunk_spans is not None and span_sums is not None and span_counts is not None:
            n_chunks = max(1, len(chunk_spans))
            pooled = np.zeros((n_chunks, self.hidden_size), dtype=np.float32)
            for ci in range(len(chunk_spans)):
                if span_sums[ci] is not None and span_counts[ci] > 0:
                    pooled[ci] = (span_sums[ci] / float(span_counts[ci])).astype(np.float32)
            chunk_reprs = mx.array(pooled)
            mx.eval(chunk_reprs)

        return {
            "cache": cache,
            "prefix_len": start_offset + seq_len,
            "chunk_reprs": chunk_reprs,
            "span_sums": span_sums,
            "span_counts": span_counts,
        }


def _align64(n: int) -> int:
    return (n + 63) & ~63


def _mx_to_np_view(a: mx.array) -> tuple[str, tuple[int, ...], np.ndarray]:
    dt = str(a.dtype).split(".")[-1]
    if a.dtype == mx.bfloat16:
        return (dt, tuple(a.shape), np.asarray(a.view(mx.uint16)))
    return (dt, tuple(a.shape), np.asarray(a))


def _np_dtype_for_mx(dt: str) -> np.dtype:
    if dt == "bfloat16":
        return np.dtype(np.uint16)
    return np.dtype(dt)


def _copy_pair(pair: tuple[np.ndarray, np.ndarray]) -> None:
    np.copyto(pair[0], pair[1])


def _arr_slab_view(slab: np.ndarray, dt: str, shape: tuple[int, ...], offset: int, nbytes: int) -> np.ndarray:
    return slab[offset : offset + nbytes].view(_np_dtype_for_mx(dt)).reshape(shape)


def _clone_chunk_state(
    spans: list[tuple[int, int]],
    sums: list[np.ndarray | None],
    counts: list[int],
    meta: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "spans": list(spans),
        "sums": [None if s is None else np.array(s, dtype=np.float64, copy=True) for s in sums],
        "counts": list(counts),
        "meta": [dict(m) for m in meta],
    }


class TieredSessionPager:
    """In-RAM contiguous host-slab L2 pager and L3 zstd/zlib disk store."""

    def __init__(self, ram_slots: int = 12, page_dir: Path | None = None):
        self.ram_slots = max(1, ram_slots)
        self.page_dir = page_dir or (Path.home() / ".cache" / "pi-warden" / "pages")
        self.page_dir.mkdir(parents=True, exist_ok=True)
        self.ram_pages: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.disk_pages: dict[str, Path] = {}
        self._zstd_c = zstd.ZstdCompressor(level=1) if zstd is not None else None
        self._zstd_d = zstd.ZstdDecompressor() if zstd is not None else None
        self._pool = ThreadPoolExecutor(max_workers=8)
        # Bound MLX idle Metal cache pool to 1 GiB so macOS VM does not compress L2 host slabs.
        mx.set_cache_limit(1024 * 1024 * 1024)
        self.l2_swaps = 0
        self.l3_swaps = 0
        self.swap_latencies_ms: list[float] = []
        self.purge_disk_pages()

    @property
    def zstd_enabled(self) -> bool:
        return self._zstd_c is not None

    def purge_disk_pages(self) -> None:
        if not self.page_dir.exists():
            return
        for pattern in ("*.ws1page", "*.tmp"):
            for p in self.page_dir.glob(pattern):
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass

    def close(self) -> None:
        self.clear_all()
        self._pool.shutdown(wait=False)

    def _safe_name(self, sid: str) -> str:
        return hashlib.sha256(sid.encode("utf-8")).hexdigest()[:24]

    def drop_session(self, sid: str) -> bool:
        dropped = False
        if sid in self.ram_pages:
            self.ram_pages.pop(sid, None)
            dropped = True
        p = self.disk_pages.pop(sid, None)
        if p is not None:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
            dropped = True
        return dropped

    def clear_all(self) -> None:
        self.ram_pages.clear()
        for p in self.disk_pages.values():
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
        self.disk_pages.clear()
        self.purge_disk_pages()
        gc.collect()

    def _plan_arr_packing(
        self,
        cache_list: list[Any],
        ckpt_snaps: list[Any] | None,
    ) -> tuple[list[Any], list[Any] | None, list[tuple[int, int, str, tuple[int, ...], np.ndarray]], int]:
        arr_meta: list[Any] = []
        ckpt_meta: list[Any] | None = [] if ckpt_snaps is not None else None
        src_entries: list[tuple[int, int, str, tuple[int, ...], np.ndarray]] = []
        cursor = 0

        for li, c in enumerate(cache_list):
            if isinstance(c, ArraysCache):
                slot_meta = []
                for a in c.cache:
                    if a is None:
                        slot_meta.append(None)
                        continue
                    dt, shape, view = _mx_to_np_view(a)
                    off = _align64(cursor)
                    nb = int(view.nbytes)
                    cursor = off + nb
                    slot_meta.append((dt, shape, off, nb))
                    src_entries.append((off, nb, dt, shape, view))
                arr_meta.append((len(c.cache), slot_meta, getattr(c, "left_padding", None)))
            else:
                arr_meta.append(None)

            if ckpt_meta is not None and ckpt_snaps is not None:
                snap = ckpt_snaps[li]
                if snap is not None:
                    cslot_meta = []
                    for a in snap:
                        if a is None:
                            cslot_meta.append(None)
                            continue
                        dt, shape, view = _mx_to_np_view(a)
                        off = _align64(cursor)
                        nb = int(view.nbytes)
                        cursor = off + nb
                        cslot_meta.append((dt, shape, off, nb))
                        src_entries.append((off, nb, dt, shape, view))
                    ckpt_meta.append(cslot_meta)
                else:
                    ckpt_meta.append(None)

        return arr_meta, ckpt_meta, src_entries, _align64(cursor)

    def _restore_from_entry(self, entry: dict[str, Any]) -> tuple[list[Any], list[Any] | None]:
        kv_layer_indices: list[int] = entry["kv_layer_indices"]
        kv_meta: dict[int, dict[str, Any]] = entry["kv_meta"]
        kv_q_slab: np.ndarray | None = entry.get("kv_q_slab")
        kv_sb_slab: np.ndarray | None = entry.get("kv_sb_slab")
        cur_off = int(entry.get("cur_off", 0))
        arr_slab: np.ndarray = entry["arr_slab"]
        arr_meta: list[Any] = entry["arr_meta"]
        ckpt_meta: list[Any] | None = entry.get("ckpt_meta")

        flat_np: list[np.ndarray] = []
        kv_refs: list[tuple[int, str, int, str]] = []
        if kv_q_slab is not None and kv_sb_slab is not None:
            for ki, li in enumerate(kv_layer_indices):
                meta = kv_meta[li]
                k_dts = meta["k_dts"]
                v_dts = meta["v_dts"]
                if k_dts and v_dts:
                    flat_np.append(kv_q_slab[ki, 0])
                    kv_refs.append((li, "k", 0, k_dts[0]))
                    flat_np.append(kv_q_slab[ki, 1])
                    kv_refs.append((li, "v", 0, v_dts[0]))
                    flat_np.append(kv_sb_slab[ki, 0])
                    kv_refs.append((li, "k", 1, k_dts[1]))
                    flat_np.append(kv_sb_slab[ki, 1])
                    kv_refs.append((li, "k", 2, k_dts[2]))
                    flat_np.append(kv_sb_slab[ki, 2])
                    kv_refs.append((li, "v", 1, v_dts[1]))
                    flat_np.append(kv_sb_slab[ki, 3])
                    kv_refs.append((li, "v", 2, v_dts[2]))

        arr_start = len(flat_np)
        arr_refs: list[tuple[int, int, str, tuple[int, ...]]] = []
        for li, slot in enumerate(arr_meta):
            if slot is not None:
                for ai, it in enumerate(slot[1]):
                    if it is not None:
                        dt, shape, off, nb = it
                        flat_np.append(_arr_slab_view(arr_slab, dt, shape, off, nb))
                        arr_refs.append((li, ai, dt, shape))

        ckpt_start = len(flat_np)
        ckpt_refs: list[tuple[int, int, str, tuple[int, ...]]] = []
        if ckpt_meta is not None:
            for li, cslot in enumerate(ckpt_meta):
                if cslot is not None:
                    for ai, it in enumerate(cslot):
                        if it is not None:
                            dt, shape, off, nb = it
                            flat_np.append(_arr_slab_view(arr_slab, dt, shape, off, nb))
                            ckpt_refs.append((li, ai, dt, shape))

        flat_mx = list(self._pool.map(mx.array, flat_np)) if flat_np else []

        kv_built: dict[int, tuple[list[Any], list[Any]]] = {
            li: ([None, None, None], [None, None, None]) for li in kv_layer_indices
        }
        eval_list: list[mx.array] = []
        for idx, (li, kind, ti, dt) in enumerate(kv_refs):
            t = flat_mx[idx]
            if dt == "bfloat16":
                t = t.view(mx.bfloat16)
            if kind == "k":
                kv_built[li][0][ti] = t
            else:
                kv_built[li][1][ti] = t
            eval_list.append(t)

        arr_caches: dict[int, ArraysCache] = {}
        for li, slot in enumerate(arr_meta):
            if slot is not None:
                nc = ArraysCache(size=slot[0])
                nc.cache = [None] * slot[0]
                if slot[2] is not None:
                    nc.left_padding = slot[2]
                arr_caches[li] = nc
        for idx, (li, ai, dt, shape) in enumerate(arr_refs):
            t = flat_mx[arr_start + idx]
            t = (t.view(mx.bfloat16) if dt == "bfloat16" else t).reshape(shape)
            arr_caches[li].cache[ai] = t
            eval_list.append(t)

        ckpt_snaps: list[Any] | None = None
        if ckpt_meta is not None:
            ckpt_snaps = [([None] * len(cslot) if cslot is not None else None) for cslot in ckpt_meta]
            for idx, (li, ai, dt, shape) in enumerate(ckpt_refs):
                t = flat_mx[ckpt_start + idx]
                t = (t.view(mx.bfloat16) if dt == "bfloat16" else t).reshape(shape)
                ckpt_snaps[li][ai] = t
                eval_list.append(t)

        if eval_list:
            mx.eval(eval_list)

        cache_list: list[Any] = []
        for li in range(int(entry["num_layers"])):
            if li in arr_caches:
                cache_list.append(arr_caches[li])
            else:
                meta = kv_meta[li]
                nc = QuantizedKVCache(group_size=meta["group_size"], bits=meta["bits"])
                nc.offset = cur_off
                if li in kv_built and kv_built[li][0][0] is not None:
                    nc.keys = tuple(kv_built[li][0])
                    nc.values = tuple(kv_built[li][1])
                cache_list.append(nc)

        return cache_list, ckpt_snaps

    def write_disk_page(self, sid: str, entry: dict[str, Any]) -> tuple[Path, int, int]:
        cur_off = int(entry.get("cur_off", 0))
        kv_q_slab = entry.get("kv_q_slab")
        kv_sb_slab = entry.get("kv_sb_slab")
        arr_slab = entry["arr_slab"]

        kv_q_disk = (
            np.ascontiguousarray(kv_q_slab[:, :, :, :, :cur_off, :])
            if kv_q_slab is not None
            else None
        )
        kv_sb_disk = (
            np.ascontiguousarray(kv_sb_slab[:, :, :, :, :cur_off, :])
            if kv_sb_slab is not None
            else None
        )
        raw_bytes = (
            (kv_q_disk.nbytes if kv_q_disk is not None else 0)
            + (kv_sb_disk.nbytes if kv_sb_disk is not None else 0)
            + arr_slab.nbytes
        )
        disk_payload = {
            "ids": list(entry["ids"]),
            "ckpt_len": int(entry["ckpt_len"]),
            "kv_bits": int(entry["kv_bits"]),
            "num_layers": int(entry["num_layers"]),
            "cur_off": cur_off,
            "kv_layer_indices": list(entry["kv_layer_indices"]),
            "kv_meta": entry["kv_meta"],
            "kv_q_disk": kv_q_disk,
            "kv_sb_disk": kv_sb_disk,
            "arr_meta": entry["arr_meta"],
            "ckpt_meta": entry.get("ckpt_meta"),
            "arr_slab": arr_slab,
            "full_chunks": entry.get("full_chunks"),
            "ckpt_chunks": entry.get("ckpt_chunks"),
            "nbytes": raw_bytes,
        }
        raw = pickle.dumps(disk_payload, protocol=pickle.HIGHEST_PROTOCOL)
        comp = self._zstd_c.compress(raw) if self._zstd_c is not None else zlib.compress(raw, level=1)
        p = self.page_dir / f"{self._safe_name(sid)}.ws1page"
        tmp = self.page_dir / f".{self._safe_name(sid)}.{os.getpid()}.tmp"
        tmp.write_bytes(comp)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
        self.disk_pages[sid] = p
        return p, len(comp), raw_bytes

    def read_disk_page(self, sid: str) -> dict[str, Any]:
        p = self.disk_pages[sid]
        with open(p, "rb") as f:
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                raw = self._zstd_d.decompress(mm) if self._zstd_d is not None else zlib.decompress(mm)
        return pickle.loads(raw)

    def page_out(
        self,
        sid: str,
        cache_list: list[Any],
        ids: list[int],
        kv_bits: int,
        ckpt_snaps: list[Any] | None = None,
        ckpt_len: int = 0,
        full_chunks: dict[str, Any] | None = None,
        ckpt_chunks: dict[str, Any] | None = None,
    ) -> float:
        t0 = time.perf_counter()
        prev = self.ram_pages.get(sid)

        kv_layer_indices: list[int] = []
        kv_caches: list[QuantizedKVCache] = []
        for li, c in enumerate(cache_list):
            if isinstance(c, QuantizedKVCache):
                kv_layer_indices.append(li)
                kv_caches.append(c)

        cur_kv_off = int(kv_caches[0].offset) if kv_caches else 0
        has_kv = bool(kv_caches and kv_caches[0].keys is not None and kv_caches[0].values is not None and cur_kv_off > 0)

        arr_meta, ckpt_meta, arr_srcs, arr_total_bytes = self._plan_arr_packing(cache_list, ckpt_snaps)
        if prev is not None and prev.get("arr_slab") is not None and prev["arr_slab"].nbytes == arr_total_bytes:
            arr_slab = prev["arr_slab"]
        else:
            arr_slab = np.empty((arr_total_bytes,), dtype=np.uint8)

        copy_jobs: list[tuple[np.ndarray, np.ndarray]] = []
        for off, nb, dt, shape, view in arr_srcs:
            dst = _arr_slab_view(arr_slab, dt, shape, off, nb)
            copy_jobs.append((dst, view))

        prev_synced = int(prev.get("synced_len", 0)) if prev is not None else 0
        can_reuse_kv = (
            has_kv
            and prev is not None
            and prev.get("kv_q_slab") is not None
            and prev.get("kv_sb_slab") is not None
            and int(prev["kv_bits"]) == int(kv_bits)
            and prev_synced > 0
            and cur_kv_off >= prev_synced
            and cur_kv_off <= int(prev["cap"])
            and len(ids) >= prev_synced
            and prev["ids"][:prev_synced] == ids[:prev_synced]
        )

        kv_meta: dict[int, dict[str, Any]] = {}
        kv_q_slab: np.ndarray | None = None
        kv_sb_slab: np.ndarray | None = None
        cap = 0

        if has_kv:
            if can_reuse_kv and prev is not None:
                kv_q_slab = prev["kv_q_slab"]
                kv_sb_slab = prev["kv_sb_slab"]
                cap = int(prev["cap"])
                kv_meta = prev["kv_meta"]
                if cur_kv_off > prev_synced:
                    for ki, c in enumerate(kv_caches):
                        assert c.keys is not None and c.values is not None
                        _, _, kq = _mx_to_np_view(c.keys[0])
                        _, _, vq = _mx_to_np_view(c.values[0])
                        _, _, ks = _mx_to_np_view(c.keys[1])
                        _, _, kb = _mx_to_np_view(c.keys[2])
                        _, _, vs = _mx_to_np_view(c.values[1])
                        _, _, vb = _mx_to_np_view(c.values[2])
                        copy_jobs.append((kv_q_slab[ki, 0, :, :, prev_synced:cur_kv_off, :], kq[:, :, prev_synced:cur_kv_off, :]))
                        copy_jobs.append((kv_q_slab[ki, 1, :, :, prev_synced:cur_kv_off, :], vq[:, :, prev_synced:cur_kv_off, :]))
                        copy_jobs.append((kv_sb_slab[ki, 0, :, :, prev_synced:cur_kv_off, :], ks[:, :, prev_synced:cur_kv_off, :]))
                        copy_jobs.append((kv_sb_slab[ki, 1, :, :, prev_synced:cur_kv_off, :], kb[:, :, prev_synced:cur_kv_off, :]))
                        copy_jobs.append((kv_sb_slab[ki, 2, :, :, prev_synced:cur_kv_off, :], vs[:, :, prev_synced:cur_kv_off, :]))
                        copy_jobs.append((kv_sb_slab[ki, 3, :, :, prev_synced:cur_kv_off, :], vb[:, :, prev_synced:cur_kv_off, :]))
            else:
                cap = ((cur_kv_off + 256 + 255) // 256) * 256
                c0 = kv_caches[0]
                assert c0.keys is not None and c0.values is not None
                q_dt0, q_sh0, _ = _mx_to_np_view(c0.keys[0])
                sb_dt0, sb_sh0, _ = _mx_to_np_view(c0.keys[1])
                n_kv = len(kv_caches)
                kv_q_slab = np.empty((n_kv, 2, q_sh0[0], q_sh0[1], cap, q_sh0[3]), dtype=_np_dtype_for_mx(q_dt0))
                kv_sb_slab = np.empty((n_kv, 4, sb_sh0[0], sb_sh0[1], cap, sb_sh0[3]), dtype=_np_dtype_for_mx(sb_dt0))
                for ki, (li, c) in enumerate(zip(kv_layer_indices, kv_caches)):
                    assert c.keys is not None and c.values is not None
                    kq_dt, _, kq = _mx_to_np_view(c.keys[0])
                    ks_dt, _, ks = _mx_to_np_view(c.keys[1])
                    kb_dt, _, kb = _mx_to_np_view(c.keys[2])
                    vq_dt, _, vq = _mx_to_np_view(c.values[0])
                    vs_dt, _, vs = _mx_to_np_view(c.values[1])
                    vb_dt, _, vb = _mx_to_np_view(c.values[2])
                    kv_meta[li] = {
                        "group_size": c.group_size,
                        "bits": c.bits,
                        "k_dts": [kq_dt, ks_dt, kb_dt],
                        "v_dts": [vq_dt, vs_dt, vb_dt],
                    }
                    copy_jobs.append((kv_q_slab[ki, 0, :, :, :cur_kv_off, :], kq[:, :, :cur_kv_off, :]))
                    copy_jobs.append((kv_q_slab[ki, 1, :, :, :cur_kv_off, :], vq[:, :, :cur_kv_off, :]))
                    copy_jobs.append((kv_sb_slab[ki, 0, :, :, :cur_kv_off, :], ks[:, :, :cur_kv_off, :]))
                    copy_jobs.append((kv_sb_slab[ki, 1, :, :, :cur_kv_off, :], kb[:, :, :cur_kv_off, :]))
                    copy_jobs.append((kv_sb_slab[ki, 2, :, :, :cur_kv_off, :], vs[:, :, :cur_kv_off, :]))
                    copy_jobs.append((kv_sb_slab[ki, 3, :, :, :cur_kv_off, :], vb[:, :, :cur_kv_off, :]))
        else:
            for li, c in zip(kv_layer_indices, kv_caches):
                kv_meta[li] = {"group_size": c.group_size, "bits": c.bits, "k_dts": [], "v_dts": []}

        if copy_jobs:
            list(self._pool.map(_copy_pair, copy_jobs))

        synced_len = ckpt_len if (0 < ckpt_len <= cur_kv_off) else cur_kv_off
        slab_bytes = (kv_q_slab.nbytes if kv_q_slab is not None else 0) + (kv_sb_slab.nbytes if kv_sb_slab is not None else 0)
        entry = {
            "ids": list(ids),
            "ckpt_len": int(ckpt_len),
            "kv_bits": int(kv_bits),
            "num_layers": len(cache_list),
            "cur_off": cur_kv_off,
            "synced_len": int(synced_len),
            "cap": cap,
            "kv_layer_indices": kv_layer_indices,
            "kv_meta": kv_meta,
            "kv_q_slab": kv_q_slab,
            "kv_sb_slab": kv_sb_slab,
            "arr_meta": arr_meta,
            "ckpt_meta": ckpt_meta,
            "arr_slab": arr_slab,
            "full_chunks": full_chunks,
            "ckpt_chunks": ckpt_chunks,
            "nbytes": slab_bytes + arr_slab.nbytes,
            "slab_bytes": slab_bytes,
        }
        self.ram_pages[sid] = entry
        self.ram_pages.move_to_end(sid)
        while len(self.ram_pages) > self.ram_slots:
            ev_sid, ev_entry = self.ram_pages.popitem(last=False)
            self.write_disk_page(ev_sid, ev_entry)
        if not can_reuse_kv:
            mx.clear_cache()
        return (time.perf_counter() - t0) * 1000.0

    def page_in(
        self, sid: str
    ) -> tuple[str, list[Any] | None, list[int], int, list[Any] | None, int, dict[str, Any] | None, dict[str, Any] | None, float]:
        if sid in self.ram_pages:
            t0 = time.perf_counter()
            entry = self.ram_pages[sid]
            self.ram_pages.move_to_end(sid)
            cache_list, ckpt_snaps = self._restore_from_entry(entry)
            ms = (time.perf_counter() - t0) * 1000.0
            self.l2_swaps += 1
            return (
                "L2_RAM",
                cache_list,
                list(entry["ids"]),
                int(entry["kv_bits"]),
                ckpt_snaps,
                int(entry["ckpt_len"]),
                entry.get("full_chunks"),
                entry.get("ckpt_chunks"),
                ms,
            )

        if sid in self.disk_pages and self.disk_pages[sid].exists():
            t0 = time.perf_counter()
            packed = self.read_disk_page(sid)
            cur_off = int(packed.get("cur_off", 0))
            kv_q_disk = packed.get("kv_q_disk")
            kv_sb_disk = packed.get("kv_sb_disk")
            kv_q_slab = None
            kv_sb_slab = None
            cap = 0
            if kv_q_disk is not None and kv_sb_disk is not None:
                cap = ((cur_off + 256 + 255) // 256) * 256
                kv_q_slab = np.empty((*kv_q_disk.shape[:4], cap, kv_q_disk.shape[5]), dtype=kv_q_disk.dtype)
                kv_sb_slab = np.empty((*kv_sb_disk.shape[:4], cap, kv_sb_disk.shape[5]), dtype=kv_sb_disk.dtype)
                kv_q_slab[:, :, :, :, :cur_off, :] = kv_q_disk
                kv_sb_slab[:, :, :, :, :cur_off, :] = kv_sb_disk
            entry = {
                "ids": packed["ids"],
                "ckpt_len": int(packed.get("ckpt_len", 0)),
                "kv_bits": int(packed["kv_bits"]),
                "num_layers": int(packed["num_layers"]),
                "cur_off": cur_off,
                "synced_len": int(packed.get("ckpt_len", 0)) if 0 < int(packed.get("ckpt_len", 0)) <= cur_off else cur_off,
                "cap": cap,
                "kv_layer_indices": packed["kv_layer_indices"],
                "kv_meta": packed["kv_meta"],
                "kv_q_slab": kv_q_slab,
                "kv_sb_slab": kv_sb_slab,
                "arr_meta": packed["arr_meta"],
                "ckpt_meta": packed.get("ckpt_meta"),
                "arr_slab": packed["arr_slab"],
                "full_chunks": packed.get("full_chunks"),
                "ckpt_chunks": packed.get("ckpt_chunks"),
            }
            cache_list, ckpt_snaps = self._restore_from_entry(entry)
            ms = (time.perf_counter() - t0) * 1000.0
            self.l3_swaps += 1
            return (
                "L3_DISK",
                cache_list,
                list(entry["ids"]),
                int(entry["kv_bits"]),
                ckpt_snaps,
                int(entry["ckpt_len"]),
                entry.get("full_chunks"),
                entry.get("ckpt_chunks"),
                ms,
            )

        return "NEW", None, [], 8, None, 0, None, None, 0.0

    def evict_ram_to_disk(self, target_sid: str | None = None) -> list[dict[str, Any]]:
        evicted = []
        sids = [target_sid] if target_sid else list(self.ram_pages.keys())
        for sid in sids:
            if sid in self.ram_pages:
                entry = self.ram_pages.pop(sid)
                t0 = time.perf_counter()
                _, comp_bytes, raw_bytes = self.write_disk_page(sid, entry)
                evicted.append({
                    "sid": sid,
                    "raw_mb": round(raw_bytes / (1024 * 1024), 2),
                    "disk_mb": round(comp_bytes / (1024 * 1024), 2),
                    "write_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                })
        gc.collect()
        return evicted
`;

const MLX_PY_PART_3 = String.raw`

def _build_reused_accumulators(
    target_spans: list[tuple[int, int]],
    resume_offset: int,
    base_chunks: dict[str, Any] | None,
) -> tuple[list[np.ndarray | None], list[int]] | None:
    if base_chunks is None:
        return None
    base_spans: list[tuple[int, int]] = base_chunks.get("spans") or []
    base_sums: list[np.ndarray | None] = base_chunks.get("sums") or []
    base_counts: list[int] = base_chunks.get("counts") or []
    exact_map: dict[tuple[int, int], int] = {}
    start_map: dict[int, int] = {}
    for bi, (bs, be) in enumerate(base_spans):
        exact_map[(bs, be)] = bi
        if be >= resume_offset and base_counts[bi] == max(0, resume_offset - bs):
            start_map[bs] = bi

    out_sums: list[np.ndarray | None] = []
    out_counts: list[int] = []
    for cs, ce in target_spans:
        if cs >= resume_offset:
            out_sums.append(None)
            out_counts.append(0)
        elif ce <= resume_offset:
            bi = exact_map.get((cs, ce))
            if bi is None or base_counts[bi] != (ce - cs) or base_sums[bi] is None:
                return None
            out_sums.append(np.array(base_sums[bi], dtype=np.float64, copy=True))
            out_counts.append(int(base_counts[bi]))
        else:
            bi = start_map.get(cs)
            if bi is None:
                return None
            out_sums.append(None if base_sums[bi] is None else np.array(base_sums[bi], dtype=np.float64, copy=True))
            out_counts.append(int(base_counts[bi]))
    return out_sums, out_counts


class WardenS1ServerEngine:
    """Singleton weight-pinned Metal engine with priority queue and L1/L2/L3 session paging."""

    def __init__(
        self,
        mlx_dir: Path,
        model_id: str,
        instance_id: str,
        idle_shutdown_sec: int = 1800,
        max_tokens: int = 131072,
        log_jsonl: Path | None = None,
        ram_slots: int = 12,
        page_dir: Path | None = None,
    ):
        self.mlx_dir = mlx_dir
        self.model_id = model_id
        self.instance_id = instance_id
        self.idle_shutdown_sec = max(0, int(idle_shutdown_sec))
        self.max_tokens = max_tokens
        self.log_jsonl = log_jsonl
        if self.log_jsonl is not None:
            self.log_jsonl.parent.mkdir(parents=True, exist_ok=True)

        gc.collect()
        mx.clear_cache()
        mx.reset_peak_memory()
        self.eng = WardenS1MLX(mlx_dir)
        self.weights_active_mb = round(mx.get_active_memory() / (1024 * 1024), 2)

        self._boundary_guard: int = 2
        self._active_sid: str | None = None
        self._active_ids: list[int] = []
        self._active_cache: list[Any] | None = None
        self._active_snaps: list[Any] | None = None
        self._active_ckpt_snaps: list[Any] | None = None
        self._active_ckpt_len: int = 0
        self._active_kv_bits: int = 8
        self._active_full_chunks: dict[str, Any] | None = None
        self._active_ckpt_chunks: dict[str, Any] | None = None
        self._active_chunk_reprs: mx.array | None = None
        self.pager = TieredSessionPager(ram_slots=ram_slots, page_dir=page_dir)

        self._seq = itertools.count()
        self._req_q: queue.PriorityQueue[tuple[int, int, str, Any, Future | None]] = queue.PriorityQueue()
        self._activity_lock = threading.Lock()
        self._in_flight = 0
        self._last_activity = time.monotonic()

        self._worker = threading.Thread(target=self._gpu_worker_loop, daemon=True)
        self._worker.start()

        self.requests_served = 0
        self.prewarms_served = 0
        self.cache_exact_hits = 0
        self.cache_delta_hits = 0
        self.cache_boundary_healed_hits = 0
        self.cache_misses = 0
        self.l1_hits = 0
        self.max_active_mb = self.weights_active_mb
        self.max_peak_mb = self.weights_active_mb
        self.recent_telemetry: list[dict[str, Any]] = []

    def stop(self) -> None:
        self._req_q.put((-1, next(self._seq), "stop", None, None))
        self._worker.join(timeout=5.0)
        self.pager.close()

    def _touch_activity(self) -> None:
        with self._activity_lock:
            self._last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        with self._activity_lock:
            if self._in_flight > 0 or not self._req_q.empty():
                return 0.0
            return max(0.0, time.monotonic() - self._last_activity)

    def _gpu_worker_loop(self) -> None:
        while True:
            _, _, op, arg, fut = self._req_q.get()
            if op == "stop":
                break
            is_inference = op in ("eval", "prewarm", "salience")
            if is_inference:
                with self._activity_lock:
                    self._in_flight += 1
                    self._last_activity = time.monotonic()
            try:
                if op == "eval":
                    payload, sid = arg
                    result = self._evaluate_on_gpu(payload, sid)
                elif op == "prewarm":
                    payload, sid = arg
                    result = self._prewarm_on_gpu(payload, sid)
                elif op == "salience":
                    payload, sid = arg
                    result = self._salience_on_gpu(payload, sid)
                elif op == "reset":
                    self._clear_l1_on_gpu(force_clear=True)
                    self.pager.clear_all()
                    result = True
                elif op == "drop_session":
                    result = self._drop_session_on_gpu(str(arg))
                elif op == "evict_to_disk":
                    if arg and arg == self._active_sid:
                        self._evict_l1_to_l2()
                    elif arg is None and self._active_sid is not None:
                        self._evict_l1_to_l2()
                    ev = self.pager.evict_ram_to_disk(arg)
                    mx.clear_cache()
                    result = {"evicted": ev, "ram_slots_used": len(self.pager.ram_pages), "disk_pages": len(self.pager.disk_pages)}
                elif op == "stats":
                    result = self._stats_on_gpu()
                else:
                    raise ValueError(f"Unknown op: {op}")
                if fut is not None:
                    fut.set_result(result)
            except Exception as exc:
                if fut is not None:
                    fut.set_exception(exc)
            finally:
                if is_inference:
                    with self._activity_lock:
                        self._in_flight = max(0, self._in_flight - 1)
                        self._last_activity = time.monotonic()

    def _submit(self, op: str, arg: Any = None, priority: int = 0) -> Any:
        fut: Future = Future()
        self._req_q.put((priority, next(self._seq), op, arg, fut))
        return fut.result()

    def evaluate(self, payload: dict[str, Any], session_id: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        return self._submit("eval", (payload, session_id), priority=0)

    def prewarm(self, payload: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
        return self._submit("prewarm", (payload, session_id), priority=1)

    def salience(self, payload: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
        return self._submit("salience", (payload, session_id), priority=0)

    def reset_cache(self) -> None:
        self._submit("reset", None, priority=0)

    def drop_session(self, session_id: str) -> dict[str, Any]:
        return self._submit("drop_session", session_id, priority=0)

    def evict_to_disk(self, session_id: str | None = None) -> dict[str, Any]:
        return self._submit("evict_to_disk", session_id, priority=0)

    def stats(self) -> dict[str, Any]:
        return self._submit("stats", None, priority=0)

    def _clear_l1_on_gpu(self, force_clear: bool = False) -> None:
        self._active_sid = None
        self._active_ids = []
        self._active_cache = None
        self._active_snaps = None
        self._active_ckpt_snaps = None
        self._active_ckpt_len = 0
        self._active_full_chunks = None
        self._active_ckpt_chunks = None
        self._active_chunk_reprs = None
        if force_clear:
            gc.collect()
            mx.clear_cache()
        elif mx.get_active_memory() > 920 * 1024 * 1024:
            mx.clear_cache()

    def _drop_session_on_gpu(self, sid: str) -> dict[str, Any]:
        dropped = False
        if self._active_sid == sid:
            self._clear_l1_on_gpu(force_clear=True)
            dropped = True
        if self.pager.drop_session(sid):
            dropped = True
        return {"dropped": dropped, "session_id": sid}

    def _evict_l1_to_l2(self) -> float:
        if self._active_cache is None or self._active_sid is None:
            return 0.0
        if self._active_snaps is not None:
            restore_cache_from_prefix(self._active_cache, self._active_snaps, len(self._active_ids))
        ms = self.pager.page_out(
            self._active_sid,
            self._active_cache,
            self._active_ids,
            self._active_kv_bits,
            ckpt_snaps=self._active_ckpt_snaps,
            ckpt_len=self._active_ckpt_len,
            full_chunks=self._active_full_chunks,
            ckpt_chunks=self._active_ckpt_chunks,
        )
        self._clear_l1_on_gpu(force_clear=False)
        return ms

    def _build_chunk_reprs(self, chunk_state: dict[str, Any] | None) -> mx.array:
        if not chunk_state or not chunk_state.get("spans"):
            return mx.zeros((1, self.eng.hidden_size), dtype=mx.float32)
        spans = chunk_state["spans"]
        sums = chunk_state["sums"]
        counts = chunk_state["counts"]
        n_c = max(1, len(spans))
        pooled = np.zeros((n_c, self.eng.hidden_size), dtype=np.float32)
        for ci in range(len(spans)):
            if sums[ci] is not None and counts[ci] > 0:
                pooled[ci] = (sums[ci] / float(counts[ci])).astype(np.float32)
        arr = mx.array(pooled)
        mx.eval(arr)
        return arr

    def _activate_session_slot(self, sid: str) -> tuple[str, float]:
        if self._active_sid == sid and self._active_cache is not None:
            self.l1_hits += 1
            return "L1", 0.0

        out_ms = self._evict_l1_to_l2()
        tier, cache, ids, kv_bits, ckpt_snaps, ckpt_len, full_chunks, ckpt_chunks, in_ms = self.pager.page_in(sid)
        total_swap_ms = out_ms + in_ms
        if cache is not None:
            self._active_sid = sid
            self._active_cache = cache
            self._active_ids = ids
            self._active_kv_bits = kv_bits
            self._active_snaps = clone_arrays_snapshots(cache)
            self._active_ckpt_snaps = ckpt_snaps
            self._active_ckpt_len = ckpt_len
            self._active_full_chunks = full_chunks
            self._active_ckpt_chunks = ckpt_chunks
            self._active_chunk_reprs = self._build_chunk_reprs(full_chunks)
            self.pager.swap_latencies_ms.append(total_swap_ms)
        return tier, total_swap_ms

    def _resolve_session_id(self, explicit_sid: str | None, payload: dict[str, Any], ids: list[int]) -> str:
        raw = explicit_sid or payload.get("session_id")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        head = ",".join(str(x) for x in ids[:64]).encode("utf-8")
        return f"pfx-{hashlib.sha256(head).hexdigest()[:16]}"

    def _truncate_ids(self, ids: list[int], offsets: list[tuple[int, int]] | None) -> tuple[list[int], list[tuple[int, int]] | None]:
        if len(ids) <= self.max_tokens:
            return ids, offsets
        head = min(4096, self.max_tokens // 8)
        tail = self.max_tokens - head
        new_ids = ids[:head] + ids[-tail:]
        new_offs = (offsets[:head] + offsets[-tail:]) if offsets is not None else None
        return new_ids, new_offs

    def _encode_with_boundary_ckpt(
        self,
        ids_chunk: list[int],
        chunk_spans: list[tuple[int, int]],
        chunk_meta: list[dict[str, Any]],
        init_cache: list[Any] | None,
        start_offset: int,
        kv_bits: int | None,
        span_sums: list[np.ndarray | None],
        span_counts: list[int],
    ) -> tuple[list[Any], list[Any], list[Any] | None, int, dict[str, Any], dict[str, Any] | None, mx.array]:
        guard = self._boundary_guard
        total_len = start_offset + len(ids_chunk)
        if len(ids_chunk) > guard and total_len > guard:
            body = ids_chunk[:-guard]
            tail = ids_chunk[-guard:]
            ckpt_len = start_offset + len(body)
            sess1 = self.eng.encode_prefix(
                body,
                chunk_spans=chunk_spans,
                kv_bits=kv_bits,
                prefill_step=2048,
                init_cache=init_cache,
                start_offset=start_offset,
                span_sums=span_sums,
                span_counts=span_counts,
            )
            cache = sess1["cache"]
            ckpt_snaps = clone_arrays_snapshots(cache)
            ckpt_chunks = _clone_chunk_state(chunk_spans, sess1["span_sums"], sess1["span_counts"], chunk_meta)
            sess2 = self.eng.encode_prefix(
                tail,
                chunk_spans=chunk_spans,
                kv_bits=None,
                prefill_step=2048,
                init_cache=cache,
                start_offset=ckpt_len,
                span_sums=sess1["span_sums"],
                span_counts=sess1["span_counts"],
            )
            full_snaps = clone_arrays_snapshots(cache)
            full_chunks = _clone_chunk_state(chunk_spans, sess2["span_sums"], sess2["span_counts"], chunk_meta)
            return cache, full_snaps, ckpt_snaps, ckpt_len, full_chunks, ckpt_chunks, sess2["chunk_reprs"]

        sess = self.eng.encode_prefix(
            ids_chunk,
            chunk_spans=chunk_spans,
            kv_bits=kv_bits,
            prefill_step=2048,
            init_cache=init_cache,
            start_offset=start_offset,
            span_sums=span_sums,
            span_counts=span_counts,
        )
        cache = sess["cache"]
        full_snaps = clone_arrays_snapshots(cache)
        full_chunks = _clone_chunk_state(chunk_spans, sess["span_sums"], sess["span_counts"], chunk_meta)
        return (
            cache,
            full_snaps,
            self._active_ckpt_snaps if init_cache is not None else None,
            self._active_ckpt_len if init_cache is not None else 0,
            full_chunks,
            self._active_ckpt_chunks if init_cache is not None else None,
            sess["chunk_reprs"],
        )

    def _encode_incremental_on_gpu(
        self,
        sid: str,
        ids: list[int],
        chunk_spans: list[tuple[int, int]],
        chunk_meta: list[dict[str, Any]],
        force_recheckpoint: bool = False,
    ) -> tuple[int, int, str, bool, str, float, float]:
        if force_recheckpoint:
            self._drop_session_on_gpu(sid)
        tier, swap_ms = self._activate_session_slot(sid)
        t0 = time.perf_counter()
        target_kv_bits = 4 if len(ids) > 65536 else 8
        old_len = len(self._active_ids)

        if (
            self._active_cache is not None
            and self._active_snaps is not None
            and ids == self._active_ids
            and self._active_full_chunks is not None
            and self._active_full_chunks.get("spans") == chunk_spans
        ):
            restore_cache_from_prefix(self._active_cache, self._active_snaps, old_len)
            self._active_full_chunks["meta"] = [dict(m) for m in chunk_meta]
            self.cache_exact_hits += 1
            return old_len, 0, "exact", False, tier, swap_ms, (time.perf_counter() - t0) * 1000.0

        if (
            self._active_cache is not None
            and self._active_snaps is not None
            and old_len > 0
            and len(ids) > old_len
            and ids[:old_len] == self._active_ids
        ):
            reused = _build_reused_accumulators(chunk_spans, old_len, self._active_full_chunks)
            if reused is not None:
                restore_cache_from_prefix(self._active_cache, self._active_snaps, old_len)
                if self._active_kv_bits != target_kv_bits:
                    self._active_cache = requantize_kv_cache_list(self._active_cache, target_kv_bits)
                    self._active_kv_bits = target_kv_bits
                delta_ids = ids[old_len:]
                cache, full_snaps, ckpt_snaps, ckpt_len, full_chunks, ckpt_chunks, chunk_reprs = self._encode_with_boundary_ckpt(
                    delta_ids, chunk_spans, chunk_meta, self._active_cache, old_len, None, reused[0], reused[1]
                )
                self._active_cache = cache
                self._active_ids = list(ids)
                self._active_snaps = full_snaps
                self._active_ckpt_snaps = ckpt_snaps
                self._active_ckpt_len = ckpt_len
                self._active_full_chunks = full_chunks
                self._active_ckpt_chunks = ckpt_chunks
                self._active_chunk_reprs = chunk_reprs
                self.cache_delta_hits += 1
                return old_len, len(delta_ids), "delta", False, tier, swap_ms, (time.perf_counter() - t0) * 1000.0

        ckpt_len = self._active_ckpt_len
        if (
            self._active_cache is not None
            and self._active_ckpt_snaps is not None
            and ckpt_len > 0
            and len(ids) > ckpt_len
            and ids[:ckpt_len] == self._active_ids[:ckpt_len]
        ):
            reused = _build_reused_accumulators(chunk_spans, ckpt_len, self._active_ckpt_chunks)
            if reused is not None:
                restore_cache_from_prefix(self._active_cache, self._active_ckpt_snaps, ckpt_len)
                if self._active_kv_bits != target_kv_bits:
                    self._active_cache = requantize_kv_cache_list(self._active_cache, target_kv_bits)
                    self._active_kv_bits = target_kv_bits
                delta_ids = ids[ckpt_len:]
                cache, full_snaps, ckpt_snaps, new_ckpt_len, full_chunks, ckpt_chunks, chunk_reprs = self._encode_with_boundary_ckpt(
                    delta_ids, chunk_spans, chunk_meta, self._active_cache, ckpt_len, None, reused[0], reused[1]
                )
                self._active_cache = cache
                self._active_ids = list(ids)
                self._active_snaps = full_snaps
                self._active_ckpt_snaps = ckpt_snaps
                self._active_ckpt_len = new_ckpt_len
                self._active_full_chunks = full_chunks
                self._active_ckpt_chunks = ckpt_chunks
                self._active_chunk_reprs = chunk_reprs
                self.cache_delta_hits += 1
                self.cache_boundary_healed_hits += 1
                return ckpt_len, len(delta_ids), "delta", True, tier, swap_ms, (time.perf_counter() - t0) * 1000.0

        self._clear_l1_on_gpu(force_clear=True)
        fresh_sums: list[np.ndarray | None] = [None] * len(chunk_spans)
        fresh_counts: list[int] = [0] * len(chunk_spans)
        cache, full_snaps, ckpt_snaps, ckpt_len, full_chunks, ckpt_chunks, chunk_reprs = self._encode_with_boundary_ckpt(
            ids, chunk_spans, chunk_meta, None, 0, target_kv_bits, fresh_sums, fresh_counts
        )
        self._active_sid = sid
        self._active_cache = cache
        self._active_ids = list(ids)
        self._active_kv_bits = target_kv_bits
        self._active_snaps = full_snaps
        self._active_ckpt_snaps = ckpt_snaps
        self._active_ckpt_len = ckpt_len
        self._active_full_chunks = full_chunks
        self._active_ckpt_chunks = ckpt_chunks
        self._active_chunk_reprs = chunk_reprs
        self.cache_misses += 1
        return 0, len(ids), "miss", False, tier, swap_ms, (time.perf_counter() - t0) * 1000.0

    def _prepare_state(self, payload: dict[str, Any], explicit_sid: str | None) -> tuple[str, list[int], list[dict[str, Any]], list[tuple[int, int]]]:
        raw_text, raw_chunks = extract_state_chunks(payload.get("state"))
        ids, offsets = encode_with_offsets(self.eng.tok, raw_text)
        ids, offsets = self._truncate_ids(ids, offsets)
        if not ids:
            ids = [self.eng.tok.eos_token_id or 1]
            offsets = [(0, len(raw_text))] if offsets is not None else None
        explicit_chunks = payload.get("chunks") if isinstance(payload.get("chunks"), list) else None
        chunk_meta, chunk_spans = map_chunks_to_token_spans(raw_text, raw_chunks, len(ids), offsets, explicit_chunks)
        sid = self._resolve_session_id(explicit_sid, payload, ids)
        return sid, ids, chunk_meta, chunk_spans

    def _compute_salience(self) -> list[float]:
        chunk_reprs = self._active_chunk_reprs
        if chunk_reprs is None:
            return []
        _, sal_probs = self.eng.heads.salience(chunk_reprs)
        mx.eval(sal_probs)
        return [round(float(v), 6) for v in np.array(sal_probs, dtype=np.float64).tolist()]

    def _prewarm_on_gpu(self, payload: dict[str, Any], explicit_sid: str | None) -> dict[str, Any]:
        if payload.get("state") is None:
            raise ValueError("state is required")
        recheckpoint = bool(payload.get("recheckpoint", False))
        sid, ids, chunk_meta, chunk_spans = self._prepare_state(payload, explicit_sid)
        prefix_reuse, delta_len, cache_mode, boundary_healed, page_tier, swap_ms, prefill_ms = self._encode_incremental_on_gpu(
            sid, ids, chunk_spans, chunk_meta, force_recheckpoint=recheckpoint
        )
        salience = self._compute_salience()
        self.prewarms_served += 1
        chunks_out = [{**m, "salience": salience[i] if i < len(salience) else 0.0} for i, m in enumerate(chunk_meta)]
        return {
            "ok": True,
            "session_id": sid,
            "runtime": "mlx",
            "state_tokens": len(ids),
            "prefix_reuse_tokens": prefix_reuse,
            "delta_tokens": delta_len,
            "cache_mode": cache_mode,
            "boundary_healed": boundary_healed,
            "page_tier": page_tier,
            "recheckpointed": recheckpoint,
            "swap_ms": round(swap_ms, 2),
            "prefill_ms": round(prefill_ms, 2),
            "salience": salience,
            "chunks": chunks_out,
        }

    def _salience_on_gpu(self, payload: dict[str, Any], explicit_sid: str | None) -> dict[str, Any]:
        if payload.get("state") is not None:
            sid, ids, chunk_meta, chunk_spans = self._prepare_state(payload, explicit_sid)
            _, _, cache_mode, boundary_healed, page_tier, swap_ms, _ = self._encode_incremental_on_gpu(
                sid, ids, chunk_spans, chunk_meta
            )
        else:
            raw_sid = explicit_sid or payload.get("session_id")
            if not isinstance(raw_sid, str) or not raw_sid.strip():
                raise ValueError("state or session_id is required")
            sid = raw_sid.strip()
            page_tier, swap_ms = self._activate_session_slot(sid)
            if self._active_cache is None or self._active_full_chunks is None:
                raise ValueError(f"session not found in cache: {sid}")
            ids = self._active_ids
            chunk_meta = self._active_full_chunks.get("meta") or []
            cache_mode = "exact"
            boundary_healed = False

        salience = self._compute_salience()
        chunks_out = [{**m, "salience": salience[i] if i < len(salience) else 0.0} for i, m in enumerate(chunk_meta)]
        return {
            "ok": True,
            "session_id": sid,
            "runtime": "mlx",
            "state_tokens": len(ids),
            "cache_mode": cache_mode,
            "boundary_healed": boundary_healed,
            "page_tier": page_tier,
            "swap_ms": round(swap_ms, 2),
            "salience": salience,
            "chunks": chunks_out,
        }

    def _evaluate_on_gpu(self, payload: dict[str, Any], explicit_sid: str | None) -> tuple[dict[str, Any], dict[str, Any]]:
        state = payload.get("state")
        questions = payload.get("questions")
        req_model = str(payload.get("model") or self.model_id)
        if state is None:
            raise ValueError("state is required")
        if not isinstance(questions, dict) or len(questions) == 0:
            raise ValueError("questions must be a non-empty object")

        abstain_band = payload.get("abstain_band")
        abstain_lo, abstain_hi = (float(abstain_band[0]), float(abstain_band[1])) if isinstance(abstain_band, list) and len(abstain_band) == 2 else (0.42, 0.58)
        sid, ids, chunk_meta, chunk_spans = self._prepare_state(payload, explicit_sid)

        q_keys, q_types, q_raw, q_ids_list = [], [], [], []
        choice_indices, choice_opt_keys, choice_opt_ids = [], [], []
        for qi, (qid, qobj) in enumerate(questions.items()):
            qtype, norm_q = normalize_question(qobj)
            prompt_text, opt_strs = format_probe_prompt(qtype, norm_q)
            q_ids = self.eng.tok.encode(prompt_text, add_special_tokens=False) or [1]
            q_keys.append(str(qid))
            q_types.append(qtype)
            q_raw.append(qobj)
            q_ids_list.append(q_ids)
            if qtype == "choice":
                choice_indices.append(qi)
                choice_opt_keys.append(list(norm_q["criteria"].keys()))
                choice_opt_ids.append([self.eng.tok.encode(s, add_special_tokens=False) or [1] for s in opt_strs])
        q_tok_total = sum(len(x) for x in q_ids_list)

        t_start = time.perf_counter()
        mx.reset_peak_memory()
        ephemeral_last_chunk = bool(payload.get("ephemeral_last_chunk", False))
        forked = False
        prefix_reuse = 0
        delta_len = 0
        cache_mode = "miss"
        boundary_healed = False
        page_tier = "NEW"
        swap_ms = 0.0
        prefill_ms = 0.0
        q_vecs: list[mx.array] = []
        chunk_reprs: mx.array | None = None
        t_probe0 = t_start

        if ephemeral_last_chunk and len(chunk_spans) >= 2:
            prefix_spans_raw = chunk_spans[:-1]
            prefix_meta_raw = chunk_meta[:-1]
            cand_token_start = chunk_spans[-1][0]
            max_prefix_end = max(e for _, e in prefix_spans_raw)
            split_pos = min(cand_token_start, max_prefix_end)
            if 0 < split_pos < len(ids) and all(s < split_pos for s, _ in prefix_spans_raw):
                prefix_ids = ids[:split_pos]
                prefix_spans = [(s, min(e, split_pos)) for s, e in prefix_spans_raw]
                prefix_meta = [
                    {**m, "token_start": prefix_spans[i][0], "token_end": prefix_spans[i][1]}
                    for i, m in enumerate(prefix_meta_raw)
                ]
                tail_ids = ids[split_pos:]
                prefix_reuse, delta_len, cache_mode, boundary_healed, page_tier, swap_ms, prefill_ms = self._encode_incremental_on_gpu(
                    sid, prefix_ids, prefix_spans, prefix_meta
                )
                reused = _build_reused_accumulators(chunk_spans, split_pos, self._active_full_chunks)
                if reused is not None:
                    cache = self._active_cache
                    prefix_snaps = self._active_snaps
                    assert cache is not None and prefix_snaps is not None
                    try:
                        restore_cache_from_prefix(cache, prefix_snaps, split_pos)
                        t_tail0 = time.perf_counter()
                        tail_sess = self.eng.encode_prefix(
                            tail_ids,
                            chunk_spans=chunk_spans,
                            kv_bits=None,
                            prefill_step=2048,
                            init_cache=cache,
                            start_offset=split_pos,
                            span_sums=reused[0],
                            span_counts=reused[1],
                        )
                        prefill_ms += (time.perf_counter() - t_tail0) * 1000.0
                        delta_len += len(tail_ids)
                        if cache_mode == "exact":
                            self.cache_exact_hits -= 1
                            self.cache_delta_hits += 1
                            cache_mode = "delta"
                        cand_snaps = clone_arrays_snapshots(cache)
                        chunk_reprs = tail_sess["chunk_reprs"]
                        assert chunk_reprs is not None
                        t_probe0 = time.perf_counter()
                        eval_len = len(ids)
                        for q_ids in q_ids_list:
                            restore_cache_from_prefix(cache, cand_snaps, eval_len)
                            h = self.eng.model.model(mx.array([q_ids], dtype=mx.int32), cache=cache)
                            q_vec = h[0, -1].astype(mx.float32)
                            mx.eval(q_vec)
                            q_vecs.append(q_vec)
                            del h
                    finally:
                        restore_cache_from_prefix(cache, prefix_snaps, split_pos)
                    forked = True

        if not forked:
            prefix_reuse, delta_len, cache_mode, boundary_healed, page_tier, swap_ms, prefill_ms = self._encode_incremental_on_gpu(
                sid, ids, chunk_spans, chunk_meta
            )

            t_probe0 = time.perf_counter()
            cache = self._active_cache
            snaps = self._active_snaps
            chunk_reprs = self._active_chunk_reprs
            prefix_len = len(ids)
            assert cache is not None and snaps is not None and chunk_reprs is not None

            for q_ids in q_ids_list:
                restore_cache_from_prefix(cache, snaps, prefix_len)
                h = self.eng.model.model(mx.array([q_ids], dtype=mx.int32), cache=cache)
                q_vec = h[0, -1].astype(mx.float32)
                mx.eval(q_vec)
                q_vecs.append(q_vec)
                del h
            restore_cache_from_prefix(cache, snaps, prefix_len)

        assert chunk_reprs is not None

        q_mat = mx.stack(q_vecs, axis=0)
        _, noul_probs = self.eng.heads.noul(q_mat)
        _, score_bin_probs, _ = self.eng.heads.score(q_mat)
        _, locus_probs = self.eng.heads.locus(q_mat, chunk_reprs)
        _, sal_probs = self.eng.heads.salience(chunk_reprs)

        choice_probs_arr = None
        if choice_indices:
            c_qrepr = q_mat[mx.array(choice_indices, dtype=mx.int32)]
            max_opts = max(len(o) for o in choice_opt_ids)
            opt_vecs = np.zeros((len(choice_opt_ids), max_opts, self.eng.hidden_size), dtype=np.float32)
            opt_mask = np.zeros((len(choice_opt_ids), max_opts), dtype=bool)
            for ci, opts in enumerate(choice_opt_ids):
                for oi, otoks in enumerate(opts):
                    emb = self.eng.model.model.embed_tokens(mx.array(otoks, dtype=mx.int32))
                    vec = mx.mean(emb.astype(mx.float32), axis=0)
                    mx.eval(vec)
                    opt_vecs[ci, oi] = np.array(vec)
                    opt_mask[ci, oi] = True
            _, choice_probs_arr = self.eng.heads.choice(c_qrepr, mx.array(opt_vecs), mx.array(opt_mask))
            mx.eval(choice_probs_arr)

        mx.eval(noul_probs, score_bin_probs, locus_probs, sal_probs)
        np_noul = np.array(noul_probs, dtype=np.float64)
        np_score_bins = np.array(score_bin_probs, dtype=np.float64)
        np_locus = np.array(locus_probs, dtype=np.float64)
        np_sal = np.array(sal_probs, dtype=np.float64)
        np_choice = np.array(choice_probs_arr, dtype=np.float64) if choice_probs_arr is not None else None
        probe_ms = (time.perf_counter() - t_probe0) * 1000.0
        total_ms = (time.perf_counter() - t_start) * 1000.0

        active_mb = round(mx.get_active_memory() / (1024 * 1024), 2)
        peak_mb = round(mx.get_peak_memory() / (1024 * 1024), 2)
        self.max_active_mb = max(self.max_active_mb, active_mb)
        self.max_peak_mb = max(self.max_peak_mb, peak_mb)
        self.requests_served += 1

        answers: dict[str, Any] = {}
        abstentions: dict[str, bool] = {}
        locus_by_q: dict[str, Any] = {}
        c_pos = 0
        n_chunks = len(chunk_meta)
        for qi, (qid, qtype, raw_q) in enumerate(zip(q_keys, q_types, q_raw)):
            lrow = [round(float(v), 6) for v in np_locus[qi, :n_chunks].tolist()]
            ltop = int(np.argmax(np_locus[qi, :n_chunks])) if n_chunks > 0 else 0
            locus_by_q[qid] = {"top_chunk": ltop, "top_prob": lrow[ltop] if lrow else 0.0, "chunk_probs": lrow}
            if qtype == "noul":
                p = round(float(np.clip(np_noul[qi], 0.0, 1.0)), 6)
                answers[qid] = {"type": "noul", "noul": p}
                abstentions[qid] = abstain_lo <= p <= abstain_hi
            elif qtype == "choice":
                keys = choice_opt_keys[c_pos]
                row = np.clip(np_choice[c_pos, : len(keys)], 0.0, 1.0)
                rsum = float(row.sum())
                row = row / rsum if rsum > 0 else np.full((len(keys),), 1.0 / len(keys))
                best_idx = int(np.argmax(row))
                answers[qid] = {
                    "type": "choice",
                    "choice": keys[best_idx],
                    "confidence": round(float(row[best_idx]), 6),
                    "probabilities": {k: round(float(row[i]), 6) for i, k in enumerate(keys)},
                }
                c_pos += 1
            elif qtype == "score":
                legend = raw_q.get("criteria") or []
                probs_dict, score_val, conf = project_score_bins(np_score_bins[qi], len(legend))
                answers[qid] = {
                    "type": "score",
                    "score": score_val,
                    "confidence": conf,
                    "probabilities": probs_dict,
                    "legend": legend,
                }
            elif qtype == "locus":
                answers[qid] = {"type": "locus", **locus_by_q[qid]}

        sal_list = [round(float(v), 6) for v in np_sal[:n_chunks].tolist()]
        chunks_out = [{**m, "salience": sal_list[i] if i < len(sal_list) else 0.0} for i, m in enumerate(chunk_meta)]
        primary_locus = locus_by_q[q_keys[0]] if q_keys else {"top_chunk": 0, "top_prob": 0.0, "chunk_probs": []}

        telemetry = {
            "ts": time.time(),
            "req_num": self.requests_served,
            "session_id": sid,
            "state_tokens": len(ids),
            "prefix_reuse_tokens": prefix_reuse,
            "delta_tokens": delta_len,
            "cache_mode": cache_mode,
            "boundary_healed": boundary_healed,
            "page_tier": page_tier,
            "swap_ms": round(swap_ms, 2),
            "kv_bits": self._active_kv_bits,
            "num_questions": len(questions),
            "q_tokens": q_tok_total,
            "prefill_ms": round(prefill_ms, 2),
            "probe_ms": round(probe_ms, 2),
            "total_ms": round(total_ms, 2),
            "metal_active_mb": active_mb,
            "metal_peak_mb": peak_mb,
        }
        self.recent_telemetry.append(telemetry)
        if len(self.recent_telemetry) > 500:
            self.recent_telemetry = self.recent_telemetry[-500:]
        if self.log_jsonl is not None:
            with open(self.log_jsonl, "a", encoding="utf-8") as lf:
                lf.write(json.dumps(telemetry) + "\n")

        response = {
            "model": req_model,
            "usage": {"input_tokens": len(ids) + q_tok_total, "output_tokens": len(questions)},
            "answers": answers,
            "s1": {
                "session_id": sid,
                "runtime": "mlx",
                "cache_mode": cache_mode,
                "boundary_healed": boundary_healed,
                "page_tier": page_tier,
                "prefix_reuse_tokens": prefix_reuse,
                "delta_tokens": delta_len,
                "state_tokens": len(ids),
                "swap_ms": round(swap_ms, 2),
                "prefill_ms": round(prefill_ms, 2),
                "probe_ms": round(probe_ms, 2),
                "total_ms": round(total_ms, 2),
                "chunks": chunks_out,
                "salience": sal_list,
                "locus": {**primary_locus, "by_question": locus_by_q},
                "abstentions": abstentions,
            },
        }
        return response, telemetry

    def _stats_on_gpu(self) -> dict[str, Any]:
        active_mb = round(mx.get_active_memory() / (1024 * 1024), 2)
        lats = [r["total_ms"] for r in self.recent_telemetry]
        swaps = self.pager.swap_latencies_ms[-200:]
        return {
            "status": "ok",
            "runtime": "mlx",
            "pid": os.getpid(),
            "instance_id": self.instance_id,
            "model": self.model_id,
            "model_dir": str(self.mlx_dir),
            "idle_shutdown_sec": self.idle_shutdown_sec,
            "idle_sec": round(self.idle_seconds(), 2),
            "in_flight": self._in_flight,
            "weights_active_mb": self.weights_active_mb,
            "metal_active_mb": active_mb,
            "metal_max_active_mb": self.max_active_mb,
            "metal_max_peak_mb": self.max_peak_mb,
            "under_1024_mib": self.max_active_mb < 1024.0,
            "active_session_id": self._active_sid,
            "active_prefix_tokens": len(self._active_ids),
            "l2_ram_sessions": len(self.pager.ram_pages) - (1 if self._active_sid in self.pager.ram_pages else 0),
            "l3_disk_sessions": len(self.pager.disk_pages),
            "zstd_enabled": self.pager.zstd_enabled,
            "requests_served": self.requests_served,
            "prewarms_served": self.prewarms_served,
            "cache_exact_hits": self.cache_exact_hits,
            "cache_delta_hits": self.cache_delta_hits,
            "cache_boundary_healed_hits": self.cache_boundary_healed_hits,
            "cache_misses": self.cache_misses,
            "l1_hits": self.l1_hits,
            "l2_ram_swaps": self.pager.l2_swaps,
            "l3_disk_swaps": self.pager.l3_swaps,
            "swap_ms_p50": round(float(np.percentile(swaps, 50)), 2) if swaps else 0.0,
            "swap_ms_p95": round(float(np.percentile(swaps, 95)), 2) if swaps else 0.0,
            "latency_ms_p50": round(float(np.percentile(lats, 50)), 2) if lats else 0.0,
            "latency_ms_p95": round(float(np.percentile(lats, 95)), 2) if lats else 0.0,
        }


def _write_state_file_atomic(path: Path, info: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except Exception:
        pass
    tmp = path.parent / f".{path.name}.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _remove_state_file_if_owned(path: Path | None, instance_id: str) -> None:
    if path is None or not path.exists():
        return
    try:
        cur = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(cur, dict) and cur.get("instanceId") == instance_id:
            path.unlink(missing_ok=True)
    except Exception:
        pass


def make_handler(engine: WardenS1ServerEngine, token: str, shutdown_cb: Any):
    expected_auth = f"Bearer {token}" if token else ""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _authorized(self) -> bool:
            if not expected_auth:
                return True
            got = self.headers.get("Authorization", "")
            return hmac.compare_digest(got, expected_auth)

        def _send_json(self, status: int, body: Any, extra_headers: dict[str, str] | None = None) -> None:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("x-typesafe-request-id", f"ws1-{uuid.uuid4().hex[:12]}")
            if extra_headers:
                for k, v in extra_headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if not self._authorized():
                self._send_json(401, {"error": "Unauthorized"})
                return
            path = self.path.split("?", 1)[0]
            if path == "/health":
                self._send_json(200, engine.stats())
                return
            if path == "/stats":
                self._send_json(200, {**engine.stats(), "recent": engine.recent_telemetry[-100:]})
                return
            if path == "/v1/models":
                self._send_json(
                    200,
                    {
                        "models": [
                            {
                                "name": engine.model_id,
                                "id": engine.model_id,
                                "object": "model",
                                "runtime": "mlx",
                                "description": "Warden-S1 752M MLX-Q4 singleton local System-One verifier with tiered session paging",
                            }
                        ]
                    },
                )
                return
            self._send_json(404, {"error": f"Not found: {path}"})

        def do_POST(self) -> None:
            if not self._authorized():
                self._send_json(401, {"error": "Unauthorized"})
                return
            path = self.path.split("?", 1)[0]
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
            except Exception as exc:
                self._send_json(400, {"error": f"Invalid JSON: {exc}"})
                return

            sid = self.headers.get("X-Warden-Session-Id")
            try:
                if path == "/v1/systemone":
                    resp, tel = engine.evaluate(body, session_id=sid)
                    self._send_json(
                        200,
                        resp,
                        extra_headers={
                            "X-Warden-S1-Latency-Ms": str(tel["total_ms"]),
                            "X-Warden-S1-Swap-Ms": str(tel["swap_ms"]),
                            "X-Warden-S1-Page-Tier": str(tel["page_tier"]),
                            "X-Warden-S1-Metal-Mb": str(tel["metal_active_mb"]),
                            "X-Warden-S1-Cache-Mode": str(tel["cache_mode"]),
                            "X-Warden-S1-Boundary-Healed": "1" if tel["boundary_healed"] else "0",
                            "X-Warden-S1-Delta-Tokens": str(tel["delta_tokens"]),
                        },
                    )
                    return
                if path == "/v1/prewarm":
                    self._send_json(200, engine.prewarm(body, session_id=sid))
                    return
                if path == "/v1/salience":
                    self._send_json(200, engine.salience(body, session_id=sid))
                    return
                if path == "/admin/reset_cache":
                    engine.reset_cache()
                    self._send_json(200, {"reset": True})
                    return
                if path == "/admin/evict_to_disk":
                    self._send_json(200, engine.evict_to_disk(body.get("session_id")))
                    return
                if path == "/admin/drop_session":
                    target_sid = body.get("session_id") or sid
                    if not target_sid:
                        self._send_json(422, {"error": "session_id is required"})
                        return
                    self._send_json(200, engine.drop_session(str(target_sid)))
                    return
                if path == "/admin/shutdown":
                    self._send_json(200, {"shutting_down": True})
                    threading.Thread(target=shutdown_cb, daemon=True).start()
                    return
                self._send_json(404, {"error": f"Not found: {path}"})
            except ValueError as e:
                self._send_json(422, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Singleton <1GiB Warden-S1 MLX loopback daemon")
    parser.add_argument("--mlx-dir", "--model-dir", dest="mlx_dir", type=Path, required=True)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--model-id", type=str, default="warden-s1-752m-mlx-q4")
    parser.add_argument("--max-tokens", type=int, default=131072)
    parser.add_argument("--ram-slots", type=int, default=12)
    parser.add_argument("--page-dir", type=Path, default=None)
    parser.add_argument("--log-jsonl", type=Path, default=None)
    parser.add_argument("--state-file", type=Path, default=None)
    parser.add_argument("--idle-shutdown-sec", type=int, default=1800)
    parser.add_argument("--token", type=str, default="")
    parser.add_argument("--instance-id", type=str, default="")
    args = parser.parse_args()

    instance_id = args.instance_id or uuid.uuid4().hex
    token = args.token or uuid.uuid4().hex + uuid.uuid4().hex
    page_dir = args.page_dir or (args.state_file.parent / "pages" if args.state_file else Path.home() / ".cache" / "pi-warden" / "pages")

    engine = WardenS1ServerEngine(
        mlx_dir=args.mlx_dir,
        model_id=args.model_id,
        instance_id=instance_id,
        idle_shutdown_sec=args.idle_shutdown_sec,
        max_tokens=args.max_tokens,
        log_jsonl=args.log_jsonl,
        ram_slots=args.ram_slots,
        page_dir=page_dir,
    )

    stop_event = threading.Event()
    server: ThreadingHTTPServer | None = None

    def trigger_shutdown() -> None:
        if stop_event.is_set():
            return
        stop_event.set()
        if server is not None:
            server.shutdown()

    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine, token, trigger_shutdown))
    bound_host, bound_port = server.server_address

    def _handle_sig(_signum: int, _frame: Any) -> None:
        threading.Thread(target=trigger_shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_sig)
    signal.signal(signal.SIGINT, _handle_sig)

    if args.idle_shutdown_sec > 0:
        def _idle_watchdog() -> None:
            poll = min(1.0, max(0.1, args.idle_shutdown_sec / 4.0))
            while not stop_event.wait(poll):
                if engine.idle_seconds() >= args.idle_shutdown_sec:
                    trigger_shutdown()
                    return
        threading.Thread(target=_idle_watchdog, daemon=True).start()

    metadata = {
        "pid": os.getpid(),
        "instanceId": instance_id,
        "host": bound_host,
        "port": bound_port,
        "runtime": "mlx",
        "modelId": args.model_id,
        "modelDir": str(args.mlx_dir.resolve()),
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "idleShutdownSec": args.idle_shutdown_sec,
        "token": token,
    }
    pid_file: Path | None = (args.state_file.parent / "pids" / f"{os.getpid()}.json") if args.state_file is not None else None
    if args.state_file is not None:
        _write_state_file_atomic(args.state_file, metadata)
        if pid_file is not None:
            _write_state_file_atomic(
                pid_file,
                {
                    "pid": os.getpid(),
                    "instanceId": instance_id,
                    "startedAt": metadata["startedAt"],
                    "runtime": "mlx",
                },
            )
    print(json.dumps({"ready": True, "url": f"http://{bound_host}:{bound_port}", **metadata}), flush=True)

    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        stop_event.set()
        server.server_close()
        engine.stop()
        _remove_state_file_if_owned(args.state_file, instance_id)
        _remove_state_file_if_owned(pid_file, instance_id)


if __name__ == "__main__":
    main()
`;

export const WARDEN_S1_MLX_DAEMON_PY: string = `${MLX_PY_PART_1}${MLX_PY_PART_2}${MLX_PY_PART_3}`;

export function mlxDaemonScriptSha256(): string {
  return createHash("sha256").update(WARDEN_S1_MLX_DAEMON_PY, "utf8").digest("hex");
}

export function materializeMlxDaemonScript(runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const scriptPath = join(runtimeDir, WARDEN_S1_MLX_SCRIPT_NAME);
  const expectedHash = mlxDaemonScriptSha256();
  if (existsSync(scriptPath)) {
    try {
      const existing = readFileSync(scriptPath, "utf8");
      const actualHash = createHash("sha256").update(existing, "utf8").digest("hex");
      if (actualHash === expectedHash) return scriptPath;
    } catch {
      // Fall through and rewrite atomically if unreadable.
    }
  }
  writeFileAtomicSync(scriptPath, WARDEN_S1_MLX_DAEMON_PY);
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

