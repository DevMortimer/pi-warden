import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionGuard } from "../src/action-guard.js";
import type { Conversation, InspectOptions, ToolCallRef } from "../src/action-guard.js";
import { defaultConfig } from "../src/config.js";
import type { Judge } from "pi-typesafe";

interface Request { state: { action: { command?: string; path?: string } }; questions: Record<string, unknown> }
interface Answers { irreversible: number; offTask?: number; scope?: string; mutates?: number; approved?: number; shouldProceed?: number }

/**
 * A judge whose next answers are set by the test. `open` keeps requests pending until the test releases them, which is
 * how overlapping sibling requests are observed.
 */
function stubJudge(): Judge & { requests: Request[]; next: Answers; release: () => void; open: boolean } {
  const waiting: Array<() => void> = [];
  const judge = {
    requests: [] as Request[],
    next: { irreversible: 0.1, offTask: 0.1, scope: "expected_step", mutates: 0.9 } as Answers,
    open: false,
    release() { for (const wake of waiting.splice(0)) wake(); },
    async evaluate(request: unknown) {
      judge.requests.push(request as Request);
      const answers = { ...judge.next };
      if (judge.open) await new Promise<void>(resolve => { waiting.push(resolve); });
      return {
        model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 },
        answers: {
          irreversible: { type: "noul", noul: answers.irreversible },
          off_task: { type: "noul", noul: answers.offTask ?? 0.1 },
          scope: { type: "choice", choice: answers.scope ?? "expected_step", confidence: 0.9, probabilities: { [answers.scope ?? "expected_step"]: 0.9 } },
          mutates: { type: "noul", noul: answers.mutates ?? 0.9 },
          should_proceed: { type: "noul", noul: answers.shouldProceed ?? 1.0 },
          ...((request as Request).questions.approved ? { approved: { type: "noul", noul: answers.approved ?? 0 } } : {}),
        },
      } as never;
    },
  };
  return judge;
}

const bash = (id: string, command: string): ToolCallRef => ({ id, tool: "bash", input: { command } });
const options = (judge?: Judge): InspectOptions => ({ config: defaultConfig().action, cwd: process.cwd(), judge });
const under = (task: string, siblings?: ToolCallRef[]): Conversation => ({ task, siblings });
const askedApproval = (judge: { requests: Request[] }) => "approved" in judge.requests.at(-1)!.questions;

test("should-proceed records low scores as trace-only by default and supports steer opt-in", async () => {
  const judge = stubJudge();
  judge.next = { irreversible: 0.1, shouldProceed: 0.3 };
  for (const steer of [false, true]) {
    const opts = options(judge);
    opts.config.shouldProceed.steer = steer;
    const verdict = await new ActionGuard().inspect(bash("quiet", "npm test"), under("run tests"), opts);
    assert.equal(verdict.level, "warn");
    assert.equal(verdict.judgment?.shouldProceed, 0.3);
    assert.equal(verdict.shouldProceedSteer, true);
    assert.equal(verdict.shouldProceedTraceOnly, steer ? undefined : true);
    assert.ok(verdict.reasons.includes(`should-proceed 0.30 (${steer ? "may need user input before continuing" : "trace-only until calibrated"})`));
    if (!steer) assert.equal(verdict.reasons[verdict.shouldProceedTraceOnlyReasonIndex!], "should-proceed 0.30 (trace-only until calibrated)");
  }
});

test("a hold is released by a reply Jev reads as approval; the same prompt, a question, or a low score keep it held", async () => {
  const guard = new ActionGuard();
  const judge = stubJudge();
  judge.next = { irreversible: 0.9 };
  let verdict = await guard.inspect(bash("c1", "git push --force"), under("push my branch"), options(judge));
  assert.equal(verdict.level, "confirm");
  assert.ok(!askedApproval(judge), "no hold yet: nothing to approve");
  guard.hold("push my branch");

  verdict = await guard.inspect(bash("c2", "git push --force"), under("push my branch"), options(judge));
  assert.equal(verdict.level, "confirm", "same prompt: the user has not replied");
  assert.ok(!askedApproval(judge));
  guard.hold("push my branch");

  judge.next = { irreversible: 0.9, approved: 0.2 };
  verdict = await guard.inspect(bash("c3", "git push --force"), under("hmm, why is that needed?"), options(judge));
  assert.equal(verdict.level, "confirm", "Jev decides: 0.2 is not approval");
  assert.ok(askedApproval(judge), "a new prompt after a hold asks the approval question");
  guard.hold("hmm, why is that needed?");

  judge.next = { irreversible: 0.9, approved: 0.95 };
  verdict = await guard.inspect(bash("c4", "git push --force"), under("YES. Force push it now, I own that branch."), options(judge));
  assert.equal(verdict.level, "allow");
  assert.equal(verdict.approvedByUser, true);
  assert.match(verdict.reasons[0]!, /^user approved in the latest message \(0\.95\)/);

  verdict = await guard.inspect(bash("c5", "git push --force"), under("push my branch"), options(judge));
  assert.equal(verdict.level, "confirm", "approval is consumed; a new hold starts");
  assert.ok(!askedApproval(judge));
});

test("regression: approval applies to the action, not the exact command string; a re-hold under the reply keeps it valid", async () => {
  // Ryan, 2026-09-16: held `command -v supabase; supabase db reset`, user said "Yes you can.", the agent retried without the
  // `command -v` prefix and was held twice more, then fell back to DROP DATABASE. The approval question was never asked.
  const guard = new ActionGuard();
  const judge = stubJudge();
  judge.next = { irreversible: 0.87, mutates: 0.95 };
  assert.equal((await guard.inspect(bash("c1", "cd wt && command -v supabase; supabase db reset 2>&1 | tail -25"), under("prove the three migrations"), options(judge))).level, "confirm");
  guard.hold("prove the three migrations");
  judge.next = { irreversible: 0.87, mutates: 0.95, approved: 0.93 };
  const reworded = await guard.inspect(bash("c2", "cd wt && supabase db reset 2>&1 | tail -25"), under("Yes you can."), options(judge));
  assert.equal(reworded.level, "allow", "reworded retry after approval runs");
  assert.ok(askedApproval(judge), "Jev was asked whether the reply approves this action");

  // Same shape, but Jev says the reply does not approve the first retry (0.2); a second, reworded retry must still be asked.
  judge.next = { irreversible: 0.87, mutates: 0.95 };
  assert.equal((await guard.inspect(bash("c3", "supabase db reset"), under("wipe the local db and replay migrations"), options(judge))).level, "confirm");
  guard.hold("wipe the local db and replay migrations");
  judge.next = { irreversible: 0.87, mutates: 0.95, approved: 0.2 };
  assert.equal((await guard.inspect(bash("c4", "supabase db reset 2>&1 | tail -25"), under("Yes you can."), options(judge))).level, "confirm", "held again: 0.2 is not approval");
  guard.hold("Yes you can.");
  judge.next = { irreversible: 0.87, mutates: 0.95, approved: 0.9 };
  const again = await guard.inspect(bash("c5", "supabase db reset 2>&1 | tail -40"), under("Yes you can."), options(judge));
  assert.ok(askedApproval(judge), "the re-hold did not consume the user's reply");
  assert.equal(again.level, "allow");

  // An unrelated destructive call after a yes is still judged, and a low approval score keeps it held.
  judge.next = { irreversible: 0.9, offTask: 0.2, mutates: 0.95 };
  assert.equal((await guard.inspect(bash("c6", "git push --force"), under("clean up"), options(judge))).level, "confirm");
  guard.hold("clean up");
  judge.next = { irreversible: 0.95, offTask: 0.9, scope: "unrelated", mutates: 0.95, approved: 0.05 };
  assert.equal((await guard.inspect(bash("c7", "rm -rf ~/Documents"), under("yes"), options(judge))).level, "confirm", "a yes to one action does not approve a different one");
});

test("without a judge, a reply that reads as approval stands in for the question; anything else keeps the hold", async () => {
  const guard = new ActionGuard();
  assert.equal((await guard.inspect(bash("c1", "git push --force"), under("push my branch"), options())).level, "confirm", "destructive pattern");
  guard.hold("push my branch");
  assert.equal((await guard.inspect(bash("c2", "git push --force"), under("push my branch"), options())).level, "confirm", "same prompt");
  guard.hold("push my branch");
  assert.equal((await guard.inspect(bash("c3", "git push --force"), under("hmm, why is that needed?"), options())).level, "confirm", "a question is not approval");
  guard.hold("hmm, why is that needed?");
  assert.equal((await guard.inspect(bash("c4", "git push --force"), under("no, don't do that"), options())).level, "confirm", "a refusal with a yes-word is not approval");
  guard.hold("no, don't do that");
  const approved = await guard.inspect(bash("c5", "git push --force"), under("yes, that's fine"), options());
  assert.equal(approved.level, "allow");
  assert.equal(approved.approvedByUser, true);
  assert.equal(approved.reasons[0], "user approved in the latest message");
  assert.equal((await guard.inspect(bash("c6", "git push --force"), under("yes, that's fine"), options())).level, "confirm", "approval is consumed by the call it released");
});

test("siblings of one assistant message are judged together, each once, only for the input they were judged with", async () => {
  const guard = new ActionGuard();
  const judge = stubJudge();
  const siblings: ToolCallRef[] = [
    bash("a", "npm test"),
    bash("b", "npm run lint"),
    { id: "c", tool: "read", input: { path: "README.md" } },
    { id: "d", tool: "write", input: { path: "note.txt", content: "hello" } },
  ];
  judge.open = true;
  const first = guard.inspect(siblings[0]!, under("run the checks", siblings), options(judge));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(judge.requests.map(request => request.state.action.command ?? request.state.action.path).sort(), ["note.txt", "npm run lint", "npm test"], "the read is not guarded; the other three requests are in flight");
  judge.release();
  judge.open = false;
  assert.equal((await first).level, "allow");
  assert.equal((await guard.inspect(siblings[1]!, under("run the checks", siblings), options(judge))).level, "allow");
  assert.equal((await guard.inspect(siblings[3]!, under("run the checks", siblings), options(judge))).level, "allow");
  assert.equal(judge.requests.length, 3, "each sibling is judged exactly once");

  // Another hook rewrote b's input before the guard saw it: the stored judgment is stale and a fresh one is made.
  guard.turnEnd();
  await guard.inspect(siblings[0]!, under("run the checks", siblings), options(judge));
  await guard.inspect(bash("b", "npm run lint -- --fix"), under("run the checks", siblings), options(judge));
  assert.equal(judge.requests.length, 7, "three prejudged plus one fresh judgment for the changed input");
  assert.equal(judge.requests.at(-1)!.state.action.command, "npm run lint -- --fix");

  // A retry after a hold stays sequential: an approval consumed by one sibling would change the question for the next.
  judge.next = { irreversible: 0.9 };
  guard.hold("run the checks");
  judge.requests.length = 0;
  judge.next = { irreversible: 0.9, approved: 0.9 };
  await guard.inspect(siblings[0]!, under("yes", siblings), options(judge));
  assert.equal(judge.requests.length, 1, "no sibling preflight while an approval is pending");
});

test("a prejudgment is used once and does not survive the turn; reset clears the hold", async () => {
  const guard = new ActionGuard();
  const judge = stubJudge();
  const siblings = [bash("a", "npm test"), bash("b", "npm run lint")];
  await guard.inspect(siblings[0]!, under("run the checks", siblings), options(judge));
  assert.equal(judge.requests.length, 2);
  await guard.inspect(siblings[0]!, under("run the checks", siblings), options(judge));
  assert.equal(judge.requests.length, 3, "the same call inspected again is judged afresh");
  guard.turnEnd();
  await guard.inspect(siblings[1]!, under("run the checks", siblings), options(judge));
  assert.equal(judge.requests.length, 5, "b's prejudgment did not outlive the turn; a's is made again for the new turn");

  judge.next = { irreversible: 0.9 };
  guard.hold("run the checks");
  guard.reset();
  judge.next = { irreversible: 0.9, approved: 0.99 };
  const verdict = await guard.inspect(bash("c", "git push --force"), under("yes"), options(judge));
  assert.equal(verdict.level, "confirm", "after reset there is no hold to approve");
  assert.ok(!askedApproval(judge));
});
