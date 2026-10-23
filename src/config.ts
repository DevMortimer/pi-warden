import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "./atomic.js";
import type { JudgmentBackend } from "./backend.js";
import { resolveJudgmentBackend } from "./backend.js";
import { defaultHostDirs } from "./host-dirs.js";
import type { HostDirs } from "./host-dirs.js";
import { COMMAND_TOOLS } from "./tools.js";
import { WIDGET_BAR_MODES, WIDGET_PLACEMENTS, defaultWidgetConfig } from "./widget.js";
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
}

/** A user-defined command rule, matched against the stripDataText-processed command. */
export interface CommandRule {
  /** Stable id; same namespace as built-in rule ids, so exemptRules can reference either. */
  id: string;
  /** Regex source string; compiled case-insensitively unless caseSensitive is true. */
  pattern: string;
  /** warn: notice to the agent; confirm: hold (action dialog steers); deny (or its alias block): block with no dialog. */
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
  /** Whether a call whose answer cannot change what the agent sees is decided offline. On by default; the pattern pass and the floor always run. */
  ask: { enabled: boolean };
  /** Fraction of judged calls that also asks the trace-only questions (off-task, scope, should-proceed) in a second request, so the recorded signal keeps coming. 0 disables it. */
  traceSample: number;
  /** Per-request TypeSafe timeout. The call is judged as an error after this. */
  timeoutMs: number;
  irreversible: Threshold;
  offTask: OffTaskThreshold;
  /** P(the call differs from the agent's own stated plan) at or above this is reported on the status line and in the trace; never holds on its own. */
  intentMismatch: number;
  /** The same, for a command whose effect is visible outside the working tree (commit, push, merge, publish, launch): less mismatch is enough. */
  visibleMismatch: number;
  /** Low P(should_proceed) is reported on the status line and in the trace; threshold is inclusive and never holds a call. `hold` is its deprecated 1.x name. Calibration: AUC 0.26 against regret, 44% flagged at 0.6 (100 targeted sessions, 2026-09-20). */
  shouldProceed: { threshold: number };
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
  /** note: tell the agent after the fact (the default, today's sensitive-path behavior); warn: notice; confirm: dialog; block (or its alias deny): deny. */
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
  /** confirm: dialog (user-invoked prompt); hold: steer hold; block (or its alias deny): deny. */
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
  /** Steer on the 2nd identical call when nothing changed between and it failed the same way or re-read the same output. Code only. */
  repeatSteer: boolean;
  /** Send the judge a compact structured `evidence` section: the parsed failure per run, the edit diffs, and a digest. */
  evidence: boolean;
  /** Maximum characters of the unified line diff in a stuck-loop diff note. */
  diffLimit: number;
  /** Characters of the current output tail shown after the diff in a stuck-loop diff note. */
  tailLimit: number;
}

export interface DoneGuardConfig {
  enabled: boolean;
  /** P(final message claims completion) at or above this warns when no check passed in the run. */
  claimsDone: number;
  /** Also send the agent a follow-up asking it to verify. Triggers one more LLM turn. */
  nudge: boolean;
  /** After a change to a `uiFiles` path, only a `visualTools` call counts as proof; passing tests do not. */
  uiProof: boolean;
  /** Globs for files whose change shows on screen. `{a,b}` alternatives are allowed; a `!` glob excludes. */
  uiFiles: string[];
  visualTools: VisualToolsConfig;
}

export interface CauseGuardConfig {
  enabled: boolean;
  /** P(the final reply states a cause or hands a check to a person) at or above this is judged. */
  claimsCause: number;
  /** Also send the agent a follow-up asking it to check the cause. Triggers one more LLM turn. */
  nudge: boolean;
  /** Days an unchecked cause is remembered for the repeat steer. */
  windowDays: number;
}

/** Tool calls that show the rendered UI. Matching is case-insensitive. */
export interface VisualToolsConfig {
  /** Heads of a shell command segment: `agent-browser`, `npx playwright`. */
  commands: string[];
  /** Words that make a shell command visual when one stands alone as an argument or flag: `idb screenshot`, `--screenshot`. */
  commandWords: string[];
  /** Text in a tool name, or in the `tool` an MCP proxy calls: `take_screenshot`, `navigate_page`. */
  tools: string[];
  /** Image extensions whose `read` counts as looking at the result. */
  images: string[];
}

// Tests of UI code are proven by running them, not by looking at them.
export const DEFAULT_UI_FILES = [
  "**/*.{css,scss,sass,less,html,htm,vue,svelte,jsx,tsx,astro,dart}", "**/web/**/*.js", "**/public/**/*.js",
  "!**/*.{test,spec}.*", "!**/*_test.dart", "!**/{test,tests,__tests__}/**",
];

export function defaultVisualTools(): VisualToolsConfig {
  return {
    // A head names the command that shows the page: a page text snapshot, or a browser or device test run. A screenshot
    // subcommand only writes a file (`agent-browser screenshot PATH`, `idb screenshot`, `chrome --headless --screenshot`),
    // so it is not a head; the saved image counts once something reads it.
    commands: ["agent-browser snapshot", "agent-browser get text", "playwright test", "npx playwright test", "flutter test", "fvm flutter test"],
    commandWords: [],
    tools: ["take_snapshot"],
    images: ["png", "jpg", "jpeg", "webp"],
  };
}

export interface ProseConfig {
  enabled: boolean;
  /** Who reads the agent's replies: "technical", "plain", or a free-text description. Drives the jargon question. */
  audience: string;
  /** P(symptom) at or above this counts as a hit. */
  threshold: number;
  /** A symptom must hit in this many of the last three replies before it is reported. */
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
  /** Replace high-confidence credential values in tool results with `[redacted]` before the model sees them. */
  maskOutput: boolean;
  /** Query parameters whose value is a share link rather than a credential. Empty by default; user config only. */
  shareLinkParams: string[];
}

export interface RulesConfig {
  /** Judge each write and edit against the project's Markdown rules on its own Jev request; steer, never hold. */
  enabled: boolean;
  /** P(violation) at or above this names the rule to the agent. */
  threshold: number;
  /** A score from here up to the rule's cutoff becomes a soft "please double-check" steer; `0` turns the tier off. */
  softThreshold: number;
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

export interface RulesAtTurnStartConfig {
  /** Ask which rules apply before each new user message, and append the ones that do as one short message. */
  enabled: boolean;
  /** P(this rule applies) at or above which the rule is named. Measured against the owner's own requests; see docs/guards.md. */
  threshold: number;
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
  /** Append a compact evidence appendix to the summary during compaction. */
  compactAppendix: boolean;
  /** A run of at least 20 lines and 1500 characters in a new tool result that repeats text already in context becomes one pointer line (code only). */
  dedupeRuns: boolean;
  /** The same for user and custom messages, when `dedupeRuns` is also on. Off by default: a repeat the user sends can itself carry meaning ("here it is again, still failing"). */
  dedupeMessages: boolean;
  /** Prevention before the call: a bash action request asks whether the command will print far more than the agent needs. Never holds. */
  largeOutput: LargeOutputConfig;
  /** Beta, off by default: Jev picks the passages of a large output that matter for the current task instead of the head/diagnostic/tail excerpt. */
  filter: FilterConfig;
}

export interface FilterConfig {
  enabled: boolean;
  /** Target chunk size; chunks end at line boundaries, and only a line longer than this is split. */
  chunkChars: number;
  /** Minimum usefulness score (0 to 3) a chunk needs to be kept; 1.5 means it at least partly answers. */
  minScore: number;
  /** Most characters kept, including the final 1000; above it the highest-scoring chunks win. */
  maxKeptChars: number;
  /** Deadline for the filter's requests; on expiry the excerpt is used. */
  timeoutMs: number;
}

/** Relevance compaction (relevance.ts): Jev picks what of the discarded span is kept word for word instead of Pi's summary. */
export interface CompactionConfig {
  /** Replace Pi's compaction summary with a relevance compaction. Off by default. User file only: it sends data and spends requests. */
  enabled: boolean;
  /** P(needed again) at or above which a unit is kept word for word. */
  keepThreshold: number;
  /** Size budget for the summary in tokens (characters / 4); over it the threshold is raised, then Pi's summary runs. */
  maxSummaryTokens: number;
  /** Deadline for one whole compaction; past it Pi's summary runs. Each request is also bounded by the global `timeoutMs`. */
  timeoutMs: number;
  /** Requests one compaction may send; a span that needs more keeps Pi's summary and sends nothing. */
  maxRequests: number;
  /** Providers of the active model for which Pi's summary always runs (a provider that compacts on its own). */
  skipProviders: string[];
}

export interface LargeOutputConfig {
  enabled: boolean;
  /** P(the command prints far more than the agent needs) at or above which the agent is steered once per command family per session. */
  threshold: number;
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

export interface JudgeConfig {
  /** Consecutive timeout, network, or other failures before judgments pause; one auth or configuration failure is enough. */
  failuresBeforeCooldown: number;
  /** How long a failing judge is left alone; guards run pattern-only until the next request after it. */
  cooldownMs: number;
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
  /** Record Jev's answers to redacted Token Guardian evaluation events; never claims or acts. Independent of report triage. */
  observer: boolean;
  /** Read async subagent reports at all. Off: warden ignores them, as before 0.14. */
  enabled: boolean;
  /** Ask Jev whether a report that names trouble deserves a wake. Off keeps the offline layer, which never wakes. */
  wake: boolean;
  /** P(this report needs the agent awake) at or above this value wakes it. Conservative on purpose. */
  threshold: number;
  /** At most one wake per this window, so several children finishing together cost one interruption. */
  cooldownMs: number;
}

export const RECALL_TOOLS = ["auto", "rg", "ag", "ugrep", "git-grep", "grep", "select-string", "findstr", "none"] as const;
export type RecallTool = typeof RECALL_TOOLS[number];

function isOption<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

export function isRecallTool(value: unknown): value is RecallTool {
  return isOption(value, RECALL_TOOLS);
}

export const WARDEN_MODES = ["steer", "confirm", "advise"] as const;
export type WardenMode = typeof WARDEN_MODES[number];

export interface WasteConfig {
  /** Master switch for the call-waste notes and the session tip. */
  enabled: boolean;
  /** Append the session tip to the prompt once per session. */
  tip: boolean;
  /** Tool calls between two notes from the same detector. */
  every: number;
  /** Note on repeated poll calls (`sleep`). */
  sleep: boolean;
  /** Note on adjacent range reads of one file. */
  paging: boolean;
  /** Note on repeated searches of one file with an overlapping pattern. */
  search: boolean;
  /** Note on a filtered check re-run. */
  recheck: boolean;
}

export interface PrefsConfig {
  /** Read this project's earlier session files for preferences the user repeated (`/warden prefs`). Local, code only. */
  enabled: boolean;
  /** At session start, send the standing preferences that pass every injection rule to the agent as one context message. */
  inject: boolean;
}

/**
 * `/warden improve`: the window the pass reads and the quiet window it arms. Both are the user's own settings: a
 * project file cannot arm a quiet window, because a quieter rules judge is a weaker guard.
 */
export interface ImproveConfig {
  /** Days a pass looks back when no number is typed: `/warden improve 4` overrides it. 1 to 90. */
  days: number;
  /** How long the rules judge and the text guards stay quiet in the arming session: ten minutes by default, never more than fifteen. */
  quietMs: number;
}

/** The silent-half field trial (trial.ts): a random half of sessions records what it would have told the agent. */
export interface TrialConfig {
  /**
   * Put each session in arm live or silent, 50/50 from its id. A silent session judges as usual but records every
   * suppressed delivery instead of sending it; holds, secret masking, security notices, and runaway stops stay live.
   * Off by default, user file only: turning it on weakens guarding in half the sessions, so a project file must not.
   */
  silentHalf: boolean;
}

export interface LearningConfig {
  /** Enable pattern analysis and recommendations. */
  patternAnalysis: boolean;
  /** Days to keep hold records in SQLite before pruning. 0 disables pruning. */
  retentionDays: number;
  /** Days to keep records of calls that were not held; they repeat their task text across a turn and are the bulk of the file. 0 disables this pruning. */
  allowedRetentionDays: number;
}

export const CONSCIENCE_SKILL_MODES = ["off", "recommend", "load"] as const;
export type ConscienceSkillMode = typeof CONSCIENCE_SKILL_MODES[number];

export interface ConscienceSkillConfig {
  /** off: no automatic skill selection; recommend: name a skill and ask the agent to load it; load: supply instructions directly. */
  mode: ConscienceSkillMode;
  /** Case-sensitive skill names to exclude; * is the only wildcard. */
  exclude: string[];
}

export interface ConscienceToolConfig {
  /** Suggest tools including evidence/research tools; never execute or enable them directly. */
  enabled: boolean;
  /** Case-sensitive tool names to exclude; * is the only wildcard. */
  exclude: string[];
}

export interface ConscienceConfig {
  /** Master switch for the conscience module. */
  enabled: boolean;
  /** Skill selection settings. */
  skills: ConscienceSkillConfig;
  /** Tool suggestion settings. */
  tools: ConscienceToolConfig;
  /** Exact tool names never recommended: core tools the agent already uses. Skills are never skipped by this list. */
  skipTools: string[];
  /** Total wall-clock deadline for one assessment (ms). Effective deadline is min(this, shared timeoutMs). */
  timeoutMs: number;
  /** Max assessments per admitted operator prompt, including the initial. */
  maxAssessments: number;
  /** Max new guidance deliveries per admitted operator prompt. */
  maxNudges: number;
  /** Max UTF-8 bytes per skill file for automatic loading. */
  maxSkillBytes: number;
  /** Max cumulative automatic loading bytes per admitted prompt. */
  maxLoadedBytes: number;
  /** P(useful now) must reach this to select a candidate for recommendation. Default 1.0 (trace-only until calibrated per spec §7). */
  recommendThreshold: number;
  /** P(advance) from the disposition question must reach this before a candidate is considered. Default 0.70. */
  advanceThreshold: number;
  /** Candidates the local ranker keeps for Jev (1..256); the rest never reach a request. Default 31, the most one request holds; the labelled replay keeps 8 of 9 good picks at 31 and fewer at 12 or 20. */
  localTopK: number;
  /** Local BM25 floor against the request and the task spine; below it the conscience sends no request. Default 0.5. */
  localFloor: number;
}


export interface WardenConfig {
  /** Master switch. false disables every guard, including offline pattern checks. */
  enabled: boolean;
  /** Consent to send task and action summaries to api.typesafe.ai. Set by /warden enable; never by a project file. */
  typesafe: boolean;
  /** The decisions service the judgments go to: a name ("typesafe", "openrouter", "commandcode") or a caller-supplied endpoint object. User file only: a project must not redirect judgments to another vendor. Undefined when the configured value was refused. */
  typesafeBackend: JudgmentBackend | undefined;
  /** Why the configured typesafeBackend was refused: judgments stay off, and the once-per-session notice and /warden status quote this. */
  backendRefusal: string | undefined;
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
  cause: CauseGuardConfig;
  slop: SlopGuardConfig;
  security: SecurityConfig;
  rules: RulesConfig;
  /** A rules reminder at the start of each user turn (curator.ts). */
  rulesAtTurnStart: RulesAtTurnStartConfig;
  context: ContextConfig;
  runaway: RunawayConfig;
  notify: NotifyConfig;
  judge: JudgeConfig;
  /** Triage of async subagent reports: Jev separates what needs the agent awake from what is only context. */
  subagent: SubagentConfig;
  /** The status line above the editor and the trace panel. */
  widget: WidgetConfig;
  /** A toast for each guard notice. Off by default; the widget and the trace panel always show them. */
  notices: boolean;
  /** Per-model steer adaptation. */
  /** Learning and adaptation settings. */
  learning: LearningConfig;
  /** Broad-consideration coach: recommends or loads skills and tools before the agent acts. */
  conscience: ConscienceConfig;
  /** Standing preferences: corrections the user repeated in earlier sessions of this project. */
  prefs: PrefsConfig;
  /** The `/warden improve` pass: its default window and its quiet window. */
  improve: ImproveConfig;
  /** Silent-half field trial: off by default, user file only. */
  trial: TrialConfig;
  /** Call-waste notes: advisory sentences attached to the tool result that triggers them. */
  waste: WasteConfig;
  /** Relevance compaction in place of Pi's compaction summary. Off by default. */
  compaction: CompactionConfig;
  /** Config values that were not applied as written, one message each; shown once per session and in `/warden status`. */
  warnings: string[];
}

export const PACKAGE_NAME = "pi-warden";
/** Bumped when WardenConfig gains a section; extension.ts checks it so a half-updated module graph is reported, not crashed on. */
export const CONFIG_SCHEMA = 15;
export const PROJECT_CONFIG_FILE = `${PACKAGE_NAME}.json`;

export function defaultConfig(): WardenConfig {
  return {
    enabled: true,
    typesafe: false,
    typesafeBackend: "typesafe",
    backendRefusal: undefined,
    mode: "steer",
    timeoutMs: 5000,
    maxRequests: 500,
    action: {
      enabled: true,
      tools: [...COMMAND_TOOLS, "write", "edit"],
      failOpen: true,
      ask: { enabled: true },
      traceSample: 0.05,
      timeoutMs: 5000,
      // 0.9 holds: below it the judge is wrong one call in two to one in seven, and the 0.7 to 0.9 band held no call the user regretted.
      irreversible: { warn: 0.5, confirm: 0.9 },
      offTask: { warn: 0.6 },
      intentMismatch: 0.9,
      visibleMismatch: 0.8,
      shouldProceed: { threshold: 0.6 },
      feedbackLog: true,
      commandRules: [],
      commandDenyRules: [],
      exemptRules: [],
      pathRules: [],
      armingRules: [],
      escalationThreshold: 0.85,
      floor: "evidence",
    },
    stuck: { enabled: true, window: 12, minFailures: 3, cooldown: 3, sameStrategy: 0.7, churnThreshold: 5, nudge: true, repeatSteer: true, evidence: true, diffLimit: 3000, tailLimit: 1000 },
    done: { enabled: true, claimsDone: 0.7, nudge: true, uiProof: true, uiFiles: [...DEFAULT_UI_FILES], visualTools: defaultVisualTools() },
    cause: { enabled: true, claimsCause: 0.7, nudge: true, windowDays: 7 },
    slop: { enabled: true, threshold: 0.7, prose: { enabled: true, audience: "technical", threshold: 0.7, trend: 2, minChars: 200 } },
    security: { enabled: true, threshold: 0.7, maskOutput: true, shareLinkParams: [] },
    rules: { enabled: true, threshold: 0.7, softThreshold: 0, files: [], fallback: true, maxChars: 8000, exclude: [], skip: [], sensitivePaths: {} },
    // 0.3 is the measured cut: 69% of the rules named apply, and 68 of the 73 requests that touch a rule's area get one.
    rulesAtTurnStart: { enabled: true, threshold: 0.3 },
    context: { enabled: true, tailMinChars: 12000, confidence: 0.8, duplicateMinChars: 2000, recallTool: "auto", formatConfidence: 0.7, compactAppendix: true, dedupeRuns: true, dedupeMessages: false, largeOutput: { enabled: true, threshold: 0.85 }, filter: { enabled: false, chunkChars: 2000, minScore: 1.5, maxKeptChars: 6000, timeoutMs: 4000 } },
    runaway: { enabled: true, repeats: 4, thinkingRepeats: 10, minChars: 400, recover: true },
    notify: { enabled: false, cooldownMs: 10000, command: [] },
    judge: { cooldownMs: 60000, failuresBeforeCooldown: 3 },
    subagent: { enabled: true, wake: true, observer: true, threshold: 0.8, cooldownMs: 120000 },
    widget: defaultWidgetConfig(),
    notices: false,
    learning: { patternAnalysis: true, retentionDays: 365, allowedRetentionDays: 90 },
    conscience: {
      enabled: false,
      skills: { mode: "recommend", exclude: [] },
      tools: { enabled: true, exclude: [] },
      skipTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      timeoutMs: 3000,
      maxAssessments: 3,
      maxNudges: 2,
      maxSkillBytes: 32768,
      maxLoadedBytes: 65536,
      // Beta policy thresholds (measured 2026-09-22); disabled by default, conscience.enabled is the switch.
      recommendThreshold: 0.80,
      advanceThreshold: 0.70,
      localTopK: 31,
      localFloor: 0.5,
    },
    prefs: { enabled: true, inject: true },
    improve: { days: 7, quietMs: 600000 },
    trial: { silentHalf: false },
    waste: { enabled: true, tip: false, every: 20, sleep: true, paging: true, search: true, recheck: true },
    // pi-claude-bridge compacts its own models and cancels on failure; its summary must not be replaced.
    compaction: { enabled: false, keepThreshold: 0.5, maxSummaryTokens: 20000, timeoutMs: 20000, maxRequests: 12, skipProviders: ["claude-bridge"] },
    warnings: [],
  };
}

/** The user file is in the host's agent directory: `~/.pi/agent` on Pi, `~/.omp/agent` on oh-my-pi. `PI_CODING_AGENT_DIR` overrides it. */
export function userConfigPath(dirs: HostDirs = defaultHostDirs()): string {
  return join(dirs.agentDir, PACKAGE_NAME, "config.json");
}

export function projectConfigPath(cwd: string, dirs: HostDirs = defaultHostDirs()): string {
  return join(cwd, dirs.configDirName, PROJECT_CONFIG_FILE);
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

/** `confirm` and `steer` named a second, higher off-task threshold before every off-task judgment went to the trace. */
function offTaskThreshold(value: unknown, fallback: OffTaskThreshold): OffTaskThreshold {
  if (!isObject(value)) return fallback;
  return { warn: probability(value.warn, fallback.warn) };
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function isMode(value: unknown): value is WardenMode {
  return isOption(value, WARDEN_MODES);
}

/** One config warning for a rule value no kind accepts; the rule still applies, at the level named. */
function unknownRuleValue(kind: string, id: string, key: string, value: unknown, valid: readonly string[], applied: string): string {
  return `${kind} "${id}": ${key} ${String(JSON.stringify(value)).slice(0, 40)} is not one of ${valid.join(", ")}; the rule applies at ${applied}`;
}

function parseCommandRule(raw: unknown, defaultSeverity: CommandRule["severity"], warnings: string[]): CommandRule | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const pattern = typeof raw.pattern === "string" && raw.pattern.trim() ? raw.pattern : undefined;
  if (!id || !pattern) return undefined;
  // `block` is the path and arming rule word for deny. An unknown value holds (never weaker than the list's own
  // default): a typo in a deny rule must not let the command through, nor one in a warn rule leave it unheld.
  let severity: CommandRule["severity"];
  if (raw.severity === undefined) severity = defaultSeverity;
  else if (raw.severity === "warn" || raw.severity === "confirm" || raw.severity === "deny") severity = raw.severity;
  else if (raw.severity === "block") severity = "deny";
  else {
    severity = defaultSeverity === "deny" ? "deny" : "confirm";
    warnings.push(unknownRuleValue("command rule", id, "severity", raw.severity, ["warn", "confirm", "deny", "block"], severity));
  }
  // Dialog is the default for a confirm rule (the reason one writes such a rule); hold restores steer semantics.
  // A deny or warn rule cannot carry an action: there is nothing to prompt and nothing to steer differently, and a
  // stray action on one would misreport in traces as a dialog rule.
  const action = raw.action === "dialog" || raw.action === "hold" ? (severity === "confirm" ? raw.action : undefined) : severity === "confirm" ? "dialog" : undefined;
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : undefined;
  const caseSensitive = typeof raw.caseSensitive === "boolean" ? raw.caseSensitive : false;
  return { id, pattern, severity, ...(action ? { action } : {}), ...(message ? { message } : {}), ...(caseSensitive ? { caseSensitive } : {}) };
}

function parseCommandRules(raw: unknown, defaultSeverity: CommandRule["severity"], warnings: string[]): CommandRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const rules: CommandRule[] = [];
  for (const item of raw) {
    const rule = parseCommandRule(item, defaultSeverity, warnings);
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

function parsePathRule(raw: unknown, warnings: string[]): PathRule | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const paths = globList(raw.paths, []);
  if (!id || paths.length === 0) return undefined;
  // "*" widens the rule to the bash surface; other entries name the structured file-tool surfaces.
  const requested = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0).map(tool => tool.trim()) : ["*"];
  const tools = requested.length > 0 ? requested : ["*"];
  const access = raw.access === "none" || raw.access === "read" || raw.access === "write" ? raw.access : "none";
  let action: PathRule["action"];
  if (raw.action === undefined) action = "note";
  else if (raw.action === "note" || raw.action === "warn" || raw.action === "confirm" || raw.action === "block") action = raw.action;
  else if (raw.action === "deny") action = "block";
  else {
    action = "confirm";
    warnings.push(unknownRuleValue("path rule", id, "action", raw.action, ["note", "warn", "confirm", "block", "deny"], action));
  }
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : undefined;
  const onlyIfExists = raw.onlyIfExists === false ? false : true;
  return { id, paths, ...(raw.regex === true ? { regex: true } : {}), access, tools, action, ...(message ? { message } : {}), ...(onlyIfExists === false ? { onlyIfExists: false } : {}) };
}

function parsePathRules(raw: unknown, warnings: string[]): PathRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const rules: PathRule[] = [];
  for (const item of raw) {
    const rule = parsePathRule(item, warnings);
    // A tool name that is neither a structured surface nor "*" is inert on every surface; keep it only when it means something.
    if (!rule || ids.has(rule.id) || !rule.tools.some(tool => tool === "*" || PATH_TOOL_NAMES.has(tool))) continue;
    ids.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

/**
 * An arming duration in milliseconds: a number is milliseconds; a string takes `ms`, `s`, `m`, or `h`, and a string
 * without a unit means minutes. Zero, negative, and unreadable values give the fallback. The one parser for `arms.for`.
 */
export function parseDuration(raw: unknown, fallback: number): number {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  if (typeof raw !== "string") return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) return fallback;
  const value = parseFloat(match[1]!);
  const unit = match[2] ?? "m";
  const ms = value * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  return ms > 0 ? ms : fallback;
}

export const DEFAULT_ARMING_DURATION = 600_000; // 10 minutes
const ARMING_TOOLS = new Set(["write", "edit"]);

function parseArmingRule(raw: unknown, warnings: string[]): ArmingRule | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const whenRaw = isObject(raw.when) ? raw.when : undefined;
  const edited = globList(whenRaw?.edited, []);
  if (!id || edited.length === 0) return undefined;
  const armsRaw = isObject(raw.arms) ? raw.arms as Record<string, unknown> : {};
  const command = typeof armsRaw.command === "string" && armsRaw.command.trim() ? armsRaw.command : undefined;
  if (!command) return undefined;
  if (raw.action === undefined) {
    warnings.push(`arming rule "${id}": has no action and is ignored; set action to confirm, hold, or block`);
    return undefined;
  }
  let action: ArmingRule["action"];
  if (raw.action === "confirm" || raw.action === "hold" || raw.action === "block") action = raw.action;
  else if (raw.action === "deny") action = "block";
  else {
    action = "confirm";
    warnings.push(unknownRuleValue("arming rule", id, "action", raw.action, ["confirm", "hold", "block", "deny"], action));
  }
  const toolsProvided = Array.isArray(whenRaw?.tools) && whenRaw!.tools.length > 0;
  const tools = toolsProvided
    ? (whenRaw!.tools as unknown[]).filter((t): t is string => typeof t === "string" && ARMING_TOOLS.has(t))
    : ["write", "edit"];
  // A when.tools that filters to nothing (e.g. ["bash"]) is inert: no tool would ever arm it.
  if (toolsProvided && tools.length === 0) return undefined;
  const forMs = parseDuration(armsRaw.for, DEFAULT_ARMING_DURATION);
  // A bare number reads as milliseconds and a bare string as minutes; both surprise someone, so both are named.
  if (typeof armsRaw.for === "string" && /^\d+(?:\.\d+)?$/.test(armsRaw.for.trim())) {
    warnings.push(`arming rule "${id}": arms.for "${armsRaw.for.trim()}" has no unit and is read as minutes; write it with ms, s, m, or h`);
  }
  if (forMs < 1000) warnings.push(`arming rule "${id}": arms for ${forMs} ms, under one second; a number in arms.for is milliseconds, "10m" is ten minutes`);
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

function parseArmingRules(raw: unknown, warnings: string[]): ArmingRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const rules: ArmingRule[] = [];
  for (const item of raw) {
    const rule = parseArmingRule(item, warnings);
    if (!rule || ids.has(rule.id)) continue;
    ids.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

/** One config warning for a project value that would weaken the action guard or security. */
function projectIgnored(key: string, value: unknown, kept: unknown): string {
  return `project file: ${key} ${JSON.stringify(value)} is ignored; a project file may make the action guard and security stricter, not weaker, so the user value ${JSON.stringify(kept)} applies`;
}

/** A project switch may turn a guard on, never off. */
function projectSwitch(key: string, value: unknown, base: boolean, warnings: string[]): boolean {
  if (base && value === false) { warnings.push(projectIgnored(key, false, true)); return true; }
  return boolean(value, base);
}

/** A project threshold may be lowered (stricter), never raised above the user's. */
function projectProbability(key: string, value: unknown, base: number, warnings: string[]): number {
  const parsed = probability(value, base);
  if (parsed <= base) return parsed;
  warnings.push(projectIgnored(key, parsed, base));
  return base;
}

function applyAction(base: ActionGuardConfig, raw: unknown, timeoutMs: number, source: "user" | "project", warnings: string[]): ActionGuardConfig {
  const withTimeout = { ...base, timeoutMs };
  if (!isObject(raw)) return withTimeout;
  const project = source === "project";
  const listed = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0) : base.tools;
  // A project adds guarded tools; one it leaves out stays guarded.
  const dropped = project ? base.tools.filter(tool => !listed.includes(tool)) : [];
  if (dropped.length) warnings.push(`project file: action.tools leaves out ${dropped.join(", ")}; a project file may add tools but not remove them, so they stay guarded`);
  const tools = project ? [...base.tools, ...listed.filter(tool => !base.tools.includes(tool))] : listed;
  const irreversibleRaw = isObject(raw.irreversible) ? raw.irreversible : undefined;
  const irreversible = project && irreversibleRaw ? (() => {
    const warn = projectProbability("action.irreversible.warn", irreversibleRaw.warn, base.irreversible.warn, warnings);
    const confirm = projectProbability("action.irreversible.confirm", irreversibleRaw.confirm, base.irreversible.confirm, warnings);
    return { warn: Math.min(warn, confirm), confirm };
  })() : threshold(raw.irreversible, base.irreversible);
  let failOpen = boolean(raw.failOpen, base.failOpen);
  if (project && failOpen && !base.failOpen) { warnings.push(projectIgnored("action.failOpen", true, false)); failOpen = false; }
  const rawAsk = isObject(raw.ask) ? raw.ask : {};
  const shouldProceed = isObject(raw.shouldProceed) ? raw.shouldProceed : {};
  return {
    enabled: project ? projectSwitch("action.enabled", raw.enabled, base.enabled, warnings) : boolean(raw.enabled, base.enabled),
    tools,
    failOpen,
    ask: { enabled: project ? projectSwitch("action.ask.enabled", rawAsk.enabled, base.ask.enabled, warnings) : boolean(rawAsk.enabled, base.ask.enabled) },
    traceSample: probability(raw.traceSample, base.traceSample),
    timeoutMs,
    irreversible,
    offTask: offTaskThreshold(raw.offTask, base.offTask),
    intentMismatch: probability(raw.intentMismatch, base.intentMismatch),
    visibleMismatch: Math.min(probability(raw.visibleMismatch, base.visibleMismatch), probability(raw.intentMismatch, base.intentMismatch)),
    shouldProceed: {
      // `hold` is the pre-1.0 name of `threshold`; files that still set it keep working through 1.x.
      threshold: probability(shouldProceed.threshold ?? shouldProceed.hold, base.shouldProceed.threshold),
    },
    feedbackLog: boolean(raw.feedbackLog, base.feedbackLog),
    // Only the user file declares these; a project file cannot add, edit, or remove them. The base (already the
    // user's rules when a project file layers on top) is carried through, so a project "action" block cannot wipe them.
    commandRules: source === "user" ? parseCommandRules(raw.commandRules, "warn", warnings) : base.commandRules,
    commandDenyRules: source === "user" ? parseCommandRules(raw.commandDenyRules, "deny", warnings) : base.commandDenyRules,
    exemptRules: source === "user" ? parseExemptRules(raw.exemptRules) : base.exemptRules,
    // Path rules are user-declared security policy: a project file cannot add, edit, or remove them either.
    pathRules: source === "user" ? parsePathRules(raw.pathRules, warnings) : base.pathRules,
    // Arming rules are user-declared security policy: same gate.
    armingRules: source === "user" ? parseArmingRules(raw.armingRules, warnings) : base.armingRules,
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
    repeatSteer: boolean(raw.repeatSteer, base.repeatSteer),
    evidence: boolean(raw.evidence, base.evidence),
    diffLimit: positiveInteger(raw.diffLimit, base.diffLimit),
    tailLimit: positiveInteger(raw.tailLimit, base.tailLimit),
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

/** A project config cannot switch the judge off for longer than this by setting a huge cooldown. */
const MAX_JUDGE_COOLDOWN_MS = 10 * 60 * 1000;

function applyJudge(base: JudgeConfig, raw: unknown): JudgeConfig {
  if (!isObject(raw)) return base;
  const cooldown = typeof raw.cooldownMs === "number" && Number.isSafeInteger(raw.cooldownMs) && raw.cooldownMs >= 0 ? Math.min(raw.cooldownMs, MAX_JUDGE_COOLDOWN_MS) : base.cooldownMs;
  return { cooldownMs: cooldown, failuresBeforeCooldown: positiveInteger(raw.failuresBeforeCooldown, base.failuresBeforeCooldown) };
}

function applySubagent(base: SubagentConfig, raw: unknown): SubagentConfig {
  if (!isObject(raw)) return base;
  const cooldown = typeof raw.cooldownMs === "number" && Number.isSafeInteger(raw.cooldownMs) && raw.cooldownMs >= 0 ? raw.cooldownMs : base.cooldownMs;
  return { enabled: boolean(raw.enabled, base.enabled), wake: boolean(raw.wake, base.wake), observer: boolean(raw.observer, base.observer), threshold: probability(raw.threshold, base.threshold), cooldownMs: cooldown };
}

function applyDone(base: DoneGuardConfig, raw: unknown): DoneGuardConfig {
  if (!isObject(raw)) return base;
  const visual = isObject(raw.visualTools) ? raw.visualTools : {};
  return {
    enabled: boolean(raw.enabled, base.enabled),
    claimsDone: probability(raw.claimsDone, base.claimsDone),
    nudge: boolean(raw.nudge, base.nudge),
    uiProof: boolean(raw.uiProof, base.uiProof),
    uiFiles: globList(raw.uiFiles, base.uiFiles),
    visualTools: {
      commands: globList(visual.commands, base.visualTools.commands),
      commandWords: globList(visual.commandWords, base.visualTools.commandWords),
      tools: globList(visual.tools, base.visualTools.tools),
      images: globList(visual.images, base.visualTools.images).map(extension => extension.replace(/^\./, "")),
    },
  };
}

function applyCause(base: CauseGuardConfig, raw: unknown): CauseGuardConfig {
  if (!isObject(raw)) return base;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    claimsCause: probability(raw.claimsCause, base.claimsCause),
    nudge: boolean(raw.nudge, base.nudge),
    windowDays: Math.max(1, positiveInteger(raw.windowDays, base.windowDays)),
  };
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
    softThreshold: probability(raw.softThreshold, base.softThreshold),
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
    placement: isOption(raw.placement, WIDGET_PLACEMENTS) ? raw.placement : base.placement,
    barMode: isOption(raw.barMode, WIDGET_BAR_MODES) ? raw.barMode : base.barMode,
    shortcut: typeof raw.shortcut === "string" ? raw.shortcut.trim() : base.shortcut,
    panelWidth: typeof raw.panelWidth === "number" && Number.isSafeInteger(raw.panelWidth) && raw.panelWidth >= 20 ? raw.panelWidth
      : typeof raw.panelWidth === "string" && /^[1-9]\d?%$/.test(raw.panelWidth.trim()) ? raw.panelWidth.trim() : base.panelWidth,
    action: template(raw.action, base.action),
    stuck: template(raw.stuck, base.stuck),
    done: template(raw.done, base.done),
    cause: template(raw.cause, base.cause),
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

function applyGuards(base: WardenConfig, raw: Json, timeoutMs: number, source: "user" | "project", warnings: string[]): Pick<WardenConfig, "action" | "stuck" | "done" | "cause" | "slop" | "security" | "rules" | "rulesAtTurnStart" | "context" | "runaway" | "notify" | "judge" | "subagent" | "waste" | "compaction"> {
  return {
    compaction: applyCompaction(base.compaction, raw.compaction, source),
    waste: applyWaste(base.waste, raw.waste),
    rules: applyRules(base.rules, raw.rules),
    rulesAtTurnStart: applyRulesAtTurnStart(base.rulesAtTurnStart, raw.rulesAtTurnStart, source, warnings),
    runaway: applyRunaway(base.runaway, raw.runaway),
    subagent: applySubagent(base.subagent, raw.subagent),
    // A project file may switch notifications off or on, but never names a command to run.
    notify: applyNotify(base.notify, raw.notify, source === "user"),
    judge: applyJudge(base.judge, raw.judge),
    action: applyAction(base.action, raw.action, timeoutMs, source, warnings),
    stuck: applyStuck(base.stuck, raw.stuck),
    done: applyDone(base.done, raw.done),
    cause: applyCause(base.cause, raw.cause),
    slop: applySlop(base.slop, raw.slop),
    security: isObject(raw.security) ? {
      enabled: source === "project" ? projectSwitch("security.enabled", raw.security.enabled, base.security.enabled, warnings) : boolean(raw.security.enabled, base.security.enabled),
      threshold: source === "project" ? projectProbability("security.threshold", raw.security.threshold, base.security.threshold, warnings) : probability(raw.security.threshold, base.security.threshold),
      // Only the user file can turn masking off: a repository must not unmask credentials in its own agent's output.
      maskOutput: source === "user" ? boolean(raw.security.maskOutput, base.security.maskOutput) : base.security.maskOutput,
      // A listed parameter excuses a share-link token, so it is user config only for the same reason as `maskOutput`.
      shareLinkParams: source === "user" ? globList(raw.security.shareLinkParams, base.security.shareLinkParams) : base.security.shareLinkParams,
    } : base.security,
    context: isObject(raw.context) ? {
      enabled: boolean(raw.context.enabled, base.context.enabled),
      tailMinChars: positiveInteger(raw.context.tailMinChars, base.context.tailMinChars),
      confidence: probability(raw.context.confidence, base.context.confidence),
      duplicateMinChars: positiveInteger(raw.context.duplicateMinChars, base.context.duplicateMinChars),
      recallTool: isRecallTool(raw.context.recallTool) ? raw.context.recallTool : base.context.recallTool,
      formatConfidence: probability(raw.context.formatConfidence, base.context.formatConfidence),
      compactAppendix: boolean(raw.context.compactAppendix, base.context.compactAppendix),
      dedupeRuns: boolean(raw.context.dedupeRuns, base.context.dedupeRuns),
      dedupeMessages: boolean(raw.context.dedupeMessages, base.context.dedupeMessages),
      largeOutput: isObject(raw.context.largeOutput) ? {
        enabled: boolean(raw.context.largeOutput.enabled, base.context.largeOutput.enabled),
        threshold: probability(raw.context.largeOutput.threshold, base.context.largeOutput.threshold),
      } : base.context.largeOutput,
      filter: isObject(raw.context.filter) ? {
        // User file only: turning it on sends whole redacted outputs to the judge and spends requests.
        enabled: source === "user" ? boolean(raw.context.filter.enabled, base.context.filter.enabled) : base.context.filter.enabled,
        chunkChars: positiveInteger(raw.context.filter.chunkChars, base.context.filter.chunkChars),
        minScore: typeof raw.context.filter.minScore === "number" && raw.context.filter.minScore >= 0 && raw.context.filter.minScore <= 3 ? raw.context.filter.minScore : base.context.filter.minScore,
        maxKeptChars: positiveInteger(raw.context.filter.maxKeptChars, base.context.filter.maxKeptChars),
        timeoutMs: positiveInteger(raw.context.filter.timeoutMs, base.context.filter.timeoutMs),
      } : base.context.filter,
    } : base.context,
  };
}

const REMOVED_KEYS: ReadonlyArray<{ path: string; now: string }> = [
  { path: "conscience.loadThreshold", now: "no score loads a skill by itself; the conscience names a skill and asks the agent to load it, and conscience.skills.mode is the only switch for loading" },
  { path: "learning.adaptiveThresholds", now: "thresholds never change on their own; /warden recommend suggests changes from your hold history and you apply them" },
  { path: "steerVisible", now: "every notice is on the status line and in the trace; nothing of it enters the conversation" },
  { path: "steerBudget", now: "notices are not queued for the agent, so there is no per-run budget; a repeat of the same notice is held back" },
  { path: "action.shouldProceed.steer", now: "a should-proceed judgment is reported on the status line and in the trace; no notice reaches the agent, so there is no steer to switch on" },
  { path: "action.offTask.steer", now: "action.offTask.warn is the only off-task threshold; every off-task judgment is reported on the status line and in the trace" },
  { path: "action.offTask.confirm", now: "action.offTask.warn is the only off-task threshold; every off-task judgment is reported on the status line and in the trace" },
  { path: "action.intentTraceOnly", now: "an intent mismatch is always reported on the status line and in the trace; nothing is sent to the agent, so there is no mode to choose" },
  { path: "steers.adaptive", now: "no notice is muted; the follow and dispute counts stay in /warden status" },
  { path: "steers.minSteers", now: "no notice is muted; the follow and dispute counts stay in /warden status" },
  { path: "steers.minFollowed", now: "no notice is muted; the follow and dispute counts stay in /warden status" },
  { path: "steers.maxDisputed", now: "no notice is muted; the follow and dispute counts stay in /warden status" },
  { path: "steers.recheckEvery", now: "no notice is muted; the follow and dispute counts stay in /warden status" },
  { path: "steers.probeEvery", now: "no notice is muted; the follow and dispute counts stay in /warden status" },
];

/** True when `path` (dot-separated) is set in `raw`; a null leaf counts, so a cleared key still gets its warning. */
function hasPath(raw: Json, path: string): boolean {
  let node: unknown = raw;
  for (const part of path.split(".")) {
    if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, part)) return false;
    node = node[part];
  }
  return true;
}

function removedKeyWarnings(raw: Json, source: "user" | "project"): string[] {
  const warnings: string[] = [];
  for (const { path, now } of REMOVED_KEYS) {
    if (hasPath(raw, path)) warnings.push(`${source === "project" ? "project file: " : ""}${path} was removed and is ignored; ${now}`);
  }
  return warnings;
}

/** Unknown keys and invalid values fall back to the base; nothing throws on a malformed file. */
export function applyUserOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  const warnings: string[] = removedKeyWarnings(raw, "user");
  const shared = applyShared(base, raw);
  const backend = resolveJudgmentBackend(raw.typesafeBackend);
  const guards = applyGuards(base, raw, shared.timeoutMs, "user", warnings);
  return {
    enabled: boolean(raw.enabled, base.enabled),
    typesafe: boolean(raw.typesafe, base.typesafe),
    typesafeBackend: backend.typesafeBackend,
    backendRefusal: backend.backendRefusal,
    mode: isMode(raw.mode) ? raw.mode : base.mode,
    ...shared,
    ...guards,
    widget: applyWidget(base.widget, raw.widget),
    notices: boolean(raw.notices, base.notices),
    learning: applyLearning(base.learning, raw.learning),
    conscience: applyConscience(base.conscience, raw.conscience),
    prefs: applyPrefs(base.prefs, raw.prefs),
    improve: applyImprove(base.improve, raw.improve, warnings),
    trial: applyTrial(base.trial, raw.trial),
    warnings: [...(base.warnings ?? []), ...warnings],
  };
}

/**
 * A project cannot turn the trial on, and cannot arm an improve quiet window: applyProjectOverrides never copies either
 * section, so the user file is the only source.
 */
function applyTrial(base: TrialConfig, raw: unknown): TrialConfig {
  if (!isObject(raw)) return base;
  return { silentHalf: boolean(raw.silentHalf, base.silentHalf) };
}

function applyWaste(base: WasteConfig, raw: unknown): WasteConfig {
  if (!isObject(raw)) return base;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    tip: boolean(raw.tip, base.tip),
    every: Math.max(2, positiveInteger(raw.every, base.every)),
    sleep: boolean(raw.sleep, base.sleep),
    paging: boolean(raw.paging, base.paging),
    search: boolean(raw.search, base.search),
    recheck: boolean(raw.recheck, base.recheck),
  };
}

/** The turn-start reminder spends a request before every user message, so a project file may make it stricter, never turn it off. */
function applyRulesAtTurnStart(base: RulesAtTurnStartConfig, raw: unknown, source: "user" | "project", warnings: string[]): RulesAtTurnStartConfig {
  if (!isObject(raw)) return base;
  const project = source === "project";
  return {
    enabled: project ? projectSwitch("rulesAtTurnStart.enabled", raw.enabled, base.enabled, warnings) : boolean(raw.enabled, base.enabled),
    // A lower cut names more rules, which is the stricter reading of "remind me".
    threshold: project ? projectProbability("rulesAtTurnStart.threshold", raw.threshold, base.threshold, warnings) : probability(raw.threshold, base.threshold),
  };
}

/** Pi awaits the compaction hook with no deadline of its own, so this one is bounded too. */
const MAX_COMPACTION_TIMEOUT_MS = 120_000;

function applyCompaction(base: CompactionConfig, raw: unknown, source: "user" | "project"): CompactionConfig {
  if (!isObject(raw)) return base;
  return {
    // Turning it on sends the session to Jev and spends requests, so only the user decides; a project tunes the rest.
    enabled: source === "user" ? boolean(raw.enabled, base.enabled) : base.enabled,
    keepThreshold: probability(raw.keepThreshold, base.keepThreshold),
    maxSummaryTokens: Math.max(1000, positiveInteger(raw.maxSummaryTokens, base.maxSummaryTokens)),
    timeoutMs: Math.min(MAX_COMPACTION_TIMEOUT_MS, positiveInteger(raw.timeoutMs, base.timeoutMs)),
    maxRequests: positiveInteger(raw.maxRequests, base.maxRequests),
    skipProviders: globList(raw.skipProviders, base.skipProviders),
  };
}

function applyPrefs(base: PrefsConfig, raw: unknown): PrefsConfig {
  if (!isObject(raw)) return base;
  return { enabled: boolean(raw.enabled, base.enabled), inject: boolean(raw.inject, base.inject) };
}

/** The 1..90 and 0..900000 ranges are the caps of improve.ts; a value past either is refused here, not silently kept. */
function applyImprove(base: ImproveConfig, raw: unknown, warnings: string[]): ImproveConfig {
  if (!isObject(raw)) return base;
  const days = raw.days;
  const quietMs = raw.quietMs;
  const keptDays = typeof days === "number" && Number.isSafeInteger(days) && days >= 1 && days <= 90
    ? days
    : base.days;
  if (days !== undefined && keptDays !== days) warnings.push(`improve.days ${String(days)} is not a whole number of days from 1 to 90; ${base.days} is used`);
  const keptQuiet = typeof quietMs === "number" && Number.isFinite(quietMs) && quietMs >= 0 && quietMs <= 900000
    ? Math.trunc(quietMs)
    : base.quietMs;
  if (quietMs !== undefined && keptQuiet !== quietMs) warnings.push(`improve.quietMs ${String(quietMs)} is not a number of milliseconds from 0 to 900000; ${base.quietMs} is used`);
  return { days: keptDays, quietMs: keptQuiet };
}

function applyLearning(base: LearningConfig, raw: unknown): LearningConfig {
  if (!isObject(raw)) return base;
  return {
    patternAnalysis: boolean(raw.patternAnalysis, base.patternAnalysis),
    // 0 keeps every record: no pruning.
    retentionDays: typeof raw.retentionDays === "number" && Number.isSafeInteger(raw.retentionDays) && raw.retentionDays >= 0 ? raw.retentionDays : base.retentionDays,
    allowedRetentionDays: typeof raw.allowedRetentionDays === "number" && Number.isSafeInteger(raw.allowedRetentionDays) && raw.allowedRetentionDays >= 0 ? raw.allowedRetentionDays : base.allowedRetentionDays,
  };
}

function applyConscience(base: ConscienceConfig, raw: unknown): ConscienceConfig {
  if (!isObject(raw)) return base;
  const skillsRaw = isObject(raw.skills) ? raw.skills : undefined;
  const toolsRaw = isObject(raw.tools) ? raw.tools : undefined;
  const mode = isOption(skillsRaw?.mode, CONSCIENCE_SKILL_MODES) ? skillsRaw.mode : base.skills.mode;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    skills: {
      mode,
      exclude: Array.isArray(skillsRaw?.exclude) ? skillsRaw.exclude.filter((x: unknown) => typeof x === "string") : base.skills.exclude,
    },
    tools: {
      enabled: boolean(toolsRaw?.enabled, base.tools.enabled),
      exclude: Array.isArray(toolsRaw?.exclude) ? toolsRaw.exclude.filter((x: unknown) => typeof x === "string") : base.tools.exclude,
    },
    skipTools: Array.isArray(raw.skipTools) ? raw.skipTools.filter((x: unknown) => typeof x === "string") : base.skipTools,
    timeoutMs: Math.max(100, Math.min(10000, typeof raw.timeoutMs === "number" ? raw.timeoutMs : base.timeoutMs)),
    maxAssessments: Math.max(1, Math.min(10, typeof raw.maxAssessments === "number" ? raw.maxAssessments : base.maxAssessments)),
    maxNudges: Math.max(1, Math.min(5, typeof raw.maxNudges === "number" ? raw.maxNudges : base.maxNudges)),
    maxSkillBytes: Math.max(1024, Math.min(131072, typeof raw.maxSkillBytes === "number" ? raw.maxSkillBytes : base.maxSkillBytes)),
    maxLoadedBytes: Math.max(1024, Math.min(262144, typeof raw.maxLoadedBytes === "number" ? raw.maxLoadedBytes : base.maxLoadedBytes)),
    recommendThreshold: Math.max(0, Math.min(1, typeof raw.recommendThreshold === "number" ? raw.recommendThreshold : base.recommendThreshold)),
    advanceThreshold: Math.max(0, Math.min(1, typeof raw.advanceThreshold === "number" ? raw.advanceThreshold : base.advanceThreshold)),
    localTopK: Math.max(1, Math.min(256, typeof raw.localTopK === "number" ? Math.trunc(raw.localTopK) : base.localTopK)),
    localFloor: Math.max(0, Math.min(20, typeof raw.localFloor === "number" ? raw.localFloor : base.localFloor)),
  };
}

/**
 * Project files may tune the guards but cannot grant TypeSafe consent, change the mode, or raise budgets. The action
 * guard and security only get stricter: a value that would weaken them is ignored with one config warning.
 */
export function applyProjectOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  const warnings: string[] = removedKeyWarnings(raw, "project");
  const enabled = projectSwitch("enabled", raw.enabled, base.enabled, warnings);
  const guards = applyGuards(base, raw, base.timeoutMs, "project", warnings);
  return { ...base, enabled, ...guards, prefs: applyPrefs(base.prefs, raw.prefs), warnings: [...(base.warnings ?? []), ...warnings] };
}

export interface LoadOptions {
  cwd?: string;
  /** Project overrides are applied only when the caller vouches for the project (Pi's trust decision). */
  projectTrusted?: boolean;
  /** Host directories; defaults to `defaultHostDirs()`. */
  dirs?: HostDirs;
  /**
   * The project file as the session read it once at its start. A session that passes one never re-reads the file, so a
   * mid-run edit lands at the next session. Omitted, the file is read on every call, as a library caller expects.
   */
  projectRaw?: { value: unknown } | undefined;
  /** The user file, read once at session start the same way: an outside edit lands at the next session. */
  userRaw?: { value: unknown } | undefined;
}

/** The user file's content, read without applying anything: the session snapshot is taken from here. */
export function readUserConfigFile(dirs: HostDirs = defaultHostDirs()): unknown {
  return readJson(userConfigPath(dirs));
}

/** The project file's content, read without applying anything: the session snapshot is taken from here. */
export function readProjectConfig(cwd: string, dirs: HostDirs = defaultHostDirs()): unknown {
  return readJson(projectConfigPath(cwd, dirs));
}

/**
 * The checks a project file loosens compared with the user's own config. The project file cannot weaken the action guard
 * or security (those values are refused with a warning at load), so what is compared here is every other check it can
 * switch off, move a threshold on, or take a file out of.
 */
export interface LoosenedCheck {
  /** The check, named as `/warden status` names it. */
  name: string;
  /** How it loosens; absent when the project file simply switches the check off. */
  detail?: string;
}

/** How a project value loosens the check it tunes. */
export type ProjectKeyKind = "off" | "high" | "low" | "fewer" | "more" | "scale" | "none";

/** One key a project file can set: the check it loosens, and how; or why it is not a check. */
export interface ProjectKeyClass {
  kind: ProjectKeyKind;
  /** The check, named as `/warden status` names it; absent only when the key is not a check. */
  check?: string;
  /** What moves, as the line's detail names it (`threshold`, `UI files`). */
  label?: string;
  /** Loosest first, for a named option list. */
  order?: readonly string[];
  /** Why this key is not a check; required when kind is "none". */
  why?: string;
}

/**
 * Every key a project file can set, classified: a direction that loosens a check, or "none" with the reason it is not
 * one. A test walks every leaf of `defaultConfig()` in a project section and fails when a key has no row here, so a
 * config key added later cannot quietly loosen a check without being named in the session-start line.
 * The action guard and security rows that a project can only tighten (`projectProbability`, `projectSwitch`) are "none":
 * the loader refuses the looser value, so the notice has nothing to say about it.
 */
export const PROJECT_KEYS: Readonly<Record<string, ProjectKeyClass>> = {
  "stuck.enabled": { kind: "off", check: "stuck-check" },
  "stuck.minFailures": { kind: "high", check: "stuck-check", label: "failures needed" },
  "stuck.sameStrategy": { kind: "high", check: "stuck-check", label: "same-strategy threshold" },
  "stuck.churnThreshold": { kind: "high", check: "stuck-check", label: "churn threshold" },
  "stuck.cooldown": { kind: "high", check: "stuck-check", label: "cooldown" },
  "stuck.nudge": { kind: "off", check: "stuck-check", label: "nudge" },
  "stuck.repeatSteer": { kind: "off", check: "stuck-check", label: "repeat steer" },
  "stuck.evidence": { kind: "off", check: "stuck-check", label: "evidence" },
  "stuck.diffLimit": { kind: "low", check: "stuck-check", label: "diff limit" },
  "stuck.tailLimit": { kind: "low", check: "stuck-check", label: "tail limit" },
  "stuck.window": { kind: "none", why: "a cap on minFailures, which decides on its own" },

  "done.enabled": { kind: "off", check: "done-check" },
  "done.claimsDone": { kind: "high", check: "done-check", label: "claims-done threshold" },
  "done.nudge": { kind: "off", check: "done-check", label: "nudge" },
  "done.uiProof": { kind: "off", check: "done-check", label: "UI proof" },
  "done.uiFiles": { kind: "fewer", check: "done-check", label: "UI files" },
  "done.visualTools.commands": { kind: "more", check: "done-check", label: "visual commands" },
  "done.visualTools.commandWords": { kind: "more", check: "done-check", label: "visual command words" },
  "done.visualTools.tools": { kind: "more", check: "done-check", label: "visual tools" },
  "done.visualTools.images": { kind: "more", check: "done-check", label: "visual image types" },

  "cause.enabled": { kind: "off", check: "cause-check" },
  "cause.claimsCause": { kind: "high", check: "cause-check", label: "claims-cause threshold" },
  "cause.nudge": { kind: "off", check: "cause-check", label: "nudge" },
  "cause.windowDays": { kind: "low", check: "cause-check", label: "window days" },

  "slop.enabled": { kind: "off", check: "slop-check" },
  "slop.threshold": { kind: "high", check: "slop-check", label: "threshold" },
  "slop.prose.enabled": { kind: "off", check: "slop-check", label: "prose" },
  "slop.prose.threshold": { kind: "high", check: "slop-check", label: "prose threshold" },
  "slop.prose.trend": { kind: "high", check: "slop-check", label: "prose trend" },
  "slop.prose.minChars": { kind: "high", check: "slop-check", label: "prose minimum chars" },
  "slop.prose.audience": { kind: "none", why: "who the prose is written for, not a threshold" },

  "rules.enabled": { kind: "off", check: "rules-check" },
  "rules.threshold": { kind: "high", check: "rules-check", label: "threshold" },
  "rules.softThreshold": { kind: "high", check: "rules-check", label: "soft threshold" },
  "rules.fallback": { kind: "off", check: "rules-check", label: "fallback" },
  "rules.maxChars": { kind: "low", check: "rules-check", label: "rules text limit" },
  "rules.files": { kind: "fewer", check: "rules-check", label: "files" },
  "rules.exclude": { kind: "more", check: "rules-check", label: "excluded paths" },
  "rules.skip": { kind: "more", check: "rules-check", label: "skipped paths" },
  "rules.sensitivePaths": { kind: "fewer", check: "rules-check", label: "sensitive-path notes" },

  "rulesAtTurnStart.enabled": { kind: "none", why: "a project can only switch it on; switching it off is refused at load" },
  "rulesAtTurnStart.threshold": { kind: "none", why: "a project can only lower it, which names more rules" },

  "security.enabled": { kind: "none", why: "a project cannot switch security off; the value is refused at load" },
  "security.threshold": { kind: "none", why: "a project cannot raise the threshold; the value is refused at load" },
  "security.maskOutput": { kind: "none", why: "user file only: a repository must not unmask credentials" },
  "security.shareLinkParams": { kind: "none", why: "user file only: it excuses a share-link token" },

  "action.enabled": { kind: "none", why: "a project can only switch the guard on; switching it off is refused" },
  "action.tools": { kind: "none", why: "a project can only add guarded tools, which guards more" },
  "action.failOpen": { kind: "none", why: "a project cannot turn fail-open on; the value is refused" },
  "action.ask.enabled": { kind: "none", why: "a project can only switch the ask gate on" },
  "action.traceSample": { kind: "none", why: "how much trace-only signal is sampled, not a call decision" },
  "action.timeoutMs": { kind: "none", why: "user file only" },
  "action.irreversible.warn": { kind: "none", why: "a project cannot raise the warn threshold; the value is refused" },
  "action.irreversible.confirm": { kind: "none", why: "a project cannot raise the hold threshold; the value is refused" },
  "action.offTask.warn": { kind: "high", check: "off-task threshold", label: "warn threshold" },
  "action.intentMismatch": { kind: "high", check: "intent-mismatch notice", label: "threshold" },
  "action.visibleMismatch": { kind: "high", check: "intent-mismatch notice", label: "visible-action threshold" },
  "action.shouldProceed.threshold": { kind: "high", check: "should-proceed notice", label: "threshold" },
  "action.feedbackLog": { kind: "none", why: "the hold record, not a check" },
  "action.commandRules": { kind: "none", why: "user file only" },
  "action.commandDenyRules": { kind: "none", why: "user file only" },
  "action.exemptRules": { kind: "none", why: "user file only" },
  "action.pathRules": { kind: "none", why: "user file only" },
  "action.armingRules": { kind: "none", why: "user file only" },
  "action.escalationThreshold": { kind: "high", check: "escalation", label: "threshold" },
  "action.floor": { kind: "none", why: "user file only" },

  "context.enabled": { kind: "off", check: "context-check" },
  "context.tailMinChars": { kind: "none", why: "how output is trimmed, not a check" },
  "context.confidence": { kind: "none", why: "how a retention answer is trusted" },
  "context.duplicateMinChars": { kind: "none", why: "when an output counts as a repeat" },
  "context.recallTool": { kind: "none", why: "which tool recalls a stored output" },
  "context.formatConfidence": { kind: "none", why: "how a named output format is trusted" },
  "context.compactAppendix": { kind: "none", why: "an appendix after compaction" },
  "context.dedupeRuns": { kind: "none", why: "repeated outputs in one run" },
  "context.dedupeMessages": { kind: "none", why: "repeated outputs across messages" },
  "context.largeOutput.enabled": { kind: "off", check: "large-output notice" },
  "context.largeOutput.threshold": { kind: "high", check: "large-output notice", label: "threshold" },
  "context.filter.enabled": { kind: "none", why: "user file only: it sends whole outputs to the judge" },
  "context.filter.chunkChars": { kind: "none", why: "how a filtered output is chunked" },
  "context.filter.minScore": { kind: "none", why: "how a filtered chunk is scored" },
  "context.filter.maxKeptChars": { kind: "none", why: "how much of a filtered output is kept" },
  "context.filter.timeoutMs": { kind: "none", why: "the filter's own deadline" },

  "runaway.enabled": { kind: "off", check: "runaway stop" },
  "runaway.repeats": { kind: "high", check: "runaway stop", label: "text repeats" },
  "runaway.thinkingRepeats": { kind: "high", check: "runaway stop", label: "thinking repeats" },
  "runaway.minChars": { kind: "high", check: "runaway stop", label: "minimum chars" },
  "runaway.recover": { kind: "none", why: "what happens after a runaway stop, not the stop" },

  "notify.enabled": { kind: "off", check: "notify" },
  "notify.cooldownMs": { kind: "high", check: "notify", label: "cooldown" },
  "notify.command": { kind: "none", why: "user file only: a project never names a command" },

  "judge.cooldownMs": { kind: "high", check: "judge", label: "cooldown" },
  "judge.failuresBeforeCooldown": { kind: "low", check: "judge", label: "failures before cooldown" },

  "subagent.enabled": { kind: "off", check: "subagent triage" },
  "subagent.wake": { kind: "off", check: "subagent wake" },
  "subagent.observer": { kind: "off", check: "subagent observer" },
  "subagent.threshold": { kind: "high", check: "subagent wake", label: "threshold" },
  "subagent.cooldownMs": { kind: "high", check: "subagent wake", label: "cooldown" },

  "waste.enabled": { kind: "off", check: "waste note" },
  "waste.tip": { kind: "off", check: "waste tip" },
  "waste.every": { kind: "high", check: "waste note", label: "calls between notes" },
  "waste.sleep": { kind: "off", check: "waste sleep note" },
  "waste.paging": { kind: "off", check: "waste paging note" },
  "waste.search": { kind: "off", check: "waste search note" },
  "waste.recheck": { kind: "off", check: "waste recheck note" },

  "compaction.enabled": { kind: "none", why: "user file only: turning it on spends requests" },
  "compaction.keepThreshold": { kind: "none", why: "how much context is kept" },
  "compaction.maxSummaryTokens": { kind: "none", why: "the summary's size" },
  "compaction.timeoutMs": { kind: "none", why: "the compaction deadline" },
  "compaction.maxRequests": { kind: "none", why: "the compaction budget" },
  "compaction.skipProviders": { kind: "none", why: "which providers keep their own summary" },

  "prefs.enabled": { kind: "none", why: "standing preferences are context, not a check" },
  "prefs.inject": { kind: "none", why: "standing preferences are context, not a check" },

  enabled: { kind: "none", why: "a project can only switch pi-warden on; switching it off is refused" },
};

/** A config value by its dotted path. */
function valueAt(config: WardenConfig, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** A list value as the items a project file adds or leaves out; a map counts by its keys. */
function itemsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value !== null && typeof value === "object") return Object.keys(value);
  return [];
}

/** Every check `layered` loosens compared with `user`, in a stable order. Empty when the project file loosens nothing. */
export function loosenedChecks(user: WardenConfig, layered: WardenConfig): LoosenedCheck[] {
  const checks: LoosenedCheck[] = [];
  for (const [path, entry] of Object.entries(PROJECT_KEYS)) {
    if (entry.kind === "none") continue;
    const before = valueAt(user, path);
    const after = valueAt(layered, path);
    const name = entry.check!;
    if (entry.kind === "off") {
      if (before === true && after === false) checks.push({ name, ...(entry.label === undefined ? {} : { detail: entry.label }) });
      continue;
    }
    if (entry.kind === "high" || entry.kind === "low") {
      if (typeof before !== "number" || typeof after !== "number") continue;
      if (entry.kind === "high" ? after > before : after < before) checks.push({ name, detail: `${entry.label ?? "value"} ${before} → ${after}` });
      continue;
    }
    if (entry.kind === "scale") {
      const order = entry.order ?? [];
      const moved = order.indexOf(String(before)) > order.indexOf(String(after)) && order.includes(String(before)) && order.includes(String(after));
      if (moved) checks.push({ name, detail: `${entry.label ?? "mode"} ${String(before)} → ${String(after)}` });
      continue;
    }
    const lost = entry.kind === "fewer" ? itemsOf(before).filter(item => !itemsOf(after).includes(item)) : itemsOf(after).filter(item => !itemsOf(before).includes(item));
    if (lost.length) checks.push({ name, detail: `${entry.label ?? "entries"} ${entry.kind === "fewer" ? "left out" : "added"}: ${lost.join(", ")}` });
  }
  return checks;
}

/** The one line a session start shows for a loosened set: what the project file takes away, and from which file. */
export function loosenNotice(checks: readonly LoosenedCheck[], dirs: HostDirs = defaultHostDirs()): string {
  const items = checks.map(check => (check.detail === undefined ? check.name : `${check.name} (${check.detail})`));
  const verb = checks.every(check => check.detail === undefined) ? "switches off" : "loosens";
  return `This project's ${join(dirs.configDirName, PROJECT_CONFIG_FILE)} ${verb}: ${items.join(", ")}.`;
}

/** Where the last loosened set for a project is kept: beside the user config, keyed by the project path. */
export function loosenRecordPath(cwd: string, dirs: HostDirs = defaultHostDirs()): string {
  const project = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(dirname(userConfigPath(dirs)), "project-config", `${project}.json`);
}

/** The checks last recorded for this project; undefined when no record exists, it cannot be read, or it predates
 *  details (a names-only record is a different set, so the line shows once more after the upgrade). */
export function readLoosenRecord(cwd: string, dirs: HostDirs = defaultHostDirs()): LoosenedCheck[] | undefined {
  const raw = readJson(loosenRecordPath(cwd, dirs));
  if (raw?.version !== 2 || !Array.isArray(raw.loosened)) return undefined;
  const checks: LoosenedCheck[] = [];
  for (const item of raw.loosened) {
    if (!isObject(item) || typeof item.name !== "string") return undefined;
    if (item.detail !== undefined && typeof item.detail !== "string") return undefined;
    checks.push({ name: item.name, ...(typeof item.detail === "string" ? { detail: item.detail } : {}) });
  }
  return checks;
}

/** Records the loosened set now shown for this project, so the same set stays quiet until it changes. A read-only
 *  agent directory must not stop a session: the record is an optimisation, and an unwritable one shows the line again. */
export function writeLoosenRecord(cwd: string, checks: readonly LoosenedCheck[], dirs: HostDirs = defaultHostDirs()): void {
  try {
    writeFileAtomicSync(loosenRecordPath(cwd, dirs), `${JSON.stringify({ version: 2, loosened: checks.map(check => (check.detail === undefined ? { name: check.name } : { name: check.name, detail: check.detail })) }, null, 2)}\n`);
  } catch (error) {
    console.warn("pi-warden: could not record the loosened project checks:", error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

export function loadConfig(options: LoadOptions = {}): WardenConfig {
  const dirs = options.dirs ?? defaultHostDirs();
  let config = applyUserOverrides(defaultConfig(), options.userRaw ? options.userRaw.value : readJson(userConfigPath(dirs)));
  if (!options.cwd || !options.projectTrusted) return config;
  const project = options.projectRaw ? options.projectRaw.value : readProjectConfig(options.cwd, dirs);
  return applyProjectOverrides(config, project);
}

/** Reads only the user file, for editing and persisting consent. */
export function readUserConfig(dirs: HostDirs = defaultHostDirs()): Json {
  return readJson(userConfigPath(dirs)) ?? {};
}

export function writeUserConfig(raw: Json, dirs: HostDirs = defaultHostDirs()): string {
  const path = userConfigPath(dirs);
  writeFileAtomicSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return path;
}

/** Persists one top-level user setting without disturbing the rest of the file. */
export function setUserSetting(key: "typesafe" | "enabled" | "mode", value: boolean | WardenMode, dirs: HostDirs = defaultHostDirs()): string {
  return writeUserConfig({ ...readUserConfig(dirs), [key]: value }, dirs);
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
