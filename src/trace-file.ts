import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { sessionFileId } from "./holds.js";
import { redact } from "./redact.js";
import type { TraceEntry, TraceEvent } from "./trace.js";

/**
 * Trace file for hosts that run Pi without the terminal UI. The widget and the sidebar never reach an RPC host, so with
 * `PI_WARDEN_TRACE_DIR` set the trace is also appended to `<dir>/<session>.jsonl`, one JSON object per line:
 *
 * - `{"v":1,"kind":"session","sessionId","cwd","wardenVersion","mode","at"}` when the file is opened for a session;
 * - `{"v":1,"kind":"entry","id","at","guard","line","details","tokens"?}` for every trace entry, as the trace stores it;
 * - `{"v":1,"kind":"amend","id","line","at"}` for an outcome line added to an entry still in the trace.
 *
 * The file keeps every entry; the in-memory limit does not apply. A write error is reported once and ends the file for
 * the session; it never reaches a guard or a tool call.
 */
export const TRACE_DIR_ENV = "PI_WARDEN_TRACE_DIR";

/** The trace directory, or undefined when the feature is off. A relative path is not resolved against a cwd that moves. */
export function traceDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env[TRACE_DIR_ENV];
  return dir && isAbsolute(dir) ? dir : undefined;
}

export function traceFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionFileId(sessionId)}.jsonl`);
}

let version: string | undefined;
function wardenVersion(): string {
  if (version !== undefined) return version;
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    version = typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch (error) {
    console.warn("pi-warden: package version unreadable for the trace file:", error);
    version = "unknown";
  }
  return version;
}

/** The home directory as `~`, the way action summaries show a path outside the project. */
function shownPath(path: string): string {
  const home = homedir();
  return redact(path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path);
}

/** Highest entry id already in the file, so a reload or a resumed session keeps ids unique in the session's file. */
async function lastEntryId(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let last = 0;
  for (const match of text.matchAll(/^\{"v":1,"kind":"entry","id":(\d+)/gm)) last = Math.max(last, Number(match[1]));
  return last;
}

export interface TraceFileSession {
  sessionId: string;
  cwd: string;
  mode: string;
}

/** Appends the session's trace events in trace order, one write at a time. */
export class TraceFile {
  private queue: Promise<void> = Promise.resolve();
  private base = 0;
  private sequence = 0;
  private readonly ids = new WeakMap<TraceEntry, number>();
  private stopped = false;

  constructor(readonly path: string, dir: string, session: TraceFileSession, private readonly onFailure: (message: string) => void) {
    const header = { v: 1, kind: "session", sessionId: session.sessionId, cwd: shownPath(session.cwd), wardenVersion: wardenVersion(), mode: session.mode, at: new Date().toISOString() };
    this.queue = this.guarded(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      this.base = await lastEntryId(path);
      await appendFile(path, `${JSON.stringify(header)}\n`, { mode: 0o600 });
    });
  }

  /** Trace listener. The record is built now, so a later amend does not show up in the entry line. */
  readonly listener = (event: TraceEvent): void => {
    if (this.stopped || event.kind === "clear") return;
    const at = new Date().toISOString();
    if (event.kind === "push") {
      const local = ++this.sequence;
      this.ids.set(event.entry, local);
      const { at: stamp, guard, line, details, tokens } = event.entry;
      const fields = { at: new Date(stamp).toISOString(), guard, line, details: [...details], ...(tokens ? { tokens: { ...tokens } } : {}) };
      this.append(() => ({ v: 1, kind: "entry", id: this.base + local, ...fields }));
      return;
    }
    const local = this.ids.get(event.entry);
    if (local === undefined) return;
    const { line } = event;
    this.append(() => ({ v: 1, kind: "amend", id: this.base + local, line, at }));
  };

  /** Resolves when every event so far is on disk or the file has stopped. */
  flush(): Promise<void> {
    return this.queue;
  }

  private append(record: () => Record<string, unknown>): void {
    this.queue = this.guarded(() => appendFile(this.path, `${JSON.stringify(record())}\n`, { mode: 0o600 }));
  }

  private guarded(write: () => Promise<void>): Promise<void> {
    return this.queue.then(() => this.run(write));
  }

  private async run(write: () => Promise<void>): Promise<void> {
    if (this.stopped) return;
    try {
      await write();
    } catch (error) {
      this.stopped = true;
      try {
        this.onFailure(`warden: trace file ${this.path} could not be written (${error instanceof Error ? error.message : String(error)}); no more trace lines go to it this session.`);
      } catch (reportError) {
        console.warn("pi-warden: trace file failure could not be reported:", reportError);
      }
    }
  }
}
