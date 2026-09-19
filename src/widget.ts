import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { freshChecks } from "./done.js";
import type { DoneVerdict } from "./done.js";
import type { Verdict } from "./guard.js";
import type { ProseVerdict } from "./prose.js";
import type { RulesVerdict } from "./rules.js";
import type { RunawayVerdict } from "./runaway.js";
import type { StuckVerdict } from "./stuck.js";

export type WidgetPlacement = "aboveEditor" | "belowEditor";
export type WidgetBarMode = "stack" | "live";

/** Palette shared by the status line and the trace sidebar: one place decides what a verdict looks like. */
export interface ThemeLike { fg(color: string, text: string): string; bold(text: string): string }

export const LEVEL_COLOR: Record<string, string> = { allow: "success", ok: "success", warn: "warning", unverified: "warning", nudged: "warning", confirm: "error", deny: "error", stuck: "error", "false claim": "error", stopped: "error", "stopped, recovering": "error", violation: "warning", skipped: "muted", wake: "warning", silent: "muted", "appended silently": "muted", "possible credentials": "warning", error: "error" };

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
  barMode: WidgetBarMode;
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
  // --- Data style (current): pipe-separated tokens, label · value pairs ---
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

/** Sentence-style templates: natural language, no " · " separators between semantic groups. */
export const SENTENCE_TEMPLATES = {
  // --- Action: 24 variants covering level × context combinations ---
  action: {
    // ALLOW variants
    allow_default: "warden allowed {tool} action — {scope}",
    allow_safe: "warden allowed {tool} action — low risk",
    allow_read_only: "warden allowed {tool} action — read-only operation",
    allow_with_context: "warden allowed {tool} action — {scope}, irreversibility {irreversible}",
    allow_off_task: "warden allowed {tool} action — off-task but below threshold ({offTask})",
    allow_intent_mismatch: "warden allowed {tool} action — plan mismatch ({intent}) but not blocking",
    allow_slop: "warden allowed {tool} action — slop detected ({slop})", 
    allow_patterns: "warden allowed {tool} action — patterns matched ({patterns})",
    allow_approved: "warden allowed {tool} action — approved by user",
    allow_typesafe_error: "warden allowed {tool} action — TypeSafe unavailable, pattern checks only",
    // WARN variants
    warn_off_task: "warden warned about {tool} action — off-task risk ({offTask})",
    warn_irreversible: "warden warned about {tool} action — high irreversibility ({irreversible})",
    warn_intent: "warden warned about {tool} action — differs from stated plan",
    warn_slop: "warden warned about {tool} action — code slop detected ({slop})",
    warn_patterns: "warden warned about {tool} action — security patterns matched ({patterns})",
    warn_visible: "warden warned about {tool} action — visible outside working tree",
    // HOLD variants
    hold_irreversible: "warden held {tool} action — irreversibility {irreversible} exceeds threshold",
    hold_dangerous: "warden held {tool} action — destructive pattern detected ({patterns})",
    hold_deny: "warden blocked {tool} action — deny rule matched ({patterns})",
    // Fallback
    default: "warden {level}ed {tool} action",
  },
  // --- Stuck: 8 variants ---
  stuck: {
    stuck_repeat: "warden detected stuck loop — {failures} failures, same strategy ({sameStrategy})",
    stuck_churn: "warden detected stuck loop — {failures} failures, churning approaches",
    stuck_no_progress: "warden detected stuck loop — {failures} failures, no progress ({progress})",
    stuck_repeat_successful: "warden detected repeated success — {failures} identical results, consider if the task is done",
    stuck_typesafe_error: "warden stuck check unavailable — TypeSafe error",
    stuck_recovering: "warden detected stuck loop — {failures} failures, now recovering",
    ok: "warden checked stuck — no loop detected ({failures} failures, approach change {approachChange})",
    default: "warden {status} — {failures} failures",
  },
  // --- Done: 10 variants ---
  done: {
    unverified: "warden flagged done claim — {checksPassed}/{checks} checks passed, {changes} changes, not verified",
    false_claim: "warden flagged false done claim — {checksPassed}/{checks} checks failed",
    ok: "warden confirmed done — {checksPassed}/{checks} checks passed, {changes} changes",
    ok_all_passed: "warden confirmed done — all {checks} checks passed",
    partial: "warden flagged done — {checksPassed}/{checks} checks passed, needs attention",
    no_checks: "warden flagged done claim — no verification checks run",
    typesafe_error: "warden done check unavailable — TypeSafe error",
    unverified_nudged: "warden flagged done claim — agent asked to verify ({checksPassed}/{checks} passed)",
    false_claim_nudged: "warden flagged false claim — agent asked to recheck",
    default: "warden done check — {outcome}",
  },
  // --- Prose: 8 variants ---
  prose: {
    nudged: "warden nudged prose — {status} in recent replies",
    wordy: "warden flagged prose — wordy ({wordy})",
    cliches: "warden flagged prose — clichés detected ({cliches})",
    jargon: "warden flagged prose — jargon detected ({jargon})",
    multiple: "warden flagged prose — {status}",
    ok: "warden checked prose — all clear",
    typesafe_error: "warden prose check unavailable — TypeSafe error",
    default: "warden prose — {status}",
  },
  // --- Security: 6 variants ---
  security: {
    injection: "warden flagged security — injection risk in {tool} output",
    exfiltration: "warden flagged security — possible credentials in {tool} output",
    both: "warden flagged security — injection and exfiltration risk in {tool} output",
    suspicious: "warden flagged security — suspicious content in {tool} output",
    ok: "warden checked {tool} output — no security issues",
    default: "warden security — {tool}",
  },
  // --- Context: 5 variants ---
  context: {
    compressed: "warden compressed {tool} output — kept {retention}, saved {bytesSaved} bytes",
    recalled: "warden recalled full {tool} output — agent needed the original",
    kept: "warden kept {tool} output — {retention}",
    large: "warden compressed {tool} output — {bytesSaved} bytes saved",
    default: "warden context — {tool}, {retention}",
  },
  // --- Runaway: 4 variants ---
  runaway: {
    stopped: "warden stopped runaway {kind} — repeated {count}× ({chars} chars)",
    stopped_recovering: "warden stopped runaway {kind} — repeated {count}×, agent recovering",
    detected: "warden detected runaway {kind} — {count}× repetition",
    default: "warden runaway — {kind}",
  },
  // --- Rules: 6 variants ---
  rules: {
    violations: "warden flagged rules — {violations} in {tool} {path}",
    violation_single: "warden flagged rule — {violations}",
    none: "warden checked rules — no violations in {tool} {path}",
    skipped: "warden rules — skipped ({reasons})",
    typesafe_error: "warden rules check unavailable — TypeSafe error",
    default: "warden rules — {tool}",
  },
  // --- Subagent: 4 variants ---
  subagent: {
    wake: "warden woke for subagent report — {agent}, {kind}",
    silent: "warden ignored subagent report — {agent}, {kind}",
    appended: "warden appended subagent report — {agent}",
    default: "warden subagent — {agent}",
  },
} as const;

/** Pick the best sentence template for a verdict. Falls back to the data-style template. */
export function pickSentenceTemplate(guard: string, tokens: Tokens): string {
  const variants = SENTENCE_TEMPLATES[guard as keyof typeof SENTENCE_TEMPLATES] as Record<string, string> | undefined;
  if (!variants) return DEFAULT_TEMPLATES[guard as keyof typeof DEFAULT_TEMPLATES] ?? "";
  const level = tokens.level ?? tokens.status ?? "";
  const tool = tokens.tool ?? "";
  const has = (key: string) => tokens[key] && tokens[key] !== "none" && tokens[key] !== "0.00";
  // Guard-specific selection logic
  if (guard === "action") {
    if (tokens.flags?.includes("user approved")) return variants.allow_approved!;
    if (tokens.flags?.includes("typesafe error")) return variants.allow_typesafe_error!;
    if (level === "allow" || level === "ok") {
      if (has("patterns")) return variants.allow_patterns!;
      if (tokens.slop && tokens.slop !== "none") return variants.allow_slop!;
      if (tokens.flags?.includes("off task")) return variants.allow_off_task!;
      if (tokens.flags?.includes("off plan")) return variants.allow_intent_mismatch!;
      if (tokens.flags?.includes("read-only")) return variants.allow_read_only!;
      if (tokens.irreversible && Number(tokens.irreversible) < 0.3) return variants.allow_safe!;
      if (tokens.scope) return variants.allow_with_context!;
      return variants.allow_default!;
    }
    if (level === "warn") {
      if (has("slop") && tokens.slop !== "none") return variants.warn_slop!;
      if (has("patterns")) return variants.warn_patterns!;
      if (tokens.intent && Number(tokens.intent) > 0.5) return variants.warn_intent!;
      if (tokens.visible && Number(tokens.visible) > 0.5) return variants.warn_visible!;
      if (tokens.offTask && Number(tokens.offTask) > 0.5) return variants.warn_off_task!;
      if (tokens.irreversible && Number(tokens.irreversible) > 0.5) return variants.warn_irreversible!;
      return variants.warn_irreversible!;
    }
    if (level === "confirm" || level === "deny") {
      if (level === "deny") return variants.hold_deny!;
      if (has("patterns")) return variants.hold_dangerous!;
      return variants.hold_irreversible!;
    }
    return variants.default!;
  }
  if (guard === "stuck") {
    if (level === "stuck" || level === "error") {
      if (tokens.flags?.includes("successful repeat")) return variants.stuck_repeat_successful!;
      if (tokens.flags?.includes("churn")) return variants.stuck_churn!;
      if (tokens.flags?.includes("typesafe error")) return variants.stuck_typesafe_error!;
      if (tokens.flags?.includes("exact repeat")) return variants.stuck_repeat!;
      if (tokens.progress && Number(tokens.progress) < 0.2) return variants.stuck_no_progress!;
      return variants.stuck_repeat!;
    }
    if (level === "ok") return variants.ok!;
    return variants.default!;
  }
  if (guard === "done") {
    if (level === "false claim") return variants.false_claim!;
    if (level === "unverified") {
      if (tokens.flags?.includes("typesafe error")) return variants.typesafe_error!;
      if (tokens.flags?.includes("nudged")) return variants.unverified_nudged!;
      return variants.unverified!;
    }
    if (level === "ok") {
      if (tokens.checks && tokens.checksPassed && tokens.checks === tokens.checksPassed) return variants.ok_all_passed!;
      return variants.ok!;
    }
    return variants.default!;
  }
  if (guard === "prose") {
    if (level === "nudged") return variants.nudged!;
    if (level === "ok") return variants.ok!;
    if (tokens.flags?.includes("typesafe error")) return variants.typesafe_error!;
    if (has("wordy") && has("cliches") && has("jargon")) return variants.multiple!;
    if (has("wordy")) return variants.wordy!;
    if (has("cliches")) return variants.cliches!;
    if (has("jargon")) return variants.jargon!;
    return variants.default!;
  }
  if (guard === "security") {
    if (has("injection") && has("exfiltration")) return variants.both!;
    if (has("injection")) return variants.injection!;
    if (has("exfiltration")) return variants.exfiltration!;
    if (level === "ok") return variants.ok!;
    return variants.default!;
  }
  if (guard === "context") {
    if (tokens.bytesSaved && Number(tokens.bytesSaved) > 0) return variants.compressed!;
    if (tokens.retention === "all") return variants.kept!;
    return variants.default!;
  }
  if (guard === "runaway") {
    if (level === "stopped, recovering") return variants.stopped_recovering!;
    if (level === "stopped") return variants.stopped!;
    return variants.default!;
  }
  if (guard === "rules") {
    if (level === "violation") return variants.violations!;
    if (level === "skipped") return variants.skipped!;
    if (level === "ok") return variants.none!;
    return variants.default!;
  }
  if (guard === "subagent") {
    if (tokens.wake === "true") return variants.wake!;
    if (level === "appended silently") return variants.appended!;
    if (level === "silent") return variants.silent!;
    return variants.default!;
  }
  return DEFAULT_TEMPLATES[guard as keyof typeof DEFAULT_TEMPLATES] ?? "";
}

export function defaultWidgetConfig(): WidgetConfig {
  return { enabled: true, placement: "aboveEditor", barMode: "live", shortcut: "ctrl+shift+w", panelWidth: "40%", ...DEFAULT_TEMPLATES };
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
    verdict.source === "repeat" && verdict.stuck ? (verdict.successRepeat ? "successful repeat" : verdict.churn ? "churn" : "exact repeat") : undefined,
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
