/**
 * Session-scoped arming rules: a preparation (editing files matching globs) arms a
 * command pattern for a window; while armed, matching commands fire the rule's action.
 *
 * The tracker is in-memory per session. State lives for the rule's window within a session;
 * it is cleared when the session starts anew (session_start) and expires per `for`. It
 * survives across agent runs within the same session (the Scenario B case: edit in one
 * turn, reconcile in the next). No cross-session persistence.
 *
 * The armed check is deterministic: it fires whether or not Jev is available. If Jev
 * is available, armed-rule names ride as context so the judge can weigh them, but the
 * action never depends on Jev.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { matchPathGlobs, stripDataText } from "./guard.js";
import type { ArmingRule } from "./config.js";

/** A single armed rule's state. */
interface ArmedEntry {
  /** Wall-clock expiry (ms epoch). Refreshed on each matching edit. */
  expiresAt: number;
  /** Paths that armed the rule, for the dialog/status display. Deduplicated. */
  armedByPaths: string[];
}

/** A compiled arming rule: the parsed config rule plus its compiled regex. */
interface CompiledArmingRule {
  rule: ArmingRule;
  /** Compiled command regex (case-insensitive unless caseSensitive). */
  commandRegex: RegExp;
  /** Duration in ms. */
  durationMs: number;
}

/** Compile a rule, returning undefined if the regex is invalid. compileArmingRules returns the ids of rules that failed. */
function compileArmingRule(rule: ArmingRule): CompiledArmingRule | undefined {
  try {
    const flags = rule.arms.caseSensitive ? "" : "i";
    const duration = parseDuration(rule.arms.for);
    return { rule, commandRegex: new RegExp(rule.arms.command, flags), durationMs: duration };
  } catch {
    return undefined;
  }
}

/** Parse a duration string like "10m", "30s", "2h" into milliseconds. Returns 600000 (10m) for undefined/invalid. */
function parseDuration(forValue: string | number | undefined): number {
  if (forValue === undefined) return 600_000;
  if (typeof forValue === "number") return forValue > 0 ? forValue : 600_000;
  const match = /^(\d+)(ms|s|m|h)$/.exec(forValue);
  if (!match) return 600_000;
  const value = parseInt(match[1]!, 10);
  if (value <= 0) return 600_000;
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1_000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    default: return 600_000;
  }
}

/** Ids of rules whose regex or duration could not be compiled; surfaced via the one-time notice channel. */
export function unparseableArmingRules(rules: readonly ArmingRule[]): string[] {
  const ids: string[] = [];
  for (const rule of rules) {
    try {
      new RegExp(rule.arms.command, rule.arms.caseSensitive ? "" : "i");
    } catch {
      ids.push(rule.id);
    }
  }
  return ids;
}

/** Match a candidate path against a rule's edited globs/regexes (reuses the shared matcher from guard.ts). */
function editedMatches(rule: ArmingRule, candidate: string): boolean {
  return matchPathGlobs(rule.when.edited, rule.when.regex ?? false, candidate);
}

export type NowFn = () => number;

/**
 * In-memory arming state for one session.
 *
 * `arm` is called on write/edit calls whose `input.path` matches a rule's `when.edited` globs.
 * `checkArmed` is called on command calls to see if any armed rule's `arms.command` regex matches.
 * `reset` clears all state (called on `agent_end`).
 */
export class ArmingTracker {
  private readonly armed = new Map<string, ArmedEntry>();
  private compiled: CompiledArmingRule[];
  private now: NowFn;

  constructor(rules: readonly ArmingRule[], now: NowFn = Date.now) {
    this.now = now;
    this.compiled = rules.map(compileArmingRule).filter((r): r is CompiledArmingRule => r !== undefined);
  }

  /** Set the clock function (for testing with injectable time). */
  setNow(now: NowFn): void {
    this.now = now;
  }

  /** Update the compiled rules from config; recompiles only when the reference changes. */
  private lastRulesRef: readonly ArmingRule[] | undefined;
  updateRules(rules: readonly ArmingRule[]): void {
    if (rules === this.lastRulesRef) return;
    this.lastRulesRef = rules;
    this.compiled = rules.map(compileArmingRule).filter((r): r is CompiledArmingRule => r !== undefined);
  }

  /**
   * Record a write/edit call. If the tool is in a rule's `when.tools` (default ["write","edit"])
   * and the path matches a `when.edited` glob, arm (or refresh) that rule.
   * Returns the ids of rules that were armed or refreshed by this call.
   */
  arm(tool: string, path: string | undefined, cwd: string, sinkTargets?: readonly string[]): string[] {
    if (!path && (!sinkTargets || sinkTargets.length === 0)) return [];
    const now = this.now();
    const armed = new Set<string>();
    const allCandidates = [path, ...(sinkTargets ?? [])].filter((p): p is string => typeof p === "string" && p.length > 0);
    for (const { rule, durationMs } of this.compiled) {
      const tools = rule.when.tools ?? ["write", "edit"];
      // The structured path is checked only when the tool matches when.tools (write/edit by default).
      // Sink targets (redirect/tee) are checked regardless of tool: a bash redirect IS a write to that path,
      // and the spec says bash edits that create the same condition via redirect arm when the glob matches.
      const structuredMatch = tools.includes(tool) && allCandidates.some(candidate => {
        const home = homedir();
        const expanded = candidate === "~" || candidate.startsWith("~/") ? home + candidate.slice(1) : candidate;
        const abs = resolve(cwd, expanded);
        return editedMatches(rule, candidate) || editedMatches(rule, abs);
      });
      // When the tool is not in when.tools (e.g. bash), only sink targets are checked.
      const sinkCandidates = tools.includes(tool) ? allCandidates : (sinkTargets ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
      const sinkMatch = sinkCandidates.some(candidate => {
        const home = homedir();
        const expanded = candidate === "~" || candidate.startsWith("~/") ? home + candidate.slice(1) : candidate;
        const abs = resolve(cwd, expanded);
        return editedMatches(rule, candidate) || editedMatches(rule, abs);
      });
      if (!structuredMatch && !sinkMatch) continue;
      const existing = this.armed.get(rule.id);
      const paths = existing?.armedByPaths ?? [];
      // Dedup the arming path.
      const displayPath = path ?? allCandidates[0]!;
      if (!paths.includes(displayPath)) paths.push(displayPath);
      this.armed.set(rule.id, { expiresAt: now + durationMs, armedByPaths: paths });
      armed.add(rule.id);
    }
    this.prune(now);
    return [...armed];
  }

  /**
   * Check whether any armed rule's command regex matches the given command.
   * Returns the matching rules (with their compiled config) for the extension to act on.
   * Expired rules are pruned first.
   */
  checkArmed(command: string): { id: string; action: ArmingRule["action"]; message?: string; armedByPaths: string[] }[] {
    // Fix 5: avoid stripDataText (a non-trivial parse) when nothing is armed — the common case.
    if (this.armed.size === 0) return [];
    const now = this.now();
    this.prune(now);
    if (this.armed.size === 0) return []; // prune may have expired everything
    const text = stripDataText(command).text;
    const hits: { id: string; action: ArmingRule["action"]; message?: string; armedByPaths: string[] }[] = [];
    for (const { rule, commandRegex } of this.compiled) {
      const entry = this.armed.get(rule.id);
      if (!entry) continue;
      if (commandRegex.test(text)) {
        hits.push({ id: rule.id, action: rule.action, ...(rule.message ? { message: rule.message } : {}), armedByPaths: entry.armedByPaths });
      }
    }
    return hits;
  }

  /** Names of currently armed rules (for Jev context). */
  armedRuleIds(): string[] {
    this.prune(this.now());
    return [...this.armed.keys()];
  }

  /** Human-readable status line for `/warden status`. */
  statusLine(): string {
    this.prune(this.now());
    if (this.armed.size === 0) return "";
    const parts: string[] = [];
    for (const [id, entry] of this.armed) {
      const remaining = Math.max(0, entry.expiresAt - this.now());
      const mins = Math.ceil(remaining / 60_000);
      parts.push(`${id} (${mins}m left)`);
    }
    return `${this.armed.size} armed: ${parts.join(", ")}`;
  }

  /** Clear all arming state (called on session_start). */
  reset(): void {
    this.armed.clear();
  }

  /** Remove expired entries. */
  private prune(now: number): void {
    for (const [id, entry] of this.armed) {
      if (entry.expiresAt <= now) this.armed.delete(id);
    }
  }
}