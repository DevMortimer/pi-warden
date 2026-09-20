/**
 * Download laya-mlx model weights from HuggingFace with a progress bar.
 *
 * Downloads to ~/.pi/agent/pi-warden/laya/ using an atomic staging strategy:
 * files are written to a .staging subdirectory first, then promoted to the final
 * location only after all files are present and the required files are validated.
 * A .done marker signals a complete, validated checkpoint.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const HF_API = "https://huggingface.co";
const MODEL_REPO = "aac6fef/laya-mlx";
const LAYA_DIR_NAME = "laya";

/**
 * Files that must exist for a valid checkpoint.
 * Checked after download; missing files trigger a re-download.
 */
const REQUIRED_FILES = [
  "model.safetensors",
  "encoder/config.json",
  "mlx_config.json",
  "tokenizer/tokenizer.json",
  "tokenizer/tokenizer_config.json",
  "manifest.json",
];

/** The directory where model weights are stored. */
export function layaModelDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, LAYA_DIR_NAME);
}

/** Marker file that signals a complete, validated download. */
function doneMarker(dir: string): string {
  return join(dir, ".done");
}

/**
 * True when the model directory exists, the .done marker is present,
 * and all required files are on disk with non-zero size.
 */
export function layaModelReady(): boolean {
  const dir = layaModelDir();
  if (!existsSync(doneMarker(dir))) return false;
  return validateCheckpoint(dir);
}

/** Validate that all required checkpoint files exist with non-zero size. */
function validateCheckpoint(dir: string): boolean {
  for (const file of REQUIRED_FILES) {
    const path = join(dir, file);
    try {
      const st = statSync(path);
      if (st.size === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

interface HfFile {
  path: string;
  size: number;
}

/**
 * Fetch all files in the repo with their sizes.
 *
 * Uses two HuggingFace endpoints because neither alone gives us everything:
 * - `/api/models/{repo}` siblings: full file list (including nested paths like
 *   `encoder/config.json`) but no sizes.
 * - `/api/models/{repo}/tree/{ref}/{path}`: sizes for files in one directory,
 *   but only returns direct children (not recursive).
 *
 * Strategy: get the full list from siblings, then walk each directory subtree
 * via /tree to fill in sizes.
 */
async function listRepoFiles(repo: string): Promise<HfFile[]> {
  // 1. Get the complete file list from siblings (includes nested paths).
  const metaUrl = `${HF_API}/api/models/${repo}`;
  const metaResp = await fetchWithTimeout(metaUrl, 15_000);
  if (!metaResp.ok) throw new Error(`HuggingFace API ${metaResp.status}: ${metaResp.statusText}`);
  const meta = (await metaResp.json()) as { siblings?: Array<{ rfilename: string }> };
  if (!meta.siblings) throw new Error("no siblings in model info");

  const allPaths = meta.siblings
    .map(s => s.rfilename)
    .filter(p => typeof p === "string" && p.length > 0);
  if (allPaths.length === 0) throw new Error("model repo has no files");

  // 2. Collect directory paths that need size lookups.
  const dirs = new Set<string>();
  for (const p of allPaths) {
    const slash = p.indexOf("/");
    if (slash !== -1) dirs.add(p.slice(0, slash));
  }

  // 3. Fetch sizes from /tree for each directory (root + subdirs).
  const sizes = new Map<string, number>();
  const fetchTree = async (dirPath: string) => {
    const treeUrl = `${HF_API}/api/models/${repo}/tree/main${dirPath ? "/" + dirPath : ""}`;
    const resp = await fetchWithTimeout(treeUrl, 15_000);
    if (!resp.ok) return; // non-fatal: we'll download without size info
    const entries = (await resp.json()) as Array<{ path: string; size?: number; type?: string }>;
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (typeof e.path === "string" && typeof e.size === "number" && e.size > 0 && e.type !== "directory") {
        // /tree returns repo-relative paths (e.g. "encoder/config.json"),
        // not paths relative to the queried directory.
        sizes.set(e.path, e.size);
      }
    }
  };

  // Fetch root + all known subdirectories in parallel.
  await Promise.all([fetchTree(""), ...[...dirs].map(d => fetchTree(d))]);

  // 4. Build the final file list.  Files without a size from /tree get size 0
  //    (the download will still work; the progress bar just won't know the total
  //    for that file).
  return allPaths
    .filter(p => !p.endsWith("/")) // skip pure directories
    .map(p => ({ path: p, size: sizes.get(p) ?? 0 }));
}

/** Download a single file with progress tracking. */
async function downloadFile(
  url: string,
  dest: string,
  totalBytes: number,
  progress: { downloaded: number; total: number; filesDone: number; filesTotal: number },
  onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  const response = await fetchWithTimeout(url, 60_000);
  if (!response.ok) throw new Error(`download ${url}: ${response.status}`);
  if (!response.body) throw new Error(`no body for ${url}`);

  const fileStream = createWriteStream(dest);
  try {
    const reader = response.body.getReader();
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        fileStream.write(result.value);
        progress.downloaded += result.value.length;
        onProgress(progress.downloaded, progress.total);
      }
    }
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
  } catch (err) {
    fileStream.destroy();
    throw err;
  }
}

/** fetch with a timeout (using AbortController). */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download the laya-mlx model. Shows a progress bar in the terminal.
 * Returns the model directory path.
 *
 * Uses atomic staging: files are written to a .staging subdirectory,
 * then promoted to the final location only after all files download
 * successfully.  An interrupted download leaves .staging behind, which
 * is cleaned up on the next startup.
 *
 * @param onStatus - callback for status messages
 */
export async function downloadLayaModel(onStatus?: (msg: string) => void): Promise<string> {
  const dir = layaModelDir();

  if (layaModelReady()) return dir;

  // Clean up any leftover staging directory from a previous interrupted download.
  const stagingDir = `${dir}.staging`;
  await rm(stagingDir, { recursive: true, force: true }).catch((err) => {
    console.warn(`pi-warden: could not clean staging dir: ${err instanceof Error ? err.message : err}`);
  });

  // If the final dir exists but is incomplete, remove it so we start fresh.
  if (existsSync(dir) && !validateCheckpoint(dir)) {
    onStatus?.("incomplete model cache detected; re-downloading...");
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      console.warn(`pi-warden: could not remove incomplete model dir: ${err instanceof Error ? err.message : err}`);
    });
  }

  mkdirSync(stagingDir, { recursive: true });

  onStatus?.("please wait, downloading laya-mlx model...");

  // 1. List files from the repo.
  const files = await listRepoFiles(MODEL_REPO);
  if (files.length === 0) throw new Error("HuggingFace returned no files for the model repo");
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  // 2. Download each file into the staging directory.
  const progress = { downloaded: 0, total: totalBytes, filesDone: 0, filesTotal: files.length };
  const lastReport = { bytes: 0, time: Date.now() };

  const onProgress = (downloaded: number, total: number) => {
    const now = Date.now();
    if (now - lastReport.time < 200 && downloaded < total) return;
    lastReport.bytes = downloaded;
    lastReport.time = now;

    const pct = total > 0 ? (downloaded / total) * 100 : 0;
    const mb = (downloaded / (1024 * 1024)).toFixed(1);
    const totalMb = (total / (1024 * 1024)).toFixed(1);
    const barLen = 30;
    const filled = Math.round((pct / 100) * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    process.stderr.write(`\r  ${bar} ${pct.toFixed(0)}% (${mb}/${totalMb} MB)`);
  };

  for (const file of files) {
    const fileUrl = `${HF_API}/${MODEL_REPO}/resolve/main/${file.path}`;
    const dest = join(stagingDir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    await downloadFile(fileUrl, dest, file.size, progress, onProgress);
    progress.filesDone++;
  }

  process.stderr.write("\n");

  // 3. Validate required files in the staging directory.
  if (!validateCheckpoint(stagingDir)) {
    await rm(stagingDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`pi-warden: could not clean staging dir after validation failure: ${err instanceof Error ? err.message : err}`);
    });
    throw new Error("laya-mlx: download completed but required checkpoint files are missing");
  }

  // 4. Promote staging to final location (atomic on the same filesystem).
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      console.warn(`pi-warden: could not remove old model dir before promote: ${err instanceof Error ? err.message : err}`);
    });
  }
  await rename(stagingDir, dir);

  // 5. Write done marker.
  writeFileSync(doneMarker(dir), JSON.stringify({ files: files.map(f => f.path), totalBytes, downloadedAt: new Date().toISOString() }));
  await chmod(doneMarker(dir), 0o600);

  onStatus?.("laya-mlx model ready.");
  return dir;
}

// ---------------------------------------------------------------------------
// Managed virtual environment for Laya.
// ---------------------------------------------------------------------------

/**
 * The directory where the pi-warden-managed Laya virtual environment lives.
 * Uses the same agent dir as the model, keeping all Laya state together.
 */
export function layaVenvDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "laya-venv");
}

/** Marker file that signals a working venv with laya importable. */
function venvDoneMarker(dir: string): string {
  return join(dir, ".done");
}

/** True when the venv exists and has laya importable. */
export function layaVenvReady(): boolean {
  return existsSync(venvDoneMarker(layaVenvDir()));
}

/** The Python executable inside the venv. */
export function layaVenvPython(): string {
  return join(layaVenvDir(), "bin", "python3");
}

/** Mark the venv as ready after successful installation. */
export async function markVenvReady(): Promise<void> {
  const marker = venvDoneMarker(layaVenvDir());
  writeFileSync(marker, JSON.stringify({ createdAt: new Date().toISOString() }));
  await chmod(marker, 0o600);
}

/** Remove the venv done marker so the next startup rebuilds it. */
export function invalidateVenv(): void {
  const marker = venvDoneMarker(layaVenvDir());
  try {
    statSync(marker);
    unlinkSync(marker);
  } catch (err) {
    console.warn(`pi-warden: could not invalidate venv marker: ${err instanceof Error ? err.message : err}`);
  }
}
