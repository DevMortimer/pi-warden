import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { actionAskGate, gateCommand } from "../src/ask-gate.js";
import { defaultConfig } from "../src/config.js";
import { evaluateAction, traceOnlyQuestions, stripDataText } from "../src/guard.js";
import type { Judge } from "../src/guard.js";

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-warden-cut-"));
  await writeFile(join(cwd, "pi-warden.md"), "Never commit secrets to this repository.\n");
});
after(async () => { await rm(cwd, { recursive: true, force: true }); });

const config = () => defaultConfig().action;
/** The gate as the guard calls it: the command with data text blanked, and the raw text beside it. */
const asks = (command: string) => actionAskGate("bash", { command }, stripDataText(command).text, cwd).ask;

/** Answers every acting question; the trace-only ones when the request carries them. */
const judgeOf = (irreversible = 0.05): Judge & { calls: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> } => {
  const calls: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> = [];
  return {
    calls,
    async evaluate(request) {
      calls.push(request as never);
      const questions = (request as { questions: Record<string, { type: string }> }).questions;
      const answers: Record<string, unknown> = {
        irreversible: { type: "noul", noul: irreversible },
        mutates: { type: "noul", noul: 0.6 },
      };
      if (questions.scope) answers.scope = { type: "choice", choice: "expected_step", confidence: 0.9 };
      if (questions.off_task) answers.off_task = { type: "noul", noul: 0.1 };
      if (questions.should_proceed) answers.should_proceed = { type: "noul", noul: 0.9 };
      if (questions.visible) answers.visible = { type: "noul", noul: 0.05 };
      return { model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 }, elapsedMs: 1 } as never;
    },
  };
};

test("ask gate: a write, an edit, and the shapes that change something are asked", () => {
  for (const command of [
    "git push origin main", "git commit -m x", "git reset --hard",
    "rm -rf dist", "mv a b", "cp a b",
    "sed -i '' 's/a/b/' src/a.ts", "sed -i.bak 's/a/b/' src/a.ts",
    "cat > src/out.md <<'EOF'\nx\nEOF",
    "printf x | tee src/out.md",
    "psql -c 'select 1'", "sqlite3 x.db 'select 1'",
    "curl -X POST https://example.com/x", "curl -d a=1 https://example.com",
    "ssh host ls", "scp a host:", "rsync -a a host:",
    "npm publish", "npm install", "pip install x", "brew install x",
    "gh pr create --title x", "gh release delete v1", "gh repo delete o/r",
    "docker compose up -d", "kubectl apply -f x.yaml", "terraform apply",
    "sudo rm /etc/hosts",
  ]) assert.equal(asks(command), true, command);
  assert.equal(actionAskGate("write", { path: join(cwd, "a.ts"), content: "x" }, undefined, cwd).ask, true);
  assert.equal(actionAskGate("edit", { path: join(cwd, "a.ts"), edits: [] }, undefined, cwd).ask, true);
});

test("ask gate: reads, builds, tests, and searches are left to the offline pass", () => {
  for (const command of [
    "git status", "git log --oneline -5", "git diff", "git branch --show-current", "git remote -v",
    "ls -la", "grep -rn foo src", "cat src/a.ts", "sed -n 1,40p src/a.ts", "head -20 src/a.ts",
    "npm test", "npm run check", "make check-lisp", "flutter test", "go test ./...", "cargo build",
    "docker ps", "kubectl get pods", "terraform plan", "helm list",
    "gh pr view 1", "gh run list", "gh issue list",
    "curl https://example.com", "curl -o /tmp/out.json https://example.com",
    "echo done > /tmp/out.log 2>&1", "wc -l src/*.ts", "rg TODO",
  ]) assert.equal(asks(command), false, command);
});

test("ask gate: a script on the command line or a heredoc is read for such words", () => {
  assert.equal(asks(`python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/tmp/x')\nEOF`), true);
  assert.equal(asks(`python3 -c "import os; os.remove('a')"`), true);
  assert.equal(asks(`node -e "require('fs').writeFileSync('a','x')"`), true);
  assert.equal(asks(`bash -c "git push origin main"`), true);
  assert.equal(asks(`python3 -c "print(1)"`), false);
  // Text merely printed is not a command, so a message that mentions a push is not a push.
  assert.equal(asks(`echo "run git push when ready"`), false);
});

test("ask gate: a hidden call still runs the pattern floor and records that no request went out", async () => {
  const j = judgeOf();
  const verdict = await evaluateAction({ tool: "bash", input: { command: "npm test" }, cwd, task: "run the tests" }, { config: config(), judge: j });
  assert.equal(verdict.source, "pattern");
  assert.equal(verdict.notAsked, "no reversible-or-visible shape");
  assert.equal(j.calls.length, 0, "no request");
  // The pattern floor still runs for a call the gate left offline: the hit is reported even though no request went out.
  const hidden = await evaluateAction({ tool: "bash", input: { command: "npm test" }, cwd, task: "run the tests" }, { config: config(), judge: judgeOf() });
  assert.equal(hidden.notAsked, "no reversible-or-visible shape");
  const destructive = await evaluateAction({ tool: "bash", input: { command: "git reset --hard HEAD~3" }, cwd, task: "t" }, { config: config(), judge: judgeOf() });
  assert.ok(destructive.patterns.some(hit => hit.id === "git-reset-hard"), "the built-in hit is still found");
});

test("the acting request carries only what a delivered outcome reads: no context, no trace-only questions", async () => {
  const j = judgeOf();
  const verdict = await evaluateAction({ tool: "bash", input: { command: "git push origin main" }, cwd, task: "push it", context: [{ role: "user", text: "an earlier turn" }] }, { config: config(), judge: j, rules: { enabled: true } });
  const lean = j.calls.at(-1)!;
  assert.deepEqual(lean.state.context, [], "the acting request sends no context");
  assert.equal(lean.questions.scope, undefined);
  assert.equal(lean.questions.off_task, undefined);
  assert.equal(lean.questions.should_proceed, undefined);
  assert.equal(lean.state.rules, undefined, "rules ride the request only while a violation is open");
  assert.ok(lean.questions.irreversible && lean.questions.mutates && lean.questions.visible, "the acting questions stay");
  assert.equal(verdict.level, "allow");
});

/** Answers off-task, scope, and should-proceed badly whenever a request asks them, and nothing else it was not asked. */
const badAnswers = (acting: number, sampled = acting): Judge & { calls: Array<{ questions: Record<string, unknown> }> } => {
  const calls: Array<{ questions: Record<string, unknown> }> = [];
  return {
    calls,
    async evaluate(request) {
      calls.push(request as never);
      const questions = (request as { questions: Record<string, unknown> }).questions;
      const answers: Record<string, unknown> = { irreversible: { type: "noul", noul: 0.05 }, mutates: { type: "noul", noul: 0.9 } };
      if (questions.off_task) answers.off_task = { type: "noul", noul: 0.95 };
      if (questions.scope) answers.scope = { type: "choice", choice: "unrelated", confidence: 0.9 };
      if (questions.should_proceed) answers.should_proceed = { type: "noul", noul: "irreversible" in questions ? acting : sampled };
      return { model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 }, elapsedMs: 1 } as never;
    },
  };
};
const write = { tool: "write", input: { path: "src/a.ts", content: "export const a = 1;" }, cwd: "", task: "add a module" };

test("with the default config the acting request asks no off-task, scope, or should-proceed question", async () => {
  const j = badAnswers(0.1);
  const verdict = await evaluateAction({ ...write, cwd }, { config: { ...config(), traceSample: 0 }, judge: j });
  assert.equal(j.calls.length, 1, "one acting request and no sample");
  for (const id of ["off_task", "scope", "should_proceed"]) assert.equal(id in j.calls[0]!.questions, false, id);
  assert.equal(verdict.level, "allow");
  assert.equal(verdict.judgment?.shouldProceed, undefined);
});

test("with shouldProceed.steer the acting request asks should-proceed, and a score at or below the threshold steers", async () => {
  const cfg = { ...config(), traceSample: 0, shouldProceed: { threshold: 0.6, steer: true } };
  const j = badAnswers(0.3);
  const verdict = await evaluateAction({ ...write, cwd }, { config: cfg, judge: j });
  assert.equal(j.calls.length, 1, "the opt-in adds a question, not a request");
  assert.ok("should_proceed" in j.calls[0]!.questions);
  assert.equal("off_task" in j.calls[0]!.questions || "scope" in j.calls[0]!.questions, false, "off-task stays off the acting request");
  assert.equal(verdict.level, "warn");
  assert.equal(verdict.shouldProceedSteer, true);
  assert.equal(verdict.shouldProceedTraceOnly, undefined, "the opt-in steer reaches the agent");
  assert.ok(verdict.reasons.includes("should-proceed 0.30 (may need user input before continuing)"));
  const above = await evaluateAction({ ...write, cwd }, { config: cfg, judge: badAnswers(0.61) });
  assert.equal(above.level, "allow");
  assert.equal(above.shouldProceedSteer, undefined);
});

test("the opt-in steer does not widen the ask gate: a call the gate decides offline gets no should-proceed answer", async () => {
  const gated = { ...config(), traceSample: 0, shouldProceed: { threshold: 0.6, steer: true } };
  const j = badAnswers(0.1);
  const offline = await evaluateAction({ tool: "bash", input: { command: "npm test" }, cwd, task: "run the tests" }, { config: gated, judge: j });
  assert.equal(j.calls.length, 0, "no request at all");
  assert.equal(offline.judgment, undefined);
  assert.equal(offline.level, "allow");
  const everything = badAnswers(0.1);
  await evaluateAction({ tool: "bash", input: { command: "npm test" }, cwd, task: "run the tests" }, { config: { ...gated, ask: { enabled: false } }, judge: everything });
  assert.ok("should_proceed" in everything.calls[0]!.questions, "ask.enabled false asks every judged call");
});

test("the acting should-proceed answer wins over the sampled one", async () => {
  const cfg = { ...config(), shouldProceed: { threshold: 0.6, steer: true } };
  const j = badAnswers(0.9, 0.1);
  const verdict = await evaluateAction({ ...write, cwd }, { config: cfg, judge: j, traceSample: 1 });
  assert.equal(j.calls.length, 2);
  assert.equal(verdict.judgment?.shouldProceed, 0.9);
  assert.equal(verdict.shouldProceedSteer, undefined);
});

test("a sampled call runs its off-task and scope answers through the trace-only chain, and never holds", async () => {
  const j = badAnswers(0.1);
  const verdict = await evaluateAction({ ...write, cwd }, { config: { ...config(), ask: { enabled: false } }, judge: j, traceSample: 1 });
  assert.equal(verdict.level, "warn");
  assert.equal(verdict.offTaskTraceOnly, true);
  assert.equal(verdict.reasons[verdict.offTaskTraceOnlyReasonIndex!], "off-task 0.95 (unrelated to the request; trace-only until AUC clears 0.51)");
  assert.equal(verdict.shouldProceedTraceOnly, true);
  assert.equal(verdict.reasons[verdict.shouldProceedTraceOnlyReasonIndex!], "should-proceed 0.10 (trace-only until calibrated)");
});

test("with traceSample 0 no call gets an off-task or should-proceed reason", async () => {
  const j = badAnswers(0.1);
  for (const input of [write, { tool: "edit", input: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }, cwd: "", task: "rename" }, { tool: "bash", input: { command: "git push origin main" }, cwd: "", task: "push it" }]) {
    const verdict = await evaluateAction({ ...input, cwd }, { config: { ...config(), traceSample: 0 }, judge: j, traceSample: 0 });
    assert.equal(verdict.judgment?.offTask, undefined);
    assert.equal(verdict.judgment?.scope, undefined);
    assert.equal(verdict.judgment?.shouldProceed, undefined);
    assert.equal(verdict.reasons.some(reason => /off-task|should-proceed/.test(reason)), false, verdict.reasons.join("; "));
  }
  assert.equal(j.calls.length, 3, "each call sent its acting request only");
});

test("a sampled call also asks the trace-only questions, and their answers never set the level", async () => {
  const j = judgeOf();
  const first = await evaluateAction({ tool: "bash", input: { command: "git push origin main" }, cwd, task: "push it" }, { config: config(), judge: j, traceSample: 1 });
  assert.equal(j.calls.length, 2, "the acting request and the sampled one");
  const sampled = j.calls.find(call => "off_task" in call.questions)!;
  assert.deepEqual(Object.keys(sampled.questions).sort(), Object.keys(traceOnlyQuestions).sort());
  // A low off-task score in the sampled answer is recorded, never turned into a warn.
  assert.equal(first.level, "allow");
  assert.equal(first.offTaskTraceOnly, undefined);
  assert.equal(first.judgment?.offTask, 0.1, "the sampled answer lands in the judgment for the trace");
  assert.equal(first.judgment?.scope, "expected_step");
});
