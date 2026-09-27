// Scoring for the rules bench: recall, false-alarm rate and precision at several cutoffs, AUC per rule,
// the low-band check, the two-tier view, and the per-rule-cutoff and soft-tier views. Soft tier values are
// read from the rules fixture's header lines; no judge and no network.
import { loadRuleHeaders } from "./cases.mjs";
const SPLITS = ["all", "tune", "holdout"];
export const CUTOFFS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
/** The cutoff that steers when a rule carries no `threshold:` header. */
export const RAISE = 0.7;
/** The planned "please double-check" tier sits between these two values. */
export const LOWER = 0.5;
/** The opt-in soft tier: from here up to a rule's cutoff, a score is a double-check, not a finding. */
export const SOFT = 0.5;
/** Clean cases scoring in this band are close to the raise line without crossing it. */
export const LOW_BAND = [0.3, 0.5];
const RULE_SAMPLE = 8;

const pct = value => (value === null || value === undefined ? "–" : value.toFixed(3));
const share = (count, total) => (total ? count / total : null);

/**
 * One row per case that was asked about the target rule: `{ label, violation }`. A case the guard never
 * asked about (a scoped rule on another language) has no row and is counted as `notAsked`.
 */
function rowsFor(cases, saved) {
  const answers = new Map(saved.map(row => [row.id, row]));
  return cases.map(c => {
    const answer = answers.get(c.id);
    const score = answer?.scores?.find(item => item.id === c.rule);
    return {
      id: c.id,
      rule: c.rule,
      label: c.label,
      kind: c.kind,
      split: c.split,
      asked: score !== undefined && score !== null,
      outcome: score?.outcome ?? null,
      violation: score?.violation ?? null,
      ...(answer?.error ? { error: answer.error } : {}),
      ...(answer?.skippedReason ? { skippedReason: answer.skippedReason } : {}),
    };
  });
}

/** Rank-based AUC over the asked cases; ties share the average rank. `null` when a class is empty. */
export function auc(rows) {
  const positives = rows.filter(row => row.label === "violation").map(row => row.violation);
  const negatives = rows.filter(row => row.label === "clean").map(row => row.violation);
  if (!positives.length || !negatives.length) return null;
  const all = [...positives.map(value => ({ value, positive: true })), ...negatives.map(value => ({ value, positive: false }))]
    .sort((a, b) => a.value - b.value);
  let cursor = 0;
  const ranks = new Array(all.length);
  while (cursor < all.length) {
    let end = cursor;
    while (end + 1 < all.length && all[end + 1].value === all[cursor].value) end++;
    const rank = (cursor + end) / 2 + 1;
    for (let index = cursor; index <= end; index++) ranks[index] = rank;
    cursor = end + 1;
  }
  const sum = all.reduce((total, row, index) => total + (row.positive ? ranks[index] : 0), 0);
  return (sum - (positives.length * (positives.length + 1)) / 2) / (positives.length * negatives.length);
}

export function metrics(rows, cutoff) {
  const positives = rows.filter(row => row.label === "violation");
  const negatives = rows.filter(row => row.label === "clean");
  const tp = positives.filter(row => row.violation >= cutoff).length;
  const fn = positives.length - tp;
  const fp = negatives.filter(row => row.violation >= cutoff).length;
  const tn = negatives.length - fp;
  return {
    cutoff,
    tp, fp, tn, fn,
    positives: positives.length,
    negatives: negatives.length,
    recall: positives.length ? tp / positives.length : null,
    falseAlarmRate: negatives.length ? fp / negatives.length : null,
    precision: tp + fp ? tp / (tp + fp) : null,
  };
}

function tier(rows) {
  const positives = rows.filter(row => row.label === "violation");
  const negatives = rows.filter(row => row.label === "clean");
  const inBand = (row, from, to) => row.violation >= from && row.violation < to;
  const raiseTrue = positives.filter(row => row.violation >= RAISE).length;
  const lowerTrue = positives.filter(row => inBand(row, LOWER, RAISE)).length;
  const raiseFalse = negatives.filter(row => row.violation >= RAISE).length;
  const lowerFalse = negatives.filter(row => inBand(row, LOWER, RAISE)).length;
  const missedAtLower = positives.filter(row => row.violation < LOWER).length;
  return {
    raise: RAISE,
    lower: LOWER,
    raiseTrue,
    lowerOnlyTrue: lowerTrue,
    missedAtLower,
    raiseFalse,
    lowerOnlyFalse: lowerFalse,
    recallAtRaise: share(raiseTrue, positives.length),
    recallAtLower: share(raiseTrue + lowerTrue, positives.length),
    addedRecall: share(lowerTrue, positives.length),
    falseAlarmRateAtRaise: share(raiseFalse, negatives.length),
    falseAlarmRateAtLower: share(raiseFalse + lowerFalse, negatives.length),
    addedFalseAlarmRate: share(lowerFalse, negatives.length),
  };
}

/** The rule's own cutoff: its `threshold:` header, else the shipped raise line. */
function effectiveCutoff(rule, headers) {
  const own = headers[rule]?.threshold;
  return typeof own === "number" ? own : RAISE;
}

/** Per rule: the effective cutoff, the score there, and the soft band under it. */
function perRuleEffective(rows, headers) {
  const ids = [...new Set(rows.map(row => row.rule))].sort();
  return ids.map(rule => {
    const own = rows.filter(row => row.rule === rule);
    const positives = own.filter(row => row.label === "violation");
    const negatives = own.filter(row => row.label === "clean");
    const cutoff = effectiveCutoff(rule, headers);
    const tp = positives.filter(row => row.violation >= cutoff).length;
    const fp = negatives.filter(row => row.violation >= cutoff).length;
    return {
      rule,
      severity: headers[rule]?.severity ?? null,
      cutoff,
      recall: share(tp, positives.length),
      falseAlarmRate: share(fp, negatives.length),
      softViolations: positives.filter(row => row.violation >= SOFT && row.violation < cutoff).length,
      softCleans: negatives.filter(row => row.violation >= SOFT && row.violation < cutoff).length,
    };
  });
}

/** The soft tier with each rule's own cutoff: what fires at the cutoff, and what the tier adds below it. */
function softTier(rows, headers) {
  const positives = rows.filter(row => row.label === "violation");
  const negatives = rows.filter(row => row.label === "clean");
  const raised = row => row.violation >= effectiveCutoff(row.rule, headers);
  const soft = row => row.violation >= SOFT && row.violation < effectiveCutoff(row.rule, headers);
  const raiseTrue = positives.filter(raised).length;
  const softTrue = positives.filter(soft).length;
  const raiseFalse = negatives.filter(raised).length;
  const softFalse = negatives.filter(soft).length;
  return {
    soft: SOFT,
    raiseTrue,
    softTrue,
    raiseFalse,
    softFalse,
    missedBelowSoft: positives.filter(row => row.violation < SOFT).length,
    recallAtCutoff: share(raiseTrue, positives.length),
    recallAtSoft: share(raiseTrue + softTrue, positives.length),
    addedRecall: share(softTrue, positives.length),
    falseAlarmAtCutoff: share(raiseFalse, negatives.length),
    falseAlarmAtSoft: share(raiseFalse + softFalse, negatives.length),
    addedFalseAlarm: share(softFalse, negatives.length),
  };
}

function perRule(rows, cuts) {
  const ids = [...new Set(rows.map(row => row.rule))].sort();
  return ids.map(rule => {
    const own = rows.filter(row => row.rule === rule);
    const asked = own.filter(row => row.asked);
    const clean = asked.filter(row => row.label === "clean");
    const lowBand = clean.filter(row => row.violation >= LOW_BAND[0] && row.violation < LOW_BAND[1]).length;
    const at = cutoff => `at${String(cutoff).replace(".", "")}`;
    const row = {
      rule,
      cases: own.length,
      asked: asked.length,
      notAsked: own.length - asked.length,
      violations: asked.filter(item => item.label === "violation").length,
      cleans: clean.length,
      auc: auc(asked),
      lowBandClean: lowBand,
      lowBandShare: share(lowBand, clean.length),
      weak: clean.length > 0 && lowBand > clean.length / 2,
      lowerOnly: { true: 0, false: 0 },
      smallSample: clean.length < RULE_SAMPLE || asked.filter(item => item.label === "violation").length < RULE_SAMPLE / 2,
    };
    for (const cutoff of cuts) row[at(cutoff)] = metrics(asked, cutoff);
    row.lowerOnly.true = asked.filter(item => item.label === "violation" && item.violation >= LOWER && item.violation < RAISE).length;
    row.lowerOnly.false = clean.filter(item => item.violation >= LOWER && item.violation < RAISE).length;
    return row;
  });
}

/** Scores the saved answers: overall per cutoff, per rule, the low band, the two-tier view, the soft tier, and each rule's own cutoff, per split. */
export function score(cases, saved, headers = loadRuleHeaders()) {
  const rows = rowsFor(cases, saved);
  const splits = {};
  for (const split of SPLITS) {
    const own = split === "all" ? rows : rows.filter(row => row.split === split);
    const asked = own.filter(row => row.asked);
    splits[split] = {
      cases: {
        total: own.length,
        violation: own.filter(row => row.label === "violation").length,
        clean: own.filter(row => row.label === "clean").length,
        asked: asked.length,
        notAsked: own.length - asked.length,
        unanswered: asked.filter(row => row.violation === null).length,
        failed: own.filter(row => row.error).length,
        byKind: Object.fromEntries(["violation", "near-miss", "not-applicable"].map(kind => [kind, own.filter(row => row.kind === kind).length])),
      },
      overall: CUTOFFS.map(cutoff => metrics(asked, cutoff)),
      twoTier: tier(asked),
      softTier: softTier(asked, headers),
      effective: perRuleEffective(asked, headers),
      perRule: perRule(own, [LOWER, RAISE]),
      lowBandRules: perRule(own, []).filter(row => row.weak).map(row => row.rule),
    };
  }
  return { cutoffs: CUTOFFS, raise: RAISE, lower: LOWER, soft: SOFT, headers, splits };
}

function overallTable(label, split) {
  const lines = [
    `${label}: ${split.cases.total} cases (${split.cases.violation} violation, ${split.cases.clean} clean: ${split.cases.byKind["near-miss"]} near-miss, ${split.cases.byKind["not-applicable"]} not applicable); asked about the target rule ${split.cases.asked}, not asked ${split.cases.notAsked}`,
    "",
    "| cutoff | tp | fp | tn | fn | recall | false alarm | precision |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const row of split.overall) {
    lines.push(`| ${row.cutoff.toFixed(1)} | ${row.tp} | ${row.fp} | ${row.tn} | ${row.fn} | ${pct(row.recall)} | ${pct(row.falseAlarmRate)} | ${pct(row.precision)} |`);
  }
  return lines.join("\n");
}

function twoTierTable(label, split) {
  const t = split.twoTier;
  return [
    `${label} two-tier: raise at >= ${t.raise}, double-check at ${t.lower} to ${t.raise}`,
    "",
    "| tier | violations flagged | clean flagged | recall | false alarm |",
    "|---|---|---|---|---|",
    `| >= ${t.raise} (raise) | ${t.raiseTrue} | ${t.raiseFalse} | ${pct(t.recallAtRaise)} | ${pct(t.falseAlarmRateAtRaise)} |`,
    `| ${t.lower}–${t.raise} (double-check) | ${t.lowerOnlyTrue} | ${t.lowerOnlyFalse} | ${pct(t.addedRecall)} added | ${pct(t.addedFalseAlarmRate)} added |`,
    `| >= ${t.lower} (either) | ${t.raiseTrue + t.lowerOnlyTrue} | ${t.raiseFalse + t.lowerOnlyFalse} | ${pct(t.recallAtLower)} | ${pct(t.falseAlarmRateAtLower)} |`,
    "",
    `The lower tier adds ${t.lowerOnlyTrue} violations (${pct(t.addedRecall)} of all violations) and ${t.lowerOnlyFalse} false alarms (${pct(t.addedFalseAlarmRate)} of all clean cases). ${t.missedAtLower} violations stay below ${t.lower}.`,
  ].join("\n");
}

function softTierTable(label, split) {
  const t = split.softTier;
  return [
    `${label} soft tier (each rule's own cutoff, soft from ${SOFT})`,
    "",
    "| tier | violations flagged | clean flagged | recall | false alarm |",
    "|---|---|---|---|---|",
    `| at each rule's cutoff | ${t.raiseTrue} | ${t.raiseFalse} | ${pct(t.recallAtCutoff)} | ${pct(t.falseAlarmAtCutoff)} |`,
    `| ${SOFT} to the cutoff (soft) | ${t.softTrue} | ${t.softFalse} | ${pct(t.addedRecall)} added | ${pct(t.addedFalseAlarm)} added |`,
    `| ${SOFT} and above (either) | ${t.raiseTrue + t.softTrue} | ${t.raiseFalse + t.softFalse} | ${pct(t.recallAtSoft)} | ${pct(t.falseAlarmAtSoft)} |`,
    "",
    `The soft tier adds ${t.softTrue} violations (${pct(t.addedRecall)}) and ${t.softFalse} false alarms (${pct(t.addedFalseAlarm)}). ${t.missedBelowSoft} violations stay below ${SOFT}.`,
  ].join("\n");
}

function effectiveTable(label, split) {
  const lines = [
    `${label} per-rule cutoff (a rule's own \`threshold:\` header, else ${RAISE}) and its soft band`,
    "",
    "| rule | severity | cutoff | recall@cutoff | FA@cutoff | soft violations | soft cleans |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of split.effective) {
    lines.push(`| ${row.rule} | ${row.severity ?? "normal"} | ${row.cutoff.toFixed(1)} | ${pct(row.recall)} | ${pct(row.falseAlarmRate)} | ${row.softViolations} | ${row.softCleans} |`);
  }
  return lines.join("\n");
}

function perRuleTable(label, split) {
  const lines = [
    `${label} per rule (case counts, AUC over the asked cases, recall and false alarm at both cutoffs, clean cases in the ${LOW_BAND[0]}–${LOW_BAND[1]} band)`,
    "",
    "| rule | cases | asked | not asked | v | clean | AUC | recall@0.7 | FA@0.7 | recall@0.5 | FA@0.5 | lower tier t/f | clean in band |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of split.perRule) {
    lines.push(`| ${row.rule} | ${row.cases} | ${row.asked} | ${row.notAsked} | ${row.violations} | ${row.cleans} | ${pct(row.auc)} | ${pct(row.at07.recall)} | ${pct(row.at07.falseAlarmRate)} | ${pct(row.at05.recall)} | ${pct(row.at05.falseAlarmRate)} | ${row.lowerOnly.true}/${row.lowerOnly.false} | ${row.lowBandClean}${row.smallSample ? " (thin)" : ""} |`);
  }
  return lines.join("\n");
}

/** The printed form of a scored run: overall tables, the two-tier view and the per-rule tables. */
export function tables(scores) {
  const out = [];
  for (const split of SPLITS) {
    const own = scores.splits[split];
    out.push(overallTable(split, own));
    out.push("");
    out.push(twoTierTable(split, own));
    out.push("");
    out.push(softTierTable(split, own));
    out.push("");
    out.push(effectiveTable(split, own));
    out.push("");
    out.push(perRuleTable(split, own));
    out.push("");
    out.push(`Rules with more than half of their asked clean cases in ${LOW_BAND[0]}–${LOW_BAND[1]} (${split}): ${own.lowBandRules.length ? own.lowBandRules.join(", ") : "none"}`);
    out.push("");
  }
  return out.join("\n");
}
