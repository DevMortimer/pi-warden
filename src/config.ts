import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JudgmentBackend } from "./backend.js";
import { resolveBackend } from "./backend.js";
import { COMMAND_TOOLS } from "./tools.js";
import { defaultWidgetConfig } from "./widget.js";
import type { WidgetConfig } from "./widget.js";

export interface Threshold {
  /** P(yes) at or above this shows a warning and continues. */
  warn: number;
  /** P(yes) at or above this asks the user before the tool runs. */
  confirm: number;
}

export interface OffTaskThreshold {
  /** P(off-task) at or above this, with a scope other than unclear, shows a warning. */
  warn: number;
  /** P(off-task) at or above this, with scope unrelated on a call that can change something, also steers the agent back to the task. Never holds: on 17k recorded calls off-task holds caught nothing the user regretted. */
  steer: number;
}

/** A user-defined command rule, matched against the stripDataText-processed command. */
export interface CommandRule {
  /** Stable id; same namespace as built-in rule ids, so exemptRules can reference either. */
  id: string;
  /** Regex source string; compiled case-insensitively unless caseSensitive is true. */
  pattern: string;
  /** warn: notice to the agent; confirm: hold (action dialog steers); deny: block with no dialog. */
  severity: "warn" | "confirm" | "deny";
  /** When severity is confirm, dialog (default) prompts the user; hold uses steer semantics. */
  action?: "dialog" | "hold";
  /** Optional human label shown instead of the derived one. */
  message?: string;
  /** Match case-sensitively. */
  caseSensitive?: boolean;
}

export interface ActionGuardConfig {
  enabled: boolean;
  /** Tool names inspected before execution. Read-only tools are skipped to keep latency low. */
  tools: string[];
  /** When TypeSafe cannot answer (timeout, outage, budget), allow the call with a warning instead of asking. */
  failOpen: boolean;
  /** Per-request TypeSafe timeout. The call is judged as an error after this. */
  timeoutMs: number;
  irreversible: Threshold;
  offTask: OffTaskThreshold;
  /** P(the call differs from the agent's own stated plan) at or above this warns and tells the agent; never holds on its own. */
  intentMismatch: number;
  /** The same, for a command whose effect is visible outside the working tree (commit, push, merge, publish, launch): less mismatch is enough. */
  visibleMismatch: number;
  /** Low P(should_proceed) is trace-only unless steer is enabled; hold is the inclusive threshold, not a blocking decision. Calibration: AUC 0.26 against regret, 44% flagged at 0.6 (100 targeted sessions, 2026-09-20). */
  shouldProceed: { hold: number; steer: boolean };
  /** Write each judged call and what the user did next (approved, declined, re-planned, regretted) to an owner-only per-session file under the agent directory; redacted, never the command. */
  feedbackLog: boolean;
  /** User-defined command rules (user file only; project files cannot set severity above warn). */
  commandRules: CommandRule[];
  /** User-defined deny rules, shorthand for commandRules with severity deny (user file only). */
  commandDenyRules: CommandRule[];
  /** Built-in or user rule ids to exempt (user file only). */
  exemptRules: string[];
  /** User-defined path rules with an access dimension (user file only; project files cannot act on them). */
  pathRules: PathRule[];
  /** User-defined arming rules: editing files matching globs arms a command pattern for a window (user file only). */
  armingRules: ArmingRule[];
  /** Jev confidence at or above this escalates a violation's severity in the blast-radius and rules-guard escalation paths. */
  escalationThreshold: number;
  /** When a judge answers: "evidence" (default) lets the judge decide the level from irreversible score alone, using built-in pattern hits as context; "level" restores the legacy behaviour where the floor sets the level before the judge.
   *  User-declared rules keep their declared action in both modes. */
  floor: "evidence" | "level";
}

/** A user-defined path rule: which paths, which side of the access is held, which tools, what happens on a hit. */
export interface PathRule {
  /** Stable id; same namespace as rule ids, so exemptRules can silence a user path rule too. */
  id: string;
  /** Path globs (`**` any depth, `*` one segment, `?` one character, `~` expands) or regex sources with regex: true. */
  paths: string[];
  /** Regex instead of glob for shapes globs cannot express. */
  regex?: boolean;
  /** Which touches match: "none" any touch; "read" writes only (reads flow); "write" reads only (writes flow). */
  access: "none" | "read" | "write";
  /** Which surfaces check the rule: file tools by name ("write", "edit", "read"), or "*" to also match bash commands. */
  tools: string[];
  /** note: tell the agent after the fact (the default, today's sensitive-path behavior); warn: notice; confirm: dialog; block: deny. */
  action: "note" | "warn" | "confirm" | "block";
  /** Optional human label shown instead of the derived one. */
  message?: string;
  /** Skip when the path does not exist (default true): phantom paths do not fire. */
  onlyIfExists?: boolean;
}

/** A user-defined arming rule: a preparation (editing files matching globs) arms a command pattern for a window.
 * While armed, matching commands fire the rule's action. This is the fix for the class of incident where each
 * individual call was harmless (edit a config, then run the reconciler that applies it) but the composition was
 * destructive — no single-call rule can catch it. */
export interface ArmingRule {
  /** Stable id; same namespace as rule ids, so exemptRules can silence an arming rule too. */
  id: string;
  /** The preparation: editing files matching these globs arms the rule. */
  when: {
    /** Path globs (`**` any depth, `*` one segment, `?` one character, `~` expands) or regex sources with regex: true. */
    edited: string[];
    /** Regex instead of glob for shapes globs cannot express. */
    regex?: boolean;
    /** Which file tools arm: default ["write", "edit"]. */
    tools?: string[];
  };
  /** The armed command: while armed, commands matching this regex fire the rule's action. */
  arms: {
    /** Regex source string; compiled case-insensitively unless caseSensitive is true. */
    command: string;
    /** How long the rule stays armed after the last matching edit; default "10m". */
    for?: string | number;
    /** Match the command case-sensitively. */
    caseSensitive?: boolean;
  };
  /** confirm: dialog (user-invoked prompt); hold: steer hold; block: deny. */
  action: "confirm" | "hold" | "block";
  /** Optional human label shown in the dialog/status. */
  message?: string;
}

export interface StuckGuardConfig {
  enabled: boolean;
  /** Tool results remembered per user prompt. */
  window: number;
  /** Failures in the window before Jev is asked. */
  minFailures: number;
  /** Tool results between two Jev checks. */
  cooldown: number;
  /** P(same strategy) at or above this reports the agent as stuck. */
  sameStrategy: number;
  /** Calls to the same target (same tool + input key) that trigger churn detection. */
  churnThreshold: number;
  /** Also steer the agent with a short message, not only the user. */
  nudge: boolean;
}

export interface DoneGuardConfig {
  enabled: boolean;
  /** P(final message claims completion) at or above this warns when no check passed in the run. */
  claimsDone: number;
  /** Also send the agent a follow-up asking it to verify. Triggers one more LLM turn. */
  nudge: boolean;
}

export interface ProseConfig {
  enabled: boolean;
  /** Who reads the agent's replies: "technical", "plain", or a free-text description. Drives the jargon question. */
  audience: string;
  /** P(symptom) at or above this counts as a hit. */
  threshold: number;
  /** A symptom must hit in this many of the last three replies before the agent is nudged. */
  trend: number;
  /** Replies with fewer characters are not judged. */
  minChars: number;
}

export interface SlopGuardConfig {
  enabled: boolean;
  /** P(symptom) at or above this is reported for written code: stub, comments, dead, hedging. */
  threshold: number;
  prose: ProseConfig;
}

export interface SecurityConfig {
  enabled: boolean;
  /** P(injection or exfiltration) at or above this adds an untrusted-output notice. */
  threshold: number;
}

export interface RulesConfig {
  /** Judge each write and edit against the project's Markdown rules on its own Jev request; steer, never hold. */
  enabled: boolean;
  /** P(violation) at or above this names the rule to the agent. */
  threshold: number;
  /** Project-relative Markdown rule files, used when the root pi-warden.md is absent. All are sent in one request. */
  files: string[];
  /** With no rules file, README.md, CLAUDE.md, or AGENTS.md (first found) is judged as one document. */
  fallback: boolean;
  /** Characters of a fallback document sent per request; every heading and the head of each section are kept within it. */
  maxChars: number;
  /** Globs of files whose content is never sent to Jev for rules (secrets, generated, vendored). */
  exclude: string[];
  /** Globs of files the rules do not apply to, for example tests or docs. */
  skip: string[];
  /** Glob → note. A write or edit under a matching path steers the agent with the note once per path; code only. */
  sensitivePaths: Record<string, string>;
}

export interface ContextConfig {
  enabled: boolean;
  /** Only new tool output is compressed; warm history and system prompts are never changed. */
  tailMinChars: number;
  /** Minimum P(the full output is not needed), 1 - P(all), before code removes output. */
  confidence: number;
  /** A text result at least this long that repeats an earlier result of this session is replaced by a short note (code only). */
  duplicateMinChars: number;
  /** Search command named in the recall footer; `auto` detects one at load. */
  recallTool: RecallTool;
  /** Minimum P(format) before a format-specific parser builds the excerpt instead of the generic head/tail one. */
  formatConfidence: number;
}

export interface RunawayConfig {
  enabled: boolean;
  /** Identical text paragraphs in one streaming reply before the run is stopped. Ordinary replies repeat a paragraph twice at most. */
  repeats: number;
  /** The same limit for thinking, where code drafting repeats paragraphs legitimately. */
  thinkingRepeats: number;
  /** Characters streamed before the first check. */
  minChars: number;
  /** After stopping, start one follow-up turn that names the repeat and asks for the one next step; once per user prompt. */
  recover: boolean;
}

export interface NotifyConfig {
  /** Desktop notification when the agent needs you: a held call it will ask about, a confirm dialog, a stopped runaway. Off by default; opt in per user or project. */
  enabled: boolean;
  /** Sibling holds in one turn produce one notification; a second within this many milliseconds is skipped. */
  cooldownMs: number;
  /**
   * Your own notifier as an argv (no shell), for ssh sessions or a phone relay: `{title}` and `{body}` in an argument are
   * replaced, and both are in PI_WARDEN_TITLE / PI_WARDEN_BODY. Empty: detect the desktop's own tool. User file only.
   */
  command: string[];
}

export interface SubagentConfig {
  /** Read async subagent reports at all. Off: warden ignores them, as before 0.14. */
  enabled: boolean;
  /** Ask Jev whether a report that names trouble deserves a wake. Off keeps the offline layer, which never wakes. */
  wake: boolean;
  /** P(this report needs the agent awake) at or above this value wakes it. Conservative on purpose. */
  threshold: number;
  /** At most one wake per this window, so several children finishing together cost one interruption. */
  cooldownMs: number;
}

export type RecallTool = "auto" | "rg" | "ag" | "ugrep" | "git-grep" | "grep" | "select-string" | "findstr" | "none";
const RECALL_TOOLS: readonly RecallTool[] = ["auto", "rg", "ag", "ugrep", "git-grep", "grep", "select-string", "findstr", "none"];

export function isRecallTool(value: unknown): value is RecallTool {
  return typeof value === "string" && (RECALL_TOOLS as readonly string[]).includes(value);
}

export type WardenMode = "steer" | "confirm" | "advise";

export interface LearningConfig {
  /** Enable adaptive thresholds based on learning data. */
  adaptiveThresholds: boolean;
  /** Enable pattern analysis and recommendations. */
  patternAnalysis: boolean;
  /** Minimum number of holds before adaptive thresholds kick in. */
  minHoldsForAdaptive: number;
  /** How aggressively to adjust thresholds (0-1). Higher values mean faster adaptation. */
  adaptationRate: number;
  /** Days to keep hold records in SQLite before pruning. 0 disables pruning. */
  retentionDays: number;
}

export interface WardenConfig {
  /** Master switch. false disables every guard, including offline pattern checks. */
  enabled: boolean;
  /** Consent to send task and action summaries to api.typesafe.ai. Set by /warden enable; never by a project file. */
  typesafe: boolean;
  /** The decisions service the judgments go to. User file only: a project must not redirect judgments to another vendor. */
  typesafeBackend: JudgmentBackend;
  /**
   * steer (default): a confirm-level call is held and the agent receives the judgment as its tool result, so it re-plans or asks
   * the user in chat. confirm: open a dialog and let the user decide (falls back to steer without a UI). advise: never hold; report only.
   * PI_WARDEN_MODE overrides it.
   */
  mode: WardenMode;
  /** Per-request TypeSafe timeout for every guard. */
  timeoutMs: number;
  /** Maximum TypeSafe requests per session across all guards. */
  maxRequests: number;
  action: ActionGuardConfig;
  stuck: StuckGuardConfig;
  done: DoneGuardConfig;
  slop: SlopGuardConfig;
  security: SecurityConfig;
  rules: RulesConfig;
  context: ContextConfig;
  runaway: RunawayConfig;
  notify: NotifyConfig;
  /** Triage of async subagent reports: Jev separates what needs the agent awake from what is only context. */
  subagent: SubagentConfig;
  /** The status line above the editor and the trace panel. */
  widget: WidgetConfig;
  /** Show steer messages in the transcript. They are always visible in the trace panel. */
  steerVisible: boolean;
  /** Per-call warning notices ("warden · …") in the transcript. Off by default; the widget and trace panel always show them. */
  notices: boolean;
  /** Steers delivered to the agent per run before further non-critical ones are recorded in the trace only. Every delivered
   * steer costs at least one LLM turn, and a closing run that collects six notices collects six restatements of the final
   * status. 0 disables the budget. Critical guards (stuck, done, runaway, subagent wake) always deliver. */
  steerBudget: number;
  /** Learning and adaptation settings. */
  learning: LearningConfig;
}

export const PACKAGE_NAME = "pi-warden";
/** Bumped when WardenConfig gains a section; extension.ts checks it so a half-updated module graph is reported, not crashed on. */
export const CONFIG_SCHEMA = 6;
export const PROJECT_CONFIG_FILE = `${PACKAGE_NAME}.json`;

export function defaultConfig(): WardenConfig {
  return {
    enabled: true,
    typesafe: false,
    typesafeBackend: "typesafe",
    mode: "steer",
    timeoutMs: 5000,
    maxRequests: 500,
    action: {
      enabled: true,
      tools: [...COMMAND_TOOLS, "write", "edit"],
      failOpen: true,
      timeoutMs: 5000,
      irreversible: { warn: 0.5, confirm: 0.7 },
      offTask: { warn: 0.6, steer: 0.85 },
      intentMismatch: 0.9,
      visibleMismatch: 0.8,
      shouldProceed: { hold: 0.6, steer: false },
      feedbackLog: true,
      commandRules: [],
      commandDenyRules: [],
      exemptRules: [],
      pathRules: [],
      armingRules: [],
      escalationThreshold: 0.85,
      floor: "evidence",
    },
    stuck: { enabled: true, window: 12, minFailures: 3, cooldown: 3, sameStrategy: 0.7, churnThreshold: 5, nudge: true },
    done: { enabled: true, claimsDone: 0.7, nudge: true },
    slop: { enabled: true, threshold: 0.7, prose: { enabled: true, audience: "technical", threshold: 0.7, trend: 2, minChars: 200 } },
    security: { enabled: true, threshold: 0.7 },
    rules: { enabled: true, threshold: 0.7, files: [], fallback: true, maxChars: 8000, exclude: [], skip: [], sensitivePaths: {} },
    context: { enabled: true, tailMinChars: 12000, confidence: 0.8, duplicateMinChars: 2000, recallTool: "auto", formatConfidence: 0.7 },
    runaway: { enabled: true, repeats: 4, thinkingRepeats: 10, minChars: 400, recover: true },
    notify: { enabled: false, cooldownMs: 10000, command: [] },
    subagent: { enabled: true, wake: true, threshold: 0.8, cooldownMs: 120000 },
    widget: defaultWidgetConfig(),
    steerVisible: false,
    notices: false,
    steerBudget: 3,
    learning: { adaptiveThresholds: true, patternAnalysis: true, minHoldsForAdaptive: 20, adaptationRate: 0.1, retentionDays: 365 },
  };
}

/** Mirrors Pi's agent directory rule so the file sits next to pi-typesafe's auth.json. */
export function userConfigPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, PACKAGE_NAME, "config.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", PROJECT_CONFIG_FILE);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function probability(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function threshold(value: unknown, fallback: Threshold): Threshold {
  if (!isObject(value)) return fallback;
  const warn = probability(value.warn, fallback.warn);
  const confirm = probability(value.confirm, fallback.confirm);
  return { warn: Math.min(warn, confirm), confirm };
}

/** `confirm` is the pre-0.12 name of the upper off-task threshold; files that still set it keep working. */
function offTaskThreshold(value: unknown, fallback: OffTaskThreshold): OffTaskThreshold {
  if (!isObject(value)) return fallback;
  const warn = probability(value.warn, fallback.warn);
  const steer = probability(value.steer ?? value.confirm, fallback.steer);
  return { warn: Math.min(warn, steer), steer };
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function isMode(value: unknown): value is WardenMode {
  return value === "steer" || value === "confirm" || value === "advise";
}

function parseCommandRule(raw: unknown, defaultSeverity: CommandRule["severity"]): CommandRule | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const pattern = typeof raw.pattern === "string" && raw.pattern.trim() ? raw.pattern : undefined;
  if (!id || !pattern) return undefined;
  const severity = raw.severity === "warn" || raw.severity === "confirm" || raw.severity === "deny" ? raw.severity : defaultSeverity;
  // Dialog is the default for a confirm rule (the reason one writes such a rule); hold restores steer semantics.
  // A deny or warn rule cannot carry an action: there is nothing to prompt and nothing to steer differently, and a
  // stray action on one would misreport in traces as a dialog rule.
  const action = raw.action === "dialog" || raw.action === "hold" ? (severity === "confirm" ? raw.action : undefined) : severity === "confirm" ? "dialog" : undefined;
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : undefined;
  const caseSensitive = typeof raw.caseSensitive === "boolean" ? raw.caseSensitive : false;
  return { id, pattern, severity, ...(action ? { action } : {}), ...(message ? { message } : {}), ...(caseSensitive ? { caseSensitive } : {}) };
}

function parseCommandRules(raw: unknown, defaultSeverity: CommandRule["severity"]): CommandRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const rules: CommandRule[] = [];
  for (const item of raw) {
    const rule = parseCommandRule(item, defaultSeverity);
    if (!rule || ids.has(rule.id)) continue;
    ids.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

function parseExemptRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) ids.add(item.trim());
  }
  return [...ids];
}

const PATH_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "powershell", "ctx_execute", "ctx_batch_execute", "ctx_execute_file"]);

function parsePathRule(raw: unknown): PathRule | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const paths = globList(raw.paths, []);
  if (!id || paths.length === 0) return undefined;
  // "*" widens the rule to the bash surface; other entries name the structured file-tool surfaces.
  const requested = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0).map(tool => tool.trim()) : ["*"];
  const tools = requested.length > 0 ? requested : ["*"];
  const access = raw.access === "none" || raw.access === "read" || raw.access === "write" ? raw.access : "none";
  const action = raw.action === "warn" || raw.action === "confirm" || raw.action === "block" ? raw.action : "note";
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : undefined;
  const onlyIfExists = raw.onlyIfExists === false ? false : true;
  return { id, paths, ...(raw.regex === true ? { regex: true } : {}), access, tools, action, ...(message ? { message } : {}), ...(onlyIfExists === false ? { onlyIfExists: false } : {}) };
}

function parsePathRules(raw: unknown): PathRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const rules: PathRule[] = [];
  for (const item of raw) {
    const rule = parsePathRule(item);
    // A tool name that is neither a structured surface nor "*" is inert on every surface; keep it only when it means something.
    if (!rule || ids.has(rule.id) || !rule.tools.some(tool => tool === "*" || PATH_TOOL_NAMES.has(tool))) continue;
    ids.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

/** Parse a duration string ("10m", "30s", "2h") or number (ms) into milliseconds. */
function parseDuration(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw !== "string") return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) return fallback;
  const value = parseFloat(match[1]!);
  const unit = match[2] ?? "m";
  return value * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

const DEFAULT_ARMING_DURATION = 600_000; // 10 minutes
const ARMING_TOOLS = new Set(["write", "edit"]);

function parseArmingRule(raw: unknown): ArmingRule | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const whenRaw = isObject(raw.when) ? raw.when : undefined;
  const edited = globList(whenRaw?.edited, []);
  if (!id || edited.length === 0) return undefined;
  const armsRaw = isObject(raw.arms) ? raw.arms as Record<string, unknown> : {};
  const command = typeof armsRaw.command === "string" && armsRaw.command.trim() ? armsRaw.command : undefined;
  if (!command) return undefined;
  const action = raw.action === "confirm" || raw.action === "hold" || raw.action === "block" ? raw.action : undefined;
  if (!action) return undefined;
  const toolsProvided = Array.isArray(whenRaw?.tools) && whenRaw!.tools.length > 0;
  const tools = toolsProvided
    ? (whenRaw!.tools as unknown[]).filter((t): t is string => typeof t === "string" && ARMING_TOOLS.has(t))
    : ["write", "edit"];
  // A when.tools that filters to nothing (e.g. ["bash"]) is inert: no tool would ever arm it.
  if (toolsProvided && tools.length === 0) return undefined;
  const forMs = parseDuration(armsRaw.for, DEFAULT_ARMING_DURATION);
  const caseSensitive = typeof armsRaw.caseSensitive === "boolean" ? armsRaw.caseSensitive : false;
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : undefined;
  const regex = whenRaw?.regex === true;
  return {
    id,
    when: { edited, ...(regex ? { regex: true } : {}), ...(toolsProvided && tools.length > 0 ? { tools } : {}) },
    arms: { command, for: forMs, ...(caseSensitive ? { caseSensitive } : {}) },
    action,
    ...(message ? { message } : {}),
  };
}

function parseArmingRules(raw: unknown): ArmingRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const rules: ArmingRule[] = [];
  for (const item of raw) {
    const rule = parseArmingRule(item);
    if (!rule || ids.has(rule.id)) continue;
    ids.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

function applyAction(base: ActionGuardConfig, raw: unknown, timeoutMs: number, source: "user" | "project"): ActionGuardConfig {
  const withTimeout = { ...base, timeoutMs };
  if (!isObject(raw)) return withTimeout;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0) : base.tools;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    tools,
    failOpen: boolean(raw.failOpen, base.failOpen),
    timeoutMs,
    irreversible: threshold(raw.irreversible, base.irreversible),
    offTask: offTaskThreshold(raw.offTask, base.offTask),
    intentMismatch: probability(raw.intentMismatch, base.intentMismatch),
    visibleMismatch: Math.min(probability(raw.visibleMismatch, base.visibleMismatch), probability(raw.intentMismatch, base.intentMismatch)),
    shouldProceed: {
      hold: probability((raw.shouldProceed as { hold?: number } | undefined)?.hold, base.shouldProceed.hold),
      steer: boolean((raw.shouldProceed as { steer?: boolean } | undefined)?.steer, base.shouldProceed.steer),
    },
    feedbackLog: boolean(raw.feedbackLog, base.feedbackLog),
    // Only the user file declares these; a project file cannot add, edit, or remove them. The base (already the
    // user's rules when a project file layers on top) is carried through, so a project "action" block cannot wipe them.
    commandRules: source === "user" ? parseCommandRules(raw.commandRules, "warn") : base.commandRules,
    commandDenyRules: source === "user" ? parseCommandRules(raw.commandDenyRules, "deny") : base.commandDenyRules,
    exemptRules: source === "user" ? parseExemptRules(raw.exemptRules) : base.exemptRules,
    // Path rules are user-declared security policy: a project file cannot add, edit, or remove them either.
    pathRules: source === "user" ? parsePathRules(raw.pathRules) : base.pathRules,
    // Arming rules are user-declared security policy: same gate.
    armingRules: source === "user" ? parseArmingRules(raw.armingRules) : base.armingRules,
    escalationThreshold: probability(raw.escalationThreshold, base.escalationThreshold),
    floor: source === "user" && (raw.floor === "level" || raw.floor === "evidence") ? raw.floor : base.floor,
  };
}

function applyStuck(base: StuckGuardConfig, raw: unknown): StuckGuardConfig {
  if (!isObject(raw)) return base;
  const window = positiveInteger(raw.window, base.window);
  return {
    enabled: boolean(raw.enabled, base.enabled),
    window,
    minFailures: Math.min(window, positiveInteger(raw.minFailures, base.minFailures)),
    cooldown: positiveInteger(raw.cooldown, base.cooldown),
    sameStrategy: probability(raw.sameStrategy, base.sameStrategy),
    churnThreshold: Math.min(window, positiveInteger(raw.churnThreshold, base.churnThreshold)),
    nudge: boolean(raw.nudge, base.nudge),
  };
}

function applyRunaway(base: RunawayConfig, raw: unknown): RunawayConfig {
  if (!isObject(raw)) return base;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    // One occurrence is not a repeat, so the floor is 2.
    repeats: Math.max(2, positiveInteger(raw.repeats, base.repeats)),
    thinkingRepeats: Math.max(2, positiveInteger(raw.thinkingRepeats, base.thinkingRepeats)),
    minChars: positiveInteger(raw.minChars, base.minChars),
    recover: boolean(raw.recover, base.recover),
  };
}

function applyNotify(base: NotifyConfig, raw: unknown, allowCommand: boolean): NotifyConfig {
  if (!isObject(raw)) return base;
  const cooldown = typeof raw.cooldownMs === "number" && Number.isSafeInteger(raw.cooldownMs) && raw.cooldownMs >= 0 ? raw.cooldownMs : base.cooldownMs;
  const command = allowCommand && Array.isArray(raw.command) && raw.command.every((arg): arg is string => typeof arg === "string") && (raw.command.length === 0 || raw.command[0]!.trim())
    ? [...raw.command] : base.command;
  return { enabled: boolean(raw.enabled, base.enabled), cooldownMs: cooldown, command };
}

function applySubagent(base: SubagentConfig, raw: unknown): SubagentConfig {
  if (!isObject(raw)) return base;
  const cooldown = typeof raw.cooldownMs === "number" && Number.isSafeInteger(raw.cooldownMs) && raw.cooldownMs >= 0 ? raw.cooldownMs : base.cooldownMs;
  return { enabled: boolean(raw.enabled, base.enabled), wake: boolean(raw.wake, base.wake), threshold: probability(raw.threshold, base.threshold), cooldownMs: cooldown };
}

function applyDone(base: DoneGuardConfig, raw: unknown): DoneGuardConfig {
  if (!isObject(raw)) return base;
  return { enabled: boolean(raw.enabled, base.enabled), claimsDone: probability(raw.claimsDone, base.claimsDone), nudge: boolean(raw.nudge, base.nudge) };
}

function applyProse(base: ProseConfig, raw: unknown): ProseConfig {
  if (!isObject(raw)) return base;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    audience: typeof raw.audience === "string" && raw.audience.trim() ? raw.audience.trim() : base.audience,
    threshold: probability(raw.threshold, base.threshold),
    trend: Math.min(3, positiveInteger(raw.trend, base.trend)),
    minChars: positiveInteger(raw.minChars, base.minChars),
  };
}

function applySlop(base: SlopGuardConfig, raw: unknown): SlopGuardConfig {
  if (!isObject(raw)) return base;
  // 0.2.x used `placeholder` for the stub threshold; it still sets the shared threshold.
  return { enabled: boolean(raw.enabled, base.enabled), threshold: probability(raw.threshold ?? raw.placeholder, base.threshold), prose: applyProse(base.prose, raw.prose) };
}

function globList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((glob): glob is string => typeof glob === "string" && glob.trim().length > 0).map(glob => glob.trim()) : fallback;
}

function applyRules(base: RulesConfig, raw: unknown): RulesConfig {
  if (!isObject(raw)) return base;
  const notes = isObject(raw.sensitivePaths)
    ? Object.fromEntries(Object.entries(raw.sensitivePaths).filter((entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === "string" && entry[1].trim().length > 0))
    : base.sensitivePaths;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    threshold: probability(raw.threshold, base.threshold),
    files: globList(raw.files, base.files),
    fallback: boolean(raw.fallback, base.fallback),
    maxChars: Math.max(500, positiveInteger(raw.maxChars, base.maxChars)),
    exclude: globList(raw.exclude, base.exclude),
    skip: globList(raw.skip, base.skip),
    sensitivePaths: notes,
  };
}

function applyWidget(base: WidgetConfig, raw: unknown): WidgetConfig {
  if (!isObject(raw)) return base;
  const template = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value : fallback);
  return {
    enabled: boolean(raw.enabled, base.enabled),
    placement: raw.placement === "belowEditor" || raw.placement === "aboveEditor" ? raw.placement : base.placement,
    barMode: raw.barMode === "live" || raw.barMode === "stack" ? raw.barMode : base.barMode,
    shortcut: typeof raw.shortcut === "string" ? raw.shortcut.trim() : base.shortcut,
    panelWidth: typeof raw.panelWidth === "number" && Number.isSafeInteger(raw.panelWidth) && raw.panelWidth >= 20 ? raw.panelWidth
      : typeof raw.panelWidth === "string" && /^[1-9]\d?%$/.test(raw.panelWidth.trim()) ? raw.panelWidth.trim() : base.panelWidth,
    action: template(raw.action, base.action),
    stuck: template(raw.stuck, base.stuck),
    done: template(raw.done, base.done),
    prose: template(raw.prose, base.prose),
    security: template(raw.security, base.security),
    context: template(raw.context, base.context),
    runaway: template(raw.runaway, base.runaway),
    rules: template(raw.rules, base.rules),
    subagent: template(raw.subagent, base.subagent),
  };
}

/** Shared request settings; `action.timeoutMs`/`action.maxRequests` from 0.1.x files are still honoured. */
function applyShared(base: WardenConfig, raw: Json): Pick<WardenConfig, "timeoutMs" | "maxRequests"> {
  const legacy = isObject(raw.action) ? raw.action : {};
  return {
    timeoutMs: positiveInteger(raw.timeoutMs ?? legacy.timeoutMs, base.timeoutMs),
    maxRequests: positiveInteger(raw.maxRequests ?? legacy.maxRequests, base.maxRequests),
  };
}

function applyGuards(base: WardenConfig, raw: Json, timeoutMs: number, source: "user" | "project"): Pick<WardenConfig, "action" | "stuck" | "done" | "slop" | "security" | "rules" | "context" | "runaway" | "notify" | "subagent"> {
  return {
    rules: applyRules(base.rules, raw.rules),
    runaway: applyRunaway(base.runaway, raw.runaway),
    subagent: applySubagent(base.subagent, raw.subagent),
    // A project file may switch notifications off or on, but never names a command to run.
    notify: applyNotify(base.notify, raw.notify, source === "user"),
    action: applyAction(base.action, raw.action, timeoutMs, source),
    stuck: applyStuck(base.stuck, raw.stuck),
    done: applyDone(base.done, raw.done),
    slop: applySlop(base.slop, raw.slop),
    security: isObject(raw.security) ? {
      enabled: boolean(raw.security.enabled, base.security.enabled),
      threshold: probability(raw.security.threshold, base.security.threshold),
    } : base.security,
    context: isObject(raw.context) ? {
      enabled: boolean(raw.context.enabled, base.context.enabled),
      tailMinChars: positiveInteger(raw.context.tailMinChars, base.context.tailMinChars),
      confidence: probability(raw.context.confidence, base.context.confidence),
      duplicateMinChars: positiveInteger(raw.context.duplicateMinChars, base.context.duplicateMinChars),
      recallTool: isRecallTool(raw.context.recallTool) ? raw.context.recallTool : base.context.recallTool,
      formatConfidence: probability(raw.context.formatConfidence, base.context.formatConfidence),
    } : base.context,
  };
}

/** Unknown keys and invalid values fall back to the base; nothing throws on a malformed file. */
export function applyUserOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  const shared = applyShared(base, raw);
  return {
    enabled: boolean(raw.enabled, base.enabled),
    typesafe: boolean(raw.typesafe, base.typesafe),
    typesafeBackend: resolveBackend(raw.typesafeBackend),
    mode: isMode(raw.mode) ? raw.mode : base.mode,
    ...shared,
    ...applyGuards(base, raw, shared.timeoutMs, "user"),
    widget: applyWidget(base.widget, raw.widget),
    steerVisible: boolean(raw.steerVisible, base.steerVisible),
    notices: boolean(raw.notices, base.notices),
    steerBudget: typeof raw.steerBudget === "number" && Number.isInteger(raw.steerBudget) && raw.steerBudget >= 0 ? raw.steerBudget : base.steerBudget,
    learning: applyLearning(base.learning, raw.learning),
  };
}

function applyLearning(base: LearningConfig, raw: unknown): LearningConfig {
  if (!isObject(raw)) return base;
  return {
    adaptiveThresholds: boolean(raw.adaptiveThresholds, base.adaptiveThresholds),
    patternAnalysis: boolean(raw.patternAnalysis, base.patternAnalysis),
    minHoldsForAdaptive: Math.max(5, positiveInteger(raw.minHoldsForAdaptive, base.minHoldsForAdaptive)),
    adaptationRate: Math.max(0, Math.min(1, probability(raw.adaptationRate, base.adaptationRate))),
    retentionDays: Math.max(0, positiveInteger(raw.retentionDays, base.retentionDays)),
  };
}

/** Project files may tune the guards but cannot grant TypeSafe consent, change the mode, or raise budgets. */
export function applyProjectOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  return { ...base, enabled: boolean(raw.enabled, base.enabled), ...applyGuards(base, raw, base.timeoutMs, "project") };
}

export interface LoadOptions {
  cwd?: string;
  /** Project overrides are applied only when the caller vouches for the project (Pi's trust decision). */
  projectTrusted?: boolean;
}

export function loadConfig(options: LoadOptions = {}): WardenConfig {
  let config = applyUserOverrides(defaultConfig(), readJson(userConfigPath()));
  if (options.cwd && options.projectTrusted) config = applyProjectOverrides(config, readJson(projectConfigPath(options.cwd)));
  return config;
}

/** Reads only the user file, for editing and persisting consent. */
export function readUserConfig(): Json {
  return readJson(userConfigPath()) ?? {};
}

export function writeUserConfig(raw: Json): string {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600, flag: "w" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}

/** Persists one top-level user setting without disturbing the rest of the file. */
export function setUserSetting(key: "typesafe" | "enabled" | "mode", value: boolean | WardenMode): string {
  return writeUserConfig({ ...readUserConfig(), [key]: value });
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split(".");
  const result = { ...obj };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    current[key] = { ...(current[key] as Record<string, unknown> ?? {}) };
    current = current[key] as Record<string, unknown>;
  }
  current[keys.at(-1)!] = value;
  return result;
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Coerce a CLI string into a JSON primitive so `/warden config set` stays ergonomic. */
export function parseConfigValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
