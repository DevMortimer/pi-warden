/**
 * The rendered status stack: the entry's only pi-tui code, kept apart from `widget.ts` so the
 * library entry stays free of both optional peers.
 */
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { carriesFlag, LEVEL_COLOR, parseVerdictLine, QUIET_COLORS, renderSegment, SEVERITY, type ThemeLike } from "./widget.js";

export interface WidgetEntry { guard: string; line: string }

/**
 * The status stack as a component. It renders from the width the layout hands it, so a body wraps to the pane and a
 * continuation keeps its column instead of reading as a second event.
 */
export function statusWidget(entries: readonly WidgetEntry[], theme: ThemeLike): { render(width: number): string[]; invalidate(): void } {
  return { render: (width: number) => widgetLines(entries, theme, width), invalidate: () => {} };
}

/**
 * The status line above the editor: a verdict chip leads each line, the guard follows in muted, and the body reads as
 * data. Guards whose last verdict found nothing fold into one line per verdict, so a calm turn costs one line instead
 * of one per guard; a verdict that ends nearest the editor is the one most worth the eye. The trace sidebar keeps every
 * event, its scores, and its detail; `/warden status` prints the last raw line per guard.
 *
 * With a `width`, each line wraps to it and a continuation keeps the column of the body, so a narrow pane does not turn
 * one verdict into two lines that look like two events.
 */
export function widgetLines(entries: readonly WidgetEntry[], theme: ThemeLike, width = 0): string[] {
  const parsed = entries.map(entry => ({ guard: entry.guard, ...parseVerdictLine(entry.line, entry.guard) }));
  const severity = (status?: string) => SEVERITY[LEVEL_COLOR[status ?? ""] ?? ""] ?? 0;
  // Folded: one line per quiet verdict. Own: one line, verdict or not. Loud: one line each, worst nearest the editor.
  const folded = new Map<string, string[]>();
  const own: typeof parsed = [];
  const loud: typeof parsed = [];
  for (const item of parsed) {
    const status = item.status;
    const color = status === undefined ? undefined : LEVEL_COLOR[status];
    if (status === undefined || color === undefined || carriesFlag(item.body)) own.push(item);
    else if (QUIET_COLORS.has(color)) folded.set(status, [...folded.get(status) ?? [], item.guard]);
    else loud.push(item);
  }
  // Stable sort on severity alone: guards that fired together keep the order they were recorded in.
  loud.sort((a, b) => severity(a.status) - severity(b.status));

  // The rail is one column, as wide as the verdicts present. A two-word verdict (`stopped, recovering`) overflows its
  // column instead of pushing every other line right.
  const RAIL_MAX = 10;
  const railWidth = parsed.reduce((longest, item) => {
    const size = item.status?.toUpperCase().length ?? 0;
    return size > 0 && size <= RAIL_MAX ? Math.max(longest, size) : longest;
  }, 0);
  const rail = (status: string) => theme.bold(theme.fg(LEVEL_COLOR[status] ?? "text", status.toUpperCase().padEnd(railWidth)));
  const separator = theme.fg("dim", " · ");
  const lines: string[] = [];
  /** The chip column plus the space after it; a line with no verdict keeps the column blank so the bodies stay in line. */
  const chipCell = (status?: string) => {
    if (status === undefined) return { text: railWidth ? " ".repeat(railWidth + 1) : "", width: railWidth ? railWidth + 1 : 0 };
    const word = status.toUpperCase();
    return { text: `${rail(status)} `, width: Math.max(railWidth, word.length) + 1 };
  };
  const push = (head: string, headWidth: number, body: string) => {
    if (!width || !body) { lines.push(head + body); return; }
    const wrapped = wrapTextWithAnsi(body, Math.max(10, width - headWidth));
    lines.push(head + (wrapped[0] ?? ""));
    for (const rest of wrapped.slice(1)) lines.push(" ".repeat(headWidth) + rest);
  };
  for (const [status, guards] of folded) {
    const chip = chipCell(status);
    push(chip.text, chip.width, theme.fg("muted", guards.join(" · ")));
  }
  const named = [...own, ...loud];
  const guardWidth = named.reduce((longest, item) => Math.max(longest, item.guard.length), 0);
  for (const item of named) {
    const body = item.body.map((segment, n) => renderSegment(segment, n === 0, theme)).join(separator);
    const name = body ? item.guard.padEnd(guardWidth) : item.guard;
    const chip = chipCell(item.status);
    push(chip.text + theme.fg("muted", name) + (body ? " " : ""), chip.width + name.length + (body ? 1 : 0), body);
  }
  return lines;
}
