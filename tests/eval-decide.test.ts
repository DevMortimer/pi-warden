import assert from "node:assert/strict";
import { test } from "node:test";
import {
  binomUpperTail,
  bootstrap,
  clopperPearsonLower,
  costPairs,
  countDiscordant,
  decisionA,
  decisionB,
  decisionC,
  decisionD,
  deltaLogRatioBounds,
  mcnemarP,
  metricsRows,
  pairRuns,
  poolComparisons,
  rateRatio,
  rateRatioLower,
  runValues,
  runsFromMetrics,
  successBounds,
  successDiffEstimate,
  thesisDecide,
  tokenSummary,
  waldBounds,
} from "../eval/decide.mjs";
import { metricRuns } from "../eval/batch.mjs";
import type { DecideRun, Pair } from "../eval/decide.mjs";

type Cell = "control" | "warden-offline" | "warden";

function run(
  task: string,
  repeat: number,
  cell: Cell,
  o: { s?: boolean; v?: boolean; c?: number | null; timedOut?: boolean; error?: boolean; family?: string } = {},
): DecideRun {
  const { s = true, v = false, c = 1, timedOut = false, error = false, family } = o;
  const r: DecideRun = { task, repeat, cell, outcome: { allChecksPass: s, violationCount: v ? 1 : 0 } };
  if (timedOut) r.timedOut = true;
  if (error) r.error = "boom";
  if (c !== null) r.cost = { usd: c };
  if (family !== undefined) r.family = family;
  return r;
}

function pair(
  task: string,
  xs: { s?: boolean; v?: boolean; c?: number | null; family?: string },
  ys: { s?: boolean; v?: boolean; c?: number | null; family?: string },
): Pair {
  const p: Pair = { task, repeat: 1, x: run(task, 1, "warden", xs), y: run(task, 1, "control", ys) };
  if (xs.family !== undefined) p.family = xs.family;
  return p;
}

function violPairs(n11: number, n10: number, n01: number): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < n11; i++) out.push(pair(`both${i}`, { v: true }, { v: true }));
  for (let i = 0; i < n10; i++) out.push(pair(`xonly${i}`, { v: true }, { v: false }));
  for (let i = 0; i < n01; i++) out.push(pair(`yonly${i}`, { v: false }, { v: true }));
  return out;
}

function costPairsOf(n: number, cx: (i: number) => number, cy: (i: number) => number): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) out.push(pair(`c${i}`, { c: cx(i) }, { c: cy(i) }));
  return out;
}

function successPairs(up: number, down: number): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < up; i++) out.push(pair(`up${i}`, { s: true }, { s: false }));
  for (let i = 0; i < down; i++) out.push(pair(`down${i}`, { s: false }, { s: true }));
  return out;
}

function blockRuns(
  blocks: number,
  spec: (i: number, cell: Cell) => { s?: boolean; v?: boolean; c?: number | null },
): DecideRun[] {
  const out: DecideRun[] = [];
  for (let i = 1; i <= blocks; i++) {
    for (const cell of ["control", "warden-offline", "warden"] as Cell[]) out.push(run(`t${i}`, 1, cell, spec(i, cell)));
  }
  return out;
}

// ---- the exact tests ------------------------------------------------------------------------

test("the exact McNemar p is the binomial lower tail of the discordant pairs", () => {
  assert.equal(mcnemarP(0, 7), 1 / 128);
  assert.equal(mcnemarP(1, 10), 11 / 1024);
  assert.equal(mcnemarP(0, 0), 1);
});

test("the one-sided Clopper-Pearson lower bound solves the binomial tail", () => {
  assert.equal(clopperPearsonLower(0, 3), 0);
  assert.ok(Math.abs(clopperPearsonLower(3, 3) - Math.pow(0.05, 1 / 3)) < 1e-12);
  assert.ok(Math.abs(clopperPearsonLower(1, 10) - (1 - Math.pow(0.95, 1 / 10))) < 1e-12);
  for (const [x, n] of [[2, 5], [5, 10], [1, 3], [7, 9], [1, 100]] as const) {
    const p = clopperPearsonLower(x, n);
    assert.ok(Math.abs(binomUpperTail(x, n, p) - 0.05) < 1e-9, `tail ${x}/${n} at ${p}`);
  }
});

test("the rate-ratio lower bound refutes (b) when only the warden run has a violation", () => {
  assert.ok(Math.abs(rateRatioLower(0, 3, 0)! - 0.5833) < 5e-5);
  assert.equal(decisionB(violPairs(0, 3, 0)).decision, "refuted");
});

test("no violation in either cell is an undefined ratio and an inconclusive rule", () => {
  assert.equal(rateRatio(0, 0, 0), undefined);
  assert.equal(rateRatioLower(0, 0, 0), undefined);
  assert.equal(decisionB(violPairs(0, 0, 0)).decision, "inconclusive");
});

test("the rate-ratio bound is 1 when no pair is discordant but both cells have a violation", () => {
  assert.equal(rateRatio(2, 0, 0), 1);
  assert.equal(rateRatioLower(2, 0, 0), 1);
  const decision = decisionB(violPairs(2, 0, 0));
  assert.equal(decision.rateRatio, 1);
  assert.equal(decision.p, 1);
  assert.equal(decision.lower, 1);
  assert.equal(decision.decision, "refuted");
});

test("a timed-out or errored run counts as not finished", () => {
  assert.deepEqual(runValues(run("t", 1, "warden", { s: true, v: true, timedOut: true })), { s: 0, v: 0, c: 1 });
  assert.deepEqual(runValues(run("t", 1, "warden", { s: true, v: true, error: true })), { s: 0, v: 0, c: 1 });
  assert.deepEqual(runValues(run("t", 1, "warden", { s: false, v: false })), { s: 0, v: 0, c: 1 });
  assert.deepEqual(runValues(run("t", 1, "warden", { s: true, v: true })), { s: 1, v: 1, c: 1 });
});

test("a run without a numeric cost leaves its pair out of (c) only", () => {
  const runs = [
    run("t1", 1, "warden", { c: 1 }), run("t1", 1, "control", { c: 2 }), run("t1", 1, "warden-offline", { c: 1 }),
    run("t2", 1, "warden", { c: null }), run("t2", 1, "control", { c: 2 }), run("t2", 1, "warden-offline", { c: 1 }),
    run("t3", 1, "warden", { c: 1 }), run("t3", 1, "control", { c: null }), run("t3", 1, "warden-offline", { c: 1 }),
  ];
  const pairs = pairRuns(runs, "warden", "control");
  assert.equal(pairs.length, 3);
  assert.equal(costPairs(pairs).length, 1);
  assert.equal(pairs.length - costPairs(pairs).length, 2);
});

test("pairRuns sorts the blocks by repeat and then by task id", () => {
  const runs = [
    run("tb", 2, "warden"), run("tb", 2, "control"), run("ta", 1, "warden"), run("ta", 1, "control"),
    run("tb", 1, "warden"), run("tb", 1, "control"), run("ta", 2, "warden"), run("ta", 2, "control"),
  ];
  const pairs = pairRuns(runs, "warden", "control");
  assert.deepEqual(pairs.map((p) => `${p.task} r${p.repeat}`), ["ta r1", "tb r1", "ta r2", "tb r2"]);
});

test("the paired bootstrap is deterministic and uses the registered order statistics", () => {
  const pairs = successPairs(2, 1);
  const first = bootstrap(pairs, successDiffEstimate);
  const again = bootstrap(pairs, successDiffEstimate);
  assert.deepEqual(first, again);
  assert.equal(first.lower, first.sorted[999]);
  assert.equal(first.upper, first.sorted[18999]);
  assert.equal(first.sorted.length, 20000);
  const equal = bootstrap([pair("e1", { s: true }, { s: true }), pair("e2", { s: true }, { s: true })], successDiffEstimate);
  assert.equal(equal.lower, 0);
  assert.equal(equal.upper, 0);
});

test("rule (a) reaches supported, refuted, and inconclusive", () => {
  assert.equal(decisionA(successPairs(4, 0)).decision, "supported");
  assert.equal(decisionA(successPairs(0, 4)).decision, "refuted");
  assert.equal(decisionA(successPairs(10, 10)).decision, "inconclusive");
});

test("rule (b) reaches supported, refuted, and inconclusive", () => {
  assert.equal(decisionB(violPairs(0, 0, 10)).decision, "supported");
  assert.equal(decisionB(violPairs(0, 10, 0)).decision, "refuted");
  assert.equal(decisionB(violPairs(0, 1, 1)).decision, "inconclusive");
});

test("rule (c) reaches supported, refuted, and inconclusive", () => {
  assert.equal(decisionC(costPairsOf(6, () => 1, () => 2)).decision, "supported");
  assert.equal(decisionC(costPairsOf(6, () => 2, () => 1)).decision, "refuted");
  const mixed = costPairsOf(20, (i) => (i < 10 ? 0.1 : 1.9), () => 1);
  assert.equal(decisionC(mixed).decision, "inconclusive");
});

test("rule (d) supports on either branch and refutes only when both conditions hold", () => {
  assert.equal(decisionD(successPairs(4, 0)).decision, "supported");
  assert.equal(decisionD(violPairs(0, 0, 10)).decision, "supported");
  const refuted = violPairs(0, 10, 0).map((p) => pair(p.task, { v: true, s: false }, { v: false, s: true }));
  assert.equal(decisionD(refuted).decision, "refuted");
  const half = [
    ...violPairs(0, 10, 0).map((p) => pair(p.task, { v: true, s: true }, { v: false, s: false })),
    ...violPairs(0, 10, 0).map((p) => pair(`${p.task}x`, { v: true, s: false }, { v: false, s: true })),
  ];
  assert.notEqual(decisionD(half).decision, "refuted");
});

test("the Wald and delta-method sensitivity bounds are finite and ordered", () => {
  const mixed = successPairs(10, 10);
  const wald = waldBounds(mixed);
  assert.ok(Number.isFinite(wald.lower) && Number.isFinite(wald.upper));
  assert.ok(wald.lower < wald.upper);
  const costs = costPairsOf(12, (i) => 1 + (i % 3), (i) => 1 + ((i + 1) % 3));
  const delta = deltaLogRatioBounds(costs);
  assert.ok(Number.isFinite(delta.lower) && Number.isFinite(delta.upper));
  assert.ok(delta.lower! < delta.upper!);
});

test("the model is proven, refuted, or reported part by part", () => {
  const proven = blockRuns(6, (i, cell) => {
    if (cell === "warden") return { s: true, v: false, c: 1 };
    if (cell === "control") return { s: false, v: true, c: 2 };
    return { s: false, v: false, c: 1 };
  });
  assert.equal(thesisDecide({ runs: proven, plannedBlocks: 6 }).model, "proven");

  const refuted = blockRuns(6, (i, cell) => {
    if (cell === "warden") return { s: false, v: false, c: 1 };
    return { s: true, v: false, c: 1 };
  });
  assert.equal(thesisDecide({ runs: refuted, plannedBlocks: 6 }).model, "refuted");

  const part = blockRuns(20, (i, cell) => {
    if (cell === "warden") return { s: true, v: i === 1, c: i <= 10 ? 0.1 : 1.9 };
    if (cell === "control") return { s: false, v: i === 2, c: 1 };
    return { s: true, v: false, c: 1 };
  });
  assert.equal(thesisDecide({ runs: part, plannedBlocks: 20 }).model, "part");
});

test("a metrics file rebuilds the same decisions as the runs", () => {
  const runs: DecideRun[] = [
    run("t1", 1, "warden", { s: true, v: false, c: 1, family: "rules" }),
    run("t1", 1, "control", { s: false, v: true, c: 2, family: "rules" }),
    run("t1", 1, "warden-offline", { s: true, v: false, c: 1.5, family: "rules" }),
    run("t2", 1, "warden", { s: true, v: true, c: 3, family: "decay" }),
    run("t2", 1, "control", { s: true, v: true, c: 4, family: "decay" }),
    run("t2", 1, "warden-offline", { s: false, v: false, c: 2, family: "decay" }),
    run("t3", 1, "warden", { s: true, v: false, c: 1 }),
    run("t3", 1, "control", { s: true, v: false, c: null }),
    run("t3", 1, "warden-offline", { s: true, v: false, c: 1 }),
    run("t4", 1, "warden", { s: true, v: true, c: 1, timedOut: true, family: "rules" }),
    run("t4", 1, "control", { s: true, v: true, c: 2, family: "rules" }),
    run("t4", 1, "warden-offline", { s: true, v: true, c: 1, family: "rules" }),
    run("t5", 1, "warden", { s: true, v: true, c: 1, error: true, family: "decay" }),
    run("t5", 1, "control", { s: true, v: true, c: 2, family: "decay" }),
    run("t5", 1, "warden-offline", { s: true, v: true, c: 1, family: "decay" }),
  ];
  const direct = thesisDecide({ runs, plannedBlocks: 5 });
  const rebuilt = thesisDecide({ runs: runsFromMetrics(metricsRows(metricRuns(runs))), plannedBlocks: 5 });
  assert.deepEqual(rebuilt.rules, direct.rules);
  assert.deepEqual(rebuilt.sensitivity, direct.sensitivity);
  assert.deepEqual(rebuilt.secondary, direct.secondary);
  assert.deepEqual(rebuilt.pairs, direct.pairs);
});

// ---- the pooled thesis claims (post hoc, deciding nothing) -----------------------------------

function tokenRun(task: string, cell: Cell, tokens: number): DecideRun {
  return { task, repeat: 1, cell, outcome: { allChecksPass: true, violationCount: 0 }, waste: { totalTokens: tokens } };
}

test("metricsRows writes the hallucination flag h and the token count t", () => {
  const runs: DecideRun[] = [
    { task: "t1", repeat: 1, cell: "warden", outcome: { allChecksPass: true, violationCount: 0, unverifiedDoneClaim: true }, waste: { totalTokens: 123 } },
    { task: "t1", repeat: 1, cell: "control", outcome: { allChecksPass: true, violationCount: 0 }, contradicted: [{ id: "x", sentence: "y" }], waste: { totalTokens: 456 } },
    { task: "t2", repeat: 1, cell: "warden", outcome: { allChecksPass: true, violationCount: 0 }, waste: { totalTokens: 789 } },
    { task: "t2", repeat: 1, cell: "control", outcome: { allChecksPass: true, violationCount: 0 } },
  ];
  const key = (r: { task: string; cell: string }) => `${r.task}|${r.cell}`;
  const expected = new Map<string, [number, number | null]>([
    ["t1|warden", [1, 123]], ["t1|control", [1, 456]], ["t2|warden", [0, 789]], ["t2|control", [0, null]],
  ]);
  const rows = metricsRows(metricRuns(runs));
  for (const row of rows) assert.deepEqual([row.h, row.t], expected.get(key(row)));
  const rebuilt = runsFromMetrics(rows);
  for (const row of metricsRows(rebuilt)) assert.deepEqual([row.h, row.t], expected.get(key(row)));
  const values = new Map(rebuilt.map((r) => [key(r), runValues(r)]));
  for (const run of runs) assert.deepEqual(values.get(key(run)), runValues(run));
});

test("poolComparisons matches the hand-concatenated pairs and keeps two models' equal blocks apart", () => {
  // Both models hold a t1 r1 block: combining the runs before pairing would merge them into one pair.
  const a: DecideRun[] = [
    run("t1", 1, "warden", { v: true, s: true }),
    run("t1", 1, "control", { v: false, s: false }),
    run("t2", 1, "warden", { v: false, s: true }),
    run("t2", 1, "control", { v: false, s: true }),
  ];
  const b: DecideRun[] = [
    run("t1", 1, "warden", { v: false, s: true }),
    run("t1", 1, "control", { v: true, s: true }),
    run("t3", 1, "warden", { v: true, s: false }),
    run("t3", 1, "control", { v: false, s: true }),
  ];
  const models = [{ label: "A", runs: a }, { label: "B", runs: b }];
  const pooled = poolComparisons(models, "warden", "control");
  const concatenated = [...pairRuns(a, "warden", "control"), ...pairRuns(b, "warden", "control")];
  const counts = countDiscordant(concatenated);
  assert.equal(pooled.pairs, 4, "two pairs per model, not the three blocks of the combined runs");
  assert.deepEqual([pooled.n11, pooled.n10, pooled.n01, pooled.n00, pooled.D], [counts.n11, counts.n10, counts.n01, counts.n00, counts.D]);
  assert.deepEqual(pooled.success, successBounds(concatenated));
  assert.equal(pooled.rateRatio, rateRatio(counts.n11, counts.n10, counts.n01));
  assert.equal(pooled.lower, rateRatioLower(counts.n11, counts.n10, counts.n01));
  assert.equal(pooled.p, mcnemarP(counts.n10, counts.D));
  assert.deepEqual(pooled.byModel.map((m) => [m.label, m.pairs]), [["A", 2], ["B", 2]]);
});

test("tokenSummary gives the median, the 90th percentile, the over-threshold count, and the paired ratio", () => {
  const controlTokens = [20, 20, 20, 20];
  const wardenTokens = [10, 20, 40, 80];
  const offlineTokens = [100, 200, 300, 400];
  const runs: DecideRun[] = [];
  for (let i = 0; i < 4; i++) {
    runs.push(tokenRun(`t${i + 1}`, "control", controlTokens[i]!));
    runs.push(tokenRun(`t${i + 1}`, "warden", wardenTokens[i]!));
    runs.push(tokenRun(`t${i + 1}`, "warden-offline", offlineTokens[i]!));
  }
  const summary = tokenSummary([{ label: "M", runs }], { threshold: 30 });
  assert.equal(summary.cells.control!.median, 20);
  assert.equal(summary.cells.control!.p90, 20);
  assert.equal(summary.cells.control!.over, 0);
  assert.equal(summary.cells.warden!.median, 40);
  assert.equal(summary.cells.warden!.p90, 80);
  assert.equal(summary.cells.warden!.over, 2);
  assert.equal(summary.cells["warden-offline"]!.median, 300);
  assert.equal(summary.cells["warden-offline"]!.p90, 400);
  assert.equal(summary.cells["warden-offline"]!.over, 4);
  // Paired warden/control: 0.5, 1, 2, 4; one pair used fewer, geometric mean sqrt(2).
  assert.equal(summary.pairs.pooled.n, 4);
  assert.equal(summary.pairs.pooled.fewer, 1);
  assert.ok(Math.abs(summary.pairs.pooled.ratio! - Math.SQRT2) < 1e-12);
});
