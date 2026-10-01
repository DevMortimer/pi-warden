import assert from "node:assert/strict";
import { test } from "node:test";
import { StaleResults, cacheIsCold, findStale, readOnlyCommand } from "../src/stale-results.js";

const big = (tag: string) => `${tag} `.repeat(300);
let counter = 0;
/** One assistant message with one call, followed by its result. */
function exchange(tool: string, input: Record<string, unknown>, text: string, isError = false): unknown[] {
  const id = `call-${counter++}`;
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: input }] },
    { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }], isError },
  ];
}
const ids = (messages: unknown[]) => (messages as Array<{ role: string; toolCallId?: string }>).filter(m => m.role === "toolResult").map(m => m.toolCallId!);
const textOf = (message: unknown) => ((message as { content: Array<{ text: string }> }).content[0]!).text;
/** The context a model call sees: the exchanges, then an assistant message that is about to call again. */
const context = (...parts: unknown[][]) => [...parts.flat(), { role: "assistant", content: [{ type: "text", text: "next" }] }];

test("superseded: a later identical read-only call stubs the earlier result, never the newest", () => {
  const first = exchange("read", { path: "a.ts" }, big("old"));
  const second = exchange("read", { path: "a.ts" }, big("new"));
  const stale = findStale(context(first, second));
  assert.deepEqual([...stale.keys()], [ids(first)[0]]);
  assert.equal(stale.get(ids(first)[0]!)!.reason, "superseded");
  assert.match(stale.get(ids(first)[0]!)!.text, /run the call again/);
});

test("superseded: a read-only bash command counts, a command that writes does not", () => {
  const a = exchange("bash", { command: "git status --short" }, big("one"));
  const b = exchange("bash", { command: "git status --short" }, big("two"));
  const c = exchange("bash", { command: "npm install > log" }, big("x"));
  const d = exchange("bash", { command: "npm install > log" }, big("y"));
  assert.deepEqual([...findStale(context(a, b, c, d)).keys()], [ids(a)[0]]);
  assert.equal(readOnlyCommand("cd x && git log -5 | head"), true);
  assert.equal(readOnlyCommand("cat a > b"), false);
  assert.equal(readOnlyCommand("git push"), false);
  assert.equal(readOnlyCommand("find . -delete"), false);
});

test("replaced: a later successful write of the path stubs the earlier read", () => {
  const read = exchange("read", { path: "src/a.ts" }, big("old"));
  const write = exchange("write", { path: "src/a.ts", content: "x" }, "Wrote file");
  const stale = findStale(context(read, write));
  assert.equal(stale.get(ids(read)[0]!)!.reason, "replaced");
  assert.match(stale.get(ids(read)[0]!)!.text, /Read the path again/);
});

test("edited: a later successful edit stubs the earlier read and says to read again when the text is needed", () => {
  const read = exchange("read", { path: "src/a.ts" }, big("old"));
  const edit = exchange("edit", { path: "src/a.ts", edits: [] }, "Edited");
  const stale = findStale(context(read, edit));
  assert.equal(stale.get(ids(read)[0]!)!.reason, "edited");
  assert.match(stale.get(ids(read)[0]!)!.text, /part of it is still true/);
  assert.match(stale.get(ids(read)[0]!)!.text, /Read the path again when you need the text/);
});

test("a failed write or edit, an other path, a failed result, and a short result stub nothing", () => {
  const read = exchange("read", { path: "a.ts" }, big("old"));
  const failedEdit = exchange("edit", { path: "a.ts", edits: [] }, "no match", true);
  const otherWrite = exchange("write", { path: "b.ts", content: "x" }, "Wrote");
  const short = exchange("read", { path: "c.ts" }, "tiny");
  const shortEdit = exchange("edit", { path: "c.ts", edits: [] }, "Edited");
  assert.equal(findStale(context(read, failedEdit, otherWrite, short, shortEdit)).size, 0);
});

test("a result the model has not seen yet is never stubbed", () => {
  // One assistant message calls a read and an edit of the same path: the read result is still on its way to the model.
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "a.ts" } }, { type: "toolCall", id: "e", name: "edit", arguments: { path: "a.ts", edits: [] } }] },
    { role: "toolResult", toolCallId: "r", toolName: "read", content: [{ type: "text", text: big("old") }] },
    { role: "toolResult", toolCallId: "e", toolName: "edit", content: [{ type: "text", text: "Edited" }] },
  ];
  assert.equal(findStale(messages).size, 0);
});

test("the stub set grows only at a cold point, and between points every call gets identical messages", () => {
  const stale = new StaleResults();
  const read = exchange("read", { path: "a.ts" }, big("old"));
  const edit = exchange("edit", { path: "a.ts", edits: [] }, "Edited");
  const base = context(read, edit);
  // Warm call: the result is out of date, but nothing grows.
  const warm = stale.apply(base, false);
  assert.equal(warm.messages, undefined);
  assert.equal(warm.grew, undefined);
  // Cold call: it grows.
  const cold = stale.apply(base, true);
  assert.equal(cold.grew!.stubbed, 1);
  assert.match(textOf(cold.messages![1]), /^\[pi-warden: stale result omitted/);
  // A newer result goes stale while the cache is warm: it stays in full, and the earlier part is byte-identical.
  const readB = exchange("read", { path: "b.ts" }, big("bee"));
  const editB = exchange("edit", { path: "b.ts", edits: [] }, "Edited");
  const later = context(read, edit, readB, editB);
  const first = stale.apply(later, false);
  const second = stale.apply([...later, ...exchange("bash", { command: "ls" }, "ok")], false);
  assert.equal(first.grew, undefined);
  assert.deepEqual(first.messages!.slice(0, 4), cold.messages!.slice(0, 4));
  assert.deepEqual(second.messages!.slice(0, later.length), first.messages!);
  assert.equal(textOf(first.messages![5]), big("bee"));
  // The next cold call adds the new one.
  const grown = stale.apply(later, true);
  assert.equal(grown.grew!.stubbed, 1);
  assert.equal(stale.totals.points, 2);
  assert.equal(stale.totals.stubbed, 2);
});

test("a committed stub is sent in full again when its result is no longer out of date", () => {
  const stale = new StaleResults();
  const read = exchange("read", { path: "a.ts" }, big("old"));
  const edit = exchange("edit", { path: "a.ts", edits: [] }, "Edited");
  stale.apply(context(read, edit), true);
  const branch = context(read);
  assert.equal(stale.apply(branch, false).messages, undefined);
});

test("cold: a compaction is cold by the caller, a run is cold when the cache lifetime ran out, a warming touch keeps it warm", () => {
  assert.equal(cacheIsCold({ now: 1_000_000, lastTouch: 1_000_000 - 301_000, ttlMs: 300_000 }), true);
  assert.equal(cacheIsCold({ now: 1_000_000, lastTouch: 1_000_000 - 100_000, ttlMs: 300_000 }), false);
  // No known lifetime or no known time: never proven cold.
  assert.equal(cacheIsCold({ now: 1_000_000, lastTouch: 0, ttlMs: undefined }), false);
  assert.equal(cacheIsCold({ now: 1_000_000, lastTouch: undefined, ttlMs: 300_000 }), false);
});

test("malformed input never throws", () => {
  const stale = new StaleResults();
  const bad: unknown[] = [null, undefined, 7, "text", [], {}, { role: "toolResult" }, { role: "toolResult", toolCallId: 4, content: 5 }, { role: "assistant", content: [null, { type: "toolCall" }, { type: "toolCall", id: "x", name: "read", arguments: "no" }] }, { role: "toolResult", toolCallId: "x", content: [null, { type: "text" }] }];
  assert.doesNotThrow(() => findStale(bad));
  assert.doesNotThrow(() => stale.apply(bad, true));
  assert.doesNotThrow(() => stale.apply(undefined as unknown as unknown[], true));
  assert.equal(stale.apply(bad, true).messages, undefined);
});
