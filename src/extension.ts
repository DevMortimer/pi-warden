import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MouseRegion } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { authState, createTypeSafe, describeAuth } from "pi-typesafe";
import type { TypeSafe } from "pi-typesafe";
import { ensureApiKey } from "pi-typesafe/ui";
import { backendHost, disclosureFor, judgeOptions, keyAvailable, resolveBackend } from "./backend.js";
import { ActionGuard } from "./action-guard.js";
import type { ToolCallRef } from "./action-guard.js";
import { ArmingTracker, unparseableArmingRules } from "./arming.js";
import * as configModule from "./config.js";
import { applyUserOverrides, defaultConfig, isMode, loadConfig, PACKAGE_NAME, projectConfigPath, readUserConfig, setUserSetting, userConfigPath, writeUserConfig } from "./config.js";
import type { WardenConfig, WardenMode } from "./config.js";
import { classifyToolResult, doneNudge, emptyEvidence, evaluateDone, finalAssistantText, formatDone, needsDoneCheck, recordOutcome as recordDoneOutcome } from "./done.js";
import type { RunEvidence } from "./done.js";
import { evaluateAction, formatVerdict, higher, inertPathRules, intentSteer, offTaskSteer, SLOP_LABELS, SteerRepeatWindow, steerReason, stripDataText, unknownExemptIds, writeSinkTargets } from "./guard.js";
import type { Level, PatternHit, PreviousAction, SlopSymptom, TaskMessage, Verdict } from "./guard.js";
import { commandOf } from "./tools.js";
import { formatHolds, HoldLedger, HoldLog, holdLogPath, outcomeNote, regretsAt, textRegrets } from "./holds.js";
import { initSchema, recordHold, recordOutcome, toHoldRecord } from "./learning.js";
import type { CallOutcome, CallRecord, OutcomeVia } from "./holds.js";
import { evaluateProse, proseNudge, ProseTrend, RESTATE_MIN_SENTENCES, RESTATE_SHARE, RestatementWindow, substantiveSentences } from "./prose.js";
import { compressOutput, duplicateNote, evaluateOutput, mergeOutput, outputKey, saveOutput, securityNotice } from "./output.js";
import type { OutputVerdict } from "./output.js";
import { classifyRecall, detectSearchTool, recallInstruction } from "./recall.js";
import type { SearchTool } from "./recall.js";
import { redact } from "./redact.js";
import { formatRules, pathNoteSteer, RulesGuard, rulesSteer } from "./rules.js";
import { detectNotifier, sendNotification } from "./notify.js";
import type { NotifierName } from "./notify.js";
import { formatRunaway, RunawayMonitor, runawayNudge } from "./runaway.js";
import { AttemptWindow, evaluateStuck, formatStuck, makeAttempt, resultFailed, stuckNudge } from "./stuck.js";
import { openTracePanel } from "./panel.js";
import { completeConfig, shapeWarning } from "./shape.js";
import type { ShapeResult } from "./shape.js";
import { ContextLedger, formatLedger } from "./saver.js";
import { formatWake, newReports, reportLabel, triageReport, WakePolicy } from "./subagent.js";
import type { PanelController, PanelUi } from "./panel.js";
import { actionDetails, doneDetails, proseDetails, rulesDetails, runawayDetails, stuckDetails, Trace } from "./trace.js";
import type { GuardName, TraceEntry } from "./trace.js";
import { DEFAULT_TEMPLATES, proseTokens, renderTemplate, statusWidget, TOKEN_NAMES } from "./widget.js";

export const disclosure = "With TypeSafe judgments enabled, pi-warden sends to api.typesafe.ai: your latest request and up to eight redacted prior user/assistant text messages for task context, plus a redacted, truncated summary of each guarded bash, write, or edit call before it runs, with the agent's own words from the message that makes the call (its stated plan); for a write or edit in a project with a rules file (pi-warden.md, the configured files, or README/CLAUDE/AGENTS as fallback), a larger redacted sample of the written content with the current file around each edit and the rule text; the last few tool calls and output tails when the agent keeps failing; the agent's final message when it reports completion without running checks; redacted tool-output samples for security and context saving (retention and output format); a redacted sample of an async subagent report that names a failure, a stop, or a question, with your latest request, when warden decides whether that report should wake the agent; and, on the first guarded call after your reply, the redacted summaries of the calls allowed in the previous turn, so Jev can say whether your reply regrets one of them. Compression and duplicate notes store an exact, owner-only copy in a temporary file on this machine; the hold feedback log stores tool names, pattern ids, scores, and outcomes (never commands) in an owner-only file under Pi's agent directory. Requests may incur charges. Secret redaction is best-effort. Results are model judgments, not proof or authorization; offline pattern checks stay active either way.";

const WIDGET = PACKAGE_NAME;
const CONFIRM_TEXT_LIMIT = 500;

/** Which guard spent the user's attention. The status line reports one count per guard. */
export type SteerGuard = "action" | "rules" | "security" | "stuck" | "done" | "prose" | "runaway" | "subagent";

interface Stats { inspected: number; judged: number; warned: number; held: number; approved: number; offPlan: number; offTask: number; slop: number; ruleChecks: number; ruleViolations: number; pathNotes: number; stuckChecks: number; stuck: number; doneChecks: number; unverified: number; proseChecks: number; proseNudges: number; runaway: number; errors: number; steers: number; steersSkipped: number; steerGuards: Partial<Record<SteerGuard, number>>; subagentReports: number; subagentWoken: number; restatements: number }
const freshStats = (): Stats => ({ inspected: 0, judged: 0, warned: 0, held: 0, approved: 0, offPlan: 0, offTask: 0, slop: 0, ruleChecks: 0, ruleViolations: 0, pathNotes: 0, stuckChecks: 0, stuck: 0, doneChecks: 0, unverified: 0, proseChecks: 0, proseNudges: 0, runaway: 0, errors: 0, steers: 0, steersSkipped: 0, steerGuards: {}, subagentReports: 0, subagentWoken: 0, restatements: 0 });

/**
 * One steer message can carry notes from more than one guard, so the per-guard numbers may add up to more than the
 * message count; the line says so instead of hiding it. Worst offender first: that is the number worth acting on.
 */
export function formatSteers(stats: { steers: number; steersSkipped: number; steerGuards: Partial<Record<SteerGuard, number>> }): string {
  if (!stats.steers && !stats.steersSkipped) return "Steers sent: 0.";
  const counts = Object.entries(stats.steerGuards).sort((a, b) => b[1]! - a[1]!) as Array<[SteerGuard, number]>;
  const reasons = counts.reduce((total, [, count]) => total + count, 0);
  const extra = reasons > stats.steers ? `; ${reasons - stats.steers} of them carried more than one reason` : "";
  const skipped = stats.steersSkipped ? `; ${stats.steersSkipped} recorded only (repeats or over the per-run budget)` : "";
  return `Steers sent: ${stats.steers} (${counts.map(([guard, count]) => `${guard} ${count}`).join(", ")}${extra})${skipped}.`;
}

function latestUserPrompt(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    return content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("\n");
  }
  return undefined;
}

/** Scope context only: approval still comes from latestUserPrompt, never from this history. */
function recentTaskContext(ctx: ExtensionContext): TaskMessage[] {
  const entries = ctx.sessionManager.getBranch();
  const messages: TaskMessage[] = [];
  let skippedLatestUser = false;
  for (let index = entries.length - 1; index >= 0 && messages.length < 8; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
    const { role, content } = entry.message;
    if (role === "user" && !skippedLatestUser) { skippedLatestUser = true; continue; }
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (text.trim()) messages.push({ role, text: redact(text).slice(0, 750) });
  }
  return messages.reverse();
}

/**
 * Tool calls of the assistant message being preflighted. Pi runs `tool_call` hooks for sibling calls one after another,
 * so judging them one request at a time costs one round trip per call; judging them together costs one round trip.
 */
export function siblingToolCalls(ctx: ExtensionContext): ToolCallRef[] {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role !== "assistant") return [];
    const content = entry.message.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap(part => part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string"
      ? [{ id: part.id, tool: part.name, input: (part.arguments ?? {}) as Record<string, unknown> }]
      : []);
  }
  return [];
}

/**
 * The agent's own words before the call: the text of the assistant message that carries it, or, when that message is
 * tool calls only, the latest assistant text since the user's prompt. Sent as `plan`; it explains the step and cannot approve it.
 */
export function assistantPlan(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role === "user") return undefined;
    if (entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("\n");
    if (text.trim()) return text.trim();
  }
  return undefined;
}

function activeMode(config: WardenConfig, hasUI: boolean): WardenMode {
  const env = process.env.PI_WARDEN_MODE?.trim();
  const mode = isMode(env) ? env : config.mode;
  return mode === "confirm" && !hasUI ? "steer" : mode;
}

function clip(text: string): string {
  return text.length <= CONFIRM_TEXT_LIMIT ? text : `${text.slice(0, CONFIRM_TEXT_LIMIT)}…`;
}

export function confirmMessage(verdict: Verdict): string {
  const { summary } = verdict;
  const lines: string[] = [];
  if (summary.command !== undefined) lines.push(clip(summary.command));
  if (summary.path !== undefined) lines.push(`${summary.tool} ${summary.path}${summary.location === "outside_project" ? " (outside the project)" : ""}${summary.exists === false ? " (new file)" : ""}`);
  if (summary.input !== undefined) lines.push(clip(summary.input));
  lines.push("", `Why: ${verdict.reasons.join("; ")}`);
  if (verdict.judgment) lines.push(`Jev: irreversible ${verdict.judgment.irreversible.toFixed(2)}, off-task ${verdict.judgment.offTask.toFixed(2)}, ${verdict.judgment.scope.replace(/_/g, " ")} (${verdict.judgment.model}, ${verdict.judgment.elapsedMs} ms)`);
  lines.push("Judgments are model output, not authorization. Yes runs the tool; No blocks it and tells the agent.");
  return lines.join("\n");
}

const SLOP_FIXES: Record<SlopSymptom, string> = {
  stub: "replace stubs, placeholders, and hard-coded fake data with the working implementation, or state in your reply exactly what is left unimplemented and why",
  comments: "delete comments that restate the code; keep only those that explain intent, constraints, or non-obvious behaviour",
  dead: "remove commented-out code, unused imports and variables, duplicated logic, and unreachable branches",
  hedging: "replace \"should work\", \"for now\", and TODOs without a plan with a definite statement or a concrete follow-up",
};

/** Names each symptom and its fix; repeats in the session turn the note into a standing rule. */
export function slopSteer(where: string, symptoms: readonly SlopSymptom[], counts: Record<SlopSymptom, number>): string {
  const named = symptoms.map(symptom => `${SLOP_LABELS[symptom]}${counts[symptom] >= 3 ? ` (${counts[symptom]}th time this session)` : ""}`).join("; ");
  const fixes = symptoms.map(symptom => SLOP_FIXES[symptom]).join("; ");
  const standing = symptoms.some(symptom => counts[symptom] >= 3) ? " Treat this as a standing rule for the rest of the session." : "";
  return `pi-warden: the content just written to ${where} has ${named}. Fix it in your next edit: ${fixes}.${standing}`;
}

/**
 * `completeConfig` in shape.ts fills sections an older config module lacks, but shape.ts can be the stale module too: the
 * 0.8 version knew nothing of `rules`, so a 0.9 extension read `config.rules.enabled` on undefined and every tool call
 * failed until Pi was restarted. The sections this build reads are therefore checked here as well, in the module that reads them.
 */
export function guardCurrentSections(result: ShapeResult): ShapeResult {
  const { config } = result;
  const missing = [...result.missing];
  if (typeof config.rules !== "object" || config.rules === null || !Array.isArray(config.rules.exclude)) {
    if (!missing.includes("rules")) missing.push("rules");
    config.rules = { enabled: false, threshold: 1, files: [], fallback: false, maxChars: 500, exclude: [], skip: [], sensitivePaths: {} };
  }
  if (typeof config.widget !== "object" || config.widget === null) {
    if (!missing.includes("widget")) missing.push("widget");
    config.widget = { ...defaultConfig().widget, enabled: false };
  }
  if (typeof config.widget.rules !== "string") config.widget = { ...config.widget, rules: DEFAULT_TEMPLATES.rules };
  // Same shape trap for the subagent section: 0.14 added it, and a stale shape module hands the config over without it.
  if (typeof config.subagent !== "object" || config.subagent === null || !Number.isFinite(config.subagent.threshold)) {
    if (!missing.includes("subagent")) missing.push("subagent");
    config.subagent = { enabled: false, wake: false, threshold: 1, cooldownMs: 0 };
  }
  if (typeof config.widget.subagent !== "string") config.widget = { ...config.widget, subagent: DEFAULT_TEMPLATES.subagent };
  return { config, missing };
}

/** Native Pi registration; importing the root library does not load this module. */
export default function wardenExtension(pi: ExtensionAPI): void {
  let client: TypeSafe | undefined;
  let budgetExhausted = false;
  let stats = freshStats();
  const widget = new Map<GuardName, string>();
  const trace = new Trace();
  let panel: PanelController | undefined;
  let lastUi: PanelUi | undefined;
  const actionGuard = new ActionGuard();
  // Arming rules: session-scoped state that correlates preparation edits with later commands.
  const arming = new ArmingTracker([]);
  const rulesGuard = new RulesGuard();
  // Hold feedback: what the user did after each judged call, the trace entry each label lands on, and the per-session log.
  const holds = new HoldLedger();
  initSchema();
  const learningIds = new Map<number, number>(); // holds.id -> learning.id
  // Prune learningIds when it grows large to prevent memory leaks
  function pruneLearningIds(): void {
    if (learningIds.size > 1000) {
      const entries = [...learningIds.entries()];
      learningIds.clear();
      // Keep only the most recent 500
      for (const [k, v] of entries.slice(-500)) learningIds.set(k, v);
    }
  }

  function summarizeContext(context?: readonly { role: string; text: string }[]): string | undefined {
    if (!context?.length) return undefined;
    return context.slice(-8).map(m => m.role + ": " + redact(m.text.slice(0, 200))).join("\n");
  }
  const traceOf = new WeakMap<CallRecord, TraceEntry>();
  let holdLog: HoldLog | undefined;
  // Allowed calls of the turn the user just replied to; the regret question about them rides the next action request.
  let regretCandidates: PreviousAction[] = [];
  let attempts = new AttemptWindow(defaultConfig().stuck.window);
  let evidence: RunEvidence = emptyEvidence();
  let doneNudged = false;
  const prose = new ProseTrend();
  const slopCounts: Record<SlopSymptom, number> = { stub: 0, comments: 0, dead: 0, hedging: 0 };
  const ledger = new ContextLedger();
  // Secrets already announced this session, by fingerprint: the same key read twice earns one banner and one steer.
  const secretsSeen = new Set<string>();
  // Subagent report entries already triaged, by session entry id; the wake window outlives one scan.
  const subagentSeen = new Set<string>();
  const wakePolicy = new WakePolicy(0);
  const runaway = new RunawayMonitor();
  // Runs stopped by the runaway guard for the current user prompt; the first one gets a recovery turn, later ones wait for the user.
  let runawayStops = 0;
  let pendingRunaway: { nudge: string; recover: boolean } | undefined;
  // Probed once per session, outside any tool_result handler; the footer under excerpts names this command.
  let searchTool: Promise<SearchTool> | undefined;
  // Desktop notifier, probed on first use; undefined after the probe means this machine has no route to the desktop.
  let notifier: Promise<NotifierName | undefined> | undefined;
  let lastNotifiedAt = 0;

  // A partially updated module graph can hand this build a config without the sections it expects; see shape.ts.
  let shapeReported = false;
  // An exemptRules id that names neither a built-in nor one of the user's own rules is inert; said once, not per call.
  let exemptReported = false;
  let inertReported = false;
  let unparseableReported = false;
  const configFor = (ctx: ExtensionContext | ExtensionCommandContext): WardenConfig => {
    const { config, missing } = guardCurrentSections(completeConfig(loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() })));
    if (missing.length && !shapeReported) {
      shapeReported = true;
      // A namespace read stays undefined (not a link error) when an older config module lacks the export.
      const text = shapeWarning(missing, (configModule as { CONFIG_SCHEMA?: number }).CONFIG_SCHEMA);
      if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
    }
    const unknownExempt = unknownExemptIds(config.action.exemptRules, config.action.commandRules, config.action.commandDenyRules, config.action.pathRules, config.action.armingRules);
    if (unknownExempt.length && !exemptReported) {
      exemptReported = true;
      const text = `warden: exemptRules names ${unknownExempt.join(", ")}, which match no built-in or user rule; those entries are inert`;
      if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
    }
    const inert = inertPathRules(config.action.pathRules, config.action.tools);
    if (inert.length && !inertReported) {
      inertReported = true;
      const text = `warden: path rules ${inert.join(", ")} can never fire with the current access/tools combination; check access polarity or add the tool to action.tools`;
      if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
    }
    const unparseable = unparseableArmingRules(config.action.armingRules);
    if (unparseable.length && !unparseableReported) {
      // Separate flag so an operator with both an inert path rule and a bad arming regex sees both warnings.
      unparseableReported = true;
      const text = `warden: arming rules ${unparseable.join(", ")} have an invalid command regex; the rules will never fire`;
      if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
    }
    arming.updateRules(config.action.armingRules);
    return config;
  };
  const consentGiven = (config: WardenConfig) => config.typesafe || process.env.PI_WARDEN_ENABLED === "1";
  const consentSource = (config: WardenConfig) => config.typesafe ? "/warden enable" : process.env.PI_WARDEN_ENABLED === "1" ? "PI_WARDEN_ENABLED" : undefined;
  /** A consent flag is not proof that judgments happen; check the key state for the chosen backend. */
  const judgeFor = (config: WardenConfig): TypeSafe | undefined => {
    if (!consentGiven(config) || budgetExhausted) return undefined;
    if (!keyAvailable(config.typesafeBackend, process.env, () => authState().usable)) return undefined;
    return client ??= createTypeSafe(judgeOptions(config));
  };
  const noteError = (ctx: ExtensionContext, message: string, code: string | undefined) => {
    stats.errors++;
    if (code === "budget") budgetExhausted = true;
    if (ctx.hasUI) ctx.ui.notify(`warden: ${message}${budgetExhausted ? " Pattern checks continue without TypeSafe for the rest of this session." : ""}`, "warning");
  };
  /** Click, shortcut, and /warden trace all toggle the same sidebar. */
  const togglePanel = (ui: PanelUi | undefined, config: WardenConfig) => {
    if (!ui) return;
    if (panel) { panel.close(); return; }
    const opened = openTracePanel(ui, trace, { width: config.widget.panelWidth });
    panel = opened;
    opened.closed.catch(() => undefined).finally(() => { if (panel === opened) panel = undefined; });
  };
  const paint = (ctx: ExtensionContext | ExtensionCommandContext, config: WardenConfig) => {
    if (!ctx.hasUI) return;
    lastUi = ctx.ui as unknown as PanelUi;
    if (!config.widget.enabled || widget.size === 0) { ctx.ui.setWidget(WIDGET, undefined); return; }
    const entries = [...widget].map(([guard, line]) => ({ guard, line }));
    // A custom component so the lines wrap to the pane and a click (fullscreen mode) opens the trace panel.
    ctx.ui.setWidget(WIDGET, (_tui, theme) => new MouseRegion(statusWidget(entries, theme), event => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      togglePanel(lastUi, config);
      return { handled: true };
    }), { placement: config.widget.placement });
  };
  const record = (ctx: ExtensionContext | ExtensionCommandContext, config: WardenConfig, guard: GuardName, line: string, details: string[]): TraceEntry => {
    widget.set(guard, line);
    const entry: TraceEntry = { at: Date.now(), guard, line, details };
    trace.push(entry);
    paint(ctx, config);
    return entry;
  };
  /** Labels landed on earlier calls: their trace entries say so and the session log is rewritten. */
  const noteOutcomes = (config: WardenConfig, records: readonly CallRecord[]) => {
    for (const item of records) {
      const entry = traceOf.get(item);
      if (entry) trace.amend(entry, outcomeNote(item));
    }
    if (config.action.feedbackLog && holds.records().length) void holdLog?.save(holds.records());
  };
  /** The user's reply was read for regret, by Jev or by the offline heuristic; the candidates are labelled once. */
  const settleRegret = (config: WardenConfig, result: { regretted: boolean; target?: string | undefined; probability?: number | undefined; via: OutcomeVia }) => {
    regretCandidates = [];
    noteOutcomes(config, holds.regret(result));
  };
  /** Every steer is counted against the guard that asked for it; the status line shows where the noise comes from. */
  const steerRepeats = new SteerRepeatWindow();
  /** Guards whose notices gate the run itself; they deliver even when the per-run steer budget is spent. */
  const CRITICAL_STEER_GUARDS: ReadonlySet<SteerGuard> = new Set(["stuck", "done", "runaway", "subagent"]);
  let steersThisRun = 0;
  /** The final messages of the current run, for restatement measurement. */
  const finals = new RestatementWindow();
  /** Returns true when the message was delivered; false means it was recorded in the trace only. */
  const steer = (config: WardenConfig, guard: SteerGuard | readonly SteerGuard[], content: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean; display?: boolean }): boolean => {
    const names = typeof guard === "string" ? [guard] : [...guard];
    for (const name of names) stats.steerGuards[name] = (stats.steerGuards[name] ?? 0) + 1;
    const critical = names.every(name => CRITICAL_STEER_GUARDS.has(name));
    const overBudget = config.steerBudget > 0 && steersThisRun >= config.steerBudget;
    // A notice delivered once is already in the agent's context. Sending the repeat again costs the accounting turn it
    // forbids, so repeats are recorded only. The same goes for notices past the per-run steer budget: every delivered
    // steer costs at least one LLM turn, and a closing run that collects six notices collects six restatements of the
    // final status. A notice skipped for the budget keeps its fingerprint, so the same notice can deliver next run.
    // Critical guards (stuck, done, runaway recovery, subagent wake) always deliver: their message starts the turn.
    const deliver = critical || (!overBudget && !steerRepeats.seen(content));
    if (!deliver) {
      stats.steersSkipped++;
      return false;
    }
    stats.steers++;
    steersThisRun++;
    const { display, ...delivery } = options ?? { deliverAs: "steer" as const };
    pi.sendMessage({ customType: `${PACKAGE_NAME}-steer`, content, display: display ?? config.steerVisible }, delivery);
    return true;
  };
  /**
   * Desktop notification for a moment that needs the user back at the terminal. Interactive sessions only: a headless run
   * or a subagent has nobody to call, and several of them would flood the desktop. Fire-and-forget; failures are silent.
   */
  const notifyDesktop = (ctx: ExtensionContext, config: WardenConfig, body: string) => {
    if (!ctx.hasUI || !config.notify.enabled) return;
    const now = Date.now();
    if (now - lastNotifiedAt < config.notify.cooldownMs) return;
    lastNotifiedAt = now;
    if (config.notify.command.length) { void sendNotification(config.notify.command, { title: "pi-warden", body }).catch(() => false); return; }
    notifier ??= detectNotifier();
    void notifier.then(name => (name ? sendNotification(name, { title: "pi-warden", body }) : false)).catch(() => false);
  };

  /**
   * Async subagent reports are custom messages that Pi appends to the agent's context itself, so warden cannot hold them
   * back. What it can do is read them when the agent has gone idle and decide whether one deserves a wake: a report with
   * no failure, blocker, or question costs no request and wakes nobody. Silent reports still leave one trace line.
   */
  const checkSubagentReports = async (ctx: ExtensionContext, config: WardenConfig) => {
    if (!config.enabled || !config.subagent.enabled) return;
    const reports = newReports(ctx.sessionManager.getBranch(), subagentSeen);
    if (!reports.length) return;
    for (const report of reports) subagentSeen.add(report.id);
    stats.subagentReports += reports.length;
    wakePolicy.cooldownMs = config.subagent.cooldownMs;
    const judge = config.subagent.wake ? judgeFor(config) : undefined;
    const task = latestUserPrompt(ctx);
    const batch: string[] = [];
    for (const report of reports) {
      const verdict = await triageReport(report, { config: config.subagent, judge, timeoutMs: config.timeoutMs, signal: ctx.signal, task });
      const label = reportLabel(report);
      record(ctx, config, "subagent", renderTemplate(config.widget.subagent, {
        agent: label, kind: report.customType, wake: verdict.wake ? "wake" : "silent",
        status: verdict.source === "error" ? "judgment failed; stayed quiet" : verdict.wake ? "woke the agent" : "appended silently",
      }), [
        `report: ${report.customType}, ${report.text.length} chars, ${verdict.source} (${verdict.reason})`,
        `agent told: ${verdict.wake ? "woken with a pointer to this report" : "nothing; the report is in context and warden stayed quiet"}`,
      ]);
      if (!verdict.wake) continue;
      const queued = wakePolicy.offer(label);
      if (queued) batch.push(...queued);
    }
    if (batch.length) {
      stats.subagentWoken += batch.length;
      steer(config, "subagent", formatWake(batch), { deliverAs: "followUp", triggerTurn: true });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    client = undefined;
    budgetExhausted = false;
    stats = freshStats();
    widget.clear();
    trace.clear();
    panel?.close();
    actionGuard.reset();
    rulesGuard.reset();
    holds.reset();
    regretCandidates = [];
    holdLog = new HoldLog(holdLogPath(typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : String(process.pid)));
    arming.reset();
    attempts.reset();
    evidence = emptyEvidence();
    doneNudged = false;
    prose.reset();
    ledger.reset();
    secretsSeen.clear();
    subagentSeen.clear();
    wakePolicy.reset();
    steerRepeats.reset();
    steersThisRun = 0;
    finals.reset();
    runaway.reset();
    runawayStops = 0;
    pendingRunaway = undefined;
    searchTool = undefined;
    notifier = undefined;
    lastNotifiedAt = 0;
    for (const symptom of Object.keys(slopCounts) as SlopSymptom[]) slopCounts[symptom] = 0;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  });

  // A new user prompt starts a new attempt history, a new steer budget, and a new restatement window; answering the
  // user is never a restatement.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = configFor(ctx);
    attempts = new AttemptWindow(config.stuck.window);
    doneNudged = false;
    steersThisRun = 0;
    finals.reset();
    runaway.reset();
    runawayStops = 0;
    pendingRunaway = undefined;
    actionGuard.turnEnd();
    rulesGuard.turnEnd();
    // Holds the user never approved are re-plans now; last turn's allowed calls wait for the regret question.
    noteOutcomes(config, holds.promptArrived());
    regretCandidates = holds.candidates();
    if (regretCandidates.length && !judgeFor(config)) settleRegret(config, { regretted: textRegrets(event.prompt), via: "text" });
  });

  // Each assistant message is judged on its own; Pi does not forward the stream's own "start" event, so this is the reset.
  pi.on("message_start", async event => {
    if (event.message.role === "assistant") runaway.reset();
  });

  // Per token this only appends to a buffer; every 256 characters the buffer is checked for identical blocks, with code only.
  pi.on("message_update", async (event, ctx) => {
    const kind = runaway.feed(event.assistantMessageEvent);
    if (!kind || runaway.stopped) return;
    const config = configFor(ctx);
    if (!config.enabled || !config.runaway.enabled) return;
    const verdict = runaway.check(kind, config.runaway);
    if (!verdict) return;
    stats.runaway++;
    runawayStops++;
    const recover = config.runaway.recover && runawayStops === 1;
    const nudge = runawayNudge(verdict, recover);
    pendingRunaway = { nudge, recover };
    record(ctx, config, "runaway", formatRunaway(verdict, recover, config.widget.runaway), runawayDetails(verdict, nudge, recover));
    if (ctx.hasUI) ctx.ui.notify(`warden · runaway: the same ${verdict.kind} block repeated ${verdict.count} times in ${verdict.chars} chars; run stopped${recover ? " (agent gets one follow-up turn)" : " (not restarted: second time for this prompt)"}`, "error");
    notifyDesktop(ctx, config, `Runaway stopped: the same ${verdict.kind} block repeated ${verdict.count} times. ${recover ? "The agent gets one recovery turn." : "Second time for this prompt; the agent is waiting for you."}`);
    // Interactive Pi restores the user's queued messages to the editor before aborting; the follow-up is queued in agent_end, after that.
    ctx.abort();
  });

  // Each low-level run collects its own evidence of changes and checks.
  pi.on("agent_start", async () => {
    evidence = emptyEvidence();
  });

  // Every turn that runs after a compression is a turn that did not carry the removed text.
  pi.on("turn_end", async () => {
    ledger.turnEnd();
    actionGuard.turnEnd();
    rulesGuard.turnEnd();
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled) return;
    // A read of a stored full output means the excerpt was not enough; that is the number that tunes context.confidence.
    // A whole-file read also undoes the saving, so the kind of access is kept apart.
    const serializedInput = JSON.stringify(event.input);
    const storedPath = ledger.storedPathIn(serializedInput);
    if (storedPath) {
      const kind = classifyRecall(event.toolName, event.input, storedPath);
      const recalled = ledger.noteAccess(serializedInput, kind);
      if (recalled) record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: `full output recalled (${kind})` }), [`the agent went back to ${recalled} (${kind === "full" ? "whole-file read" : "scoped access"})`, formatLedger(ledger.snapshot())]);
    }
    if (!config.action.enabled || !config.action.tools.includes(event.toolName)) return;
    stats.inspected++;
    // Arming: a write/edit to a protected path arms matching command patterns for a window. Bash redirect/tee
    // targets that match a when.edited glob also arm. This is session state, not a per-call verdict — it runs
    // before the action guard so the armed check on a later command sees the preparation.
    if (config.action.armingRules.length > 0) {
      const inputPath = typeof (event.input as Record<string, unknown>).path === "string" ? (event.input as Record<string, unknown>).path as string : undefined;
      const armCmd = commandOf(event.toolName, event.input as Record<string, unknown>)?.command;
      // Parity with checkArmed: strip data text before extracting write-sink targets so a redirect
      // mentioned inside a data heredoc (no shell sink) does not arm, but a real redirect in an executed
      // heredoc or plain command does.
      const sinks = armCmd ? writeSinkTargets(stripDataText(armCmd).text) : undefined;
      arming.arm(event.toolName, inputPath, ctx.cwd, sinks);
    }
    const task = latestUserPrompt(ctx);
    const judge = judgeFor(config);
    const siblings = siblingToolCalls(ctx);
    const call = { id: event.toolCallId, tool: event.toolName, input: event.input };
    // The rules request carries the written content and the rule text, so it goes out beside the action request, not inside it.
    const rulesCheck = config.rules.enabled && (event.toolName === "write" || event.toolName === "edit")
      ? rulesGuard.inspect(call, siblings, { cwd: ctx.cwd, config: config.rules, judge, timeoutMs: config.timeoutMs, signal: ctx.signal })
      : undefined;
    rulesCheck?.catch(() => undefined);
    const verdict = await actionGuard.inspect(
      call,
      { task, context: recentTaskContext(ctx), siblings, plan: assistantPlan(ctx) },
      { config: config.action, cwd: ctx.cwd, judge, signal: ctx.signal, slop: config.slop, security: config.security, previousActions: regretCandidates.length ? regretCandidates : undefined },
    );
    if (verdict.source === "skipped") return;
    // Arming check: if any armed rule's command regex matches this call, inject a hit into the verdict.
    // The hit is deterministic — it fires regardless of Jev. But to avoid spending a judge request on a call whose
    // outcome is already decided by the armed hit, the armed check runs before the action guard when armed rules
    // exist, and if it produces a deny/confirm/hold verdict, the judge is skipped entirely (fix 11).
    const cmd = commandOf(event.toolName, event.input as Record<string, unknown>)?.command;
    const armedHits = cmd && config.action.armingRules.length > 0 ? arming.checkArmed(cmd) : [];
    // Fix 3: exemptRules can silence an armed rule by raw id (the injected id is `armed:<id>`, but the user wrote <id>).
    const visibleArmedHits = armedHits.filter(hit => !config.action.exemptRules.includes(hit.id));
    if (visibleArmedHits.length > 0) {
      // Build the verdict from patterns alone — no judge request (fix 11). The deny/confirm/hold plumbing handles it.
      const armedPatterns: PatternHit[] = [];
      const armedReasons: string[] = [];
      let armedLevel: Level = "allow";
      for (const hit of visibleArmedHits) {
        const action = hit.action;
        // Fix 1: hold → destructive severity + action:"hold" (steer-mode hold semantics, same as commandRules action:"hold");
        // confirm → destructive + action:"dialog"; block → deny. The old code mapped hold to risky→warn, a no-op.
        const severity = action === "block" ? "deny" : "destructive";
        const patternHit: PatternHit = {
          id: `armed:${hit.id}`,
          severity,
          label: hit.message ?? `armed rule ${hit.id}`,
          ...(action === "confirm" ? { action: "dialog" as const } : action === "hold" ? { action: "hold" as const } : {}),
          ...(hit.message ? { message: hit.message } : {}),
        };
        armedPatterns.push(patternHit);
        // Fix 8: armed confirm dialog names the files that armed it.
        const armedBy = hit.armedByPaths.length > 0 ? ` (armed by: ${hit.armedByPaths.join(", ")})` : "";
        if (severity === "deny") { armedLevel = "deny"; armedReasons.push(`${hit.message ?? `armed rule ${hit.id}`}${armedBy}`); }
        else if (severity === "destructive") { armedLevel = higher(armedLevel, "confirm"); armedReasons.push(`armed: ${hit.message ?? hit.id}${armedBy}`); }
      }
      // Merge the armed patterns into the existing verdict (the action guard may have produced one too).
      verdict.patterns.push(...armedPatterns);
      verdict.level = higher(verdict.level, armedLevel);
      verdict.reasons.push(...armedReasons);
      // Fix 6: armed hits on read-only commands still record a trace line (bypass the read-only source gate).
      if (verdict.source === "read-only") verdict.source = "pattern";
    }
    if (regretCandidates.length && verdict.judgment?.regretted !== undefined) {
      settleRegret(config, { regretted: regretsAt(verdict.judgment.regretted), target: verdict.judgment.regretTarget, probability: verdict.judgment.regretted, via: "jev" });
    }
    // Notes for the agent about the content it just wrote: slop, rule violations, and sensitive paths arrive as one message.
    const notes: string[] = [];
    const noteGuards = new Set<SteerGuard>();
    /** Sensitive-path notes ride with the combined steer for this call; their trace waits for the delivery result. */
    const pathNoteTraces: Array<(delivered: boolean) => void> = [];
    if (verdict.judgment?.securityRisk !== undefined && verdict.judgment.securityRisk >= config.security.threshold) {
      steer(config, "security", "pi-warden: the proposed write may introduce a security weakness. Check for embedded credentials, disabled TLS, unsafe command/SQL interpolation, broad permissions, or bypassed verification; use a safe implementation instead.");
    }
    if (verdict.judgment) stats.judged++;
    if (verdict.source === "error") noteError(ctx, verdict.error ?? "TypeSafe request failed.", verdict.errorCode);
    const mode = activeMode(config, ctx.hasUI);
    if (verdict.approvedByUser) {
      stats.approved++;
      const released = holds.approved(event.toolName);
      if (released) {
        noteOutcomes(config, [released]);
        const learningId = learningIds.get(released.id);
        if (learningId) recordOutcome(learningId, "approved");
      }
    }
    const told = verdict.level === "confirm" && mode === "steer" ? steerReason(verdict, { canApprove: judge !== undefined }) : undefined;
    // SAFETY: verdict.source is a string union; the read-only → pattern rewrite above may have narrowed it in TS's view,
    // but the field is still one of the source values at runtime when no armed hits fired.
    const entry = (verdict.source as string) !== "read-only" ? record(ctx, config, "action", formatVerdict(verdict, config.widget.action), actionDetails(verdict, { mode, ...(told ? { told } : {}) })) : undefined;
    // What happens to this call is the label for its scores; a decision made in the dialog lands at once, a steer-mode hold waits for the user.
    const track = (held: boolean, outcome?: CallOutcome, via?: OutcomeVia) => {
      if (!entry) return;
      const recordOpts: Parameters<typeof holds.record>[1] = { held, mode, outcome, via };
      if (task) recordOpts.task = task;
      if (verdict.plan) recordOpts.plan = verdict.plan;
      const ctxSummary = summarizeContext(recentTaskContext(ctx));
      if (ctxSummary) recordOpts.contextSummary = ctxSummary;
      if (held) recordOpts.agentReason = steerReason(verdict, { canApprove: judge !== undefined });
      const item = holds.record(verdict, recordOpts);
      traceOf.set(item, entry);
      noteOutcomes(config, outcome ? [item] : []);
      // Record to SQLite for learning
      if (held) {
        const id = recordHold(toHoldRecord(
          { at: item.at, tool: item.tool, level: item.level, reasons: item.reasons, scores: item.scores },
          ctx.cwd,
          { task, plan: verdict.plan, contextSummary: ctxSummary, agentReason: steerReason(verdict, { canApprove: judge !== undefined }) },
        ));
        learningIds.set(item.id, id);
        if (outcome) recordOutcome(id, outcome);
        pruneLearningIds();
      }
    };
    // The warn notice below names the mismatch to the user; the agent gets the steer with the other notes.
    if (verdict.intentMismatch) {
      stats.offPlan++;
      noteGuards.add("action");
      notes.push(intentSteer(verdict));
    }
    if (verdict.offTaskSteer) {
      stats.offTask++;
      noteGuards.add("action");
      notes.push(offTaskSteer(verdict));
    }
    if (verdict.slopSymptoms?.length && verdict.slopReasons) {
      stats.slop++;
      noteGuards.add("action");
      for (const symptom of verdict.slopSymptoms) slopCounts[symptom]++;
      const where = verdict.summary.path ?? event.toolName;
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · slop · ${where}: ${verdict.slopReasons.join("; ")}`, "warning");
      notes.push(slopSteer(where, verdict.slopSymptoms, slopCounts));
    }
    if (rulesCheck) {
      const rules = await rulesCheck;
      if (rules.source !== "skipped") {
        stats.ruleChecks++;
        if (rules.error) noteError(ctx, rules.error, rules.errorCode);
        const told = rules.findings.length ? rulesSteer(rules, rulesGuard.count(rules)) : undefined;
        record(ctx, config, "rules", formatRules(rules, config.widget.rules), rulesDetails(rules, told));
        holds.recordRules({ source: rules.source, path: rules.path, findings: rules.findings.map(f => ({ name: f.name, violation: f.violation })), ...(rules.error ? { error: rules.error } : {}) });
        if (told) {
          stats.ruleViolations++;
          noteGuards.add("rules");
          if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · rules · ${rules.path}: ${rules.findings.map(finding => `${finding.name} (${finding.violation.toFixed(2)})`).join("; ")}`, "warning");
          notes.push(told);
        }
      }
      const hits = rulesGuard.notesFor(verdict.summary.location === "inside_project" ? verdict.summary.path : undefined, config.rules.sensitivePaths);
      if (hits.length && verdict.summary.path) {
        stats.pathNotes++;
        const told = pathNoteSteer(verdict.summary.path, hits);
        // A repeat or a spent steer budget records the note without the agent reading it again, so the trace waits
        // for the combined steer's delivery result instead of claiming the agent was told.
        pathNoteTraces.push((delivered: boolean) => {
          record(ctx, config, "rules", renderTemplate(config.widget.rules, { tool: event.toolName, path: verdict.summary.path, violations: `sensitive path ${hits.map(hit => hit.glob).join(", ")}`, status: "note" }), [`${event.toolName} ${verdict.summary.path} matches ${hits.map(hit => hit.glob).join(", ")} in rules.sensitivePaths`, delivered ? `agent told: ${told}` : `steer recorded, not delivered (a repeat or the per-run budget): ${told}`]);
          if (delivered && ctx.hasUI && config.notices) ctx.ui.notify(`warden · sensitive path · ${verdict.summary.path} (${hits.map(hit => hit.glob).join(", ")}); the agent was given the note`, "warning");
        });
        noteGuards.add("rules");
        notes.push(told);
      }
    }
    if (notes.length) {
      const delivered = steer(config, [...noteGuards], notes.join("\n\n"));
      for (const traceNote of pathNoteTraces) traceNote(delivered);
      pathNoteTraces.length = 0;
    }
    const warnSteer = (label: string) => steer(config, "action", `pi-warden: this ${event.toolName} call ran with a warning (${label}). Nobody sees this in a headless run, so it is on you: if the flagged risk is expected, continue; otherwise fix it or ask the user before building on it.`);
    if (verdict.level === "warn") {
      stats.warned++;
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · ${event.toolName}: ${verdict.reasons.join("; ")}`, "warning");
      else if (!ctx.hasUI) warnSteer(verdict.reasons.join("; "));
      track(false);
      return undefined;
    }
    if (verdict.level === "deny") {
      stats.held++;
      track(true, "declined", "deny");
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · blocked ${event.toolName}: ${verdict.reasons.join("; ")}`, "error");
      notifyDesktop(ctx, config, `Blocked ${event.toolName}: ${verdict.reasons.join("; ")}. A deny rule matched; the call never ran.`);
      return { block: true, reason: `pi-warden blocked this ${event.toolName} call (${verdict.reasons.join("; ")}). A deny rule matched; this command is not allowed to run. Ask the user if this is genuinely required.` };
    }
    if (verdict.level !== "confirm") { track(false); return undefined; }

    const reasons = verdict.reasons.join("; ");
    // A user-defined confirm rule prompts the user in every mode, advise included: the operator wrote the rule to be
    // asked. Advise mode keeps Jev holds advisory; it does not soften a prompt the operator asked for by name.
    // The action defaults to dialog at parse time (the reason one writes such a rule); hold restores steer semantics.
    const dialogRule = verdict.patterns.some(hit => hit.action === "dialog");
    if (dialogRule && ctx.hasUI) {
      notifyDesktop(ctx, config, `Waiting for you: allow this ${event.toolName} call? ${reasons}`);
      const allowed = await ctx.ui.confirm(`warden: allow this ${event.toolName} call?`, confirmMessage(verdict), ctx.signal ? { signal: ctx.signal } : {});
      if (allowed) { track(true, "approved", "dialog"); return undefined; }
      stats.held++;
      track(true, "declined", "dialog");
      return { block: true, reason: `pi-warden: the user declined this ${event.toolName} call (${reasons}). Do not retry it unchanged; ask the user how to proceed.` };
    }
    if (mode === "advise") {
      stats.warned++;
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · ${event.toolName} (advise mode, not held): ${reasons}`, "warning");
      else if (!ctx.hasUI) warnSteer(reasons);
      track(false);
      return undefined;
    }
    if (mode === "confirm") {
      notifyDesktop(ctx, config, `Waiting for you: allow this ${event.toolName} call? ${reasons}`);
      const allowed = await ctx.ui.confirm(`warden: allow this ${event.toolName} call?`, confirmMessage(verdict), ctx.signal ? { signal: ctx.signal } : {});
      if (allowed) { track(true, "approved", "dialog"); return undefined; }
      stats.held++;
      track(true, "declined", "dialog");
      return { block: true, reason: `pi-warden: the user declined this ${event.toolName} call (${reasons}). Do not retry it unchanged; ask the user how to proceed.` };
    }
    stats.held++;
    actionGuard.hold(task);
    track(true);
    if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · held ${event.toolName}: ${reasons}. The agent was told why and asked to re-plan or ask you.`, "warning");
    notifyDesktop(ctx, config, `Held ${event.toolName}: ${reasons}. The agent will re-plan or ask you in chat.`);
    return { block: true, reason: told ?? steerReason(verdict, { canApprove: judge !== undefined }) };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled) return;
    const textBlocks = event.content.filter(part => part.type === "text");
    const text = textBlocks.map(part => part.text).join("\n");
    // Repeat detection uses the original result, so its request goes out together with the output check.
    const failed = resultFailed(event.isError, event.details, event.content);
    const stuckCheck = (() => {
      if (!config.stuck.enabled) return undefined;
      attempts.push(makeAttempt(event.toolName, event.input, event.content, failed));
      if (!attempts.shouldJudge(config.stuck)) return undefined;
      stats.stuckChecks++;
      return evaluateStuck(attempts, latestUserPrompt(ctx), { config: config.stuck, judge: judgeFor(config), timeoutMs: config.timeoutMs, signal: ctx.signal });
    })();
    // A recall brings stored text back on purpose: it is not judged, compressed, or dropped again.
    const recallRead = ledger.storedPathIn(JSON.stringify(event.input)) !== undefined;
    // Duplicate detection is code only: an identical result adds nothing, whatever Jev would say about it.
    const key = config.context.enabled && !recallRead && textBlocks.length === 1 && text.length >= config.context.duplicateMinChars ? outputKey(text) : undefined;
    const earlier = key ? ledger.duplicateOf(key) : undefined;
    // A multi-block result is judged per text block: each block earns its own retention and banner, and the merged
    // verdict feeds the session bookkeeping below. A block below both thresholds spends no request; its credential
    // scan still runs offline.
    const multiBlock = textBlocks.length > 1 && !earlier && !recallRead;
    const blockVerdicts: OutputVerdict[] = [];
    let output: OutputVerdict;
    if (earlier || recallRead) {
      output = { secret: false, suspicious: false, retention: "all" };
    } else if (multiBlock) {
      for (const blockText of textBlocks.map(part => part.text ?? "")) {
        if (ctx.signal?.aborted) break;
        blockVerdicts.push(await evaluateOutput(event.toolName, blockText, latestUserPrompt(ctx), {
          security: config.security, context: config.context, judge: judgeFor(config), timeoutMs: config.timeoutMs,
          signal: ctx.signal, compressible: true, taskContext: recentTaskContext(ctx),
        }));
      }
      output = mergeOutput(blockVerdicts);
    } else {
      output = await evaluateOutput(event.toolName, text, latestUserPrompt(ctx), {
        security: config.security, context: config.context, judge: judgeFor(config), timeoutMs: config.timeoutMs,
        signal: ctx.signal, compressible: true, taskContext: recentTaskContext(ctx),
      });
    }
    if (ctx.signal?.aborted) return;
    if (output.error) noteError(ctx, output.error, output.errorCode);
    let content = event.content;
    // A credential-shaped value the agent has already been warned about this session is traced, not announced again.
    // Per value, not per set: masking one value or a changed subset must not re-announce the rest.
    const secretValues = output.secretIds ?? (output.secret && output.secretId !== undefined ? [output.secretId] : []);
    const unseenSecrets = secretValues.filter((id) => !secretsSeen.has(id));
    const secretRepeat = output.secret && secretValues.length > 0 && unseenSecrets.length === 0;
    // Per-block banners are computed before secretsSeen is updated, so a block whose values were all announced
    // earlier stays quiet while a block with a new value earns the banner.
    const blockNotices = multiBlock ? blockVerdicts.map(verdict => {
      const values = verdict.secretIds ?? (verdict.secret && verdict.secretId !== undefined ? [verdict.secretId] : []);
      const repeat = verdict.secret && values.length > 0 && values.every(id => secretsSeen.has(id));
      return securityNotice(repeat ? { ...verdict, secret: false } : verdict);
    }) : [];
    if (unseenSecrets.length) for (const id of unseenSecrets) secretsSeen.add(id);
    const notice = multiBlock ? blockNotices.find(banner => banner !== undefined) : securityNotice(secretRepeat ? { ...output, secret: false } : output);
    // Fixture and documentation stand-ins (`devtok_`, `sk-synthetic-`, an alphabet run) earn one trace line and nothing else:
    // no banner in the result and no steer. Most credential steers in the benchmark were these values read from a test file.
    const unseenSynthetic = (output.syntheticIds ?? []).filter((id) => !secretsSeen.has(id));
    if (unseenSynthetic.length) {
      for (const id of unseenSynthetic) secretsSeen.add(id);
      record(ctx, config, "security", renderTemplate(config.widget.security, { tool: event.toolName, injection: output.injection?.toFixed(2), exfiltration: output.exfiltration?.toFixed(2), status: "credential-shaped stand-in (traced)" }), [
        `${unseenSynthetic.length} credential-shaped value${unseenSynthetic.length === 1 ? "" : "s"} in this output match a test fixture or a documented example; traced once, never announced`,
      ]);
    }
    if (secretRepeat && !output.suspicious) {
      record(ctx, config, "security", renderTemplate(config.widget.security, { tool: event.toolName, injection: output.injection?.toFixed(2), exfiltration: output.exfiltration?.toFixed(2), status: "possible credentials (seen before)" }), [
        `the same credential-shaped value${output.secretId ? ` (${output.secretId})` : ""} was already announced this session; no banner or steer this time`,
      ]);
    }
    const recallTool = await (searchTool ??= detectSearchTool(config.context.recallTool));
    let storedPath: string | undefined;
    if (earlier && key) {
      try {
        storedPath = earlier.path ?? await saveOutput(text);
        const replacement = `${duplicateNote(text, earlier.tool)}\n\n${recallInstruction(recallTool, storedPath)}`;
        const bytesSaved = Buffer.byteLength(text) - Buffer.byteLength(replacement);
        if (bytesSaved > 0) {
          content = content.map(part => part.type === "text" ? { ...part, text: replacement } : part);
          ledger.duplicate(bytesSaved);
          ledger.remember(key, earlier.tool, storedPath);
          record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: "duplicate", bytesSaved: String(bytesSaved) }), [
            `identical to an earlier ${earlier.tool} result; saved ${bytesSaved} bytes; full output: ${storedPath}`,
            formatLedger(ledger.snapshot()),
          ]);
        }
      } catch {
        noteError(ctx, "Could not store full output; keeping it unchanged.", undefined);
      }
    }
    if (config.context.enabled && !earlier && !recallRead && textBlocks.length === 1 && text.length >= config.context.tailMinChars) ledger.candidate();
    if (multiBlock && !ctx.signal?.aborted) {
      // Retention and banners per block; block order and non-text parts are never touched.
      content = [...content];
      let textIndex = 0;
      for (let index = 0; index < content.length; index++) {
        const part = content[index]!;
        if (part.type !== "text") continue;
        const verdict = blockVerdicts[textIndex];
        const blockNotice = blockNotices[textIndex];
        const blockText = part.text ?? "";
        textIndex++;
        if (!verdict) continue;
        let replacement: string | undefined;
        const excerpt = compressOutput(blockText, verdict.retention, verdict.format);
        if (excerpt) {
          try {
            const path = await saveOutput(blockText);
            const body = `${blockNotice ? `${blockNotice}\n\n` : ""}${excerpt}\n\n${recallInstruction(recallTool, path)}`;
            const bytesSaved = Buffer.byteLength(blockText) - Buffer.byteLength(body);
            if (bytesSaved > 0) {
              replacement = body;
              ledger.record(path, bytesSaved);
              storedPath = path;
              record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: verdict.retention, bytesSaved: String(bytesSaved) }), [
                `text block ${textIndex} of ${blockVerdicts.length}: retention ${verdict.retention}; confidence ${verdict.confidence?.toFixed(2)}; format ${verdict.format ?? "generic"}${verdict.formatConfidence === undefined ? "" : ` (${verdict.formatConfidence.toFixed(2)})`}; saved ${bytesSaved} bytes; full output: ${path}`,
                formatLedger(ledger.snapshot()),
              ]);
            }
          } catch {
            noteError(ctx, "Could not store full output; keeping the block unchanged.", undefined);
          }
        }
        if (!replacement && blockNotice) replacement = `${blockNotice}\n\n${blockText}\n\n${blockNotice}`;
        if (replacement) content[index] = { ...part, text: replacement };
      }
    } else {
      const excerpt = earlier ? undefined : compressOutput(text, output.retention, output.format);
      if (excerpt && !ctx.signal?.aborted) {
        try {
          const path = await saveOutput(text);
          const replacement = `${excerpt}\n\n${recallInstruction(recallTool, path)}`;
          const bytesSaved = Buffer.byteLength(text) - Buffer.byteLength(replacement) - (notice ? Buffer.byteLength(notice) * 2 + 4 : 0);
          if (bytesSaved > 0) {
            content = content.map(part => part.type === "text" ? { ...part, text: replacement } : part);
            ledger.record(path, bytesSaved);
            storedPath = path;
            record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: output.retention, bytesSaved: String(bytesSaved) }), [
              `retention: ${output.retention}; confidence ${output.confidence?.toFixed(2)}; format ${output.format ?? "generic"}${output.formatConfidence === undefined ? "" : ` (${output.formatConfidence.toFixed(2)})`}; ${output.model}; ${output.elapsedMs} ms`,
              `saved ${bytesSaved} bytes; full output: ${path}`,
              formatLedger(ledger.snapshot()),
            ]);
          }
        } catch {
          noteError(ctx, "Could not store full output; keeping it unchanged.", undefined);
        }
      }
    }
    if (key && !earlier) ledger.remember(key, event.toolName, storedPath);
    if (notice && textBlocks.length) {
      if (!multiBlock) {
        let index = 0;
        content = content.map(part => {
          if (part.type !== "text") return part;
          index++;
          return { ...part, text: `${index === 1 ? `${notice}\n\n` : ""}${part.text}${index === textBlocks.length ? `\n\n${notice}` : ""}` };
        });
      }
      const delivered = steer(config, "security", notice);
      record(ctx, config, "security", renderTemplate(config.widget.security, {
        tool: event.toolName, injection: output.injection?.toFixed(2), exfiltration: output.exfiltration?.toFixed(2),
        status: [output.suspicious && "untrusted instructions", output.secret && "possible credentials"].filter(Boolean).join(", "),
      }), [
        `jev: injection ${output.injection?.toFixed(2) ?? "not judged"}; exfiltration ${output.exfiltration?.toFixed(2) ?? "not judged"}`,
        `output sample: ${redact(text).slice(0, 300)}`, delivered ? `agent told: ${notice}` : `steer recorded, not delivered (a repeat or the per-run budget): ${notice}`,
      ]);
    }
    const patch = content === event.content ? undefined : { content };
    // Checks use the original result, not the excerpts or security banner.
    if (config.done.enabled) recordDoneOutcome(evidence, classifyToolResult(event.toolName, event.input, failed, text), event.input, event.toolName);
    const verdict = await stuckCheck;
    if (!verdict) return patch;
    if (verdict.error) noteError(ctx, verdict.error, verdict.errorCode);
    if (verdict.source === "repeat" && !verdict.stuck) return patch;
    const nudge = verdict.stuck && config.stuck.nudge ? stuckNudge(verdict) : undefined;
    record(ctx, config, "stuck", formatStuck(verdict, config.widget.stuck), stuckDetails(verdict, attempts.attempts, nudge));
    if (!verdict.stuck) return patch;
    stats.stuck++;
    if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · stuck: ${verdict.reasons.join("; ")}${nudge ? " (agent nudged)" : ""}`, "warning");
    if (nudge) steer(config, "stuck", nudge);
    return patch;
  });

  // The agent has caught up and Pi will not continue on its own: the one moment a wake costs the user nothing.
  pi.on("agent_settled", async (_event, ctx) => {
    await checkSubagentReports(ctx, configFor(ctx));
  });

  pi.on("agent_end", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled) return;
    // Arming state survives across runs within a session (the Scenario B case: edit in one turn,
    // reconcile in the next). It is cleared on session_start and bounded by the rule's `for` window.
    // No guarded call carried the regret question this run (the agent only replied): the offline heuristic reads the prompt.
    if (regretCandidates.length) settleRegret(config, { regretted: textRegrets(latestUserPrompt(ctx)), via: "text" });
    if (pendingRunaway) {
      const { nudge, recover } = pendingRunaway;
      pendingRunaway = undefined;
      // A follow-up queued here continues the run once the aborted message is in place; without recovery the note is appended only.
      if (recover) steer(config, "runaway", nudge, { deliverAs: "followUp", triggerTurn: true, display: true });
      else steer(config, "runaway", nudge, { triggerTurn: false, display: true });
      return;
    }
    const finalMessage = finalAssistantText(event.messages);
    // Restatement is measured in code, before any judging: the run that collects five accounting replies restating the
    // same completion status is the noise the user sees, and it is invisible to every per-reply and per-call guard.
    if (finalMessage) {
      const share = finals.share(finalMessage);
      finals.record(finalMessage);
      const sentences = substantiveSentences(finalMessage).length;
      if (share >= RESTATE_SHARE && sentences >= RESTATE_MIN_SENTENCES) {
        stats.restatements++;
        const line = `warden · prose · restated ${Math.round(share * 100)}% of ${sentences} sentences · recorded only`;
        record(ctx, config, "prose", line, [
          `${Math.round(share * 100)}% of this reply's substantive sentences were already sent in an earlier reply of this run`,
          "no steer: a nudge cannot retract the reply and would cost the turn it warns against",
        ]);
        if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · prose: the final reply restates ${Math.round(share * 100)}% of what was already said this run (recorded, not steered)`, "warning");
      }
    }
    const judge = judgeFor(config);
    if (!finalMessage || !judge) return;
    // Pi shows the agent as working until this hook returns, so the two independent checks share one round trip.
    const task = latestUserPrompt(ctx);
    const proseCheck = config.slop.enabled && config.slop.prose.enabled && finalMessage.length >= config.slop.prose.minChars
      ? evaluateProse(task, finalMessage, { config: config.slop.prose, judge, timeoutMs: config.timeoutMs, signal: ctx.signal })
      : undefined;
    const doneCheck = config.done.enabled && !doneNudged && needsDoneCheck(evidence)
      ? evaluateDone(task, finalMessage, evidence, { config: config.done, judge, timeoutMs: config.timeoutMs, signal: ctx.signal })
      : undefined;
    if (proseCheck) {
      stats.proseChecks++;
      const verdict = await proseCheck;
      if (verdict.error) noteError(ctx, verdict.error, verdict.errorCode);
      else prose.record(verdict.flagged);
      const due = verdict.error ? [] : prose.due(config.slop.prose.trend);
      const nudge = due.length ? proseNudge(due, config.slop.prose.audience, prose.counts) : undefined;
      if (nudge) { verdict.nudged = true; prose.markNudged(); stats.proseNudges++; }
      record(ctx, config, "prose", renderTemplate(config.widget.prose, proseTokens(verdict)), proseDetails(verdict, finalMessage, config.slop.prose.audience, nudge));
      if (nudge) {
        if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · prose: ${due.join(", ")} in ${config.slop.prose.trend} of the last 3 replies (agent nudged for the next reply)`, "warning");
        steer(config, "prose", nudge, { deliverAs: "nextTurn" });
      }
    }
    if (!doneCheck) return;
    stats.doneChecks++;
    const verdict = await doneCheck;
    if (verdict.error) noteError(ctx, verdict.error, verdict.errorCode);
    const nudge = verdict.unverified && config.done.nudge ? doneNudge(verdict) : undefined;
    record(ctx, config, "done", formatDone(verdict, config.widget.done), doneDetails(verdict, finalMessage, nudge));
    if (!verdict.unverified) return;
    stats.unverified++;
    if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · done-check: ${verdict.reasons.join("; ")}${nudge ? " (agent asked to verify)" : ""}`, "warning");
    if (nudge) {
      doneNudged = true;
      steer(config, "done", nudge, { deliverAs: "followUp", triggerTurn: true });
    }
  });

  // Shortcuts are registered once at load; a shape check keeps a typo in the config file from being registered.
  const shortcut = loadConfig().widget.shortcut;
  if (/^(?:(?:ctrl|shift|alt|super)\+)+[a-z0-9]+$|^f\d{1,2}$/i.test(shortcut)) {
    pi.registerShortcut(shortcut as KeyId, {
      description: "Toggle the pi-warden trace sidebar",
      handler: async ctx => { if (ctx.hasUI) togglePanel(ctx.ui as unknown as PanelUi, configFor(ctx)); },
    });
  }

  const actions = ["status", "enable", "disable", "mode", "config", "test", "trace"];
  pi.registerCommand("warden", {
    description: "pi-warden status, TypeSafe consent, steer/confirm/advise mode, config editor, trace panel, and a synthetic guard test",
    getArgumentCompletions(prefix) {
      const matches = actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const [action = "status", argument] = args.trim().split(/\s+/);
      const report = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
      };
      try {
        const config = configFor(ctx);
        if (action === "status") {
          const auth = describeAuth();
          const source = consentSource(config);
          const usage = client?.getUsage();
          const guards = [config.action.enabled && "action", config.stuck.enabled && "stuck", config.done.enabled && "done-check", config.slop.enabled && "slop", config.slop.enabled && config.slop.prose.enabled && `prose (${config.slop.prose.audience})`, config.security.enabled && "security", config.rules.enabled && "rules", config.context.enabled && "context", config.runaway.enabled && "runaway", config.subagent.enabled && "subagent triage", config.notify.enabled && "desktop notifications"].filter(Boolean).join(", ");
          report([
            `pi-warden: ${config.enabled ? `guarding ${config.action.tools.join(", ")} (${guards})` : "off"}; mode ${activeMode(config, ctx.hasUI)}; TypeSafe judgments ${source ? `consented via ${source}` : "not consented (run /warden enable)"}${config.typesafeBackend !== "typesafe" ? ` (${config.typesafeBackend})` : ""}; ${auth.text}`,
            `Session: ${stats.inspected} inspected, ${stats.judged} judged, ${stats.warned} warned, ${stats.held} held, ${stats.approved} approved on retry, ${stats.offPlan} off plan, ${stats.offTask} off task, ${stats.slop} slop notes, ${stats.ruleViolations}/${stats.ruleChecks} rule violations, ${stats.pathNotes} sensitive-path notes, ${stats.stuck}/${stats.stuckChecks} stuck, ${stats.unverified}/${stats.doneChecks} unverified done, ${stats.proseNudges}/${stats.proseChecks} prose nudges, ${stats.runaway} runaway stops, ${stats.subagentWoken}/${stats.subagentReports} subagent reports woken, ${stats.restatements} restatements, ${stats.errors} TypeSafe errors; ${usage?.requestsStarted ?? 0}/${config.maxRequests} requests. Steers are ${config.steerVisible ? "shown in the transcript" : "hidden from the transcript (trace panel shows them)"}. Steer budget: ${config.steerBudget === 0 ? "off" : `${config.steerBudget} per run`}.`,
            formatSteers(stats),
            `Thresholds: irreversible warn ${config.action.irreversible.warn} / hold ${config.action.irreversible.confirm}; off-task warn ${config.action.offTask.warn} / steer ${config.action.offTask.steer} (never holds); intent mismatch ${config.action.intentMismatch} (${config.action.visibleMismatch} on a visible action); stuck same-strategy ${config.stuck.sameStrategy} after ${config.stuck.minFailures} failures; done claims ${config.done.claimsDone}; slop ${config.slop.threshold}, rules ${config.rules.threshold}, prose ${config.slop.prose.threshold} in ${config.slop.prose.trend}/3 replies; runaway ${config.runaway.repeats} repeats (thinking ${config.runaway.thinkingRepeats}), recover ${config.runaway.recover}; failOpen ${config.action.failOpen}.`,
            formatLedger(ledger.snapshot()),
            `${formatHolds(holds.snapshot(), config.action.feedbackLog ? holdLog?.path : undefined)}${holdLog?.lastFailure ? ` Log write failed: ${holdLog.lastFailure}.` : ""}`,
            `Rules: ${config.rules.enabled ? `${rulesGuard.describe(ctx.cwd, config.rules)}${Object.keys(config.rules.sensitivePaths).length ? `; ${Object.keys(config.rules.sensitivePaths).length} sensitive path${Object.keys(config.rules.sensitivePaths).length === 1 ? "" : "s"}` : ""}` : "off"}.`,
            ...(config.action.armingRules.length > 0 ? [`Arming: ${arming.statusLine() || "no rules armed"}.`] : []),
            `Desktop notifications: ${config.notify.enabled ? `on (${config.notify.command.length ? `command ${config.notify.command[0]}` : (await (notifier ??= detectNotifier())) ?? "no notifier found on this machine"}; cooldown ${config.notify.cooldownMs} ms)` : "off (\"notify\": { \"enabled\": true } in the config turns them on)"}.`,
            `Config: ${userConfigPath()}${ctx.isProjectTrusted() ? ` and ${projectConfigPath(ctx.cwd)}` : ""}.`,
            widget.size ? `Last: ${[...widget.values()].join(" | ")}` : "No guarded activity yet this session.",
            `Trace: ${trace.entries().length} events (/warden trace${shortcut ? `, ${shortcut}` : ""}, or click the status line in fullscreen mode; each toggles the sidebar). Widget templates in config.widget: action tokens ${TOKEN_NAMES.action.map(name => `{${name}}`).join(" ")}.`,
          ].join(" "));
          return;
        }
        if (action === "trace") {
          if (!ctx.hasUI) {
            const entries = trace.entries();
            report(entries.length ? entries.slice(-20).map(entry => `${new Date(entry.at).toTimeString().slice(0, 8)} ${entry.guard}: ${entry.line}${entry.details.length ? `\n  ${entry.details.join("\n  ")}` : ""}`).join("\n") : "No guarded activity yet this session.");
            return;
          }
          togglePanel(ctx.ui as unknown as PanelUi, config);
          return;
        }
        if (action === "enable") {
          if (!ctx.hasUI) { report("Consent needs an interactive session. For headless runs set PI_WARDEN_ENABLED=1 and TYPESAFE_API_KEY explicitly.", "warning"); return; }
          if (!await ctx.ui.confirm("Enable TypeSafe judgments for pi-warden?", disclosure)) return;
          // One flow: consent, then a key if none is configured yet (hidden input, verified, stored for every pi-typesafe consumer).
          const key = await ensureApiKey(ctx);
          if (!key) { report("No key entered; pi-warden stays on pattern checks only. Run /warden enable again when you have a key from console.typesafe.ai.", "warning"); return; }
          const path = setUserSetting("typesafe", true);
          client = undefined;
          budgetExhausted = false;
          report(`TypeSafe judgments enabled and saved to ${path}${key.login ? `; key verified (${key.login.models} model${key.login.models === 1 ? "" : "s"}) and stored at ${key.login.path}` : ` using the ${key.source === "stored" ? "stored key" : "key from TYPESAFE_API_KEY"}`}. This stays on in new sessions until /warden disable.`);
          return;
        }
        if (action === "disable") {
          const path = setUserSetting("typesafe", false);
          report(`TypeSafe judgments disabled in ${path}. Offline pattern checks stay active; set enabled to false there to turn pi-warden off entirely.`);
          return;
        }
        if (action === "mode") {
          if (!isMode(argument)) { report(`Mode is ${activeMode(config, ctx.hasUI)}${process.env.PI_WARDEN_MODE ? " (from PI_WARDEN_MODE)" : ""}. Use /warden mode steer | confirm | advise. steer holds risky calls and tells the agent why; confirm asks you with a dialog; advise only reports.`); return; }
          const path = setUserSetting("mode", argument);
          report(`Mode set to ${argument} in ${path}.`);
          return;
        }
        if (action === "config") {
          if (!ctx.hasUI) { report(`Edit ${userConfigPath()} directly. Defaults: ${JSON.stringify(defaultConfig())}`); return; }
          const current = readUserConfig();
          const seed = Object.keys(current).length ? current : { ...defaultConfig(), typesafe: config.typesafe };
          const text = await ctx.ui.editor(`pi-warden config · ${userConfigPath()}`, JSON.stringify(seed, null, 2));
          if (text === undefined) return;
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { report("Invalid JSON; nothing was saved.", "error"); return; }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { report("The config must be a JSON object; nothing was saved.", "error"); return; }
          const path = writeUserConfig(parsed as Record<string, unknown>);
          const effective = applyUserOverrides(defaultConfig(), parsed);
          client = undefined;
          report(`Saved ${path}. Effective: guard ${effective.enabled && effective.action.enabled ? "on" : "off"}, mode ${effective.mode}, TypeSafe ${effective.typesafe ? "on" : "off"}, tools ${effective.action.tools.join(", ")}, irreversible hold ≥ ${effective.action.irreversible.confirm}, off-task steer ≥ ${effective.action.offTask.steer}, stuck ${effective.stuck.enabled ? "on" : "off"}, done-check ${effective.done.enabled ? "on" : "off"}, slop ${effective.slop.enabled ? "on" : "off"}.`);
          return;
        }
        if (action === "test") {
          const judge = judgeFor(config);
          if (judge && ctx.hasUI && !await ctx.ui.confirm("Send one synthetic pi-warden test request?", `A synthetic action ("rm -rf /tmp/pi-warden-demo" for the task "Clean up the demo directory") goes to ${backendHost(config.typesafeBackend)} and may incur charges. ${disclosureFor(config.typesafeBackend, disclosure)}`)) return;
          const verdict = await evaluateAction(
            { tool: "bash", input: { command: "rm -rf /tmp/pi-warden-demo" }, cwd: ctx.cwd, task: "Clean up the demo directory" },
            { config: { ...config.action, enabled: true, tools: ["bash"] }, judge },
          );
          record(ctx, config, "action", formatVerdict(verdict, config.widget.action), actionDetails(verdict, { mode: activeMode(config, ctx.hasUI) }));
          report(`${formatVerdict(verdict)}${verdict.reasons.length ? ` — ${verdict.reasons.join("; ")}` : ""}${judge ? "" : " (pattern checks only: TypeSafe judgments are not enabled or no key is configured)"}${verdict.error ? ` — ${verdict.error}` : ""}`);
          if (verdict.level === "confirm") {
            const mode = activeMode(config, ctx.hasUI);
            if (mode === "confirm" && ctx.hasUI) {
              const allowed = await ctx.ui.confirm("warden: allow this bash call? (demo)", `${confirmMessage(verdict)}\n\nThis is /warden test: nothing runs either way.`);
              report(allowed ? "Demo: you chose Yes, so a real call would have run." : "Demo: you chose No, so a real call would have been blocked and the agent told why.");
            } else {
              report(`In ${mode} mode a real call would ${mode === "advise" ? "run with this warning shown to you" : "be held and the agent would read"}: "${steerReason(verdict, { canApprove: judge !== undefined })}"`);
            }
          }
          return;
        }
        report(`Unknown action "${action}". Use: ${actions.join(", ")}.`, "warning");
      } catch (error) {
        report(error instanceof Error ? error.message : "pi-warden command failed.", "error");
      }
    },
  });
}
