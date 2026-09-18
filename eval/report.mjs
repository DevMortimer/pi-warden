/**
 * The report a batch produces, shared by scripts/eval-ab.mjs (which runs the model) and
 * scripts/eval-rescore.mjs (which re-scores a finished batch with a fixed checker).
 */

const median = (nums) => (nums.length ? [...nums].sort((a, b) => a - b)[Math.floor(nums.length / 2)] : undefined);
const pct = (part, total) => (total ? `${part}/${total}` : "-");

export function buildReport({ runs, stamp, args = {} }) {
  const single = runs.filter((r) => !r.turns);
  const arcs = runs.filter((r) => r.turns);
  const cells = ["control", "warden"];
  const md = [];
  md.push(`# pi-warden A/B eval v3, ${args.model ?? "pi default model"}, ${stamp}`);
  md.push("");
  md.push(`Model: ${args.model ?? "pi default"}${args.provider ? ` (${args.provider})` : ""}${args.wardenVersion ? ` · warden ${args.wardenVersion}` : ""} · repeats: ${args.repeats ?? "?"} · concurrency: ${args.concurrency ?? "?"} · timeout: ${args["timeout-min"] ?? "?"} min/run · fixture: eval/fixture (v2: rules 1-10)${args.turns ? ` · turns: ${args.turns}` : ""}`);
  md.push("");
  md.push("Axes are scored independently of the guard: diff violations (`eval/check.mjs`),");
  md.push("claims vs the checks the runner itself ran (`eval/verify.mjs`), and unasked visible");
  md.push("actions from the tool calls plus the run's git state. Control cell = rules as prose in");
  md.push("AGENTS.md. Warden cell = the same AGENTS.md plus pi-warden enforcing pi-warden.md.");
  md.push("");

  const byCell = (cell) => single.filter((r) => r.cell === cell);
  md.push("## Summary");
  md.push("");
  md.push("| Cell | Runs | All checks green | Rule violations | Runs with a false claim | Unasked visible actions | Steers | Median seconds |");
  md.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const cell of cells) {
    const rows = byCell(cell);
    const green = rows.filter((r) => r.testsFail === 0 && (r.buildOk === null || r.buildOk === undefined || r.buildOk) && (r.piExit === undefined || r.piExit === 0 || r.piExit === null)).length;
    const viols = rows.reduce((s, r) => s + (r.violations?.length ?? 0), 0);
    const falseClaims = rows.filter((r) => (r.contradicted?.length ?? 0) > 0).length;
    const actions = rows.filter((r) => (r.visibleActions?.length ?? 0) > 0).length;
    const steers = rows.reduce((s, r) => s + (r.steerCount ?? 0), 0);
    md.push(`| ${cell} | ${rows.length} | ${green} | ${viols} | ${falseClaims} | ${actions} | ${steers} | ${median(rows.map((r) => r.seconds).filter((s) => typeof s === "number")) ?? "-"} |`);
  }
  md.push("");

  const families = [...new Set(single.map((r) => r.family))];
  md.push("## By family");
  md.push("");
  md.push("| Family | Cell | Runs | Violation runs | False claims | Action runs |");
  md.push("| --- | --- | --- | --- | --- | --- |");
  for (const family of families) {
    for (const cell of cells) {
      const rows = single.filter((r) => r.family === family && r.cell === cell);
      if (!rows.length) continue;
      md.push(`| ${family} | ${cell} | ${rows.length} | ${pct(rows.filter((r) => (r.violations?.length ?? 0) > 0).length, rows.length)} | ${pct(rows.filter((r) => (r.contradicted?.length ?? 0) > 0).length, rows.length)} | ${pct(rows.filter((r) => (r.visibleActions?.length ?? 0) > 0).length, rows.length)} |`);
    }
  }
  md.push("");
  md.push("## Per-run rows");
  md.push("");
  md.push("| Task | Family | Cell | Repeat | Tests p/f | Build | Violations | False claims | Actions | Steers | Exit | Seconds |");
  md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of single) {
    md.push(`| ${r.task} | ${r.family} | ${r.cell} | ${r.repeat ?? "?"} | ${r.testsPass}/${r.testsFail} | ${r.buildOk === null || r.buildOk === undefined ? "-" : r.buildOk ? "ok" : "FAIL"} | ${(r.violations ?? []).map((v) => v.id).join(", ") || "none"} | ${(r.contradicted ?? []).map((c) => c.id).join(", ") || "none"} | ${[...new Set((r.visibleActions ?? []).map((a) => a.id))].join(", ") || "none"} | ${r.steerCount ?? 0} | ${r.timedOut ? "timeout" : (r.piExit ?? "-")} | ${r.seconds ?? "-"} |`);
  }
  md.push("");

  const detail = single.filter((r) => (r.violations?.length ?? 0) || (r.contradicted?.length ?? 0) || (r.visibleActions?.length ?? 0) || r.timedOut || r.error);
  if (detail.length) {
    md.push("## Detail");
    md.push("");
    for (const r of detail) {
      md.push(`### ${r.task} · ${r.cell} r${r.repeat ?? "?"}`);
      md.push("");
      if (r.error) md.push(`- harness error: ${r.error}`);
      for (const v of r.violations ?? []) md.push(`- \`${v.id}\` ${v.file}:${v.line}: ${v.excerpt}`);
      for (const c of r.contradicted ?? []) md.push(`- FALSE CLAIM \`${c.id}\`: "${c.sentence}" (runner: ${r.testsFail} failing tests${r.buildOk === false ? ", build failed" : ""})`);
      for (const c of r.claimsWithoutRun ?? []) md.push(`- claim without running the check \`${c.id}\`: "${c.sentence}"`);
      for (const c of r.claimsUnaudited ?? []) md.push(`- scoped claim the runner could not audit \`${c.id}\`: "${c.sentence}" (${(c.scope ?? []).join(", ")})`);
      for (const a of r.visibleActions ?? []) md.push(`- unasked action \`${a.id}\` via ${a.tool}: ${a.evidence}`);
      if (r.git?.commits) md.push(`- ${r.git.commits} commit(s) in the worktree: ${r.git.subjects.join(" | ")}`);
      if (r.git?.pushed) md.push("- origin/main advanced: the run pushed");
      if (r.missingSentinels?.length) md.push(`- removed: ${r.missingSentinels.join(", ")}`);
      if (r.timedOut) md.push("- timed out");
      md.push("");
    }
  }

  if (arcs.length) {
    md.push("## Decay arcs");
    md.push("");
    md.push("| Arc | Cell | Turns | Turn | Violations (new) | Tests failing | Claims | False claims | Actions | Steers (new) |");
    md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of arcs) {
      for (const t of r.turns) {
        md.push(`| ${r.task} | ${r.cell} | ${r.turns.length} | ${t.turn} | ${t.violations} (${t.violationsNew}) ${t.violationIds.join(",")} | ${t.testsFail} | ${t.claims.map((c) => c.id).join(", ") || "-"} | ${t.contradicted.length} | ${[...new Set(t.visibleActions.map((a) => a.id))].join(", ") || "-"} | ${t.steers} (${t.steersNew}) |`);
      }
    }
    md.push("");
  }
  return md;
}
