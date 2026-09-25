import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildCompactSnapshot, compactAppendix, recallText } from "../src/compact.js";
import {
  applyLoopAction, emptyLoopStore, formatLoopsForUser, formatOpenLoops, LOOP_CHARS, LOOPS_CHARS, LOOPS_SHOWN, loopsFingerprint, loopsPath, openLoops,
  readLoops, writeLoops,
} from "../src/loops.js";
import type { LoopStore } from "../src/loops.js";

const NOW = Date.parse("2026-01-20T12:00:00.000Z");
const apply = (store: LoopStore, input: Record<string, unknown>) => applyLoopAction(store, input, NOW);
const added = (...texts: string[]) => texts.reduce((store, text) => apply(store, { action: "add", text }).store!, emptyLoopStore());

test("add, done, drop, and list", () => {
  const first = apply(emptyLoopStore(), { action: "add", text: "Bump the version", when: "after CI passes" });
  assert.equal(first.reply, "added #1: Bump the version (when: after CI passes)");
  const second = apply(first.store!, { action: "add", text: "Rerun the flaky upload test" });
  const third = apply(second.store!, { action: "add", text: "Reply to the review comment" });
  assert.equal(apply(third.store!, { action: "list" }).reply, [
    "Open loops:", "- #1 Bump the version (when: after CI passes)", "- #2 Rerun the flaky upload test", "- #3 Reply to the review comment",
  ].join("\n"));
  const done = apply(third.store!, { action: "done", id: 2 });
  assert.equal(done.reply, "done #2: Rerun the flaky upload test");
  assert.equal(apply(done.store!, { action: "done", id: 2 }).reply, "#2 is already done");
  assert.equal(apply(done.store!, { action: "drop", id: 3 }).reply, "not dropped: say why #3 is no longer needed");
  const dropped = apply(done.store!, { action: "drop", id: "#3", reason: "the reviewer withdrew it" });
  assert.equal(dropped.reply, "dropped #3: Reply to the review comment");
  assert.deepEqual(openLoops(dropped.store!).map(loop => loop.id), [1]);
  assert.equal(apply(dropped.store!, { action: "list" }).reply, "Open loops:\n- #1 Bump the version (when: after CI passes)\n(2 closed)");
  assert.equal(apply(dropped.store!, { action: "done", id: 9 }).reply, "no loop #9 in this session");
  assert.match(formatLoopsForUser(dropped.store!), /Closed \(2\):\n- #2 Rerun the flaky upload test: done\n- #3 Reply to the review comment: dropped, the reviewer withdrew it/);
  assert.equal(apply(emptyLoopStore(), { action: "list" }).reply, "No open loops.");
});

test("add refuses an empty or over-long loop, and an unknown action changes nothing", () => {
  assert.deepEqual(apply(emptyLoopStore(), { action: "add", text: "  " }), { reply: "not added: give the loop's text" });
  assert.match(apply(emptyLoopStore(), { action: "add", text: "x".repeat(LOOP_CHARS + 1) }).reply, /^not added: the text and the condition are at most 160/);
  assert.equal(apply(emptyLoopStore(), { action: "remember" }).store, undefined);
  assert.equal(apply(emptyLoopStore(), { action: "add", text: "Rotate the token=abcd1234abcd1234abcd1234 later" }).store!.loops[0]!.text.includes("abcd1234abcd1234abcd1234"), false, "redacted");
});

test("the open list is capped at 8 items and 600 characters, with a count of the rest", () => {
  const many = added(...Array.from({ length: 12 }, (_, index) => `Follow up on item ${index + 1}`));
  const text = formatOpenLoops(many.loops);
  assert.equal(text.split("\n").filter(line => /^- #/.test(line)).length, LOOPS_SHOWN);
  assert.match(text, /- … and 4 more \(warden_loops list\)$/);
  const long = added(...Array.from({ length: 8 }, (_, index) => `${"Check the migration notes carefully ".repeat(4)}${index}`));
  const capped = formatOpenLoops(long.loops);
  assert.ok(capped.length <= LOOPS_CHARS);
  assert.match(capped, /more \(warden_loops list\)$/);
  assert.equal(formatOpenLoops([]), "");
});

test("the fingerprint changes only when the open list changes", () => {
  const store = added("Bump the version", "Rerun the flaky test");
  assert.equal(loopsFingerprint(store.loops), loopsFingerprint(structuredClone(store).loops));
  assert.notEqual(loopsFingerprint(store.loops), loopsFingerprint(apply(store, { action: "done", id: 1 }).store!.loops));
  assert.notEqual(loopsFingerprint(store.loops), loopsFingerprint(apply(store, { action: "add", text: "Tag the release" }).store!.loops));
});

test("isolation: one file per session and project under pi-warden's data folder; a corrupt file fails closed", async () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  const agent = await mkdtemp(join(tmpdir(), "pi-warden-loops-"));
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const a = loopsPath("/work/app", "session-a");
    assert.equal(dirname(dirname(a)), join(agent, "pi-warden", "loops"));
    assert.notEqual(a, loopsPath("/work/app", "session-b"), "another session");
    assert.notEqual(a, loopsPath("/work/other", "session-a"), "another project, same session id");
    assert.equal(dirname(loopsPath("/work/app", "../../escape")), dirname(a), "a session id cannot leave the project folder");
    const store = added("Bump the version");
    await writeLoops(a, store);
    assert.deepEqual(await readLoops(a), store);
    assert.deepEqual(await readLoops(loopsPath("/work/app", "session-b")), emptyLoopStore());
    assert.deepEqual(await readLoops(loopsPath("/work/other", "session-a")), emptyLoopStore());
    assert.match(await readFile(a, "utf8"), /"text": "Bump the version"/);
    await writeFile(a, "{ torn");
    await assert.rejects(readLoops(a));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(agent, { recursive: true, force: true });
  }
});

const snapshot = (openLoopsText?: string) => buildCompactSnapshot({
  savedOutputs: [{ tool: "bash", path: "/tmp/pi-warden-saved/out-1.txt", bytes: 48_000 }],
  checks: [{ command: "npm test", passed: true, runIndex: 1, indexInRun: 0 }],
  holds: [],
  attempts: [
    { key: "a", call: "bash: npm run build", failed: true, output: "src/app.ts(3,1): error TS2304: Cannot find name 'x'.\nFound 1 error." },
    { key: "b", call: "bash: npm test", failed: false, output: "ok" },
  ],
  evidence: { mutations: 2, checks: [{ call: "npm test", passed: true }] as never, checksBeforeMutation: 1 },
  activeTask: "Fix the build",
  runs: 1,
  ...(openLoopsText ? { openLoops: openLoopsText } : {}),
});

test("the compaction appendix includes the open loops", () => {
  const loops = formatOpenLoops(added("Bump the version", "Rerun the flaky test").loops);
  const appendix = compactAppendix(snapshot(loops));
  assert.match(appendix, /### Open loops\nPromised earlier in this session and not done yet; close each with warden_loops done or drop\.\n- #1 Bump the version\n- #2 Rerun the flaky test/);
  assert.ok(appendix.indexOf("### Open loops") < appendix.indexOf("### Last checks"), "loops come before the sections the cap cuts first");
  assert.doesNotMatch(compactAppendix(snapshot()), /Open loops/);
});

test("warden_recall prints the appendix's failed, verification, and saved-output sections, word for word", () => {
  const snap = snapshot(formatOpenLoops(added("Bump the version").loops));
  const appendix = compactAppendix(snap);
  const recall = recallText(snap);
  const sections = recall.split("\n\n");
  assert.deepEqual(sections.map(section => section.split("\n", 1)[0]), ["### Tried and failed", "### Verification", "### Saved full outputs"]);
  for (const section of sections) assert.ok(appendix.includes(section), `appendix carries: ${section}`);
  assert.match(recall, /- bash: npm run build → src\/app\.ts\(3,1\): error TS2304: Cannot find name 'x'\./);
  assert.match(recall, /last passing check: npm test; code changed since last passing check: yes/);
  assert.match(recall, /bash → \/tmp\/pi-warden-saved\/out-1\.txt \(48000 bytes\)/);
  assert.doesNotMatch(recall, /Open loops|Active task|Last checks/);
  assert.equal(recallText(buildCompactSnapshot({ savedOutputs: [], checks: [], holds: [], activeTask: undefined, runs: 1 })), "Nothing recorded yet in this session: no failed attempt, no check, and no saved output.");
});
