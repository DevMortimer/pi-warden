import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import { buildCuratorRequest, curatedRuleList, curatedRules, curatorPercentile, CuratorLedger, formatCuratedRules, formatCurator, ruleFirstLine, ruleScores } from "../src/curator.js";
import type { Rule } from "../src/rules.js";

// The config module is loaded first on purpose: the rules module and the context guards import each other, and this is
// the order every other test of the rules path uses.
const shipped = defaultConfig();

const rule = (id: string, name: string, body: string, paths: string[] = []): Rule => ({ id, name, body, paths });

test("the shipped defaults: the reminder is on at the measured cut, and working memory is off", () => {
  assert.deepEqual(shipped.rulesAtTurnStart, { enabled: true, threshold: 0.3 });
  assert.equal(shipped.workingMemory.enabled, false, "the feasibility gate failed; the switch cannot turn it on");
});

test("the rule list carries the heading, the first line, the text, and the path scope, in file order", () => {
  const rules = curatedRuleList([
    rule("a", "No hardcoded secrets", "\nSource code must not contain passwords.\nMore detail here.", []),
    rule("b", "Version bumps stay out", "paths: package.json\nUse a separate commit.", ["package.json"]),
  ]);
  assert.deepEqual(rules.map(entry => entry.name), ["No hardcoded secrets", "Version bumps stay out"]);
  assert.equal(rules[0]!.first, "Source code must not contain passwords.");
  assert.match(rules[0]!.text, /Source code must not contain passwords\. More detail here\./);
  assert.deepEqual(rules[1]!.paths, ["package.json"]);
  assert.equal(ruleFirstLine("\n\n   \n- Only this line"), "Only this line");
});

test("the request asks one question per rule, names the rule, and redacts the request", () => {
  const rules = curatedRuleList([rule("a", "House prose", "No em-dashes in documents.", []), rule("b", "Config is additive", "New keys get a default.", ["src/config.ts"])]);
  const request = buildCuratorRequest("Add a key. TOKEN=ghp_Qk7mZ2w8n4v1x6b9c3d5f7h2j4k6l8m0p", undefined, rules);
  assert.deepEqual(Object.keys(request.questions), ["applies_0", "applies_1"]);
  assert.match(JSON.stringify(request.questions), /House prose/);
  assert.match(JSON.stringify(request.questions), /src\/config\.ts/);
  assert.ok(!JSON.stringify(request.state).includes("ghp_Qk7mZ2w8n4v1x6b9c3d5f7h2j4k6l8m0p"), "the request is redacted before it leaves");
  assert.ok(!("task_spine" in request.state), "no spine for a first turn");
});

test("scores parse as numbers, malformed answers count as zero, and only rules over the threshold are named", () => {
  const rules = curatedRuleList([rule("a", "A", "a", []), rule("b", "B", "b", []), rule("c", "C", "c", [])]);
  const scores = ruleScores({ applies_0: { noul: 0.9 }, applies_1: { noul: "yes" }, applies_2: 0.31 }, rules);
  assert.deepEqual(scores, [0.9, 0, 0.31]);
  const named = curatedRules(rules, scores, 0.3);
  assert.deepEqual(named.map(entry => entry.id), ["a", "c"], "strongest first");
  assert.deepEqual(curatedRules(rules, [0.4, 0.4, 0.4], 0.3).map(entry => entry.id), ["a", "b", "c"], "ties keep file order");
  assert.deepEqual(curatedRules(rules, [0.9, 0.8, 0.7], 0.3).map(entry => entry.id), ["a", "b", "c"], "at most three rules are named");
  assert.equal(formatCuratedRules(named), "Rules that apply to this request:\n- A: a\n- C: c");
  assert.equal(formatCuratedRules([]), "", "no rule applies, no message");
});

test("the ledger counts requests, rules, failures, and the latency percentiles", () => {
  const ledger = new CuratorLedger();
  assert.equal(formatCurator(ledger.snapshot()), "Rules at turn start: no requests yet this session.");
  ledger.sent(100);
  ledger.added(2);
  ledger.sent(300);
  ledger.added(0);
  ledger.failed();
  const snapshot = ledger.snapshot();
  assert.deepEqual({ requests: snapshot.requests, rulesAdded: snapshot.rulesAdded, failures: snapshot.failures, empty: snapshot.empty }, { requests: 2, rulesAdded: 2, failures: 1, empty: 1 });
  assert.equal(curatorPercentile(snapshot.ms, 0.5), 100);
  assert.equal(curatorPercentile(snapshot.ms, 0.9), 300);
  assert.match(formatCurator(snapshot), /2 rules added over 2 requests; 1 with none applying; latency p50 100 ms, p90 300 ms; 1 failed \(nothing was added\)/);
  ledger.reset();
  assert.equal(ledger.snapshot().requests, 0);
});
