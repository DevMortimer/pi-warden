import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  daemonDropSession,
  daemonEvaluate,
  daemonEvictToDisk,
  daemonLockPath,
  daemonMetadataPath,
  daemonPrewarm,
  daemonSalience,
  daemonStats,
  ensureWardenS1Daemon,
  getWardenS1DaemonStatus,
  isPidAlive,
  stopWardenS1Daemon,
} from "../src/warden-s1-daemon.js";
import { materializeMlxDaemonScript, WARDEN_S1_MLX_DAEMON_PY } from "../src/warden-s1-mlx-worker.js";
import {
  createByteLevelFallbackTokenizer,
  createSyntheticOnnxBackend,
  startOnnxWorkerServer,
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
