import assert from "node:assert/strict";
import { test } from "node:test";
import { SWAP_LIMIT_CHARS, SeenText, TAIL_KEEP_CHARS, collapseRuns, savedResultIn, seenItem, seenItems } from "../src/dedupe.js";

const report = (lines: number, tag = "report") => Array.from({ length: lines }, (_, index) => `${tag} line ${index}: the build of module ${index} passed with no warnings at all`).join("\n");
const fresh = (chars: number) => Array.from({ length: Math.ceil(chars / 50) }, (_, index) => `new status line ${index} ${"n".repeat(28)}`).join("\n");

test("a report pasted again inside a new text is found once, with where the earlier copy is", () => {
  const seen = new SeenText();
  seen.add(report(40), "an earlier subagent message");
  const text = `Turn 3 report\n${report(40)}\n${fresh(2500)}`;
  const runs = seen.find(text);
  assert.equal(runs.length, 1);
  assert.deepEqual({ start: runs[0]!.start, lines: runs[0]!.lines, where: runs[0]!.where }, { start: 1, lines: 40, where: "an earlier subagent message" });
  const collapsed = collapseRuns(text, runs, "/tmp/full.txt");
  assert.match(collapsed, /^Turn 3 report\n\[pi-warden: the next 40 lines repeat an earlier subagent message — omitted; full text: \/tmp\/full\.txt\]\nnew status line 0/);
  assert.ok(collapsed.endsWith(fresh(2500)));
});

test("trailing spaces do not break a match; a changed line does", () => {
  const seen = new SeenText();
  seen.add(report(40), "an earlier bash result");
  const spaced = report(40).split("\n").map(line => `${line}   `).join("\n");
  assert.equal(seen.find(`${spaced}\n${fresh(2500)}`).length, 1);
  // One changed line in the middle leaves two halves of 20 and 19 lines: each is under 1500 characters, so nothing is cut.
  const changed = report(40).split("\n");
  changed[20] = changed[20]!.replace("passed", "FAILED");
  assert.deepEqual(seen.find(`${changed.join("\n")}\n${fresh(2500)}`), []);
});

test("a run under 20 lines or 1500 characters is kept", () => {
  const seen = new SeenText();
  const short = Array.from({ length: 30 }, (_, index) => `ok ${index}`).join("\n");
  seen.add(short, "an earlier bash result");
  seen.add(report(19), "an earlier read result");
  assert.deepEqual(seen.find(`${short}\n${fresh(2500)}`), [], "30 lines but few characters");
  assert.deepEqual(seen.find(`${report(19)}\n${fresh(2500)}`), [], "many characters but 19 lines");
});

test("the last 2000 characters are never cut", () => {
  const seen = new SeenText();
  seen.add(report(100), "an earlier user message");
  const text = report(100);
  const runs = seen.find(text);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.start, 0);
  assert.ok(runs[0]!.lines < 100, "the run stops before the tail");
  const collapsed = collapseRuns(text, runs, "/tmp/full.txt");
  assert.ok(collapsed.endsWith(text.slice(-TAIL_KEEP_CHARS)));
  // A text whose repeat sits wholly in its tail is unchanged.
  assert.deepEqual(seen.find(report(30)), []);
});

test("two separate runs from different sources each get their own pointer", () => {
  const seen = new SeenText();
  seen.add(report(30, "alpha"), "an earlier bash result");
  seen.add(report(30, "beta"), "an earlier user message");
  const text = `${report(30, "beta")}\nbetween\n${report(30, "alpha")}\n${fresh(2500)}`;
  const runs = seen.find(text);
  assert.deepEqual(runs.map(run => [run.start, run.lines, run.where]), [[0, 30, "an earlier user message"], [31, 30, "an earlier bash result"]]);
  const collapsed = collapseRuns(text, runs, "/tmp/f");
  assert.equal(collapsed.split("\n").slice(0, 3).join("|"), "[pi-warden: the next 30 lines repeat an earlier user message — omitted; full text: /tmp/f]|between|[pi-warden: the next 30 lines repeat an earlier bash result — omitted; full text: /tmp/f]");
});

test("sync adds new entries once and rebuilds when an entry leaves the context", () => {
  const seen = new SeenText();
  const first = { id: "a", type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: report(40) }] } };
  const second = { id: "b", type: "custom_message", customType: "subagent-report", content: "short" };
  seen.sync([seenItem(first)!, seenItem(second)!]);
  const text = `${report(40)}\n${fresh(2500)}`;
  assert.equal(seen.find(text)[0]!.where, "an earlier bash result");
  // A compaction drops the first entry: its text is no longer in context and nothing may point to it.
  seen.sync([seenItem(second)!]);
  assert.deepEqual(seen.find(text), []);
});

test("seenItem reads user, assistant, tool, and custom texts, never images", () => {
  assert.deepEqual(seenItem({ id: "u", type: "message", message: { role: "user", content: "hi" } }), { key: "u", where: "an earlier user message", texts: ["hi"] });
  assert.deepEqual(seenItem({ id: "c", type: "custom_message", customType: "relay", content: [{ type: "text", text: "x" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }), { key: "c", where: "an earlier relay message", texts: ["x"] });
  assert.equal(seenItem({ id: "s", type: "compaction", summary: "…" }), undefined);
});

test("seenItems leaves out a claude-bridge tool result over the output limit, by the provider that called it", () => {
  const call = (id: string, provider?: string) => ({ id, type: "message", message: { role: "assistant", ...(provider ? { provider } : {}), content: [] } });
  const result = (id: string, chars: number) => ({ id, type: "message", message: { role: "toolResult", toolName: "tiny_fetch", content: [{ type: "text", text: "x".repeat(chars) }] } });
  const keys = (entries: unknown[], provider?: string) => seenItems(entries, provider).map(item => item.key);
  const large = SWAP_LIMIT_CHARS + 1;
  assert.deepEqual(keys([call("a1", "claude-bridge"), result("r1", large), result("r2", SWAP_LIMIT_CHARS)]), ["a1", "r2"]);
  // A result an earlier provider gave to the model stays seen after a switch to claude-bridge.
  assert.deepEqual(keys([call("a1", "anthropic"), result("r1", large)], "claude-bridge"), ["a1", "r1"]);
  // With no provider on the assistant message, the current provider stands in.
  assert.deepEqual(keys([call("a1"), result("r1", large)], "claude-bridge"), ["a1"]);
  assert.deepEqual(keys([result("r1", large)], "openai"), ["r1"]);
});

test("savedResultIn names a Claude Code tool-results file only on claude-bridge", () => {
  const read = JSON.stringify({ path: "/home/u/.claude/projects/-home-u-app/5e1f0c2a/tool-results/mcp-custom-tools-tiny_fetch-3.txt", offset: 10 });
  assert.equal(savedResultIn(read, "claude-bridge"), true);
  assert.equal(savedResultIn(JSON.stringify({ command: "sed -n '1,400p' /home/u/.claude/projects/-home-u-app/5e1f/tool-results/bash-1.txt" }), "claude-bridge"), true);
  assert.equal(savedResultIn(read, "anthropic"), false);
  assert.equal(savedResultIn(read, undefined), false);
  assert.equal(savedResultIn(JSON.stringify({ path: "src/tool-results/index.ts" }), "claude-bridge"), false);
});
