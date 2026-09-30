/**
 * Verdict reuse for the action guard.
 *
 * Agents repeat themselves: on recorded sessions 2,336 of 27,368 judged calls were an exact repeat of an earlier
 * (project, tool, command) in the same session. The second judgment of an identical call in the same session almost
 * always says the same thing, and one TypeSafe request is spent on it either way. This cache answers the repeat with the
 * earlier verdict inside a short window.
 *
 * A hold is never reused: an approval dialogue, a steer, or a deny is a decision about one call, and repeating it must
 * ask again. Only allow and warn verdicts are stored, and only for an identical command (or, for a write or an edit, an
 * identical path and content hash), in the same project, inside the window.
 */
import { createHash } from "node:crypto";

/** The fields this cache reads from a verdict. Nothing else is stored or reused. */
export interface ReusableVerdict {
  level: string;
  approvedByUser?: boolean;
}

interface Entry<V> {
  at: number;
  verdict: V;
}

const MAX_ENTRIES = 256;

export class VerdictCache<V extends ReusableVerdict = ReusableVerdict> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(private readonly ttlMs: number, private readonly max = MAX_ENTRIES) {}

  /** True when an unexpired, reusable verdict is stored for `key`. */
  has(key: string, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  /** The stored verdict for `key`, or undefined when it is absent, expired, or not reusable. */
  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at >= this.ttlMs) { this.entries.delete(key); return undefined; }
    return entry.verdict;
  }

  /** Stores `verdict` for `key`. A hold, a deny, or an approved retry is never stored. */
  set(key: string, at: number, verdict: V): void {
    if (this.ttlMs <= 0) return;
    if (verdict.level === "confirm" || verdict.level === "deny") return;
    if (verdict.approvedByUser) return;
    this.entries.delete(key);
    this.entries.set(key, { at, verdict });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * The reuse key for a call: the project, the tool, and what it does. A command uses its text; a write uses the path and
 * the content hash; an edit uses the path and the hash of its replacement pairs, so an edit of the same file with new
 * content is judged again. Undefined when the call has nothing stable to key on.
 */
export function cacheKey(cwd: string, tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === "write") {
    if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
    return `${cwd}\u0000${tool}\u0000${input.path}\u0000${sha(input.content)}`;
  }
  if (tool === "edit") {
    if (typeof input.path !== "string" || !Array.isArray(input.edits)) return undefined;
    return `${cwd}\u0000${tool}\u0000${input.path}\u0000${sha(JSON.stringify(input.edits))}`;
  }
  const command = typeof input.command === "string" ? input.command
    : typeof input.code === "string" ? input.code
    : Array.isArray(input.commands) ? input.commands.map(entry => (entry as { command?: unknown })?.command).join("\n")
    : undefined;
  if (command === undefined) return undefined;
  return `${cwd}\u0000${tool}\u0000${command}`;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
