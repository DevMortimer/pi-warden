import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SteerStats, SteerWatch, assistantView, formatSteerCounts, steerOutcome } from "../src/adaptive.js";
import type { SteerKind } from "../src/adaptive.js";

const dir = mkdtempSync(join(tmpdir(), "pi-warden-adaptive-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const store = () => new SteerStats(join(dir, `stats-${files++}.json`));
const A = "provider/model-a";
const B = "provider/model-b";

/** `n` observed notices, the first `followed` of them followed and the next `disputed` disputed. */
function feed(stats: SteerStats, model: string, kind: SteerKind, n: number, followed: number, disputed = 0) {
  for (let i = 0; i < n; i++) stats.observe(model, kind, { followed: i < followed, disputed: i >= followed && i < followed + disputed });
}

test("every notice is counted, however badly the agent does with it: no count mutes a kind", () => {
  const stats = store();
  feed(stats, A, "intent-mismatch", 30, 0, 30);
  assert.deepEqual(stats.pair(A, "intent-mismatch"), { sent: 30, followed: 0, disputed: 30 });
  assert.deepEqual(stats.counts(), [{ model: A, kind: "intent-mismatch", sent: 30, followed: 0, disputed: 30 }]);
  assert.match(formatSteerCounts(stats.counts()), /provider\/model-a: intent-mismatch \(30 shown, 0% followed, 100% disputed\)/);
});

test("counts are kept per model and kind", () => {
  const stats = store();
  feed(stats, A, "intent-mismatch", 4, 1);
  feed(stats, A, "rules", 2, 2);
  feed(stats, B, "intent-mismatch", 3, 0);
  assert.deepEqual(stats.counts().map(pair => [pair.model, pair.kind, pair.sent, pair.followed]), [
    [A, "intent-mismatch", 4, 1],
    [A, "rules", 2, 2],
    [B, "intent-mismatch", 3, 0],
  ]);
  assert.match(formatSteerCounts(stats.counts()), /provider\/model-a: intent-mismatch \(4 shown, 25% followed, 0% disputed\), rules \(2 shown, 100% followed, 0% disputed\)/);
});

test("counts persist in the stats file across instances", () => {
  const path = join(dir, "persist.json");
  const first = new SteerStats(path);
  feed(first, A, "rules", 3, 1);
  const second = new SteerStats(path);
  assert.deepEqual(second.pair(A, "rules"), { sent: 3, followed: 1, disputed: 0 });
  assert.equal(formatSteerCounts([]), "Notices followed: no notice has been shown to this model yet.");
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

test("SteerWatch settles after two assistant messages, early on a follow, and waits past the user for a next-turn notice", () => {
  const watch = new SteerWatch();
  watch.add(A, ["rules"], { path: "src/a.ts" });
  assert.deepEqual(watch.assistant(assistantView([{ type: "text", text: "Looking." }])), []);
  const settled = watch.assistant(assistantView([{ type: "toolCall", id: "1", name: "read", arguments: { path: "x" } }]));
  assert.deepEqual(settled, [{ model: A, kind: "rules", followed: false, disputed: false }]);

  watch.add(A, ["rules"], { path: "src/a.ts" });
  assert.equal(watch.assistant(assistantView([{ type: "toolCall", id: "2", name: "edit", arguments: { path: "src/a.ts" } }]))[0]?.followed, true);

  watch.add(A, ["intent-mismatch"]);
  assert.deepEqual(watch.user(), [], "a notice with no reply before the user spoke is dropped");

  watch.add(B, ["prose"], {}, { nextTurn: true });
  assert.deepEqual(watch.assistant(assistantView("ignored: the note waits for the next prompt")), []);
  watch.user();
  watch.assistant(assistantView("Plain reply."));
  assert.deepEqual(watch.assistant(assistantView("Still plain.")), [{ model: B, kind: "prose", followed: false, disputed: false }]);
});
