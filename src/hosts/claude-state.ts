import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, writeFileSync } from "node:fs";
import { mkdir, opendir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeSafeIntegrationError } from "pi-typesafe";
import { defaultHostDirs } from "../host-dirs.js";
import { object, readText } from "./io.js";

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Empty exclusive markers are reservations, including when their creating process crashes. */
function marker(path: string): boolean {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new TypeSafeIntegrationError("budget", "Cannot persist a Claude session reservation; no request was submitted.");
  }
}

export class ClaudeState {
  readonly directory: string;
  constructor(session: string, private readonly maxRequests: number, private readonly signal: AbortSignal) {
    this.directory = join(defaultHostDirs().agentDir, "pi-warden", "state", "claude", digest(session));
  }

  async prepare(): Promise<void> {
    this.signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const targets = join(this.directory, "targets");
    await mkdir(targets, { recursive: true, mode: 0o700 });
    const entries = await opendir(targets);
    let checked = 0;
    for await (const entry of entries) {
      this.signal.throwIfAborted();
      if (/^[a-f0-9]{64}\.json(?:\.claimed-[a-f0-9-]+)?$/.test(entry.name)) {
        const path = join(targets, entry.name);
        const info = await stat(path).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 600_000) await rm(path, { force: true });
      }
      if (++checked >= 128) break;
    }
    const path = join(this.directory, "budget.json");
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, maxRequests: this.maxRequests })); }
      finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const raw: unknown = JSON.parse((await readText(path, this.signal, 256)) ?? "null");
    if (!object(raw) || raw.version !== 1 || raw.maxRequests !== this.maxRequests) throw new Error("Claude session budget is incomplete or changed.");
  }

  once(kind: "processed" | "sensitive" | "notice", identity: string): boolean {
    this.signal.throwIfAborted();
    return marker(join(this.directory, `${kind}-${digest(identity)}.claim`));
  }

  reserveRequest(): void {
    for (let index = 0; index < this.maxRequests; index++) {
      this.signal.throwIfAborted();
      if (marker(join(this.directory, `request-${index}.claim`))) return;
    }
    throw new TypeSafeIntegrationError("budget", "Claude session request budget reached; no request was submitted.");
  }

  async capture(identity: string, value: unknown): Promise<void> {
    const path = join(this.directory, "targets", `${digest(identity)}.json`);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Claude Edit capture exceeds its byte limit.");
    try {
      await writeFile(path, text, { mode: 0o600, flag: "wx", signal: this.signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async consume(identity: string): Promise<unknown> {
    const path = join(this.directory, "targets", `${digest(identity)}.json`);
    const claimed = `${path}.claimed-${randomUUID()}`;
    try { await rename(path, claimed); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try { return JSON.parse((await readText(claimed, this.signal, 256 * 1024)) ?? "null"); }
    finally { await rm(claimed, { force: true }); }
  }
}
