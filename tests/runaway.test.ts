import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import { CHECK_EVERY, findRepeats, formatRunaway, repeatedBlock, repeatedTail, RunawayMonitor, runawayNudge } from "../src/runaway.js";
import type { RunawayVerdict } from "../src/runaway.js";

const config = () => defaultConfig().runaway;

/** Shape of the observed runaway: an intent line and the same command block, over and over, with no tool call. */
const loopParagraphs = (times: number) => Array.from({ length: times }, () => "Stop. PR green. Merge. Executing:\n\n```bash\ngh pr merge 1234 --merge\n```").join("\n\n");
/** Run-on repetition without paragraph breaks, as at the start of the observed message. */
const runOn = (times: number) => "All checks passed on the PR — merging and watching the dev deploy to confirm the fix lands.".repeat(times);

/** Feeds text to the monitor in token-sized pieces and returns the first verdict. */
function stream(monitor: RunawayMonitor, kind: "text" | "thinking", text: string, options = config(), piece = 7): RunawayVerdict | undefined {
  monitor.feed({ type: `${kind}_start` });
  for (let index = 0; index < text.length; index += piece) {
    const due = monitor.feed({ type: `${kind}_delta`, delta: text.slice(index, index + piece) });
    if (!due) continue;
    const verdict = monitor.check(due, options);
    if (verdict) return verdict;
  }
  return undefined;
}

test("repeatedBlock counts identical normalised paragraphs and ignores short ones", () => {
  assert.deepEqual(repeatedBlock("```\nx\n```\n\n```\nx\n```\n\n```\nx\n```"), { count: 0, block: "" }, "code fences alone are too short to count");
  const found = repeatedBlock("Running the  whole suite now.\n\nrunning THE whole suite now.\n\nSomething else entirely here.");
  assert.equal(found.count, 2, "case and whitespace are normalised");
  assert.equal(found.block, "running the whole suite now.");
  assert.equal(repeatedBlock(loopParagraphs(6)).count, 6);
});

test("repeatedTail counts back-to-back units in run-on text and needs two windows of text", () => {
  assert.equal(repeatedTail("short").count, 0);
  const found = repeatedTail(runOn(5));
  assert.equal(found.count, 5);
  assert.match(found.block, /^all checks passed on the pr/);
  assert.equal(repeatedTail("a".repeat(50) + "b".repeat(200) + "c".repeat(60)).count, 1, "a phrase that occurs once is not a repeat");
  const mid = repeatedTail(runOn(4) + "All checks passed on the PR — merging and");
  assert.equal(mid.count, 4, "a unit cut off mid-stream still counts the complete ones before it");
  const templated = Array.from({ length: 12 }, (_, index) => `Item ${index} is documented in the section below, together with its defaults.`).join(" ");
  assert.equal(repeatedTail(templated).count, 1, "a shared suffix is not a repeated unit");
  assert.equal(repeatedTail("Header row here.\n" + "|---".repeat(40)).count, 1, "units shorter than a paragraph are ignored");
});

test("findRepeats picks the stronger signal", () => {
  assert.equal(findRepeats(loopParagraphs(5)).signal, "block");
  assert.equal(findRepeats(runOn(6)).signal, "phrase");
  assert.equal(findRepeats("One paragraph.\n\nAnother paragraph, quite different from the first one.").count, 1);
});

test("ordinary replies with tables, lists, and repeated code lines are never stopped", () => {
  const table = ["| a | b | c | d | e |", "|---|---|---|---|---|", ...Array.from({ length: 12 }, (_, index) => `| ${index} | — | — | — | — |`)].join("\n");
  const code = "```ts\n" + Array.from({ length: 10 }, (_, index) => `  expect(result[${index}]).toBe(true);\n  expect(result[${index}]).toBeDefined();`).join("\n") + "\n```";
  const list = Array.from({ length: 8 }, (_, index) => `- step ${index}: run the check and record the result`).join("\n");
  const reply = `Here is the summary.\n\n${table}\n\n${code}\n\n${list}\n\nDone.`;
  assert.ok(reply.length > config().minChars);
  assert.equal(stream(new RunawayMonitor(), "text", reply), undefined);
  assert.equal(findRepeats(reply).count, 1);
});

test("the monitor stops a looping reply once, roughly at the repeat threshold, and ignores later deltas", () => {
  const monitor = new RunawayMonitor();
  monitor.feed({ type: "start" });
  const verdict = stream(monitor, "text", loopParagraphs(30));
  assert.ok(verdict, "the loop is caught");
  assert.equal(verdict.kind, "text");
  assert.equal(verdict.signal, "block");
  // Checks run every CHECK_EVERY characters, so the count can overshoot the threshold by the repeats that fit in one window.
  assert.ok(verdict.count >= 4 && verdict.count <= 8, `stopped at ${verdict.count} repeats, not after all 30`);
  assert.ok(verdict.chars < loopParagraphs(8).length, `stopped after ${verdict.chars} chars`);
  assert.equal(monitor.stopped, true);
  assert.equal(monitor.feed({ type: "text_delta", delta: "x".repeat(CHECK_EVERY) }), "text", "feed still reports growth");
  assert.equal(monitor.check("text", config()), undefined, "but a stopped message yields no second verdict");
  monitor.feed({ type: "start" });
  assert.equal(monitor.stopped, false, "a new assistant message starts clean");
  assert.equal(monitor.streamed("text"), "");
});

test("run-on repetition without paragraph breaks is caught by the trailing phrase", () => {
  const verdict = stream(new RunawayMonitor(), "text", runOn(40));
  assert.ok(verdict);
  assert.equal(verdict.signal, "phrase");
  assert.ok(verdict.count >= 4);
});

test("thinking has its own higher threshold and text blocks are counted apart from thinking", () => {
  const monitor = new RunawayMonitor();
  assert.equal(stream(monitor, "thinking", loopParagraphs(8)), undefined, "8 repeats in thinking is code drafting, not a runaway");
  assert.equal(stream(monitor, "text", "A single ordinary sentence that says what happens next in the plan."), undefined);
  const verdict = stream(monitor, "thinking", loopParagraphs(12));
  assert.ok(verdict);
  assert.equal(verdict.kind, "thinking");
  assert.ok(verdict.count >= 10);
});

test("minChars and repeats are honoured; a message shorter than one check window is never judged", () => {
  const strict = { ...config(), repeats: 2, minChars: 50 };
  assert.equal(stream(new RunawayMonitor(), "text", loopParagraphs(3), strict), undefined, `${loopParagraphs(3).length} chars end before the first check`);
  const verdict = stream(new RunawayMonitor(), "text", loopParagraphs(6), strict);
  assert.ok(verdict);
  assert.ok(verdict.count >= 2);
  const lenient = { ...config(), repeats: 40 };
  assert.equal(stream(new RunawayMonitor(), "text", loopParagraphs(30), lenient), undefined);
  const tall = { ...config(), minChars: 100_000 };
  assert.equal(stream(new RunawayMonitor(), "text", loopParagraphs(30), tall), undefined);
});

test("nudge and widget line name the repeat and the outcome", () => {
  const verdict: RunawayVerdict = { kind: "text", count: 7, block: "stop. pr green. merge. executing:", chars: 2816, signal: "block" };
  const recovery = runawayNudge(verdict, true);
  assert.match(recovery, /repeated 7 times/);
  assert.match(recovery, /no tool was called/);
  assert.match(recovery, /call the tool with it now/);
  const halt = runawayNudge(verdict, false);
  assert.match(halt, /not restarted. Wait for the user/);
  assert.equal(formatRunaway(verdict, true), "warden · runaway · text · 7× repeated · 2816 chars · block · stopped, recovering");
  assert.equal(formatRunaway(verdict, false), "warden · runaway · text · 7× repeated · 2816 chars · block · stopped");
});
