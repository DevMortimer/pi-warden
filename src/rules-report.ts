import type { RuleRecord } from "./rules-log.js";

/**
 * Pure report over the local rules records: for each rule, how often it was judged, how often it fired, how often a
 * fired rule was cleared on a later edit, and the mean violation score, with a flag for the rules worth a look. It also
 * lists the rules in the current rule set with no records. Nothing here reads or sends anything; the caller supplies
 * the records and the current rule list, so a later CLI can reuse the same function.
 */

export type RuleFlag = "never fires" | "fires on everything" | "undecided";

export interface RuleReportRow {
  id: string;
  name: string;
  judged: number;
  fired: number;
  /** fired / judged. */
  firedRate: number;
  /** Number of judgments that cleared an earlier finding on the same path. */
  cleared: number;
  meanViolation: number;
  flags: RuleFlag[];
}

export interface RulesReport {
  rows: RuleReportRow[];
  /** Rules in the current rule set with no records in the window. */
  unheard: Array<{ id: string; name: string }>;
  days: number;
  since: number;
  until: number;
  /** Records inside the window. */
  records: number;
}

/** Which records count: live verdicts (no `source` field), history replays (`source: "calibrate"`), or both. */
export type ReportSource = "live" | "calibrate" | "all";

export const REPORT_DEFAULT_DAYS = 30;
/** A rule with this many judgments and no fire is flagged `never fires`. */
export const NEVER_FIRES_MIN = 20;
/** A fired rate above this is flagged `fires on everything`. */
export const FIRES_RATE_MAX = 0.5;
export const UNDECIDED_LOW = 0.3;
export const UNDECIDED_HIGH = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

const FLAG_RANK: Record<RuleFlag, number> = { "fires on everything": 0, undecided: 1, "never fires": 2 };

function worstRank(row: RuleReportRow): number {
  return row.flags.length ? Math.min(...row.flags.map(flag => FLAG_RANK[flag])) : 3;
}

/** Worst first: a noisy rule, then an undecided one, then a rule that never fires; ties by fired rate, then volume. */
export function compareRows(a: RuleReportRow, b: RuleReportRow): number {
  return worstRank(a) - worstRank(b)
    || b.firedRate - a.firedRate
    || b.judged - a.judged
    || a.name.localeCompare(b.name);
}

export function buildRulesReport(
  records: readonly RuleRecord[],
  options: { days?: number; now?: number; currentRules?: readonly { id: string; name: string }[]; source?: ReportSource } = {},
): RulesReport {
  const days = options.days ?? REPORT_DEFAULT_DAYS;
  const until = options.now ?? Date.now();
  const since = until - days * DAY_MS;
  const wanted = options.source ?? "all";
  const inWindow = records.filter(record => {
    if (wanted === "live" && record.source === "calibrate") return false;
    if (wanted === "calibrate" && record.source !== "calibrate") return false;
    const at = Date.parse(record.at);
    return Number.isFinite(at) && at >= since && at <= until;
  });
  const groups = new Map<string, RuleRecord[]>();
  for (const record of inWindow) {
    const list = groups.get(record.id);
    if (list) list.push(record);
    else groups.set(record.id, [record]);
  }
  const rows: RuleReportRow[] = [];
  for (const [id, list] of groups) {
    const judged = list.length;
    const fired = list.filter(record => record.finding).length;
    const cleared = list.filter(record => record.cleared === true).length;
    const meanViolation = list.reduce((sum, record) => sum + record.violation, 0) / judged;
    const firedRate = fired / judged;
    const middle = list.filter(record => record.violation > UNDECIDED_LOW && record.violation < UNDECIDED_HIGH).length;
    const flags: RuleFlag[] = [];
    if (judged >= NEVER_FIRES_MIN && fired === 0) flags.push("never fires");
    if (firedRate > FIRES_RATE_MAX) flags.push("fires on everything");
    if (middle > judged / 2) flags.push("undecided");
    rows.push({ id, name: list[list.length - 1]!.name, judged, fired, firedRate, cleared, meanViolation, flags });
  }
  rows.sort(compareRows);
  const heard = new Set(rows.map(row => row.id));
  const unheard = (options.currentRules ?? []).filter(rule => !heard.has(rule.id)).map(rule => ({ id: rule.id, name: rule.name }));
  return { rows, unheard, days, since, until, records: inWindow.length };
}

function shortName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length <= 30 ? clean : `${clean.slice(0, 29)}…`;
}

/** One rule per short line; the flags and the no-record list are named after the rows. */
export function formatRulesReport(report: RulesReport): string {
  const window = `last ${report.days} day${report.days === 1 ? "" : "s"}`;
  const lines: string[] = [];
  if (!report.rows.length) {
    lines.push(`Rules report: no judgments in the ${window}.`);
  } else {
    lines.push(`Rules report: ${report.records} judgment${report.records === 1 ? "" : "s"}, ${report.rows.length} rule${report.rows.length === 1 ? "" : "s"}, ${window}.`);
    lines.push("Worst first:");
    report.rows.forEach((row, index) => {
      const firedRate = `${Math.round(row.firedRate * 100)}%`;
      const flag = row.flags.length ? ` · ${row.flags.join(" · ")}` : "";
      lines.push(`${index + 1}. ${shortName(row.name)} · ${row.judged} judged · ${row.fired} fired ${firedRate} · ${row.cleared} cleared · mean ${row.meanViolation.toFixed(2)}${flag}`);
    });
  }
  if (report.unheard.length) {
    lines.push(`No records (${report.unheard.length}): ${report.unheard.map(rule => shortName(rule.name)).join(", ")}.`);
  }
  lines.push("Local log only; nothing is sent.");
  return lines.join("\n");
}
