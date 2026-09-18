import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVEL_COLOR, parseVerdictLine, widgetLines } from "../src/widget.js";
import type { ThemeLike } from "../src/widget.js";

/** A theme that marks every tone in the text, so an assertion can check the hierarchy and not only the words. */
const marks: Record<string, string> = { text: "T", muted: "m", dim: "d", success: "S", warning: "W", error: "E" };
const theme: ThemeLike = { fg: (color: string, text: string) => `<${marks[color] ?? color}>${text}</>`, bold: (text: string) => `<b>${text}</>` };
const plain = (lines: readonly string[]) => lines.map(line => line.replace(/<\/?[A-Za-z]*>/g, ""));

const allow = { guard: "action", line: "warden · bash · irreversible 0.20 · off-task 0.10 · expected step · allow" };

test("the verdict leads the status line as a chip and the warden prefix is gone", () => {
  const lines = widgetLines([allow], theme);
  assert.deepEqual(plain(lines), ["ALLOW action"], "one line for one guard, and it reads from the verdict");
  assert.equal(LEVEL_COLOR.allow, "success");
  assert.match(lines[0]!, /^<b><S>ALLOW<\/><\/> <m>action<\/>$/, "the chip is bold and takes the level's tone; the guard is muted behind it");
});

test("a verdict the guard found nothing in folds into one line per verdict, naming the guards that spoke", () => {
  const lines = plain(widgetLines([
    allow,
    { guard: "rules", line: "warden · rules · write src/clean.ts · 2 rules · none · ok" },
    { guard: "prose", line: "warden · prose · wordy 0.36 · clichés 0.09 · jargon 0.19 · ok" },
  ], theme));
  assert.deepEqual(lines, ["ALLOW action", "OK    rules · prose"], "three quiet guards cost two lines, not three");
  assert.ok(!lines.join("\n").includes("wordy"), "the folded line drops the scores the guard found nothing in; the trace sidebar keeps them");
});

test("a quiet verdict with a caveat keeps its own line", () => {
  const lines = plain(widgetLines([
    { guard: "action", line: "warden · bash · typesafe error · allow" },
    { guard: "prose", line: "warden · prose · typesafe error · ok" },
    { guard: "rules", line: "warden · rules · write src/r.ts · 2 rules · none · ok" },
  ], theme));
  assert.deepEqual(lines, ["OK    rules", "ALLOW action bash · typesafe error", "OK    prose  typesafe error"], "a degraded judgment is never reported as a plain OK");
  assert.equal(plain(widgetLines([{ guard: "action", line: "warden · bash · user approved · allow" }], theme))[0], "ALLOW action bash · user approved", "an approval is not folded away either");
  const slop = plain(widgetLines([
    { guard: "action", line: "warden · write · slop: stub 0.92, hedging 0.75 · allow" },
    { guard: "action", line: "warden · write · slop: none · allow" },
  ], theme));
  assert.deepEqual(slop, ["ALLOW action", "ALLOW action write · slop: stub 0.92, hedging 0.75"], "a named symptom keeps its line; `slop: none` is the absence of one and folds");
});

test("the worst verdict ends nearest the editor", () => {
  const lines = plain(widgetLines([
    { guard: "stuck", line: "warden · stuck · 3 failures · exact repeat · stuck" },
    { guard: "action", line: "warden · bash · irreversible 0.90 · off-task 0.95 · unrelated · warn" },
    { guard: "done", line: "warden · done-check · 1 changes · 0/0 checks passed · claims done 0.92 · claims verified 0.10 · checks apply 0.90 · complete · unverified" },
  ], theme));
  assert.deepEqual(lines.map(line => line.split(" ")[0]), ["WARN", "UNVERIFIED", "STUCK"], "warnings first, the error last, where the eye already is");
});

test("a line without a verdict keeps the guard in the rail and no chip", () => {
  const lines = widgetLines([{ guard: "context", line: "warden · context · bash · duplicate · saved 1024 bytes" }], theme);
  assert.deepEqual(plain(lines), ["context bash · duplicate · saved 1024 bytes"], "nothing to judge, no chip column");
  assert.match(lines[0]!, /^<m>context<\/> <T>bash<\/>/, "the guard is the rail when there is no verdict");
});

test("the rail and the guard column are as wide as their widest entry, so bodies line up", () => {
  const lines = plain(widgetLines([
    { guard: "action", line: "warden · bash · off-task 0.95 · unrelated · warn" },
    { guard: "done", line: "warden · done-check · 1 changes · claims done 0.92 · complete · unverified" },
  ], theme));
  assert.deepEqual(lines, ["WARN       action bash · off-task 0.95 · unrelated", "UNVERIFIED done   done-check · 1 changes · claims done 0.92 · complete"], "the chip rail and the guard column pad to the longest of each");
});

test("body segments read as data: subject in the text tone, labels muted, values bright", () => {
  const line = widgetLines([{ guard: "action", line: "warden · bash · irreversible 0.90 · unrelated · warn" }], theme)[0]!;
  assert.match(line, /<T>bash<\/><d> · <\/><m>irreversible <\/><T>0\.90<\/><d> · <\/><m>unrelated<\/>/, "the tool leads in the text tone and each score keeps its label dim");
});

test("a two-word verdict overflows its column instead of pushing the rail right", () => {
  const lines = plain(widgetLines([
    { guard: "action", line: "warden · bash · off-task 0.95 · unrelated · warn" },
    { guard: "runaway", line: "warden · runaway · text · 7× repeated · 520 chars · block · stopped, recovering" },
  ], theme));
  assert.deepEqual(lines, ["WARN action  bash · off-task 0.95 · unrelated", "STOPPED, RECOVERING runaway text · 7× repeated · 520 chars · block"], "the common chips keep a narrow rail and the rare long one takes the width it needs");
});

test("a narrow pane wraps a body under its own column", () => {
  const bare: ThemeLike = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const lines = widgetLines([{ guard: "action", line: "warden · write · irreversible 0.09 · off-task 0.95 · unrelated · off task · warn" }], bare, 40);
  assert.deepEqual(lines, ["WARN action write · irreversible 0.09 ·", "            off-task 0.95 · unrelated ·", "            off task"], "a continuation keeps the body column, so it reads as the same event and not a second one");
  assert.ok(lines.every(line => line.length <= 40), "no line is wider than the pane");
});

test("parseVerdictLine takes the verdict only where the template ends on a known level", () => {
  assert.deepEqual(parseVerdictLine("warden · rules · write src/r.ts · 2 rules · none · ok", "rules"), { status: "ok", body: ["write src/r.ts", "2 rules", "none"] }, "the guard's own name is not repeated in the body");
  assert.deepEqual(parseVerdictLine("warden · bash · irreversible 0.33 · allow", "action"), { status: "allow", body: ["bash", "irreversible 0.33"] }, "an action line names its tool, not the guard");
  assert.deepEqual(parseVerdictLine("warden · context · bash · saved 12 bytes", "context"), { body: ["bash", "saved 12 bytes"] }, "no level token, no verdict");
  assert.deepEqual(parseVerdictLine("22:44:54 bash → allow · irr 0.33", "action"), { body: ["22:44:54 bash → allow", "irr 0.33"] }, "a template that keeps the level mid-line has no chip to lead with");
});
