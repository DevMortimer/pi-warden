/**
 * Open loops: things the agent promised to do later in this session ("after CI passes, bump the version"). The agent
 * adds and closes them with the `warden_loops` tool; warden keeps them in one small file per session under its data
 * folder, so they survive compaction and resume, and shows the open ones in the compaction appendix, in one reminder at
 * the end of a run, and in one message on resume. Code only, no Jev request. A loop never reaches another session or
 * another project: the file is keyed by both.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userConfigPath } from "./config.js";
import { redact } from "./redact.js";

export const LOOP_CHARS = 160;
/** Open loops shown in the appendix, the reminder, and the resume message. */
export const LOOPS_SHOWN = 8;
export const LOOPS_CHARS = 600;
/** A session with this many open loops is tracking tasks, not promises; one more is refused until some close. */
const MAX_OPEN = 30;

export type LoopAction = "add" | "done" | "drop" | "list";
export const LOOP_ACTIONS: readonly LoopAction[] = ["add", "done", "drop", "list"];

export interface Loop {
  id: number;
  /** Redacted, at most LOOP_CHARS characters. */
  text: string;
  /** The condition that makes it due, such as "after CI passes"; redacted. */
  when?: string;
  status: "open" | "done" | "dropped";
  /** Why a dropped loop was dropped; redacted. */
  reason?: string;
  at: number;
  closedAt?: number;
}

export interface LoopStore {
  next: number;
  loops: Loop[];
}

export function emptyLoopStore(): LoopStore {
  return { next: 1, loops: [] };
}

/**
 * One file per session, in a folder per project: the working directory's hash keeps another project's session with the
 * same id apart, and the id keeps another session of this project apart.
 */
export function loopsPath(cwd: string, session: string): string {
  const project = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(dirname(userConfigPath()), "loops", project, `${session.replace(/[^\w.-]/g, "_")}.json`);
}

const isLoop = (value: unknown): value is Loop => {
  const loop = value as Loop;
  return typeof loop === "object" && loop !== null && typeof loop.id === "number" && typeof loop.text === "string" && typeof loop.at === "number"
    && (loop.status === "open" || loop.status === "done" || loop.status === "dropped");
};

/** A missing file is an empty store; an unreadable or malformed one throws, so a write never replaces loops it could not read. */
export async function readLoops(path: string): Promise<LoopStore> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLoopStore();
    throw error;
  }
  const raw = JSON.parse(text) as { next?: unknown; loops?: unknown };
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.loops)) throw new Error("the loops file has no loops list");
  const loops = raw.loops.filter(isLoop);
  const next = typeof raw.next === "number" ? raw.next : Math.max(0, ...loops.map(loop => loop.id)) + 1;
  return { next, loops };
}

/** Written whole to a temporary file and renamed, so a crash never leaves half a file. */
export async function writeLoops(path: string, store: LoopStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export const openLoops = (store: LoopStore): Loop[] => store.loops.filter(loop => loop.status === "open");

const oneLine = (text: string) => redact(text.replace(/\s+/g, " ").trim());
const loopLine = (loop: Loop) => `- #${loop.id} ${loop.text}${loop.when ? ` (when: ${loop.when})` : ""}`;

/**
 * The open loops, oldest first, at most LOOPS_SHOWN lines and LOOPS_CHARS characters; whole lines only, with a count of
 * the ones left out. Empty when none is open.
 */
export function formatOpenLoops(loops: readonly Loop[]): string {
  const open = loops.filter(loop => loop.status === "open");
  const lines: string[] = [];
  let length = 0;
  for (const loop of open.slice(0, LOOPS_SHOWN)) {
    const line = loopLine(loop);
    // Room for the count line of the ones left out.
    if (length + line.length + 1 > LOOPS_CHARS - 40) break;
    lines.push(line);
    length += line.length + 1;
  }
  if (lines.length < open.length) lines.push(`- … and ${open.length - lines.length} more (warden_loops list)`);
  return lines.join("\n");
}

/** The open list as it stands: a reminder already sent for the same list is not sent again. */
export function loopsFingerprint(loops: readonly Loop[]): string {
  return loops.filter(loop => loop.status === "open").map(loop => `${loop.id}:${loop.text}:${loop.when ?? ""}`).join("\n");
}

export interface LoopInput {
  action?: unknown;
  text?: unknown;
  when?: unknown;
  id?: unknown;
  reason?: unknown;
}

/** Applies one `warden_loops` call. `store` is undefined when nothing changes. */
export function applyLoopAction(store: LoopStore, input: LoopInput, now: number): { reply: string; store?: LoopStore } {
  const action = typeof input.action === "string" ? input.action : "";
  if (action === "list") {
    const open = openLoops(store);
    const closed = store.loops.length - open.length;
    return { reply: open.length ? `Open loops:\n${formatOpenLoops(open)}${closed ? `\n(${closed} closed)` : ""}` : `No open loops${closed ? ` (${closed} closed)` : ""}.` };
  }
  if (action === "add") {
    const text = typeof input.text === "string" ? oneLine(input.text) : "";
    const when = typeof input.when === "string" ? oneLine(input.when) : "";
    if (!text) return { reply: "not added: give the loop's text" };
    if (text.length > LOOP_CHARS || when.length > LOOP_CHARS) return { reply: `not added: the text and the condition are at most ${LOOP_CHARS} characters each` };
    if (openLoops(store).length >= MAX_OPEN) return { reply: `not added: ${MAX_OPEN} loops are open; close the finished ones with done or drop first` };
    const loop: Loop = { id: store.next, text, ...(when ? { when } : {}), status: "open", at: now };
    return { reply: `added #${loop.id}: ${text}${when ? ` (when: ${when})` : ""}`, store: { next: store.next + 1, loops: [...store.loops, loop] } };
  }
  if (action === "done" || action === "drop") {
    const id = typeof input.id === "number" ? input.id : typeof input.id === "string" ? Number(input.id.replace(/^#/, "")) : NaN;
    const loop = store.loops.find(entry => entry.id === id);
    if (!loop) return { reply: `no loop #${Number.isFinite(id) ? id : "?"} in this session` };
    if (loop.status !== "open") return { reply: `#${loop.id} is already ${loop.status}` };
    const reason = typeof input.reason === "string" ? oneLine(input.reason).slice(0, LOOP_CHARS) : "";
    if (action === "drop" && !reason) return { reply: `not dropped: say why #${loop.id} is no longer needed` };
    const closed: Loop = { ...loop, status: action === "done" ? "done" : "dropped", ...(reason && action === "drop" ? { reason } : {}), closedAt: now };
    return {
      reply: `${action === "done" ? "done" : "dropped"} #${loop.id}: ${loop.text}`,
      store: { ...store, loops: store.loops.map(entry => entry.id === loop.id ? closed : entry) },
    };
  }
  return { reply: `unknown action; use one of ${LOOP_ACTIONS.join(", ")}` };
}

/** `/warden loops`: every loop of the session, open first, with how each closed. */
export function formatLoopsForUser(store: LoopStore): string {
  if (!store.loops.length) return "No loops in this session. The agent adds one with warden_loops when it promises to do something later.";
  const open = openLoops(store);
  const closed = store.loops.filter(loop => loop.status !== "open");
  return [
    open.length ? `Open loops (${open.length}):` : "No open loops.",
    ...open.map(loopLine),
    ...(closed.length ? [`Closed (${closed.length}):`, ...closed.map(loop => `${loopLine(loop)}: ${loop.status}${loop.reason ? `, ${loop.reason}` : ""}`)] : []),
  ].join("\n");
}
