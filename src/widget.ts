import type { DoneVerdict } from "./done.js";
import type { Verdict } from "./guard.js";
import type { ProseVerdict } from "./prose.js";
import type { RulesVerdict } from "./rules.js";
import type { RunawayVerdict } from "./runaway.js";
import type { StuckVerdict } from "./stuck.js";

export type WidgetPlacement = "aboveEditor" | "belowEditor";

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

export function actionTokens(verdict: Verdict, at = Date.now()): Tokens {
  const flags = [
    verdict.approvedByUser ? "user approved" : undefined,
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
    verdict.source === "repeat" && verdict.stuck ? "exact repeat" : undefined,
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
  return {
    guard: "done",
    time: time(at),
    changes: String(verdict.evidence.mutations),
    checks: String(verdict.evidence.checks.length),
    checksPassed: String(verdict.evidence.checks.filter(check => check.passed).length),
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
  action: ["tool", "level", "source", "irreversible", "offTask", "scope", "approved", "slop", "slopStub", "slopComments", "slopDead", "slopHedging", "patterns", "reasons", "path", "model", "ms", "flags", "time", "guard"],
  prose: ["wordy", "cliches", "jargon", "status", "reasons", "model", "ms", "flags", "time", "guard"],
  stuck: ["failures", "sameStrategy", "approachChange", "progress", "status", "source", "reasons", "model", "ms", "flags", "time", "guard"],
  done: ["changes", "checks", "checksPassed", "claimsDone", "claimsVerified", "checksApply", "outcome", "status", "reasons", "model", "ms", "flags", "time", "guard"],
} as const;
