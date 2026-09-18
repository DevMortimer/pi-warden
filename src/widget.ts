import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { freshChecks } from "./done.js";
import type { DoneVerdict } from "./done.js";
import type { Verdict } from "./guard.js";
import type { ProseVerdict } from "./prose.js";
import type { RulesVerdict } from "./rules.js";
import type { RunawayVerdict } from "./runaway.js";
import type { StuckVerdict } from "./stuck.js";

export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Palette shared by the status line and the trace sidebar: one place decides what a verdict looks like. */
export interface ThemeLike { fg(color: string, text: string): string; bold(text: string): string }

export const LEVEL_COLOR: Record<string, string> = { allow: "success", ok: "success", warn: "warning", unverified: "warning", nudged: "warning", confirm: "error", stuck: "error", "false claim": "error", stopped: "error", "stopped, recovering": "error", violation: "warning", skipped: "muted", wake: "warning", silent: "muted", "appended silently": "muted", "possible credentials": "warning", error: "error" };

/** Verdicts that need no eye: the guard ran and found nothing. The rest keep a line of their own. */
const QUIET_COLORS = new Set(["success", "muted"]);

/**
 * A quiet verdict never folds when its line names a finding or a caveat. A `typesafe error` means pattern checks stood
 * in for a judgment, `user approved` means the call needed consent, and a named slop symptom or pattern is something the
 * guard did find; folding any of them into `OK action` would report a verdict the guard did not give.
 */
const FLAG_WORDS = ["typesafe error", "user approved", "off plan", "off task", "read-only"];
/** A `{slop}` or `{patterns}` segment names something a guard found; `slop: none` names the absence of one. */
const FINDING = /^(slop|patterns): (?!none\b)/;
const carriesFlag = (body: readonly string[]) => body.some(segment => FINDING.test(segment) || FLAG_WORDS.some(word => segment.includes(word)));

/** How far a verdict is from the editor; a worse verdict sits closer to where the eye already is. */
const SEVERITY: Record<string, number> = { warning: 1, error: 2 };

export interface WidgetConfig {
  enabled: boolean;
  placement: WidgetPlacement;
  /** Keyboard shortcut that toggles the trace sidebar; empty string disables it. */
  shortcut: string;
  /** Sidebar width: a percentage string such as "40%" or a column count. */
  panelWidth: string | number;
  /** Templates per guard. Segments are separated by " · "; a segment whose token has no value is dropped. */
  action: string;
  stuck: string;
  done: string;
  prose: string;
  security: string;
  context: string;
  runaway: string;
  rules: string;
  subagent: string;
}

export const DEFAULT_TEMPLATES = {
  action: "warden · {tool} · irreversible {irreversible} · off-task {offTask} · {scope} · slop: {slop} · patterns: {patterns} · {flags} · {level}",
  stuck: "warden · stuck · {failures} failures · same strategy {sameStrategy} · change {approachChange} · progress {progress} · {flags} · {status}",
  done: "warden · done-check · {changes} changes · {checksPassed}/{checks} checks passed · claims done {claimsDone} · claims verified {claimsVerified} · checks apply {checksApply} · {outcome} · {status}",
  prose: "warden · prose · wordy {wordy} · clichés {cliches} · jargon {jargon} · {flags} · {status}",
  security: "warden · security · {tool} · injection {injection} · exfiltration {exfiltration} · {status}",
  context: "warden · context · {tool} · {retention} · saved {bytesSaved} bytes",
  runaway: "warden · runaway · {kind} · {count}× repeated · {chars} chars · {signal} · {status}",
  rules: "warden · rules · {tool} {path} · {asked} rules · {violations} · {status}",
  subagent: "warden · subagent · {agent} · {kind} · {wake} · {status}",
} as const;

export function defaultWidgetConfig(): WidgetConfig {
  return { enabled: true, placement: "aboveEditor", shortcut: "ctrl+shift+w", panelWidth: "40%", ...DEFAULT_TEMPLATES };
}

export type Tokens = Record<string, string | undefined>;

const SEPARATOR = " · ";
const TOKEN = /\{([a-zA-Z]+)\}/g;

/**
 * Fill `{token}` placeholders. The template is split on " · "; a segment is dropped when any of its tokens is empty,
 * so optional information disappears together with its label. Unknown tokens render as empty (and drop their segment).
 */
export function renderTemplate(template: string, tokens: Tokens): string {
  const segments: string[] = [];
  for (const segment of template.split(SEPARATOR)) {
    let missing = false;
    const rendered = segment.replace(TOKEN, (_match, name: string) => {
      const value = tokens[name];
      if (value === undefined || value === "") missing = true;
      return value ?? "";
    });
    if (!missing && rendered.trim()) segments.push(rendered.trim());
  }
  return segments.join(SEPARATOR);
}

const fixed = (value: number | undefined, digits = 2) => (value === undefined ? undefined : value.toFixed(digits));
const time = (at: number) => new Date(at).toTimeString().slice(0, 8);

/**
 * Body segments read as data, not prose: the subject (tool, path, agent) stays in the text tone, numeric values keep
 * the text tone, and the labels around them sit one step down in muted. Labels dim so the eye lands on what was measured.
 */
export function renderSegment(segment: string, subject: boolean, theme: ThemeLike): string {
  if (subject) return theme.fg("text", segment);
  const value = /^(.+[ \t])([0-9][0-9.]*)$/.exec(segment);
  if (value) return theme.fg("muted", value[1]!) + theme.fg("text", value[2]!);
  return theme.fg("muted", segment);
}

/**
 * Split a rendered line into its verdict and its body. The verdict is the trailing segment when the template ends on a
 * known level, wherever the template put `{level}` or `{status}`; the body drops the `warden` prefix and the guard's own
 * name, so the guard is named once by the rail that renders this.
 */
export function parseVerdictLine(line: string, guard: string): { status?: string; body: string[] } {
  const segments = line.split(SEPARATOR);
  const last = segments.at(-1)!;
  const hasStatus = segments.length > 1 && LEVEL_COLOR[last] !== undefined;
  const status = hasStatus ? segments.pop()! : undefined;
  if (segments[0] === "warden") segments.shift();
  if (segments[0] === guard) segments.shift();
  return { ...(status === undefined ? {} : { status }), body: segments };
}

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

export function actionTokens(verdict: Verdict, at = Date.now()): Tokens {
  const flags = [
    verdict.approvedByUser ? "user approved" : undefined,
    verdict.intentMismatch ? "off plan" : undefined,
    verdict.offTaskSteer ? "off task" : undefined,
    verdict.source === "error" ? "typesafe error" : undefined,
    verdict.source === "read-only" ? "read-only" : undefined,
  ].filter(Boolean).join(", ");
  return {
    guard: "action",
    time: time(at),
    tool: verdict.summary.tool,
    level: verdict.level,
    source: verdict.source,
    irreversible: fixed(verdict.judgment?.irreversible),
    offTask: fixed(verdict.judgment?.offTask),
    scope: verdict.judgment?.scope.replace(/_/g, " "),
    approved: fixed(verdict.judgment?.approved),
    intent: fixed(verdict.judgment?.intentMismatch),
    visible: fixed(verdict.judgment?.visible),
    plan: verdict.plan === undefined ? undefined : (verdict.plan.length <= 80 ? verdict.plan : `${verdict.plan.slice(0, 80)}…`).replace(/\s+/g, " "),
    slop: verdict.slopSymptoms?.length ? verdict.slopSymptoms.map(symptom => `${symptom} ${verdict.slop![symptom].toFixed(2)}`).join(", ") : verdict.slop ? "none" : undefined,
    slopStub: fixed(verdict.slop?.stub),
    slopComments: fixed(verdict.slop?.comments),
    slopDead: fixed(verdict.slop?.dead),
    slopHedging: fixed(verdict.slop?.hedging),
    patterns: verdict.patterns.length ? verdict.patterns.map(hit => hit.id).join(", ") : undefined,
    reasons: verdict.reasons.length ? verdict.reasons.join("; ") : undefined,
    path: verdict.summary.path,
    model: verdict.judgment?.model,
    ms: verdict.judgment ? String(verdict.judgment.elapsedMs) : undefined,
    flags: flags || undefined,
  };
}

export function stuckTokens(verdict: StuckVerdict, at = Date.now()): Tokens {
  const flags = [
    verdict.source === "repeat" && verdict.stuck ? (verdict.successRepeat ? "successful repeat" : "exact repeat") : undefined,
    verdict.source === "error" ? "typesafe error" : undefined,
  ].filter(Boolean).join(", ");
  return {
    guard: "stuck",
    time: time(at),
    failures: String(verdict.failures),
    sameStrategy: fixed(verdict.judgment?.sameStrategy),
    approachChange: verdict.judgment ? `${verdict.judgment.approachChange.toFixed(1)}/2` : undefined,
    progress: fixed(verdict.judgment?.progress),
    status: verdict.stuck ? "stuck" : "ok",
    source: verdict.source,
    reasons: verdict.reasons.length ? verdict.reasons.join("; ") : undefined,
    model: verdict.judgment?.model,
    ms: verdict.judgment ? String(verdict.judgment.elapsedMs) : undefined,
    flags: flags || undefined,
  };
}

export function runawayTokens(verdict: RunawayVerdict, recovering: boolean, at = Date.now()): Tokens {
  return {
    guard: "runaway",
    time: time(at),
    kind: verdict.kind,
    count: String(verdict.count),
    chars: String(verdict.chars),
    signal: verdict.signal,
    block: verdict.block,
    status: recovering ? "stopped, recovering" : "stopped",
  };
}

export function doneTokens(verdict: DoneVerdict, at = Date.now()): Tokens {
  const checks = freshChecks(verdict.evidence);
  return {
    guard: "done",
    time: time(at),
    changes: String(verdict.evidence.mutations),
    checks: String(checks.length),
    checksPassed: String(checks.filter(check => check.passed).length),
    claimsDone: fixed(verdict.judgment?.claimsDone),
    claimsVerified: fixed(verdict.judgment?.claimsVerified),
    checksApply: fixed(verdict.judgment?.verificationApplies),
    outcome: verdict.judgment?.outcome,
    status: verdict.falseClaim ? "false claim" : verdict.unverified ? "unverified" : "ok",
    reasons: verdict.reasons.length ? verdict.reasons.join("; ") : undefined,
    model: verdict.judgment?.model,
    ms: verdict.judgment ? String(verdict.judgment.elapsedMs) : undefined,
    flags: verdict.error ? "typesafe error" : undefined,
  };
}

export function proseTokens(verdict: ProseVerdict, at = Date.now()): Tokens {
  return {
    guard: "prose",
    time: time(at),
    wordy: fixed(verdict.scores?.wordy),
    cliches: fixed(verdict.scores?.cliches),
    jargon: fixed(verdict.scores?.jargon),
    status: verdict.nudged ? "nudged" : verdict.flagged.length ? verdict.flagged.join(", ") : "ok",
    reasons: verdict.flagged.length ? verdict.flagged.join(", ") : undefined,
    model: verdict.model,
    ms: verdict.elapsedMs === undefined ? undefined : String(verdict.elapsedMs),
    flags: verdict.error ? "typesafe error" : undefined,
  };
}

export function rulesTokens(verdict: RulesVerdict, at = Date.now()): Tokens {
  return {
    guard: "rules",
    time: time(at),
    tool: verdict.tool,
    path: verdict.path,
    asked: verdict.source === "skipped" ? undefined : String(verdict.asked),
    violations: verdict.findings.length ? verdict.findings.map(finding => `${finding.name} ${finding.violation.toFixed(2)}`).join(", ") : verdict.scores ? "none" : undefined,
    status: verdict.source === "error" ? "typesafe error" : verdict.source === "skipped" ? "skipped" : verdict.findings.length ? "violation" : "ok",
    source: verdict.source,
    reasons: verdict.skippedReason ?? (verdict.findings.length ? verdict.findings.map(finding => finding.name).join("; ") : undefined),
    model: verdict.model,
    ms: verdict.elapsedMs === undefined ? undefined : String(verdict.elapsedMs),
    flags: verdict.error ? "typesafe error" : undefined,
  };
}

/** Token names users can put in templates, for /warden status and the README. */
export const TOKEN_NAMES = {
  security: ["tool", "injection", "exfiltration", "status"],
  context: ["tool", "retention", "bytesSaved"],
  runaway: ["kind", "count", "chars", "signal", "block", "status", "time", "guard"],
  rules: ["tool", "path", "asked", "violations", "status", "source", "reasons", "model", "ms", "flags", "time", "guard"],
  action: ["tool", "level", "source", "irreversible", "offTask", "scope", "approved", "intent", "visible", "plan", "slop", "slopStub", "slopComments", "slopDead", "slopHedging", "patterns", "reasons", "path", "model", "ms", "flags", "time", "guard"],
  prose: ["wordy", "cliches", "jargon", "status", "reasons", "model", "ms", "flags", "time", "guard"],
  stuck: ["failures", "sameStrategy", "approachChange", "progress", "status", "source", "reasons", "model", "ms", "flags", "time", "guard"],
  done: ["changes", "checks", "checksPassed", "claimsDone", "claimsVerified", "checksApply", "outcome", "status", "reasons", "model", "ms", "flags", "time", "guard"],
  subagent: ["agent", "kind", "wake", "status", "time", "guard"],
} as const;
