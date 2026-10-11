import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, before, test } from "node:test";
import type { Judge } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import type { RulesConfig } from "../src/config.js";
import { editRulesFor, evaluateRules, formatRuleSetDetails, parseRules, RuleStore, skipReason, turnRulesFor } from "../src/rules.js";
import type { Rule } from "../src/rules.js";
import { BROUGHT_PROBE_LIMIT, diffSince, evaluateTurnRun, snapshotTree, turnSteer, TURN_PATH } from "../src/turn-rules.js";

let repo: string;
let notRepo: string;

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).toString();
const gitPath = (name: string) => {
  const path = git("rev-parse", "--git-path", name).trim();
  return isAbsolute(path) ? path : join(repo, path);
};
const indexHash = async () => createHash("sha256").update(await readFile(gitPath("index"))).digest("hex");
/** Everything the snapshot must leave alone: the stash list, the real index bytes, and the worktree state. */
const readOnlyState = async () => `${git("stash", "list")}|${await indexHash()}|${git("status", "--porcelain")}`;

const rulesConfig = (overrides: Partial<RulesConfig> = {}): RulesConfig => ({ ...defaultConfig().rules, ...overrides });

const TURN_MD = [
  "# The change stays inside the task",
  "when: turn",
  "The diff must contain only what the user's task asked for.",
  "",
  "# No console statements",
  "Code must not contain `console.log` calls. Use the logger.",
  "",
  "# No single-use abstractions",
  "when: turn",
  "A new helper introduced and used exactly once is a violation.",
].join("\n");

/** Answers every rule question from `violations` by rule id; unnamed rules are compliant. */
function stubJudge(violations: Record<string, number> = {}): Judge & { requests: Array<{ state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, unknown> }> }> } {
  const judge = {
    requests: [] as Array<{ state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, unknown> }> }>,
    async evaluate(request: unknown) {
      const body = request as { state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
      judge.requests.push(body);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(body.questions)) {
        const violation = violations[id.replace(/^(?:rule|turn)_/, "")] ?? 0.05;
        const choice = violation >= 0.5 ? "violation" : "compliant";
        answers[id] = { type: "choice", choice, confidence: 0.9, probabilities: { compliant: 1 - violation - 0.02, violation, not_applicable: 0.01, insufficient_context: 0.01 } };
      }
      return { model: "jev-test", elapsedMs: 7, answers } as never;
    },
  };
  return judge;
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "pi-warden-turn-"));
  notRepo = await mkdtemp(join(tmpdir(), "pi-warden-turn-off-"));
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "one\n");
  await writeFile(join(repo, "b.txt"), "bee\n");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await writeFile(join(repo, "pi-warden.md"), TURN_MD);
  git("add", ".");
  git("commit", "-q", "-m", "seed");
  // One stash entry, so the read-only check has a stash list worth keeping.
  await writeFile(join(repo, "b.txt"), "stashed\n");
  git("stash", "push", "-q", "-m", "seed-stash");
  await writeFile(join(repo, "b.txt"), "bee\n");
});
after(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(notRepo, { recursive: true, force: true });
});

test("parseRules: when: turn marks a rule for the end-of-run pass, the default is edit, and bad or repeated values warn", () => {
  const rules = parseRules([
    "# Edit rule", "Body.", "",
    "# Turn rule", "when: turn", "Body.", "",
    "# Mixed headers", "when: Turn", "paths: src/**", "severity: low", "threshold: 0.8", "Body.", "",
    "# Bad when", "when: later", "Body.", "",
    "# Duplicate when", "when: turn", "when: edit", "Body.", "",
  ].join("\n"));
  assert.equal(rules[0]!.when, undefined, "no when: line means edit");
  assert.equal(rules[1]!.when, "turn");
  assert.equal(rules[2]!.when, "turn", "when: is case-insensitive like the other headers");
  assert.deepEqual(rules[2]!.paths, ["src/**"]);
  assert.equal(rules[2]!.severity, "low");
  assert.equal(rules[2]!.threshold, 0.8);
  assert.deepEqual(rules[3]!.headerWarnings, ["when: later is not edit or turn; ignored"]);
  assert.equal(rules[3]!.when, undefined, "a bad value is dropped");
  assert.deepEqual(rules[4]!.headerWarnings, ["when: appears more than once; the first is kept"]);
  assert.equal(rules[4]!.when, "turn", "the first when: is kept");
  assert.ok(!rules[3]!.body.includes("when:"), "the header line never stays in the body");
  const details = formatRuleSetDetails({ sources: ["pi-warden.md"], rules: [rules[1]!], alwaysDropped: 0 }, "root");
  assert.match(details, /when: turn/, "/warden rules shows the header");
});

test("evaluateRules: when: turn rules are never asked on a write or an edit, and a path only they match is skipped", async () => {
  const set: { rules: Rule[] } = { rules: parseRules(TURN_MD) };
  const judge = stubJudge({ "no-single-use-abstractions": 0.9, "the-change-stays-inside-the-task": 0.9, "no-console-statements": 0.9 });
  const verdict = await evaluateRules("write", { path: "src/a.ts", content: "console.log(1)" }, { cwd: repo, config: rulesConfig(), set: set as never, judge, timeoutMs: 1000 });
  const asked = Object.keys(judge.requests[0]!.questions);
  assert.deepEqual(asked, ["rule_no-console-statements"], "the turn rules are not asked per edit");
  assert.equal(verdict.findings.length, 1);
  assert.equal(turnRulesFor(set as never).length, 2);
  assert.equal(editRulesFor(set as never, "src/a.ts").length, 1);
  const turnOnly = { rules: [parseRules(TURN_MD)[0]!] };
  assert.equal(skipReason({ tool: "write", path: "src/a.ts", content: "x" }, turnOnly as never, rulesConfig()), "no rule's paths match this file");
});

test("snapshotTree and diffSince: a read-only baseline that sees untracked non-ignored files and cuts the diff per file and in total", async () => {
  const before = await readOnlyState();
  const snapshot = await snapshotTree(repo);
  assert.ok(snapshot.tree, `snapshot must succeed: ${snapshot.reason}`);
  assert.equal(await readOnlyState(), before, "snapshotTree must not touch the stash list, the index, or the worktree");

  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  await writeFile(join(repo, "new.txt"), "fresh\n");
  await writeFile(join(repo, "ignored.txt"), "never judged\n");
  const dirty = await readOnlyState();
  const diff = await diffSince(repo, snapshot.tree!, 8000);
  assert.ok(diff);
  assert.deepEqual(diff.files.map(file => file.path), ["a.txt", "new.txt"], "the changed tracked file and the new untracked file, not the ignored one");
  assert.deepEqual(diff.files.map(file => file.status), ["M", "A"]);
  assert.match(diff.text, /\+two/, "the diff shows the added line");
  assert.equal(await readOnlyState(), dirty, "diffSince must not touch the stash list, the index, or the worktree");
  assert.equal(git("stash", "list").trim().split("\n").length, 1, "the stash list is untouched");

  await writeFile(join(repo, "a.txt"), `one\n${"filler line to cut\n".repeat(60)}`);
  const capped = (await diffSince(repo, snapshot.tree!, 200))!;
  assert.ok(capped.cuts.some(cut => cut.startsWith("a.txt: file diff cut")), `a per-file cut is named: ${JSON.stringify(capped.cuts)}`);
  assert.ok(capped.text.length <= 200 + 100, "the total is capped");
  assert.match(capped.text, /cut/, "the cut is said inline");
  const fileDiff = capped.files.find(file => file.path === "a.txt")!;
  assert.ok(fileDiff.diff.includes("more chars of this file's diff cut"), "the per-file cap says what it cut");
});

test("snapshotTree: a directory that is not a git repository gets a reason and no tree", async () => {
  const result = await snapshotTree(notRepo);
  assert.equal(result.tree, undefined);
  assert.equal(result.reason, "not a git repository");
});

test("evaluateTurnRun: a file a per-edit judgment saw is judged once, and one already judged is not judged again", async () => {
  const store = new RuleStore();
  const config = rulesConfig();
  const set = store.load(repo, config)!;
  const snapshot = await snapshotTree(repo);
  assert.ok(snapshot.tree);
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  await writeFile(join(repo, "b.txt"), "changed by sed\n");
  const judge = stubJudge({ "no-console-statements": 0.9, "the-change-stays-inside-the-task": 0.9, "no-single-use-abstractions": 0.05 });
  const run = await evaluateTurnRun({
    cwd: repo, config, set, judge, timeoutMs: 1000,
    task: "update the config", startTree: snapshot.tree!, alreadyJudged: new Set(["b.txt"]),
  });
  assert.deepEqual(run.verdicts.map(verdict => [verdict.tool, verdict.path]), [["turn", TURN_PATH], ["edit", "a.txt"]], "the turn verdict plus the one file no per-edit check saw");
  assert.equal(judge.requests.length, 2);
  const turnRequest = judge.requests[0]!;
  assert.equal(turnRequest.state.task, "update the config");
  assert.match(String(turnRequest.state.diff), /a\.txt/, "the turn question sees the whole diff");
  assert.match(String(turnRequest.state.diff), /changed by sed/, "the turn question sees every changed file, judged or not");
  const fileRequest = judge.requests[1]!;
  assert.match(String((fileRequest.state as { edits: Array<{ newText: string }> }).edits[0]!.newText), /a\.txt/, "the file's diff stands as the edit");
  assert.ok(!String((fileRequest.state as { edits: Array<{ newText: string }> }).edits[0]!.newText).includes("changed by sed"), "the already-judged file gets no second request");
  assert.equal(run.verdicts[0]!.findings.map(finding => finding.id).join(), "the-change-stays-inside-the-task");
  assert.equal(run.verdicts[1]!.findings.map(finding => finding.id).join(), "no-console-statements");
});

test("evaluateTurnRun: a sed -i change no per-edit guard saw is judged with the edit rules, and no turn request is sent without turn rules", async () => {
  const editOnly = { sources: ["pi-warden.md"], rules: parseRules("# No console statements\nCode must not contain `console.log` calls."), alwaysDropped: 0 };
  const config = rulesConfig();
  const snapshot = await snapshotTree(repo);
  assert.ok(snapshot.tree);
  const platformArgs = process.platform === "darwin" ? ["-i", "", "-e", "s/changed by sed/one/", "b.txt"] : ["-i", "-e", "s/changed by sed/one/", "b.txt"];
  execFileSync("sed", platformArgs, { cwd: repo, stdio: "pipe" });
  const judge = stubJudge({ "no-console-statements": 0.9 });
  const run = await evaluateTurnRun({ cwd: repo, config, set: editOnly as never, judge, timeoutMs: 1000, task: "fix b", startTree: snapshot.tree!, alreadyJudged: new Set() });
  assert.deepEqual(run.verdicts.map(verdict => [verdict.tool, verdict.path]), [["edit", "b.txt"]], "the sed -i file is judged as one edit of its diff");
  assert.equal(judge.requests.length, 1, "no turn request when the rule set has no when: turn rules");
  assert.equal(run.verdicts[0]!.findings.map(finding => finding.id).join(), "no-console-statements");
});

test("evaluateTurnRun: with no turn rules and no unseen change the pass is silent and sends nothing", async () => {
  const editOnly = { sources: ["pi-warden.md"], rules: parseRules("# No console statements\nCode must not contain `console.log` calls."), alwaysDropped: 0 };
  const config = rulesConfig();
  const snapshot = await snapshotTree(repo);
  assert.ok(snapshot.tree);
  await writeFile(join(repo, "a.txt"), "written by the agent\n");
  const judge = stubJudge();
  const run = await evaluateTurnRun({ cwd: repo, config, set: editOnly as never, judge, timeoutMs: 1000, startTree: snapshot.tree!, alreadyJudged: new Set(["a.txt", "pi-warden.md"]) });
  assert.deepEqual(run.verdicts, []);
  assert.equal(run.skipped, undefined);
  assert.equal(judge.requests.length, 0);
});

test("evaluateTurnRun: no judge or no rules file is one skip each, and a turn finding is named with its rule", async () => {
  const store = new RuleStore();
  const config = rulesConfig();
  const set = store.load(repo, config)!;
  await writeFile(join(repo, "a.txt"), "unseen change\n");
  const snapshot = await snapshotTree(repo);
  assert.ok(snapshot.tree);
  await writeFile(join(repo, "a.txt"), "unseen change again\n");
  const offline = await evaluateTurnRun({ cwd: repo, config, set, timeoutMs: 1000, startTree: snapshot.tree!, alreadyJudged: new Set() });
  assert.equal(offline.skipped, "TypeSafe judgments are off");
  const noSet = await evaluateTurnRun({ cwd: repo, config, set: undefined, judge: stubJudge(), timeoutMs: 1000, startTree: snapshot.tree!, alreadyJudged: new Set() });
  assert.equal(noSet.skipped, "no rules file");

  const judge = stubJudge({ "no-single-use-abstractions": 0.85 });
  const run = await evaluateTurnRun({ cwd: repo, config, set, judge, timeoutMs: 1000, task: "t", startTree: snapshot.tree!, alreadyJudged: new Set() });
  const verdict = run.verdicts.find(item => item.tool === "turn")!;
  assert.deepEqual(verdict.findings.map(finding => finding.id), ["no-single-use-abstractions"]);
});

test("turnSteer: one steer covers the turn verdict and the missed files; no findings means no steer", () => {
  const finding = { id: "r", name: "Stay inside the task", outcome: "violation" as const, violation: 0.9, body: "The diff adds a scheduler the task did not ask for." };
  const turn = { source: "typesafe" as const, tool: "turn" as const, path: TURN_PATH, sources: ["pi-warden.md"], asked: 1, aggregate: false, findings: [finding] };
  const file = { source: "typesafe" as const, tool: "edit" as const, path: "src/a.ts", sources: ["pi-warden.md"], asked: 1, aggregate: false, findings: [{ ...finding, id: "r2", name: "No console statements" }] };
  const steer = turnSteer([turn, file], new Map())!;
  assert.match(steer, /^pi-warden: the changes this run made violate a project rule: "Stay inside the task"/);
  assert.match(steer, /the change to src\/a\.ts \(made by a command, not an edit\)/);
  assert.equal(steer.split("pi-warden:").length, 2, "one steer for the run");
  assert.equal(turnSteer([{ ...turn, findings: [] }], new Map()), undefined);
});

// ---------------------------------------------------------------------------
// Changes git brought in during the run are not the agent's.

const OLD = "2020-01-01T00:00:00Z";

/** A fresh repository with one seed commit, a committer-date-aware `git`, and the run-end diff against a start snapshot. */
async function scene() {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-brought-"));
  const run = (args: string[], date?: string) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: dir, stdio: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) },
  }).toString();
  run(["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "readme\n");
  await writeFile(join(dir, "CHANGELOG.md"), "# Changelog\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "seed"], OLD);
  const diffPaths = async (start: Awaited<ReturnType<typeof snapshotTree>>) => {
    assert.ok(start.tree);
    const diff = await diffSince(dir, start.tree, 8000, { head: start.head, startedAt: start.startedAt });
    return diff!.files.map(file => file.path).sort();
  };
  return { dir, run, diffPaths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("diffSince: a fast-forward pull of an older commit gives no verdict for its files", async () => {
  const s = await scene();
  try {
    s.run(["checkout", "-q", "-b", "upstream"]);
    await writeFile(join(s.dir, "CHANGELOG.md"), "# Changelog\n## 1.2.0\n");
    s.run(["commit", "-q", "-am", "bump"], OLD);
    s.run(["checkout", "-q", "main"]);
    const start = await snapshotTree(s.dir);
    s.run(["merge", "-q", "--ff-only", "upstream"]);
    assert.deepEqual(await s.diffPaths(start), []);
    const diff = await diffSince(s.dir, start.tree!, 8000);
    assert.deepEqual(diff!.files.map(file => file.path), ["CHANGELOG.md"], "without the start HEAD the pulled file counts, as before");
  } finally { await s.cleanup(); }
});

test("diffSince: a merge of an older branch without conflicts gives no verdict for its files", async () => {
  const s = await scene();
  try {
    s.run(["checkout", "-q", "-b", "feature"]);
    await writeFile(join(s.dir, "feature.txt"), "feature\n");
    s.run(["add", "feature.txt"]);
    s.run(["commit", "-q", "-m", "feature"], OLD);
    s.run(["checkout", "-q", "main"]);
    await writeFile(join(s.dir, "README.md"), "readme two\n");
    s.run(["commit", "-q", "-am", "main work"], OLD);
    const start = await snapshotTree(s.dir);
    s.run(["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"]);
    assert.deepEqual(await s.diffPaths(start), []);
  } finally { await s.cleanup(); }
});

test("diffSince: a commit made during the run that bumps the version and changes src is still judged", async () => {
  const s = await scene();
  try {
    s.run(["checkout", "-q", "-b", "upstream"]);
    await writeFile(join(s.dir, "pulled.txt"), "pulled\n");
    s.run(["add", "pulled.txt"]);
    s.run(["commit", "-q", "-m", "pulled"], OLD);
    s.run(["checkout", "-q", "main"]);
    const start = await snapshotTree(s.dir);
    s.run(["merge", "-q", "--ff-only", "upstream"]);
    await writeFile(join(s.dir, "CHANGELOG.md"), "# Changelog\n## 9.9.9\n");
    await writeFile(join(s.dir, "src.ts"), "export const x = 1;\n");
    s.run(["add", "."]);
    s.run(["commit", "-q", "-m", "bump version"]);
    assert.deepEqual(await s.diffPaths(start), ["CHANGELOG.md", "src.ts"], "the agent's commit is judged, the pulled file is not");
  } finally { await s.cleanup(); }
});

test("diffSince: a pull together with an uncommitted change judges only that change", async () => {
  const s = await scene();
  try {
    s.run(["checkout", "-q", "-b", "upstream"]);
    await writeFile(join(s.dir, "CHANGELOG.md"), "# Changelog\n## 1.2.0\n");
    await writeFile(join(s.dir, "pulled.txt"), "pulled\n");
    s.run(["add", "."]);
    s.run(["commit", "-q", "-m", "pulled"], OLD);
    s.run(["checkout", "-q", "main"]);
    const start = await snapshotTree(s.dir);
    s.run(["merge", "-q", "--ff-only", "upstream"]);
    await writeFile(join(s.dir, "README.md"), "edited by the agent\n");
    await writeFile(join(s.dir, "untracked.txt"), "new\n");
    assert.deepEqual(await s.diffPaths(start), ["README.md", "untracked.txt"]);
    await writeFile(join(s.dir, "pulled.txt"), "pulled, then edited\n");
    assert.deepEqual(await s.diffPaths(start), ["README.md", "pulled.txt", "untracked.txt"], "an uncommitted edit of a pulled file is judged");
  } finally { await s.cleanup(); }
});

test("diffSince: git checkout <old> -- file is still judged, and so is a conflict the agent resolved", async () => {
  const s = await scene();
  try {
    s.run(["checkout", "-q", "-b", "old"]);
    await writeFile(join(s.dir, "README.md"), "from the old branch\n");
    s.run(["commit", "-q", "-am", "old readme"], OLD);
    s.run(["checkout", "-q", "main"]);
    await writeFile(join(s.dir, "README.md"), "from main\n");
    s.run(["commit", "-q", "-am", "main readme"], OLD);
    const start = await snapshotTree(s.dir);
    s.run(["checkout", "old", "--", "README.md"]);
    assert.deepEqual(await s.diffPaths(start), ["README.md"], "the old content came by a command, not by a pull");
    s.run(["checkout", "main", "--", "README.md"]);
    assert.throws(() => s.run(["merge", "-q", "old"]));
    await writeFile(join(s.dir, "README.md"), "resolved by hand\n");
    s.run(["add", "README.md"]);
    s.run(["commit", "-q", "-m", "Merge old"]);
    assert.deepEqual(await s.diffPaths(start), ["README.md"], "a resolved conflict is the agent's work");
  } finally { await s.cleanup(); }
});

test("diffSince: a git failure in the brought filter is returned in the notes and every file is judged", async () => {
  const s = await scene();
  try {
    s.run(["checkout", "-q", "-b", "upstream"]);
    await writeFile(join(s.dir, "CHANGELOG.md"), "# Changelog\n## 1.2.0\n");
    s.run(["commit", "-q", "-am", "bump"], OLD);
    s.run(["checkout", "-q", "main"]);
    const start = await snapshotTree(s.dir);
    assert.ok(start.tree);
    s.run(["merge", "-q", "--ff-only", "upstream"]);
    const diff = await diffSince(s.dir, start.tree!, 8000, { head: "0".repeat(40), startedAt: start.startedAt });
    assert.deepEqual(diff!.files.map(file => file.path), ["CHANGELOG.md"], "the filter failed, so the pulled file is judged");
    assert.equal(diff!.notes.length, 1);
    assert.match(diff!.notes[0]!, /^git-brought filter failed: .+; every changed file was judged$/);
  } finally { await s.cleanup(); }
});

test("diffSince: over the probe limit only the newest commits are probed, and the cut is named in the notes", async () => {
  const s = await scene();
  try {
    // One commit per file, oldest first; the files are 10 and the commits are more than the limit allows per file.
    const files = 10;
    const commits = Math.floor(BROUGHT_PROBE_LIMIT / files) + 50;
    s.run(["checkout", "-q", "-b", "upstream"]);
    const stream: string[] = [];
    for (let index = 0; index < commits; index++) {
      const content = `content ${index}\n`;
      stream.push(`commit refs/heads/upstream\ncommitter t <t@example.com> ${1577836800 + index} +0000\ndata 1\nc\n${index === 0 ? "from refs/heads/main\n" : ""}M 100644 inline f${index % files}.txt\ndata ${content.length}\n${content}\n`);
    }
    execFileSync("git", ["fast-import", "--force", "--quiet"], { cwd: s.dir, input: stream.join("") });
    s.run(["checkout", "-q", "main"]);
    const start = await snapshotTree(s.dir);
    assert.ok(start.tree);
    s.run(["merge", "-q", "--ff-only", "upstream"]);
    const diff = await diffSince(s.dir, start.tree!, 8000, { head: start.head, startedAt: start.startedAt });
    assert.deepEqual(diff!.files, [], "the newest commits hold the current content of every file, so all are still found as brought");
    assert.equal(diff!.notes.length, 1);
    assert.match(diff!.notes[0]!, new RegExp(`^git-brought filter cut: ${files} files × ${commits} older commits is over the ${BROUGHT_PROBE_LIMIT}-probe limit, so only the newest ${BROUGHT_PROBE_LIMIT / files} commits were probed$`));
  } finally { await s.cleanup(); }
});

// ---------------------------------------------------------------------------
// A commit the hosting service makes during the run is brought by git whatever its date; the HEAD reflog says what this checkout made.

/** `scene()` with a bare `origin` and a second clone that plays the hosting service: another committer, dated after the run starts. */
async function hostedScene() {
  const s = await scene();
  const bare = await mkdtemp(join(tmpdir(), "pi-warden-origin-"));
  const hostDir = await mkdtemp(join(tmpdir(), "pi-warden-host-"));
  const later = new Date(Date.now() + 60_000).toISOString();
  const host = (args: string[]) => execFileSync("git", ["-c", "user.name=hosting", "-c", "user.email=hosting@example.com", ...args], {
    cwd: hostDir, stdio: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later },
  }).toString();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  await writeFile(join(s.dir, "package.json"), '{"version":"1.0.0"}\n');
  s.run(["add", "package.json"]);
  s.run(["commit", "-q", "-m", "package"], OLD);
  s.run(["remote", "add", "origin", bare]);
  s.run(["push", "-q", "origin", "main"]);
  host(["clone", "-q", bare, "."]);
  /** A squash commit on `origin/main` that bumps the version, with `extra` files, as the hosting service writes it. */
  const squash = async (extra: Record<string, string> = {}) => {
    await writeFile(join(hostDir, "CHANGELOG.md"), "# Changelog\n## 1.0.1\n");
    await writeFile(join(hostDir, "package.json"), '{"version":"1.0.1"}\n');
    for (const [name, content] of Object.entries(extra)) await writeFile(join(hostDir, name), content);
    host(["add", "."]);
    host(["commit", "-q", "-m", "Fix it (#1)"]);
    host(["push", "-q", "origin", "main"]);
  };
  return { ...s, bare, squash, cleanup: async () => { await s.cleanup(); await rm(bare, { recursive: true, force: true }); await rm(hostDir, { recursive: true, force: true }); } };
}

test("diffSince: a squash commit the hosting service made during the run, pulled with --ff-only, gives no verdict for its files", async () => {
  const s = await hostedScene();
  try {
    const start = await snapshotTree(s.dir);
    assert.ok(start.tree);
    await s.squash({ "fix.ts": "export const fixed = true;\n" });
    s.run(["pull", "-q", "--ff-only", "origin", "main"]);
    assert.deepEqual(await s.diffPaths(start), [], "the version bump and the fix came from origin");
    const diff = await diffSince(s.dir, start.tree!, 8000, { head: start.head, startedAt: start.startedAt });
    assert.deepEqual(diff!.notes, []);
  } finally { await s.cleanup(); }
});

test("diffSince: a commit made in another worktree during the run and fast-forwarded into this one gives no verdict", async () => {
  const s = await hostedScene();
  const other = `${s.dir}-other`;
  try {
    const start = await snapshotTree(s.dir);
    s.run(["worktree", "add", "-q", "-b", "other", other]);
    const inOther = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: other, stdio: "pipe" });
    await writeFile(join(other, "CHANGELOG.md"), "# Changelog\n## 1.0.1\n");
    await writeFile(join(other, "other.ts"), "export const other = 1;\n");
    inOther(["add", "."]);
    inOther(["commit", "-q", "-m", "work in the other worktree"]);
    s.run(["merge", "-q", "--ff-only", "other"]);
    assert.deepEqual(await s.diffPaths(start), []);
  } finally {
    s.run(["worktree", "remove", "--force", other]);
    await s.cleanup();
  }
});

test("diffSince: the agent's own content coming back as a squash on origin is still judged", async () => {
  const s = await hostedScene();
  try {
    const start = await snapshotTree(s.dir);
    s.run(["checkout", "-q", "-b", "feature"]);
    await writeFile(join(s.dir, "CHANGELOG.md"), "# Changelog\n## 1.0.1\n");
    s.run(["commit", "-q", "-am", "bump in the checkout"]);
    await s.squash({ "fix.ts": "export const fixed = true;\n" });
    s.run(["checkout", "-q", "main"]);
    s.run(["pull", "-q", "--ff-only", "origin", "main"]);
    assert.deepEqual(await s.diffPaths(start), ["CHANGELOG.md"], "the changelog content came from this checkout first; package.json and fix.ts came from origin");
  } finally { await s.cleanup(); }
});

test("diffSince: with the HEAD reflog off the commit-date rule decides and the note says so", async () => {
  const s = await hostedScene();
  try {
    s.run(["config", "core.logAllRefUpdates", "false"]);
    const start = await snapshotTree(s.dir);
    assert.ok(start.tree);
    await s.squash();
    s.run(["pull", "-q", "--ff-only", "origin", "main"]);
    const diff = await diffSince(s.dir, start.tree!, 8000, { head: start.head, startedAt: start.startedAt });
    assert.deepEqual(diff!.files.map(file => file.path).sort(), ["CHANGELOG.md", "package.json"], "the squash is dated after the run began, so the date rule judges it");
    assert.equal(diff!.notes.length, 1);
    assert.match(diff!.notes[0]!, /^git-brought filter used the commit-date rule because the HEAD reflog is off or cannot be read/);
  } finally { await s.cleanup(); }
});
