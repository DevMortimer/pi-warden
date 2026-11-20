import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { mkdir, opendir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeSafeIntegrationError } from "pi-typesafe";
import { defaultHostDirs } from "../host-dirs.js";
import type { Attempt } from "../stuck.js";
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
/** Results of one prompt the stuck-check numbers; past this it records nothing more for that prompt. */
const ATTEMPT_LIMIT = 10_000;
/** Characters of redacted output an attempt keeps for the stuck evidence. */
export const ATTEMPT_TEXT_LIMIT = 8000;
/** An attempt with that output and its other clipped fields stays under this even when JSON escapes every character. */
const ATTEMPT_BYTES = 96 * 1024;

/** Empty exclusive markers are reservations, including when their creating process crashes. */
function marker(path: string): boolean {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new TypeSafeIntegrationError("budget", "Cannot persist a session reservation; no request was submitted.");
  }
}

export type HostName = "claude" | "codex";

type MarkerKind = "processed" | "sensitive" | "notice" | "evidence" | "done" | "attempt" | "repeat" | "stuck";

/** Each prompt numbers its own results, so a new prompt starts an empty window as in Pi. */
const promptDirectory = (prompt: string): string => digest(prompt).slice(0, 16);

const STRINGS = ["tool", "key", "outputKey", "call", "output", "text"] as const;
const FLAGS = ["failed", "changes", "readOnly", "poll"] as const;

function storedAttempt(raw: unknown): Attempt | undefined {
  if (!object(raw) || raw.version !== 1) return undefined;
  if (STRINGS.some(field => typeof raw[field] !== "string") || FLAGS.some(field => typeof raw[field] !== "boolean")) return undefined;
  if ((raw.text as string).length > ATTEMPT_TEXT_LIMIT || (raw.unreported !== undefined && raw.unreported !== true)) return undefined;
  const change = raw.change;
  if (change !== undefined && (!object(change) || typeof change.path !== "string" || typeof change.diff !== "string"
    || !Number.isSafeInteger(change.added) || !Number.isSafeInteger(change.removed))) return undefined;
  return {
    tool: raw.tool as string, key: raw.key as string, outputKey: raw.outputKey as string, call: raw.call as string,
    failed: raw.failed as boolean, output: raw.output as string, changes: raw.changes as boolean, readOnly: raw.readOnly as boolean,
    poll: raw.poll as boolean, text: raw.text as string, ...(raw.unreported === true ? { unreported: true as const } : {}),
    ...(object(change) ? { change: { path: change.path as string, added: change.added as number, removed: change.removed as number, diff: change.diff as string } } : {}),
  };
}

/** One directory per host session; every record in it is created exclusively, so parallel hook processes never rewrite a shared file. */
export class HostState {
  readonly directory: string;
  constructor(host: HostName, session: string, private readonly maxRequests: number, private readonly signal: AbortSignal) {
    this.directory = join(defaultHostDirs().agentDir, "pi-warden", "state", host, digest(session));
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
    if (!object(raw) || raw.version !== 1 || raw.maxRequests !== this.maxRequests) throw new Error("Session budget is incomplete or changed.");
  }

  once(kind: MarkerKind, identity: string): boolean {
    this.signal.throwIfAborted();
    return marker(join(this.directory, `${kind}-${digest(identity)}.claim`));
  }

  /** Whether `once` has already claimed this identity, without claiming it. */
  claimed(kind: MarkerKind, identity: string): boolean {
    this.signal.throwIfAborted();
    return existsSync(join(this.directory, `${kind}-${digest(identity)}.claim`));
  }

  reserveRequest(): void {
    for (let index = 0; index < this.maxRequests; index++) {
      this.signal.throwIfAborted();
      if (marker(join(this.directory, `request-${index}.claim`))) return;
    }
    throw new TypeSafeIntegrationError("budget", "Session request budget reached; no request was submitted.");
  }

  /**
   * Exclusive numbered files keep the order calls finished in, without a shared file that is read and rewritten. A full
   * session records nothing more and its Stop skips the done-check; the rules judgment of the same call still runs.
   */
  recordEvidence(identity: string, record: EvidenceRecord): void {
    if (!this.once("evidence", identity)) return;
    this.append(index => `evidence-${index}.json`, JSON.stringify({ version: 1, ...record }), EVIDENCE_LIMIT);
  }

  /** Writes `text` to the first numbered file nobody created yet and returns its number; undefined when all are taken. */
  private append(name: (index: number) => string, text: string, limit: number): number | undefined {
    for (let index = 0; index < limit; index++) {
      this.signal.throwIfAborted();
      let fd: number;
      try { fd = openSync(join(this.directory, name(index)), "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try { writeFileSync(fd, text); }
      finally { closeSync(fd); }
      return index;
    }
    return undefined;
  }

  /**
   * One tool result of one agent's window of the prompt `prompt`, numbered like the evidence records so the stuck-check
   * reads the results in the order their hooks finished. Undefined for a replayed call, or when the agent has no free
   * number left. The directory is made here because a hook of the previous prompt may record after the sweep below.
   */
  recordAttempt(prompt: string, agent: string | undefined, identity: string, attempt: Attempt): number | undefined {
    if (!this.once("attempt", identity)) return undefined;
    const text = JSON.stringify({ version: 1, ...attempt });
    if (Buffer.byteLength(text) > ATTEMPT_BYTES) throw new Error("Stuck-check attempt exceeds its byte limit.");
    this.signal.throwIfAborted();
    mkdirSync(this.attemptDirectory(prompt, agent), { recursive: true, mode: 0o700 });
    return this.append(index => join(this.attemptPath(prompt, agent), `${index}.json`), text, ATTEMPT_LIMIT);
  }

  /** The agent's results of the prompt numbered from `first` to `last`, oldest first. One a crashed hook left empty or invalid is skipped. */
  async attempts(prompt: string, agent: string | undefined, first: number, last: number): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    for (let index = Math.max(0, first); index <= last; index++) {
      const text = await readText(join(this.attemptDirectory(prompt, agent), `${index}.json`), this.signal, ATTEMPT_BYTES);
      if (text === undefined) continue;
      let raw: unknown;
      try { raw = JSON.parse(text); }
      catch { continue; }
      const attempt = storedAttempt(raw);
      if (attempt) attempts.push(attempt);
    }
    return attempts;
  }

  /** Records in the order they were claimed. A record a crashed hook left empty or invalid is not evidence. */
  async evidence(): Promise<EvidenceRecord[]> {
    const records: EvidenceRecord[] = [];
    for (let index = 0; ; index++) {
      if (index >= EVIDENCE_LIMIT) throw new Error("Session evidence is full; done-check skipped.");
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
    const id = randomUUID();
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, id, task }), { mode: 0o600, flag: "wx", signal: this.signal });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    await this.dropAttempts(id);
  }

  /**
   * Removes the results of every earlier prompt. This is what bounds the session directory: the numbers are never read
   * again once the window moved on, and a hook of a swept prompt only re-creates its own directory until the next prompt.
   */
  private async dropAttempts(keep: string): Promise<void> {
    const root = join(this.directory, "attempts");
    const entries = await opendir(root).catch(() => undefined);
    if (!entries) return;
    let checked = 0;
    for await (const entry of entries) {
      this.signal.throwIfAborted();
      if (entry.name !== promptDirectory(keep)) await rm(join(root, entry.name), { recursive: true, force: true });
      if (++checked >= 128) break;
    }
  }

  private attemptPath(prompt: string, agent: string | undefined): string {
    return join("attempts", promptDirectory(prompt), digest(agent ?? "").slice(0, 16));
  }

  private attemptDirectory(prompt: string, agent: string | undefined): string {
    return join(this.directory, this.attemptPath(prompt, agent));
  }

  async prompt(): Promise<PromptRecord | undefined> {
    const text = await readText(join(this.directory, "prompt.json"), this.signal, 16 * 1024);
    if (text === undefined) return undefined;
    const raw: unknown = JSON.parse(text);
    if (!object(raw) || raw.version !== 1 || typeof raw.id !== "string" || !/^[a-f0-9-]{36}$/.test(raw.id) || typeof raw.task !== "string" || raw.task.length > TASK_LIMIT) throw new Error("Invalid prompt record.");
    return { id: raw.id, task: raw.task };
  }

  async capture(identity: string, value: unknown): Promise<void> {
    const path = join(this.directory, "targets", `${digest(identity)}.json`);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Edit capture exceeds its byte limit.");
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
