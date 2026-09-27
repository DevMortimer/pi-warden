import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as lib from "../src/index.js";
import { main, scoreSheet, type ReviewSheet } from "../scripts/rules-replay.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** Answers every rule question: a violation when the request state carries the BAD marker. */
const fakeJudge = {
  async evaluate(request: { state: unknown; questions: Record<string, unknown> }) {
    const bad = JSON.stringify(request.state).includes("BAD");
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(request.questions)) {
      answers[key] = {
        type: "choice",
        choice: bad ? "violation" : "compliant",
        confidence: 0.9,
        probabilities: bad ? { violation: 0.92, compliant: 0.08 } : { violation: 0.05, compliant: 0.95 },
      };
    }
    return { answers, model: "fake", usage: { requestsStarted: 1 }, elapsedMs: 1 };
  },
};

/** A fake project with one rule, and a sessions directory with eight calls in one session plus one foreign session. */
function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), "rules-replay-test-"));
  const project = join(base, "project");
  const sessionsDir = join(base, "sessions");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "pi-warden.md"), "# No bad marker\nDo not write the marker BAD in any file.\n");
  mkdirSync(sessionsDir, { recursive: true });
  const event = (id: string, message: unknown) => JSON.stringify({ type: "message", id, timestamp: "2026-09-01T00:00:00.000Z", message });
  const call = (id: string, name: string, args: unknown) => event(id, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
  const result = (id: string) => event(`r-${id}`, { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] });
  const session = (id: string, cwd: string, calls: string[]) =>
    [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd }), ...calls].join("\n");
  writeFileSync(join(sessionsDir, "one.jsonl"), `${session("s1", project, [
    call("c1", "write", { path: join(project, "src/a.ts"), content: "const x = 1;\n" }), result("c1"),
    call("c2", "edit", { path: "src/a.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 2; // BAD\n" }] }), result("c2"),
    call("c3", "edit", { path: "src/missing.ts", edits: [{ oldText: "zzz", newText: "yyy" }] }), result("c3"),
    call("c4", "edit", { path: "src/a.ts", edits: [{ oldText: "gone text", newText: "new" }] }), result("c4"),
    call("c5", "edit", { path: "src/a.ts", edits: [{ oldText: "const x = 2; // BAD", newText: "const x = 3;" }] }), result("c5"),
    call("c6", "write", { path: join(base, "outside.ts"), content: "x\n" }), result("c6"),
    call("c7", "write", { path: join(project, "src/b.ts"), content: "const y = 2;\n" }), result("c7"),
    call("c8", "write", { path: join(project, "docs/note.md"), content: "" }), result("c8"),
  ])}\n`);
  writeFileSync(join(sessionsDir, "two.jsonl"), `${session("s2", base, [
    call("x1", "write", { path: join(base, "other.ts"), content: "BAD\n" }), result("x1"),
  ])}\n`);
  return { base, project, sessionsDir };
}

const depsFor = (fx: { sessionsDir: string }, extra: Record<string, unknown> = {}) => ({
  lib,
  createJudge: () => fakeJudge,
  sessionsDir: fx.sessionsDir,
  log: () => undefined,
  ...extra,
});

test("rules replay: fixture calls are rebuilt, judged, and counted", async () => {
  const fx = makeFixture();
  const out = join(fx.base, "out");
  const result = await main(["--project", fx.project, "--out", out], depsFor(fx));
  assert.ok(!("scored" in result));
  assert.deepEqual(result.aggregates.calls, { found: 8, selected: 8, rebuilt: 4, unrebuilt: 3, outside: 1, skipped: 1, judged: 3, flagged: 1, errors: 0, budgetSkipped: 0 });
  assert.equal(result.aggregates.sessions, 1);
  assert.deepEqual(result.aggregates.unrebuiltReasons, { "content before the call unknown": 2, "old text not found or not unique": 1 });
  assert.deepEqual(result.aggregates.skippedReasons, { "nothing to judge or outside the project": 1 });
  assert.deepEqual(result.aggregates.flaggedPerRule, { "no-bad-marker": 1 });
  assert.deepEqual(result.aggregates.requests, { budget: 20, spent: 3 });
  assert.equal(result.aggregates.labels, "unlabelled");
});

test("rules replay: the review sheet carries every flagged call and an equal unflagged sample", async () => {
  const fx = makeFixture();
  const out = join(fx.base, "out");
  const result = await main(["--project", fx.project, "--out", out], depsFor(fx));
  assert.ok(!("scored" in result));
  const flagged = result.sheet.items.filter(item => item.kind === "flagged");
  const unflagged = result.sheet.items.filter(item => item.kind === "unflagged");
  assert.equal(flagged.length, 1);
  assert.equal(unflagged.length, 1);
  const item = flagged[0]!;
  assert.equal(item.file, "src/a.ts");
  assert.equal(item.tool, "edit");
  assert.equal(item.rule, "no-bad-marker");
  assert.equal(item.score, 0.92);
  assert.match(item.excerpt, /BAD/);
  assert.equal(item.label, "");
  assert.ok(unflagged[0]!.file.startsWith("src/"));
  assert.equal(result.sheet.seed, 20260928);
  assert.equal(result.sheet.labels.real, "a real violation");
});

test("rules replay: only the report is written, never the project or the repository", async () => {
  const fx = makeFixture();
  const out = join(fx.base, "out");
  const projectBefore = snapshot(fx.project);
  const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  await main(["--project", fx.project, "--out", out], depsFor(fx));
  assert.deepEqual(snapshot(fx.project), projectBefore);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }), statusBefore);
  assert.deepEqual(readdirSync(out).sort(), ["aggregates.json", "review-sheet.json"]);
  // The aggregates are safe to commit: counts only, no paths and no excerpts.
  const aggregates = readFileSync(join(out, "aggregates.json"), "utf8");
  assert.doesNotMatch(aggregates, /\/Users\/|\/private\/|\/var\/folders\//);
  assert.doesNotMatch(aggregates, /excerpt|src\//);
});

test("rules replay: --dry-run counts calls, sends nothing, writes nothing", async () => {
  const fx = makeFixture();
  const out = join(fx.base, "never-created");
  const result = await main(["--project", fx.project, "--out", out, "--dry-run"], depsFor(fx));
  assert.ok(!("scored" in result));
  assert.deepEqual(result.aggregates.calls, { found: 8, selected: 8, rebuilt: 4, unrebuilt: 3, outside: 1, skipped: 1, judged: 0, flagged: 0, errors: 0, budgetSkipped: 0 });
  assert.deepEqual(result.aggregates.requests, { budget: 20, spent: 0, planned: 3 });
  assert.equal(existsSync(out), false);
});

test("rules replay: --max and --since bound the replay", async () => {
  const fx = makeFixture();
  const capped = await main(["--project", fx.project, "--max", "2", "--dry-run"], depsFor(fx));
  assert.ok(!("scored" in capped));
  assert.equal(capped.aggregates.calls.found, 8);
  assert.equal(capped.aggregates.calls.selected, 2);
  assert.equal(capped.aggregates.calls.judged, 0);
  assert.equal(capped.aggregates.requests.planned, 2);
  const past = await main(["--project", fx.project, "--since", "2026-09-05", "--dry-run"], depsFor(fx));
  assert.ok(!("scored" in past));
  assert.equal(past.aggregates.sessions, 0);
  assert.equal(past.aggregates.calls.found, 0);
});

test("rules replay: --budget is a hard cap on judged requests", async () => {
  const fx = makeFixture();
  const out = join(fx.base, "out");
  const result = await main(["--project", fx.project, "--out", out, "--budget", "1"], depsFor(fx));
  assert.ok(!("scored" in result));
  assert.equal(result.aggregates.calls.judged, 1);
  assert.equal(result.aggregates.calls.budgetSkipped, 2);
  assert.deepEqual(result.aggregates.requests, { budget: 1, spent: 1 });
});

test("rules replay: --score reports precision on flagged items and the miss rate from the unflagged sample", async () => {
  const fx = makeFixture();
  const labelled: ReviewSheet = {
    generated: "2026-09-01T00:00:00.000Z",
    seed: 20260928,
    labels: {},
    items: [
      { n: 1, kind: "flagged", tool: "write", file: "a.ts", rule: "r1", score: 0.9, excerpt: "x", label: "real" },
      { n: 2, kind: "flagged", tool: "write", file: "b.ts", rule: "r1", score: 0.8, excerpt: "x", label: "false-alarm" },
      { n: 3, kind: "flagged", tool: "write", file: "c.ts", rule: "r2", score: 0.8, excerpt: "x", label: "unsure" },
      { n: 4, kind: "unflagged", tool: "write", file: "d.ts", rule: "r1", score: 0.1, excerpt: "x", label: "real" },
      { n: 5, kind: "unflagged", tool: "write", file: "e.ts", rule: "r1", score: 0.1, excerpt: "x", label: "false-alarm" },
      { n: 6, kind: "unflagged", tool: "write", file: "f.ts", rule: "r1", score: 0.1, excerpt: "x", label: "false-alarm" },
    ],
  };
  const scored = scoreSheet(labelled);
  assert.equal(scored.flagged.precision, 0.5);
  assert.equal(scored.flagged.decided, 2);
  assert.equal(scored.flagged.unsure, 1);
  assert.ok(Math.abs(scored.unflagged.missRate - 1 / 3) < 1e-9);
  assert.equal(scored.unflagged.decided, 3);
  const sheetFile = join(fx.base, "labelled.json");
  writeFileSync(sheetFile, JSON.stringify(labelled));
  const lines: string[] = [];
  await main(["--score", sheetFile], depsFor(fx, { log: (line: string) => lines.push(line) }));
  assert.match(lines.join("\n"), /precision 0\.500 over 2 decided/);
  assert.match(lines.join("\n"), /miss rate 0\.333 over 3 decided/);
});

/** The file tree of a directory: relative path to content. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = readFileSync(path, "utf8");
    }
  };
  walk(dir, "");
  return out;
}
