import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Judge, Questions } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import { aggregateLevel, authorize, buildRequest, evaluateAction, scopeMatches } from "../src/guard.js";
import type { Violation } from "../src/guard.js";
import { buildInitPrompt, writeStarterRules } from "../src/init.js";
import { resolveRulesFile } from "../src/rules-file.js";
import { completeConfig } from "../src/shape.js";

let cwd: string;
before(async () => { cwd = await mkdtemp(join(tmpdir(), "warden-pipeline-")); });
after(async () => { await rm(cwd, { recursive: true, force: true }); });

function fakeJudge(scores: Record<string, number> = {}): Judge & { requests: Array<{ state: unknown; questions: Questions }> } {
  const requests: Array<{ state: unknown; questions: Questions }> = [];
  return {
    requests,
    async evaluate(request) {
      requests.push(request);
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === "noul") answers[key] = { type: "noul", noul: scores[key] ?? (key === "should_proceed" ? 1 : 0.01) };
        else if (question.type === "choice") answers[key] = { type: "choice", choice: "expected_step", confidence: 1, probabilities: { expected_step: 1 } };
      }
      return { model: "offline-test", elapsedMs: 1, usage: { input_tokens: 0, output_tokens: 0 }, answers } as never;
    },
  };
}

// Shell text below is inert input to the guard; these tests never execute it.
test("authorization does not clear a destructive hold for an unrelated target or a noun", async () => {
  for (const [task, command] of [
    ["delete scratch.txt", "rm -rf ../protected"],
    ["Adjust the display presets", "git reset --hard HEAD~1"],
    ["force push the feature branch", "git push --force origin main"],
    ["Explain how to force push: git push --force origin main", "git push --force origin main"],
    ["Do not, under any circumstances or at any point during this task, force push: git push --force origin main", "git push --force origin main"],
  ]) {
    const action = { tool: "bash", input: { command }, cwd, task };
    assert.equal((await evaluateAction(action, { config: defaultConfig().action })).level, "confirm");
    assert.equal((await evaluateAction(action, { config: defaultConfig().action, judge: fakeJudge() })).level, "confirm");
  }
});

test("non-rm bash violations fire in the pattern loop regardless of authorization", async () => {
  const config = defaultConfig().action;
  // Destructive patterns always fire in the pattern loop, even when the user explicitly named the command.
  assert.equal((await evaluateAction({ tool: "bash", input: { command: "git push --force origin feature" }, cwd, task: "force push" }, { config })).level, "confirm");
});

test("file-scope authorization requires every complete path, not a shared basename or substring", () => {
  assert.equal(scopeMatches("delete reports", { paths: ["eval/reports/"] }), false, "generic word does not authorize specific path");
  assert.equal(scopeMatches("delete eval/reports/", { paths: ["eval/reports/"] }), true, "exact path");
  assert.equal(scopeMatches("delete eval/reports-old", { paths: ["eval/reports"] }), false);
  assert.equal(scopeMatches("delete a.txt", { paths: ["a.txt", "b.txt"] }), false);
  assert.equal(scopeMatches("delete a.txt and b.txt", { paths: ["a.txt", "b.txt"] }), true);
  assert.equal(scopeMatches("delete report.ts", { paths: ["report.js"] }), false);
  const violation: Violation = { id: "rm-rf", severity: "risky", source: "pattern", description: "recursive removal", scope: { paths: ["tmp"] } };
  assert.equal(authorize("Explain how to remove tmp", violation).authorized, true, "target named in prompt");
  assert.equal(authorize("Remove tmp?", violation).authorized, false, "question punctuation prevents exact path match");
  assert.equal(authorize("Delete tmp, but do not remove anything", violation).authorized, false, "negation prevents authorization");
});

test("violation questions use instance keys and real answers control escalation", async () => {
  const judge = fakeJudge({ violation_0: 0.99 });
  const verdict = await evaluateAction({ tool: "bash", input: { command: "rm -rf /tmp/test" }, cwd, task: "delete test" }, { config: defaultConfig().action, judge });
  assert.ok(judge.requests[0]!.questions.violation_0);
  assert.equal(verdict.extra?.violation_0, 0.99);
  assert.equal(verdict.level, "deny");
});

test("duplicate violation IDs receive separate questions and scoped state", () => {
  const violations: Violation[] = ["one.txt", "two.txt"].map(path => ({ id: "rm-rf", severity: "risky", source: "pattern", description: "recursive removal", scope: { paths: [path] } }));
  const request = buildRequest({ tool: "bash", command: "fixture" }, "review", { violations });
  assert.deepEqual(Object.keys(request.questions).filter(key => key.startsWith("violation_")), ["violation_0", "violation_1"]);
  const dynamicQuestions = request.questions as Record<string, unknown>;
  assert.match(JSON.stringify(dynamicQuestions.violation_0), /Violation #1/);
  assert.match(JSON.stringify(dynamicQuestions.violation_1), /Violation #2/);
});

test("sensitive paths remain advisory and read-only suppression survives aggregation", async () => {
  const config = defaultConfig().action;
  const read = await evaluateAction({ tool: "bash", input: { command: "cat .env" }, cwd, task: "inspect the fixture" }, { config, judge: fakeJudge({ mutates: 0, violation_0: 0.99 }) });
  assert.equal(read.level, "allow");
  const write = await evaluateAction({ tool: "write", input: { path: ".env", content: "REVIEW_FIXTURE=1" }, cwd, task: "update the fixture" }, { config, judge: fakeJudge({ violation_0: 0.99 }) });
  assert.equal(write.level, "warn");
  assert.equal(aggregateLevel([{ id: "sensitive-path", severity: "sensitive", escalatedSeverity: "sensitive", source: "pattern", description: "credential file" }]), "warn");
});

test("older action sections receive the escalation default before making a decision", async () => {
  const { escalationThreshold: _threshold, ...legacyAction } = defaultConfig().action;
  const { config } = completeConfig({ ...defaultConfig(), action: legacyAction } as never);
  assert.equal(config.action.escalationThreshold, defaultConfig().action.escalationThreshold);
  const verdict = await evaluateAction({ tool: "bash", input: { command: "rm -rf build" }, cwd, task: "inspect output" }, { config: config.action, judge: fakeJudge({ violation_0: 0.6 }) });
  assert.equal(verdict.level, "warn");
});

test("unreadable rule candidates are skipped without crashing the hook", async () => {
  const directory = join(cwd, "bad-rules");
  await mkdir(join(directory, "AGENTS.md"), { recursive: true });
  // Unreadable file is silently skipped; pattern floor still fires.
  const harmless = await evaluateAction({ tool: "bash", input: { command: "npm test" }, cwd: directory, task: "run tests" }, { config: defaultConfig().action, judge: fakeJudge() });
  assert.equal(harmless.level, "allow");
  const destructive = await evaluateAction({ tool: "bash", input: { command: "git push --force origin main" }, cwd: directory, task: "run tests" }, { config: defaultConfig().action, judge: fakeJudge() });
  assert.equal(destructive.level, "confirm");
});

test("init preserves fallback policy and includes prior rules in the tailoring prompt", async () => {
  const directory = join(cwd, "init-policy");
  await mkdir(directory);
  const policy = "# Project policy\nUse the approved project logger for diagnostics.\n";
  await writeFile(join(directory, "AGENTS.md"), policy);
  assert.match(buildInitPrompt(directory), /approved project logger/);
  const result = writeStarterRules(directory);
  assert.match(result.content, /approved project logger/);
  assert.match(resolveRulesFile(directory)!.content, /approved project logger/);
  await writeFile(join(directory, "pi-warden.md"), "# Prior rule\nKeep the supported protocol version.\n");
  assert.match(buildInitPrompt(directory), /supported protocol version/);
  assert.match(await readFile(join(directory, "AGENTS.md"), "utf8"), /approved project logger/);
});
