/**
 * Download laya-mlx model weights from HuggingFace with a progress bar.
 *
 * Downloads to ~/.pi/agent/pi-warden/laya/ and creates a .done marker when complete.
 * A marker file avoids re-downloading on every session start.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

const HF_API = "https://huggingface.co";
const MODEL_REPO = "aac6fef/laya-mlx";
const LAYA_DIR_NAME = "laya";

/** The directory where model weights are stored. */
export function layaModelDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, LAYA_DIR_NAME);
}

/** Marker file that signals a complete download. */
function doneMarker(dir: string): string {
  return join(dir, ".done");
}

/** True when the model has already been downloaded. */
export function layaModelReady(): boolean {
  return existsSync(doneMarker(layaModelDir()));
}

interface HfFile {
  path: string;
  size: number;
}

/** Fetch the file list from HuggingFace API. */
async function listRepoFiles(repo: string): Promise<HfFile[]> {
  const url = `${HF_API}/api/models/${repo}`;
  const response = await fetchWithTimeout(url, 15_000);
  if (!response.ok) throw new Error(`HuggingFace API ${response.status}: ${response.statusText}`);
  const data = (await response.json()) as { siblings?: Array<{ rfilename: string; size?: number }> };
  if (!data.siblings) throw new Error("no siblings in model info");
  return data.siblings
    .filter((s): s is { rfilename: string; size: number } => typeof s.rfilename === "string" && typeof s.size === "number" && s.size > 0)
    .map(s => ({ path: s.rfilename, size: s.size }));
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
 * @param onStatus - callback for status messages (e.g., "Downloading model...")
 */
export async function downloadLayaModel(onStatus?: (msg: string) => void): Promise<string> {
  const dir = layaModelDir();

  if (layaModelReady()) return dir;

  mkdirSync(dir, { recursive: true });

  onStatus?.("please wait, downloading laya-mlx model...");

  // 1. List files
  const files = await listRepoFiles(MODEL_REPO);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  // 2. Download each file with progress
  const progress = { downloaded: 0, total: totalBytes, filesDone: 0, filesTotal: files.length };
  const lastReport = { bytes: 0, time: Date.now() };

  const onProgress = (downloaded: number, total: number) => {
    const now = Date.now();
    // Update at most every 200ms to avoid terminal thrash
    if (now - lastReport.time < 200 && downloaded < total) return;
    lastReport.bytes = downloaded;
    lastReport.time = now;

    const pct = total > 0 ? (downloaded / total) * 100 : 0;
    const mb = (downloaded / (1024 * 1024)).toFixed(1);
    const totalMb = (total / (1024 * 1024)).toFixed(1);
    // Simple progress bar
    const barLen = 30;
    const filled = Math.round((pct / 100) * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    process.stderr.write(`\r  ${bar} ${pct.toFixed(0)}% (${mb}/${totalMb} MB)`);
  };

  for (const file of files) {
    const fileUrl = `${HF_API}/${MODEL_REPO}/resolve/main/${file.path}`;
    const dest = join(dir, file.path);
    await downloadFile(fileUrl, dest, file.size, progress, onProgress);
    progress.filesDone++;
  }

  process.stderr.write("\n");

  // 3. Write done marker
  writeFileSync(doneMarker(dir), JSON.stringify({ files: files.map(f => f.path), totalBytes, downloadedAt: new Date().toISOString() }));
  await chmod(doneMarker(dir), 0o600);

  onStatus?.("laya-mlx model ready.");
  return dir;
}
