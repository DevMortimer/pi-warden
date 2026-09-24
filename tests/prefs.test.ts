import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import {
  CLAUSE_CHARS, extractPreferences, formatPrefs, groupPreferences, isHumanTyped, jaccard, MESSAGE_CHARS, PREFS_HINT, PREFS_LEAD,
  prefsMessage, scanPreferences, tokens,
} from "../src/prefs.js";

const FIXTURES = resolve("tests/fixtures/prefs");
const NOW = Date.parse("2026-01-05T00:00:00.000Z");
const CURRENT = "2026-01-04T10-00-00-000Z_current.jsonl";
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-warden-prefs-"));
  await cp(FIXTURES, dir, { recursive: true });
  // The window is measured from file modification times; pin them to the session dates in the file names.
  for (const name of await readdir(dir)) {
    const at = new Date(name.slice(0, 10) + "T12:00:00.000Z");
    await utimes(join(dir, name), at, at);
  }
});

after(() => rm(dir, { recursive: true, force: true }));

test("detection: imperative preference forms are candidates", () => {
  assert.deepEqual(extractPreferences("Please don't open pull requests, leave the branch local."), ["Don't open pull requests, leave the branch local"]);
  assert.deepEqual(extractPreferences("looks fine. never force-push the release branch"), ["Never force-push the release branch"]);
  assert.deepEqual(extractPreferences("Always run the linter before you commit."), ["Always run the linter before you commit"]);
  assert.deepEqual(extractPreferences("stop adding emoji to the changelog"), ["Stop adding emoji to the changelog"]);
  assert.deepEqual(extractPreferences("ok, from now on write commit messages in the imperative mood"), ["Write commit messages in the imperative mood"]);
  assert.deepEqual(extractPreferences("next time, ask before you delete a branch"), ["Ask before you delete a branch"]);
  assert.deepEqual(extractPreferences("I told you to keep the tests offline"), ["Keep the tests offline"]);
  assert.deepEqual(extractPreferences("yes proceed. but do not bump the version in this commit"), ["Do not bump the version in this commit"]);
});

test("detection: questions, statements, fragments, and relayed text are not candidates", () => {
  // A question asks for a reason or suggests one step; it is not a standing preference.
  assert.deepEqual(extractPreferences("why don't you run the linter first?"), []);
  assert.deepEqual(extractPreferences("Why do you always amend the last commit?"), []);
  assert.deepEqual(extractPreferences("do you always run the full suite?"), []);
  // The dropped "I": a statement about the user, not an instruction.
  assert.deepEqual(extractPreferences("don't know why the build broke"), []);
  assert.deepEqual(extractPreferences("i don't like how the panel looks"), []);
  assert.deepEqual(extractPreferences("don't worry about the flaky test"), []);
  assert.deepEqual(extractPreferences("the watcher never closes the file handle"), []);
  assert.deepEqual(extractPreferences("it never printed a summary"), []);
  assert.deepEqual(extractPreferences("i told you i did"), []);
  assert.deepEqual(extractPreferences("agents started from now on would use it too"), []);
  assert.deepEqual(extractPreferences("don't merge"), [], "one content word is a fragment");
  assert.equal(isHumanTyped("# Order\n\nNever push to main."), false);
  assert.equal(isHumanTyped("<skill name=\"x\">\nAlways lint.\n</skill>"), false);
  assert.equal(isHumanTyped("STATUS REPORT   FROM: worker-1\nNever push to main."), false);
  assert.equal(isHumanTyped("SCHEDULE · 10:00 · check the queue\nNever push to main."), false);
  assert.equal(isHumanTyped(`never push to main. ${"x".repeat(2100)}`), false);
  assert.equal(isHumanTyped("never push to main"), true);
});

test("detection: a clause is redacted and capped", () => {
  const [clause] = extractPreferences("never paste the api_key=abcd1234efgh5678 value into the chat log");
  assert.equal(clause, "Never paste the api_key=[redacted] value into the chat log");
  const [long] = extractPreferences(`always ${"write a long careful note ".repeat(20)}`);
  assert.ok(long!.length <= CLAUSE_CHARS);
  assert.ok(long!.endsWith("…"));
});

test("grouping: near-duplicates share a group; polarity keeps opposites apart", () => {
  assert.ok(jaccard(tokens("don't open pull requests, leave the branch local"), tokens("dont open pull requests leave the branch local")) >= 0.6);
  assert.ok(jaccard(tokens("don't use tabs"), tokens("dont use tabs in the makefile")) >= 0.6);
  const at = (day: number) => Date.parse(`2026-01-0${day}T00:00:00.000Z`);
  const prefs = groupPreferences([
    { clause: "Don't use tabs", session: "s1", at: at(1) },
    { clause: "Dont use tabs in the makefile", session: "s2", at: at(2) },
    { clause: "Never squash commits", session: "s1", at: at(1) },
    { clause: "Always squash commits", session: "s2", at: at(2) },
  ]);
  assert.deepEqual(prefs, [{ text: "Dont use tabs in the makefile", sessions: 2, lastAt: at(2) }]);
});

test("the 2-session threshold: repeats inside one session do not count; ranking is sessions, then recency", () => {
  const at = (day: number) => Date.parse(`2026-01-0${day}T00:00:00.000Z`);
  const prefs = groupPreferences([
    { clause: "Never bump the version", session: "s1", at: at(1) },
    { clause: "Never bump the version", session: "s1", at: at(2) },
    { clause: "Keep replies short please", session: "s1", at: at(1) },
    { clause: "Keep replies short", session: "s2", at: at(2) },
    { clause: "Run the linter first", session: "s1", at: at(3) },
    { clause: "Run the linter first", session: "s2", at: at(4) },
    { clause: "Keep replies short", session: "s3", at: at(1) },
  ]);
  assert.deepEqual(prefs.map(pref => [pref.text, pref.sessions]), [["Keep replies short", 3], ["Run the linter first", 2]]);
});

test("scan: human user messages of earlier sessions only; the current session is excluded", async () => {
  const before = await readFile(join(dir, CURRENT), "utf8");
  const scan = await scanPreferences({ dir, exclude: join(dir, CURRENT), now: NOW });
  assert.equal(scan.scanned, 3);
  assert.deepEqual(scan.prefs.map(pref => [pref.text, pref.sessions]), [
    ["Never paste the api_key=[redacted] value into the chat log", 2],
    ["Write commit messages in imperative mood", 2],
    ["Dont open pull requests, leave the branch local", 2],
  ]);
  const text = scan.prefs.map(pref => pref.text).join("\n");
  assert.doesNotMatch(text, /abcd1234|zzzz9999/, "redacted");
  assert.doesNotMatch(text, /formatter/i, "tool results, custom messages, relayed orders, and questions are skipped");
  assert.doesNotMatch(text, /linter/i, "one earlier session plus the current one is not a standing preference");
  assert.equal(await readFile(join(dir, CURRENT), "utf8"), before, "read-only");
  const withCurrent = await scanPreferences({ dir, now: NOW });
  assert.ok(withCurrent.prefs.some(pref => /linter/i.test(pref.text)));
});

test("scan: the window drops old sessions and caps the count; a missing directory is empty", async () => {
  const recent = await scanPreferences({ dir, now: NOW, maxAgeDays: 2 });
  assert.equal(recent.scanned, 2);
  const capped = await scanPreferences({ dir, now: NOW, maxSessions: 1 });
  assert.equal(capped.scanned, 1);
  assert.deepEqual(capped.prefs, []);
  const missing = await scanPreferences({ dir: join(dir, "absent"), now: NOW });
  assert.deepEqual(missing, { prefs: [], scanned: 0, ms: missing.ms });
});

test("command output lists count and last date, with the hint; the message is capped", async () => {
  const scan = await scanPreferences({ dir, exclude: CURRENT, now: NOW });
  const text = formatPrefs(scan);
  assert.match(text, /^Standing preferences \(repeated in 2\+ of the last 3 sessions of this project\):/);
  assert.match(text, /1\. Never paste the api_key=\[redacted\] value into the chat log \(2 sessions, last 2026-01-03\)/);
  assert.ok(text.endsWith(PREFS_HINT));
  assert.match(formatPrefs({ prefs: [], scanned: 1, ms: 0 }), /No standing preferences: nothing was repeated in 2 or more of the last 1 session of this project\./);
  const message = prefsMessage(scan.prefs)!;
  assert.ok(message.startsWith(PREFS_LEAD));
  assert.equal(message.split("\n- ").length - 1, 3);
  const many = Array.from({ length: 10 }, (_, index) => ({ text: `${"x".repeat(150)} ${index}`, sessions: 2, lastAt: NOW }));
  assert.ok(prefsMessage(many)!.length <= MESSAGE_CHARS);
  assert.equal(prefsMessage([]), undefined);
});

test("scan time on the fixture stays small and the files are untouched", async () => {
  const stamps = await Promise.all((await readdir(dir)).map(async name => (await stat(join(dir, name))).mtimeMs));
  const scan = await scanPreferences({ dir, now: NOW });
  assert.ok(scan.ms < 300);
  assert.deepEqual(await Promise.all((await readdir(dir)).map(async name => (await stat(join(dir, name))).mtimeMs)), stamps);
});
