// Loads the labelled rules cases, the rules fixture and the seed project the bench copies to a temp dir.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;

/** The rule document the bench installs as `pi-warden.md` in the temp project. */
export const RULES_FIXTURE = join(DIR, "rules.md");
/** The files the temp project starts from; edit cases use them as the current file on disk. */
export const SEED_DIR = join(DIR, "project");
export const SPLITS = ["all", "tune", "holdout"];
export const KINDS = ["violation", "near-miss", "not-applicable"];

export function loadCases() {
  const cases = JSON.parse(readFileSync(join(DIR, "cases.json"), "utf8"));
  const seen = new Set();
  for (const item of cases) {
    if (typeof item.id !== "string" || !item.id) throw new Error(`case without an id: ${JSON.stringify(item).slice(0, 80)}`);
    if (seen.has(item.id)) throw new Error(`duplicate case id ${item.id}`);
    seen.add(item.id);
    if (!SPLITS.includes(item.split) || item.split === "all") throw new Error(`${item.id}: split must be tune or holdout`);
    if (!["violation", "clean"].includes(item.label)) throw new Error(`${item.id}: label must be violation or clean`);
    if (!KINDS.includes(item.kind)) throw new Error(`${item.id}: unknown kind ${item.kind}`);
    if (item.label !== (item.kind === "violation" ? "violation" : "clean")) throw new Error(`${item.id}: label and kind disagree`);
    if (item.tool === "write" && typeof item.content !== "string") throw new Error(`${item.id}: write without content`);
    if (item.tool === "edit") {
      if (!Array.isArray(item.edits) || !item.edits.length) throw new Error(`${item.id}: edit without edits`);
      for (const edit of item.edits) {
        if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" || !edit.newText.trim()) throw new Error(`${item.id}: an edit needs oldText and a non-empty newText`);
      }
      if (item.edits.length > 1 && typeof item.expectEdit !== "string") throw new Error(`${item.id}: a multi-edit case names expectEdit`);
    }
    if (!item.rule) throw new Error(`${item.id}: no target rule`);
  }
  return cases;
}

/** The tool input the guard sees for one case. */
export function inputFor(item) {
  return item.tool === "write"
    ? { path: item.path, content: item.content }
    : { path: item.path, edits: item.edits.map(edit => ({ oldText: edit.oldText, newText: edit.newText })) };
}
