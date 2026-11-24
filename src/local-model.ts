import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomicSync } from "./atomic.js";
import type { LocalModelConfig, LocalModelRuntime } from "./config.js";
import type { HostDirs } from "./host-dirs.js";
import { defaultHostDirs, expandHome } from "./host-dirs.js";

export const MLX_MODEL_REPO = "DevMortimer/Warden-S1-752M-MLX-4bit";
export const ONNX_MODEL_REPO = "DevMortimer/Warden-S1-752M-ONNX-Int4";
export const MLX_MODEL_ID = "warden-s1-752m-mlx-q4";
export const ONNX_MODEL_ID = "warden-s1-752m-onnx-int4";
export const MLX_EXPECTED_MIB = 415.5;
export const ONNX_EXPECTED_MIB = 461.3;
export const MLX_MODEL_DIR_NAME = "warden-s1-752m-mlx-4bit";
export const ONNX_MODEL_DIR_NAME = "warden-s1-752m-onnx-int4";
export const DEFAULT_IDLE_SHUTDOWN_SEC = 1800;
export const DEFAULT_HF_BASE_URL = "https://huggingface.co";
export const READY_MANIFEST_FILE = "warden_s1_ready.json";
export const ONNX_MANIFEST_FILE = "onnx_manifest.json";
export const MLX_REQUIRED_FILES = [
  "config.json",
  "calibration.json",
  "chat_template.jinja",
  "model.safetensors",
  "model.safetensors.index.json",
  "s1_heads.safetensors",
  "tokenizer.json",
  "tokenizer_config.json",
] as const;

export type SelectedRuntime = "mlx" | "onnx";

export interface MlxProbeResult {
  readonly available: boolean;
  readonly python?: string;
  readonly reason?: string;
}

export interface ProbeMlxOptions {
  readonly refresh?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly candidates?: readonly string[];
  readonly timeoutMs?: number;
  readonly exec?: (python: string, args: readonly string[], timeoutMs: number) => { status: number | null; stderr?: string; error?: Error };
}

export interface RuntimeSelection {
  readonly runtime: SelectedRuntime;
  readonly requestedRuntime: LocalModelRuntime;
  readonly repoId: string;
  readonly modelId: string;
  readonly expectedMib: number;
  readonly modelDir: string;
  readonly modelsRoot: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly mlxPython?: string;
  readonly diagnostic?: string;
}

export interface SelectRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly refreshProbe?: boolean;
  readonly probeMlx?: () => MlxProbeResult;
}

export interface ReadyManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReadyManifest {
  readonly version: 1;
  readonly runtime: SelectedRuntime;
  readonly repoId: string;
  readonly modelId: string;
  readonly downloadedAt: string;
  readonly totalBytes: number;
  readonly files: readonly ReadyManifestFile[];
}

export interface WardenS1Status {
  readonly runtime: SelectedRuntime;
  readonly requestedRuntime: LocalModelRuntime;
  readonly repoId: string;
  readonly modelId: string;
  readonly expectedMib: number;
  readonly modelDir: string;
  readonly modelsRoot: string;
  readonly ready: boolean;
  readonly installed: boolean;
  readonly incomplete: boolean;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly missingFiles: readonly string[];
  readonly partFiles: readonly string[];
  readonly mlxPython?: string;
  readonly ortRuntimePath?: string;
  readonly diagnostic?: string;
  readonly manifest?: ReadyManifest;
}

export interface StatusOptions extends SelectRuntimeOptions {
  readonly stateDir?: string;
  readonly dirs?: HostDirs;
}

export interface DownloadProgress {
  readonly runtime: SelectedRuntime;
  readonly repoId: string;
  readonly file: string;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export interface DownloadOptions extends StatusOptions {
  readonly hfBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly ensureOrtRuntime?: (runtimeDir: string) => Promise<string | undefined>;
}

export interface DownloadResult {
  readonly runtime: SelectedRuntime;
  readonly repoId: string;
  readonly modelId: string;
  readonly modelDir: string;
  readonly files: readonly ReadyManifestFile[];
  readonly totalBytes: number;
  readonly resumedFiles: readonly string[];
  readonly skippedFiles: readonly string[];
  readonly ortRuntimePath?: string;
}

export interface RemoveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runtime?: SelectedRuntime;
}

export interface RemoveResult {
  readonly removedDirs: readonly string[];
  readonly freedBytes: number;
}

interface ModelFileSpec {
  readonly path: string;
  readonly bytes: number;
  readonly sha256?: string;
  readonly gitOid?: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;
const SHA1_RE = /^[0-9a-f]{40}$/i;
const LOCK_FILE = ".download.lock";

let cachedMlxProbe: MlxProbeResult | undefined;

interface InflightDownload {
  readonly promise: Promise<DownloadResult>;
  readonly listeners: Set<(progress: DownloadProgress) => void>;
}

const inflightDownloads = new Map<string, InflightDownload>();

export function resolveModelsRoot(config?: Partial<LocalModelConfig>, env: NodeJS.ProcessEnv = process.env): string {
  const configured = config?.cacheDir?.trim();
  if (configured) return resolvePath(expandHome(configured));
  const envCache = env.PI_WARDEN_CACHE_DIR?.trim();
  if (envCache) return resolvePath(join(expandHome(envCache), "models"));
  return join(homedir(), ".cache", "pi-warden", "models");
}

export function resolveModelDir(runtime: SelectedRuntime, config?: Partial<LocalModelConfig>, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveModelsRoot(config, env), runtime === "mlx" ? MLX_MODEL_DIR_NAME : ONNX_MODEL_DIR_NAME);
}

export function resolveWardenStateDir(dirs: HostDirs = defaultHostDirs(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_WARDEN_STATE_DIR?.trim();
  if (configured) return resolvePath(expandHome(configured));
  return join(dirs.agentDir, "pi-warden");
}

export function resolveOrtRuntimeDir(stateDir?: string, dirs: HostDirs = defaultHostDirs(), env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir ? resolvePath(expandHome(stateDir)) : resolveWardenStateDir(dirs, env), "runtime");
}

export function resolveInstalledOrtPath(options?: { stateDir?: string; dirs?: HostDirs; env?: NodeJS.ProcessEnv }): string | undefined {
  try {
    const resolved = import.meta.resolve("onnxruntime-node");
    if (resolved) return resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved;
  } catch {
    // Not present in ambient node_modules.
  }
  const runtimeDir = resolveOrtRuntimeDir(options?.stateDir, options?.dirs, options?.env);
  const pkgDir = join(runtimeDir, "node_modules", "onnxruntime-node");
  if (existsSync(join(pkgDir, "package.json"))) return pkgDir;
  return undefined;
}

export function probeMlxPython(options: ProbeMlxOptions = {}): MlxProbeResult {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const useCache = !options.refresh
    && options.platform === undefined
    && options.arch === undefined
    && options.env === undefined
    && options.candidates === undefined
    && options.exec === undefined;
  if (useCache && cachedMlxProbe) return cachedMlxProbe;

  if (platform !== "darwin" || arch !== "arm64") {
    const result: MlxProbeResult = { available: false, reason: `MLX requires macOS Apple Silicon (darwin/arm64), found ${platform}/${arch}` };
    if (useCache) cachedMlxProbe = result;
    return result;
  }

  const rawCandidates = options.candidates ?? [
    ...(env.PI_WARDEN_PYTHON?.trim() ? [expandHome(env.PI_WARDEN_PYTHON)] : []),
    "python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    join(homedir(), ".local", "bin", "python3"),
    "/usr/bin/python3",
  ];
  const candidates = [...new Set(rawCandidates.filter(c => c.length > 0))];
  const timeoutMs = Math.min(3000, Math.max(100, options.timeoutMs ?? 2500));
  const exec = options.exec ?? ((python: string, args: readonly string[], timeout: number) => {
    const out = spawnSync(python, args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    return { status: out.status, stderr: out.stderr, error: out.error };
  });

  for (const python of candidates) {
    const out = exec(python, ["-c", "import mlx, mlx_lm"], timeoutMs);
    if (!out.error && out.status === 0) {
      const result: MlxProbeResult = { available: true, python };
      if (useCache) cachedMlxProbe = result;
      return result;
    }
  }

  const result: MlxProbeResult = { available: false, reason: "Python with mlx and mlx_lm not found (install via: pip install mlx mlx-lm)" };
  if (useCache) cachedMlxProbe = result;
  return result;
}

export function selectWardenS1Runtime(config?: Partial<LocalModelConfig>, options: SelectRuntimeOptions = {}): RuntimeSelection {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const requestedRuntime: LocalModelRuntime = config?.runtime ?? "auto";
  const modelsRoot = resolveModelsRoot(config, env);

  const build = (runtime: SelectedRuntime, extra?: { mlxPython?: string; diagnostic?: string }): RuntimeSelection => ({
    runtime,
    requestedRuntime,
    repoId: runtime === "mlx" ? MLX_MODEL_REPO : ONNX_MODEL_REPO,
    modelId: runtime === "mlx" ? MLX_MODEL_ID : ONNX_MODEL_ID,
    expectedMib: runtime === "mlx" ? MLX_EXPECTED_MIB : ONNX_EXPECTED_MIB,
    modelDir: join(modelsRoot, runtime === "mlx" ? MLX_MODEL_DIR_NAME : ONNX_MODEL_DIR_NAME),
    modelsRoot,
    platform,
    arch,
    ...(extra?.mlxPython ? { mlxPython: extra.mlxPython } : {}),
    ...(extra?.diagnostic ? { diagnostic: extra.diagnostic } : {}),
  });

  if (requestedRuntime === "onnx") return build("onnx");

  const runProbe = () => options.probeMlx
    ? options.probeMlx()
    : probeMlxPython({ platform, arch, env, ...(options.refreshProbe !== undefined ? { refresh: options.refreshProbe } : {}) });

  if (requestedRuntime === "mlx") {
    if (platform !== "darwin" || arch !== "arm64") {
      return build("mlx", {
        diagnostic: `Requested runtime "mlx" requires macOS Apple Silicon (darwin/arm64), but this host is ${platform}/${arch}. Switch localModel.runtime to "auto" or "onnx".`,
      });
    }
    const probe = runProbe();
    if (!probe.available) {
      return build("mlx", {
        diagnostic: `Requested runtime "mlx" is unavailable: ${probe.reason ?? "Python with mlx and mlx_lm not found"}. Install mlx and mlx-lm, or switch localModel.runtime to "auto" or "onnx".`,
      });
    }
    return build("mlx", probe.python ? { mlxPython: probe.python } : undefined);
  }

  if (platform === "darwin" && arch === "arm64") {
    const probe = runProbe();
    if (probe.available) return build("mlx", probe.python ? { mlxPython: probe.python } : undefined);
  }
  return build("onnx");
}

function safeJoinInside(root: string, relPath: string): string {
  if (!relPath || relPath.includes("\\") || isAbsolute(relPath)) {
    throw new Error(`Unsafe model file path: ${relPath}`);
  }
  const base = resolvePath(root);
  const full = resolvePath(base, relPath);
  const rel = relative(base, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Model file path escapes target directory: ${relPath}`);
  }
  return full;
}

function readReadyManifest(modelDir: string, runtime: SelectedRuntime, repoId: string): ReadyManifest | undefined {
  const path = join(modelDir, READY_MANIFEST_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReadyManifest>;
    if (parsed.version !== 1 || parsed.runtime !== runtime || parsed.repoId !== repoId) return undefined;
    if (typeof parsed.modelId !== "string" || typeof parsed.downloadedAt !== "string") return undefined;
    if (typeof parsed.totalBytes !== "number" || !Number.isSafeInteger(parsed.totalBytes) || parsed.totalBytes < 0) return undefined;
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) return undefined;
    for (const file of parsed.files) {
      if (!file || typeof file.path !== "string" || !file.path.length) return undefined;
      if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return undefined;
      if (typeof file.sha256 !== "string" || !SHA256_RE.test(file.sha256)) return undefined;
      safeJoinInside(modelDir, file.path);
    }
    return parsed as ReadyManifest;
  } catch {
    return undefined;
  }
}

function listFilesRecursive(dir: string, prefix = ""): Array<{ rel: string; size: number }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ rel: string; size: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) results.push(...listFilesRecursive(full, rel));
    else if (entry.isFile()) {
      try {
        results.push({ rel, size: statSync(full).size });
      } catch {
        // File vanished during scan.
      }
    }
  }
  return results;
}

export function getWardenS1Status(config?: Partial<LocalModelConfig>, options: StatusOptions = {}): WardenS1Status {
  const selection = selectWardenS1Runtime(config, options);
  const ortRuntimePath = selection.runtime === "onnx" ? resolveInstalledOrtPath(options) : undefined;
  const manifest = readReadyManifest(selection.modelDir, selection.runtime, selection.repoId);
  const diskEntries = listFilesRecursive(selection.modelDir).filter(e => e.rel !== LOCK_FILE);
  const partFiles = diskEntries.filter(e => e.rel.endsWith(".part")).map(e => e.rel).sort();
  const missingFiles: string[] = [];
  let downloadedBytes = 0;

  if (manifest) {
    for (const file of manifest.files) {
      const full = safeJoinInside(selection.modelDir, file.path);
      if (!existsSync(full)) {
        missingFiles.push(file.path);
        continue;
      }
      const size = statSync(full).size;
      if (size !== file.bytes) {
        missingFiles.push(file.path);
        downloadedBytes += size;
      } else {
        downloadedBytes += file.bytes;
      }
    }
    for (const entry of diskEntries) {
      if (entry.rel.endsWith(".part")) downloadedBytes += entry.size;
    }
  } else {
    for (const entry of diskEntries) {
      if (entry.rel !== READY_MANIFEST_FILE) downloadedBytes += entry.size;
    }
  }

  const filesComplete = Boolean(manifest) && missingFiles.length === 0;
  const installed = filesComplete;
  const incomplete = (!filesComplete && (partFiles.length > 0 || downloadedBytes > 0)) || (filesComplete && partFiles.length > 0);
  const ready = filesComplete && partFiles.length === 0 && !selection.diagnostic;
  const totalBytes = manifest ? manifest.totalBytes : Math.round(selection.expectedMib * 1024 * 1024);

  return {
    runtime: selection.runtime,
    requestedRuntime: selection.requestedRuntime,
    repoId: selection.repoId,
    modelId: selection.modelId,
    expectedMib: selection.expectedMib,
    modelDir: selection.modelDir,
    modelsRoot: selection.modelsRoot,
    ready,
    installed,
    incomplete,
    downloadedBytes,
    totalBytes,
    missingFiles,
    partFiles,
    ...(selection.mlxPython ? { mlxPython: selection.mlxPython } : {}),
    ...(ortRuntimePath ? { ortRuntimePath } : {}),
    ...(selection.diagnostic ? { diagnostic: selection.diagnostic } : {}),
    ...(manifest ? { manifest } : {}),
  };
}

export function formatDownloadProgress(progress: DownloadProgress): string {
  const downloadedMib = (progress.downloadedBytes / (1024 * 1024)).toFixed(1);
  const totalMib = (progress.totalBytes / (1024 * 1024)).toFixed(1);
  return `Warden-S1 (${progress.runtime}): ${progress.percent}% (${downloadedMib}/${totalMib} MiB) [${progress.fileIndex}/${progress.fileCount}] ${progress.file}`;
}

export function removeWardenS1(config?: Partial<LocalModelConfig>, options: RemoveOptions = {}): RemoveResult {
  const modelsRoot = resolveModelsRoot(config, options.env);
  if (!existsSync(modelsRoot)) return { removedDirs: [], freedBytes: 0 };

  const targetNames = options.runtime
    ? [options.runtime === "mlx" ? MLX_MODEL_DIR_NAME : ONNX_MODEL_DIR_NAME]
    : [MLX_MODEL_DIR_NAME, ONNX_MODEL_DIR_NAME];

  const removedDirs: string[] = [];
  let freedBytes = 0;

  for (const name of targetNames) {
    const dir = join(modelsRoot, name);
    if (!existsSync(dir)) continue;
    for (const file of listFilesRecursive(dir)) freedBytes += file.size;
    rmSync(dir, { recursive: true, force: true });
    removedDirs.push(dir);
  }

  for (const entry of readdirSync(modelsRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".part")) {
      const full = join(modelsRoot, entry.name);
      try {
        freedBytes += statSync(full).size;
      } catch {
        // Ignore race.
      }
      rmSync(full, { force: true });
    }
  }

  return { removedDirs, freedBytes };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function acquireDownloadLock(modelDir: string): () => void {
  mkdirSync(modelDir, { recursive: true });
  const lockPath = join(modelDir, LOCK_FILE);
  const tryOpen = (): number | undefined => {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return process.pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      return undefined;
    }
  };
  if (tryOpen() === undefined) {
    let existingPid = 0;
    try {
      existingPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    } catch {
      existingPid = 0;
    }
    if (isProcessAlive(existingPid)) {
      throw new Error(`Another Warden-S1 download is already in progress for ${modelDir} (pid ${existingPid}).`);
    }
    rmSync(lockPath, { force: true });
    if (tryOpen() === undefined) {
      throw new Error(`Could not acquire download lock for ${modelDir}.`);
    }
  }
  return () => {
    rmSync(lockPath, { force: true });
  };
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.HF_TOKEN?.trim() || env.HUGGING_FACE_HUB_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function extractEtag(headers: Headers): string | undefined {
  const raw = headers.get("x-linked-etag") ?? headers.get("etag");
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^W\//i, "").replace(/^"|"$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

async function hashFile(filePath: string, withGitBlobSha1: boolean): Promise<{ bytes: number; sha256: string; gitOid?: string }> {
  const size = statSync(filePath).size;
  const sha256 = createHash("sha256");
  const sha1 = withGitBlobSha1 ? createHash("sha1") : undefined;
  if (sha1) sha1.update(`blob ${size}\0`);
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buf.length;
      sha256.update(buf);
      sha1?.update(buf);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return {
    bytes,
    sha256: sha256.digest("hex"),
    ...(sha1 ? { gitOid: sha1.digest("hex") } : {}),
  };
}

async function verifyFileDigest(filePath: string, spec: ModelFileSpec, etag?: string): Promise<string> {
  const needGitOid = !spec.sha256 && (Boolean(spec.gitOid) || Boolean(etag && SHA1_RE.test(etag)));
  const digest = await hashFile(filePath, needGitOid);
  if (spec.bytes > 0 && digest.bytes !== spec.bytes) {
    throw new Error(`Size mismatch for ${spec.path}: expected ${spec.bytes} bytes, got ${digest.bytes}`);
  }
  if (spec.sha256) {
    if (digest.sha256 !== spec.sha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${spec.path}: expected ${spec.sha256.toLowerCase()}, got ${digest.sha256}`);
    }
    return digest.sha256;
  }
  if (etag && SHA256_RE.test(etag)) {
    if (digest.sha256 !== etag.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${spec.path} (from ETag): expected ${etag.toLowerCase()}, got ${digest.sha256}`);
    }
    return digest.sha256;
  }
  if (spec.gitOid) {
    if (digest.gitOid !== spec.gitOid.toLowerCase()) {
      throw new Error(`Integrity mismatch for ${spec.path}: expected git oid ${spec.gitOid.toLowerCase()}, got ${digest.gitOid}`);
    }
    return digest.sha256;
  }
  if (etag && SHA1_RE.test(etag)) {
    if (digest.gitOid !== etag.toLowerCase()) {
      throw new Error(`Integrity mismatch for ${spec.path} (from ETag): expected ${etag.toLowerCase()}, got ${digest.gitOid}`);
    }
  }
  return digest.sha256;
}

async function streamBodyToPart(body: ReadableStream<Uint8Array>, partPath: string, append: boolean, onBytes: (delta: number) => void): Promise<void> {
  mkdirSync(dirname(partPath), { recursive: true });
  const ws = createWriteStream(partPath, { flags: append ? "a" : "w" });
  const reader = body.getReader();
  const streamError = new Promise<never>((_resolve, reject) => {
    ws.once("error", reject);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const ok = ws.write(value);
        onBytes(value.byteLength);
        if (!ok) {
          await Promise.race([
            new Promise<void>(resolve => ws.once("drain", resolve)),
            streamError,
          ]);
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.end(() => resolve());
    });
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel error on aborted stream.
    }
    await new Promise<void>(resolve => {
      ws.end(() => resolve());
    });
    throw error;
  }
}

async function fetchOnnxFileList(baseUrl: string, repoId: string, fetchImpl: typeof globalThis.fetch, headers: Record<string, string>, signal?: AbortSignal): Promise<{ files: ModelFileSpec[]; rawManifest: string }> {
  const url = `${baseUrl}/${repoId}/resolve/main/${ONNX_MANIFEST_FILE}`;
  const res = await fetchImpl(url, { headers, ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`Failed to fetch ${ONNX_MANIFEST_FILE} from ${url}: HTTP ${res.status}`);
  const rawManifest = await res.text();
  let parsed: { files?: Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }> };
  try {
    parsed = JSON.parse(rawManifest) as { files?: Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }> };
  } catch (error) {
    throw new Error(`Invalid JSON in ${ONNX_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`Invalid ${ONNX_MANIFEST_FILE}: missing files array`);
  }
  const files: ModelFileSpec[] = [];
  for (const entry of parsed.files) {
    if (!entry || typeof entry.path !== "string" || !entry.path.length) {
      throw new Error(`Invalid ${ONNX_MANIFEST_FILE}: file entry missing path`);
    }
    if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error(`Invalid ${ONNX_MANIFEST_FILE}: invalid byte size for ${entry.path}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw new Error(`Invalid ${ONNX_MANIFEST_FILE}: invalid sha256 for ${entry.path}`);
    }
    files.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256.toLowerCase() });
  }
  return { files, rawManifest };
}

interface HfTreeEntry {
  readonly type?: string;
  readonly path?: string;
  readonly size?: number;
  readonly oid?: string;
  readonly lfs?: { readonly oid?: string; readonly size?: number };
}

async function fetchMlxFileList(baseUrl: string, repoId: string, fetchImpl: typeof globalThis.fetch, headers: Record<string, string>, signal?: AbortSignal): Promise<ModelFileSpec[]> {
  const url = `${baseUrl}/api/models/${repoId}/tree/main`;
  const res = await fetchImpl(url, { headers, ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`Failed to fetch MLX model tree from ${url}: HTTP ${res.status}`);
  const parsed = (await res.json()) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Invalid HF tree response from ${url}`);
  const byPath = new Map<string, HfTreeEntry>();
  for (const item of parsed as HfTreeEntry[]) {
    if (item && item.type === "file" && typeof item.path === "string") {
      byPath.set(item.path, item);
    }
  }
  const files: ModelFileSpec[] = [];
  for (const requiredPath of MLX_REQUIRED_FILES) {
    const entry = byPath.get(requiredPath);
    if (!entry) throw new Error(`Required MLX file "${requiredPath}" not found in ${repoId} tree`);
    const bytes = typeof entry.lfs?.size === "number" ? entry.lfs.size : entry.size;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`Invalid size for MLX file "${requiredPath}" in ${repoId} tree`);
    }
    const sha256 = typeof entry.lfs?.oid === "string" && SHA256_RE.test(entry.lfs.oid)
      ? entry.lfs.oid.toLowerCase()
      : typeof entry.oid === "string" && SHA256_RE.test(entry.oid)
        ? entry.oid.toLowerCase()
        : undefined;
    const gitOid = !sha256 && typeof entry.oid === "string" && SHA1_RE.test(entry.oid)
      ? entry.oid.toLowerCase()
      : undefined;
    files.push({
      path: requiredPath,
      bytes,
      ...(sha256 ? { sha256 } : {}),
      ...(gitOid ? { gitOid } : {}),
    });
  }
  return files;
}

async function ensureDefaultOrtRuntime(options: { stateDir?: string; dirs?: HostDirs; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<string> {
  const existing = resolveInstalledOrtPath(options);
  if (existing) return existing;
  const runtimeDir = resolveOrtRuntimeDir(options.stateDir, options.dirs, options.env);
  mkdirSync(runtimeDir, { recursive: true });
  const runtimePkg = join(runtimeDir, "package.json");
  if (!existsSync(runtimePkg)) {
    writeFileAtomicSync(runtimePkg, JSON.stringify({ name: "pi-warden-ort-runtime", private: true }, null, 2) + "\n");
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCmd, ["install", "--no-audit", "--no-fund", "--prefix", runtimeDir, "onnxruntime-node"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: options.env ?? process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out installing onnxruntime-node runtime"));
    }, 180_000);
    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(new Error("Cancelled onnxruntime-node runtime installation"));
    };
    if (options.signal) {
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.once("error", error => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Failed to run npm to install onnxruntime-node: ${error.message}`));
    });
    child.once("close", code => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`Failed to install onnxruntime-node into ${runtimeDir} (exit ${code}): ${stderr.trim()}`));
    });
  });
  const installed = join(runtimeDir, "node_modules", "onnxruntime-node");
  if (!existsSync(join(installed, "package.json"))) {
    throw new Error(`onnxruntime-node did not appear at ${installed} after npm install`);
  }
  return installed;
}

async function runDownload(selection: RuntimeSelection, options: DownloadOptions, emit: (progress: DownloadProgress) => void): Promise<DownloadResult> {
  const releaseLock = acquireDownloadLock(selection.modelDir);
  try {
    const baseUrl = (options.hfBaseUrl ?? DEFAULT_HF_BASE_URL).replace(/\/+$/, "");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const env = options.env ?? process.env;
    const headers = authHeaders(env);

    let files: ModelFileSpec[];
    let rawOnnxManifest: string | undefined;
    if (selection.runtime === "onnx") {
      const fetched = await fetchOnnxFileList(baseUrl, selection.repoId, fetchImpl, headers, options.signal);
      files = fetched.files;
      rawOnnxManifest = fetched.rawManifest;
    } else {
      files = await fetchMlxFileList(baseUrl, selection.repoId, fetchImpl, headers, options.signal);
    }

    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
    const verifiedFiles: ReadyManifestFile[] = [];
    const resumedFiles: string[] = [];
    const skippedFiles: string[] = [];
    let completedBytes = 0;

    const report = (file: string, fileIndex: number, fileDownloaded: number) => {
      const downloadedBytes = Math.min(totalBytes, completedBytes + fileDownloaded);
      const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 100;
      emit({
        runtime: selection.runtime,
        repoId: selection.repoId,
        file,
        fileIndex,
        fileCount: files.length,
        downloadedBytes,
        totalBytes,
        percent,
      });
    };

    for (let i = 0; i < files.length; i++) {
      const spec = files[i]!;
      const fileIndex = i + 1;
      const dest = safeJoinInside(selection.modelDir, spec.path);
      const partPath = `${dest}.part`;

      if (existsSync(dest) && statSync(dest).size === spec.bytes) {
        try {
          const sha256 = await verifyFileDigest(dest, spec);
          rmSync(partPath, { force: true });
          verifiedFiles.push({ path: spec.path, bytes: spec.bytes, sha256 });
          skippedFiles.push(spec.path);
          completedBytes += spec.bytes;
          report(spec.path, fileIndex, 0);
          continue;
        } catch {
          rmSync(dest, { force: true });
        }
      }

      let partSize = 0;
      if (existsSync(partPath)) {
        const size = statSync(partPath).size;
        if (size === spec.bytes) {
          try {
            const sha256 = await verifyFileDigest(partPath, spec);
            mkdirSync(dirname(dest), { recursive: true });
            renameSync(partPath, dest);
            verifiedFiles.push({ path: spec.path, bytes: spec.bytes, sha256 });
            resumedFiles.push(spec.path);
            completedBytes += spec.bytes;
            report(spec.path, fileIndex, 0);
            continue;
          } catch {
            rmSync(partPath, { force: true });
            partSize = 0;
          }
        } else if (size > 0 && size < spec.bytes) {
          partSize = size;
        } else {
          rmSync(partPath, { force: true });
          partSize = 0;
        }
      }

      const encodedPath = spec.path.split("/").map(encodeURIComponent).join("/");
      const url = `${baseUrl}/${selection.repoId}/resolve/main/${encodedPath}`;
      const requestHeaders: Record<string, string> = { ...headers };
      if (partSize > 0) requestHeaders.range = `bytes=${partSize}-`;

      let res = await fetchImpl(url, { headers: requestHeaders, ...(options.signal ? { signal: options.signal } : {}) });
      if (res.status === 416 && partSize > 0) {
        rmSync(partPath, { force: true });
        partSize = 0;
        res = await fetchImpl(url, { headers, ...(options.signal ? { signal: options.signal } : {}) });
      }
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`Failed to download ${spec.path} from ${url}: HTTP ${res.status}`);
      }
      if (!res.body) {
        throw new Error(`Empty response body downloading ${spec.path} from ${url}`);
      }

      let append = false;
      let fileDownloaded = 0;
      if (res.status === 206 && partSize > 0) {
        const contentRange = res.headers.get("content-range");
        if (contentRange && !contentRange.toLowerCase().startsWith(`bytes ${partSize}-`)) {
          rmSync(partPath, { force: true });
          throw new Error(`Unexpected Content-Range "${contentRange}" resuming ${spec.path} from byte ${partSize}`);
        }
        append = true;
        fileDownloaded = partSize;
        resumedFiles.push(spec.path);
      } else {
        partSize = 0;
        append = false;
        fileDownloaded = 0;
      }

      report(spec.path, fileIndex, fileDownloaded);
      await streamBodyToPart(res.body, partPath, append, delta => {
        fileDownloaded += delta;
        report(spec.path, fileIndex, fileDownloaded);
      });

      const etag = extractEtag(res.headers);
      let verifiedSha256: string;
      try {
        verifiedSha256 = await verifyFileDigest(partPath, spec, etag);
      } catch (error) {
        rmSync(partPath, { force: true });
        throw error;
      }

      mkdirSync(dirname(dest), { recursive: true });
      renameSync(partPath, dest);
      verifiedFiles.push({ path: spec.path, bytes: spec.bytes, sha256: verifiedSha256 });
      completedBytes += spec.bytes;
      report(spec.path, fileIndex, 0);
    }

    let ortRuntimePath: string | undefined;
    if (selection.runtime === "onnx") {
      const runtimeDir = resolveOrtRuntimeDir(options.stateDir, options.dirs, env);
      ortRuntimePath = options.ensureOrtRuntime
        ? await options.ensureOrtRuntime(runtimeDir)
        : await ensureDefaultOrtRuntime({
          ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
          ...(options.dirs !== undefined ? { dirs: options.dirs } : {}),
          env,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      if (rawOnnxManifest !== undefined) {
        writeFileAtomicSync(join(selection.modelDir, ONNX_MANIFEST_FILE), rawOnnxManifest);
      }
    }

    const readyManifest: ReadyManifest = {
      version: 1,
      runtime: selection.runtime,
      repoId: selection.repoId,
      modelId: selection.modelId,
      downloadedAt: new Date().toISOString(),
      totalBytes,
      files: verifiedFiles,
    };
    writeFileAtomicSync(join(selection.modelDir, READY_MANIFEST_FILE), JSON.stringify(readyManifest, null, 2) + "\n");

    return {
      runtime: selection.runtime,
      repoId: selection.repoId,
      modelId: selection.modelId,
      modelDir: selection.modelDir,
      files: verifiedFiles,
      totalBytes,
      resumedFiles,
      skippedFiles,
      ...(ortRuntimePath ? { ortRuntimePath } : {}),
    };
  } finally {
    releaseLock();
  }
}

export async function downloadWardenS1(config?: Partial<LocalModelConfig>, options: DownloadOptions = {}): Promise<DownloadResult> {
  const selection = selectWardenS1Runtime(config, options);
  if (selection.diagnostic) throw new Error(selection.diagnostic);

  const key = resolvePath(selection.modelDir);
  const existing = inflightDownloads.get(key);
  if (existing) {
    if (options.onProgress) existing.listeners.add(options.onProgress);
    try {
      return await existing.promise;
    } finally {
      if (options.onProgress) existing.listeners.delete(options.onProgress);
    }
  }

  const listeners = new Set<(progress: DownloadProgress) => void>();
  if (options.onProgress) listeners.add(options.onProgress);
  const emit = (progress: DownloadProgress) => {
    for (const listener of listeners) listener(progress);
  };

  const promise = runDownload(selection, options, emit).finally(() => {
    inflightDownloads.delete(key);
  });
  inflightDownloads.set(key, { promise, listeners });
  return promise;
}
