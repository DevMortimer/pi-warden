import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import { parseRules, RuleStore } from "../src/rules.js";
import type { RuleSet } from "../src/rules.js";
import { buildRulesCheckRequest, CHECK_ABOUT, checkRules, formatRulesCheck, MECHANICAL_CUTOFF } from "../src/rules-lint.js";
import type { RuleCheck } from "../src/rules-lint.js";

interface SentRequest {
  state: { about?: string; rules?: Array<{ id: string; name: string; paths: string[]; body: string }> };
  questions: Record<string, { type: string; criteria?: unknown }>;
}

/** A judge stub that records every request it is given and answers from `answer`. `failAt` marks requests that throw. */
function stubJudge(answer: (id: string, question: { type: string }) => unknown, failAt: (index: number) => boolean = () => false) {
  const judge = {
    requests: [] as SentRequest[],
    async evaluate(request: unknown) {
      const body = request as SentRequest;
      const index = judge.requests.length;
      judge.requests.push(body);
      if (failAt(index)) throw new Error("upstream body must not leak");
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(body.questions)) answers[id] = answer(id, question);
      return { model: "jev-test", elapsedMs: 5, usage: { input_tokens: 10, output_tokens: 0 }, answers } as never;
    },
  };
  return judge;
}

const judged = (pick: string) => ({ type: "choice", choice: pick, confidence: 0.9, probabilities: { from_change_alone: 0.05, needs_other_files: 0.05, needs_task_or_history: 0.05, too_vague: 0.05, [pick]: 0.8 } });
const mechanical = (noul: number) => ({ type: "noul", noul });
/** A rule the judge finds fine on both questions: the answer follows the question type, as the real API does. */
const healthy = (_id: string, question: { type: string }) => question.type === "noul" ? mechanical(0.05) : judged("from_change_alone");

function ruleSet(markdown: string, sources: string[] = ["pi-warden.md"]): RuleSet {
  return { sources, rules: parseRules(markdown), alwaysDropped: 0 };
}

const TWO_RULES = ["# No console statements", "Code under `src/` must not call `console.log`.", "", "# No duplicate logic", "Do not duplicate logic that exists elsewhere in the codebase."].join("\n");

test("buildRulesCheckRequest: two questions per rule, named by id, with the rule's name, paths, and body in one shared state", () => {
  const set = ruleSet(["# No console statements", "paths: src/**", "Code must not call `console.log`.", "", "# No duplicate logic", "Do not duplicate logic that exists elsewhere."].join("\n"));
  const built = buildRulesCheckRequest(set.rules);
  assert.deepEqual(Object.keys(built.request.questions).sort(), ["judgeable_no-console-statements", "judgeable_no-duplicate-logic", "mechanical_no-console-statements", "mechanical_no-duplicate-logic"]);
  assert.equal(built.notChecked, 0);
  assert.deepEqual(built.request.state, {
    about: CHECK_ABOUT,
    rules: [
      { id: "no-console-statements", name: "No console statements", paths: ["src/**"], body: "Code must not call `console.log`." },
      { id: "no-duplicate-logic", name: "No duplicate logic", paths: [], body: "Do not duplicate logic that exists elsewhere." },
    ],
  });
  const judgeable = built.request.questions["judgeable_no-console-statements"] as { type: string; criteria: Record<string, unknown> };
  assert.equal(judgeable.type, "choice");
  assert.deepEqual(Object.keys(judgeable.criteria), ["from_change_alone", "needs_other_files", "needs_task_or_history", "too_vague"]);
  assert.equal((built.request.questions["mechanical_no-console-statements"] as { type: string }).type, "noul");
});

test("checkRules: one answer per rule, a rule needs attention on a non-judgeable reason or a mechanical score at the cutoff", async () => {
  const judge = stubJudge((id, question) => {
    if (question.type === "noul") return mechanical(id === "mechanical_no-console-statements" ? 0.93 : 0.05);
    return judged(id === "judgeable_no-duplicate-logic" ? "needs_other_files" : "from_change_alone");
  });
  const result = await checkRules({ set: ruleSet(TWO_RULES), judge, timeoutMs: 1000 });
  assert.equal(result.source, "typesafe");
  assert.equal(result.checked, 2);
  assert.equal(result.requests, 1);
  assert.equal(result.failedRequests, 0);
  assert.equal(result.unanswered, 0);
  const [console_, duplicate] = result.results;
  assert.deepEqual(console_, { id: "no-console-statements", name: "No console statements", judgeability: "from_change_alone", judgeabilityScore: 0.8, mechanical: 0.93, needsAttention: true });
  assert.equal(duplicate!.needsAttention, true);
  assert.deepEqual(result.attention.map(rule => rule.id), ["no-console-statements", "no-duplicate-logic"]);
});

test("checkRules: a rule the judge calls unjudgeable and unmechanical is fine, and MECHANICAL_CUTOFF is the house 0.7", async () => {
  const judge = stubJudge((_id, question) => (question.type === "noul" ? mechanical(MECHANICAL_CUTOFF - 0.01) : judged("from_change_alone")));
  const result = await checkRules({ set: ruleSet(TWO_RULES), judge, timeoutMs: 1000 });
  assert.equal(MECHANICAL_CUTOFF, 0.7);
  assert.deepEqual(result.attention, []);
  assert.equal(result.checked, 2);
});

test("formatRulesCheck: one line per rule that needs attention with the reason, the score, and one suggestion, then the summary", async () => {
  const judge = stubJudge((id, question) => {
    if (question.type === "noul") return mechanical(id === "mechanical_no-console-statements" ? 0.93 : 0.05);
    return judged(id === "judgeable_no-duplicate-logic" ? "needs_other_files" : "from_change_alone");
  });
  const text = formatRulesCheck(await checkRules({ set: ruleSet(TWO_RULES), judge, timeoutMs: 1000 }));
  const lines = text.split("\n");
  assert.equal(lines[0], "Rules check: pi-warden.md — 2 rules checked in 1 request.");
  assert.equal(lines[1], "- No console statements (no-console-statements): a linter could enforce it exactly (0.93). Fix: move it to your linter.");
  assert.equal(lines[2], "- No duplicate logic (no-duplicate-logic): needs another file to judge (0.80). Fix: split it so the changed file alone shows the violation, or leave it to review.");
  assert.equal(lines[3], "0 fine, 2 need attention.");
});

test("formatRulesCheck: a rule that is both mechanical and non-judgeable names both reasons and points at the linter", async () => {
  const judge = stubJudge((id, question) => (question.type === "noul" ? mechanical(0.9) : judged(id === "judgeable_no-duplicate-logic" ? "too_vague" : "from_change_alone")));
  const text = formatRulesCheck(await checkRules({ set: ruleSet(TWO_RULES), judge, timeoutMs: 1000 }));
  assert.match(text, /- No duplicate logic \(no-duplicate-logic\): too vague to judge twice \(0\.80\); a linter could enforce it exactly \(0\.90\)\. Fix: move it to your linter\./);
});

test("checkRules: no judge, no request, and the report says nothing was sent", async () => {
  const judge = stubJudge(() => judged("from_change_alone"));
  const result = await checkRules({ set: ruleSet(TWO_RULES), judge: undefined, timeoutMs: 1000 });
  assert.equal(result.source, "skipped");
  assert.equal(result.requests, 0);
  assert.equal(judge.requests.length, 0);
  assert.match(formatRulesCheck(result), /sent nothing/);
  assert.match(formatRulesCheck(result), /\/warden rules shows the rule set locally/);
});

test("checkRules: nothing to check is its own source, and the report says there are no separate rules", async () => {
  const judge = stubJudge(() => judged("from_change_alone"));
  const none = await checkRules({ set: undefined, judge, timeoutMs: 1000 });
  assert.equal(none.source, "none");
  assert.match(formatRulesCheck(none), /No rules file detected/);
  const prose = await checkRules({ set: { sources: ["NOTES.md"], rules: [], alwaysDropped: 0, proseOnly: true }, judge, timeoutMs: 1000 });
  assert.equal(prose.source, "prose");
  assert.match(formatRulesCheck(prose), /no rule-shaped sections/);
  const aggregate = await checkRules({ set: { sources: ["AGENTS.md"], rules: [], alwaysDropped: 0, aggregate: "Some prose." }, judge, timeoutMs: 1000 });
  assert.equal(aggregate.source, "aggregate");
  assert.match(formatRulesCheck(aggregate), /No separate rules to check: AGENTS\.md has no rule headings, so the guard judges it as one document\./);
  assert.equal(judge.requests.length, 0, "an aggregate, prose-only, or missing rule set sends nothing");
});

test("checkRules: rule text is redacted before it is sent, and secrets never reach the judge", async () => {
  const set = ruleSet(["# No hardcoded secrets", "A rule body may quote `api_key = \"42a7b1f9c3d5e6\"` and a token `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`.", "", "# Plain rule", "A rule with nothing to hide."].join("\n"));
  const judge = stubJudge(() => judged("from_change_alone"));
  await checkRules({ set, judge, timeoutMs: 1000 });
  const sent = JSON.stringify(judge.requests);
  assert.ok(!sent.includes("42a7b1f9c3d5e6"), "the assigned value never leaves the machine");
  assert.ok(!sent.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "the token never leaves the machine");
  assert.ok(sent.includes("[redacted]"), "the rule is sent with its credential masked");
});

test("checkRules: the request carries pi-typesafe's own 32-question limit, so a large rule set is chunked and needs no hand-rolled cap", async () => {
  const judge = stubJudge(healthy);
  const markdown = Array.from({ length: 20 }, (_value, index) => `# Rule ${index + 1}\nKeep rule number ${index + 1} in mind.`).join("\n\n");
  const result = await checkRules({ set: ruleSet(markdown), judge, timeoutMs: 1000 });
  assert.equal(result.requests, 2, "40 questions split into chunks of at most 32");
  assert.equal(judge.requests.length, 2);
  assert.equal(judge.requests[0]!.questions ? Object.keys(judge.requests[0]!.questions).length : 0, 32);
  assert.equal(result.checked, 20);
  assert.equal(result.notChecked, 0);
});

test("checkRules: a rule set past the state byte budget drops the tail and says so instead of sending a request the API would reject", async () => {
  const judge = stubJudge(healthy);
  const body = "x".repeat(600);
  const markdown = Array.from({ length: 140 }, (_value, index) => `# Rule ${index + 1}\n${body}`).join("\n\n");
  const result = await checkRules({ set: ruleSet(markdown), judge, timeoutMs: 1000 });
  assert.ok(result.notChecked > 0, "the tail is left out");
  assert.equal(result.checked + result.notChecked, 140);
  assert.match(formatRulesCheck(result), /left out \(the request would be too large\)/);
});

test("checkRules: a failed request is reported, and a check where nothing answered is an error, never a throw", async () => {
  const partial = stubJudge(healthy, index => index === 1);
  const markdown = Array.from({ length: 20 }, (_value, index) => `# Rule ${index + 1}\nKeep rule number ${index + 1} in mind.`).join("\n\n");
  const half = await checkRules({ set: ruleSet(markdown), judge: partial, timeoutMs: 1000 });
  assert.equal(half.source, "typesafe");
  assert.equal(half.failedRequests, 1);
  assert.equal(half.unanswered, 4);
  assert.match(formatRulesCheck(half), /1 request failed: TypeSafe request failed\./);
  const all = await checkRules({ set: ruleSet(TWO_RULES), judge: stubJudge(healthy, () => true), timeoutMs: 1000 });
  assert.equal(all.source, "error");
  assert.match(formatRulesCheck(all), /^Rules check failed after 1 request: TypeSafe request failed\./);
});

test("checkRules: an answer outside the four reasons is treated as the most cautious one", async () => {
  const judge = stubJudge((id, question) => (question.type === "noul" ? mechanical(0.05) : judged(id === "judgeable_no-console-statements" ? "whatever" : "from_change_alone")));
  const result = await checkRules({ set: ruleSet(TWO_RULES), judge, timeoutMs: 1000 });
  const unknown = result.results.find(rule => rule.id === "no-console-statements") as RuleCheck;
  assert.equal(unknown.judgeability, "too_vague");
  assert.equal(unknown.needsAttention, true);
});

test("checkRules: the loaded rule set is asked about as the guard resolved it, including a scoped rule's paths", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "pi-warden-rules-lint-"));
  try {
    await writeFile(join(cwd, "pi-warden.md"), ["# Explicit return types", "paths: src/**/*.ts", "Every exported function declares its return type."].join("\n"));
    const judge = stubJudge(() => judged("from_change_alone"));
    const result = await checkRules({ set: new RuleStore().load(cwd, defaultConfig().rules), judge, timeoutMs: 1000 });
    assert.equal(result.sources[0], "pi-warden.md");
    assert.deepEqual(judge.requests[0]!.state.rules, [{ id: "explicit-return-types", name: "Explicit return types", paths: ["src/**/*.ts"], body: "Every exported function declares its return type." }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
