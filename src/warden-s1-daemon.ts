import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomicSync } from "./atomic.js";
import { materializeMlxDaemonScript } from "./warden-s1-mlx-worker.js";
import type {
  ChunkInput,
  DaemonStats,
  PrewarmResponse,
  SalienceResponse,
  SystemOneResponse,
} from "./warden-s1-onnx-worker.js";

export const DEFAULT_IDLE_SHUTDOWN_SEC = 1800;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 35_000;
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;
export const ONNX_MIN_TIMEOUT_MS = 15_000;
export const ONNX_DEFAULT_TIMEOUT_CUTOFF_MS = 5_000;

export type WardenS1Runtime = "mlx" | "onnx";

export function effectiveWardenS1TimeoutMs(timeoutMs: number, runtime?: WardenS1Runtime): number {
  if (runtime === "onnx" && timeoutMs <= ONNX_DEFAULT_TIMEOUT_CUTOFF_MS) {
    return Math.max(timeoutMs, ONNX_MIN_TIMEOUT_MS);
  }
  return timeoutMs;
}

export interface DaemonMetadata {
  readonly pid: number;
  readonly instanceId: string;
  readonly host: string;
  readonly port: number;
  readonly socketPath?: string;
  readonly runtime: WardenS1Runtime;
  readonly modelId: string;
  readonly modelDir: string;
  readonly startedAt: string;
  readonly idleShutdownSec: number;
  readonly token: string;
}

export interface DaemonEndpoint extends DaemonMetadata {
  readonly url: string;
  readonly stateDir: string;
}

export interface EnsureDaemonOptions {
  readonly runtime: WardenS1Runtime;
  readonly modelDir?: string;
  readonly modelId?: string;
  readonly stateDir?: string;
  readonly idleShutdownSec?: number;
  readonly ramSlots?: number;
  readonly maxTokens?: number;
  readonly pythonBin?: string;
  readonly ortPath?: string;
  readonly mockWeights?: boolean;
  readonly stepDelayMs?: number;
  readonly threads?: number;
  readonly startupTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly healthTimeoutMs?: number;
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly endpoint?: DaemonEndpoint;
  readonly stats?: DaemonStats;
  readonly reason?: string;
}

export interface DaemonRpcOptions {
  readonly sessionId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DaemonEvaluatePayload {
  readonly state: unknown;
  readonly questions: Record<string, unknown>;
  readonly model?: string;
  readonly session_id?: string;
  readonly chunks?: readonly ChunkInput[];
  readonly abstain_band?: readonly [number, number];
  readonly ephemeral_last_chunk?: boolean;
}

export interface DaemonPrewarmPayload {
  readonly state: unknown;
  readonly session_id?: string;
  readonly recheckpoint?: boolean;
  readonly chunks?: readonly ChunkInput[];
}

export interface DaemonSaliencePayload {
  readonly state?: unknown;
  readonly session_id?: string;
  readonly chunks?: readonly ChunkInput[];
}

export function defaultWardenS1StateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_WARDEN_CACHE_DIR?.trim();
  if (configured) {
    return configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : resolve(configured);
  }
  return join(homedir(), ".cache", "pi-warden");
}

export function daemonMetadataPath(stateDir: string): string {
  return join(stateDir, "warden-s1-daemon.json");
}

export function daemonLockPath(stateDir: string): string {
  return join(stateDir, "warden-s1-daemon.lock");
}

export function daemonPagesPath(stateDir: string): string {
  return join(stateDir, "pages");
}

export function daemonPidsDir(stateDir: string): string {
  return join(stateDir, "pids");
}

export function daemonPidFilePath(stateDir: string, pid: number): string {
  return join(daemonPidsDir(stateDir), `${pid}.json`);
}

export interface DaemonPidRecord {
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly runtime?: WardenS1Runtime;
}

function writeDaemonPidRecord(stateDir: string, record: DaemonPidRecord): void {
  try {
    mkdirSync(daemonPidsDir(stateDir), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(daemonPidFilePath(stateDir, record.pid), `${JSON.stringify(record)}\n`);
  } catch {
    // Best-effort PID registry write.
  }
}

function removeDaemonPidRecord(stateDir: string, pid: number, expectedInstanceId?: string): void {
  const path = daemonPidFilePath(stateDir, pid);
  if (!existsSync(path)) return;
  try {
    if (expectedInstanceId) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonPidRecord>;
      if (parsed.instanceId && parsed.instanceId !== expectedInstanceId) return;
    }
    unlinkSync(path);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      // Already removed.
    }
  }
}

function readProcessCommandLine(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
      if (raw) return raw;
    } catch {
      // Fall through to ps check.
    }
  }
  if (process.platform !== "win32") {
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isOwnedWardenS1Process(pid: number, instanceId?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (!isPidAlive(pid)) return false;
  if (process.platform === "win32") return true;
  const cmdline = readProcessCommandLine(pid);
  if (!cmdline) return false;
  if (instanceId && cmdline.includes(instanceId)) return true;
  return /warden[-_]s1|warden_s1_mlx_daemon|--instance-id/i.test(cmdline);
}

async function terminatePidWithEscalation(pid: number, sigtermWaitMs: number, sigkillWaitMs = 1000): Promise<boolean> {
  if (pid === process.pid) return false;
  if (!isPidAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already exited.
  }
  const termDeadline = Date.now() + Math.max(100, sigtermWaitMs);
  while (Date.now() < termDeadline && isPidAlive(pid)) {
    await sleep(25);
  }
  if (!isPidAlive(pid)) return true;
  // Native C++ ORT inference blocks JS SIGTERM handlers until InferenceSession.run returns; escalate to SIGKILL.
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
  const killDeadline = Date.now() + Math.max(200, sigkillWaitMs);
  while (Date.now() < killDeadline && isPidAlive(pid)) {
    await sleep(25);
  }
  return !isPidAlive(pid);
}

export async function sweepOrphanDaemonPids(
  stateDirInput: string,
  options?: { readonly keepPid?: number; readonly keepInstanceId?: string; readonly timeoutMs?: number },
): Promise<number[]> {
  const stateDir = resolve(stateDirInput);
  const pidsDir = daemonPidsDir(stateDir);
  if (!existsSync(pidsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(pidsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const reaped: number[] = [];
  const sigtermWaitMs = Math.max(200, Math.min(1000, options?.timeoutMs ?? 1000));
  for (const name of entries) {
    const filePath = join(pidsDir, name);
    let parsed: Partial<DaemonPidRecord> | undefined;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DaemonPidRecord>;
    } catch {
      try { unlinkSync(filePath); } catch {}
      continue;
    }
    const pid = parsed?.pid;
    const instanceId = typeof parsed?.instanceId === "string" ? parsed.instanceId : undefined;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }
    if (options?.keepPid === pid && (!options.keepInstanceId || options.keepInstanceId === instanceId)) {
      continue;
    }
    if (!isPidAlive(pid)) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }
    if (!isOwnedWardenS1Process(pid, instanceId)) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }
    const dead = await terminatePidWithEscalation(pid, sigtermWaitMs, 1000);
    if (dead) {
      reaped.push(pid);
      try { unlinkSync(filePath); } catch {}
    }
  }
  return reaped;
}

function removeDaemonPagesDir(stateDir: string): void {
  try {
    rmSync(daemonPagesPath(stateDir), { recursive: true, force: true });
  } catch {
    // Best-effort page directory cleanup.
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function normalizeModelDir(options: Pick<EnsureDaemonOptions, "modelDir" | "mockWeights">): string {
  if (options.modelDir && options.modelDir.trim().length > 0) return resolve(options.modelDir);
  return options.mockWeights ? "mock-weights" : "";
}

function readDaemonMetadata(stateDir: string): DaemonMetadata | null {
  const path = daemonMetadataPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonMetadata>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.instanceId === "string" &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      (parsed.runtime === "mlx" || parsed.runtime === "onnx") &&
      typeof parsed.modelId === "string" &&
      typeof parsed.modelDir === "string" &&
      typeof parsed.token === "string"
    ) {
      return parsed as DaemonMetadata;
    }
  } catch {
    return null;
  }
  return null;
}

function toEndpoint(meta: DaemonMetadata, stateDir: string): DaemonEndpoint {
  return {
    ...meta,
    url: `http://${meta.host}:${meta.port}`,
    stateDir,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timerSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timerSignal, callerSignal]) : timerSignal;
}

async function probeHealth(endpoint: DaemonEndpoint, timeoutMs = 1500): Promise<DaemonStats | null> {
  try {
    const res = await fetch(`${endpoint.url}/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as DaemonStats;
    if (body.status !== "ok" || body.instance_id !== endpoint.instanceId) return null;
    return body;
  } catch {
    return null;
  }
}

async function tryFastPath(
  stateDir: string,
  expectedRuntime: WardenS1Runtime,
  expectedModelDir: string,
  healthTimeoutMs: number,
): Promise<DaemonEndpoint | null> {
  const meta = readDaemonMetadata(stateDir);
  if (!meta) return null;
  if (meta.runtime !== expectedRuntime) return null;
  if (expectedModelDir && meta.modelDir !== expectedModelDir) return null;
  if (!isPidAlive(meta.pid)) return null;
  const ep = toEndpoint(meta, stateDir);
  const health = await probeHealth(ep, healthTimeoutMs);
  return health ? ep : null;
}

interface LockHandle {
  readonly lockDir: string;
  readonly ownerFile: string;
  readonly holderId: string;
}

function tryBreakStaleLock(lockDir: string, staleMs: number): boolean {
  const ownerFile = join(lockDir, "owner.json");
  let statMtime = 0;
  try {
    statMtime = statSync(lockDir).mtimeMs;
  } catch {
    return false;
  }
  const ageMs = Date.now() - statMtime;
  if (!existsSync(ownerFile)) {
    // Allow brief grace period for lock acquirer to finish writing owner.json.
    if (ageMs < 500) return false;
    try {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  try {
    const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { pid?: number; acquiredAt?: number };
    const ownerDead = typeof owner.pid === "number" && !isPidAlive(owner.pid);
    const expired = typeof owner.acquiredAt === "number" ? Date.now() - owner.acquiredAt > staleMs : ageMs > staleMs;
    if (ownerDead || expired) {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    if (ageMs > 500) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

async function acquireSpawnLock(
  stateDir: string,
  expectedRuntime: WardenS1Runtime,
  expectedModelDir: string,
  lockTimeoutMs: number,
  healthTimeoutMs: number,
): Promise<{ lock: LockHandle | null; existing: DaemonEndpoint | null }> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = daemonLockPath(stateDir);
  const ownerFile = join(lockDir, "owner.json");
  const holderId = randomUUID();
  const deadline = Date.now() + lockTimeoutMs;
  const staleMs = Math.max(60_000, lockTimeoutMs * 2);

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileAtomicSync(
        ownerFile,
        JSON.stringify({ pid: process.pid, holderId, acquiredAt: Date.now() }),
      );
      return { lock: { lockDir, ownerFile, holderId }, existing: null };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    const ready = await tryFastPath(stateDir, expectedRuntime, expectedModelDir, healthTimeoutMs);
    if (ready) return { lock: null, existing: ready };

    if (tryBreakStaleLock(lockDir, staleMs)) continue;
    await sleep(40 + Math.floor(Math.random() * 35));
  }

  throw new Error(`Timed out after ${lockTimeoutMs} ms waiting for Warden-S1 daemon lock at ${lockDir}`);
}

function releaseSpawnLock(lock: LockHandle): void {
  try {
    if (!existsSync(lock.ownerFile)) return;
    const owner = JSON.parse(readFileSync(lock.ownerFile, "utf8")) as { holderId?: string };
    if (owner.holderId !== lock.holderId) return;
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; never throw during unlock.
  }
}

function resolveOnnxWorkerSpawnSpec(): { command: string; prefixArgs: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const siblingJs = join(here, "warden-s1-onnx-worker.js");
  if (existsSync(siblingJs)) {
    return { command: process.execPath, prefixArgs: [siblingJs] };
  }
  const distJs = resolve(here, "../dist/warden-s1-onnx-worker.js");
  if (existsSync(distJs)) {
    return { command: process.execPath, prefixArgs: [distJs] };
  }
  const siblingTs = join(here, "warden-s1-onnx-worker.ts");
  if (existsSync(siblingTs)) {
    let tsxSpec = "tsx";
    try {
      tsxSpec = import.meta.resolve("tsx");
    } catch {
      // Fall back to bare specifier when tsx is resolved from cwd.
    }
    return { command: process.execPath, prefixArgs: ["--import", tsxSpec, siblingTs] };
  }
  throw new Error(`Warden-S1 ONNX worker entrypoint not found near ${here}`);
}

function readLogTail(logPath: string, maxChars = 1500): string {
  try {
    const raw = readFileSync(logPath, "utf8");
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
  } catch {
    return "";
  }
}

export async function ensureWardenS1Daemon(options: EnsureDaemonOptions): Promise<DaemonEndpoint> {
  const stateDir = options.stateDir ? resolve(options.stateDir) : defaultWardenS1StateDir();
  const modelDir = normalizeModelDir(options);
  if (!options.mockWeights && (!modelDir || !existsSync(modelDir))) {
    throw new Error(
      !modelDir
        ? "modelDir is required unless mockWeights is true"
        : `Warden-S1 modelDir does not exist: ${modelDir}`,
    );
  }
  const idleShutdownSec = options.idleShutdownSec ?? DEFAULT_IDLE_SHUTDOWN_SEC;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? 1500;

  const fast = await tryFastPath(stateDir, options.runtime, modelDir, healthTimeoutMs);
  if (fast) return fast;

  const { lock, existing } = await acquireSpawnLock(stateDir, options.runtime, modelDir, lockTimeoutMs, healthTimeoutMs);
  if (existing) return existing;
  if (!lock) throw new Error("Failed to acquire Warden-S1 daemon spawn lock");

  try {
    const rechecked = await tryFastPath(stateDir, options.runtime, modelDir, healthTimeoutMs);
    if (rechecked) return rechecked;

    const prior = readDaemonMetadata(stateDir);
    if (prior && isPidAlive(prior.pid)) {
      await stopWardenS1Daemon(stateDir, 5000);
    } else {
      await sweepOrphanDaemonPids(stateDir, { timeoutMs: 3000 });
    }

    const instanceId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const stateFile = daemonMetadataPath(stateDir);
    const pageDir = join(stateDir, "pages");
    const logPath = join(stateDir, "warden-s1-daemon.log");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    let command: string;
    let args: string[];
    if (options.runtime === "mlx") {
      const scriptPath = materializeMlxDaemonScript(join(stateDir, "runtime"));
      const managedMlxPython = join(stateDir, "runtime", "mlx-venv", "bin", "python3");
      command = options.pythonBin ?? (existsSync(managedMlxPython) ? managedMlxPython : "python3");
      args = [
        scriptPath,
        "--mlx-dir",
        modelDir,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--state-file",
        stateFile,
        "--page-dir",
        pageDir,
        "--idle-shutdown-sec",
        String(idleShutdownSec),
        "--token",
        token,
        "--instance-id",
        instanceId,
      ];
      if (options.modelId) args.push("--model-id", options.modelId);
      if (options.ramSlots !== undefined) args.push("--ram-slots", String(options.ramSlots));
      if (options.maxTokens !== undefined) args.push("--max-tokens", String(options.maxTokens));
    } else {
      const spec = resolveOnnxWorkerSpawnSpec();
      command = spec.command;
      args = [
        ...spec.prefixArgs,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--state-dir",
        stateDir,
        "--state-file",
        stateFile,
        "--page-dir",
        pageDir,
        "--idle-shutdown-sec",
        String(idleShutdownSec),
        "--token",
        token,
        "--instance-id",
        instanceId,
      ];
      if (options.mockWeights) args.push("--mock-weights");
      if (modelDir && modelDir !== "mock-weights") args.push("--model-dir", modelDir);
      if (options.modelId) args.push("--model-id", options.modelId);
      if (options.ortPath) args.push("--ort-path", options.ortPath);
      if (options.ramSlots !== undefined) args.push("--ram-slots", String(options.ramSlots));
      if (options.maxTokens !== undefined) args.push("--max-tokens", String(options.maxTokens));
      if (options.stepDelayMs !== undefined) args.push("--step-delay-ms", String(options.stepDelayMs));
      if (options.threads !== undefined) args.push("--threads", String(options.threads));
    }

    const logFd = openSync(logPath, "a", 0o600);
    let childPid: number | undefined;
    let exitedEarly = false;
    let exitCode: number | null = null;
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
      });
      childPid = child.pid;
      child.once("exit", (code) => {
        exitedEarly = true;
        exitCode = code;
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }

    if (!childPid) {
      throw new Error(`Failed to spawn Warden-S1 ${options.runtime} daemon (${command})`);
    }
    writeDaemonPidRecord(stateDir, {
      pid: childPid,
      instanceId,
      startedAt: new Date().toISOString(),
      runtime: options.runtime,
    });

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      const meta = readDaemonMetadata(stateDir);
      if (meta && meta.instanceId === instanceId && meta.pid === childPid) {
        const ep = toEndpoint(meta, stateDir);
        const health = await probeHealth(ep, healthTimeoutMs);
        if (health) return ep;
      }
      if (exitedEarly || !isPidAlive(childPid)) {
        removeDaemonPidRecord(stateDir, childPid, instanceId);
        const tail = readLogTail(logPath);
        throw new Error(
          `Warden-S1 ${options.runtime} daemon exited during startup (code=${String(exitCode)}): ${tail || "no log output"}`,
        );
      }
      await sleep(40);
    }

    await terminatePidWithEscalation(childPid, 500, 1000);
    removeDaemonPidRecord(stateDir, childPid, instanceId);
    const tail = readLogTail(logPath);
    throw new Error(`Timed out after ${startupTimeoutMs} ms waiting for Warden-S1 ${options.runtime} daemon: ${tail}`);
  } finally {
    releaseSpawnLock(lock);
  }
}

export async function getWardenS1DaemonStatus(stateDirInput?: string, healthTimeoutMs = 1500): Promise<DaemonStatus> {
  const stateDir = stateDirInput ? resolve(stateDirInput) : defaultWardenS1StateDir();
  const meta = readDaemonMetadata(stateDir);
  if (!meta) return { running: false, reason: "no_metadata" };
  if (!isPidAlive(meta.pid)) return { running: false, reason: "dead_pid" };
  const endpoint = toEndpoint(meta, stateDir);
  const stats = await probeHealth(endpoint, healthTimeoutMs);
  if (!stats) return { running: false, endpoint, reason: "unhealthy" };
  return { running: true, endpoint, stats };
}

export async function stopWardenS1Daemon(
  stateDirInput?: string,
  timeoutMs = 5000,
): Promise<{ stopped: boolean; pid?: number; reapedPids?: number[] }> {
  const stateDir = stateDirInput ? resolve(stateDirInput) : defaultWardenS1StateDir();
  const meta = readDaemonMetadata(stateDir);
  if (!meta) {
    const reaped = await sweepOrphanDaemonPids(stateDir, { timeoutMs });
    removeDaemonPagesDir(stateDir);
    if (reaped.length > 0) {
      return { stopped: true, pid: reaped[0]!, reapedPids: reaped };
    }
    return { stopped: false };
  }
  const endpoint = toEndpoint(meta, stateDir);

  if (isPidAlive(meta.pid)) {
    let shutdownAccepted = false;
    try {
      const res = await fetch(`${endpoint.url}/admin/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${meta.token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(Math.min(1500, timeoutMs)),
      });
      shutdownAccepted = res.ok;
    } catch {
      // Fall through immediately to SIGTERM -> SIGKILL escalation.
    }

    if (shutdownAccepted) {
      const gracefulDeadline = Date.now() + Math.min(2500, Math.max(250, Math.floor(timeoutMs * 0.5)));
      while (Date.now() < gracefulDeadline && isPidAlive(meta.pid)) {
        await sleep(25);
      }
    }

    if (isPidAlive(meta.pid) && isOwnedWardenS1Process(meta.pid, meta.instanceId)) {
      const sigtermWaitMs = Math.max(250, Math.min(1500, shutdownAccepted ? timeoutMs - 2500 : timeoutMs));
      await terminatePidWithEscalation(meta.pid, sigtermWaitMs, 1000);
    }
  }

  const mainDead = !isPidAlive(meta.pid);
  if (mainDead) {
    const cur = readDaemonMetadata(stateDir);
    if (cur && cur.instanceId === meta.instanceId) {
      try {
        unlinkSync(daemonMetadataPath(stateDir));
      } catch {
        // Already cleaned up by daemon on exit.
      }
    }
    removeDaemonPidRecord(stateDir, meta.pid, meta.instanceId);
  }

  const reaped = await sweepOrphanDaemonPids(stateDir, {
    ...(mainDead ? {} : { keepPid: meta.pid, keepInstanceId: meta.instanceId }),
    timeoutMs,
  });

  if (mainDead) {
    removeDaemonPagesDir(stateDir);
    return { stopped: true, pid: meta.pid, ...(reaped.length ? { reapedPids: reaped } : {}) };
  }
  return { stopped: false, pid: meta.pid, ...(reaped.length ? { reapedPids: reaped } : {}) };
}

async function daemonPost<T>(
  endpoint: DaemonEndpoint,
  path: string,
  payload: unknown,
  options?: DaemonRpcOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${endpoint.token}`,
    "Content-Type": "application/json",
  };
  if (options?.sessionId) headers["X-Warden-Session-Id"] = options.sessionId;
  const res = await fetch(`${endpoint.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: buildSignal(options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, options?.signal),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Warden-S1 daemon ${path} returned HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

export function daemonEvaluate(
  endpoint: DaemonEndpoint,
  payload: DaemonEvaluatePayload,
  options?: DaemonRpcOptions,
): Promise<SystemOneResponse> {
  return daemonPost<SystemOneResponse>(endpoint, "/v1/systemone", payload, options);
}

export function daemonPrewarm(
  endpoint: DaemonEndpoint,
  payload: DaemonPrewarmPayload,
  options?: DaemonRpcOptions,
): Promise<PrewarmResponse> {
  return daemonPost<PrewarmResponse>(endpoint, "/v1/prewarm", payload, options);
}

export function daemonSalience(
  endpoint: DaemonEndpoint,
  payload: DaemonSaliencePayload,
  options?: DaemonRpcOptions,
): Promise<SalienceResponse> {
  return daemonPost<SalienceResponse>(endpoint, "/v1/salience", payload, options);
}

export async function daemonStats(
  endpoint: DaemonEndpoint,
  options?: Omit<DaemonRpcOptions, "sessionId">,
): Promise<DaemonStats & { readonly recent: readonly Record<string, unknown>[] }> {
  const res = await fetch(`${endpoint.url}/stats`, {
    method: "GET",
    headers: { Authorization: `Bearer ${endpoint.token}` },
    signal: buildSignal(options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, options?.signal),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Warden-S1 daemon /stats returned HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as DaemonStats & { readonly recent: readonly Record<string, unknown>[] };
}

export function daemonEvictToDisk(
  endpoint: DaemonEndpoint,
  sessionId?: string | null,
  options?: Omit<DaemonRpcOptions, "sessionId">,
): Promise<{ evicted: unknown[]; ram_slots_used: number; disk_pages: number }> {
  return daemonPost(endpoint, "/admin/evict_to_disk", { session_id: sessionId ?? null }, options);
}

export function daemonDropSession(
  endpoint: DaemonEndpoint,
  sessionId: string,
  options?: Omit<DaemonRpcOptions, "sessionId">,
): Promise<{ dropped: boolean; session_id: string }> {
  return daemonPost(endpoint, "/admin/drop_session", { session_id: sessionId }, options);
}
