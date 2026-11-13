import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, writeFileSync } from "node:fs";
import { mkdir, opendir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeSafeIntegrationError } from "pi-typesafe";
import { defaultHostDirs } from "../host-dirs.js";
import { object, readText } from "./io.js";

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A done-check fact: a project file change, or a check run with its redacted, clipped command. */
export interface EvidenceRecord { outcome: "mutation" | "check-pass" | "check-fail"; call?: string }
/** The latest prompt, redacted; its id scopes the done-check to one judgment per prompt. */
export interface PromptRecord { id: string; task: string }

/** Bounds the done-check's read at Stop well inside the hook deadline; a fuller session is not judged. */
const EVIDENCE_LIMIT = 10_000;
const CALL_LIMIT = 256;
/** A clipped call stays under this even when JSON escapes every character. */
const RECORD_BYTES = 4096;
export const TASK_LIMIT = 2000;

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

  once(kind: "processed" | "sensitive" | "notice" | "evidence" | "done", identity: string): boolean {
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

  /**
   * Exclusive numbered files keep the order calls finished in, without a shared file that is read and rewritten. A full
   * session records nothing more and its Stop skips the done-check; the rules judgment of the same call still runs.
   */
  recordEvidence(identity: string, record: EvidenceRecord): void {
    if (!this.once("evidence", identity)) return;
    const text = JSON.stringify({ version: 1, ...record });
    for (let index = 0; index < EVIDENCE_LIMIT; index++) {
      this.signal.throwIfAborted();
      let fd: number;
      try { fd = openSync(join(this.directory, `evidence-${index}.json`), "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try { writeFileSync(fd, text); }
      finally { closeSync(fd); }
      return;
    }
  }

  /** Records in the order they were claimed. A record a crashed hook left empty or invalid is not evidence. */
  async evidence(): Promise<EvidenceRecord[]> {
    const records: EvidenceRecord[] = [];
    for (let index = 0; ; index++) {
      if (index >= EVIDENCE_LIMIT) throw new Error("Claude session evidence is full; done-check skipped.");
      const text = await readText(join(this.directory, `evidence-${index}.json`), this.signal, RECORD_BYTES);
      if (text === undefined) return records;
      let raw: unknown;
      try { raw = JSON.parse(text); }
      catch { continue; }
      if (!object(raw) || raw.version !== 1 || !["mutation", "check-pass", "check-fail"].includes(raw.outcome as string)) continue;
      if (raw.call !== undefined && (typeof raw.call !== "string" || raw.call.length > CALL_LIMIT)) continue;
      records.push({ outcome: raw.outcome as EvidenceRecord["outcome"], ...(typeof raw.call === "string" ? { call: raw.call } : {}) });
    }
  }

  /** Replaced whole by rename: one prompt at a time per session, so the newest write is the prompt in force. */
  async recordPrompt(task: string): Promise<void> {
    const path = join(this.directory, "prompt.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, id: randomUUID(), task }), { mode: 0o600, flag: "wx", signal: this.signal });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async prompt(): Promise<PromptRecord | undefined> {
    const text = await readText(join(this.directory, "prompt.json"), this.signal, 16 * 1024);
    if (text === undefined) return undefined;
    const raw: unknown = JSON.parse(text);
    if (!object(raw) || raw.version !== 1 || typeof raw.id !== "string" || !/^[a-f0-9-]{36}$/.test(raw.id) || typeof raw.task !== "string" || raw.task.length > TASK_LIMIT) throw new Error("Invalid Claude prompt record.");
    return { id: raw.id, task: raw.task };
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
