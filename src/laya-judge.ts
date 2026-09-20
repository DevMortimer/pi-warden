/**
 * Laya-MLX judge adapter for pi-warden.
 *
 * Implements the pi-typesafe `Judge` interface by communicating with a long-running
 * Python subprocess that loads the Laya model once and answers questions on demand.
 *
 * Architecture:
 *   Node (LayaJudge) ←stdin/stdout JSON→ Python (laya-bridge.py)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { Judge } from "pi-typesafe";
import type { EvaluationOptions } from "pi-typesafe";
import type { Questions, SystemOneRequest } from "@typesafe-ai/sdk";
import { downloadLayaModel, layaModelDir, layaModelReady, layaVenvDir, layaVenvReady, layaVenvPython, markVenvReady, invalidateVenv } from "./laya-download.js";

const PYTHON_MIN_VERSION = [3, 11] as const;
const STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

interface PendingRequest {
  resolve: (value: { answers: Record<string, unknown>; model: string; elapsedMs: number }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A Judge backed by a local Laya-MLX model via a Python subprocess.
 *
 * Usage:
 *   const judge = await LayaJudge.create(onStatus);
 *   const result = await judge.evaluate(request);
 */
export class LayaJudge implements Judge {
  private process: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private ready = false;
  private readyPromise: Promise<void>;
  private modelName = "laya-mlx";
  private buffer = "";
  private requestCounter = 0;
  /** Resolved Python binary path; set by create() before spawnBridge(). */
  python: string | null = null;

  private constructor(private onStatus?: (msg: string) => void) {
    this.readyPromise = new Promise<void>((resolve) => {
      this._resolveReady = resolve;
    });
  }
  private _resolveReady: (() => void) | null = null;

  /**
   * Create a LayaJudge: download the model if needed, then spawn the Python bridge.
   */
  static async create(onStatus?: (msg: string) => void): Promise<LayaJudge> {
    const judge = new LayaJudge(onStatus);

    // 1. Discover a suitable Python 3.11+ binary.
    const basePython = await findPython();
    if (!basePython) {
      throw new Error(
        `laya-mlx requires Python ${PYTHON_MIN_VERSION[0]}.${PYTHON_MIN_VERSION[1]}+ but no suitable binary was found. ` +
        `Install Python ${PYTHON_MIN_VERSION[0]}.${PYTHON_MIN_VERSION[1]}+ and ensure it is on your PATH.`
      );
    }
    judge.python = basePython;

    // 2. Ensure a pi-warden-managed venv exists with laya-mlx installed.
    const venvPython = await ensureLayaVenv(basePython, onStatus);

    // 3. Download the model.
    let modelDir: string;
    if (!layaModelReady()) {
      modelDir = await downloadLayaModel(onStatus);
    } else {
      modelDir = layaModelDir();
    }

    // 4. Spawn the bridge using the venv's Python (guaranteed to have laya-mlx).
    judge.python = venvPython;
    await judge.spawnBridge(modelDir);

    return judge;
  }

  /**
   * Evaluate a SystemOneRequest — the core Judge interface method.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluate(request: SystemOneRequest, options?: EvaluationOptions): Promise<any> {
    await this.readyPromise;

    if (!this.process || !this.process.stdin || this.process.killed) {
      throw new Error("laya-mlx bridge process is not running");
    }

    const id = `r${++this.requestCounter}`;
    const timeoutMs = options?.signal ? DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

    // Build the request payload
    const payload = {
      id,
      state: request.state ?? null,
      questions: request.questions,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`laya-mlx request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Handle abort signal
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("laya-mlx request aborted"));
        }, { once: true });
      }

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve({
            model: result.model,
            answers: result.answers,
            usage: { input_tokens: 0, output_tokens: 0 },
            elapsedMs: result.elapsedMs,
          });
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      // Send the request
      try {
        this.process!.stdin!.write(JSON.stringify(payload) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`failed to write to laya-mlx bridge: ${err}`));
      }
    });
  }

  /** Shut down the Python bridge subprocess gracefully. */
  async shutdown(): Promise<void> {
    if (!this.process) return;

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("laya-mlx bridge shutting down"));
    }
    this.pending.clear();

    // Try graceful shutdown first
    if (this.process.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.end();
    }

    await new Promise<void>((resolve) => {
      if (!this.process) { resolve(); return; }
      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
        resolve();
      }, 5000);
      this.process!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.process!.kill("SIGTERM");
    });

    this.process = null;
    this.ready = false;
  }

  // ---------------------------------------------------------------------------
  // Private: bridge spawning, message handling
  // ---------------------------------------------------------------------------

  private async spawnBridge(modelDir: string): Promise<void> {
    const python = this.python ?? (await findPython()) ?? "python3";
    const bridgePath = new URL("../python/laya-bridge.py", import.meta.url).pathname;

    this.process = spawn(python, [bridgePath, modelDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    // Handle stderr (logs from the bridge)
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Forward important messages to status
      if (text.includes("loading model") || text.includes("model loaded")) {
        this.onStatus?.(text.trim());
      }
    });

    // Handle stdout (JSON responses)
    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    // Handle process exit
    this.process.on("exit", (code) => {
      this.ready = false;
      if (code !== 0 && code !== null) {
        this.onStatus?.(`laya-mlx bridge exited with code ${code}`);
      }
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`laya-mlx bridge exited with code ${code}`));
      }
      this.pending.clear();
    });

    this.process.on("error", (err) => {
      this.onStatus?.(`laya-mlx bridge error: ${err.message}`);
    });

    // Wait for the ready signal
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`laya-mlx bridge did not become ready within ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS)
      ),
    ]);
  }

  private processBuffer(): void {
    // Process complete newline-delimited JSON messages
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.handleMessage(message);
      } catch {
        // Not JSON or malformed — skip
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    // Ready signal from the bridge
    if (message.ready === true) {
      this.modelName = (typeof message.model === "string" ? message.model : "laya-mlx");
      this.ready = true;
      this._resolveReady?.();
      return;
    }

    // Error from the bridge (startup failure)
    if (typeof message.error === "string" && !message.id) {
      this.onStatus?.(`laya-mlx: ${message.error}`);
      this._resolveReady?.();
      // Ready promise resolves so callers get the error from evaluate()
      return;
    }

    // Response to a request
    const id = typeof message.id === "string" ? message.id : undefined;
    if (!id) return;

    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    if (typeof message.error === "string") {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve({
      answers: (typeof message.answers === "object" && message.answers !== null ? message.answers : {}) as Record<string, unknown>,
      model: typeof message.model === "string" ? message.model : this.modelName,
      elapsedMs: typeof message.elapsed_ms === "number" ? message.elapsed_ms : 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Python discovery: scan for versioned binaries, then fall back.
// ---------------------------------------------------------------------------

import { readdirSync } from "node:fs";

/** Minimum Python minor version required. */
const FALLBACK_PYTHONS = ["python3", "python"];

/**
 * Well-known directories where Homebrew or other package managers install Python.
 * The child_process PATH may not include these, so we scan them explicitly.
 */
const KNOWN_PYTHON_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Filename pattern: python3.X where X is one or more digits. */
const VERSIONED_RE = /^python3\.(\d+)$/;

/**
 * Scan a directory for python3.X binaries and return qualifying paths
 * sorted newest-first.  Silently skips unreadable directories.
 */
function discoverVersionedInDir(dir: string): string[] {
  try {
    const entries = readdirSync(dir);
    const found: Array<{ minor: number; path: string }> = [];
    for (const entry of entries) {
      const m = VERSIONED_RE.exec(entry);
      if (!m) continue;
      const minor = parseInt(m[1]!, 10);
      if (minor >= PYTHON_MIN_VERSION[1]) {
        found.push({ minor, path: `${dir}/${entry}` });
      }
    }
    // Newest version first (3.14 before 3.13 before 3.12 ...).
    found.sort((a, b) => b.minor - a.minor);
    return found.map(f => f.path);
  } catch (err) {
    // Directory does not exist or is not readable — expected for stale PATH entries.
    if (process.env.PI_DEBUG || process.env.NODE_DEBUG) {
      console.warn(`pi-warden: skipping unreadable Python scan directory: ${err instanceof Error ? err.message : err}`);
    }
    return [];
  }
}

/** Run `python --version` and return [major, minor] or null. */
export async function getPythonVersion(cmd: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.on("close", () => {
      const match = /^Python\s+(\d+)\.(\d+)/.exec(stdout.trim());
      if (match) resolve([parseInt(match[1]!, 10), parseInt(match[2]!, 10)]);
      else resolve(null);
    });
    child.on("error", () => resolve(null));
  });
}

/** True when the parsed version meets the minimum requirement. */
function versionOk(v: number[] | null): boolean {
  return v !== null && (v[0]! > PYTHON_MIN_VERSION[0] || (v[0] === PYTHON_MIN_VERSION[0] && v[1]! >= PYTHON_MIN_VERSION[1]));
}

/**
 * Try a single candidate path. Returns the path if its version is adequate,
 * or null otherwise.  For diagnostics, also returns the reason for rejection.
 */
async function probeCandidate(path: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const v = await getPythonVersion(path);
  if (versionOk(v)) return { ok: true, path };
  if (v === null) return { ok: false, reason: `"${path}" did not output a parseable Python version` };
  return { ok: false, reason: `"${path}" is Python ${v.join(".")}, need >= ${PYTHON_MIN_VERSION[0]}.${PYTHON_MIN_VERSION[1]}` };
}

/**
 * Collect well-known directories plus the directories that PATH entries point to,
 * so we scan every place versioned Python binaries might live.
 */
function searchDirs(): string[] {
  const dirs = new Set<string>(KNOWN_PYTHON_DIRS);
  const pathEnv = process.env.PATH ?? "";
  for (const entry of pathEnv.split(":")) {
    if (entry) dirs.add(entry);
  }
  return [...dirs];
}

/**
 * Find a Python 3.11+ binary on this machine.
 *
 * Phase 1: scan every search directory for `python3.X` files where X >= 11,
 * sort newest-first, probe each.  This covers any future Python version
 * without hardcoding names.
 *
 * Phase 2: generic `python3` / `python` on PATH and in well-known dirs.
 * These may point to an old system Python (3.9 on macOS), so they are
 * tried last.
 *
 * Exported for tests.
 */
export async function findPython(): Promise<string | null> {
  const tried: string[] = [];

  // Phase 1: versioned names discovered from directories (newest first).
  const dirs = searchDirs();
  const versioned: string[] = [];
  for (const dir of dirs) {
    for (const path of discoverVersionedInDir(dir)) {
      if (!versioned.includes(path)) versioned.push(path);
    }
  }
  for (const path of versioned) {
    tried.push(path);
    const result = await probeCandidate(path);
    if (result.ok) return result.path;
  }

  // Phase 2: generic fallback names on PATH.
  for (const name of FALLBACK_PYTHONS) {
    tried.push(name);
    const result = await probeCandidate(name);
    if (result.ok) return result.path;
  }

  // Diagnostic: log what was tried and why each candidate failed.
  console.warn(`pi-warden: Python discovery tried ${tried.length} candidates; none met >= ${PYTHON_MIN_VERSION[0]}.${PYTHON_MIN_VERSION[1]}`);
  return null;
}

// ---------------------------------------------------------------------------
// Managed virtual environment: create venv, install laya-mlx, verify import.
// ---------------------------------------------------------------------------

const LAYA_MLX_PACKAGE = "laya-mlx";

/** Check whether the given Python can `import laya_mlx`. */
async function canImportLaya(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(python, ["-c", "import laya_mlx"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    child.on("close", (code) => { resolve(code === 0); });
    child.on("error", () => { resolve(false); });
  });
}

/**
 * Ensure a pi-warden-managed venv exists with laya-mlx importable.
 * Returns the venv's Python path.
 *
 * Lifecycle:
 *  - If the venv marker exists and `import laya_mlx` works, return immediately.
 *  - Otherwise create (or recreate) the venv, install laya-mlx, verify, mark done.
 *  - If the venv directory exists but is broken (e.g. partial install), the marker
 *    is absent so it gets recreated on top of the old directory.
 */
async function ensureLayaVenv(basePython: string, onStatus?: (msg: string) => void): Promise<string> {
  const venvDir = layaVenvDir();
  const venvPy = layaVenvPython();

  // Fast path: venv exists and laya is importable.
  if (layaVenvReady() && existsSync(venvPy)) {
    if (await canImportLaya(venvPy)) return venvPy;
    // Venv marker is stale — the package was removed or corrupted.
    invalidateVenv();
  }

  // Ensure the base Python has the venv module.
  if (!(await hasVenvModule(basePython))) {
    throw new Error(
      `laya-mlx: the detected Python ("${basePython}") lacks the venv module. ` +
      `Install the python3-venv or python3-full package for your system.`
    );
  }

  onStatus?.("setting up laya-mlx Python environment...");

  // Create the venv.  If a broken venv directory exists, remove it first.
  if (existsSync(venvDir)) {
    await rmrf(venvDir);
  }
  await createVenv(basePython, venvDir);

  // Install laya-mlx into the venv.
  const installed = await pipInstall(venvPy, LAYA_MLX_PACKAGE);
  if (!installed) {
    invalidateVenv();
    throw new Error(
      `laya-mlx: failed to install ${LAYA_MLX_PACKAGE} into the managed venv. ` +
      `Check your network connection and try again.`
    );
  }

  // Verify the import actually works.
  if (!(await canImportLaya(venvPy))) {
    invalidateVenv();
    throw new Error(
      `laya-mlx: installed ${LAYA_MLX_PACKAGE} but \"import laya_mlx\" still fails. ` +
      `The package may be incompatible with this Python version.`
    );
  }

  await markVenvReady();
  onStatus?.("laya-mlx environment ready.");
  return venvPy;
}

/** Check if a Python has the venv module. */
async function hasVenvModule(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(python, ["-c", "import venv"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    child.on("close", (code) => { resolve(code === 0); });
    child.on("error", () => { resolve(false); });
  });
}

/** Create a venv at the given path using the base Python. */
async function createVenv(basePython: string, venvDir: string): Promise<void> {
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(basePython, ["-m", "venv", venvDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code !== 0) console.warn(`pi-warden: venv creation failed (exit ${code}): ${stderr.slice(0, 200)}`);
      resolve(code === 0);
    });
    child.on("error", (err) => { console.warn(`pi-warden: venv creation error: ${err.message}`); resolve(false); });
  });
  if (!ok) throw new Error(`laya-mlx: failed to create virtual environment at ${venvDir}`);
}

/** Install a package into the venv using its pip. Returns true on success. */
async function pipInstall(venvPython: string, pkg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(venvPython, ["-m", "pip", "install", "--quiet", pkg], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code !== 0) console.warn(`pi-warden: pip install ${pkg} failed (exit ${code}): ${stderr.slice(0, 200)}`);
      resolve(code === 0);
    });
    child.on("error", (err) => { console.warn(`pi-warden: pip install ${pkg} error: ${err.message}`); resolve(false); });
  });
}

/** Best-effort recursive remove.  Logs but does not throw on failure. */
async function rmrf(dir: string): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`pi-warden: could not remove ${dir}: ${err instanceof Error ? err.message : err}`);
  }
}
