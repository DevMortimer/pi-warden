import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRun, isSleepPoll, pagingNudge, patternsOverlap, rangeRead, recheckNudge, searchNudge, searchRead, sleepNudge, WASTE_TIP, WasteTracker, withWasteTip, writtenPaths } from "../src/waste.js";
import type { WasteCall, WasteConfig, WasteNudge } from "../src/waste.js";

const config = (over: Partial<WasteConfig> = {}): WasteConfig => ({ enabled: true, tip: true, every: 20, sleep: true, paging: true, search: true, recheck: true, ...over });

/** A finished call in a project directory; the fields a detector reads come from `over`. */
const call = (over: Partial<WasteCall> & { tool: string; input: Record<string, unknown> }): WasteCall =>
  ({ cwd: "/work/project", failed: false, result: "", ...over });

const lines = (count: number) => `${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

const pollCommand = "sleep 5; curl -s http://127.0.0.1:4000/api/state | jq .status";
const poll = () => call({ tool: "bash", input: { command: pollCommand }, result: "{ \"status\": \"running\" }" });
const pollText = (nudge: WasteNudge | undefined) => nudge?.text ?? "";

test("waste sleep: a second poll in the window fires; one poll, a loop, and a sleeping chain do not", () => {
  const first = sleepNudge([poll()]);
  assert.equal(first, undefined, "one poll is waiting, not polling");

  const nudge = sleepNudge([poll(), call({ tool: "bash", input: { command: "git status --short" } }), poll()]);
  assert.ok(nudge, "two polls inside the window fire");
  assert.match(pollText(nudge), /^You have waited 2 times in the last 3 calls\./);
  assert.match(pollText(nudge), /one sleep long enough, or a blocking command such as `gh pr checks --watch`\./);

  // A follow-up that is a chain of work, not one status command.
  const chain = "sleep 5; git fetch origin && git rebase main && npm test";
  assert.equal(isSleepPoll(chain), false);
  assert.equal(sleepNudge([call({ tool: "bash", input: { command: chain }, result: "" }), call({ tool: "bash", input: { command: chain }, result: "" })]), undefined);

  // A loop that sleeps waits for something real; the shell blocks it on its own.
  const loop = "while [ ! -f /tmp/build.done ]; do sleep 5; done";
  assert.equal(isSleepPoll(loop), false);
  assert.equal(isSleepPoll("until gh pr checks 12; do sleep 10; done"), false);
  assert.equal(sleepNudge([call({ tool: "bash", input: { command: loop }, result: "" }), call({ tool: "bash", input: { command: loop }, result: "" })]), undefined);

  // A single long sleep with a status tail is one poll; alone it does not fire.
  assert.equal(isSleepPoll("sleep 90; tail -4 /tmp/build.log"), true);
  assert.equal(sleepNudge([call({ tool: "bash", input: { command: "sleep 90; tail -4 /tmp/build.log" }, result: "" })]), undefined);

  // `cd DIR &&` in front is how polls are usually written.
  assert.equal(isSleepPoll("cd /tmp/run && sleep 20 && gh pr checks 12"), true);
  assert.equal(isSleepPoll("sleep 5; echo one; echo two"), false);
});

test("waste paging: three adjacent ranged reads of one file fire with the one-read alternative", () => {
  const reads = [
    call({ tool: "read", input: { path: "src/extension.ts", offset: 745, limit: 62 }, result: lines(62) }),
    call({ tool: "read", input: { path: "src/extension.ts", offset: 760, limit: 22 }, result: lines(22) }),
    call({ tool: "read", input: { path: "src/extension.ts", offset: 750, limit: 17 }, result: lines(17) }),
  ];
  const nudge = pagingNudge(reads);
  assert.ok(nudge, "three overlapping reads of one file fire");
  assert.equal(nudge.detector, "paging");
  assert.match(nudge.text, /^You read src\/extension\.ts in 3 calls and the parts run from line 745 to 806 without a gap\./);
  assert.match(nudge.text, /One `read` with offset=745, limit=62 returns the same lines\./);

  // Same file, same shell, ranges far apart: the one-read alternative would read hundreds of unneeded lines.
  const far = ["40,60", "400,420", "900,920"].map(range => call({ tool: "bash", input: { command: `sed -n '${range}p' src/big.ts` }, result: lines(20) }));
  assert.ok(far.every(entry => rangeRead(entry)), "sed ranges are ranged reads");
  assert.equal(pagingNudge(far), undefined);

  // Adjacent reads with an edit of that file between them: the re-reads are about the change.
  const edited = [reads[0]!, call({ tool: "edit", input: { path: "src/extension.ts", edits: [{ oldText: "a", newText: "b" }] } }), reads[1]!, reads[2]!];
  assert.equal(pagingNudge(edited), undefined);

  // A whole-file read and a big ranged read are not pages of a run.
  assert.equal(rangeRead(call({ tool: "read", input: { path: "src/big.ts" }, result: lines(20) })), undefined);
  assert.equal(rangeRead(call({ tool: "read", input: { path: "src/big.ts", offset: 1, limit: 200 }, result: lines(200) })), undefined);
  const wide = [0, 1, 2].map(() => call({ tool: "read", input: { path: "src/big.ts", offset: 1, limit: 200 }, result: lines(200) }));
  assert.equal(pagingNudge(wide), undefined);

  // A program's own read is not the agent reading: a python heredoc has no pages.
  const script = call({ tool: "bash", input: { command: "python3 - <<'PY'\nprint(open('src/extension.ts').read())\nPY" }, result: lines(200) });
  assert.equal(rangeRead(script), undefined);
  assert.equal(rangeRead(call({ tool: "bash", input: { command: "node -e \"console.log(1)\"" }, result: "" })), undefined);

  // A relative path after `cd DIR &&` is the same file as the same path from the project root.
  const from = (dir: string, path: string) => call({ tool: "read", input: { path, offset: 10, limit: 5 }, result: lines(5), cwd: "/work/project" });
  const cwdReads = [from("/work/project", "src/a.ts"), call({ tool: "bash", input: { command: "cd src && sed -n '12,16p' a.ts" }, result: lines(5) }), from("/work/project", "./src/a.ts")];
  assert.ok(pagingNudge(cwdReads), "the same file reached two ways is one run of pages");
});

test("waste search: three searches of one file with an overlapping pattern fire", () => {
  const key = call({ tool: "bash", input: { command: "grep \" 429\" /tmp/x/backend.log" }, result: "line: 429\n" });
  const again = call({ tool: "bash", input: { command: "grep \" 429\" /tmp/x/backend.log" }, result: "line: 429\n" });
  const counted = call({ tool: "bash", input: { command: "grep -c \"ERROR\" /tmp/x/backend.log" }, result: "12\n" });
  const nudge = searchNudge([key, again, counted]);
  assert.ok(nudge, "three searches of one file fire");
  assert.match(nudge.text, /^You searched \/tmp\/x\/backend\.log 3 times with the same or an overlapping pattern\./);
  assert.match(nudge.text, /reuse them, or widen the search once\./);

  // Recursive and glob searches name no single file.
  const recursive = call({ tool: "bash", input: { command: "grep -rn foo src/" }, result: "src/a.ts:1:foo\n" });
  assert.equal(searchRead(recursive), undefined);
  assert.equal(searchNudge([recursive, recursive, recursive]), undefined);
  const glob = call({ tool: "bash", input: { command: "grep foo 'src/*.ts'" }, result: "" });
  assert.equal(searchRead(glob), undefined);

  // One search alone is not a repetition, and its pattern is read from the command.
  assert.equal(searchNudge([key]), undefined);
  assert.deepEqual(searchRead(key), { file: "/tmp/x/backend.log", path: "/tmp/x/backend.log", pattern: " 429" });
  assert.equal(searchRead(call({ tool: "bash", input: { command: "rg -n 'class Foo' src/foo.ts" } }))?.pattern, "class Foo");

  // A write to the file between the searches is a new file to search.
  const written = [key, call({ tool: "edit", input: { path: "/tmp/x/backend.log", edits: [] } }), again, counted];
  assert.equal(searchNudge(written), undefined);

  // Three searches of one file whose patterns share nothing are three different questions.
  const distinct = ["alpha", "beta", "gamma"].map(pattern => call({ tool: "bash", input: { command: `grep ${pattern} /tmp/x/backend.log` }, result: "" }));
  assert.equal(searchNudge(distinct), undefined, "no two patterns overlap");
});

test("waste patterns: identical, contained, and shared -E alternatives overlap", () => {
  assert.equal(patternsOverlap("foo", "foo"), true);
  assert.equal(patternsOverlap(" foo ", "foo"), true);
  assert.equal(patternsOverlap("class Foo", "Foo"), true);
  assert.equal(patternsOverlap("ERROR|WARN", "WARN|DEBUG"), true);
  assert.equal(patternsOverlap("alpha", "beta"), false);
});

test("waste recheck: a filtered re-run of the same check fires; a failure and an unpiped re-run do not", () => {
  const first = call({ tool: "bash", input: { command: "npm run check 2>&1 | tail -30" }, result: "…\nℹ tests 1175\n" });
  const second = call({ tool: "bash", input: { command: "npm run check 2>&1 | grep -E \"^(ℹ|✖)\"" }, result: "ℹ tests 1175\n" });
  const nudge = recheckNudge([first, second]);
  assert.ok(nudge, "the same check run twice with two filters fires");
  assert.equal(nudge.subject, "npm run check");
  assert.match(nudge.text, /^You ran npm run check 2 times and filtered the output each time\. Run it once without a pipe;/);

  // The first result already showed a failure: chasing it is the work, not waste.
  const failing = { ...first, result: "…\n# fail 2\n✖ two tests failed\n" };
  assert.equal(recheckNudge([failing, second]), undefined);
  assert.equal(recheckNudge([{ ...first, failed: true }, second]), undefined);

  // A write between the runs voids it: the second run answers a different tree.
  const written = [first, call({ tool: "write", input: { path: "src/config.ts", content: "x" } }), second];
  assert.equal(recheckNudge(written), undefined);

  // Already running it without a pipe takes the note's advice; the same filter is not a second question.
  const unpiped = call({ tool: "bash", input: { command: "npm run check" }, result: "ℹ tests 1175\n" });
  assert.equal(recheckNudge([first, unpiped]), undefined);
  const sameFilter = call({ tool: "bash", input: { command: "npm run check 2>&1 | tail -30" }, result: "ℹ tests 1175\n" });
  assert.equal(recheckNudge([first, sameFilter]), undefined);

  // Redirects and environment noise are not part of the key; two different checks are not one.
  assert.equal(checkRun(call({ tool: "bash", input: { command: "npm test 2>&1 > /tmp/out.log | tail -20" } }))?.key, "npm test");
  assert.equal(checkRun(call({ tool: "bash", input: { command: "cd /work/project && npx tsc --noEmit | head -20" } }))?.key, "npx tsc --noEmit");
  assert.equal(checkRun(call({ tool: "bash", input: { command: "python3 scripts/build.py" } })), undefined);
  const other = call({ tool: "bash", input: { command: "npm run build 2>&1 | grep error" }, result: "ℹ tests 1175\n" });
  assert.equal(recheckNudge([first, other]), undefined, "a different check is not a re-run");
});

test("waste writes: a write to the file between two reads voids the note", () => {
  assert.deepEqual(writtenPaths(call({ tool: "edit", input: { path: "src/a.ts", edits: [] } })), ["/work/project/src/a.ts"]);
  assert.deepEqual(writtenPaths(call({ tool: "bash", input: { command: "npm test > /tmp/out.log" } })), ["/tmp/out.log"]);
  assert.deepEqual(writtenPaths(call({ tool: "bash", input: { command: "sed -i '' 's/a/b/' src/a.ts" } })), ["/work/project/src/a.ts"]);
  assert.deepEqual(writtenPaths(call({ tool: "bash", input: { command: "cd src && cp a.ts b.ts" } })), ["/work/project/src/a.ts", "/work/project/src/b.ts"]);
  assert.deepEqual(writtenPaths(call({ tool: "read", input: { path: "src/a.ts" } })), []);
  assert.deepEqual(writtenPaths(call({ tool: "bash", input: { command: "git status --short" } })), []);
});

test("waste rate limit: one note per detector per window of calls", () => {
  const tracker = new WasteTracker();
  const fired: WasteNudge[] = [];
  for (let index = 0; index < 22; index++) {
    const nudge = tracker.record(poll(), config({ every: 20 }));
    if (nudge) fired.push(nudge);
  }
  assert.equal(fired.length, 2, "calls 2 and 22 are 20 calls apart");
  assert.match(fired[0]!.text, /2 times in the last 2 calls/);
  assert.match(fired[1]!.text, /10 times in the last 10 calls/);

  // A detector switched off is silent; so is the whole guard.
  const off = new WasteTracker();
  assert.equal(off.record(poll(), config({ sleep: false })), undefined);
  assert.equal(off.record(poll(), config({ sleep: false })), undefined);
  assert.equal(off.record(poll(), config({ enabled: false })), undefined);
  assert.equal(off.record(poll(), config({ enabled: false })), undefined);

  // A reset starts a new session: the window and the rate limit are empty again.
  const reset = new WasteTracker();
  assert.equal(reset.record(poll(), config()), undefined);
  assert.ok(reset.record(poll(), config()));
  reset.reset();
  assert.equal(reset.record(poll(), config()), undefined);
  assert.ok(reset.record(poll(), config()));
});

test("waste notes are text for a tool result: no hold, no block, no level", () => {
  const nudge = sleepNudge([poll(), poll()]);
  assert.ok(nudge);
  assert.deepEqual(Object.keys(nudge).sort(), ["detector", "subject", "text"]);
  assert.equal("block" in nudge, false);
  assert.equal("hold" in nudge, false);
  assert.equal("level" in nudge, false);
});

test("waste tip: appended after the prompt it finds, never in place of it", () => {
  assert.equal(withWasteTip(undefined), WASTE_TIP);
  assert.equal(withWasteTip("BASE PROMPT"), `BASE PROMPT\n\n${WASTE_TIP}`);
  assert.equal(withWasteTip(`BASE PROMPT\n\n${WASTE_TIP}`), `BASE PROMPT\n\n${WASTE_TIP}`, "an append of the same text is idempotent");
  assert.ok(withWasteTip("BASE PROMPT").startsWith("BASE PROMPT"));
  assert.match(WASTE_TIP, /^Tool calls are expensive: each one re-reads the whole conversation\./);
  assert.match(WASTE_TIP, /Wait for slow work with one blocking command, not repeated sleeps\.$/);
});
