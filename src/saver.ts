/**
 * Session accounting for the context saver, so its value can be measured instead of assumed:
 * how often large outputs appear, how many were compressed, how much was removed, how many turns that removal was
 * spared from (token-turns), and how often the agent went back for the full text (a recall means the excerpt was
 * not enough). Deterministic; no requests.
 */
export interface ContextLedgerSnapshot {
  /** Single-text-block outputs at or above tailMinChars, i.e. candidates for compression. */
  large: number;
  compressed: number;
  bytesSaved: number;
  /** Assistant turns completed since the session started. */
  turns: number;
  /** Sum over turns of the bytes that were no longer in context on that turn, in rough tokens (bytes / 4). */
  tokenTurnsSaved: number;
  /** Times the agent read a stored full output after compression. */
  recalls: number;
}

export class ContextLedger {
  private large = 0;
  private compressed = 0;
  private bytesSaved = 0;
  private turns = 0;
  private tokenTurnsSaved = 0;
  private recalls = 0;
  private readonly stored = new Map<string, { recalled: boolean }>();

  candidate(): void {
    this.large++;
  }

  record(path: string, bytesSaved: number): void {
    this.compressed++;
    this.bytesSaved += bytesSaved;
    this.stored.set(path, { recalled: false });
  }

  /** One LLM turn finished: everything removed so far was absent from this turn's prompt. */
  turnEnd(): void {
    this.turns++;
    this.tokenTurnsSaved += Math.round(this.bytesSaved / 4);
  }

  /** True when `text` (a path, command, or serialized input) mentions a stored full output for the first time. */
  noteAccess(text: string): string | undefined {
    for (const [path, state] of this.stored) {
      if (!text.includes(path)) continue;
      if (!state.recalled) { state.recalled = true; this.recalls++; }
      return path;
    }
    return undefined;
  }

  snapshot(): ContextLedgerSnapshot {
    return { large: this.large, compressed: this.compressed, bytesSaved: this.bytesSaved, turns: this.turns, tokenTurnsSaved: this.tokenTurnsSaved, recalls: this.recalls };
  }

  reset(): void {
    this.large = 0; this.compressed = 0; this.bytesSaved = 0; this.turns = 0; this.tokenTurnsSaved = 0; this.recalls = 0;
    this.stored.clear();
  }
}

/** One line for /warden status. Says when there is nothing to report instead of printing zeros. */
export function formatLedger(snapshot: ContextLedgerSnapshot): string {
  if (snapshot.large === 0) return "Context saver: no tool output large enough to consider this session.";
  const kb = (snapshot.bytesSaved / 1024).toFixed(1);
  const recallRate = snapshot.compressed ? Math.round((snapshot.recalls / snapshot.compressed) * 100) : 0;
  return `Context saver: ${snapshot.large} large outputs, ${snapshot.compressed} compressed, ${kb} KB removed (~${Math.round(snapshot.bytesSaved / 4)} tokens), ~${snapshot.tokenTurnsSaved} token-turns spared over ${snapshot.turns} turns, ${snapshot.recalls} recall${snapshot.recalls === 1 ? "" : "s"} of the full output (${recallRate}%).`;
}
