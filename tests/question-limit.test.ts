import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BACKEND_LIMITS } from "pi-typesafe";
import type { BackendLimits } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import { assess } from "../src/conscience.js";
import { filterOutput } from "../src/filter.js";
import { evaluateAction } from "../src/guard.js";
import type { Verdict } from "../src/guard.js";
import { relevanceCompaction } from "../src/relevance.js";
import type { SpanMessage } from "../src/relevance.js";
import { evaluateRulesTarget, parseRules, questionLimit } from "../src/rules.js";
import type { RuleSet, RulesTarget } from "../src/rules.js";
import { calibrate } from "../src/rules-calibrate.js";
import type { HistoryCommit } from "../src/rules-calibrate.js";
import { checkRules } from "../src/rules-lint.js";
import { judgedAction } from "./judged-action.js";
import { evaluateTurnRules } from "../src/turn-rules.js";

type Request = { state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: unknown }> };
type Subject = (id: string, state: Record<string, unknown>) => string;

function hash(text: string): number {
  let value = 7;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 1_000_003;
  return value;
}

/**
 * Answers every question from its subject alone, so the same question gets the same answer whichever request carries it.
 * Records each request's question count and refuses one over its limit, as pi-typesafe's admission does.
 */
function fakeJudge(maxQuestions: number | undefined, subject: Subject = id => id, choose?: (id: string, keys: string[]) => string | undefined) {
  const counts: number[] = [];
  const judge = {
    ...(maxQuestions === undefined ? {} : { limits: { ...DEFAULT_BACKEND_LIMITS, maxQuestions } satisfies BackendLimits }),
    async evaluate(request: unknown) {
      const body = request as Request;
      const ids = Object.keys(body.questions);
      counts.push(ids.length);
      const limit = maxQuestions ?? DEFAULT_BACKEND_LIMITS.maxQuestions;
      if (ids.length > limit) throw new Error(`${ids.length} questions, at most ${limit} per request`);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(body.questions)) {
        const h = hash(subject(id, body.state));
        if (question.type === "noul") answers[id] = { type: "noul", noul: (h % 1000) / 1000 };
        else if (question.type === "choice") {
          const keys = Object.keys(question.criteria as Record<string, unknown>);
          const pick = choose?.(id, keys) ?? keys[h % keys.length]!;
          answers[id] = { type: "choice", choice: pick, confidence: 0.85, probabilities: Object.fromEntries(keys.map(key => [key, key === pick ? 0.85 : 0.15 / (keys.length - 1)])) };
        } else {
          const levels = (question.criteria as unknown[]).length;
          const level = h % levels;
          answers[id] = { type: "score", score: level, confidence: 0.9, legend: {}, probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === level ? 0.9 : 0.1 / (levels - 1)])) };
        }
      }
      return { model: "jev-test", elapsedMs: 1, usage: { input_tokens: 1, output_tokens: 0 }, answers } as never;
    },
  };
  return { judge, counts };
}

const rulesMarkdown = (count: number) => Array.from({ length: count }, (_, index) => `# Rule ${index + 1}\nCode must follow convention number ${index + 1}.`).join("\n\n");
const ruleSet = (count: number): RuleSet => ({ sources: ["pi-warden.md"], rules: parseRules(rulesMarkdown(count)), alwaysDropped: 0 });
const withoutTime = <T extends object>(value: T) => ({ ...value, elapsedMs: undefined });

test("questionLimit: the backend's limit when the judge carries one, the schema's 32 when it does not", () => {
  assert.equal(questionLimit({ limits: { ...DEFAULT_BACKEND_LIMITS, maxQuestions: 16 } }), 16);
  assert.equal(questionLimit({ evaluate: async () => ({}) } as never), 32);
  assert.equal(questionLimit(undefined), 32);
});

test("rules guard: 31 rules and the edit locator take two requests of 16 on a 16-question backend, one of 32 elsewhere, same verdict", async () => {
  const target: RulesTarget = { tool: "edit", path: "src/a.ts", edits: [{ id: "edit_1", newText: "const a = 1;" }, { id: "edit_2", newText: "const b = 2;" }] };
  const run = async (maxQuestions: number) => {
    const { judge, counts } = fakeJudge(maxQuestions);
    const verdict = await evaluateRulesTarget(target, "edit", "src/a.ts", { cwd: process.cwd(), config: defaultConfig().rules, set: ruleSet(31), judge, timeoutMs: 1000 });
    return { verdict, counts };
  };
  const wide = await run(32);
  const narrow = await run(16);
  assert.deepEqual(wide.counts, [32]);
  assert.deepEqual(narrow.counts, [16, 16]);
  assert.equal(narrow.verdict.source, "typesafe");
  assert.ok(narrow.verdict.findings.length > 0 && narrow.verdict.editId, "the fake answers flag rules, so the locator answer is read");
  assert.deepEqual(withoutTime(narrow.verdict), withoutTime(wide.verdict));
});

test("turn rules: 31 rules take 16 + 15 questions on a 16-question backend, one request of 31 elsewhere, same verdict", async () => {
  const rules = ruleSet(31).rules;
  const run = async (maxQuestions: number) => {
    const { judge, counts } = fakeJudge(maxQuestions);
    const verdict = await evaluateTurnRules("Refactor the parser", "+const a = 1;", rules, { judge, config: defaultConfig().rules, timeoutMs: 1000, sources: ["pi-warden.md"] });
    return { verdict, counts };
  };
  const wide = await run(32);
  const narrow = await run(16);
  assert.deepEqual(wide.counts, [31]);
  assert.deepEqual(narrow.counts, [16, 15]);
  assert.ok(narrow.verdict.findings.length > 0);
  assert.deepEqual(withoutTime(narrow.verdict), withoutTime(wide.verdict));
});

test("rules check: two questions per rule are chunked to the backend's limit, same answers", async () => {
  const run = async (maxQuestions: number) => {
    const { judge, counts } = fakeJudge(maxQuestions);
    const result = await checkRules({ set: ruleSet(20), judge, timeoutMs: 1000 });
    return { result, counts };
  };
  const wide = await run(32);
  const narrow = await run(16);
  assert.deepEqual(wide.counts, [32, 8]);
  assert.deepEqual(narrow.counts, [16, 16, 8]);
  assert.equal(narrow.result.checked, 20);
  assert.deepEqual({ ...withoutTime(narrow.result), requests: undefined }, { ...withoutTime(wide.result), requests: undefined });
});

test("context filter: passages are batched at most 16 to a request on a 16-question backend, same kept text", async () => {
  const text = Array.from({ length: 80 }, (_, index) => index % 9 === 0 ? `line ${index} NEEDLE assertion failed` : `line ${index} progress ok`).join("\n") + "\nsummary: 1 failed\n";
  const input = { tool: "bash", command: "npm test", task: "Fix the failing parser test" };
  const config = { ...defaultConfig().context.filter, chunkChars: 40, minScore: 2 };
  const passage: Subject = (id, state) => String(state[id]);
  const run = async (maxQuestions: number) => {
    const { judge, counts } = fakeJudge(maxQuestions, passage);
    const result = await filterOutput(text, input, { config, judge });
    return { result, counts };
  };
  const wide = await run(32);
  const narrow = await run(16);
  assert.ok(wide.counts.some(count => count > 16), `the wide judge gets a request over 16: ${wide.counts.join(", ")}`);
  assert.ok(narrow.counts.every(count => count <= 16), `no request over 16: ${narrow.counts.join(", ")}`);
  assert.equal(narrow.counts.reduce((sum, count) => sum + count, 0), wide.counts.reduce((sum, count) => sum + count, 0), "every passage is asked about once");
  assert.equal(narrow.result.ok, true);
  const comparable = (result: typeof wide.result) => ({ ...result, elapsedMs: undefined, requests: undefined });
  assert.deepEqual(comparable(narrow.result), comparable(wide.result));
});

test("relevance compaction: 30 tool calls take 16 + 14 keep questions on a 16-question backend, 24 + 6 elsewhere, same summary", async () => {
  const messages: SpanMessage[] = [{ role: "user", content: "Fix the date parser." }];
  for (let index = 1; index <= 30; index++) {
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `c${index}`, name: "read", arguments: { path: `src/file${index}.ts` } }] });
    messages.push({ role: "toolResult", toolCallId: `c${index}`, toolName: "read", content: [{ type: "text", text: `export const value${index} = ${index};` }], isError: false });
  }
  const config = { keepThreshold: 0.5, maxSummaryTokens: 20000, timeoutMs: 2000, maxRequests: 12 };
  const run = async (maxQuestions: number) => {
    const { judge, counts } = fakeJudge(maxQuestions);
    const result = await relevanceCompaction({ messages, task: "Fix the date parser." }, { judge, config, concurrency: 1 });
    return { result, counts };
  };
  const wide = await run(32);
  const narrow = await run(16);
  assert.deepEqual(wide.counts, [24, 6]);
  assert.deepEqual(narrow.counts, [16, 14]);
  assert.equal(narrow.result.ok, true);
  assert.deepEqual(narrow.result.scores, wide.result.scores);
  assert.equal(narrow.result.ok && narrow.result.summary, wide.result.ok && wide.result.summary);
});

test("conscience: every request carries the disposition question; 31 candidates take 16 + 16 + 2 questions on a 16-question backend, same pick", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-warden-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills: Skill[] = Array.from({ length: 31 }, (_, index) => {
    const baseDir = join(root, `testing-${index + 1}`);
    const filePath = join(baseDir, "SKILL.md");
    mkdirSync(baseDir);
    writeFileSync(filePath, `# testing-${index + 1}\n`);
    return {
      name: `testing-${index + 1}`,
      description: `Write and run unit tests for the parser, variant ${index + 1}.`,
      filePath,
      baseDir,
      sourceInfo: { path: filePath, source: "local", scope: "user" as const, origin: "top-level" as const },
      disableModelInvocation: false,
    };
  });
  const candidate: Subject = (id, state) => {
    const entry = (state.candidates as Record<string, { name?: string }> | undefined)?.[id];
    return entry?.name ?? id;
  };
  const config = {
    ...defaultConfig().conscience,
    enabled: true,
    skills: { mode: "recommend" as const, exclude: [] },
    tools: { enabled: false, exclude: [] },
    skipTools: [],
    localTopK: 31,
    localFloor: 0,
    recommendThreshold: 0.5,
    advanceThreshold: 0.5,
  };
  const run = async (maxQuestions: number) => {
    const { judge, counts } = fakeJudge(maxQuestions, candidate, id => id === "conscience_disposition" ? "advance" : undefined);
    const result = await assess("add unit tests for the date parser", "", skills, [], [], [], { judge, config, sharedTimeoutMs: 5000 });
    return { result, counts };
  };
  const wide = await run(32);
  const narrow = await run(16);
  assert.deepEqual(wide.counts, [32]);
  assert.deepEqual(narrow.counts, [16, 16, 2]);
  assert.ok(narrow.result.selected, "the fake answers make one candidate useful enough to pick");
  const pick = (result: typeof wide.result) => ({ disposition: result.disposition, selected: result.selected?.id, usefulness: result.usefulness, pAdvance: result.pAdvance, skipReason: result.skipReason });
  assert.deepEqual(pick(narrow.result), pick(wide.result));
  assert.equal(narrow.result.requestCount, 3);
});

test("a judge with no limits (an extension author's own evaluate) still gets 32 questions per request", async () => {
  const target: RulesTarget = { tool: "edit", path: "src/a.ts", edits: [{ id: "edit_1", newText: "const a = 1;" }, { id: "edit_2", newText: "const b = 2;" }] };
  const { judge, counts } = fakeJudge(undefined);
  assert.ok(!("limits" in judge));
  const verdict = await evaluateRulesTarget(target, "edit", "src/a.ts", { cwd: process.cwd(), config: defaultConfig().rules, set: ruleSet(31), judge, timeoutMs: 1000 });
  assert.equal(verdict.source, "typesafe");
  assert.deepEqual(counts, [32]);
});

/** Every optional acting question on (plan, regret, large output, should-proceed), one rm violation per target, two extension questions. */
async function actionGuard(maxQuestions: number | undefined, targets: number) {
  const { judge, counts } = fakeJudge(maxQuestions);
  const command = `rm -rf ${Array.from({ length: targets }, (_, index) => `build/out-${index + 1}`).join(" ")}`;
  const base = judgedAction();
  const verdict = await evaluateAction(
    { tool: "bash", input: { command }, cwd: process.cwd(), task: "Tidy the workspace", plan: "Clear the old build output." },
    {
      config: { ...base, shouldProceed: { ...base.shouldProceed, steer: true } },
      judge,
      largeOutput: defaultConfig().context.largeOutput,
      previousActions: [{ id: "call_1", tool: "bash", command: "npm run build" }, { id: "call_2", tool: "bash", command: "ls build" }],
      questions: { ext_one: { type: "noul", instructions: "Is the build directory involved?" }, ext_two: { type: "noul", instructions: "Is this cleanup?" } } as never,
    },
  );
  return { verdict, counts };
}
const verdictOf = (verdict: Verdict) => ({ ...verdict, judgment: { ...verdict.judgment, elapsedMs: undefined } });

test("action guard: 6 and 12 open violations plus 2 extension questions fit a 16-question backend, same verdict as one request", async () => {
  for (const [targets, narrowCounts] of [[6, [16]], [12, [16, 6]]] as const) {
    const wide = await actionGuard(32, targets);
    const narrow = await actionGuard(16, targets);
    assert.equal(wide.verdict.source, "typesafe");
    assert.equal(Object.keys(wide.verdict.extra ?? {}).filter(key => key.startsWith("violation_")).length, targets);
    assert.deepEqual(wide.counts, [targets + 10]);
    assert.deepEqual(narrow.counts, narrowCounts);
    assert.deepEqual(verdictOf(narrow.verdict), verdictOf(wide.verdict));
  }
});

test("action guard: a judge with no limits sends the one request it sent before", async () => {
  const { verdict, counts } = await actionGuard(undefined, 12);
  assert.equal(verdict.source, "typesafe");
  assert.deepEqual(counts, [22]);
});

test("calibration: a sample with 20 questions takes two requests on a 16-question backend and one without limits, same scores", async () => {
  const history: HistoryCommit[] = [{
    hash: "c1", at: "2026-01-01T00:00:00.000Z",
    files: [{ path: "src/a.ts", binary: false, hunks: [{ oldText: "old", newText: "new", before: "ctx\nold\nctx", after: "ctx\nnew\nctx", start: 2, count: 1 }] }],
  }];
  const dir = mkdtempSync(join(tmpdir(), "pi-warden-calibrate-limit-"));
  try {
    const run = async (maxQuestions: number | undefined) => {
      const { judge, counts } = fakeJudge(maxQuestions);
      const result = await calibrate(history, { set: ruleSet(20), config: defaultConfig().rules, cwd: dir, maxRequests: 5, judge, timeoutMs: 1000 });
      return { result, counts };
    };
    const wide = await run(undefined);
    const narrow = await run(16);
    assert.deepEqual(wide.counts, [20]);
    assert.deepEqual(narrow.counts, [16, 4]);
    assert.equal(narrow.result.failed, 0);
    assert.equal(narrow.result.records.length, 20);
    assert.deepEqual(narrow.result.records, wide.result.records);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
