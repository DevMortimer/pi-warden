import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  candidatesInSession, classifyClause, emptyPrefsStore, evaluatePrefs, extractPreferences, forgetPref, groupPreferences, isCorrection, LESSON_MARK,
  MAX_INJECTED, MESSAGE_CHARS, NO_LESSON_SIGNAL, NOT_CONFIRMED, PREFS_CLOSING, PREFS_LEAD, prefsMessage, prefsStorePath, readPrefsStore, recordLesson,
  WAS_INJECTED, WEAKENS_CHECK, writePrefsStore,
} from "../src/prefs.js";
import type { PrefCandidate, PrefItem, PrefsStore, WordCounts } from "../src/prefs.js";

const NOW = Date.parse("2026-01-20T12:00:00.000Z");
const at = (date: string) => Date.parse(`${date}T12:00:00.000Z`);
const said = (clause: string, session: string, date: string, permit = false): PrefCandidate => ({ clause, session, at: at(date), ...(permit ? { permit } : {}) });
/** Three sessions on two days: enough to be injected when every other rule holds. */
const thrice = (clause: string): PrefCandidate[] => [said(clause, `${clause}-1`, "2026-01-10"), said(clause, `${clause}-2`, "2026-01-10"), said(clause, `${clause}-3`, "2026-01-12")];
/** "subagent" is a rare subject word, as it is in real messages. */
const counts = (): WordCounts => ({ messages: 100, words: new Map([["subagent", 1], ["spawn", 1]]) });
const scanOf = (candidates: PrefCandidate[]) => ({ prefs: groupPreferences(candidates, counts()), candidates, counts: counts() });
const evaluate = (candidates: PrefCandidate[], store: PrefsStore = emptyPrefsStore(), now = NOW) => evaluatePrefs(scanOf(candidates), store, now);
const statusOf = (items: readonly PrefItem[], text: string) => items.find(item => item.text === text)?.status;

const session = (...messages: string[]) => Buffer.from(messages.map((content, index) =>
  JSON.stringify({ type: "message", id: `m${index}`, timestamp: "2026-01-10T12:00:00.000Z", message: { role: "user", content } })).join("\n"));

test("rule 1: only what the human typed counts; relayed messages are read as nothing", () => {
  assert.deepEqual(candidatesInSession(session("never force-push the release branch"), "s1", NOW).map(candidate => candidate.clause), ["Never force-push the release branch"]);
  assert.deepEqual(candidatesInSession(session("From Lead agent:\n\nNever force-push the release branch."), "s1", NOW), []);
  assert.deepEqual(candidatesInSession(session("# ORDER\n\nNever force-push the release branch."), "s1", NOW), []);
});

test("rule 2: standing forms pass; questions and temporary words fail", () => {
  for (const [text, clause] of [
    ["don't open pull requests", "Don't open pull requests"],
    ["never force-push the release branch", "Never force-push the release branch"],
    ["always run the linter before a commit", "Always run the linter before a commit"],
    ["stop adding emoji to the changelog", "Stop adding emoji to the changelog"],
    ["from now on, write commit messages in the imperative", "Write commit messages in the imperative"],
    ["next time ask before deleting a branch", "Ask before deleting a branch"],
    ["I told you to keep the tests offline", "Keep the tests offline"],
    ["always use pnpm for this project", "Always use pnpm for this project"],
  ] as const) assert.deepEqual(extractPreferences(text), [clause], text);
  for (const text of [
    "why don't you rebase the branch?",
    "please make the table wider",
    "don't merge the migration yet",
    "don't touch the schema now",
    "don't push until the checks pass",
    "never squash commits in this PR",
    "don't rebase this branch onto main",
    "never rename the helper for this",
    "don't bump the version for now",
    "don't deploy today",
  ]) assert.deepEqual(extractPreferences(text), [], text);
});

test("rule 3: a pronoun-only object or a named ticket, branch, PR, or hash is task-bound", () => {
  for (const clause of [
    "Don't commit or stage it", "Never do that again", "Dont commit it back though", "Don't make it amber anymore", "Stop doing that", "Don't touch them", "Never revert ABC-123 by hand",
    "Don't close PR 42 before the demo", "Never rebase on branch feat/new-login", "Don't cherry-pick 3f9c2ab1 onto main", "Never close #17 by hand",
  ]) assert.equal(classifyClause(clause), "task-bound", clause);
  for (const clause of ["Don't commit to main", "Never touch this file by hand", "Always check that the build passes", "Don't spawn subagents", "Don't let it spawn subagents"]) {
    assert.equal(classifyClause(clause), "standing", clause);
  }
  const items = evaluate([...thrice("Don't commit or stage it"), ...thrice("Don't commit to main")]);
  assert.equal(statusOf(items, "Don't commit or stage it"), "not injected: task-bound");
  assert.equal(statusOf(items, "Don't commit to main"), WAS_INJECTED, "the task-bound wording lends it no sessions and takes none");
});

test("rule 4: three sessions on two days are injected; two sessions or one day are listed only", () => {
  const two = [said("Never force-push the release branch", "a", "2026-01-10"), said("Never force-push the release branch", "b", "2026-01-12")];
  const oneDay = ["c", "d", "e"].map(name => said("Always squash merge feature branches", name, "2026-01-11"));
  const items = evaluate([...thrice("Keep replies short"), ...two, ...oneDay]);
  assert.equal(statusOf(items, "Keep replies short"), WAS_INJECTED);
  assert.equal(statusOf(items, "Never force-push the release branch"), "not injected: seen in 2 sessions");
  assert.equal(statusOf(items, "Always squash merge feature branches"), "not injected: seen on 1 day");
});

test("rule 5: last seen within 30 days, and no later message of the opposite polarity", () => {
  const stale = evaluate(thrice("Keep replies short"), emptyPrefsStore(), at("2026-02-20"));
  assert.equal(stale[0]!.status, "not injected: last seen 2026-01-12, over 30 days ago");
  const subagents = thrice("Don't spawn subagents");
  const lifted = evaluate([...subagents, said("do use subagents here", "later", "2026-01-14", true)]);
  assert.equal(statusOf(lifted, "Don't spawn subagents"), "not injected: contradicted by a later message");
  assert.equal(lifted.length, 1, "a permission is never listed itself");
  const earlier = evaluate([...subagents, said("do use subagents here", "earlier", "2026-01-09", true)]);
  assert.equal(statusOf(earlier, "Don't spawn subagents"), WAS_INJECTED, "a permission the user later took back does not lift it");
  const opposite = evaluate([...thrice("Always squash commits"), said("Never squash commits", "later", "2026-01-15")]);
  assert.equal(statusOf(opposite, "Always squash commits"), "not injected: contradicted by a later message");
});

test("rule 6: a preference that skips, disables, or avoids a check is listed, never injected; the markers live in one constant", () => {
  for (const clause of [
    "Always skip the tests before pushing", "Don't run the tests", "Don't run the live tests", "Don't run the checks", "Never ask before pushing",
    "Never ask for a review", "Don't wait for the review", "Don't review the diff", "Don't check the output", "Never verify before pushing",
    "Always commit with --no-verify", "Always disable warden in this repo", "Always push without asking", "Always deploy without asking",
    "Always delete old branches without confirmation", "Stop testing it",
  ]) assert.equal(classifyClause(clause), "weakens", clause);
  assert.ok(WEAKENS_CHECK.asked.length > 0 && WEAKENS_CHECK.refused.length > 0);
  const items = evaluate([...thrice("Always skip the tests before pushing"), ...thrice("Don't run the live tests")]);
  assert.equal(statusOf(items, "Always skip the tests before pushing"), "not injected: weakens a check");
  assert.equal(statusOf(items, "Don't run the live tests"), "not injected: weakens a check");
});

test("rule 6: a prohibition of a harmful action is a safety preference and is injected", () => {
  const safety = [
    "Never check in secrets", "Never force-push the release branch", "Don't commit to main", "Never test in production", "Never skip the tests",
    "Never push without asking", "Always run the checks before a commit", "Dont run subagents do the review yourself",
  ];
  for (const clause of safety) assert.equal(classifyClause(clause), "standing", clause);
  assert.equal(classifyClause("Don't ever run the tests"), "weakens");
  const injected = ["Never check in secrets", "Never force-push the release branch", "Don't commit to main", "Never test in production", "Never push without asking"];
  const items = evaluate(injected.flatMap(thrice));
  for (const clause of injected) assert.equal(statusOf(items, clause), WAS_INJECTED, clause);
  assert.match(prefsMessage(items)!, /- "Never check in secrets" \(3 sessions\)/);
});

test("rule 7: at most five items and 400 characters; the closing sentence is exact", () => {
  const clauses = ["Keep replies short", "Never force-push the release branch", "Always sign the tags", "Don't edit the lockfile by hand", "Always write changelog entries", "Never rename public exports"];
  const items = evaluate(clauses.flatMap(thrice));
  assert.equal(items.filter(item => item.injected).length, MAX_INJECTED);
  assert.equal(items.filter(item => !item.injected)[0]!.status, `not injected: over the ${MAX_INJECTED}-item or ${MESSAGE_CHARS}-character cap`);
  const message = prefsMessage(items)!;
  assert.ok(message.startsWith(`${PREFS_LEAD}\n- "`));
  assert.ok(message.endsWith("\nIf the current request says otherwise, follow the current request."));
  assert.equal(PREFS_CLOSING, "If the current request says otherwise, follow the current request.");
  assert.match(message, /- "Keep replies short" \(3 sessions\)/, "quoted as said, with the session count");
  const long = [
    "Always describe the database migration steps in the pull request body with rollback notes and owners",
    "Never rename exported functions without adding a deprecated alias that forwards to the new name",
    "Always keep screenshots of changed panels beside the design review document for the product team",
  ];
  const capped = evaluate(long.flatMap(thrice));
  const cappedMessage = prefsMessage(capped)!;
  assert.ok(cappedMessage.length <= MESSAGE_CHARS);
  assert.ok(capped.some(item => !item.injected && item.status.includes("cap")));
  assert.equal(prefsMessage(evaluate([])), undefined);
});

const lesson = (overrides: Partial<Parameters<typeof recordLesson>[0]> = {}) =>
  recordLesson({ lesson: "Never edit the generated client by hand", session: "s1", now: at("2026-01-10"), signal: true, scan: scanOf([]), store: emptyPrefsStore(), ...overrides });

test("agent lesson: rejected without a correction or failure, and when it weakens a check or is not standing", () => {
  assert.deepEqual(lesson({ signal: false }), { reply: NO_LESSON_SIGNAL });
  assert.equal(NO_LESSON_SIGNAL, "not recorded: no correction or failure to learn from");
  assert.deepEqual(lesson({ lesson: "Always skip the tests when the build is slow" }), { reply: "not recorded: weakens a check" });
  assert.match(lesson({ lesson: "Don't commit or stage it" }).reply, /^not recorded: task-bound/);
  assert.match(lesson({ lesson: "The client is generated" }).reply, /^not recorded: not one standing instruction/);
  assert.match(lesson({ lesson: "Don't touch the schema yet" }).reply, /^not recorded: not one standing instruction/);
  assert.match(lesson({ lesson: `Never ${"write long notes ".repeat(12)}` }).reply, /^not recorded: longer than 160 characters/);
  assert.equal(lesson({ signal: false }).store, undefined);
  assert.ok(isCorrection("don't commit it yet"), "a temporary hold still corrects the agent");
  assert.ok(!isCorrection("thanks, looks good"));
});

test("agent lesson: recorded but not injected until confirmed; injected after a later session with the marker", () => {
  const first = lesson();
  assert.match(first.reply, /^recorded: "Never edit the generated client by hand"/);
  const pending = evaluate([], first.store!);
  assert.equal(pending[0]!.status, NOT_CONFIRMED);
  assert.equal(prefsMessage(pending), undefined);
  const same = lesson({ store: first.store!, now: at("2026-01-10") });
  assert.equal(evaluate([], same.store!)[0]!.status, NOT_CONFIRMED, "the same session again is no confirmation");
  const second = lesson({ lesson: "never edit the generated client by hand", session: "s2", now: at("2026-01-11"), store: first.store! });
  assert.match(second.reply, /^recorded as a confirmation of the agent lesson "Never edit the generated client by hand" \(2 sessions\)/);
  assert.equal(second.store!.lessons.length, 1, "a duplicate confirms, it is not added");
  const confirmed = evaluate([], second.store!);
  assert.equal(confirmed[0]!.status, WAS_INJECTED);
  assert.match(prefsMessage(confirmed)!, new RegExp(`- "Never edit the generated client by hand" \\(2 sessions\\) ${LESSON_MARK.replace(/[()]/g, "\\$&")}`));
  const byUser = evaluate([said("never edit the generated client by hand", "u1", "2026-01-12")], first.store!);
  assert.equal(statusOf(byUser, "Never edit the generated client by hand"), WAS_INJECTED, "a matching user preference confirms it");
});

test("agent lesson: user preferences fill the budget first; a lesson repeating a listed preference confirms it instead", () => {
  const store = lesson({ lesson: "Always sign the release tags", session: "s1" }).store!;
  const confirmedStore = lesson({ lesson: "Always sign the release tags", session: "s2", now: at("2026-01-11"), store }).store!;
  const clauses = ["Keep replies short", "Never force-push the release branch", "Always write changelog entries", "Don't edit the lockfile by hand", "Never rename public exports"];
  const items = evaluate(clauses.flatMap(thrice), confirmedStore);
  assert.equal(items.at(-1)!.source, "agent");
  assert.match(items.at(-1)!.status, /over the 5-item/);
  const listed = thrice("Keep replies short");
  const repeat = lesson({ lesson: "Always keep replies short", scan: scanOf(listed) });
  assert.match(repeat.reply, /^recorded as a confirmation of the user's preference "Keep replies short"/);
  assert.equal(repeat.store!.lessons.length, 0);
  const shown = evaluate(listed, repeat.store!);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.agentConfirmations, 1);
});

test("agent lesson: expires after 30 days without a confirmation", () => {
  const store = lesson().store!;
  assert.equal(evaluate([], store, at("2026-02-10"))[0]!.status, "not injected: agent lesson expired, not confirmed in 30 days");
  const later = lesson({ lesson: "Always sign the release tags", session: "s9", now: at("2026-02-15"), store });
  assert.deepEqual(later.store!.lessons.map(entry => entry.text), ["Always sign the release tags"], "an expired lesson is dropped when the file is written");
});

test("forget: a user preference or an agent lesson is never listed or injected again, rewordings included", () => {
  const candidates = thrice("Don't spawn subagents");
  const items = evaluate(candidates);
  const store = forgetPref(emptyPrefsStore(), items[0]!, NOW);
  assert.deepEqual(evaluate(candidates, store), []);
  assert.deepEqual(evaluate([...candidates, ...thrice("Never use subagents")], store), [], "the same group in other words");
  assert.equal(prefsMessage(evaluate(candidates, store)), undefined);
  const recorded = lesson().store!;
  const lessonItem = evaluate([], recorded)[0]!;
  const forgot = forgetPref(recorded, lessonItem, NOW);
  assert.deepEqual(forgot.lessons, []);
  assert.deepEqual(evaluate([], forgot), []);
  assert.equal(lesson({ store: forgot }).reply, "not recorded: the user forgot this preference");
});

test("the lesson file lives under pi-warden's data folder, round-trips, and a corrupt one fails closed", async () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  const agent = await mkdtemp(join(tmpdir(), "pi-warden-prefs-store-"));
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const path = prefsStorePath("/work/repo");
    assert.equal(dirname(path), join(agent, "pi-warden", "prefs"));
    assert.notEqual(path, prefsStorePath("/work/other"));
    assert.deepEqual(await readPrefsStore(path), emptyPrefsStore(), "a missing file is empty");
    const store = lesson().store!;
    await writePrefsStore(path, store);
    assert.deepEqual(await readPrefsStore(path), store);
    assert.match(await readFile(path, "utf8"), /"session": "s1"/);
    await writeFile(path, "{ torn");
    await assert.rejects(readPrefsStore(path));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(agent, { recursive: true, force: true });
  }
});
