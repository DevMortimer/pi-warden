/**
 * Session accounting for the context saver, so its value can be measured instead of assumed:
 * how often large outputs appear, how many were compressed or dropped as duplicates, how much was removed, how many
 * turns that removal was spared from (token-turns), and how often the agent went back for the full text. A recall means
 * the excerpt was not enough; a whole-file recall also undoes the saving, a scoped one keeps it. Deterministic; no requests.
 */
export interface ContextLedgerSnapshot {
  /** Single-text-block outputs at or above tailMinChars, i.e. candidates for compression. */
  large: number;
  compressed: number;
  /** Results replaced by a duplicate note because an identical result already exists in this session. */
  duplicates: number;
  bytesSaved: number;
  /** Assistant turns completed since the session started. */
  turns: number;
  /** Sum over turns of the bytes that were no longer in context on that turn, in rough tokens (bytes / 4). */
  tokenTurnsSaved: number;
  /** Times the agent went back to a stored full output after compression, by kind of access. */
  recalls: number;
  recallsFull: number;
}

export type RecallKind = "full" | "scoped";

/** Serialized tool input escapes backslashes, so a Windows path must also match in its JSON form. */
function mentions(text: string, path: string): boolean {
  return text.includes(path) || text.includes(JSON.stringify(path).slice(1, -1));
}

export class ContextLedger {
  private large = 0;
  private compressed = 0;
  private duplicates = 0;
  private bytesSaved = 0;
  private turns = 0;
  private tokenTurnsSaved = 0;
  private recalls = 0;
  private recallsFull = 0;
  private readonly stored = new Map<string, { recalled: boolean; tool: string; bytes: number }>();
  /** Every sizeable text result seen this session, by content key, with the tool that produced it and its stored copy if any. */
  private readonly seen = new Map<string, { tool: string; path?: string }>();

  candidate(): void {
    this.large++;
  }

  /** `source` is the tool that produced the output and the full output's size in bytes. */
  record(path: string, bytesSaved: number, source: { tool: string; bytes: number }): void {
    this.compressed++;
    this.bytesSaved += bytesSaved;
    this.stored.set(path, { recalled: false, tool: source.tool, bytes: source.bytes });
  }

  /** Remember a result's identity so a later identical result can be dropped. `path` is set when a full copy exists. */
  remember(key: string, tool: string, path?: string): void {
    const existing = this.seen.get(key);
    if (existing && existing.path && !path) return;
    this.seen.set(key, path ? { tool, path } : { tool });
  }

  duplicateOf(key: string): { tool: string; path?: string } | undefined {
    return this.seen.get(key);
  }

  duplicate(bytesSaved: number): void {
    this.duplicates++;
    this.bytesSaved += bytesSaved;
  }

  /** One LLM turn finished: everything removed so far was absent from this turn's prompt. */
  turnEnd(): void {
    this.turns++;
    this.tokenTurnsSaved += Math.round(this.bytesSaved / 4);
  }

  /** The stored path that `text` (a path, command, or serialized input) mentions, if any. */
  storedPathIn(text: string): string | undefined {
    for (const path of this.stored.keys()) if (mentions(text, path)) return path;
    for (const entry of this.seen.values()) if (entry.path && mentions(text, entry.path)) return entry.path;
    return undefined;
  }

  /** Counts the first access to a compressed output; later accesses and duplicate-only copies are not new recalls. */
  noteAccess(text: string, kind: RecallKind = "full"): string | undefined {
    for (const [path, state] of this.stored) {
      if (!mentions(text, path)) continue;
      if (!state.recalled) { state.recalled = true; this.recalls++; if (kind === "full") this.recallsFull++; }
      return path;
    }
    return undefined;
  }

  snapshot(): ContextLedgerSnapshot {
    return { large: this.large, compressed: this.compressed, duplicates: this.duplicates, bytesSaved: this.bytesSaved, turns: this.turns, tokenTurnsSaved: this.tokenTurnsSaved, recalls: this.recalls, recallsFull: this.recallsFull };
  }

  /** Paths to temp files for cleanup at session start. Internal only — paths never leave the machine. */
  storedPaths(): string[] {
    return [...this.stored.keys()];
  }

  /** Stored full outputs, oldest first, with the tool that produced each and its size. Local only, like `storedPaths`. */
  storedOutputs(): Array<{ tool: string; path: string; bytes: number }> {
    return [...this.stored].map(([path, entry]) => ({ tool: entry.tool, path, bytes: entry.bytes }));
  }

  reset(): void {
    this.large = 0; this.compressed = 0; this.duplicates = 0; this.bytesSaved = 0; this.turns = 0; this.tokenTurnsSaved = 0; this.recalls = 0; this.recallsFull = 0;
    this.stored.clear();
    this.seen.clear();
  }
}

/** One line for /warden status. Says when there is nothing to report instead of printing zeros. */
export function formatLedger(snapshot: ContextLedgerSnapshot): string {
  if (snapshot.large === 0 && snapshot.duplicates === 0) return "Context saver: no tool output large enough to consider this session.";
  const kb = (snapshot.bytesSaved / 1024).toFixed(1);
  const recallRate = snapshot.compressed ? Math.round((snapshot.recalls / snapshot.compressed) * 100) : 0;
  const scoped = snapshot.recalls - snapshot.recallsFull;
  return `Context saver: ${snapshot.large} large outputs, ${snapshot.compressed} compressed, ${snapshot.duplicates} duplicate${snapshot.duplicates === 1 ? "" : "s"} dropped, ${kb} KB removed (~${Math.round(snapshot.bytesSaved / 4)} tokens), ~${snapshot.tokenTurnsSaved} token-turns spared over ${snapshot.turns} turns, ${snapshot.recalls} recall${snapshot.recalls === 1 ? "" : "s"} of the full output (${recallRate}%; ${snapshot.recallsFull} whole-file, ${scoped} scoped).`;
}
