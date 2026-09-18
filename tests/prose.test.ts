import assert from "node:assert/strict";
import { test } from "node:test";
import { restatedShare, RestatementWindow, RESTATE_SHARE, substantiveSentences } from "../src/prose.js";

const DONE = "CON-375 done: draft PR 2688 is pushed with code, tests and screenshots, and Linear is In Review. Worktree millia-con375 awaits review.";
const PARAPHRASE = "CON-375 is complete: the draft pull request 2688 is pushed together with code, tests and screenshots, and Linear sits In Review. The worktree millia-con375 now awaits review.";
const FRESH = "The security notice named variable names only: no values were echoed and nothing was committed. pr-evidence holds PNG files.";

test("restatedShare reads a paraphrase of the same status as a restatement", () => {
  const share = restatedShare(PARAPHRASE, [DONE]);
  assert.ok(share >= RESTATE_SHARE, `the paraphrase restates ${share} of the finished status, at least ${RESTATE_SHARE}`);
});

test("restatedShare keeps a reply with new information below the threshold", () => {
  const share = restatedShare(FRESH, [DONE]);
  assert.ok(share < RESTATE_SHARE, `the fresh answer scores ${share}, below ${RESTATE_SHARE}`);
});

test("short connective sentences never count toward a restatement", () => {
  assert.equal(substantiveSentences("Yes. Done. On it.").length, 0, "one-line acknowledgements carry no comparable sentence");
});

test("an empty comparison pool scores zero, so a first reply never restates", () => {
  assert.equal(restatedShare(DONE, []), 0, "with no earlier reply there is nothing to restate");
});

test("RestatementWindow forgets finals beyond its limit and resets with the prompt", () => {
  const window = new RestatementWindow(2);
  window.record(DONE);
  window.record(FRESH);
  window.record(FRESH);
  assert.ok(restatedShare(PARAPHRASE, [DONE]) > 0, "the dropped final would still match");
  assert.equal(window.share(PARAPHRASE), 0, "only the last two finals are compared");
  window.reset();
  assert.equal(window.share(DONE), 0, "a new prompt clears the window: answering the user is never a restatement");
});
