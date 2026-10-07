import assert from "node:assert/strict";
import { test } from "node:test";
import type { Judge } from "pi-typesafe";
import { causeNudge, causePreFilter, emptyCauseActivity, evaluateCause, formatCause, recordCauseActivity } from "../src/cause.js";
import type { CauseStore, CauseStoreRecord } from "../src/cause.js";
import { defaultConfig } from "../src/config.js";

type Answers = { statesCause?: number; handsOff?: number; checked?: number; sameCause?: string };

/** A judge whose next answers are set by the test; it records the requests it was handed. */
function stubJudge(answers: Answers): Judge & { requests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> } {
  const judge = {
    requests: [] as Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }>,
    async evaluate(request: unknown) {
      const typed = request as { state: Record<string, unknown>; questions: Record<string, unknown> };
      judge.requests.push(typed);
      const given: Record<string, unknown> = {
        states_cause: { type: "noul", noul: answers.statesCause ?? 0.1 },
        hands_off: { type: "noul", noul: answers.handsOff ?? 0.1 },
        checked: { type: "noul", noul: answers.checked ?? 0.1 },
        ...(answers.sameCause === undefined ? {} : { same_cause: { type: "choice", choice: answers.sameCause, confidence: 0.9, probabilities: { [answers.sameCause]: 0.9 } } }),
      };
      return { model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(given).filter(([id]) => id in typed.questions)) } as never;
    },
  };
  return judge;
}

/** A store that answers its recorded causes however the test set it up; it records what the guard wrote. */
function fakeStore(records: CauseStoreRecord[] = []): CauseStore & { recorded: Array<{ summary: string; at: number }> } {
  const recorded: Array<{ summary: string; at: number }> = [];
  return {
    recorded,
    async recall(_projectRoot, _since, limit) {
      return records.slice(0, limit);
    },
    async record(_projectRoot, record) {
      recorded.push(record);
    },
  };
}

const cause = () => defaultConfig().cause;
const DAY = 86_400_000;

test("a causal guess with no check in the run is steered", async () => {
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05 });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000 });
  assert.equal(verdict.unchecked, true);
  assert.equal(verdict.handsOff, false);
  assert.match(causeNudge(verdict), /check it with your own tools/i);
  assert.match(causeNudge(verdict), /unverified/);
  assert.match(causeNudge(verdict), /states a cause/i);
});

test("a reply that hands a check to a person gets the hand-off steer text", async () => {
  const judge = stubJudge({ statesCause: 0.1, handsOff: 0.9, checked: 0.05 });
  const verdict = await evaluateCause("why did the alert fire", "Ask the team whether the config changed.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000 });
  assert.equal(verdict.unchecked, true);
  assert.equal(verdict.handsOff, true);
  const nudge = causeNudge(verdict);
  assert.match(nudge, /asks a person to check something/i);
  assert.match(nudge, /check it with your own tools/i);
  assert.doesNotMatch(nudge, /states a cause/i);
  assert.doesNotMatch(nudge, /\d{4}-\d{2}-\d{2}/);
});

test("a reply whose run checked the claim is not steered", async () => {
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.1, checked: 0.9 });
  const activity = emptyCauseActivity();
  recordCauseActivity(activity, "bash", { command: "sqlite3 app.db 'select count(*) from alerts'" }, "the alert row changed at 10:00");
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", activity, { config: cause(), judge, timeoutMs: 1000 });
  assert.equal(verdict.unchecked, false);
  assert.equal(judge.requests.length, 1);
  assert.match(JSON.stringify(judge.requests[0]!.state.run), /sqlite3/);
});

test("a reply with no causal or hand-off wording sends no request", () => {
  assert.equal(causePreFilter("Tests pass; the parser bug is fixed."), false);
  assert.equal(causePreFilter("Done."), false);
  assert.equal(causePreFilter("The parser reads tokens left to right."), false);
  assert.equal(causePreFilter("I updated the README."), false);
  assert.equal(causePreFilter("The alert is probably from a manual edit."), true);
  assert.equal(causePreFilter("The bug is in parse()."), true);
  assert.equal(causePreFilter("Ask the team whether the config changed."), true);
});

test("the stored summary is the cause sentence, redacted", async () => {
  const store = fakeStore();
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05 });
  const reply = "I read the log. The alert is probably from a manual edit with sk-abcdefghijklmnop, not the deploy.";
  await evaluateCause("why did the alert fire", reply, emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store, projectRoot: "/p", now: Date.now() });
  assert.equal(store.recorded.length, 1, "the unchecked cause is stored");
  const summary = store.recorded[0]!.summary;
  assert.match(summary, /probably from a manual edit/);
  assert.doesNotMatch(summary, /I read the log/, "the status line is not the stored cause");
  assert.doesNotMatch(summary, /sk-abcdefghijklmnop/, "the stored summary is redacted");
  assert.ok(summary.length <= 301, "the stored summary is cut to 300 characters");
});

test("a different unchecked cause in the window does not escalate, and its steer names no date", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const store = fakeStore([{ summary: "a deploy removed the search index", at: now - DAY }]);
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05, sameCause: "none" });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual config edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store, projectRoot: "/p", now });
  assert.equal(verdict.unchecked, true);
  assert.equal(verdict.previous, undefined, "a different cause does not escalate");
  assert.doesNotMatch(causeNudge(verdict), /\d{4}-\d{2}-\d{2}/, "the steer names no date");
  assert.equal(store.recorded.length, 1, "the new unchecked cause is stored");
  const state = judge.requests[0]!.state as { earlier_causes?: Array<{ key: string; date: string; cause: string }> };
  assert.ok(state.earlier_causes, "the earlier cause rode the request");
  assert.equal(state.earlier_causes[0]!.cause, "a deploy removed the search index");
});

test("the same cause, chosen by the judge from earlier_causes, escalates and names that cause's date", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const earlier = now - DAY;
  const store = fakeStore([{ summary: "a manual config edit", at: earlier }]);
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05, sameCause: "c1" });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual config edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store, projectRoot: "/p", now });
  assert.ok(verdict.previous, "the matched earlier cause is recalled");
  const nudge = causeNudge(verdict);
  assert.match(nudge, /2026-10-07/, "the stronger steer names the earlier date");
  assert.match(nudge, /check it with your own tools/i);
  assert.equal(store.recorded.length, 1, "the new unchecked cause is stored");
  const request = judge.requests[0]!;
  assert.ok("same_cause" in request.questions, "the repeat question is asked");
  const state = request.state as { earlier_causes: Array<{ key: string; date: string; cause: string }> };
  assert.deepEqual(state.earlier_causes, [{ key: "c1", date: "2026-10-07", cause: "a manual config edit" }]);
});

test("a hand-off reply gets the hand-off steer text at both levels", async () => {
  const first = await evaluateCause("why did the alert fire", "Ask the team whether the config changed.", emptyCauseActivity(), { config: cause(), judge: stubJudge({ statesCause: 0.1, handsOff: 0.9, checked: 0.05 }), timeoutMs: 1000 });
  assert.match(causeNudge(first), /asks a person to check something/i);
  assert.doesNotMatch(causeNudge(first), /\d{4}-\d{2}-\d{2}/);
  const now = Date.parse("2026-10-08T12:00:00Z");
  const store = fakeStore([{ summary: "a manual config edit", at: now - DAY }]);
  const repeat = await evaluateCause("why did the alert fire", "Ask the team whether the config changed.", emptyCauseActivity(), { config: cause(), judge: stubJudge({ statesCause: 0.1, handsOff: 0.9, checked: 0.05, sameCause: "c1" }), timeoutMs: 1000, store, projectRoot: "/p", now });
  assert.equal(repeat.handsOff, true);
  const nudge = causeNudge(repeat);
  assert.match(nudge, /asks a person to check something/i);
  assert.match(nudge, /2026-10-07/);
});

test("with no earlier cause in the window, the request has no earlier_causes and no repeat question", async () => {
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05 });
  await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store: fakeStore(), projectRoot: "/p", now: Date.now() });
  const request = judge.requests[0]!;
  assert.ok(!("earlier_causes" in request.state), "the state names no earlier causes");
  assert.ok(!("same_cause" in request.questions), "the repeat question is not asked");
});

test("a cause older than 7 days counts as new", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const store = fakeStore([{ summary: "a manual config edit", at: now - 8 * DAY }]);
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05, sameCause: "c1" });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual config edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store, projectRoot: "/p", now });
  assert.equal(verdict.previous, undefined);
  assert.doesNotMatch(causeNudge(verdict), /\d{4}-\d{2}-\d{2}/);
  assert.ok(!("earlier_causes" in judge.requests[0]!.state), "a cause outside the window does not ride the request");
});

test("a checked cause is not stored and gets no steer", async () => {
  const store = fakeStore();
  const judge = stubJudge({ statesCause: 0.9, checked: 0.9 });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store, projectRoot: "/p", now: Date.now() });
  assert.equal(verdict.unchecked, false);
  assert.equal(store.recorded.length, 0);
});

test("the request carries the run's tool results and redacts credentials", async () => {
  const activity = emptyCauseActivity();
  recordCauseActivity(activity, "bash", { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnop' http://service/state" }, "ok");
  const judge = stubJudge({ statesCause: 0.9, checked: 0.05 });
  await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", activity, { config: cause(), judge, timeoutMs: 1000 });
  const state = judge.requests[0]!.state as { run: { tool_calls: Array<{ call: string; output: string }> } };
  assert.equal(state.run.tool_calls.length, 1);
  assert.match(JSON.stringify(state), /curl/);
  assert.doesNotMatch(JSON.stringify(state), /sk-abcdefghijklmnop/);
});

test("the request keeps the last 40 tool calls with short redacted output samples", async () => {
  const activity = emptyCauseActivity();
  for (let index = 0; index < 45; index++) recordCauseActivity(activity, "bash", { command: `echo ${index}` }, `output ${index} ${"x".repeat(300)}`);
  assert.equal(activity.calls.length, 40, "the activity keeps the last 40 calls");
  assert.equal(activity.calls[0]!.call, "echo 5");
  const judge = stubJudge({ statesCause: 0.9, checked: 0.05 });
  await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", activity, { config: cause(), judge, timeoutMs: 1000 });
  const state = judge.requests[0]!.state as { run: { tool_calls: Array<{ call: string; output: string }> } };
  assert.equal(state.run.tool_calls.length, 40);
  assert.ok(state.run.tool_calls.every(call => call.output.length <= 160), "each output sample is at most 160 characters");
});

test("the widget line and the two steer levels read as data", async () => {
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05 });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000 });
  assert.match(formatCause(verdict), /cause-check · .* · unchecked/);
  const repeated = { ...verdict, previous: { summary: "x", at: Date.parse("2026-10-07T00:00:00Z") } };
  assert.match(causeNudge(repeated), /2026-10-07/);
});

test("the cause guard can be turned off", async () => {
  const judge = stubJudge({ statesCause: 0.9, checked: 0.05 });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", emptyCauseActivity(), { config: { ...cause(), enabled: false }, judge, timeoutMs: 1000 });
  assert.equal(verdict.unchecked, false);
  assert.equal(judge.requests.length, 0, "an off guard sends no request");
});
