import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  daemonDropSession,
  daemonEvaluate,
  daemonEvictToDisk,
  daemonLockPath,
  daemonMetadataPath,
  daemonPagesPath,
  daemonPidFilePath,
  daemonPidsDir,
  daemonPrewarm,
  daemonSalience,
  daemonStats,
  effectiveWardenS1TimeoutMs,
  ensureWardenS1Daemon,
  getWardenS1DaemonStatus,
  isPidAlive,
  stopWardenS1Daemon,
  sweepOrphanDaemonPids,
} from "../src/warden-s1-daemon.js";
import { materializeMlxDaemonScript, WARDEN_S1_MLX_DAEMON_PY } from "../src/warden-s1-mlx-worker.js";
import {
  createByteLevelFallbackTokenizer,
  createSyntheticOnnxBackend,
  resolveOnnxThreads,
  startOnnxWorkerServer,
  WardenS1OnnxBackend,
  WardenS1OnnxEngine,
} from "../src/warden-s1-onnx-worker.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return predicate();
}

test("2-token BPE boundary healing recovers from newline merge with <1e-6 5-head parity", async () => {
  const pageDir = makeTempDir("ws1-bpe-");
  try {
    // Include 'Ċ Ċ' ('\n' + '\n' -> '\n\n') merge plus word merges matching Qwen byte-level BPE.
    const tokenizer = createByteLevelFallbackTokenizer(["Ċ Ċ", "# #", "d o", "do n", "don e", "N e", "Ne x", "Nex t"]);
    const turn1 = "## Turn 1\nVerify invariants done.\n";
    const turn2 = `${turn1}\n## Next\nRun final check.`;

    const ids1 = tokenizer.encode(turn1);
    const ids2 = tokenizer.encode(turn2);
    assert.ok(ids1.length > 4, "turn1 should have enough tokens for boundary checkpoint");
    assert.notEqual(
      ids2[ids1.length - 1],
      ids1[ids1.length - 1],
      "trailing '\\n' must merge with leading '\\n' into '\\n\\n' token",
    );
    assert.deepEqual(ids2.slice(0, ids1.length - 2), ids1.slice(0, ids1.length - 2));

    const questions = {
      ok: { type: "noul", instructions: "Were invariants verified?" },
      route: { type: "choice", instructions: "Pick phase", criteria: { check: "Verification", edit: "Editing", done: "Done" } },
      risk: { type: "score", instructions: "Rate risk", criteria: ["low", "medium", "high"] },
      where: { type: "locus", instructions: "Which section changed?" },
    };

    const incEngine = new WardenS1OnnxEngine({
      backend: createSyntheticOnnxBackend({ tokenizer }),
      modelId: "warden-s1-test",
      modelDir: "mock-weights",
      pageDir,
    });

    const r1 = await incEngine.evaluate({ state: turn1, questions }, "sess-bpe");
    assert.equal(r1.response.s1.cache_mode, "miss");
    assert.equal(r1.response.s1.boundary_healed, false);

    const r2 = await incEngine.evaluate({ state: turn2, questions }, "sess-bpe");
    assert.equal(r2.response.s1.cache_mode, "delta");
    assert.equal(r2.response.s1.boundary_healed, true);
    assert.equal(r2.response.s1.prefix_reuse_tokens, ids1.length - 2);
    assert.equal(incEngine.cacheMisses, 1, "turn2 must not incur a cold cache miss");
    assert.equal(incEngine.cacheBoundaryHealedHits, 1);

    const coldEngine = new WardenS1OnnxEngine({
      backend: createSyntheticOnnxBackend({ tokenizer }),
      modelId: "warden-s1-test",
      modelDir: "mock-weights",
      pageDir,
    });
    const rCold = await coldEngine.evaluate({ state: turn2, questions }, "sess-cold");
    assert.equal(rCold.response.s1.cache_mode, "miss");

    const noulInc = (r2.response.answers.ok as { noul: number }).noul;
    const noulCold = (rCold.response.answers.ok as { noul: number }).noul;
    assert.ok(Math.abs(noulInc - noulCold) < 1e-6, `noul parity diff=${Math.abs(noulInc - noulCold)}`);

    const choiceInc = (r2.response.answers.route as { probabilities: Record<string, number> }).probabilities;
    const choiceCold = (rCold.response.answers.route as { probabilities: Record<string, number> }).probabilities;
    for (const k of ["check", "edit", "done"]) {
      assert.ok(Math.abs(choiceInc[k]! - choiceCold[k]!) < 1e-6, `choice[${k}] diff`);
    }

    const scoreInc = (r2.response.answers.risk as { score: number }).score;
    const scoreCold = (rCold.response.answers.risk as { score: number }).score;
    assert.ok(Math.abs(scoreInc - scoreCold) < 1e-6, `score diff=${Math.abs(scoreInc - scoreCold)}`);

    assert.equal(r2.response.s1.salience.length, rCold.response.s1.salience.length);
    for (let i = 0; i < r2.response.s1.salience.length; i++) {
      assert.ok(
        Math.abs(r2.response.s1.salience[i]! - rCold.response.s1.salience[i]!) < 1e-6,
        `salience[${i}] diff`,
      );
    }

    assert.equal(r2.response.s1.locus.chunk_probs.length, rCold.response.s1.locus.chunk_probs.length);
    for (let i = 0; i < r2.response.s1.locus.chunk_probs.length; i++) {
      assert.ok(
        Math.abs(r2.response.s1.locus.chunk_probs[i]! - rCold.response.s1.locus.chunk_probs[i]!) < 1e-6,
        `locus[${i}] diff`,
      );
    }
  } finally {
    rmSync(pageDir, { recursive: true, force: true });
  }
});

test("12 multiplexed sessions exercise L1/L2/L3 zstd paging, 5 heads, recheckpoint, auth, and priority queue", async () => {
  const stateDir = makeTempDir("ws1-mpx-");
  const pageDir = join(stateDir, "pages");
  const handle = await startOnnxWorkerServer({
    mockWeights: true,
    ramSlots: 4,
    pageDir,
    idleShutdownSec: 0,
    token: "test-secret-token",
  });

  try {
    // Verify Bearer auth rejects missing/wrong tokens.
    const unauth = await fetch(`${handle.url}/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(unauth.status, 401);
    const badAuth = await fetch(`${handle.url}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(badAuth.status, 401);

    const endpoint = {
      pid: process.pid,
      instanceId: handle.instanceId,
      host: handle.host,
      port: handle.port,
      runtime: "onnx" as const,
      modelId: handle.engine.modelId,
      modelDir: handle.engine.modelDir,
      startedAt: new Date().toISOString(),
      idleShutdownSec: 0,
      token: handle.token,
      url: handle.url,
      stateDir,
    };

    const questions = {
      safe: { type: "noul", instructions: "Is this session safe?" },
      kind: { type: "choice", instructions: "Classify", criteria: { code: "Code", docs: "Docs" } },
      severity: { type: "score", instructions: "Severity", criteria: ["none", "low", "high"] },
    };

    // Turn 1 across 12 sessions overflows ramSlots=4 into L3 zstd disk pages.
    for (let i = 0; i < 12; i++) {
      const sid = `session-${String(i).padStart(2, "0")}`;
      const state = `<turn index="0" role="user">Session ${i} initial task details.\n</turn>\n`;
      const res = await daemonEvaluate(endpoint, { state, questions }, { sessionId: sid });
      assert.equal(res.s1.session_id, sid);
      assert.equal(res.s1.cache_mode, "miss");
      assert.ok(typeof (res.answers.safe as { noul: number }).noul === "number");
      assert.ok(typeof (res.answers.kind as { choice: string }).choice === "string");
      assert.ok(typeof (res.answers.severity as { score: number }).score === "number");
      assert.equal(res.s1.salience.length, 1);
      assert.equal(res.s1.locus.chunk_probs.length, 1);
      assert.equal(typeof res.s1.abstentions.safe, "boolean");
    }

    const diskFiles = readdirSync(pageDir).filter((f) => f.endsWith(".ws1page"));
    assert.ok(diskFiles.length >= 7, `expected >=7 L3 zstd disk pages, got ${diskFiles.length}`);
    // Verify genuine Zstandard frame magic bytes (0x28 0xB5 0x2F 0xFD).
    const firstBytes = readFileSync(join(pageDir, diskFiles[0]!)).subarray(0, 4);
    assert.deepEqual([...firstBytes], [0x28, 0xb5, 0x2f, 0xfd], "L3 disk page must be zstd compressed");

    // Wake session-00 from L3 disk with a BPE newline-merge append.
    const s0Turn2 = `<turn index="0" role="user">Session 0 initial task details.\n</turn>\n\n<turn index="1" role="assistant">Done verifying.</turn>`;
    const wake = await daemonEvaluate(endpoint, { state: s0Turn2, questions }, { sessionId: "session-00" });
    assert.equal(wake.s1.page_tier, "L3_DISK");
    assert.equal(wake.s1.cache_mode, "delta");
    assert.equal(wake.s1.boundary_healed, true);
    assert.equal(wake.s1.chunks.length, 2);
    assert.equal(wake.s1.salience.length, 2);
    assert.equal(wake.s1.locus.chunk_probs.length, 2);

    // Repeat exact state on active L1 session-00 -> L1 exact hit.
    const l1Hit = await daemonEvaluate(endpoint, { state: s0Turn2, questions }, { sessionId: "session-00" });
    assert.equal(l1Hit.s1.page_tier, "L1");
    assert.equal(l1Hit.s1.cache_mode, "exact");

    // Cache-only /v1/salience reads cached chunk_reprs without re-encoding state.
    const salOnly = await daemonSalience(endpoint, { session_id: "session-00" });
    assert.equal(salOnly.ok, true);
    assert.equal(salOnly.salience.length, 2);

    // /v1/prewarm with recheckpoint: true cleanly replaces compacted prefix.
    const compacted = `<turn index="0" role="user">Compacted summary for session 0.</turn>`;
    const prewarmed = await daemonPrewarm(endpoint, { state: compacted, recheckpoint: true }, { sessionId: "session-00" });
    assert.equal(prewarmed.ok, true);
    assert.equal(prewarmed.recheckpointed, true);
    assert.equal(prewarmed.cache_mode, "miss");

    // Explicit eviction & session drop admin RPCs.
    const ev = await daemonEvictToDisk(endpoint, null);
    assert.ok(ev.disk_pages >= 8);
    const dropped = await daemonDropSession(endpoint, "session-00");
    assert.equal(dropped.dropped, true);

    const st = await daemonStats(endpoint);
    assert.equal(st.zstd_enabled, true);
    assert.ok(st.l3_disk_swaps >= 1);
    assert.ok(st.l1_hits >= 1);
    assert.ok(st.cache_boundary_healed_hits >= 1);
  } finally {
    await handle.close();
    rmSync(stateDir, { recursive: true, force: true });
  }

  // Priority queue check: foreground /v1/systemone jumps ahead of queued /v1/prewarm items.
  const prioDir = makeTempDir("ws1-prio-");
  const prioServer = await startOnnxWorkerServer({
    mockWeights: true,
    stepDelayMs: 25,
    pageDir: join(prioDir, "pages"),
    idleShutdownSec: 0,
    token: "prio-token",
  });
  try {
    const ep = {
      pid: process.pid,
      instanceId: prioServer.instanceId,
      host: prioServer.host,
      port: prioServer.port,
      runtime: "onnx" as const,
      modelId: prioServer.engine.modelId,
      modelDir: prioServer.engine.modelDir,
      startedAt: new Date().toISOString(),
      idleShutdownSec: 0,
      token: prioServer.token,
      url: prioServer.url,
      stateDir: prioDir,
    };
    const order: string[] = [];
    // First prewarm occupies the single worker slot while subsequent items queue behind it.
    const p0 = daemonPrewarm(ep, { state: "## A\nfirst" }, { sessionId: "p0" }).then(() => order.push("prewarm-0"));
    const p1 = daemonPrewarm(ep, { state: "## B\nsecond" }, { sessionId: "p1" }).then(() => order.push("prewarm-1"));
    const p2 = daemonPrewarm(ep, { state: "## C\nthird" }, { sessionId: "p2" }).then(() => order.push("prewarm-2"));
    const fg = daemonEvaluate(
      ep,
      { state: "## FG\nurgent", questions: { ok: { type: "noul", instructions: "Urgent check?" } } },
      { sessionId: "fg" },
    ).then(() => order.push("systemone"));
    await Promise.all([p0, p1, p2, fg]);
    const fgIdx = order.indexOf("systemone");
    const lastPrewarmIdx = order.lastIndexOf("prewarm-2");
    assert.ok(fgIdx >= 0 && fgIdx < lastPrewarmIdx, `expected systemone ahead of queued prewarm, got order=${order.join(",")}`);
  } finally {
    await prioServer.close();
    rmSync(prioDir, { recursive: true, force: true });
  }
});

test("10 concurrent ensureWardenS1Daemon callers spawn exactly 1 singleton daemon and recover stale locks", async () => {
  const stateDir = makeTempDir("ws1-lock-");
  try {
    const endpoints = await Promise.all(
      Array.from({ length: 10 }, () =>
        ensureWardenS1Daemon({
          runtime: "onnx",
          mockWeights: true,
          stateDir,
          idleShutdownSec: 60,
          startupTimeoutMs: 15_000,
          lockTimeoutMs: 20_000,
        }),
      ),
    );

    const pids = new Set(endpoints.map((e) => e.pid));
    const instanceIds = new Set(endpoints.map((e) => e.instanceId));
    const ports = new Set(endpoints.map((e) => e.port));
    assert.equal(pids.size, 1, `expected 1 daemon pid across 10 callers, got ${[...pids].join(",")}`);
    assert.equal(instanceIds.size, 1);
    assert.equal(ports.size, 1);

    const ep = endpoints[0]!;
    assert.equal(isPidAlive(ep.pid), true);
    const metaMode = statSync(daemonMetadataPath(stateDir)).mode & 0o777;
    assert.equal(metaMode, 0o600, "warden-s1-daemon.json must be owner-only 0600");

    const status = await getWardenS1DaemonStatus(stateDir);
    assert.equal(status.running, true);
    assert.equal(status.endpoint?.pid, ep.pid);

    const evalRes = await daemonEvaluate(
      ep,
      {
        state: "## Turn 0\nSingleton daemon check.",
        questions: { ok: { type: "noul", instructions: "Healthy?" } },
      },
      { sessionId: "singleton-check" },
    );
    assert.equal(evalRes.s1.runtime, "onnx");

    const stopRes = await stopWardenS1Daemon(stateDir, 5000);
    assert.equal(stopRes.stopped, true);
    assert.equal(isPidAlive(ep.pid), false);
    assert.equal(existsSync(daemonMetadataPath(stateDir)), false);

    // Plant a stale lock owned by a dead PID and verify automatic recovery.
    const lockDir = daemonLockPath(stateDir);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 999999, holderId: "stale-holder", acquiredAt: Date.now() - 5000 }));
    const recovered = await ensureWardenS1Daemon({
      runtime: "onnx",
      mockWeights: true,
      stateDir,
      idleShutdownSec: 60,
      startupTimeoutMs: 15_000,
    });
    assert.equal(isPidAlive(recovered.pid), true);
  } finally {
    await stopWardenS1Daemon(stateDir, 5000).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("daemon auto-exits after idleShutdownSec and removes metadata file", async () => {
  const stateDir = makeTempDir("ws1-idle-");
  try {
    const ep = await ensureWardenS1Daemon({
      runtime: "onnx",
      mockWeights: true,
      stateDir,
      idleShutdownSec: 1,
      startupTimeoutMs: 15_000,
    });
    assert.equal(isPidAlive(ep.pid), true);
    await daemonEvaluate(
      ep,
      { state: "## Turn 0\nOne quick probe.", questions: { ok: { type: "noul", instructions: "Alive?" } } },
      { sessionId: "idle-test" },
    );

    const exited = await waitUntil(() => !isPidAlive(ep.pid) && !existsSync(daemonMetadataPath(stateDir)), 6000, 100);
    assert.equal(exited, true, `expected daemon pid=${ep.pid} to auto-exit after 1s idle`);
  } finally {
    await stopWardenS1Daemon(stateDir, 3000).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("MLX worker materializes atomically and passes python3 -m py_compile", () => {
  const runtimeDir = makeTempDir("ws1-mlx-");
  try {
    const p1 = materializeMlxDaemonScript(runtimeDir);
    assert.equal(existsSync(p1), true);
    const mtime1 = statSync(p1).mtimeMs;
    const p2 = materializeMlxDaemonScript(runtimeDir);
    assert.equal(p2, p1);
    assert.equal(statSync(p2).mtimeMs, mtime1, "second materialization with identical hash must be a no-op");

    for (const needle of [
      "mx.set_cache_limit(1024 * 1024 * 1024)",
      "requantize_kv_cache_list",
      "PriorityQueue",
      "boundary_healed",
      "ephemeral_last_chunk",
      "purge_disk_pages",
      "/v1/prewarm",
      "/v1/salience",
      "idle_shutdown_sec",
    ]) {
      assert.ok(WARDEN_S1_MLX_DAEMON_PY.includes(needle), `MLX script missing ${needle}`);
    }

    execFileSync("python3", ["-m", "py_compile", p1], { timeout: 5000, stdio: "pipe" });
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("fork-on-candidate (ephemeral_last_chunk) preserves warm prefix across 6 candidates and next-turn append with 0 cold misses and <1e-6 5-head parity", async () => {
  const pageDir = makeTempDir("ws1-fork-");
  try {
    const tokenizer = createByteLevelFallbackTokenizer(["Ċ Ċ", "# #", "< /", "t u", "tu r", "tur n"]);
    const turn0 = `<turn index="0" role="user" pinned="true">\nGoal: tidy the workspace.\n</turn>`;
    const turn1 = `<turn index="1" role="tool" tool="read">\nRead README.md successfully.\n</turn>`;
    const prefix0 = turn0;
    const prefix1 = `${turn0}\n\n${turn1}`;

    const questions = {
      risk: { type: "noul", instructions: "Is this action irreversible?" },
      route: { type: "choice", instructions: "Pick guard", criteria: { action: "Action", rules: "Rules", done: "Done" } },
      severity: { type: "score", instructions: "Rate severity", criteria: ["none", "low", "high"] },
      where: { type: "locus", instructions: "Which turn explains this?" },
    };

    const incEngine = new WardenS1OnnxEngine({
      backend: createSyntheticOnnxBackend({ tokenizer }),
      modelId: "warden-s1-test",
      modelDir: "mock-weights",
      pageDir,
    });

    const w0 = await incEngine.prewarm(
      { state: prefix0, chunks: [{ index: 0, label: "Turn 0", char_start: 0, char_end: prefix0.length }] },
      "sess-fork",
    );
    assert.equal(w0.cache_mode, "miss");
    assert.equal(incEngine.cacheMisses, 1);

    const candidates = [
      "action: bash touch notes.txt",
      "rules: write src/app.ts",
      "action: bash npm test",
      "output: read README.md",
      "rules: edit src/index.ts",
      "done: verified all checks pass",
    ];
    let lastForkedResp: Awaited<ReturnType<typeof incEngine.evaluate>>["response"] | undefined;
    let lastState = "";
    let lastChunks: Array<{ index: number; label: string; char_start: number; char_end: number }> = [];

    for (let i = 0; i < candidates.length; i++) {
      const candBlock = `<turn index="current" role="candidate">\n${candidates[i]}\n</turn>`;
      const composed = `${prefix0}\n\n${candBlock}`;
      const chunks = [
        { index: 0, label: "Turn 0", char_start: 0, char_end: prefix0.length },
        { index: 1, label: "Current candidate", char_start: prefix0.length + 2, char_end: composed.length },
      ];
      const res = await incEngine.evaluate(
        { state: composed, chunks, questions, ephemeral_last_chunk: true },
        "sess-fork",
      );
      assert.equal(res.response.s1.cache_mode, "delta", `candidate #${i + 1} must hit warm prefix`);
      assert.equal(res.response.s1.prefix_reuse_tokens, w0.state_tokens, `candidate #${i + 1} must reuse entire Turn 0 prefix`);
      assert.equal(incEngine.cacheMisses, 1, `candidate #${i + 1} must incur 0 cold misses after Turn 0`);
      lastForkedResp = res.response;
      lastState = composed;
      lastChunks = chunks;
    }

    // Verify < 1e-6 5-head parity of forked candidate evaluation vs cold full-sequence evaluation.
    const coldEngine = new WardenS1OnnxEngine({
      backend: createSyntheticOnnxBackend({ tokenizer }),
      modelId: "warden-s1-test",
      modelDir: "mock-weights",
      pageDir,
    });
    const rCold = await coldEngine.evaluate({ state: lastState, chunks: lastChunks, questions }, "sess-cold-fork");
    assert.equal(rCold.response.s1.cache_mode, "miss");
    assert.ok(
      Math.abs((lastForkedResp!.answers.risk as { noul: number }).noul - (rCold.response.answers.risk as { noul: number }).noul) < 1e-6,
      "noul parity",
    );
    const cFork = (lastForkedResp!.answers.route as { probabilities: Record<string, number> }).probabilities;
    const cCold = (rCold.response.answers.route as { probabilities: Record<string, number> }).probabilities;
    for (const k of ["action", "rules", "done"]) {
      assert.ok(Math.abs(cFork[k]! - cCold[k]!) < 1e-6, `choice[${k}] parity`);
    }
    assert.ok(
      Math.abs((lastForkedResp!.answers.severity as { score: number }).score - (rCold.response.answers.severity as { score: number }).score) < 1e-6,
      "score parity",
    );
    for (let i = 0; i < rCold.response.s1.salience.length; i++) {
      assert.ok(Math.abs(lastForkedResp!.s1.salience[i]! - rCold.response.s1.salience[i]!) < 1e-6, `salience[${i}] parity`);
    }
    for (let i = 0; i < rCold.response.s1.locus.chunk_probs.length; i++) {
      assert.ok(Math.abs(lastForkedResp!.s1.locus.chunk_probs[i]! - rCold.response.s1.locus.chunk_probs[i]!) < 1e-6, `locus[${i}] parity`);
    }

    // Next-turn append + candidate evaluation still reuses Turn 0 with 0 cold misses.
    const cand7 = `<turn index="current" role="candidate">\naction: git status\n</turn>`;
    const composedNext = `${prefix1}\n\n${cand7}`;
    const chunksNext = [
      { index: 0, label: "Turn 0", char_start: 0, char_end: turn0.length },
      { index: 1, label: "Turn 1", char_start: turn0.length + 2, char_end: prefix1.length },
      { index: 2, label: "Current candidate", char_start: prefix1.length + 2, char_end: composedNext.length },
    ];
    const rNext = await incEngine.evaluate(
      { state: composedNext, chunks: chunksNext, questions, ephemeral_last_chunk: true },
      "sess-fork",
    );
    assert.equal(rNext.response.s1.cache_mode, "delta");
    assert.equal(incEngine.cacheMisses, 1, "next-turn append after 6 forked evaluates must incur 0 cold misses");
    // Prewarm on prefix1 after evaluate hits exact 0-token cache because evaluate committed activeRecord at prefix1.
    const w1 = await incEngine.prewarm(
      {
        state: prefix1,
        chunks: [
          { index: 0, label: "Turn 0", char_start: 0, char_end: turn0.length },
          { index: 1, label: "Turn 1", char_start: turn0.length + 2, char_end: prefix1.length },
        ],
      },
      "sess-fork",
    );
    assert.equal(w1.cache_mode, "exact");
    assert.equal(w1.delta_tokens, 0);
    assert.equal(incEngine.cacheMisses, 1);
  } finally {
    rmSync(pageDir, { recursive: true, force: true });
  }
});

test("session page cleanup removes .ws1page files on fresh startup, server close, and stopWardenS1Daemon", async () => {
  const stateDir = makeTempDir("ws1-page-clean-");
  const pagesDir = daemonPagesPath(stateDir);
  try {
    // Plant a stale .ws1page from a prior crashed daemon and verify fresh startup purges it.
    mkdirSync(pagesDir, { recursive: true, mode: 0o700 });
    const stalePage = join(pagesDir, "stale-crash-artifact.ws1page");
    writeFileSync(stalePage, Buffer.from("stale-page-data"));
    assert.equal(existsSync(stalePage), true);

    const srv = await startOnnxWorkerServer({
      mockWeights: true,
      ramSlots: 1,
      pageDir: pagesDir,
      idleShutdownSec: 0,
      token: "clean-token",
    });
    assert.equal(existsSync(stalePage), false, "fresh worker startup must purge stale .ws1page files");

    const ep = {
      pid: process.pid,
      instanceId: srv.instanceId,
      host: srv.host,
      port: srv.port,
      runtime: "onnx" as const,
      modelId: srv.engine.modelId,
      modelDir: srv.engine.modelDir,
      startedAt: new Date().toISOString(),
      idleShutdownSec: 0,
      token: srv.token,
      url: srv.url,
      stateDir,
    };
    const q = { ok: { type: "noul", instructions: "Healthy?" } };
    for (let i = 0; i < 4; i++) {
      await daemonEvaluate(ep, { state: `<turn index="0">Session ${i}</turn>`, questions: q }, { sessionId: `p-${i}` });
    }
    assert.ok(readdirSync(pagesDir).filter((f) => f.endsWith(".ws1page")).length >= 2, "must have spilled pages to disk");

    await srv.close();
    assert.deepEqual(
      existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith(".ws1page")) : [],
      [],
      "worker close() must delete all .ws1page files",
    );

    // Spawn real daemon subprocess, spill pages to disk, and verify stopWardenS1Daemon removes pagesDir completely.
    const daemonEp = await ensureWardenS1Daemon({
      runtime: "onnx",
      mockWeights: true,
      stateDir,
      ramSlots: 1,
      idleShutdownSec: 60,
      startupTimeoutMs: 15_000,
    });
    for (let i = 0; i < 4; i++) {
      await daemonEvaluate(daemonEp, { state: `<turn index="0">Subprocess session ${i}</turn>`, questions: q }, { sessionId: `sp-${i}` });
    }
    assert.ok(readdirSync(pagesDir).filter((f) => f.endsWith(".ws1page")).length >= 2, "subprocess daemon must spill pages");

    const stopped = await stopWardenS1Daemon(stateDir, 5000);
    assert.equal(stopped.stopped, true);
    assert.equal(existsSync(pagesDir), false, "stopWardenS1Daemon must remove <stateDir>/pages");
  } finally {
    await stopWardenS1Daemon(stateDir, 5000).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("WardenS1OnnxBackend.loadFromLocalDir disables ORT CPU memory arena and mem-pattern, and ensureWardenS1Daemon sets ORT_DISABLE_TELEMETRY=1", async () => {
  const dir = makeTempDir("ws1-ort-opts-");
  try {
    const modelDir = join(dir, "model");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(
      join(modelDir, "onnx_manifest.json"),
      JSON.stringify({
        architecture: { hidden_size: 1024 },
        models: {
          embed: { onnx: "embed.onnx" },
          backbone: { onnx: "backbone.onnx", outputs: ["hidden"] },
          heads: { onnx: "heads.onnx" },
        },
        auxiliary: { tokenizer: "tokenizer.json" },
      }),
    );
    writeFileSync(join(modelDir, "tokenizer.json"), JSON.stringify({ model: { vocab: { a: 0 }, merges: [] } }));

    const recordPath = join(dir, "ort-calls.json");
    const stubOrtPath = join(dir, "stub-ort.mjs");
    writeFileSync(
      stubOrtPath,
      [
        `import { writeFileSync } from "node:fs";`,
        `const calls = [];`,
        `export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }`,
        `export const InferenceSession = {`,
        `  async create(modelPath, options) {`,
        `    calls.push({ modelPath, options });`,
        `    writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(calls));`,
        `    return { async run() { return {}; } };`,
        `  },`,
        `};`,
      ].join("\n"),
    );

    await WardenS1OnnxBackend.loadFromLocalDir({ modelDir, ortPath: stubOrtPath });
    const recorded = JSON.parse(readFileSync(recordPath, "utf8")) as Array<{
      modelPath: string;
      options: Record<string, unknown>;
    }>;
    assert.equal(recorded.length, 3, "embed, backbone, and heads sessions must all be created");
    for (const call of recorded) {
      assert.equal(call.options.enableCpuMemArena, false, `${call.modelPath}: enableCpuMemArena must be false`);
      assert.equal(call.options.enableMemPattern, false, `${call.modelPath}: enableMemPattern must be false`);
      assert.equal(call.options.graphOptimizationLevel, "all");
      assert.equal(call.options.intraOpNumThreads, resolveOnnxThreads());
      assert.equal(call.options.interOpNumThreads, 1);
      assert.equal(call.options.executionMode, "sequential");
      assert.deepEqual(call.options.executionProviders, ["cpu"]);
    }

    // Verify ensureWardenS1Daemon passes ORT_DISABLE_TELEMETRY=1 to the spawned daemon process.
    const stateDir = join(dir, "daemon-state");
    const probeBin = join(dir, "probe-env.sh");
    writeFileSync(probeBin, '#!/bin/sh\necho "ORT_DISABLE_TELEMETRY=${ORT_DISABLE_TELEMETRY:-unset}" >&2\nexit 1\n');
    chmodSync(probeBin, 0o755);
    await assert.rejects(
      ensureWardenS1Daemon({
        runtime: "mlx",
        modelDir,
        stateDir,
        pythonBin: probeBin,
        startupTimeoutMs: 5000,
      }),
      /ORT_DISABLE_TELEMETRY=1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WardenS1OnnxBackend requests only hidden_states on non-mutating probes and disposes transient tensors without disposing active state", async () => {
  const pageDir = makeTempDir("ws1-dispose-");
  try {
    const base = createSyntheticOnnxBackend();
    const seenFetches: Array<readonly string[] | undefined> = [];
    const disposed = new WeakSet<object>();
    let disposedCount = 0;

    const wrapTensor = <T extends object>(t: T): T => {
      const target = t as T & { dispose?: () => void };
      if (!target.dispose) {
        target.dispose = () => {
          if (!disposed.has(target)) {
            disposed.add(target);
            disposedCount += 1;
          }
        };
      }
      return target;
    };

    const wrappedBackbone = {
      async run(feeds: Record<string, Parameters<typeof base.backboneSession.run>[0][string]>, fetches?: readonly string[]) {
        for (const [k, v] of Object.entries(feeds)) {
          assert.equal(disposed.has(v), false, `feed tensor ${k} must not be disposed before run`);
        }
        seenFetches.push(fetches);
        const out = await base.backboneSession.run(feeds, fetches);
        for (const v of Object.values(out)) wrapTensor(v);
        return out;
      },
    };
    const wrappedEmbed = {
      async run(feeds: Record<string, Parameters<typeof base.embedSession.run>[0][string]>) {
        const out = await base.embedSession.run(feeds);
        for (const v of Object.values(out)) wrapTensor(v);
        return out;
      },
    };
    const wrappedHeads = {
      async run(feeds: Record<string, Parameters<typeof base.headsSession.run>[0][string]>) {
        const out = await base.headsSession.run(feeds);
        for (const v of Object.values(out)) wrapTensor(v);
        return out;
      },
    };

    const backend = new WardenS1OnnxBackend({
      ort: base.ort,
      manifest: base.manifest,
      tokenizer: base.tokenizer,
      embedSession: wrappedEmbed,
      backboneSession: wrappedBackbone,
      headsSession: wrappedHeads,
    });
    const engine = new WardenS1OnnxEngine({
      backend,
      modelId: "warden-s1-dispose-test",
      modelDir: "mock-weights",
      pageDir,
    });

    const questions = {
      safe: { type: "noul", instructions: "Is this action safe?" },
      kind: { type: "choice", instructions: "Pick kind", criteria: { a: "Alpha", b: "Beta" } },
    };
    const t0 = `<turn index="0" role="user">Initial goal for disposal verification.</turn>`;
    await engine.prewarm({ state: t0 }, "s-disp");
    const r1 = await engine.evaluate(
      {
        state: `${t0}\n\n<turn index="current" role="candidate">bash: ls</turn>`,
        questions,
        ephemeral_last_chunk: true,
      },
      "s-disp",
    );
    assert.equal(r1.response.s1.cache_mode, "delta");
    const r2 = await engine.evaluate(
      {
        state: `${t0}\n\n<turn index="1" role="tool">read ok</turn>\n\n<turn index="current" role="candidate">bash: pwd</turn>`,
        questions,
        ephemeral_last_chunk: true,
      },
      "s-disp",
    );
    assert.equal(r2.response.s1.cache_mode, "delta");

    assert.ok(
      seenFetches.some(f => Array.isArray(f) && f.length === 1 && f[0] === "hidden_states"),
      "non-mutating probe steps must pass ['hidden_states'] fetches to backboneSession.run",
    );
    assert.ok(disposedCount > 20, `expected transient tensors to be disposed, got ${disposedCount}`);
    engine.close();
  } finally {
    rmSync(pageDir, { recursive: true, force: true });
  }
});

test("ensureWardenS1Daemon rejects a missing modelDir before acquiring the lock or stopping a live daemon", async () => {
  const stateDir = makeTempDir("ws1-missing-modeldir-");
  try {
    const live = await ensureWardenS1Daemon({
      runtime: "onnx",
      mockWeights: true,
      stateDir,
      idleShutdownSec: 60,
      startupTimeoutMs: 15_000,
      lockTimeoutMs: 15_000,
    });
    assert.equal(isPidAlive(live.pid), true);
    assert.equal((await getWardenS1DaemonStatus(stateDir)).running, true);

    const missingDir = join(stateDir, "deleted-onnx-model-dir");
    await assert.rejects(
      ensureWardenS1Daemon({
        runtime: "onnx",
        modelDir: missingDir,
        stateDir,
        startupTimeoutMs: 5_000,
        lockTimeoutMs: 5_000,
      }),
      /modelDir does not exist/,
    );

    assert.equal(isPidAlive(live.pid), true, "missing modelDir must not kill an already-running daemon");
    const status = await getWardenS1DaemonStatus(stateDir);
    assert.equal(status.running, true);
    const st = await daemonStats(live);
    assert.equal(st.pid, live.pid);
    assert.equal(st.instance_id, live.instanceId);
  } finally {
    await stopWardenS1Daemon(stateDir);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resolveOnnxThreads caps default threads to [1, 4] and honors explicit and env overrides", () => {
  assert.equal(resolveOnnxThreads(undefined, {}, 1), 1);
  assert.equal(resolveOnnxThreads(undefined, {}, 2), 2);
  assert.equal(resolveOnnxThreads(undefined, {}, 3), 3);
  assert.equal(resolveOnnxThreads(undefined, {}, 4), 2);
  assert.equal(resolveOnnxThreads(undefined, {}, 8), 4);
  assert.equal(resolveOnnxThreads(undefined, {}, 32), 4);
  assert.equal(resolveOnnxThreads(undefined, { PI_WARDEN_ONNX_THREADS: "3" }, 16), 3);
  assert.equal(resolveOnnxThreads(undefined, { PI_WARDEN_ONNX_THREADS: "0" }, 16), 4);
  assert.equal(resolveOnnxThreads(6, { PI_WARDEN_ONNX_THREADS: "2" }, 16), 6);
});

test("effectiveWardenS1TimeoutMs enforces 25000 ms floor only for ONNX when timeoutMs <= 5000", () => {
  assert.equal(effectiveWardenS1TimeoutMs(5000, "onnx"), 25_000);
  assert.equal(effectiveWardenS1TimeoutMs(3000, "onnx"), 25_000);
  assert.equal(effectiveWardenS1TimeoutMs(30_000, "onnx"), 30_000);
  assert.equal(effectiveWardenS1TimeoutMs(5000, "mlx"), 5000);
  assert.equal(effectiveWardenS1TimeoutMs(5000, undefined), 5000);
});

test("WardenS1OnnxBackend auto-probes CUDA on NVIDIA Linux and DirectML on Windows with clean CPU fallback", async () => {
  const dir = makeTempDir("ws1-gpu-probe-");
  try {
    const modelDir = join(dir, "model");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(
      join(modelDir, "onnx_manifest.json"),
      JSON.stringify({
        architecture: { hidden_size: 1024 },
        models: {
          embed: { onnx: "embed.onnx" },
          backbone: { onnx: "backbone.onnx", outputs: ["hidden"] },
          heads: { onnx: "heads.onnx" },
        },
        auxiliary: { tokenizer: "tokenizer.json" },
      }),
    );
    writeFileSync(join(modelDir, "tokenizer.json"), JSON.stringify({ model: { vocab: { a: 0 }, merges: [] } }));

    // 1. Linux with NVIDIA device: CUDA succeeds -> activeExecutionProvider === "cuda".
    const cudaOkStub = join(dir, "ort-cuda-ok.mjs");
    writeFileSync(
      cudaOkStub,
      [
        `export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }`,
        `export const InferenceSession = { async create(_p, opts) { return { opts, async run() { return {}; } }; } };`,
      ].join("\n"),
    );
    const cudaBackend = await WardenS1OnnxBackend.loadFromLocalDir({
      modelDir,
      ortPath: cudaOkStub,
      platform: "linux",
      env: {},
      hasNvidiaDevice: true,
      threads: 2,
    });
    assert.equal(cudaBackend.activeExecutionProvider, "cuda");
    assert.equal(cudaBackend.intraOpNumThreads, 2);
    const engine = new WardenS1OnnxEngine({
      backend: cudaBackend,
      modelId: "warden-s1-test",
      modelDir,
      pageDir: join(dir, "pages"),
    });
    assert.equal(engine.stats().activeExecutionProvider, "cuda");
    assert.equal(engine.stats().intraOpNumThreads, 2);

    // 2. Linux with CUDA_VISIBLE_DEVICES="0" where CUDA EP shared library is missing -> falls back to ["cpu"].
    const fallbackLogPath = join(dir, "fallback-log.json");
    const cudaFailStub = join(dir, "ort-cuda-fail.mjs");
    writeFileSync(
      cudaFailStub,
      [
        `import { writeFileSync } from "node:fs";`,
        `const seen = [];`,
        `export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }`,
        `export const InferenceSession = {`,
        `  async create(_p, opts) {`,
        `    seen.push(opts.executionProviders);`,
        `    writeFileSync(${JSON.stringify(fallbackLogPath)}, JSON.stringify(seen));`,
        `    if (opts.executionProviders.includes("cuda") || opts.executionProviders.includes("dml")) {`,
        `      throw new Error("EP shared library unavailable");`,
        `    }`,
        `    return { async run() { return {}; } };`,
        `  },`,
        `};`,
      ].join("\n"),
    );
    const linuxFallback = await WardenS1OnnxBackend.loadFromLocalDir({
      modelDir,
      ortPath: cudaFailStub,
      platform: "linux",
      env: { CUDA_VISIBLE_DEVICES: "0" },
      hasNvidiaDevice: false,
    });
    assert.equal(linuxFallback.activeExecutionProvider, "cpu");
    const linuxSeen = JSON.parse(readFileSync(fallbackLogPath, "utf8")) as string[][];
    assert.deepEqual(linuxSeen[0], ["cuda", "cpu"]);
    assert.deepEqual(linuxSeen[1], ["cpu"]);

    // 3. Linux with CUDA_VISIBLE_DEVICES="-1" skips CUDA probe completely.
    const linuxDisabled = await WardenS1OnnxBackend.loadFromLocalDir({
      modelDir,
      ortPath: cudaOkStub,
      platform: "linux",
      env: { CUDA_VISIBLE_DEVICES: "-1" },
      hasNvidiaDevice: false,
    });
    assert.equal(linuxDisabled.activeExecutionProvider, "cpu");

    // 4. Windows tries ["dml", "cpu"] and falls back cleanly to ["cpu"].
    const winFallback = await WardenS1OnnxBackend.loadFromLocalDir({
      modelDir,
      ortPath: cudaFailStub,
      platform: "win32",
      env: {},
    });
    assert.equal(winFallback.activeExecutionProvider, "cpu");
    const winSeen = JSON.parse(readFileSync(fallbackLogPath, "utf8")) as string[][];
    assert.ok(winSeen.some((eps) => eps[0] === "dml" && eps[1] === "cpu"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopWardenS1Daemon escalates to SIGKILL on SIGTERM-ignoring worker and reaps orphaned PIDs", async () => {
  const stateDir = makeTempDir("ws1-sigkill-");
  const stubbornScript = [
    `process.on("SIGTERM", () => {});`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  const spawnStubborn = (instanceId: string) =>
    spawn(process.execPath, ["-e", stubbornScript, "--", "--warden-s1-test", "--instance-id", instanceId], {
      detached: true,
      stdio: "ignore",
    });

  let stubbornPid: number | undefined;
  let orphanPid: number | undefined;
  try {
    // 1. Stubborn primary daemon ignoring SIGTERM is terminated via SIGKILL escalation.
    const stubborn = spawnStubborn("stubborn-primary");
    stubbornPid = stubborn.pid!;
    stubborn.unref();
    assert.equal(isPidAlive(stubbornPid), true);
    mkdirSync(daemonPidsDir(stateDir), { recursive: true, mode: 0o700 });
    writeFileSync(
      daemonMetadataPath(stateDir),
      JSON.stringify({
        pid: stubbornPid,
        instanceId: "stubborn-primary",
        host: "127.0.0.1",
        port: 1,
        runtime: "onnx",
        modelId: "warden-s1-test",
        modelDir: "mock-weights",
        startedAt: new Date().toISOString(),
        idleShutdownSec: 60,
        token: "tok",
      }),
    );
    writeFileSync(
      daemonPidFilePath(stateDir, stubbornPid),
      JSON.stringify({ pid: stubbornPid, instanceId: "stubborn-primary", startedAt: new Date().toISOString(), runtime: "onnx" }),
    );

    // 2. Also plant a second stubborn orphan recorded only in <stateDir>/pids/<pid>.json.
    const orphan = spawnStubborn("stubborn-orphan");
    orphanPid = orphan.pid!;
    orphan.unref();
    assert.equal(isPidAlive(orphanPid), true);
    writeFileSync(
      daemonPidFilePath(stateDir, orphanPid),
      JSON.stringify({ pid: orphanPid, instanceId: "stubborn-orphan", startedAt: new Date().toISOString(), runtime: "onnx" }),
    );

    // 3. Plant a PID record pointing at our own non-worker process to prove ownership check never kills unrelated PIDs.
    writeFileSync(
      daemonPidFilePath(stateDir, process.pid),
      JSON.stringify({ pid: process.pid, instanceId: "self-recycled", startedAt: new Date().toISOString(), runtime: "onnx" }),
    );

    const stopRes = await stopWardenS1Daemon(stateDir, 600);
    assert.equal(stopRes.stopped, true);
    assert.equal(isPidAlive(stubbornPid), false, "SIGTERM-ignoring primary daemon must be killed via SIGKILL");
    assert.equal(isPidAlive(orphanPid), false, "orphaned worker in pids/ must be reaped via SIGKILL");
    assert.equal(existsSync(daemonMetadataPath(stateDir)), false);
    assert.equal(existsSync(daemonPidFilePath(stateDir, stubbornPid)), false);
    assert.equal(existsSync(daemonPidFilePath(stateDir, orphanPid)), false);
    assert.equal(existsSync(daemonPidFilePath(stateDir, process.pid)), false, "stale non-warden PID record is unlinked safely");

    // 4. Verify ensureWardenS1Daemon sweeps an orphan recorded in pids/ before spawning a fresh daemon.
    const orphan2 = spawnStubborn("stubborn-orphan-2");
    const orphan2Pid = orphan2.pid!;
    orphan2.unref();
    mkdirSync(daemonPidsDir(stateDir), { recursive: true, mode: 0o700 });
    writeFileSync(
      daemonPidFilePath(stateDir, orphan2Pid),
      JSON.stringify({ pid: orphan2Pid, instanceId: "stubborn-orphan-2", startedAt: new Date().toISOString(), runtime: "onnx" }),
    );
    const fresh = await ensureWardenS1Daemon({
      runtime: "onnx",
      mockWeights: true,
      stateDir,
      idleShutdownSec: 60,
      startupTimeoutMs: 15_000,
    });
    assert.equal(isPidAlive(orphan2Pid), false, "ensureWardenS1Daemon must reap prior orphaned worker");
    assert.equal(isPidAlive(fresh.pid), true);
    assert.equal(existsSync(daemonPidFilePath(stateDir, fresh.pid)), true);

    const swept = await sweepOrphanDaemonPids(stateDir, { keepPid: fresh.pid, keepInstanceId: fresh.instanceId });
    assert.deepEqual(swept, []);
    assert.equal(isPidAlive(fresh.pid), true, "keepPid protects the live healthy daemon");
  } finally {
    if (stubbornPid && isPidAlive(stubbornPid)) { try { process.kill(stubbornPid, "SIGKILL"); } catch {} }
    if (orphanPid && isPidAlive(orphanPid)) { try { process.kill(orphanPid, "SIGKILL"); } catch {} }
    await stopWardenS1Daemon(stateDir, 2000).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
