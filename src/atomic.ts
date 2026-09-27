/**
 * Whole-file writes and per-file queues for pi-warden's small JSON stores. Two operations on one store in one process
 * share no temporary name and do not interleave: every write goes to a temporary file that belongs to this process and
 * this write, then a rename puts it in place, and every read-modify-write of one file runs through a queue keyed by that
 * path. Cross-process locking is out of scope: a second process writing the same store can still lose this process's
 * update, and nothing here stops it.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let writes = 0;

/** The temporary file one write lands in: the pid keeps two processes apart, the counter two writes within one process. */
function temporaryPath(path: string): string {
  writes += 1;
  return `${path}.${process.pid}.${writes}.tmp`;
}

/** Writes `text` to `path` through a temporary file and a rename, so a crash or a reader never sees half a file. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  await writeFile(temporary, text, { mode: 0o600 });
  // The mode applies only when the temporary file is created; force it so a leftover file cannot change the store's permissions.
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** `writeFileAtomic` for the synchronous stores, which cannot interleave with each other inside one process. */
export function writeFileAtomicSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** The tail of each path's queue: a task starts once the previous task for the same path has settled. */
const queues = new Map<string, Promise<void>>();

/**
 * Runs `task` after every earlier task for `key`, so the read-modify-write sequences that share a store file run one
 * after another instead of all reading the same old store and then writing over each other's change. A task's rejection
 * reaches its own caller and does not stop the queue.
 */
export function serialize<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
