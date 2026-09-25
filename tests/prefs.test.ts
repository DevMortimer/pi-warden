import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import {
  CLAUSE_CHARS, emptyPrefsStore, emptyWordCounts, evaluatePrefs, extractPreferences, formatPrefs, groupPreferences, isHumanTyped, jaccard, PREFS_HINT,
  scanPreferences, tokens,
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
  assert.deepEqual(prefs.map(pref => [pref.text, pref.sessions, pref.lastAt]), [["Dont use tabs in the makefile", 2, at(2)]]);
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
  assert.deepEqual([missing.prefs, missing.candidates, missing.scanned, missing.directories], [[], [], 0, 1]);
});

test("command output lists each item with count, days, last date, and status, with the hint", async () => {
  const scan = await scanPreferences({ dir, exclude: CURRENT, now: NOW });
  const text = formatPrefs(scan, evaluatePrefs(scan, emptyPrefsStore(), NOW));
  assert.match(text, /^Standing preferences \(repeated in 2\+ of the last 3 sessions of this project; injected from 3 sessions on 2 days\):/);
  assert.match(text, /1\. Never paste the api_key=\[redacted\] value into the chat log \(2 sessions on 2 days, last 2026-01-03\): not injected: seen in 2 sessions/);
  assert.ok(text.endsWith(PREFS_HINT));
  assert.match(formatPrefs({ scanned: 1, directories: 1 }, []), /No standing preferences: nothing was repeated in 2 or more of the last 1 session of this project, and the agent recorded no lesson\./);
});

test("scan time on the fixture stays small and the files are untouched", async () => {
  const stamps = await Promise.all((await readdir(dir)).map(async name => (await stat(join(dir, name))).mtimeMs));
  const scan = await scanPreferences({ dir, now: NOW });
  assert.ok(scan.ms < 300);
  assert.deepEqual(await Promise.all((await readdir(dir)).map(async name => (await stat(join(dir, name))).mtimeMs)), stamps);
});

test("detection: relayed orders and messages from other agents are not the user", () => {
  assert.equal(isHumanTyped("# WORK ORDER\n\nPROJECT: docs\nBRANCH: tidy-readme\n\nNever push to main."), false, "an order with a heading");
  assert.equal(isHumanTyped("Tidy the docs.\nPROJECT: docs\nBRANCH: tidy-readme\nNever push to main."), false, "a header block of field lines");
  assert.equal(isHumanTyped("From Lead agent:\n\nAdded rule: offline only. Do not run the live tests. Continue your task."), false);
  assert.equal(isHumanTyped("Heads up from the Planner: never push to main while the release is open."), false);
  assert.equal(isHumanTyped("Added by the owner: never push to main while the release is open."), false);
  assert.equal(isHumanTyped("Owner change: never push to main, open a draft instead."), false);
  assert.deepEqual(extractPreferences("From Lead agent:\n\nAdded rule: offline only. Do not run the live tests. Continue your task."), []);
  assert.equal(isHumanTyped("from now on: never push to main"), true, "a lowercase \"from\" line is the user's own");
  assert.equal(isHumanTyped("Note: never push to main"), true, "one label is not a header block");
});

test("detection: a temporary hold is not a standing preference", () => {
  assert.deepEqual(extractPreferences("don't commit the migration yet"), []);
  assert.deepEqual(extractPreferences("always skip the e2e suite for now"), []);
  assert.deepEqual(extractPreferences("don't push until the checks pass"), []);
});

test("grouping: differently worded clauses that share a rare subject word are one preference", () => {
  const counts = emptyWordCounts();
  counts.messages = 100;
  for (const [word, count] of [["subagent", 2], ["review", 2], ["spawn", 1], ["commit", 3], ["push", 3], ["bump", 1], ["version", 2]] as const) counts.words.set(word, count);
  const at = (day: number) => Date.parse(`2026-01-0${day}T00:00:00.000Z`);
  const subagents = [
    { clause: "Don't spawn subagents", session: "s1", at: at(1) },
    { clause: "Never use subagents, review it yourself", session: "s2", at: at(2) },
  ];
  assert.ok(jaccard(tokens(subagents[0]!.clause), tokens(subagents[1]!.clause)) < 0.6, "the words alone do not match");
  assert.deepEqual(groupPreferences(subagents, counts).map(pref => [pref.text, pref.sessions]), [["Never use subagents, review it yourself", 2]]);
  const common = emptyWordCounts();
  common.messages = 100;
  common.words.set("subagent", 40);
  assert.deepEqual(groupPreferences(subagents, common), [], "a common word is not a subject");
  // A shared rare word with little else in common stays apart.
  assert.deepEqual(groupPreferences([
    { clause: "Always commit and push", session: "s1", at: at(1) },
    { clause: "Always commit and bump the version", session: "s2", at: at(2) },
  ], counts), []);
  assert.deepEqual(groupPreferences([
    { clause: "Always spawn subagents", session: "s1", at: at(1) },
    { clause: "Never use subagents, review it yourself", session: "s2", at: at(2) },
  ], counts), [], "opposite polarity never groups");
});

test("scan: sessions from another worktree of the same repository are read; other repositories and nested ones are not", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-warden-prefs-wt-")));
  try {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { stdio: "ignore" });
    const main = join(base, "repo");
    const worktree = join(base, "repo-feature");
    const other = join(base, "other");
    const nested = join(main, "vendor", "lib");
    for (const path of [main, other, nested]) await mkdir(path, { recursive: true });
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", worktree);
    git(other, "init", "-q");
    git(nested, "init", "-q");
    const sessions = join(base, "sessions");
    const session = async (cwd: string, name: string, text: string) => {
      const dir = join(sessions, cwd.slice(base.length).replace(/[/\\]/g, "-") || "root");
      await mkdir(dir, { recursive: true });
      const header = { type: "session", version: 3, id: name, timestamp: "2026-01-02T00:00:00.000Z", cwd };
      const message = { type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: text } };
      await writeFile(join(dir, `${name}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
      const at = new Date(NOW - 86_400_000);
      await utimes(join(dir, `${name}.jsonl`), at, at);
      return dir;
    };
    const own = await session(main, "s-main", "never force-push the release branch. always squash merge feature branches");
    await session(worktree, "s-worktree", "please never force-push the release branch");
    await session(join(main, "docs"), "s-subdir", "ok, never force-push the release branch");
    await session(other, "s-other", "always squash merge feature branches");
    await session(nested, "s-nested", "always squash merge feature branches");
    const scan = await scanPreferences({ dir: own, cwd: main, now: NOW });
    assert.equal(scan.directories, 3, "the project, its worktree, and a subdirectory of it");
    assert.deepEqual(scan.prefs.map(pref => [pref.text, pref.sessions]), [["Never force-push the release branch", 3]]);
    assert.match(formatPrefs(scan, evaluatePrefs(scan, emptyPrefsStore(), NOW)), /of the last 3 sessions of this project and its worktrees/);
    assert.equal(scan.project, main, "the lesson file is keyed by the main worktree");
    const alone = await scanPreferences({ dir: own, now: NOW });
    assert.equal(alone.directories, 1, "without a working directory only the project's own sessions are read");
    const outside = await scanPreferences({ dir: own, cwd: base, now: NOW });
    assert.equal(outside.directories, 1, "outside a repository only the project's own sessions are read");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
