import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Judge } from "pi-typesafe";
import { defaultConfig, evaluateTurnRules, evaluateTurnRun, parseRules, RuleStore, snapshotTree } from "../src/index.js";
import { loadShellCases, loadTurnCases, ruleIds, SHELL_RULES_FIXTURE, TURN_RULES_FIXTURE } from "../eval/rules-bench/turn-cases.mjs";
import type { BenchLib, BenchRow } from "../eval/rules-bench/turn.mjs";
import { main, tables } from "../eval/rules-bench/turn.mjs";

const lib: BenchLib = { defaultConfig, parseRules, RuleStore, snapshotTree, evaluateTurnRules, evaluateTurnRun };

function stubJudge(violations: Record<string, number> = {}): Judge & { getUsage: () => unknown } {
  return {
    getUsage: () => ({ input_tokens: 1, output_tokens: 0 }),
    async evaluate(request: unknown) {
      const body = request as { questions: Record<string, { type: string }> };
      const answers: Record<string, unknown> = {};
      for (const [id] of Object.entries(body.questions)) {
        const violation = violations[id.replace(/^(?:rule|turn)_/, "")] ?? 0.05;
        answers[id] = { type: "choice", choice: violation >= 0.5 ? "violation" : "compliant", confidence: 0.9, probabilities: { compliant: 1 - violation - 0.02, violation, not_applicable: 0.01, insufficient_context: 0.01 } };
      }
      return { model: "jev-test", elapsedMs: 1, answers } as never;
    },
  };
}

test("turn bench cases: 36 turn cases and 6 shell cases, both labels per rule in both splits, every turn diff multi-file", () => {
  const turn = loadTurnCases();
  const shell = loadShellCases();
  assert.equal(turn.length, 36);
  assert.equal(shell.length, 6);
  const turnRules = new Set(ruleIds(TURN_RULES_FIXTURE));
  assert.equal(turnRules.size, 6, "six turn rules in the fixture");
  for (const rule of turnRules) {
    const ofRule = turn.filter(item => item.rule === rule);
    assert.equal(ofRule.length, 6, `${rule}: six cases`);
    for (const split of ["tune", "holdout"]) {
      const labels = new Set(ofRule.filter(item => item.split === split).map(item => item.label));
      assert.deepEqual([...labels].sort(), ["clean", "violation"], `${rule}/${split}: violations and near-misses`);
    }
    assert.ok(ofRule.every(item => (item.diff.match(/^diff --git /gm) ?? []).length >= 2), `${rule}: every case is a multi-file diff`);
  }
  const shellRules = new Set(ruleIds(SHELL_RULES_FIXTURE));
  for (const item of shell) assert.ok(shellRules.has(item.rule), `${item.id}: target rule exists`);
  assert.equal(shell.filter(item => item.label === "violation").length, 3);
  assert.equal(shell.filter(item => item.label === "clean").length, 3);
});

test("turn bench tables: recall and false alarms at 0.5, 0.6, 0.7, and 0.8 from the raw scores", () => {
  const rows: BenchRow[] = [
    { id: "1", source: "turn", rule: "r", split: "tune", label: "violation", kind: "violation", verdictSource: "typesafe", outcome: "violation", violation: 0.9 },
    { id: "2", source: "turn", rule: "r", split: "tune", label: "violation", kind: "violation", verdictSource: "typesafe", outcome: "compliant", violation: 0.4 },
    { id: "3", source: "turn", rule: "r", split: "tune", label: "clean", kind: "near-miss", verdictSource: "typesafe", outcome: "compliant", violation: 0.2 },
    { id: "4", source: "turn", rule: "r", split: "tune", label: "clean", kind: "near-miss", verdictSource: "typesafe", outcome: "violation", violation: 0.6 },
  ];
  const table = tables(rows);
  for (const cutoff of ["0.5", "0.6", "0.7", "0.8"]) assert.match(table, new RegExp(`^tune\\s+${cutoff.replace(".", "\\.")}`, "m"), `a row at ${cutoff}`);
  assert.ok(table.includes("0.500 (1/2)"), "one of two violations caught at 0.5 and above");
  assert.ok(table.includes("0.000 (0/2)"), "no false alarm at 0.7 and above");
});

test("turn bench runner: dry run sends nothing, and a full offline run drives every case through the real pass", async () => {
  const dry: string[] = [];
  const planned = await main(["--dry-run"], { lib, createJudge: () => stubJudge(), log: line => dry.push(line) });
  assert.deepEqual(planned, { sent: 0, planned: 42 });
  assert.ok(dry.some(line => line.startsWith("dry run: 0 requests sent")));

  const out = mkdtempSync(join(tmpdir(), "pi-warden-turn-bench-out-"));
  try {
    const lines: string[] = [];
    const result = await main(["--split", "all", "--out", out], {
      lib,
      createJudge: () => stubJudge({ "the-change-stays-inside-the-task": 0.9, "no-console-statements": 0.9 }),
      log: line => lines.push(line),
    });
    assert.equal(result.sent, 42, "one request per case");
    const saved = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as { cases: Array<{ id: string; violation?: number }>; tables: string };
    assert.equal(saved.cases.length, 42);
    for (const row of saved.cases) assert.ok(row.violation !== undefined, `${row.id}: the target rule was asked`);
    assert.match(saved.tables, /turn question \(36 cases\)/);
    assert.match(saved.tables, /shell-changed files \(6 cases\)/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
