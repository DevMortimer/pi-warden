import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type { Verdict } from "../src/guard.js";
import { formatHolds, HoldLedger, HoldLog, holdLogPath, mutatingCall, outcomeNote, regretsAt, textRegrets } from "../src/holds.js";

const verdict = (overrides: Partial<Verdict> & { command?: string; path?: string } = {}): Verdict => {
  const { command, path, ...rest } = overrides;
  return {
    level: "confirm",
    source: "typesafe",
    summary: { tool: "bash", ...(command !== undefined ? { command } : {}), ...(path !== undefined ? { path } : {}) },
    patterns: [{ id: "git-force-push", severity: "destructive", label: "git force push" }],
    reasons: ["destructive: git force push", "irreversible 0.91"],
    judgment: { irreversible: 0.91, offTask: 0.2, scope: "expected_step", scopeConfidence: 0.8, mutates: 0.95, model: "jev-test", elapsedMs: 5 },
    ...rest,
  };
};

let temporary: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-warden-holds-"));
  process.env.PI_CODING_AGENT_DIR = temporary;
});

after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await rm(temporary, { recursive: true, force: true });
});

test("a hold released by the user's reply is a false positive; the pending hold of the same tool takes the label", () => {
  const ledger = new HoldLedger();
  const write = ledger.record(verdict({ summary: { tool: "write", path: "a.ts" } }), { held: true, mode: "steer", at: 1 });
  const bash = ledger.record(verdict({ command: "git push --force" }), { held: true, mode: "steer", at: 2 });
  assert.equal(ledger.approved("bash", "retry", 3)?.id, bash.id);
  assert.equal(bash.outcome, "approved");
  assert.equal(bash.outcomeVia, "retry");
  assert.equal(bash.outcomeAt, 3);
  assert.equal(write.outcome, "pending");
  assert.equal(ledger.approved("edit", "retry", 4)?.id, write.id, "no hold of that tool: the latest pending hold is released");
  assert.equal(ledger.approved("bash"), undefined, "nothing left to release");
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.holds, 2);
  assert.equal(snapshot.approved, 2);
  assert.equal(snapshot.precision, 0);
  assert.match(outcomeNote(bash), /released on retry.*false positive/);
});

test("a steer hold the reply neither releases nor replaces is abandoned when the run ends", () => {
  const ledger = new HoldLedger();
  const hold = ledger.record(verdict(), { held: true, mode: "steer", at: 1 });
  assert.deepEqual(ledger.runEnded(2), [], "the run that held the call ends before the user can reply; the reply is what releases it");
  assert.equal(hold.outcome, "pending");
  assert.equal(ledger.snapshot().awaiting, 1);
  ledger.promptArrived();
  assert.equal(hold.outcome, "pending", "the reply alone decides nothing");
  const changed = ledger.runEnded(3);
  assert.deepEqual(changed.map(record => record.id), [hold.id]);
  assert.equal(hold.outcome, "abandoned");
  assert.equal(hold.outcomeVia, "next prompt");
  assert.equal(hold.outcomeAt, 3);
  assert.deepEqual(ledger.runEnded(4), [], "labels land once");
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.abandoned, 1);
  assert.equal(snapshot.awaiting, 0);
  assert.equal(snapshot.labels, 0, "abandoned is not in the precision denominator");
  assert.equal(snapshot.precision, undefined, "nothing was measured as a true or false positive");
  assert.match(outcomeNote(hold), /nothing came of it/);
  assert.match(formatHolds(snapshot), /1 hold; 0 approved by you, 0 declined, 0 re-planned, 1 abandoned, 0 awaiting your reply/);
});

test("a steer hold becomes a re-plan once the reply has arrived and a mutating call arrives instead", () => {
  const ledger = new HoldLedger();
  const hold = ledger.record(verdict({ command: "rm -rf build" }), { held: true, mode: "steer", at: 1 });
  assert.deepEqual(ledger.replanned(2), [], "the hold's own run is not a re-plan: the user has not replied yet");
  ledger.promptArrived();
  assert.deepEqual(ledger.replanned(3).map(record => record.id), [hold.id]);
  assert.equal(hold.outcome, "replanned");
  assert.equal(hold.outcomeVia, "next prompt");
  assert.deepEqual(ledger.runEnded(4), [], "a labelled hold is not labelled again");
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.replanned, 1);
  assert.equal(snapshot.abandoned, 0);
  assert.equal(snapshot.precision, 1);
  assert.equal(snapshot.labels, 1);
  assert.match(outcomeNote(hold), /replaced by another call that changes something/);
});

test("only a steer hold waits for the reply; the dialog decides a confirm-mode hold at once", () => {
  const ledger = new HoldLedger();
  const hold = ledger.record(verdict(), { held: true, mode: "confirm", at: 1 });
  ledger.promptArrived();
  assert.deepEqual(ledger.runEnded(2), [], "confirm mode labels the hold through the dialog, not through the run end");
  assert.equal(hold.outcome, "pending");
});

test("mutatingCall reads the write family and Jev's mutates score", () => {
  assert.equal(mutatingCall(verdict({ summary: { tool: "write", path: "a.ts" } })), true, "a write changes a file whatever Jev says");
  const noJudgment = verdict({ summary: { tool: "bash" } });
  delete noJudgment.judgment;
  assert.equal(mutatingCall(noJudgment), false, "a bash call with no judgment is not read as mutating");
  assert.equal(mutatingCall(verdict({ command: "ls", judgment: { irreversible: 0.1, offTask: 0.1, scope: "expected_step", scopeConfidence: 0.8, mutates: 0.8, model: "jev-test", elapsedMs: 5 } })), true);
  assert.equal(mutatingCall(verdict({ command: "ls", judgment: { irreversible: 0.1, offTask: 0.1, scope: "expected_step", scopeConfidence: 0.8, mutates: 0.2, model: "jev-test", elapsedMs: 5 } })), false);
});

test("dialog decisions label the hold at once", () => {
  const ledger = new HoldLedger();
  const allowed = ledger.record(verdict(), { held: true, mode: "confirm", outcome: "approved", via: "dialog", at: 1 });
  const refused = ledger.record(verdict(), { held: true, mode: "confirm", outcome: "declined", via: "dialog", at: 2 });
  assert.equal(allowed.outcomeAt, 1);
  assert.equal(refused.outcomeVia, "dialog");
  assert.equal(ledger.snapshot().precision, 0.5);
  assert.match(outcomeNote(allowed), /confirm dialog.*false positive/);
  assert.match(outcomeNote(refused), /declined.*hold stood/);
});

test("allowed calls of the last turn are the regret candidates; the located one is the miss, the rest are accepted", () => {
  const ledger = new HoldLedger();
  ledger.record(verdict({ level: "allow", command: "npm test" }), { held: false, mode: "steer" });
  const push = ledger.record(verdict({ level: "warn", command: `git push origin main ${"x".repeat(400)}` }), { held: false, mode: "steer" });
  ledger.record(verdict(), { held: true, mode: "steer" });
  assert.deepEqual(ledger.candidates(), [], "the user has not replied yet");
  ledger.promptArrived();
  const candidates = ledger.candidates();
  assert.deepEqual(candidates.map(candidate => candidate.id), ["a1", "a2"], "holds are not candidates");
  assert.equal(candidates[1]!.tool, "bash");
  assert.equal(candidates[1]!.command!.length, 301, "commands are clipped for the request");
  const changed = ledger.regret({ regretted: true, target: "a2", probability: 0.88, via: "jev" });
  assert.deepEqual(changed.map(record => [record.id, record.outcome]), [[1, "accepted"], [2, "regretted"]]);
  assert.equal(push.regret, 0.88);
  assert.equal(push.outcomeVia, "jev");
  assert.deepEqual(ledger.candidates(), [], "labelled calls leave the candidate set");
  assert.deepEqual(ledger.regret({ regretted: true, via: "text" }), [], "nothing left to label");
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.allowed, 2);
  assert.equal(snapshot.regretted, 1);
  assert.equal(snapshot.accepted, 1);
  assert.match(outcomeNote(push), /regrets this call \(0\.88\); it should have been held/);
});

test("regret without a located target falls on the latest candidate; candidates two prompts old are no longer asked about", () => {
  const ledger = new HoldLedger();
  ledger.record(verdict({ level: "allow" }), { held: false, mode: "steer" });
  const last = ledger.record(verdict({ level: "allow" }), { held: false, mode: "steer" });
  ledger.promptArrived();
  assert.deepEqual(ledger.regret({ regretted: true, target: "a9", via: "text" }).map(record => record.outcome), ["accepted", "regretted"]);
  assert.equal(last.outcome, "regretted");

  const stale = new HoldLedger();
  const record = stale.record(verdict({ level: "allow" }), { held: false, mode: "steer" });
  stale.promptArrived();
  stale.promptArrived();
  assert.deepEqual(stale.candidates(), []);
  assert.equal(record.outcome, "pending", "an allowed call that was never checked stays pending, not accepted");
});

test("textRegrets reads a stop, undo, or objection at the start of the reply, not the word wait elsewhere", () => {
  for (const text of ["wait, don't push that", "Stop!", "no, that was wrong", "undo that", "Revert the last commit you made", "why did you delete the branch?", "hold on", "Please don't run that again", "  roll back what you did"]) {
    assert.equal(textRegrets(text), true, text);
  }
  for (const text of ["yes, go ahead", "wait for CI to finish, then push", "now add the tests", "looks good", "the build passed; next, update the docs", undefined, ""]) {
    assert.equal(textRegrets(text), false, String(text));
  }
  assert.equal(regretsAt(0.7), true);
  assert.equal(regretsAt(0.69), false);
});

test("formatHolds reports counts and precision, or says there is nothing yet", () => {
  const ledger = new HoldLedger();
  assert.equal(formatHolds(ledger.snapshot()), "Holds: no guarded call judged yet this session.");
  ledger.record(verdict({ level: "allow" }), { held: false, mode: "steer" });
  assert.match(formatHolds(ledger.snapshot()), /^Holds: 0 holds; precision not yet measurable; 1 allowed \(0 regretted by you, 0 accepted\)\.$/);
  ledger.record(verdict(), { held: true, mode: "steer" });
  ledger.record(verdict(), { held: true, mode: "confirm", outcome: "declined", via: "dialog" });
  ledger.record(verdict(), { held: true, mode: "confirm", outcome: "approved", via: "dialog" });
  const line = formatHolds(ledger.snapshot(), "/tmp/holds.jsonl");
  assert.match(line, /3 holds; 1 approved by you, 1 declined, 0 re-planned, 0 abandoned, 1 awaiting your reply; precision 50% over 2 labels; 1 allowed/);
  assert.match(line, /Log: \/tmp\/holds\.jsonl\.$/);
});

test("the log is one JSON line per call, owner-only, under the agent directory, and never contains the command", async () => {
  const path = holdLogPath("sess/../id 42", new Date("2026-09-19T10:00:00Z"));
  assert.equal(path, join(temporary, "pi-warden", "holds", "2026-09-19-sessid42.jsonl"));
  const log = new HoldLog(path);
  const ledger = new HoldLedger();
  ledger.record(verdict({ command: "git push --force origin main" }), { held: true, mode: "steer", at: 1 });
  await log.save(ledger.records());
  const first = await stat(path);
  ledger.approved("bash", "retry", 2);
  ledger.record(verdict({ level: "allow", command: "rm -rf secret-dir" }), { held: false, mode: "steer", at: 3 });
  await log.save(ledger.records());
  if (process.platform !== "win32") assert.notEqual((await stat(path)).ino, first.ino, "a save replaces the file, so a reader never gets a line cut short");
  assert.deepEqual(await readdir(dirname(path)), [basename(path)], "no temporary file is left beside the log");
  const text = await readFile(path, "utf8");
  const lines = text.trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 2, "the file holds the current state of every record, not an event per change");
  assert.deepEqual(lines[0], { id: 1, at: 1, tool: "bash", level: "confirm", source: "typesafe", mode: "steer", held: true, patterns: ["git-force-push"], reasons: ["destructive: git force push", "irreversible 0.91"], planChars: 0, scores: { irreversible: 0.91, offTask: 0.2, scope: "expected_step", mutates: 0.95 }, outcome: "approved", outcomeAt: 2, outcomeVia: "retry", callExcerpt: "bash" });
  assert.equal(lines[1]!.outcome, "pending");
  assert.ok(!text.includes("origin main") && !text.includes("secret-dir"), "commands never reach the log");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(log.lastFailure, undefined);

  const broken = new HoldLog(join(temporary, "pi-warden", "holds", "2026-09-19-sessid42.jsonl", "nested.jsonl"));
  await broken.save(ledger.records());
  assert.ok(broken.lastFailure, "a write into a file path fails and is remembered instead of thrown");
});

test("rules verdicts land in records() and the log as tool \"rules\", never as regret candidates", async () => {
  const ledger = new HoldLedger();
  ledger.recordRules({ source: "typesafe", path: "src/x.ts", findings: [{ name: "No hardcoded secrets", violation: 0.88 }] });
  ledger.recordRules({ source: "typesafe", path: "src/y.ts", findings: [] });
  const records = ledger.records().slice(-2);
  assert.ok(records[0] && records[1]);
  assert.equal(records[0].tool, "rules");
  assert.equal(records[0].level, "warn");
  assert.equal(records[0].held, false);
  assert.deepEqual(records[0].reasons, ["No hardcoded secrets 0.88"]);
  assert.equal(records[1].level, "allow");
  // they never join the regret labelling: no pending action candidates from rules records
  assert.deepEqual(ledger.candidates(), []);
  const path = join(temporary, "rules-log.jsonl");
  await new HoldLog(path).save(ledger.records());
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const parsed = lines.map(line => JSON.parse(line) as { tool: string; reasons: string[] });
  assert.ok(parsed.some(r => r.tool === "rules" && r.reasons.includes("No hardcoded secrets 0.88")));
});

test("reset clears every record, including the rules verdicts, so a new session does not inherit the last one's counts", () => {
  const ledger = new HoldLedger();
  ledger.record(verdict({ command: "git push --force origin main" }), { held: true, mode: "steer" });
  ledger.recordRules({ source: "typesafe", path: "src/x.ts", findings: [{ name: "No hardcoded secrets", violation: 0.88 }] });
  assert.equal(ledger.snapshot().allowed, 1);
  assert.equal(ledger.snapshot().holds, 1);
  ledger.reset();
  assert.deepEqual(ledger.records(), [], "records from the previous session are gone, not just the tracked ones");
  assert.deepEqual(ledger.snapshot(), { holds: 0, approved: 0, declined: 0, replanned: 0, abandoned: 0, awaiting: 0, allowed: 0, regretted: 0, accepted: 0, labels: 0, precision: undefined });
  // The id counter restarts, so the new session's first record is a1 again and matches the regret target ids.
  assert.equal(ledger.recordRules({ source: "typesafe", findings: [] }).id, 1);
});
