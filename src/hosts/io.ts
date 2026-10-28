import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export const FILE_BYTES = 1024 * 1024;

/** Only controlled reasons and an escaped path may reach installer diagnostics. */
export class HostFileError extends Error {
  constructor(path: string, reason: string) {
    super(`${JSON.stringify(path)}: ${reason}`);
    this.name = "HostFileError";
  }

  static from(path: string, error: unknown): HostFileError {
    if (error instanceof HostFileError) return error;
    const code = object(error) ? error.code : undefined;
    const reason = code === "ELOOP" ? "Symbolic links are not supported for this file."
      : code === "EACCES" || code === "EPERM" ? "Permission denied."
      : code === "ENOENT" ? "File or parent directory does not exist."
      : code === "ENOTDIR" || code === "EISDIR" ? "Expected a regular file and parent directory."
      : "Cannot access this host file.";
    return new HostFileError(path, reason);
  }
}

/** Open first: a pathname size check cannot rule out a FIFO or a growing file. */
export async function readText(path: string, signal?: AbortSignal, maxBytes = FILE_BYTES): Promise<string | undefined> {
  signal?.throwIfAborted();
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const file = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw HostFileError.from(path, error);
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new HostFileError(path, "Expected a regular host file.");
    if (stat.size > maxBytes) throw new HostFileError(path, `Host file exceeds the ${maxBytes}-byte limit.`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new HostFileError(path, `Host file exceeds the ${maxBytes}-byte limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw HostFileError.from(path, error);
  } finally {
    await file.close().catch(error => { throw HostFileError.from(path, error); });
  }
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check again after preparing the replacement, so an observed outside edit is never overwritten. */
export async function replaceText(path: string, text: string, expected: string | undefined): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(error => { throw HostFileError.from(path, error); });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    if (await readText(path) !== expected) throw new HostFileError(path, "File changed during the operation; retry explicitly.");
    await rename(temporary, path);
  } catch (error) {
    throw HostFileError.from(path, error);
  } finally {
    await rm(temporary, { force: true }).catch(error => { throw HostFileError.from(path, error); });
  }
}
