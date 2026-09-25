import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_STEERS, NEVER_MUTED, SteerStats, SteerWatch, assistantView, formatMuted, steerOutcome } from "../src/adaptive.js";
import type { SteerKind } from "../src/adaptive.js";
import { applyUserOverrides, defaultConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "pi-warden-adaptive-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const store = () => new SteerStats(join(dir, `stats-${files++}.json`));
const config = DEFAULT_STEERS;
const A = "provider/model-a";
const B = "provider/model-b";

/** `n` observed steers, the first `followed` of them followed and the next `disputed` disputed. */
function feed(stats: SteerStats, model: string, kind: SteerKind, n: number, followed: number, disputed = 0) {
  for (let i = 0; i < n; i++) stats.observe(model, kind, { followed: i < followed, disputed: i >= followed && i < followed + disputed }, config);
}

test("no pair is muted under 30 observed steers, however badly it does", () => {
  const stats = store();
  feed(stats, A, "intent-mismatch", 29, 0, 29);
  assert.equal(stats.pair(A, "intent-mismatch")?.muted, false);
  assert.equal(stats.request(A, "intent-mismatch", config), "send");
  assert.deepEqual(stats.muted(), []);
});

test("at 30 steers a pair is muted under 20% followed or over 40% disputed, and not at the thresholds themselves", () => {
  const followLow = store();
  feed(followLow, A, "intent-mismatch", 30, 5); // 16.7% followed
  assert.equal(followLow.pair(A, "intent-mismatch")?.muted, true);
  assert.equal(followLow.request(A, "intent-mismatch", config), "probe", "the first steer after muting is a probe");
  assert.equal(followLow.request(A, "intent-mismatch", config), "trace-only");

  const followAt = store();
  feed(followAt, A, "intent-mismatch", 30, 6); // exactly 20% followed
  assert.equal(followAt.pair(A, "intent-mismatch")?.muted, false);

  const disputed = store();
  feed(disputed, A, "rules", 30, 15, 13); // 50% followed, 43% disputed
  assert.equal(disputed.pair(A, "rules")?.muted, true);

  const disputedAt = store();
  feed(disputedAt, A, "rules", 30, 15, 12); // exactly 40% disputed
  assert.equal(disputedAt.pair(A, "rules")?.muted, false);
});

test("thresholds come from config: steers.minSteers, minFollowed, maxDisputed", () => {
  const custom = applyUserOverrides(defaultConfig(), { steers: { minSteers: 10, minFollowed: 0.5, maxDisputed: 0.1, recheckEvery: 20, probeEvery: 4 } }).steers;
  assert.deepEqual(custom, { adaptive: true, minSteers: 10, minFollowed: 0.5, maxDisputed: 0.1, recheckEvery: 20, probeEvery: 4 });
  assert.deepEqual(defaultConfig().steers, DEFAULT_STEERS);
  assert.equal(applyUserOverrides(defaultConfig(), { steers: { minFollowed: 3, minSteers: -1 } }).steers.minFollowed, 0.2, "invalid values fall back");
  const stats = store();
  for (let i = 0; i < 10; i++) stats.observe(A, "rules", { followed: i < 4, disputed: false }, custom);
  assert.equal(stats.pair(A, "rules")?.muted, true, "40% followed is under a 50% floor");
});

test("steers.adaptive false sends everything and counts nothing", () => {
  const off = { ...config, adaptive: false };
  const stats = store();
  for (let i = 0; i < 40; i++) stats.observe(A, "rules", { followed: false, disputed: true }, off);
  assert.equal(stats.pair(A, "rules"), undefined);
  feed(stats, A, "rules", 30, 0);
  assert.equal(stats.request(A, "rules", off), "send", "a muted pair is sent when adaptation is off");
});

test("the never-muted set: holds, confirm, deny, masking, the credential notice, and the done-check are counted but never muted", () => {
  for (const kind of ["hold", "confirm", "deny", "masking", "credential-notice", "done"] as const) assert.ok(NEVER_MUTED.has(kind), kind);
  for (const kind of ["intent-mismatch", "rules", "slop", "prose"] as const) assert.ok(!NEVER_MUTED.has(kind), kind);
  const stats = store();
  for (const kind of NEVER_MUTED) {
    feed(stats, A, kind, 60, 0, 60);
    assert.equal(stats.pair(A, kind)?.muted, false, kind);
    assert.equal(stats.request(A, kind, config), "send", kind);
  }
  assert.equal(stats.pair(A, "done")?.sent, 60, "the done-check's outcomes are still counted");
});

test("while muted, 1 in 5 steers is sent; every 30 steers the probes decide", () => {
  const stats = store();
  feed(stats, A, "off-task", 30, 0);
  const decisions = Array.from({ length: 30 }, () => stats.request(A, "off-task", config));
  assert.equal(decisions.filter(decision => decision === "probe").length, 6);
  assert.deepEqual(decisions.slice(0, 5), ["probe", "trace-only", "trace-only", "trace-only", "trace-only"]);
  assert.equal(stats.pair(A, "off-task")?.muted, true, "no probe outcome was observed: still muted");

  // Probes that are followed end the mute; the probe counts become the pair's counts.
  for (let i = 0; i < 30; i++) {
    if (stats.request(A, "off-task", config) === "probe") stats.observe(A, "off-task", { followed: i < 10, disputed: false }, config);
    if (i === 28) assert.equal(stats.pair(A, "off-task")?.muted, true);
  }
  const pair = stats.pair(A, "off-task")!;
  assert.equal(pair.muted, false);
  assert.deepEqual({ sent: pair.sent, followed: pair.followed }, { sent: 6, followed: 2 });
  assert.equal(stats.request(A, "off-task", config), "send");
  // A fresh 30 steers must pass before it can be muted again.
  feed(stats, A, "off-task", 23, 0);
  assert.equal(stats.pair(A, "off-task")?.muted, false);
  feed(stats, A, "off-task", 1, 0);
  assert.equal(stats.pair(A, "off-task")?.muted, true);
});

test("probes that keep failing keep the pair muted", () => {
  const stats = store();
  feed(stats, A, "slop", 30, 0);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 30; i++) if (stats.request(A, "slop", config) === "probe") stats.observe(A, "slop", { followed: false, disputed: true }, config);
    assert.equal(stats.pair(A, "slop")?.muted, true, `round ${round}`);
  }
});

test("unmute resets a pair; its steers are sent and counted from zero", () => {
  const stats = store();
  feed(stats, A, "rules", 30, 0);
  assert.equal(stats.request(A, "rules", config), "probe");
  assert.equal(stats.unmute(A, "rules"), true);
  assert.equal(stats.pair(A, "rules"), undefined);
  assert.equal(stats.request(A, "rules", config), "send");
  assert.equal(stats.unmute(A, "rules"), false, "nothing left to reset");
});

test("pairs are isolated by model id", () => {
  const stats = store();
  feed(stats, A, "intent-mismatch", 30, 0);
  feed(stats, B, "intent-mismatch", 30, 20);
  assert.equal(stats.pair(A, "intent-mismatch")?.muted, true);
  assert.equal(stats.pair(B, "intent-mismatch")?.muted, false);
  assert.equal(stats.request(B, "intent-mismatch", config), "send");
  assert.deepEqual(stats.muted().map(pair => pair.model), [A]);
  assert.deepEqual(stats.modelsWith("intent-mismatch").sort(), [A, B]);
  stats.unmute(B, "intent-mismatch");
  assert.equal(stats.pair(A, "intent-mismatch")?.muted, true, "resetting one model leaves the other");
});

test("counts persist in the stats file across instances", () => {
  const path = join(dir, "persist.json");
  const first = new SteerStats(path);
  feed(first, A, "rules", 30, 0);
  const second = new SteerStats(path);
  assert.equal(second.pair(A, "rules")?.muted, true);
  assert.match(formatMuted(second.muted(), config), /provider\/model-a: rules \(30 steers, 0% followed, 0% disputed\)/);
  assert.equal(formatMuted([], { ...config, adaptive: false }), "Adaptive steers: off.");
});

test("steerOutcome: follow and dispute heuristics per kind", () => {
  const view = (text: string, ...calls: Array<[string, Record<string, unknown>]>) => ({ text, calls: calls.map(([name, input]) => ({ name, input })) });
  assert.deepEqual(steerOutcome("done", {}, [view("Running the tests.", ["bash", { command: "npm test" }])]), { followed: true, disputed: false });
  assert.equal(steerOutcome("done", {}, [view("Done.")]).followed, false);
  assert.equal(steerOutcome("rules", { path: "src/a.ts" }, [view("", ["edit", { path: "/p/src/a.ts" }])]).followed, true);
  assert.equal(steerOutcome("rules", { path: "src/a.ts" }, [view("", ["edit", { path: "/p/src/b.ts" }])]).followed, false);
  assert.equal(steerOutcome("stuck", { call: { name: "bash", input: { command: "npm test" } } }, [view("", ["bash", { command: "npm test" }])]).followed, false);
  assert.equal(steerOutcome("stuck", { call: { name: "bash", input: { command: "npm test" } } }, [view("", ["bash", { command: "npm run build" }])]).followed, true);
  assert.deepEqual(steerOutcome("intent-mismatch", {}, [view("As I said, this matches the plan.", ["bash", { command: "ls" }])]), { followed: false, disputed: true });
  assert.equal(steerOutcome("intent-mismatch", {}, [view("Should I push now?")]).followed, true);
  assert.equal(steerOutcome("intent-mismatch", {}, [view("Back to the task: the warden note is about the push.", ["bash", { command: "git push" }])]).followed, false, "\"task\" and a mention of warden are no course change");
  assert.equal(steerOutcome("off-task", {}, [view("I will run the linter instead.", ["bash", { command: "npm run lint" }])]).followed, true);
  assert.equal(steerOutcome("conscience", { capability: { kind: "tool", id: "search_code" } }, [view("", ["search_code", {}])]).followed, true);
  assert.equal(steerOutcome("loops", {}, [view("", ["warden_loops", { action: "done", id: 1 }])]).followed, true);
});

test("SteerWatch settles after two assistant messages, early on a follow, and waits past the user for a next-turn steer", () => {
  const watch = new SteerWatch();
  watch.add(A, ["rules"], { path: "src/a.ts" });
  assert.deepEqual(watch.assistant(assistantView([{ type: "text", text: "Looking." }])), []);
  const settled = watch.assistant(assistantView([{ type: "toolCall", id: "1", name: "read", arguments: { path: "x" } }]));
  assert.deepEqual(settled, [{ model: A, kind: "rules", followed: false, disputed: false }]);

  watch.add(A, ["rules"], { path: "src/a.ts" });
  assert.equal(watch.assistant(assistantView([{ type: "toolCall", id: "2", name: "edit", arguments: { path: "src/a.ts" } }]))[0]?.followed, true);

  watch.add(A, ["intent-mismatch"]);
  assert.deepEqual(watch.user(), [], "a steer with no reply before the user spoke is dropped");

  watch.add(B, ["prose"], {}, { nextTurn: true });
  assert.deepEqual(watch.assistant(assistantView("ignored: the note waits for the next prompt")), []);
  watch.user();
  watch.assistant(assistantView("Plain reply."));
  assert.deepEqual(watch.assistant(assistantView("Still plain.")), [{ model: B, kind: "prose", followed: false, disputed: false }]);
});
