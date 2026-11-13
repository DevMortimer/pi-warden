/**
 * Codex `apply_patch` input, parsed the way Codex's own lenient parser reads it (codex-rs/apply-patch): an optional
 * heredoc wrapper, `*** Begin Patch` ... `*** End Patch`, and Add, Delete or Update hunks. Only the text a patch writes
 * is read here; nothing is applied, and the file on disk is never consulted.
 */

export interface PatchChunk {
  /** Lines the chunk replaced and wrote, context lines included in both. */
  oldLines: string[];
  newLines: string[];
  /** The `+` lines alone: the text the chunk added. */
  added: string[];
}

export type PatchHunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const ENVIRONMENT = "*** Environment ID:";

class PatchError extends Error {
  constructor(message: string) {
    super(`Invalid apply_patch input: ${message}`);
    this.name = "PatchError";
  }
}

/** The patch lines between the markers; a `<<'EOF'` wrapper a model put around them is stripped, as Codex does. */
function body(patch: string): string[] {
  const lines = patch.trim().split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  const framed = (candidate: string[]): boolean => candidate.length > 0 && candidate[0]!.trim() === BEGIN && candidate[candidate.length - 1]!.trim() === END;
  if (framed(lines)) return lines;
  const [first] = lines;
  if (lines.length >= 4 && (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && lines[lines.length - 1]!.endsWith("EOF")) {
    const inner = lines.slice(1, -1);
    if (framed(inner)) return inner;
  }
  throw new PatchError("expected *** Begin Patch ... *** End Patch.");
}

export function parsePatch(patch: string): PatchHunk[] {
  const lines = body(patch);
  const hunks: PatchHunk[] = [];
  // Typed by assertion: `header` changes it, which narrowing in this function cannot see.
  let mode = "started" as "started" | "add" | "delete" | "update" | "ended";
  let endOfFile = false;
  const update = (): Extract<PatchHunk, { kind: "update" }> => hunks[hunks.length - 1] as Extract<PatchHunk, { kind: "update" }>;
  const emptyChunk = (chunk: PatchChunk | undefined): boolean => chunk !== undefined && !chunk.oldLines.length && !chunk.newLines.length;
  const closeUpdate = (): void => {
    if (mode !== "update") return;
    const { chunks } = update();
    if (!chunks.length || emptyChunk(chunks[chunks.length - 1])) throw new PatchError("an Update File hunk has no lines.");
  };
  const header = (trimmed: string): boolean => {
    if (mode === "started" && trimmed.startsWith(ENVIRONMENT)) return true;
    let next: PatchHunk | undefined;
    if (trimmed === END) { closeUpdate(); mode = "ended"; return true; }
    if (trimmed.startsWith(ADD)) next = { kind: "add", path: trimmed.slice(ADD.length), contents: "" };
    else if (trimmed.startsWith(DELETE)) next = { kind: "delete", path: trimmed.slice(DELETE.length) };
    else if (trimmed.startsWith(UPDATE)) next = { kind: "update", path: trimmed.slice(UPDATE.length), chunks: [] };
    if (!next) return false;
    closeUpdate();
    hunks.push(next);
    mode = next.kind;
    endOfFile = false;
    return true;
  };
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    const trimmed = line.trim();
    if (mode === "ended") {
      if (trimmed) throw new PatchError("text after *** End Patch.");
      continue;
    }
    if (mode === "started" || mode === "delete") {
      if (!header(trimmed)) throw new PatchError("expected an Add, Delete or Update File header.");
      continue;
    }
    if (mode === "add") {
      if (header(trimmed)) continue;
      const hunk = hunks[hunks.length - 1] as Extract<PatchHunk, { kind: "add" }>;
      if (!line.startsWith("+")) throw new PatchError("every Add File line starts with +.");
      hunk.contents += `${line.slice(1)}\n`;
      continue;
    }
    const updateLine = line.trimEnd();
    if (header(updateLine)) continue;
    const hunk = update();
    const { chunks } = hunk;
    const last = chunks[chunks.length - 1];
    const marker = updateLine === "@@" || updateLine.startsWith("@@ ");
    if (endOfFile) {
      if (!updateLine) continue;
      if (!marker) throw new PatchError("a chunk after *** End of File starts with @@.");
    }
    if (!chunks.length && hunk.movePath === undefined && updateLine.startsWith(MOVE)) {
      hunk.movePath = updateLine.slice(MOVE.length);
      continue;
    }
    if (marker) {
      if (emptyChunk(last)) throw new PatchError("an @@ chunk has no lines.");
      chunks.push({ oldLines: [], newLines: [], added: [] });
      endOfFile = false;
      continue;
    }
    if (updateLine === EOF_MARKER) {
      if (!last || emptyChunk(last)) throw new PatchError("an @@ chunk has no lines.");
      endOfFile = true;
      continue;
    }
    const kind = line === "" ? " " : line[0];
    if (kind !== " " && kind !== "+" && kind !== "-") throw new PatchError("every Update File line starts with a space, + or -.");
    if (!chunks.length) chunks.push({ oldLines: [], newLines: [], added: [] });
    const chunk = chunks[chunks.length - 1]!;
    const text = line.slice(1);
    if (kind !== "+") chunk.oldLines.push(text);
    if (kind !== "-") chunk.newLines.push(text);
    if (kind === "+") chunk.added.push(text);
  }
  if (mode !== "ended") throw new PatchError("expected *** End Patch.");
  return hunks;
}
