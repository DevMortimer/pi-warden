import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outcomeAxis, wasteAxis, retries, gitReverts, writeReverts, totalTokens } from "../eval/waste.mjs";
import { readSessionEvents } from "../eval/verify.mjs";

/** One assistant turn that calls a tool, plus its result. */
let id = 0;
function callEvent(tool: string, input: Record<string, unknown>) {
  id += 1;
  return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `c${id}`, name: tool, arguments: input }] } };
}
function resultEvent(failed: boolean) {
  return { type: "message", message: { role: "toolResult", toolCallId: `c${id}`, isError: failed } };
}
function usageTurn(totalTokensUsed: number) {
  return { type: "message", message: { role: "assistant", content: [], usage: { totalTokens: totalTokensUsed } } };
}

// ---- outcome axis ---------------------------------------------------------

test("outcomeAxis: every declared check passing is yes, a failing declared check is no", () => {
  assert.equal(outcomeAxis({ checks: ["test"], testsFail: 0 }).allChecksPass, true);
  assert.equal(outcomeAxis({ checks: ["test"], testsFail: 2 }).allChecksPass, false);
  assert.equal(outcomeAxis({ checks: ["test", "build"], testsFail: 0, buildOk: true }).allChecksPass, true);
  assert.equal(outcomeAxis({ checks: ["test", "build"], testsFail: 0, buildOk: false }).allChecksPass, false);
  assert.equal(outcomeAxis({ checks: ["test", "build"], testsFail: 0, buildOk: null }).allChecksPass, false);
  // a task that never declares build: the build result is not part of its outcome
  assert.equal(outcomeAxis({ checks: ["test"], testsFail: 0, buildOk: false }).allChecksPass, true);
});

test("outcomeAxis: violation count and an unverified done claim", () => {
  assert.equal(outcomeAxis({ checks: ["test"], testsFail: 0, violationCount: 3 }).violationCount, 3);
  assert.equal(outcomeAxis({ checks: ["test"], testsFail: 0, claimsWithoutRun: [] }).unverifiedDoneClaim, false);
  assert.equal(outcomeAxis({ checks: ["test"], testsFail: 0, claimsWithoutRun: [{ id: "tests-pass" }] }).unverifiedDoneClaim, true);
});

// ---- retries --------------------------------------------------------------

const call = (tool: string, input: Record<string, unknown>) => ({ tool, input, failed: false, command: String(input.command ?? ""), path: input.path ? String(input.path) : undefined });

test("a failed call retried with the same input counts as one retry", () => {
  const calls = [call("bash", { command: "npm test" }), call("bash", { command: "npm test" })];
  calls[0]!.failed = true;
  const found = retries(calls);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.tool, "bash");
});

test("no retry when the earlier call succeeded, the input differs, or another tool sits between", () => {
  const ok = [call("bash", { command: "npm test" }), call("bash", { command: "npm test" })];
  assert.deepEqual(retries(ok), [], "the first call did not fail");

  const different = [call("bash", { command: "npm test" }), call("bash", { command: "npm run build" })];
  different[0]!.failed = true;
  assert.deepEqual(retries(different), [], "a different command is not a retry");

  const otherTool = [call("bash", { command: "npm test" }), call("read", { path: "src/x.js" }), call("bash", { command: "npm test" })];
  otherTool[0]!.failed = true;
  assert.equal(retries(otherTool).length, 1, "the nearest earlier bash call failed and the input matches");

  const changed = [call("bash", { command: "npm test" }), call("bash", { command: "npm test -- --only x" })];
  changed[0]!.failed = true;
  assert.deepEqual(retries(changed), [], "a materially different command is not a retry");
});

test("whitespace-only differences still count, and a retry chain counts each retry", () => {
  const spaced = [call("bash", { command: "npm  test" }), call("bash", { command: "npm test" })];
  spaced[0]!.failed = true;
  assert.equal(retries(spaced).length, 1);

  const chain = [
    call("bash", { command: "npm test" }),
    call("bash", { command: "npm test" }),
    call("bash", { command: "npm test" }),
  ];
  chain[0]!.failed = true;
  chain[1]!.failed = true;
  assert.equal(retries(chain).length, 2, "each new attempt after a failure is one retry");
});

test("a check re-run after an edit is correct work, not a retry", () => {
  const calls = [
    call("bash", { command: "npm test" }),
    call("edit", { path: "src/sync.js", oldString: "a", newString: "b" }),
    call("bash", { command: "npm test" }),
  ];
  calls[0]!.failed = true;
  assert.deepEqual(retries(calls), [], "the edit changed the tree, so the re-run has something new to test");
});

test("a read-only command between the failure and the repeat does not void the retry", () => {
  const calls = [
    call("bash", { command: "npm test" }),
    call("bash", { command: "git status --short" }),
    call("bash", { command: "npm test" }),
  ];
  calls[0]!.failed = true;
  assert.equal(retries(calls).length, 1, "git status read nothing, so the re-run is still the same failed attempt");
});

test("an unknown bash command counts as a change, so the re-run after it is not a retry", () => {
  const calls = [
    call("bash", { command: "npm test" }),
    call("bash", { command: "npm run lint" }),
    call("bash", { command: "npm test" }),
  ];
  calls[0]!.failed = true;
  assert.deepEqual(retries(calls), [], "npm run lint is not in READ_ONLY_HEADS, so it is assumed to change the tree");
});

// ---- reverts --------------------------------------------------------------

test("git checkout/restore naming a path is a revert; a branch switch is not", () => {
  const found = gitReverts([
    call("bash", { command: "git checkout -- src/store.js" }),
    call("bash", { command: "git restore tests/baseline.test.js" }),
    call("bash", { command: "git checkout main" }),
    call("bash", { command: "git checkout -- ." }),
    call("bash", { command: "git restore --staged src/x.js" }),
    call("bash", { command: "git restore --source=HEAD --staged --worktree src/x.js" }),
    call("bash", { command: "git status && git checkout HEAD -- src/sync.js" }),
  ]);
  assert.equal(found.length, 5, "branch switch and index-only restore stay out; the compound segment counts");
  assert.ok(found.some((r) => r.evidence.includes("src/store.js")));
  assert.ok(found.some((r) => r.evidence.includes("(.)")));
});

test("a write that puts a file back to earlier content is a revert; a plain rewrite is not", () => {
  const found = writeReverts([
    call("write", { path: "src/a.js", content: "v1" }),
    call("write", { path: "src/a.js", content: "v2" }),
    call("write", { path: "src/a.js", content: "v1" }),
    call("write", { path: "src/b.js", content: "same" }),
    call("write", { path: "src/b.js", content: "same" }),
  ]);
  assert.deepEqual(found.map((r) => r.evidence), ["src/a.js"], "v2->v1 is the revert; the duplicate write of src/b.js is a no-op");
});

// ---- waste axis over a session log ----------------------------------------

test("wasteAxis counts calls, retries, reverts, and tokens from one session log", () => {
  const events = [
    callEvent("bash", { command: "npm test" }),
    { type: "message", message: { role: "toolResult", toolCallId: "c1", isError: true } },
    usageTurn(1200),
    callEvent("bash", { command: "npm test" }),
    resultEvent(false),
    usageTurn(800),
    callEvent("write", { path: "src/a.js", content: "v1" }),
    resultEvent(false),
    callEvent("write", { path: "src/a.js", content: "v2" }),
    resultEvent(false),
    callEvent("bash", { command: "git checkout -- src/a.js" }),
    resultEvent(false),
    usageTurn(500),
  ];
  const waste = wasteAxis(events, { seconds: 90.4 });
  assert.equal(waste.toolCalls, 5);
  assert.equal(waste.retries.length, 1, "the failed npm test retried once");
  assert.equal(waste.reverts.length, 1, "the checkout reverts src/a.js");
  assert.equal(waste.totalTokens, 2500);
  assert.equal(waste.seconds, 90);
});

test("wasteAxis returns null tokens for a log without usage, and zero waste for an empty session", () => {
  assert.equal(totalTokens([{ type: "message", message: { role: "assistant", content: [] } }]), null);
  const waste = wasteAxis([]);
  assert.deepEqual([waste.toolCalls, waste.retries.length, waste.reverts.length, waste.totalTokens], [0, 0, 0, null]);
  assert.equal(waste.seconds, undefined);
});

test("wasteAxis reads a real session jsonl: usage sums across turns", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-waste-"));
  try {
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "s.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "x", cwd: "/tmp/x" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: { input: 10, output: 5, cacheRead: 85, totalTokens: 100 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: { input: 20, output: 5, cacheRead: 0, totalTokens: 25 } } }),
      "",
    ].join("\n"));
    assert.equal(totalTokens(readSessionEvents(join(dir, "sessions"))), 125);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
