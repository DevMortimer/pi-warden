import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig, projectConfigPath } from "../src/config.js";
import {
  MLX_MODEL_ID,
  MLX_MODEL_REPO,
  MLX_REQUIRED_FILES,
  ONNX_MANIFEST_FILE,
  ONNX_MODEL_ID,
  ONNX_MODEL_REPO,
  READY_MANIFEST_FILE,
  downloadWardenS1,
  formatDownloadProgress,
  getWardenS1Status,
  probeMlxPython,
  removeWardenS1,
  resolveCacheRoot,
  resolveManagedMlxPython,
  resolveManagedMlxVenvDir,
  resolveModelsRoot,
  selectWardenS1Runtime,
  type DownloadProgress,
} from "../src/local-model.js";

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function gitBlobOid(buf: Buffer): string {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

function makeTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startServer(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function serveWithRange(req: IncomingMessage, res: ServerResponse, payload: Buffer, extraHeaders: Record<string, string> = {}): void {
  const range = req.headers.range;
  if (typeof range === "string") {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { "content-range": `bytes */${payload.length}` });
      res.end();
      return;
    }
    const start = Number.parseInt(match[1]!, 10);
    const end = match[2] ? Math.min(payload.length - 1, Number.parseInt(match[2], 10)) : payload.length - 1;
    if (start >= payload.length || start > end) {
      res.writeHead(416, { "content-range": `bytes */${payload.length}` });
      res.end();
      return;
    }
    const slice = payload.subarray(start, end + 1);
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(slice.length),
      "content-range": `bytes ${start}-${end}/${payload.length}`,
      "accept-ranges": "bytes",
      ...extraHeaders,
    });
    res.end(slice);
    return;
  }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(payload.length),
    "accept-ranges": "bytes",
    ...extraHeaders,
  });
  res.end(payload);
}

test("selectWardenS1Runtime: hardware-aware selection matrix across macOS/Linux/Windows and overrides", t => {
  const cacheDir = makeTempDir(t, "pi-warden-s1-select-");

  const appleWithMlx = selectWardenS1Runtime(
    { runtime: "auto", cacheDir },
    { platform: "darwin", arch: "arm64", probeMlx: () => ({ available: true, python: "/opt/homebrew/bin/python3" }) },
  );
  assert.equal(appleWithMlx.runtime, "mlx");
  assert.equal(appleWithMlx.repoId, MLX_MODEL_REPO);
  assert.equal(appleWithMlx.modelId, MLX_MODEL_ID);
  assert.equal(appleWithMlx.mlxPython, "/opt/homebrew/bin/python3");
  assert.equal(appleWithMlx.diagnostic, undefined);

  const appleWithoutMlx = selectWardenS1Runtime(
    { runtime: "auto", cacheDir },
    { platform: "darwin", arch: "arm64", probeMlx: () => ({ available: false, reason: "no mlx_lm" }) },
  );
  assert.equal(appleWithoutMlx.runtime, "mlx");
  assert.equal(appleWithoutMlx.repoId, MLX_MODEL_REPO);
  assert.equal(appleWithoutMlx.modelId, MLX_MODEL_ID);
  assert.equal(appleWithoutMlx.mlxPython, undefined);
  assert.equal(appleWithoutMlx.diagnostic, undefined);

  // An existing ONNX-only install on Apple Silicon stays on ONNX under auto until download upgrades to MLX.
  const onnxFallbackRoot = makeTempDir(t, "pi-warden-s1-onnx-fallback-");
  const onnxDir = join(onnxFallbackRoot, "warden-s1-752m-onnx-int4");
  mkdirSync(onnxDir, { recursive: true });
  writeFileSync(
    join(onnxDir, READY_MANIFEST_FILE),
    JSON.stringify({
      version: 1,
      runtime: "onnx",
      repoId: ONNX_MODEL_REPO,
      modelId: ONNX_MODEL_ID,
      downloadedAt: new Date().toISOString(),
      totalBytes: 12,
      files: [{ path: "config.json", bytes: 12, sha256: sha256Hex(Buffer.from("placeholder!")) }],
    }),
  );
  const appleOnnxFallback = selectWardenS1Runtime(
    { runtime: "auto", cacheDir: onnxFallbackRoot },
    { platform: "darwin", arch: "arm64", probeMlx: () => ({ available: false, reason: "no mlx_lm" }) },
  );
  assert.equal(appleOnnxFallback.runtime, "onnx");
  assert.equal(appleOnnxFallback.repoId, ONNX_MODEL_REPO);
  const appleOnnxForDownload = selectWardenS1Runtime(
    { runtime: "auto", cacheDir: onnxFallbackRoot },
    { platform: "darwin", arch: "arm64", forDownload: true, probeMlx: () => ({ available: false, reason: "no mlx_lm" }) },
  );
  assert.equal(appleOnnxForDownload.runtime, "mlx");
  assert.equal(appleOnnxForDownload.repoId, MLX_MODEL_REPO);

  const linux = selectWardenS1Runtime({ runtime: "auto", cacheDir }, { platform: "linux", arch: "x64" });
  assert.equal(linux.runtime, "onnx");
  assert.equal(linux.repoId, ONNX_MODEL_REPO);

  const windows = selectWardenS1Runtime({ runtime: "auto", cacheDir }, { platform: "win32", arch: "x64" });
  assert.equal(windows.runtime, "onnx");
  assert.equal(windows.repoId, ONNX_MODEL_REPO);

  const intelMac = selectWardenS1Runtime({ runtime: "auto", cacheDir }, { platform: "darwin", arch: "x64" });
  assert.equal(intelMac.runtime, "onnx");

  let probed = false;
  const forcedOnnx = selectWardenS1Runtime(
    { runtime: "onnx", cacheDir },
    { platform: "darwin", arch: "arm64", probeMlx: () => { probed = true; return { available: true, python: "python3" }; } },
  );
  assert.equal(forcedOnnx.runtime, "onnx");
  assert.equal(probed, false, "explicit onnx must not invoke MLX probe");

  const forcedMlxLinux = selectWardenS1Runtime({ runtime: "mlx", cacheDir }, { platform: "linux", arch: "x64" });
  assert.equal(forcedMlxLinux.runtime, "mlx");
  assert.match(forcedMlxLinux.diagnostic ?? "", /Apple Silicon|darwin\/arm64/);

  const forcedMlxNoPython = selectWardenS1Runtime(
    { runtime: "mlx", cacheDir },
    { platform: "darwin", arch: "arm64", probeMlx: () => ({ available: false, reason: "mlx_lm missing" }) },
  );
  assert.equal(forcedMlxNoPython.runtime, "mlx");
  assert.match(forcedMlxNoPython.diagnostic ?? "", /mlx_lm missing/);
});

test("probeMlxPython: skips spawning outside darwin/arm64 and probes candidates with bounded timeout", () => {
  let called = 0;
  const linuxProbe = probeMlxPython({
    platform: "linux",
    arch: "x64",
    exec: () => { called += 1; return { status: 0 }; },
  });
  assert.equal(linuxProbe.available, false);
  assert.equal(called, 0);

  const expectedFastProbeArgs = [
    "-c",
    "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('mlx') and importlib.util.find_spec('mlx_lm') else 1)",
  ];
  const seen: Array<{ python: string; timeoutMs: number }> = [];
  const macProbe = probeMlxPython({
    platform: "darwin",
    arch: "arm64",
    env: { PI_WARDEN_PYTHON: "/custom/venv/bin/python3" },
    timeoutMs: 99999,
    exec: (python, args, timeoutMs) => {
      seen.push({ python, timeoutMs });
      assert.deepEqual(args, expectedFastProbeArgs);
      return python === "/custom/venv/bin/python3" ? { status: 0 } : { status: 1 };
    },
  });
  assert.equal(macProbe.available, true);
  assert.equal(macProbe.python, "/custom/venv/bin/python3");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.timeoutMs, 15_000, "MLX probe timeout ceiling must be 15000 ms");

  let defaultTimeoutSeen = 0;
  probeMlxPython({
    platform: "darwin",
    arch: "arm64",
    candidates: ["/cold/dyld/python3"],
    exec: (_python, args, timeoutMs) => {
      assert.deepEqual(args, expectedFastProbeArgs);
      defaultTimeoutSeen = timeoutMs;
      return { status: 0 };
    },
  });
  assert.equal(defaultTimeoutSeen, 8000, "default MLX probe timeout must be 8000 ms so a 3500 ms cold dyld exec succeeds");

  // Managed mlx-venv under PI_WARDEN_CACHE_DIR is probed right after PI_WARDEN_PYTHON and before global python3.
  const isolatedCache = "/var/tmp/pi-warden-managed-probe-test";
  const expectedManagedPython = resolveManagedMlxPython({ PI_WARDEN_CACHE_DIR: isolatedCache });
  assert.equal(resolveCacheRoot({ PI_WARDEN_CACHE_DIR: isolatedCache }), isolatedCache);
  assert.equal(resolveManagedMlxVenvDir({ PI_WARDEN_CACHE_DIR: isolatedCache }), join(isolatedCache, "runtime", "mlx-venv"));
  assert.equal(expectedManagedPython, join(isolatedCache, "runtime", "mlx-venv", "bin", "python3"));

  const probedOrder: string[] = [];
  const managedProbe = probeMlxPython({
    platform: "darwin",
    arch: "arm64",
    env: { PI_WARDEN_CACHE_DIR: isolatedCache },
    exec: python => {
      probedOrder.push(python);
      return python === expectedManagedPython ? { status: 0 } : { status: 1 };
    },
  });
  assert.equal(managedProbe.available, true);
  assert.equal(managedProbe.python, expectedManagedPython);
  assert.deepEqual(probedOrder, [expectedManagedPython], "managed mlx-venv must be probed before global python3");

  const withOverrideOrder: string[] = [];
  probeMlxPython({
    platform: "darwin",
    arch: "arm64",
    env: { PI_WARDEN_PYTHON: "/override/python3", PI_WARDEN_CACHE_DIR: isolatedCache },
    exec: python => {
      withOverrideOrder.push(python);
      return { status: 1 };
    },
  });
  assert.equal(withOverrideOrder[0], "/override/python3");
  assert.equal(withOverrideOrder[1], expectedManagedPython);
  assert.equal(withOverrideOrder[2], "python3");
  assert.ok(withOverrideOrder.includes("/opt/homebrew/bin/python3.12"));
});

test("probeMlxPython: uses importlib.util.find_spec against a real Python binary in < 300 ms without executing mlx_lm", t => {
  const realPython = ["python3", "/opt/homebrew/bin/python3", "/usr/bin/python3"].find(candidate => {
    const check = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 2000, stdio: "ignore" });
    return !check.error && check.status === 0;
  });
  assert.ok(realPython, "a real python3 binary is required on the test host");

  const root = makeTempDir(t, "pi-warden-s1-fast-probe-");
  const siteDir = join(root, "site-packages");
  mkdirSync(join(siteDir, "mlx"), { recursive: true });
  mkdirSync(join(siteDir, "mlx_lm"), { recursive: true });
  writeFileSync(join(siteDir, "mlx", "__init__.py"), "raise RuntimeError('find_spec must not execute mlx')\n");
  writeFileSync(join(siteDir, "mlx_lm", "__init__.py"), "raise RuntimeError('find_spec must not execute mlx_lm')\n");

  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "python3");
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(wrapper, `#!/bin/sh\nPYTHONPATH=${shellQuote(siteDir)} exec ${shellQuote(realPython)} "$@"\n`);
  chmodSync(wrapper, 0o755);

  const res = probeMlxPython({
    platform: "darwin",
    arch: "arm64",
    candidates: [wrapper],
    refresh: true,
  });

  assert.equal(res.available, true);
  assert.equal(res.python, wrapper);

  // Measure direct real-Python find_spec latency (best of 2 to avoid parallel-test CPU spikes).
  let bestMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 2; i += 1) {
    const t0 = performance.now();
    probeMlxPython({
      platform: "darwin",
      arch: "arm64",
      candidates: [realPython],
      refresh: true,
    });
    bestMs = Math.min(bestMs, performance.now() - t0);
  }
  assert.ok(bestMs < 300, `expected real-Python find_spec probe < 300 ms, got ${Math.round(bestMs)} ms`);
});

test("probeMlxPython: never caches a timeout or spawn error as permanent available: false", t => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const root = makeTempDir(t, "pi-warden-s1-timeout-cache-");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const py = join(binDir, "python3");
  writeFileSync(py, "#!/bin/sh\nsleep 0.35\nexit 0\n");
  chmodSync(py, 0o755);

  const prevPython = process.env.PI_WARDEN_PYTHON;
  const prevCache = process.env.PI_WARDEN_CACHE_DIR;
  t.after(() => {
    if (prevPython === undefined) delete process.env.PI_WARDEN_PYTHON;
    else process.env.PI_WARDEN_PYTHON = prevPython;
    if (prevCache === undefined) delete process.env.PI_WARDEN_CACHE_DIR;
    else process.env.PI_WARDEN_CACHE_DIR = prevCache;
  });

  process.env.PI_WARDEN_CACHE_DIR = root;
  process.env.PI_WARDEN_PYTHON = py;

  const first = probeMlxPython({ timeoutMs: 100, refresh: true });
  assert.equal(first.available, false);

  // Replace the slow stub with a fast succeeding probe under the exact same cache key.
  writeFileSync(py, "#!/bin/sh\nexit 0\n");
  chmodSync(py, 0o755);

  const second = probeMlxPython();
  assert.equal(second.available, true, "transient timeout must not be cached as permanent available: false");
  assert.equal(second.python, py);
});

test("resolveModelsRoot: respects cacheDir, PI_WARDEN_CACHE_DIR, and default home path", () => {
  assert.equal(resolveModelsRoot({ cacheDir: "/var/tmp/my-models" }), "/var/tmp/my-models");
  assert.equal(resolveModelsRoot(undefined, { PI_WARDEN_CACHE_DIR: "/var/tmp/warden-cache" }), "/var/tmp/warden-cache/models");
  assert.ok(resolveModelsRoot(undefined, {}).endsWith(join(".cache", "pi-warden", "models")));
});

test("downloadWardenS1 (ONNX): resumes half-written .part via HTTP 206 Range, verifies SHA-256, writes ready manifest, and skips on retry", async t => {
  const cacheDir = makeTempDir(t, "pi-warden-s1-onnx-");
  const stateDir = makeTempDir(t, "pi-warden-s1-state-");

  const shard0 = Buffer.alloc(4096, 0x41);
  const shard1 = Buffer.from("warden-s1-onnx-shard-01-payload-".repeat(64), "utf8");
  const configJson = Buffer.from(JSON.stringify({ hidden_size: 1024 }), "utf8");
  const filesMap = new Map<string, Buffer>([
    ["warden_s1_embed.onnx", shard0],
    ["warden_s1_backbone.shard_00.bin", shard1],
    ["config.json", configJson],
  ]);

  const manifest = {
    format: "warden-s1-onnx-int4-v1",
    files: [...filesMap.entries()].map(([path, buf]) => ({
      path,
      bytes: buf.length,
      sha256: sha256Hex(buf),
    })),
  };

  const requests: Array<{ url: string; range?: string }> = [];
  const { baseUrl } = await startServer(t, (req, res) => {
    const url = req.url ?? "";
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    requests.push(range ? { url, range } : { url });
    if (url === `/${ONNX_MODEL_REPO}/resolve/main/${ONNX_MANIFEST_FILE}`) {
      const body = Buffer.from(JSON.stringify(manifest), "utf8");
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    const prefix = `/${ONNX_MODEL_REPO}/resolve/main/`;
    if (url.startsWith(prefix)) {
      const filePath = decodeURIComponent(url.slice(prefix.length));
      const payload = filesMap.get(filePath);
      if (payload) {
        serveWithRange(req, res, payload, { "x-linked-etag": `"${sha256Hex(payload)}"` });
        return;
      }
    }
    res.writeHead(404);
    res.end("not found");
  });

  // Initial empty state: installed false, incomplete false, ready false (0 network calls).
  const initialStatus = getWardenS1Status({ runtime: "onnx", cacheDir }, { stateDir });
  assert.equal(initialStatus.ready, false);
  assert.equal(initialStatus.installed, false);
  assert.equal(initialStatus.incomplete, false);
  assert.equal(requests.length, 0);

  // Seed an interrupted half-written .part file for shard1.
  mkdirSync(initialStatus.modelDir, { recursive: true });
  const halfLen = Math.floor(shard1.length / 2);
  writeFileSync(join(initialStatus.modelDir, "warden_s1_backbone.shard_00.bin.part"), shard1.subarray(0, halfLen));

  const partialStatus = getWardenS1Status({ runtime: "onnx", cacheDir }, { stateDir });
  assert.equal(partialStatus.ready, false);
  assert.equal(partialStatus.installed, false);
  assert.equal(partialStatus.incomplete, true);
  assert.deepEqual(partialStatus.partFiles, ["warden_s1_backbone.shard_00.bin.part"]);

  const progressEvents: DownloadProgress[] = [];
  let ortInstallDir: string | undefined;
  const result = await downloadWardenS1(
    { runtime: "onnx", cacheDir },
    {
      hfBaseUrl: baseUrl,
      stateDir,
      onProgress: p => progressEvents.push(p),
      ensureOrtRuntime: async runtimeDir => {
        ortInstallDir = runtimeDir;
        const pkgDir = join(runtimeDir, "node_modules", "onnxruntime-node");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.0.0" }));
        return pkgDir;
      },
    },
  );

  assert.equal(result.runtime, "onnx");
  assert.equal(result.repoId, ONNX_MODEL_REPO);
  assert.deepEqual(result.resumedFiles, ["warden_s1_backbone.shard_00.bin"]);
  assert.equal(result.skippedFiles.length, 0);
  assert.equal(ortInstallDir, join(stateDir, "runtime"));
  assert.ok(result.ortRuntimePath?.endsWith(join("runtime", "node_modules", "onnxruntime-node")));

  const resumeReq = requests.find(r => r.url.endsWith("/warden_s1_backbone.shard_00.bin"));
  assert.equal(resumeReq?.range, `bytes=${halfLen}-`, "resumed download must send Range header starting at .part size");

  assert.equal(existsSync(join(result.modelDir, "warden_s1_backbone.shard_00.bin.part")), false, ".part must be atomically renamed away");
  assert.deepEqual(readFileSync(join(result.modelDir, "warden_s1_backbone.shard_00.bin")), shard1);
  assert.ok(existsSync(join(result.modelDir, READY_MANIFEST_FILE)));
  assert.ok(existsSync(join(result.modelDir, ONNX_MANIFEST_FILE)));
  assert.ok(progressEvents.length >= 3);
  assert.equal(progressEvents.at(-1)!.percent, 100);
  assert.match(formatDownloadProgress(progressEvents.at(-1)!), /^Warden-S1 \(onnx\): 100% \(.* MiB\) \[3\/3\] config\.json$/);

  const readyStatus = getWardenS1Status({ runtime: "onnx", cacheDir }, { stateDir });
  assert.equal(readyStatus.ready, true);
  assert.equal(readyStatus.installed, true);
  assert.equal(readyStatus.incomplete, false);
  assert.deepEqual(readyStatus.missingFiles, []);
  assert.deepEqual(readyStatus.partFiles, []);
  assert.ok(readyStatus.ortRuntimePath);

  // Re-running download is idempotent: skips already-verified files with zero file downloads.
  const beforeRetryCount = requests.length;
  const second = await downloadWardenS1(
    { runtime: "onnx", cacheDir },
    { hfBaseUrl: baseUrl, stateDir, ensureOrtRuntime: async dir => join(dir, "node_modules", "onnxruntime-node") },
  );
  assert.equal(second.skippedFiles.length, 3);
  assert.equal(requests.length - beforeRetryCount, 1, "only manifest fetch should occur when all files are already verified");
});

test("downloadWardenS1 (ONNX): corrupt 1-byte tamper fails SHA-256 verification, deletes .part, and keeps ready false", async t => {
  const cacheDir = makeTempDir(t, "pi-warden-s1-corrupt-");
  const stateDir = makeTempDir(t, "pi-warden-s1-corrupt-state-");

  const goodBytes = Buffer.from("valid-onnx-model-weights-data-1234567890", "utf8");
  const tamperedBytes = Buffer.from(goodBytes);
  tamperedBytes[0] = tamperedBytes[0]! ^ 0xff;

  const manifest = {
    files: [{ path: "warden_s1_heads.onnx", bytes: goodBytes.length, sha256: sha256Hex(goodBytes) }],
  };

  const { baseUrl } = await startServer(t, (req, res) => {
    if (req.url === `/${ONNX_MODEL_REPO}/resolve/main/${ONNX_MANIFEST_FILE}`) {
      const body = Buffer.from(JSON.stringify(manifest), "utf8");
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    if (req.url === `/${ONNX_MODEL_REPO}/resolve/main/warden_s1_heads.onnx`) {
      serveWithRange(req, res, tamperedBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await assert.rejects(
    downloadWardenS1(
      { runtime: "onnx", cacheDir },
      { hfBaseUrl: baseUrl, stateDir, ensureOrtRuntime: async () => undefined },
    ),
    /SHA-256 mismatch/,
  );

  const status = getWardenS1Status({ runtime: "onnx", cacheDir }, { stateDir });
  assert.equal(status.ready, false);
  assert.equal(status.installed, false);
  assert.equal(existsSync(join(status.modelDir, "warden_s1_heads.onnx.part")), false, "corrupt .part must be removed");
  assert.equal(existsSync(join(status.modelDir, "warden_s1_heads.onnx")), false, "corrupt payload must never be renamed to final path");
});

test("downloadWardenS1 (MLX): downloads HF tree LFS and metadata files with SHA-256 and git-oid verification, and deduplicates concurrent calls", async t => {
  const cacheDir = makeTempDir(t, "pi-warden-s1-mlx-");
  const lfsFiles = new Set(["model.safetensors", "s1_heads.safetensors", "tokenizer.json"]);
  const payloads = new Map<string, Buffer>();
  for (const name of MLX_REQUIRED_FILES) {
    payloads.set(name, Buffer.from(`payload-for-${name}-`.repeat(16), "utf8"));
  }

  const tree = MLX_REQUIRED_FILES.map(path => {
    const buf = payloads.get(path)!;
    if (lfsFiles.has(path)) {
      return {
        type: "file",
        path,
        size: buf.length,
        oid: gitBlobOid(buf),
        lfs: { oid: sha256Hex(buf), size: buf.length },
      };
    }
    return { type: "file", path, size: buf.length, oid: gitBlobOid(buf) };
  });

  let treeFetches = 0;
  const { baseUrl } = await startServer(t, (req, res) => {
    if (req.url === `/api/models/${MLX_MODEL_REPO}/tree/main`) {
      treeFetches += 1;
      const body = Buffer.from(JSON.stringify(tree), "utf8");
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    const prefix = `/${MLX_MODEL_REPO}/resolve/main/`;
    if (req.url?.startsWith(prefix)) {
      const name = decodeURIComponent(req.url.slice(prefix.length));
      const buf = payloads.get(name);
      if (buf) {
        const etag = lfsFiles.has(name) ? `"${sha256Hex(buf)}"` : `"${gitBlobOid(buf)}"`;
        serveWithRange(req, res, buf, { etag });
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });

  const probe = () => ({ available: true, python: "/opt/homebrew/bin/python3" });
  const progressA: DownloadProgress[] = [];
  const progressB: DownloadProgress[] = [];
  const [resA, resB] = await Promise.all([
    downloadWardenS1({ runtime: "auto", cacheDir }, { platform: "darwin", arch: "arm64", probeMlx: probe, hfBaseUrl: baseUrl, onProgress: p => progressA.push(p) }),
    downloadWardenS1({ runtime: "auto", cacheDir }, { platform: "darwin", arch: "arm64", probeMlx: probe, hfBaseUrl: baseUrl, onProgress: p => progressB.push(p) }),
  ]);

  assert.equal(treeFetches, 1, "concurrent calls on the same modelDir must deduplicate");
  assert.equal(resA.runtime, "mlx");
  assert.equal(resB.runtime, "mlx");
  assert.equal(resA.files.length, MLX_REQUIRED_FILES.length);
  assert.ok(progressA.length > 0 && progressB.length > 0);

  const status = getWardenS1Status({ runtime: "auto", cacheDir }, { platform: "darwin", arch: "arm64", probeMlx: probe });
  assert.equal(status.ready, true);
  assert.equal(status.installed, true);

  // Forced MLX on Linux refuses before touching the network.
  await assert.rejects(
    downloadWardenS1({ runtime: "mlx", cacheDir }, { platform: "linux", arch: "x64", hfBaseUrl: baseUrl }),
    /Apple Silicon/,
  );
  assert.equal(treeFetches, 1, "refused forced-MLX download must make zero network requests");
});

test("downloadWardenS1 (MLX auto-provision): darwin/arm64 auto invokes ensureMlxRuntime when no global mlx exists and transitions ready false -> true", async t => {
  const cacheRoot = makeTempDir(t, "pi-warden-s1-mlx-provision-");
  const env: NodeJS.ProcessEnv = { PI_WARDEN_CACHE_DIR: cacheRoot };
  const payloads = new Map<string, Buffer>();
  for (const name of MLX_REQUIRED_FILES) {
    payloads.set(name, Buffer.from(`mlx-provision-${name}-`.repeat(8), "utf8"));
  }
  const tree = MLX_REQUIRED_FILES.map(path => {
    const buf = payloads.get(path)!;
    return { type: "file", path, size: buf.length, oid: gitBlobOid(buf), lfs: { oid: sha256Hex(buf), size: buf.length } };
  });
  const { baseUrl } = await startServer(t, (req, res) => {
    if (req.url === `/api/models/${MLX_MODEL_REPO}/tree/main`) {
      const body = Buffer.from(JSON.stringify(tree), "utf8");
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    const prefix = `/${MLX_MODEL_REPO}/resolve/main/`;
    if (req.url?.startsWith(prefix)) {
      const name = decodeURIComponent(req.url.slice(prefix.length));
      const buf = payloads.get(name);
      if (buf) {
        serveWithRange(req, res, buf, { etag: `"${sha256Hex(buf)}"` });
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });

  let provisionedPython: string | undefined;
  const dynamicProbe = () => provisionedPython
    ? { available: true, python: provisionedPython }
    : { available: false, reason: "no global mlx" };

  const before = getWardenS1Status({ runtime: "auto" }, { platform: "darwin", arch: "arm64", env, probeMlx: dynamicProbe });
  assert.equal(before.runtime, "mlx");
  assert.equal(before.ready, false);
  assert.equal(before.diagnostic, undefined);

  let seenVenvDir: string | undefined;
  const result = await downloadWardenS1(
    { runtime: "auto" },
    {
      platform: "darwin",
      arch: "arm64",
      env,
      hfBaseUrl: baseUrl,
      probeMlx: dynamicProbe,
      ensureMlxRuntime: async venvDir => {
        seenVenvDir = venvDir;
        const bin = join(venvDir, "bin", "python3");
        mkdirSync(join(venvDir, "bin"), { recursive: true });
        writeFileSync(bin, "#!/bin/sh\nexit 0\n");
        provisionedPython = bin;
        return bin;
      },
    },
  );
  assert.equal(result.runtime, "mlx");
  assert.equal(seenVenvDir, resolveManagedMlxVenvDir(env));
  assert.equal(result.mlxPython, resolveManagedMlxPython(env));

  // If weights are on disk without mlxPython available yet, status stays ready: false with a clear provisioning hint.
  const withoutPython = getWardenS1Status(
    { runtime: "auto" },
    { platform: "darwin", arch: "arm64", env, probeMlx: () => ({ available: false, reason: "missing" }) },
  );
  assert.equal(withoutPython.runtime, "mlx");
  assert.equal(withoutPython.installed, true);
  assert.equal(withoutPython.ready, false);
  assert.match(withoutPython.diagnostic ?? "", /\/warden model download.*mlx-venv/);

  // Once the managed mlx-venv python probes cleanly, status is ready: true.
  const after = getWardenS1Status({ runtime: "auto" }, { platform: "darwin", arch: "arm64", env, probeMlx: dynamicProbe });
  assert.equal(after.runtime, "mlx");
  assert.equal(after.ready, true);
  assert.equal(after.mlxPython, resolveManagedMlxPython(env));
  assert.equal(after.diagnostic, undefined);
});

test("removeWardenS1: deletes downloaded model directories and stray .part files and reports freed bytes", t => {
  const cacheDir = makeTempDir(t, "pi-warden-s1-remove-");
  const status = getWardenS1Status({ runtime: "onnx", cacheDir });
  mkdirSync(status.modelDir, { recursive: true });
  writeFileSync(join(status.modelDir, "weights.bin"), Buffer.alloc(1024, 1));
  writeFileSync(join(status.modelDir, "partial.bin.part"), Buffer.alloc(256, 2));
  writeFileSync(join(cacheDir, "stray.part"), Buffer.alloc(128, 3));

  const removed = removeWardenS1({ cacheDir });
  assert.deepEqual(removed.removedDirs, [status.modelDir]);
  assert.equal(removed.freedBytes, 1024 + 256 + 128);
  assert.equal(existsSync(status.modelDir), false);
  assert.equal(existsSync(join(cacheDir, "stray.part")), false);

  const after = getWardenS1Status({ runtime: "onnx", cacheDir });
  assert.equal(after.ready, false);
  assert.equal(after.installed, false);
  assert.equal(after.incomplete, false);
});

test("trust boundary: project .pi/pi-warden.json cannot enable localModel.autoDownload or switch typesafeBackend", t => {
  const root = makeTempDir(t, "pi-warden-s1-trust-");
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const dirs = { agentDir, configDirName: ".pi" };
  const projPath = projectConfigPath(projectDir, dirs);
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(projPath, JSON.stringify({
    typesafeBackend: "warden-s1",
    localModel: { autoDownload: true, runtime: "onnx", cacheDir: "/tmp/evil", idleShutdownSec: 10 },
  }));

  const loaded = loadConfig({ cwd: projectDir, projectTrusted: true, dirs });
  assert.equal(loaded.typesafeBackend, "cloud");
  assert.deepEqual(loaded.localModel, {
    autoDownload: false,
    runtime: "auto",
    idleShutdownSec: 1800,
  });
});
