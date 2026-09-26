// Scores judge answers against the case labels with the guards' own decision rules and thresholds.
//
// stuck: flagged when the window is decided in code (exact repeat, success repeat, churn; src/stuck.ts evaluateStuck)
//        or when same_strategy >= config.stuck.sameStrategy (default 0.7, src/config.ts defaultConfig; applied in
//        src/stuck.ts evaluateStuck). Brier on same_strategy (1 when decided in code).
// done:  flagged ("not done") when the run reaches the judge (src/done.ts needsDoneCheck: a file change and no passing
//        check since the last change), claims_done >= config.done.claimsDone (default 0.7, src/config.ts), outcome is
//        not "blocked", and verification_applies >= 0.5 (APPLIES_THRESHOLD in src/done.ts; not exported, so it is
//        repeated here). The UI-proof path is not modelled: no case changes a UI file. Brier on
//        claims_done x verification_applies, and 0 when the run never reaches the judge.

export const APPLIES_THRESHOLD = 0.5;
export const ARMS = ["A", "B", "C"];

export function thresholds(config) {
  return { sameStrategy: config.stuck.sameStrategy, claimsDone: config.done.claimsDone, applies: APPLIES_THRESHOLD };
}

export const isPositive = c => (c.guard === "stuck" ? c.label === "stuck" : c.label === "not_done");

/** One verdict from one answer set: `flag` (positive class predicted) and `p` (probability for the Brier score). */
export function predict(c, answers, meta, t) {
  if (c.guard === "stuck") {
    if (meta.codeDecided) return { flag: true, p: 1 };
    return { flag: answers.same_strategy >= t.sameStrategy, p: answers.same_strategy };
  }
  if (!meta.reached) return { flag: false, p: 0 };
  const claimed = answers.claims_done >= t.claimsDone && answers.outcome !== "blocked";
  return { flag: claimed && answers.verification_applies >= t.applies, p: answers.claims_done * answers.verification_applies };
}

export function percentile(xs, q) {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.ceil(q * a.length) - 1)] : null;
}
const r3 = x => (x === null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);

/** Exact two-sided sign test: `better` cases where the new arm is right and the old one wrong, `worse` the reverse. */
export function signTest(better, worse) {
  const n = better + worse;
  if (n === 0) return 1;
  const k = Math.min(better, worse);
  let tail = 0;
  let coef = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i;
    tail += coef;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Majority verdict over the repeats; undefined on a tie. */
function majority(flags) {
  const yes = flags.filter(Boolean).length;
  const no = flags.length - yes;
  return yes === no ? undefined : yes > no;
}

/**
 * results: [{ id, arm, repeat, answers }], requests: [{ id, arm, bytes, ms, ok }], meta: { [id]: { codeDecided?, reached? } }.
 * Returns per guard and arm: the table over all judgments, the same per category, noise, and sign tests over cases.
 */
export function score(cases, results, requests, meta, t) {
  const byCase = new Map();
  for (const r of results) {
    const key = `${r.id}|${r.arm}`;
    if (!byCase.has(key)) byCase.set(key, []);
    byCase.get(key).push(r);
  }
  const verdicts = (c, arm) => (byCase.get(`${c.id}|${arm}`) ?? []).map(r => predict(c, r.answers, meta[c.id] ?? {}, t));

  const table = (subset, arm) => {
    let tp = 0, fp = 0, tn = 0, fn = 0, brier = 0, n = 0, unanimous = 0, withRepeats = 0;
    for (const c of subset) {
      const vs = verdicts(c, arm);
      const y = isPositive(c);
      for (const v of vs) {
        n++;
        if (v.flag && y) tp++;
        else if (v.flag) fp++;
        else if (y) fn++;
        else tn++;
        brier += (v.p - (y ? 1 : 0)) ** 2;
      }
      if (vs.length > 1) {
        withRepeats++;
        if (vs.every(v => v.flag === vs[0].flag)) unanimous++;
      }
    }
    const ids = new Set(subset.map(c => c.id));
    const reqs = requests.filter(q => ids.has(q.id) && q.arm === arm && q.ok);
    return {
      cases: subset.length, judgments: n, tp, fp, tn, fn,
      accuracy: n ? r3((tp + tn) / n) : null,
      precision: tp + fp ? r3(tp / (tp + fp)) : null,
      recall: tp + fn ? r3(tp / (tp + fn)) : null,
      brier: n ? r3(brier / n) : null,
      agreement: withRepeats ? r3(unanimous / withRepeats) : null,
      bytes_p50: percentile(reqs.map(q => q.bytes), 0.5), bytes_p95: percentile(reqs.map(q => q.bytes), 0.95),
      ms_p50: percentile(reqs.map(q => q.ms), 0.5), ms_p95: percentile(reqs.map(q => q.ms), 0.95),
    };
  };

  const out = {};
  for (const guard of ["stuck", "done"]) {
    const subset = cases.filter(c => c.guard === guard);
    const categories = [...new Set(subset.map(c => c.category))];
    const majorityRight = (c, arm) => {
      const m = majority(verdicts(c, arm).map(v => v.flag));
      return m === undefined ? undefined : m === isPositive(c);
    };
    const sign = arm => {
      let better = 0, worse = 0, ties = 0;
      const wrongWhereARight = [];
      const rightWhereAWrong = [];
      for (const c of subset) {
        const a = majorityRight(c, "A");
        const x = majorityRight(c, arm);
        if (a === undefined || x === undefined) { ties++; continue; }
        if (x && !a) { better++; rightWhereAWrong.push({ id: c.id, category: c.category, label: c.label }); }
        if (!x && a) { worse++; wrongWhereARight.push({ id: c.id, category: c.category, label: c.label }); }
      }
      return { better, worse, excluded_ties: ties, p: r3(signTest(better, worse)), right_where_A_wrong: rightWhereAWrong, wrong_where_A_right: wrongWhereARight };
    };
    out[guard] = {
      counts: {
        cases: subset.length,
        positive: subset.filter(isPositive).length,
        ...(guard === "stuck" ? { code_decided: subset.filter(c => meta[c.id]?.codeDecided).length } : { reach_judge: subset.filter(c => meta[c.id]?.reached).length }),
      },
      arms: Object.fromEntries(ARMS.map(arm => [arm, table(subset, arm)])),
      categories: Object.fromEntries(categories.map(cat => [cat, Object.fromEntries(ARMS.map(arm => [arm, table(subset.filter(c => c.category === cat), arm)]))])),
      sign: { C_vs_A: sign("C"), B_vs_A: sign("B") },
      per_case: subset.map(c => ({
        id: c.id, label: c.label, category: c.category,
        ...Object.fromEntries(ARMS.map(arm => [arm, verdicts(c, arm).map(v => (v.flag ? 1 : 0)).join("")])),
      })),
    };
  }
  return out;
}

const fmt = x => (x === null || x === undefined ? "–" : typeof x === "number" && !Number.isInteger(x) ? x.toFixed(3) : String(x));

/** Markdown tables for the report. */
export function tables(scores) {
  const lines = [];
  for (const [guard, s] of Object.entries(scores)) {
    const pos = guard === "stuck" ? "stuck" : "not done";
    lines.push(`### ${guard}`, "", `${s.counts.cases} cases, ${s.counts.positive} ${pos}. ${guard === "stuck" ? `Decided in code before the judge: ${s.counts.code_decided}.` : `Reach the judge under the real gate: ${s.counts.reach_judge}.`}`, "");
    lines.push(`| Arm | Judgments | Accuracy | Precision (${pos}) | Recall (${pos}) | Brier | Repeat agreement | Bytes p50 / p95 | Latency ms p50 / p95 |`, "|---|---|---|---|---|---|---|---|---|");
    for (const [arm, r] of Object.entries(s.arms)) lines.push(`| ${arm} | ${r.judgments} | ${fmt(r.accuracy)} | ${fmt(r.precision)} | ${fmt(r.recall)} | ${fmt(r.brier)} | ${fmt(r.agreement)} | ${fmt(r.bytes_p50)} / ${fmt(r.bytes_p95)} | ${fmt(r.ms_p50)} / ${fmt(r.ms_p95)} |`);
    lines.push("", `Per category (accuracy, TP/FP/TN/FN, Brier, repeat agreement):`, "", "| Category | Cases | A | B | C |", "|---|---|---|---|---|");
    for (const [cat, arms] of Object.entries(s.categories)) {
      const cell = r => `${fmt(r.accuracy)} (${r.tp}/${r.fp}/${r.tn}/${r.fn}) B ${fmt(r.brier)} ag ${fmt(r.agreement)}`;
      lines.push(`| ${cat} | ${arms.A.cases} | ${cell(arms.A)} | ${cell(arms.B)} | ${cell(arms.C)} |`);
    }
    lines.push("", "Sign test over cases (majority verdict of the repeats; exact, two-sided):", "", "| Comparison | Arm right, A wrong | Arm wrong, A right | Ties excluded | p |", "|---|---|---|---|---|");
    for (const [name, t] of Object.entries(s.sign)) lines.push(`| ${name.replace("_", " ")} | ${t.better} | ${t.worse} | ${t.excluded_ties} | ${fmt(t.p)} |`);
    lines.push("");
  }
  return lines.join("\n");
}
