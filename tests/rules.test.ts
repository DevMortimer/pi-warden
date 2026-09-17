import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultConfig } from "../src/config.js";
import type { RulesConfig } from "../src/config.js";
import type { Judge } from "../src/jev.js";
import { AGGREGATE_QUESTION, buildRulesRequest, condense, describeTarget, evaluateRules, LOCATOR_QUESTION, matchGlob, MAX_RULES, parseRules, pathNotes, pathNoteSteer, projectPath, RulesGuard, rulesSteer, RuleStore, skipReason } from "../src/rules.js";
import type { RulesVerdict, RuleSet } from "../src/rules.js";

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-warden-rules-"));
  await mkdir(join(cwd, "src", "db", "migrations"), { recursive: true });
  await writeFile(join(cwd, "src", "user.ts"), ["import { db } from \"./db\";", "", "export async function findUser(id: string) {", "  const row = await db.get(id);", "  return row;", "}", ""].join("\n"));
});
after(async () => { await rm(cwd, { recursive: true, force: true }); });

const rulesConfig = (overrides: Partial<RulesConfig> = {}): RulesConfig => ({ ...defaultConfig().rules, ...overrides });

const RULES_MD = [
  "# No console statements",
  "Code must not contain `console.log` or `console.debug` calls. Use the logger.",
  "",
  "# Explicit return types",
  "paths: src/**/*.ts",
  "Every exported function must declare its return type.",
  "```ts",
  "# not a heading: inside a fence",
  "export function f(): number { return 1; }",
  "```",
  "",
  "# TODO comments need a reference",
  "A bare TODO is a violation.",
  "",
  "# No console statements",
  "Duplicate heading gets a distinct id.",
].join("\n");

/** Answers every rule question with the outcome set per rule id; unnamed rules are compliant. */
function stubJudge(violations: Record<string, number>, locator?: string): Judge & { requests: Array<{ state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, unknown> }> }> } {
  const judge = {
    requests: [] as Array<{ state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, unknown> }> }>,
    async evaluate(request: unknown) {
      const body = request as { state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
      judge.requests.push(body);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(body.questions)) {
        if (id === LOCATOR_QUESTION) {
          const keys = Object.keys(question.criteria);
          const pick = locator ?? keys[0]!;
          answers[id] = { type: "choice", choice: pick, confidence: 0.7, probabilities: Object.fromEntries(keys.map(key => [key, key === pick ? 0.7 : 0.3 / (keys.length - 1)])) };
          continue;
        }
        const violation = violations[id.replace(/^rule_/, "")] ?? 0.05;
        const choice = violation >= 0.5 ? "violation" : "compliant";
        answers[id] = { type: "choice", choice, confidence: 0.9, probabilities: { compliant: 1 - violation - 0.02, violation, not_applicable: 0.01, insufficient_context: 0.01 } };
      }
      return { model: "jev-test", elapsedMs: 7, usage: { input_tokens: 10, output_tokens: 0 }, answers } as never;
    },
  };
  return judge;
}

test("parseRules: top-level headings delimit rules, fenced '#' lines are body text, paths: scopes a rule, duplicate names get distinct ids", () => {
  const rules = parseRules(RULES_MD);
  assert.deepEqual(rules.map(rule => rule.id), ["no-console-statements", "explicit-return-types", "todo-comments-need-a-reference", "no-console-statements-2"]);
  assert.deepEqual(rules[1]!.paths, ["src/**/*.ts"]);
  assert.match(rules[1]!.body, /# not a heading: inside a fence/);
  assert.ok(!rules[1]!.body.includes("paths:"), "the paths line is removed from the body");
  assert.deepEqual(rules[0]!.paths, []);
  assert.equal(rules[2]!.body, "A bare TODO is a violation.");
});

test("parseRules: the highest heading level present delimits rules, so H2 rules under an H1 title work; no headings means no rules", () => {
  const rules = parseRules("# Project rules\n\nIntro text.\n\n## Use const\nPrefer const.\n\n### Not a rule\nSub-detail.\n\n## No any\nAvoid any.");
  assert.deepEqual(rules.map(rule => rule.name), ["Project rules"], "the single H1 is the top level here");
  const h2 = parseRules("Intro without a title.\n\n## Use const\nPrefer const.\n\n### Detail\nmore\n\n## No any\nAvoid any.");
  assert.deepEqual(h2.map(rule => rule.name), ["Use const", "No any"]);
  assert.match(h2[0]!.body, /### Detail/);
  assert.deepEqual(parseRules("Just prose, no headings."), []);
});

test("condense keeps every heading and the head of each section within the character budget", () => {
  const sections = Array.from({ length: 40 }, (_, index) => `## Section ${index}\n${"x".repeat(1000)} rule-${index}`);
  const document = `# Big AGENTS.md\n\n${sections.join("\n\n")}`;
  const out = condense(document, 8000);
  assert.ok(out.length <= 8000 + 60, `length ${out.length}`);
  assert.match(out, /## Section 0\n/);
  assert.match(out, /## Section 39\n/);
  assert.equal(condense("short", 8000), "short");
});

test("globs match at any depth and within a segment; project paths are relative with forward slashes, outside paths are undefined", () => {
  assert.equal(matchGlob("db/migrations/0182.sql", ["migrations/**"]), "migrations/**");
  assert.equal(matchGlob("src/auth/permissions.ts", ["**/permissions*"]), "**/permissions*");
  assert.equal(matchGlob("src/a.test.ts", ["**/*.test.*"]), "**/*.test.*");
  assert.equal(matchGlob("src/a.ts", ["**/*.test.*", "docs/**"]), undefined);
  assert.equal(matchGlob("src/deep/x.ts", ["src/*.ts"]), undefined, "* does not cross a slash");
  assert.equal(matchGlob("README.md", ["*.md"]), "*.md");
  assert.equal(projectPath("src/x.ts", cwd), "src/x.ts");
  assert.equal(projectPath(join(cwd, "src", "x.ts"), cwd), "src/x.ts");
  assert.equal(projectPath("/tmp/elsewhere.ts", cwd), undefined);
  assert.equal(projectPath("../sibling/x.ts", cwd), undefined);
});

test("RuleStore: root pi-warden.md wins, then configured files, then the first fallback document as one aggregate; files are re-read on change", async () => {
  const store = new RuleStore();
  assert.equal(store.load(cwd, rulesConfig()), undefined, "nothing yet");
  await writeFile(join(cwd, "AGENTS.md"), "# Agents\n\nAlways write tests.\n");
  await writeFile(join(cwd, "README.md"), "# Readme\n\nInstall with npm.\n");
  let set = store.load(cwd, rulesConfig());
  assert.deepEqual(set?.sources, ["README.md"], "README is the first fallback");
  assert.equal(set?.rules.length, 0);
  assert.match(set?.aggregate ?? "", /Install with npm/);
  assert.equal(store.load(cwd, rulesConfig({ fallback: false })), undefined, "fallback can be turned off");

  await writeFile(join(cwd, "docs-rules.md"), "# Use const\nPrefer const over let.\n");
  set = store.load(cwd, rulesConfig({ files: ["docs-rules.md", "missing.md"] }));
  assert.deepEqual(set?.sources, ["docs-rules.md"]);
  assert.deepEqual(set?.rules.map(rule => rule.id), ["use-const"]);

  await writeFile(join(cwd, "pi-warden.md"), RULES_MD);
  set = store.load(cwd, rulesConfig({ files: ["docs-rules.md"] }));
  assert.deepEqual(set?.sources, ["pi-warden.md"], "the root file wins over configured files");
  assert.equal(set?.rules.length, 4);

  // Same size and mtime: cached. Changed content with a new mtime: re-read.
  const stale = new Date(Date.now() - 60_000);
  await writeFile(join(cwd, "pi-warden.md"), `${RULES_MD}\n\n# Fifth rule\nBody.\n`);
  await utimes(join(cwd, "pi-warden.md"), stale, stale);
  assert.equal(store.load(cwd, rulesConfig())?.rules.length, 5);
});

test("the rule cap keeps the first 31 rules and reports the rest", async () => {
  const store = new RuleStore();
  const many = Array.from({ length: 40 }, (_, index) => `# Rule ${index}\nBody ${index}.`).join("\n\n");
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-rules-cap-"));
  await writeFile(join(dir, "pi-warden.md"), many);
  const set = store.load(dir, rulesConfig());
  assert.equal(set?.rules.length, MAX_RULES);
  assert.equal(set?.dropped, 9);
  await rm(dir, { recursive: true, force: true });
});

test("describeTarget: a write is sampled and redacted; an edit carries each new text with the current file around the old text", () => {
  const write = describeTarget("write", { path: "src/new.ts", content: `const token = "sk-abcdefghijklmnop1234";\n${"x".repeat(9000)}` }, cwd);
  assert.equal(write?.path, "src/new.ts");
  assert.ok(write!.content!.length < 6300, "sampled");
  assert.ok(!write!.content!.includes("sk-abcdefghijklmnop1234"), "redacted");
  assert.match(write!.content!, /chars\] …/, "head/middle/tail sample");

  const edit = describeTarget("edit", { path: "src/user.ts", edits: [{ oldText: "  return row;", newText: "  console.log(row);\n  return row;" }, { oldText: "nowhere", newText: "// TODO" }, { oldText: "x", newText: "   " }] }, cwd);
  assert.equal(edit?.edits?.length, 2, "blank new text is dropped");
  assert.equal(edit?.edits?.[0]?.id, "edit_1");
  assert.match(edit!.edits![0]!.before!, /export async function findUser/, "context lines around the old text");
  assert.equal(edit?.edits?.[1]?.before, undefined, "old text not found: no context");
  assert.equal(describeTarget("write", { path: "/tmp/outside.ts", content: "x" }, cwd), undefined);
  assert.equal(describeTarget("bash", { command: "ls" }, cwd), undefined);
  assert.equal(describeTarget("write", { path: "src/empty.ts", content: "   " }, cwd), undefined);
});

test("buildRulesRequest: one Choice per applicable rule, the rule text in the question, the code in the state, a locator for two or more edits", () => {
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules(RULES_MD), dropped: 0 };
  const target = describeTarget("edit", { path: "src/user.ts", edits: [{ oldText: "  return row;", newText: "  console.log(row);" }, { oldText: "import", newText: "// TODO fix" }] }, cwd)!;
  const request = buildRulesRequest(target, set);
  const keys = Object.keys(request.questions);
  assert.deepEqual(keys, ["rule_no-console-statements", "rule_explicit-return-types", "rule_todo-comments-need-a-reference", "rule_no-console-statements-2", LOCATOR_QUESTION]);
  const question = request.questions["rule_no-console-statements"] as { instructions: string; criteria: Record<string, string> };
  assert.match(question.instructions, /Rule: No console statements\nCode must not contain/);
  assert.deepEqual(Object.keys(question.criteria), ["compliant", "violation", "not_applicable", "insufficient_context"]);
  assert.equal(request.state.path, "src/user.ts");
  assert.equal((request.state.edits as unknown[]).length, 2);
  assert.ok(!("rules" in request.state), "rule text rides in the questions, not the state");

  const scoped = buildRulesRequest(describeTarget("write", { path: "docs/guide.md", content: "console.log" }, cwd)!, set);
  assert.ok(!("rule_explicit-return-types" in scoped.questions), "paths: src/**/*.ts excludes docs");
  assert.ok(!(LOCATOR_QUESTION in scoped.questions), "no locator for a write");

  const aggregate = buildRulesRequest(describeTarget("write", { path: "src/a.ts", content: "x" }, cwd)!, { sources: ["AGENTS.md"], rules: [], aggregate: "Always write tests.", dropped: 0 });
  assert.deepEqual(Object.keys(aggregate.questions), [AGGREGATE_QUESTION]);
  assert.equal(aggregate.state.rules, "Always write tests.");
});

test("skipReason names exclude, skip, path scoping, and missing rules", () => {
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules("# Only TS\npaths: **/*.ts\nBody."), dropped: 0 };
  const target = describeTarget("write", { path: "src/a.ts", content: "x" }, cwd)!;
  assert.equal(skipReason(target, set, rulesConfig()), undefined);
  assert.match(skipReason(target, set, rulesConfig({ exclude: ["src/**"] }))!, /rules\.exclude \(src\/\*\*\)/);
  assert.match(skipReason(target, set, rulesConfig({ skip: ["**/*.ts"] }))!, /rules\.skip/);
  assert.match(skipReason(describeTarget("write", { path: "README.md", content: "x" }, cwd), set, rulesConfig())!, /no rule's paths match/);
  assert.match(skipReason(undefined, set, rulesConfig())!, /outside the project/);
  assert.match(skipReason(target, undefined, rulesConfig())!, /no rules file/);
});

test("evaluateRules: violations at or above the threshold become findings, strongest first, with the located edit; compliant rules do not", async () => {
  const set: RuleSet = { sources: ["pi-warden.md"], rules: parseRules(RULES_MD), dropped: 0 };
  const judge = stubJudge({ "no-console-statements": 0.91, "todo-comments-need-a-reference": 0.72, "explicit-return-types": 0.69 }, "edit_2");
  const verdict = await evaluateRules("edit", { path: "src/user.ts", edits: [{ oldText: "  return row;", newText: "  console.log(row);" }, { oldText: "import", newText: "// TODO fix" }] }, { cwd, config: rulesConfig(), set, judge, timeoutMs: 1000 });
  assert.equal(verdict.source, "typesafe");
  assert.equal(verdict.asked, 4);
  assert.deepEqual(verdict.findings.map(finding => [finding.id, finding.violation]), [["no-console-statements", 0.91], ["todo-comments-need-a-reference", 0.72]]);
  assert.equal(verdict.findings[0]!.body, "Code must not contain `console.log` or `console.debug` calls. Use the logger.");
  assert.equal(verdict.editId, "edit_2");
  assert.equal(verdict.editPreview, "// TODO fix");
  assert.equal(verdict.scores?.length, 4);

  const clean = await evaluateRules("write", { path: "src/a.ts", content: "export const a = 1;" }, { cwd, config: rulesConfig(), set, judge: stubJudge({}), timeoutMs: 1000 });
  assert.equal(clean.findings.length, 0);
  assert.equal(clean.editId, undefined);
});

test("evaluateRules: an aggregate document yields one finding named after the file; skips and errors are reported, not thrown", async () => {
  const set: RuleSet = { sources: ["AGENTS.md"], rules: [], aggregate: "Never use console.log.", dropped: 0 };
  const verdict = await evaluateRules("write", { path: "src/a.ts", content: "console.log(1)" }, { cwd, config: rulesConfig(), set, judge: stubJudge({ [AGGREGATE_QUESTION]: 0.8 }), timeoutMs: 1000 });
  assert.equal(verdict.aggregate, true);
  assert.equal(verdict.asked, 1);
  assert.deepEqual(verdict.findings.map(finding => finding.name), ["the project's AGENTS.md"]);

  const offline = await evaluateRules("write", { path: "src/a.ts", content: "x" }, { cwd, config: rulesConfig(), set, timeoutMs: 1000 });
  assert.equal(offline.source, "skipped");
  assert.match(offline.skippedReason!, /TypeSafe judgments are off/);

  const failing: Judge = { async evaluate() { throw new Error("upstream body must not leak"); } };
  const error = await evaluateRules("write", { path: "src/a.ts", content: "x" }, { cwd, config: rulesConfig(), set, judge: failing, timeoutMs: 1000 });
  assert.equal(error.source, "error");
  assert.equal(error.error, "TypeSafe request failed.");
  assert.equal(error.findings.length, 0);
});

test("rulesSteer names the rule, quotes its text, points at the edit, and makes the third repeat a standing rule", () => {
  const verdict: RulesVerdict = {
    source: "typesafe", tool: "edit", path: "src/user.ts", sources: ["pi-warden.md"], asked: 4, aggregate: false,
    findings: [{ id: "no-console-statements", name: "No console statements", outcome: "violation", violation: 0.91, body: "Code must not contain `console.log`.\nUse the logger." }],
    editId: "edit_2", editPreview: "console.log(row);",
  };
  const once = rulesSteer(verdict, new Map([["no-console-statements", 1]]));
  assert.equal(once, "pi-warden: the content just written to src/user.ts in edit 2 (starting \"console.log(row);\") violates project rule from pi-warden.md: \"No console statements\" (0.91): Code must not contain `console.log`. Use the logger. Fix it in your next edit.");
  const third = rulesSteer(verdict, new Map([["no-console-statements", 3]]));
  assert.match(third, /\(0\.91; 3rd time this session\)/);
  assert.match(third, /Treat this as a standing rule for the rest of the session\.$/);
  const { editId: _editId, editPreview: _editPreview, ...located } = verdict;
  const aggregate = rulesSteer({ ...located, aggregate: true, sources: ["AGENTS.md"], findings: [{ id: "rules", name: "the project's AGENTS.md", outcome: "violation", violation: 0.8, body: "" }] }, new Map());
  assert.match(aggregate, /^pi-warden: the content just written to src\/user\.ts breaks a rule stated in AGENTS\.md: "the project's AGENTS\.md" \(0\.80\)\. Fix it/);
});

test("sensitive paths: glob → note, once per path per session, with the note in the steer", () => {
  const notes = { "migrations/**": "Tell the user this touches a migration and add a rollback", "**/permissions*": "Ask for a security review." };
  assert.deepEqual(pathNotes("src/db/migrations/0182.sql", notes).map(hit => hit.glob), ["migrations/**"]);
  assert.deepEqual(pathNotes("src/auth/permissions.ts", notes).map(hit => hit.glob), ["**/permissions*"]);
  assert.deepEqual(pathNotes("src/x.ts", notes), []);
  assert.deepEqual(pathNotes(undefined, notes), []);
  assert.equal(pathNoteSteer("src/db/migrations/0182.sql", pathNotes("src/db/migrations/0182.sql", notes)), "pi-warden: src/db/migrations/0182.sql is a sensitive path in this project (migrations/**). Tell the user this touches a migration and add a rollback.");
  const guard = new RulesGuard();
  assert.equal(guard.notesFor("src/db/migrations/0182.sql", notes).length, 1);
  assert.equal(guard.notesFor("src/db/migrations/0182.sql", notes).length, 0, "not repeated for the same path");
  assert.equal(guard.notesFor("src/db/migrations/0183.sql", notes).length, 1);
  guard.reset();
  assert.equal(guard.notesFor("src/db/migrations/0182.sql", notes).length, 1);
});

test("RulesGuard prejudges sibling writes so their requests overlap, uses a prejudgment once, and counts repeats per rule", async () => {
  const judge = stubJudge({ "no-console-statements": 0.9 });
  const guard = new RulesGuard();
  const config = rulesConfig();
  const a = { id: "a", tool: "write", input: { path: "src/a.ts", content: "console.log(1)" } };
  const b = { id: "b", tool: "write", input: { path: "src/b.ts", content: "console.log(2)" } };
  const first = await guard.inspect(a, [a, b], { cwd, config, judge, timeoutMs: 1000 });
  assert.equal(judge.requests.length, 2, "both siblings judged on the first inspection");
  const second = await guard.inspect(b, [a, b], { cwd, config, judge, timeoutMs: 1000 });
  assert.equal(judge.requests.length, 2, "the sibling's prejudgment is reused");
  assert.equal(first.findings.length, 1);
  assert.equal(second.findings.length, 1);
  guard.count(first);
  assert.equal(guard.count(second).get("no-console-statements"), 2);
  const changed = await guard.inspect({ ...b, input: { path: "src/b.ts", content: "console.log(3)" } }, [a, b], { cwd, config, judge, timeoutMs: 1000 });
  assert.equal(judge.requests.length, 3, "a changed input is judged afresh");
  assert.equal(changed.source, "typesafe");
});
