import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeSafeIntegrationError } from "pi-typesafe";
import type { Judge } from "pi-typesafe";
import { applyProjectOverrides, applyUserOverrides, defaultConfig } from "../src/config.js";
import { buildFilterBatches, chunkLines, FILTER_MAX_QUESTIONS, FILTER_REQUEST_BYTES, FILTER_RUBRIC, filterOutput, selectChunks } from "../src/filter.js";
import { completeConfig } from "../src/shape.js";

const config = () => defaultConfig().context.filter;
const input = { tool: "bash", command: "npm test", task: "Fix the failing parser test", plan: "Run the suite to see which test fails." };

/** Synthetic log: numbered progress lines with a few marked lines the fake judge rates as useful. */
function log(lines: number, marked: readonly number[] = []): string {
  return Array.from({ length: lines }, (_, index) => marked.includes(index) ? `line ${index} NEEDLE assertion failed in parser.test.ts:${index}` : `line ${index} progress ok ${"·".repeat(40)}`).join("\n") + "\nsummary: 1 failed, 399 passed\n";
}

type Request = { state: Record<string, unknown>; questions: Record<string, { type: string; criteria: unknown }> };

/** Scores each chunk from its text; records every request so batching and concurrency can be checked. */
function fakeJudge(rate: (chunk: string) => number, sent: Request[] = [], delayMs = 0): Judge {
  return {
    async evaluate(request: unknown) {
      const body = request as Request;
      sent.push(body);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "score", score: rate(String(body.state[id])), confidence: 0.9, legend: {}, probabilities: {} }]));
      return { model: "jev-test", elapsedMs: delayMs, answers, usage: { input_tokens: 1, output_tokens: 0 } } as never;
    },
  };
}
const needle = (chunk: string) => chunk.includes("NEEDLE") ? 3 : 0;

test("filter config: off by default, parsed from user and project files, malformed values keep defaults", () => {
  assert.deepEqual(config(), { enabled: false, chunkChars: 2000, minScore: 1.5, maxKeptChars: 6000, timeoutMs: 4000 });
  for (const apply of [applyUserOverrides, applyProjectOverrides]) {
    const on = apply(defaultConfig(), { context: { filter: { enabled: true, chunkChars: 3000, minScore: 2, maxKeptChars: 8000, timeoutMs: 2500 } } });
    assert.deepEqual(on.context.filter, { enabled: apply === applyUserOverrides, chunkChars: 3000, minScore: 2, maxKeptChars: 8000, timeoutMs: 2500 });
    const bad = apply(defaultConfig(), { context: { filter: { enabled: "yes", chunkChars: -5, minScore: 4, maxKeptChars: 1.5, timeoutMs: 0 } } });
    assert.deepEqual(bad.context.filter, config());
    assert.deepEqual(apply(defaultConfig(), { context: { filter: null } }).context.filter, config());
  }
  // An older config module without the key: the filter stays off.
  const legacy = defaultConfig();
  delete (legacy.context as Partial<typeof legacy.context>).filter;
  assert.equal(completeConfig(legacy).config.context.filter.enabled, false);
});

test("a project file tunes the filter but cannot turn it on or off; only the user file can", () => {
  const project = applyProjectOverrides(defaultConfig(), { context: { filter: { enabled: true, minScore: 2 } } });
  assert.equal(project.context.filter.enabled, false, "a project cannot enable the filter");
  assert.equal(project.context.filter.minScore, 2, "a project may tune it");
  const user = applyUserOverrides(defaultConfig(), { context: { filter: { enabled: true } } });
  assert.equal(applyProjectOverrides(user, { context: { filter: { enabled: false, timeoutMs: 3000 } } }).context.filter.enabled, true, "nor turn off what the user turned on");
});

test("chunks end at line boundaries near chunkChars; only a line longer than chunkChars is split", () => {
  const text = log(300);
  const chunks = chunkLines(text, 2000);
  assert.equal(chunks.join(""), text, "chunks join back to the exact output");
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.length <= 2000);
    assert.ok(chunk.endsWith("\n"), "every chunk but the last ends a line");
    assert.ok(chunk.length > 2000 - 60, "a chunk is filled up to near chunkChars");
  }
  const long = `short\n${"x".repeat(4500)}\nend`;
  assert.deepEqual(chunkLines(long, 2000).map(chunk => chunk.length), [6, 2000, 2000, 501, 3]);
  assert.equal(chunkLines(long, 2000).join(""), long);
});

test("selection keeps chunks at or above minScore in original order, marks gaps, and always keeps the tail", () => {
  const chunks = ["a1\na2\n", "b1\n", "c1\nc2\nc3\n", "d1\n", "x".repeat(1500) + "\n", "e".repeat(900) + "\n"];
  const kept = selectChunks(chunks, [1.4, 1.5, 0, 3, 0, 0], { minScore: 1.5, maxKeptChars: 6000 })!;
  const tail = chunks.join("").slice(-1000);
  assert.equal(kept.text, `[… 2 lines omitted …]\nb1\n[… 3 lines omitted …]\nd1\n[… 1 line omitted …]\n${tail}`);
  assert.equal(kept.kept, 2, "1.4 is below the threshold; 1.5 is kept");
  assert.equal(kept.keptChars, 3 + 3 + 1000);
  assert.equal(selectChunks(chunks, [0, 1, 1.49, 0, 0, 3], { minScore: 1.5, maxKeptChars: 6000 }), undefined, "a chunk only inside the tail does not count as passing");
});

test("above maxKeptChars the highest scores win and original order is restored", () => {
  const chunks = Array.from({ length: 8 }, (_, index) => `${String(index).repeat(999)}\n`);
  const scores = [2, 3, 1.5, 2.5, 0, 0, 0, 0];
  const kept = selectChunks(chunks, scores, { minScore: 1.5, maxKeptChars: 3000 })!;
  // Budget 3000 - 1000 tail = 2000: chunks 1 (3) and 3 (2.5) fit, in original order.
  assert.equal(kept.kept, 2);
  assert.ok(kept.text.indexOf("111") < kept.text.indexOf("333"));
  assert.ok(!kept.text.includes("000") && !kept.text.includes("222"));
  assert.ok(kept.keptChars <= 3000);
  assert.ok(kept.text.endsWith(chunks.join("").slice(-1000)));
});

test("batches stay under the request size and question limits and cover each chunk once", () => {
  const chunks = chunkLines(log(1200), 2000);
  const batches = buildFilterBatches(chunks, input);
  assert.ok(batches.length >= 2, "a 50k output needs more than one request");
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify({ state: batch.state, questions: batch.questions })) <= FILTER_REQUEST_BYTES);
    assert.ok(Object.keys(batch.questions).length <= FILTER_MAX_QUESTIONS);
    assert.equal(batch.state.task, input.task);
    assert.equal(batch.state.plan, input.plan);
    assert.equal(batch.state.command, "npm test");
  }
  assert.deepEqual(batches.flatMap(batch => batch.ids), chunks.map((_, index) => index));
  assert.ok(batches.length <= Math.ceil(Buffer.byteLength(JSON.stringify(chunks)) / FILTER_REQUEST_BYTES) + 1, "as few requests as the limit allows");
  const question = batches[0]!.questions.c1!;
  assert.equal(question.type, "score");
  assert.deepEqual(question.criteria, [...FILTER_RUBRIC]);
  assert.match(String(question.instructions), /agent's current task/);
  // Tiny chunks hit the question limit before the size limit.
  assert.deepEqual(buildFilterBatches(Array.from({ length: 40 }, (_, index) => `${index}\n`), input).map(batch => batch.ids.length), [32, 8]);
});

test("chunk text, task, plan, and command are redacted before they leave", () => {
  const secret = "ghp_" + "Qk7mZ2xR9vT4bN8cL1pW6sD3fH5jK0aYuE2i";
  const [batch] = buildFilterBatches([`token ${secret}\n`], { ...input, task: `use ${secret}`, plan: `print ${secret}`, command: `echo ${secret}` });
  assert.ok(!JSON.stringify(batch).includes(secret));
});

test("the filter keeps the useful passages word for word, in order, with the tail, and runs batches in parallel", async () => {
  const text = log(1200, [100, 700]);
  const sent: Request[] = [];
  const started = Date.now();
  const result = await filterOutput(text, input, { config: config(), judge: fakeJudge(needle, sent, 100) });
  assert.ok(result.ok);
  assert.ok(sent.length >= 2);
  assert.ok(Date.now() - started < 100 * sent.length, "batches run in parallel");
  assert.equal(result.requests, sent.length);
  assert.equal(result.kept, 2);
  assert.match(result.text, new RegExp(`^\\[pi-warden: filtered; ${text.length} original characters, ${text.split("\n").length} lines\\. Passages selected for the current task; omitted text is in the full-output file\\.\\]\n\\[… \\d+ lines omitted …\\]\n`));
  assert.ok(result.text.indexOf("line 100 NEEDLE") < result.text.indexOf("line 700 NEEDLE"));
  assert.ok(result.text.endsWith(text.slice(-1000)), "the final status is always kept");
  for (const line of result.text.split("\n")) if (line && !line.startsWith("[")) assert.ok(text.includes(line), "every kept line is verbatim");
  assert.ok(result.keptChars <= config().maxKeptChars);
});

test("every judge failure and an empty selection fall back with a reason", async () => {
  const text = log(400, [10]);
  const failing = (code: "timeout" | "budget" | "http"): Judge => ({ async evaluate() { throw new TypeSafeIntegrationError(code, code); } });
  for (const [code, reason] of [["timeout", "timeout"], ["budget", "budget"], ["http", "error"]] as const) {
    const result = await filterOutput(text, input, { config: config(), judge: failing(code) });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, reason);
    assert.ok(result.requests >= 1);
  }
  const none = await filterOutput(text, input, { config: config(), judge: fakeJudge(() => 1) });
  assert.equal(!none.ok && none.reason, "none_passed");
  // One failed batch among several discards the whole attempt: partial scores would bias the selection.
  let calls = 0;
  const flaky: Judge = { async evaluate(request) { if (calls++ === 1) throw new TypeSafeIntegrationError("timeout", "timeout"); return fakeJudge(needle).evaluate(request as never); } };
  const partial = await filterOutput(log(1200, [5]), input, { config: config(), judge: flaky });
  assert.equal(!partial.ok && partial.reason, "timeout");
});

test("the filter's deadline is timeoutMs", async () => {
  // A dead backend holds its socket open; the fake holds a referenced timer instead. The deadline timer is unref'd, so
  // without one the loop would drain before the abort fires. The timer is cleared on abort.
  const hang: Judge = { evaluate: (_request, options) => new Promise((_, reject) => {
    const alive = setTimeout(() => undefined, 60_000);
    options?.signal?.addEventListener("abort", () => { clearTimeout(alive); reject(options.signal!.reason); }, { once: true });
  }) };
  const started = Date.now();
  const result = await filterOutput(log(400), input, { config: { ...config(), timeoutMs: 50 }, judge: hang });
  assert.equal(!result.ok && result.reason, "timeout");
  assert.ok(Date.now() - started < 2000);
});
