import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultConfig } from "../src/config.js";
import type { RulesConfig } from "../src/config.js";
import type { Judge } from "pi-typesafe";
import { execFileSync } from "node:child_process";
import { AGGREGATE_QUESTION, buildRulesRequest, condense, describeRuleSet, formatRuleSetDetails, describeTarget, evaluateRules, gitIgnored, isRuleShaped, LOCATOR_QUESTION, matchGlob, MAX_RULES, parseRules, pathNotes, pathNoteSteer, projectPath, RulesGuard, rulesSteer, RuleStore, skipReason } from "../src/rules.js";
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
  assert.deepEqual(set?.sources, ["AGENTS.md"], "AGENTS is the first fallback");
  assert.equal(set?.rules.length, 0);
  assert.match(set?.aggregate ?? "", /Always write tests/);
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

test("the shipped examples parse: the starter rules file yields scoped rules under the cap, and both config examples are accepted as written", async () => {
  const { readFile } = await import("node:fs/promises");
  const { applyProjectOverrides, applyUserOverrides } = await import("../src/config.js");
  const starter = parseRules(await readFile("examples/pi-warden.md", "utf8"));
  assert.ok(starter.length >= 10 && starter.length <= MAX_RULES, `${starter.length} rules`);
  assert.ok(starter.every(rule => rule.body.length > 0), "every rule has text");
  assert.deepEqual(starter.find(rule => rule.id === "no-explicit-any")?.paths, ["**/*.ts", "**/*.tsx"]);
  assert.ok(!starter.some(rule => /copy this file/i.test(rule.body)), "the intro stays above the first heading and is not a rule");

  const project = applyProjectOverrides(defaultConfig(), JSON.parse(await readFile("examples/pi-warden.json", "utf8")));
  assert.ok(project.rules.skip.includes("**/*.test.*"));
  assert.ok(project.rules.exclude.includes("secrets/**"));
  assert.equal(Object.keys(project.rules.sensitivePaths).length, 4);
  assert.equal(project.typesafe, false, "a project file cannot grant consent");

  const user = applyUserOverrides(defaultConfig(), JSON.parse(await readFile("examples/config.json", "utf8")));
  assert.equal(user.typesafe, true);
  assert.equal(user.rules.maxChars, 8000);
  assert.match(user.slop.prose.audience, /founder/);
});

test("isRuleShaped: a document with headings but imperative sentences is rule-shaped; one without is prose only", () => {
  const ruleDoc = ["# Project rules", "", "## No console", "You must not use console.log.", "", "## Use const", "Prefer const over let."].join("\n");
  assert.equal(isRuleShaped(ruleDoc), true);
  const proseDoc = ["# My Project", "", "This is a project about building things.", "It does many interesting things.", "", "## Overview", "Here we describe the project."].join("\n");
  assert.equal(isRuleShaped(proseDoc), false);
  const bulletDoc = ["# Guide", "", "## Coding style", "- Always use strict mode", "- Never use var"].join("\n");
  assert.equal(isRuleShaped(bulletDoc), true);
  const noHeadings = "Just some prose with no headings at all.";
  assert.equal(isRuleShaped(noHeadings), false);
});

test("RuleStore: a fallback README with no rule-shaped sections returns proseOnly; one with rule-shaped sections returns aggregate", async () => {
  const store = new RuleStore();
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-rules-prose-"));
  const proseReadme = ["# pi-warden", "", "**Stop babysitting your coding agent.**", "", "pi-warden supervises Pi while it works.", "", "## Install", "", "```bash", "pi install npm:pi-warden", "```"].join("\n");
  await writeFile(join(dir, "README.md"), proseReadme);
  const proseSet = store.load(dir, rulesConfig());
  assert.equal(proseSet?.proseOnly, true, "prose README is flagged proseOnly");
  assert.equal(proseSet?.aggregate, undefined, "prose README has no aggregate");
  assert.equal(proseSet?.rules.length, 0, "prose README has no rules");

  const ruleReadme = ["# Project rules", "", "## No console", "You must not use console.log.", "", "## Use const", "Prefer const."].join("\n");
  const dir2 = await mkdtemp(join(tmpdir(), "pi-warden-rules-prose-"));
  await writeFile(join(dir2, "README.md"), ruleReadme);
  const ruleSet = store.load(dir2, rulesConfig());
  assert.equal(ruleSet?.proseOnly, undefined, "rule-shaped README is not proseOnly");
  assert.ok(ruleSet?.aggregate, "rule-shaped README has aggregate");
  assert.equal(ruleSet?.rules.length, 0, "rule-shaped README still has no parsed rules (heading level mismatch)");
  await rm(dir, { recursive: true, force: true });
  await rm(dir2, { recursive: true, force: true });
});

test("evaluateRules: a prose-only fallback set skips with prose reason and does not ask Jev", async () => {
  const set: RuleSet = { sources: ["README.md"], rules: [], dropped: 0, proseOnly: true };
  const judge = stubJudge({});
  const verdict = await evaluateRules("write", { path: "src/a.ts", content: "x" }, { cwd, config: rulesConfig(), set, judge, timeoutMs: 1000 });
  assert.equal(verdict.source, "skipped");
  assert.match(verdict.skippedReason!, /no rules found in README\.md \(prose only\)/);
  assert.equal(judge.requests.length, 0, "judge not called for prose-only set");
});

test("describeRuleSet: proseOnly set shows 'no rules found in X (prose only)'", () => {
  const proseOnly: RuleSet = { sources: ["README.md"], rules: [], dropped: 0, proseOnly: true };
  assert.match(describeRuleSet(proseOnly), /no rules found in README\.md \(prose only\)/);
  const aggregate: RuleSet = { sources: ["AGENTS.md"], rules: [], aggregate: "Always write tests.", dropped: 0 };
  assert.match(describeRuleSet(aggregate), /no rule headings: judged as one document/);
});

test("pi-warden.md with no headings still yields one rule (exempt from prose check)", () => {
  const noHeadingDoc = "Always write tests.\nNever use console.log.";
  const rules = parseRules(noHeadingDoc);
  assert.equal(rules.length, 0, "parseRules returns nothing for no headings");
  assert.equal(isRuleShaped(noHeadingDoc), false, "prose check says not rule-shaped");
});

test("outside-project target is skipped by the rules guard and traced", async () => {
  const judge = stubJudge({});
  const guard = new RulesGuard();
  const config = rulesConfig();
  await writeFile(join(cwd, "pi-warden.md"), RULES_MD);
  const call = { id: "o1", tool: "write", input: { path: "/tmp/outside.ts", content: "console.log(1)" } };
  const verdict = await guard.inspect(call, [call], { cwd, config, judge, timeoutMs: 1000 });
  assert.equal(verdict.source, "skipped");
  assert.match(verdict.skippedReason!, /outside the project/);
  assert.equal(verdict.findings.length, 0);
});

test("gitignored target is skipped by the rules guard", async () => {
  const gitDir = await mkdtemp(join(tmpdir(), "pi-warden-rules-gitignore-"));
  try {
    execFileSync("git", ["init"], { cwd: gitDir, stdio: "pipe" });
    await writeFile(join(gitDir, ".gitignore"), ".local/\nbuild/\n");
    await writeFile(join(gitDir, "pi-warden.md"), "# No console\nDo not use console.log.\n");
    const judge = stubJudge({});
    const guard = new RulesGuard();
    const config = rulesConfig();
    const call = { id: "g1", tool: "write", input: { path: ".local/cache.json", content: "data" } };
    const verdict = await guard.inspect(call, [call], { cwd: gitDir, config, judge, timeoutMs: 1000 });
    assert.equal(verdict.source, "skipped");
    assert.match(verdict.skippedReason!, /gitignored/);
    assert.equal(verdict.findings.length, 0);
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
});

test("in-project non-gitignored target is still judged by the rules guard", async () => {
  const judge = stubJudge({ "no-console-statements": 0.9 });
  const guard = new RulesGuard();
  const config = rulesConfig();
  await writeFile(join(cwd, "pi-warden.md"), RULES_MD);
  const call = { id: "j1", tool: "write", input: { path: "src/a.ts", content: "console.log(1)" } };
  const verdict = await guard.inspect(call, [call], { cwd, config, judge, timeoutMs: 1000 });
  assert.equal(verdict.source, "typesafe");
  assert.ok(verdict.findings.length > 0, "should have findings for in-project target");
});

test("no rule set means gitIgnored is not called, even for a gitignored path", async () => {
  const noRulesDir = await mkdtemp(join(tmpdir(), "pi-warden-rules-no-set-"));
  try {
    // No rules file in this directory and no git repo: git check-ignore would fail if called.
    const judge = stubJudge({});
    const guard = new RulesGuard();
    const config = rulesConfig({ fallback: false });
    const call = { id: "n1", tool: "write", input: { path: ".local/cache.json", content: "data" } };
    const verdict = await guard.inspect(call, [call], { cwd: noRulesDir, config, judge, timeoutMs: 1000 });
    assert.equal(verdict.source, "skipped");
    assert.match(verdict.skippedReason!, /no rules file/, "should skip for no rules, not gitignored");
    assert.equal(judge.requests.length, 0, "judge should not be called");
  } finally {
    await rm(noRulesDir, { recursive: true, force: true });
  }
});

test("formatRuleSetDetails: root rules show ids and scopes", () => {
  const set: RuleSet = {
    sources: ["pi-warden.md"],
    rules: [
      { id: "no-secrets", name: "No secrets", body: "", paths: ["src/**"] },
      { id: "tests-before-done", name: "Tests before done", body: "", paths: [] },
    ],
    dropped: 0,
  };
  assert.equal(formatRuleSetDetails(set, "root"), [
    "Rules in force: pi-warden.md (2 rules, 0 dropped)",
    "1. no-secrets paths: src/**",
    "2. tests-before-done paths: (all)",
  ].join("\n"));
});

test("formatRuleSetDetails: configured rules name each source", () => {
  const set: RuleSet = {
    sources: ["rules/code.md", "rules/docs.md"],
    rules: [
      { id: "typed-code", name: "Typed code", body: "", paths: ["src/**"], source: "rules/code.md" },
      { id: "links-work", name: "Links work", body: "", paths: ["docs/**"], source: "rules/docs.md" },
    ],
    dropped: 0,
  };
  const text = formatRuleSetDetails(set, "configured", ["dist/**", "*.lock"]);
  assert.match(text, /^Rules in force: rules\.files: rules\/code\.md, rules\/docs\.md \(2 rules, 0 dropped\)/);
  assert.match(text, /1\. typed-code \[rules\/code\.md\] paths: src\/\*\*/);
  assert.match(text, /2\. links-work \[rules\/docs\.md\] paths: docs\/\*\*/);
  assert.match(text, /Excluded from Jev by rules\.exclude: dist\/\*\*, \*\.lock$/);
});

test("formatRuleSetDetails: fallback aggregate names its condensed size", () => {
  const set: RuleSet = { sources: ["README.md"], rules: [], aggregate: "Always write tests.", dropped: 0 };
  assert.equal(formatRuleSetDetails(set, "fallback"),
    "Rules in force: README.md judged as one aggregate rule (prose only; 19 condensed chars)");
});

test("formatRuleSetDetails: empty set uses the first-run remedy", () => {
  assert.equal(formatRuleSetDetails(undefined, "none"),
    "No rules file detected. Run /warden init to create project-specific rules.");
});

test("formatRuleSetDetails: dropped count is always visible", () => {
  const set: RuleSet = {
    sources: ["pi-warden.md"],
    rules: [{ id: "first", name: "First", body: "", paths: [] }],
    dropped: 7,
  };
  assert.match(formatRuleSetDetails(set, "root"), /\(1 rule, 7 dropped\)/);
});
