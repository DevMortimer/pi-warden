import assert from "node:assert/strict";
import { test } from "node:test";
import type { Judge } from "pi-typesafe";
import { causeNudge, causePreFilter, emptyCauseActivity, evaluateCause, formatCause, recordCauseActivity } from "../src/cause.js";
import type { CauseStore, CauseStoreRecord } from "../src/cause.js";
import { defaultConfig } from "../src/config.js";

type Answers = { statesCause?: number; handsOff?: number; checked?: number; topic?: string };

/** A judge whose next answers are set by the test; it records the requests it was handed. */
function stubJudge(answers: Answers): Judge & { requests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> } {
  const judge = {
    requests: [] as Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }>,
    async evaluate(request: unknown) {
      const typed = request as { state: Record<string, unknown>; questions: Record<string, unknown> };
      judge.requests.push(typed);
      const given = {
        states_cause: { type: "noul", noul: answers.statesCause ?? 0.1 },
        hands_off: { type: "noul", noul: answers.handsOff ?? 0.1 },
        checked: { type: "noul", noul: answers.checked ?? 0.1 },
        topic: { type: "choice", choice: answers.topic ?? "code", confidence: 0.9, probabilities: { [answers.topic ?? "code"]: 0.9 } },
      };
      return { model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(given).filter(([id]) => id in typed.questions)) } as never;
    },
  };
  return judge;
}

/** A store that returns one earlier record inside the window, like a real project history. */
function fakeStore(previous?: CauseStoreRecord, windowDays = 7): CauseStore & { recorded: Array<{ topic: string; summary: string; at: number }> } {
  const recorded: Array<{ topic: string; summary: string; at: number }> = [];
  return {
    recorded,
    async recall(_projectRoot, _topic, now) {
      return previous && now - previous.at <= windowDays * 86_400_000 ? previous : undefined;
    },
    async record(_projectRoot, record) {
      recorded.push(record);
    },
  };
}

const cause = () => defaultConfig().cause;

test("a causal guess with no check in the run is steered", async () => {
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05, topic: "code" });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000 });
  assert.equal(verdict.unchecked, true);
  assert.equal(verdict.topic, "code");
  assert.match(causeNudge(verdict), /check it with your own tools/i);
  assert.match(causeNudge(verdict), /unverified/);
});

test("a reply that hands a check to a person is steered", async () => {
  const judge = stubJudge({ statesCause: 0.1, handsOff: 0.9, checked: 0.05, topic: "config" });
  const verdict = await evaluateCause("why did the alert fire", "Ask the team whether the config changed.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000 });
  assert.equal(verdict.unchecked, true);
  assert.equal(verdict.topic, "config");
});

test("a reply whose run checked the claim is not steered", async () => {
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.1, checked: 0.9, topic: "data" });
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

test("the same unchecked cause on a later day gets the stronger steer with the earlier date", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const earlier = now - 86_400_000;
  const store = fakeStore({ summary: "a manual config edit", at: earlier });
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05, topic: "config" });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual config edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store, projectRoot: "/p", now });
  assert.ok(verdict.previous, "the earlier unchecked cause is recalled");
  const nudge = causeNudge(verdict);
  assert.match(nudge, /2026-10-07/);
  assert.match(nudge, /check it with your own tools/i);
  assert.equal(store.recorded.length, 1, "the new unchecked cause is stored");
});

test("a cause older than 7 days counts as new", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const store = fakeStore({ summary: "a manual config edit", at: now - 8 * 86_400_000 });
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05, topic: "config" });
  const verdict = await evaluateCause("why did the alert fire", "The alert is probably from a manual config edit.", emptyCauseActivity(), { config: cause(), judge, timeoutMs: 1000, store, projectRoot: "/p", now });
  assert.equal(verdict.previous, undefined);
  assert.doesNotMatch(causeNudge(verdict), /\d{4}-\d{2}-\d{2}/);
});

test("a checked cause is not stored and gets no steer", async () => {
  const store = fakeStore();
  const judge = stubJudge({ statesCause: 0.9, checked: 0.9, topic: "code" });
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

test("the widget line and the two steer levels read as data", async () => {
  const judge = stubJudge({ statesCause: 0.9, handsOff: 0.05, checked: 0.05, topic: "code" });
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
