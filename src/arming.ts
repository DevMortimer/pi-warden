/**
 * Session-scoped arming rules: a preparation (editing files matching globs) arms a
 * command pattern for a window; while armed, matching commands fire the rule's action.
 *
 * The tracker is in-memory per session. State dies on `agent_end` (or `reset`). No
 * cross-session persistence. Expiry on wall-clock, refreshed on each matching edit.
 *
 * The armed check is deterministic: it fires whether or not Jev is available. If Jev
 * is available, armed-rule names ride as context so the judge can weigh them, but the
 * action never depends on Jev.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { globToRegExp } from "./rules.js";
import { stripDataText } from "./guard.js";
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

function compileArmingRule(rule: ArmingRule): CompiledArmingRule | undefined {
  try {
    const flags = rule.arms.caseSensitive ? "" : "i";
    const duration = typeof rule.arms.for === "number" ? rule.arms.for : 600_000;
    return { rule, commandRegex: new RegExp(rule.arms.command, flags), durationMs: duration };
  } catch {
    return undefined;
  }
}

/** Match a candidate path against a rule's edited globs/regexes (reuses PR 2's matching approach). */
function editedMatches(rule: ArmingRule, candidate: string): boolean {
  const home = homedir();
  const target = candidate === "~" || candidate.startsWith("~/") ? home + candidate.slice(1) : candidate;
  if (rule.when.regex) {
    try {
      return rule.when.edited.some(pattern => new RegExp(pattern).test(target));
    } catch {
      return false;
    }
  }
  const relative = target.startsWith(home + "/") ? `~${target.slice(home.length)}` : target;
  const raw = relative.startsWith("~/") ? relative.slice(2) : relative.replace(/^\/+/, "");
  const forms = (pattern: string) => (pattern.startsWith("~/") ? [pattern, pattern.slice(2)] : [pattern]);
  return rule.when.edited.some(pattern => forms(pattern).some(form => globToRegExp(form).test(raw) || globToRegExp(form).test(relative)));
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

  /** Update the compiled rules from config; armed state is preserved. */
  updateRules(rules: readonly ArmingRule[]): void {
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
    const now = this.now();
    this.prune(now);
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

  /** Clear all arming state (called on agent_end). */
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