import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultHostDirs } from "./host-dirs.js";
import type { HostDirs } from "./host-dirs.js";
import type { KeyId } from "@earendil-works/pi-tui";
import * as tuiModule from "@earendil-works/pi-tui";
type MouseRegionConstructor = new (child: ReturnType<typeof statusWidget>, onMouse: (event: { type: string; button: string }) => { handled: boolean } | undefined) => import("@earendil-works/pi-tui").Component;
const MouseRegion: MouseRegionConstructor | undefined = (tuiModule as Partial<{ MouseRegion: MouseRegionConstructor }>).MouseRegion;
import { authState, backendHost, createTypeSafe, describeAuth, resolveBackend, ask } from "pi-typesafe";
import type { TypeSafe } from "pi-typesafe";
import { ensureApiKey } from "pi-typesafe/ui";
import { backendName, describeBackend, disclosureFor, judgeOptions, loginStoresKey } from "./backend.js";
import type { BackendSetting, JudgmentsOffReason } from "./backend.js";
import { ActionGuard } from "./action-guard.js";
import { adaptHost } from "./host-compat.js";
import { assistantView, formatMuted, NEVER_MUTED, STEER_KINDS, SteerStats, SteerWatch, steerStatsPath } from "./adaptive.js";
import type { SteerKind, SteerSubject } from "./adaptive.js";
import type { ToolCallRef } from "./action-guard.js";
import { ArmingTracker, unparseableArmingRules } from "./arming.js";
import * as configModule from "./config.js";
import { applyUserOverrides, defaultConfig, getNestedValue, isMode, loadConfig, PACKAGE_NAME, parseConfigValue, PROJECT_CONFIG_FILE, projectConfigPath, readUserConfig, setNestedValue, setUserSetting, userConfigPath, writeUserConfig } from "./config.js";
import type { WardenConfig, WardenMode } from "./config.js";
import { classifyToolResult, doneNudge, emptyEvidence, evaluateDone, finalAssistantText, formatDone, isVisualCheck, needsDoneCheck, recordOutcome as recordDoneOutcome, recordUi } from "./done.js";
import type { RunEvidence } from "./done.js";
import { createdScratch, describeAsked, evaluateAction, formatVerdictTokens, higher, inertPathRules, intentSteer, largeOutputNotice, movedInTargets, offTaskSteer, pruneScratch, scratchCandidates, SCRATCH_PATHS_ENV, scratchPaths, shouldProceedMessage, SLOP_LABELS, SteerRepeatWindow, steerReason, stripDataText, unknownExemptIds, wardenHostPaths, writeSinkTargets, isVisibleCommand } from "./guard.js";
import type { Level, PatternHit, PreviousAction, ScratchIdentity, SlopSymptom, TaskMessage, Verdict } from "./guard.js";
import { commandOf } from "./tools.js";
import { mergeWrites, shellWrites } from "./shell-writes.js";
import type { ShellSkip, ShellWrite } from "./shell-writes.js";
import { formatHolds, HoldLedger, HoldLog, holdLogPath, mutatingCall, outcomeNote, regretsAt, textRegrets } from "./holds.js";
import { initSchema, recordHold, recordOutcome, toHoldRecord, holdStats, generateRecommendations, analyzeSteerEffectivenessReport } from "./learning.js";
import type { CallOutcome, CallRecord, OutcomeVia } from "./holds.js";
import { evaluateProse, proseNudge, ProseTrend, RESTATE_MIN_SENTENCES, RESTATE_SHARE, RestatementWindow, substantiveSentences } from "./prose.js";
import { compressOutput, duplicateNote, evaluateOutput, isGenericExcerpt, mergeOutput, outputKey, saveOutput, securityNotice, CompressionLearner } from "./output.js";
import { filterOutput } from "./filter.js";
import type { FilterResult } from "./filter.js";
import type { OutputVerdict } from "./output.js";
import { classifyRecall, detectSearchTool, recallInstruction } from "./recall.js";
import type { SearchTool } from "./recall.js";
import { maskSecrets, redact } from "./redact.js";
import { formatRules, pathNoteSteer, projectPath, RulesGuard, rulesSteer, RULES_FILE, FALLBACK_FILES, turnRulesFor } from "./rules.js";
import type { RulesVerdict } from "./rules.js";
import { evaluateTurnRun, SHELL_RULES_CHECKS, snapshotTree, turnSteer } from "./turn-rules.js";
import type { SnapshotResult } from "./turn-rules.js";
import { checkRules, formatRulesCheck } from "./rules-lint.js";
import { parseRulesAuditArgs, parseBenchArgs, runRulesAudit, runBench, formatRulesAudit, formatBench } from "./rules-audit.js";
import type { RulesCheckResult } from "./rules-lint.js";
import { calibrate, calibrateGate, calibrationNotice, collectHistory, formatCalibration, planCalibration, tuneRequest, CALIBRATE_DEFAULT_COMMITS, CALIBRATE_DEFAULT_MAX } from "./rules-calibrate.js";
import type { Calibration, HistoryCommit } from "./rules-calibrate.js";
import { readRulesLog, RulesLog, rulesLogPath } from "./rules-log.js";
import { buildRulesReport, formatRulesReport, REPORT_DEFAULT_DAYS } from "./rules-report.js";
import { checkPiWardenMissing } from "./rules-file.js";
import { writeStarterRules, buildInitPrompt } from "./init.js";
import { buildAuditPrompt, findProjects, snapshotReport, reportOutcome } from "./audit.js";
import { detectNotifier, sendNotification } from "./notify.js";
import type { NotifierName } from "./notify.js";
import { formatRunaway, RunawayMonitor, runawayNudge } from "./runaway.js";
import { AttemptWindow, evaluateStuck, formatStuck, makeAttempt, quickRepeatNudge, resultFailed, stuckDiff, stuckNudge } from "./stuck.js";
import type { QuickRepeat } from "./stuck.js";
import { WasteTracker, WASTE_TIP, withWasteTip } from "./waste.js";
import { assess, isRelayedReport, isShortContinuation, recommendationText } from "./conscience.js";
import { loadSkillBody, buildLoadMessage, policyMatches, CONSCIENCE_BETA_POLICY, recordFileIdentity, clearFileIdentityCache } from "./load.js";
import type { ConsciencePolicy } from "./load.js";
import { buildIndexPrompt, readIndex, writeIndex, validateIndex, indexStats, indexPath, ensureIndexDir } from "./index-cmd.js";
import { fileContentHash } from "./hashing.js";
import type { IndexFile } from "./index-cmd.js";
import type { IntegrationErrorCode } from "pi-typesafe";

import { classifyJudgeError, cooldownFailureKind, JudgeCooldown } from "./judge-cooldown.js";
import type { CooldownEvent } from "./judge-cooldown.js";
import { openConfigPanel, openTracePanel } from "./panel.js";
import { completeConfig, shapeWarning, taskSpine } from "./shape.js";
import type { ShapeResult } from "./shape.js";
import { ContextLedger, formatFilterLedger, formatLedger } from "./saver.js";
import { buildCuratorRequest, curatedRuleList, curatedRules, CURATOR_TIMEOUT_MS, CURATOR_TYPE, CuratorLedger, formatCuratedRules, formatCurator, ruleScores } from "./curator.js";
import { SeenText, collapseRuns, seenItem } from "./dedupe.js";
import { buildCompactSnapshot, compactAppendix, recallText } from "./compact.js";
import { formatCompaction, relevanceCompaction } from "./relevance.js";
import type { CompactionStats, FallbackReason } from "./relevance.js";
import { applyLoopAction, formatLoopsForUser, formatOpenLoops, LOOP_ACTIONS, LOOP_CHARS, loopsFingerprint, loopsPath, openLoops, readLoops, updateLoops } from "./loops.js";
import { changePrefsStore, emptyWordCounts, evaluatePrefs, forgetPref, formatPrefs, LESSON_CHARS, prefsMessage, prefsStorePath, readPrefsStore, recordLesson, scanPreferences } from "./prefs.js";
import type { PrefItem, PrefsScan } from "./prefs.js";
import { formatWake, newReports, reportLabel, triageReport, WakePolicy } from "./subagent.js";
import type { PanelController, PanelUi } from "./panel.js";
import { actionDetails, doneDetails, proseDetails, rulesDetails, runawayDetails, stuckDetails, Trace } from "./trace.js";
import type { GuardName, TraceEntry } from "./trace.js";
import { TraceFile, judgmentsState, traceDir, traceFilePath } from "./trace-file.js";
import { actionTokens, DEFAULT_TEMPLATES, LEVEL_COLOR, pickSentenceTemplate, proseTokens, renderTemplate, rulesTokens, SENTENCE_TEMPLATES, TOKEN_NAMES } from "./widget.js";
import { statusWidget } from "./widget-render.js";
import { evaluateSupervision, validateSupervisionRequest } from "./supervision.js";

export const disclosure = "With TypeSafe judgments enabled, pi-warden sends to api.typesafe.ai: your latest request, the task spine it is judged against (the first request of the thread and up to four redacted earlier requests), plus a redacted, truncated summary of each guarded bash, write, or edit call before it runs, with the agent's own words from the message that makes the call (its stated plan); one judged action call in twenty (`action.traceSample`, default 0.05) also sends a second request for diagnostics that carries up to eight redacted earlier user/assistant text messages and the resolved active rules file content (pi-warden.md, the configured files, or README/CLAUDE/AGENTS as fallback, token-aware truncated at ~4000 tokens); on every other call that rules content rides the acting request only while a rule violation is open on the call; none of it is sent unless the rules guard is on (`rules.enabled: false` keeps it on this machine); for a write or edit (or a bash command that writes a file with its content in the command) in a project with a rules file (pi-warden.md, the configured files, or README/CLAUDE/AGENTS as fallback), a larger redacted sample of the written content with the current file around each edit and the rule text; the last few tool calls and output tails when the agent keeps failing; the agent's final message when it reports completion without running checks; redacted tool-output samples for security and context saving (retention and output format); with the context filter on (`context.filter`, off by default), the redacted text of a large tool output in chunks, with the call's command and the agent's stated plan; before each new user message, when the rules guard is on (except for a short continuation or a relayed child report, which send nothing), your new request (1500 redacted characters), the same task spine, and every rule of the active rules source (each rule's heading, its text clipped at 300 characters, and its `paths:` scope), one question per rule, so Jev can say which of them apply; a redacted sample of an async subagent report that names a failure, a stop, or a question, with your latest request, when warden decides whether that report should wake the agent; on the first guarded call after your reply, the redacted summaries of the calls allowed in the previous turn, so Jev can say whether your reply regrets one of them; and, only for a call that is held after an earlier hold, once your reply came in, one approval request with your reply, up to 3000 redacted characters of the agent's text in the turn before it (every assistant message after your previous message), the redacted call summary, and the reasons for the hold (pattern names and scores), so Jev can say whether your reply approves that call. With relevance compaction on (`compaction.enabled`, off by default), at each compaction: the same latest request and task spine, a redacted outline of the conversation being compacted (user and assistant text clipped, one line per tool call), and for each tool call, extension message, and earlier-summary part a redacted 500-character input and a 1100-character head/tail sample, so Jev can say which to keep word for word. For the Token Guardian observer, only on a claimed supervision trigger with consent, an available judge, and unblocked caps: allow-listed redacted metrics consisting of root ID (bounded opaque identifier), role, lifecycle, pause reason, failure continuation plan, observed USD cost, observer USD cost, soft and hard USD limits, descendant count; progress material-progress count, reads and writes since progress, repeated-operation count, equivalent-error count, SHA-256 operation signature (or null), and age since last progress; MCP availability state and capability count. Token Guardian excludes prompt text, source code, raw commands, command results, filesystem paths, raw errors, credentials, and the worker transcript entirely; the five questions share one request per claimed trigger, and Guardian alone handles enforcement. For the conscience coach (recommend mode): your current request (2000 redacted characters), the same task spine (the first request of the thread and up to four redacted earlier requests), up to four recent user/assistant text messages (500 redacted characters each with roles), and sanitized candidate metadata (skill/tool name, role, lead, useWhen, examples when an index entry matches; bare description otherwise; full skill instructions never go to Jev). The index is built locally by the session model; only sanitized entries reach Jev; advertised locations never do. Compression and duplicate notes store an exact, owner-only copy in a temporary file on this machine; the hold feedback log stores tool names, pattern ids, scores, and outcomes (never commands) in an owner-only file under Pi's agent directory; an owner-only SQLite database under Pi's agent directory stores redacted hold context (plan, summary, redacted command preview, outcomes) for held and judged-allowed calls, for learning and retention (a hold is kept 365 days and an allowed call 90, both configurable). Requests may incur charges. Secret redaction is best-effort. Results are model judgments, not proof or authorization; offline pattern checks stay active either way.";

const WIDGET = PACKAGE_NAME;
const CONFIRM_TEXT_LIMIT = 500;

/** Which guard spent the user's attention. The status line reports one count per guard. */
export type SteerGuard = "action" | "rules" | "security" | "stuck" | "repeat" | "done" | "prose" | "runaway" | "subagent" | "conscience" | "loops";

interface Stats { inspected: number; judged: number; warned: number; held: number; approved: number; offPlan: number; offPlanTraceOnly: number; offTask: number; slop: number; ruleChecks: number; ruleViolations: number; pathNotes: number; stuckChecks: number; stuck: number; doneChecks: number; unverified: number; proseChecks: number; proseNudges: number; runaway: number; errors: number; cooldownSkips: number; steers: number; steersSkipped: number; steersMuted: number; steerGuards: Partial<Record<SteerGuard, number>>; subagentReports: number; subagentWoken: number; restatements: number }
const freshStats = (): Stats => ({ inspected: 0, judged: 0, warned: 0, held: 0, approved: 0, offPlan: 0, offPlanTraceOnly: 0, offTask: 0, slop: 0, ruleChecks: 0, ruleViolations: 0, pathNotes: 0, stuckChecks: 0, stuck: 0, doneChecks: 0, unverified: 0, proseChecks: 0, proseNudges: 0, runaway: 0, errors: 0, cooldownSkips: 0, steers: 0, steersSkipped: 0, steersMuted: 0, steerGuards: {}, subagentReports: 0, subagentWoken: 0, restatements: 0 });

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
 * The agent's words the latest user message answers: the text of every assistant message after the previous user message
 * and before the latest one, in order, redacted and clipped to the last 3,000 characters (the question is usually at the
 * end). A reply that arrives mid-run follows messages that hold only tool calls, and an explanation can sit earlier in the
 * turn, so the newest message alone is not enough. Sent only with the approval request of a held call, to read a short or
 * numbered reply against what it points at; it explains the reply and never approves.
 */
export function askedBeforeReply(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  const texts: string[] = [];
  let userSeen = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (!userSeen) { userSeen = entry.message.role === "user"; continue; }
    if (entry.message.role === "user") break;
    if (entry.message.role !== "assistant") continue;
    const text = assistantText(entry.message.content).trim();
    if (text) texts.unshift(text);
  }
  return describeAsked(texts.join("\n\n"));
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

/** Whether the call is a shell command with a visible effect (commit, push, merge, tag, reset, pull request, release, publish). */
export function isVisibleAction(tool: string, input: Record<string, unknown>): boolean {
  const view = commandOf(tool, input);
  return view?.shell === true && isVisibleCommand(view.command);
}

/**
 * The agent's own words for the call: the text of the assistant message that carries it, or, when that message is
 * tool calls only, the text of the assistant message right before it with no tool call in between. Text from before an
 * earlier tool call described that call, so it is no plan and the intent question is not asked. The exception is
 * `visibleAction` (a commit, push, merge, tag, reset, pull request, release, or publish, by `isVisibleCommand`): such a
 * call is still judged against the latest assistant text since the user's prompt, because an unannounced commit or push
 * after an older plan is the mismatch users object to. Sent as `plan`; it explains the step and cannot approve it.
 */
export function assistantPlan(ctx: ExtensionContext, visibleAction = false): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  const plan = planForCall(entries);
  if (plan !== undefined || !visibleAction) return plan;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role === "user") return undefined;
    if (entry.message.role !== "assistant") continue;
    const text = assistantText(entry.message.content);
    if (text) return text;
  }
  return undefined;
}

function assistantText(content: string | ReadonlyArray<{ type: string }>): string {
  return (typeof content === "string" ? content : content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("\n")).trim();
}

/** The text of the message that carries the call, or of the assistant message right before it with no tool call in between. */
function planForCall(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): string | undefined {
  let carrierSeen = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    const { role } = entry.message;
    if (role === "user") return undefined;
    // A result after the carrier belongs to a sibling call; one before it means an earlier tool call ran.
    if (role === "toolResult") { if (carrierSeen) return undefined; continue; }
    if (role !== "assistant") continue;
    const content = entry.message.content;
    const text = assistantText(content);
    if (!carrierSeen) {
      if (text) return text;
      carrierSeen = true;
      continue;
    }
    if (typeof content !== "string" && content.some(part => part.type === "toolCall")) return undefined;
    return text || undefined;
  }
  return undefined;
}

/**
 * The once-per-session notice: why Jev judgments are off and what turns them on. `rejectedEnv` is the environment
 * variable that holds a rejected key, or undefined when the rejected key is the one `/typesafe login` saved. Never
 * names a key value or a path.
 */
export function judgmentsOffText(reason: Exclude<JudgmentsOffReason, "budget">, setting: BackendSetting, headless: boolean, rejectedEnv?: string): string {
  switch (reason) {
    case "no_consent": return `warden: Jev judgments are off (no consent). ${headless ? "Set PI_WARDEN_ENABLED=1." : "Run /warden enable."}`;
    case "bad_backend": return `warden: Jev judgments are off (typesafeBackend refused: ${setting.backendRefusal ?? "the configured value is not usable"})`;
    case "no_key": return `warden: Jev judgments are off (no key for ${backendName(setting.typesafeBackend)}). Set ${resolveBackend(setting.typesafeBackend).keyEnv}${loginStoresKey(setting.typesafeBackend) ? " or run /typesafe login" : ""}.`;
    case "key_rejected": return rejectedEnv
      ? `warden: Jev judgments are off (the key in ${rejectedEnv} was rejected). Check the key, then run /warden status.`
      : "warden: Jev judgments are off (the key saved by /typesafe login was rejected). Run /typesafe login.";
  }
}

function activeMode(config: WardenConfig, hasUI: boolean): WardenMode {
  const env = process.env.PI_WARDEN_MODE?.trim();
  const mode = isMode(env) ? env : config.mode;
  return mode === "confirm" && !hasUI ? "steer" : mode;
}

/** Keep diagnostics intact while removing structured trace-only items at the agent boundary. */
function agentDeliveryReasons(verdict: Verdict): string[] {
  const indexes = [
    verdict.offTaskTraceOnly ? verdict.offTaskTraceOnlyReasonIndex : undefined,
    verdict.shouldProceedTraceOnly ? verdict.shouldProceedTraceOnlyReasonIndex : undefined,
    verdict.intentTraceOnly ? verdict.intentTraceOnlyReasonIndex : undefined,
  ].filter((index): index is number => index !== undefined && index >= 0 && index < verdict.reasons.length);
  if (!indexes.length) return verdict.reasons;
  return verdict.reasons.filter((_reason, reasonIndex) => !indexes.includes(reasonIndex));
}

/** Keep the full judgment while suppressing trace-only reasons and steer flags. */
function agentDeliveryVerdict(verdict: Verdict): Verdict {
  const reasons = agentDeliveryReasons(verdict);
  if (reasons === verdict.reasons) return verdict;
  const deliveryVerdict: Verdict = { ...verdict, reasons };
  if (verdict.offTaskTraceOnly) delete deliveryVerdict.offTaskSteer;
  if (verdict.shouldProceedTraceOnly) delete deliveryVerdict.shouldProceedSteer;
  if (verdict.intentTraceOnly) delete deliveryVerdict.intentMismatch;
  return deliveryVerdict;
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
  if (verdict.judgment) lines.push(`Jev: irreversible ${verdict.judgment.irreversible.toFixed(2)}, off-task ${verdict.judgment.offTask?.toFixed(2) ?? "n/a"}, ${verdict.judgment.scope?.replace(/_/g, " ") ?? "n/a"} (${verdict.judgment.model}, ${verdict.judgment.elapsedMs} ms)`);
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
    config.rules = { enabled: false, threshold: 1, softThreshold: 0, files: [], fallback: false, maxChars: 500, exclude: [], skip: [], sensitivePaths: {} };
  }
  if (typeof config.widget !== "object" || config.widget === null) {
    if (!missing.includes("widget")) missing.push("widget");
    config.widget = { ...defaultConfig().widget, enabled: false };
  }
  if (typeof config.widget.rules !== "string") config.widget = { ...config.widget, rules: DEFAULT_TEMPLATES.rules };
  // Same shape trap for the subagent section: 0.14 added it, and a stale shape module hands the config over without it.
  if (typeof config.subagent !== "object" || config.subagent === null || !Number.isFinite(config.subagent.threshold)) {
    if (!missing.includes("subagent")) missing.push("subagent");
    config.subagent = { enabled: false, wake: false, observer: true, threshold: 1, cooldownMs: 0 };
  }
  if (typeof config.subagent.observer !== "boolean") config.subagent = { ...config.subagent, observer: true };
  if (typeof config.widget.subagent !== "string") config.widget = { ...config.widget, subagent: DEFAULT_TEMPLATES.subagent };
  return { config, missing };
}

/** Native Pi registration; importing the root library does not load this module. */
let indexRunning = false;
let indexWritePaths: string[] = [];

/** Test-only: set the index-running state and write paths for the action guard bypass. */
export function _testSetIndexRunning(running: boolean, paths: string[] = []): void {
  indexRunning = running;
  indexWritePaths = paths;
}


/* ─── One-time migration notice ─────────────────────────────────────── */

const MIGRATION_MARKER = ".pi-warden-migration-notice-shown";

/** Single-quote a path for /bin/sh; an embedded quote ends the string, escapes itself, and reopens. */
function shellQuote(value: string): string {
  return `'` + value.replaceAll("'", `'\\''`) + `'`;
}

/** The absolute, symlink-free, on-disk-case form of a directory; a missing directory falls back to its absolute path. */
function canonicalDirectory(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return pathResolve(path);
  }
}

/**
 * The one-time migration message for a host whose agent directory is not Pi's default, when data
 * still lives only under the default and this host has not shown the notice yet: undefined
 * otherwise. The caller checks the filesystem for data and the marker. The directories are compared
 * in absolute, symlink-free form: the same directory under another spelling (trailing slash, `.`
 * segment, symlink) gets no notice, because the command would move the only copy aside. The command
 * moves the fresh data this host may have created aside (non-destructive, and works when the target
 * folder does not exist) and copies the legacy data whole in its place.
 */
export function legacyDataNotice(
  dirs: HostDirs,
  piDefault: HostDirs,
  exists: (path: string) => boolean,
): string | undefined {
  const agentDir = canonicalDirectory(dirs.agentDir);
  const piAgentDir = canonicalDirectory(piDefault.agentDir);
  if (agentDir === piAgentDir) return undefined;
  const legacy = join(piAgentDir, PACKAGE_NAME);
  if (!exists(legacy)) return undefined;
  const target = join(agentDir, PACKAGE_NAME);
  if (exists(join(agentDir, MIGRATION_MARKER))) return undefined;
  const command = `{ [ ! -e ${shellQuote(target)} ] || mv ${shellQuote(target)} ${shellQuote(`${target}.before-migration`)}; } && cp -R ${shellQuote(legacy)} ${shellQuote(target)}`;
  return `pi-warden now keeps its data in ${target}. Your earlier config and learning data are in ${legacy}. To keep them, close all Pi and oh-my-pi sessions, then run \`${command}\`. Also copy each project's ${join(piDefault.configDirName, PROJECT_CONFIG_FILE)} to ${join(dirs.configDirName, PROJECT_CONFIG_FILE)} and keep the original.`;
}

export default function wardenExtension(host: ExtensionAPI): void {
  const pi = adaptHost(host);
  // The host boundary: this module already imports the Pi peer at runtime (via load.js), so it reads
  // the host's agent directory here once and passes it to every library path call below. The library
  // modules stay free of runtime Pi imports.
  const dirs = { agentDir: getAgentDir(), configDirName: CONFIG_DIR_NAME };
  // The beta policy is held in this closure and passed to the activation gate on every delivery
  // check; there is no module state. A question-wording change breaks the hash test and the gate
  // fail-closes (no delivery) until the policy is re-measured.
  const consciencePolicy = CONSCIENCE_BETA_POLICY;
  let client: TypeSafe | undefined;
  const cooldown = new JudgeCooldown();
  let judgeConfig: WardenConfig | undefined;
  /** Where cooldown notices go; unset headless, where a failure is already silent (see noteError). */
  let noticeUi: { notify(text: string, level: "info" | "warning"): void } | undefined;
  let budgetExhausted = false;
  let stats = freshStats();
  const widget = new Map<GuardName, string>();
  const trace = new Trace();
  // The trace file for a host without the terminal UI; set per session when PI_WARDEN_TRACE_DIR is an absolute path.
  let traceFile: TraceFile | undefined;
  let unsubscribeTraceFile: (() => void) | undefined;
  // Directories outside the project the host lets its agent write; set per session from PI_WARDEN_HOST_PATHS.
  let sessionHostPaths: string[] = [];
  // Scratch roots the host declares; set per session from PI_WARDEN_SCRATCH_PATHS.
  let sessionScratchPaths: string[] = [];
  let panel: PanelController | undefined;
  let configPanel: PanelController | undefined;
  let lastUi: PanelUi | undefined;
  const actionGuard = new ActionGuard();
  // Arming rules: session-scoped state that correlates preparation edits with later commands.
  const arming = new ArmingTracker([]);
  const rulesGuard = new RulesGuard();
  // Hold feedback: what the user did after each judged call, the trace entry each label lands on, and the per-session log.
  const holds = new HoldLedger();
  const learningIds = new Map<number, Promise<number>>(); // holds.id -> promise of learning.id
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
  /** The session id of the open session; every hold row of it carries it. */
  let activeSessionId: string | undefined;
  // Local rules verdict log for this session; a write failure is silent to the agent and shown once in the trace.
  let rulesLog: RulesLog | undefined;
  // Allowed calls of the turn the user just replied to; the regret question about them rides the next action request.
  let regretCandidates: PreviousAction[] = [];
  let attempts = new AttemptWindow(defaultConfig().stuck.window);
  // Call-waste notes for this session; the tip is offered once, the notes are rate limited per detector.
  const waste = new WasteTracker();
  let wasteTipOffered = false;
  /** Full output text and saved path keyed by attempt call key, for stuck-loop diffs. */
  let fullOutputs = new Map<string, { text: string; path?: string }>();
  let evidence: RunEvidence = emptyEvidence();
  let doneNudged = false;
  // Turn rules: the read-only working-tree snapshot started at run start and awaited at run end, and the files a
  // per-edit judgment saw.
  let turnSnapshot: Promise<SnapshotResult> | undefined;
  let turnJudged = new Set<string>();
  /** True from a delivered warden follow-up that starts a turn until the next run starts: that run keeps the evidence. */
  let wardenContinuation = false;
  let warnedFallback = false;
  let warnedMissingRules = false;
  /** True while /warden init is sending a prompt and waiting for the agent to generate pi-warden.md. */
  let initRunning = false;
  /** The most recent /warden rules calibrate result; /warden rules tune reads its flagged rules. */
  let lastCalibration: Calibration | undefined;
  /** The most recent /warden rules check result of this session; /warden rules tune reads its flagged rules. */
  let lastCheck: RulesCheckResult | undefined;
  /** True while /warden audit is sending a prompt and waiting for the agent to write the report. */
  let auditRunning = false;
  const prose = new ProseTrend();
  const slopCounts: Record<SlopSymptom, number> = { stub: 0, comments: 0, dead: 0, hedging: 0 };
  const ledger = new ContextLedger();
  /** The turn-start rules reminder's requests, rules named, and latency, for /warden status. */
  const curator = new CuratorLedger();
  /** Relevance compactions this session, for /warden status. */
  const compactions: { runs: number; replaced: number; fallbacks: Partial<Record<FallbackReason | "skipped" | "judgments off", number>>; last?: CompactionStats | undefined } = { runs: 0, replaced: 0, fallbacks: {} };
  /** The trace entry of this turn's latest saving; its ledger line was written before the turn counted, so turn_end adds one that has. */
  let savingEntry: TraceEntry | undefined;
  // Learns which compression strategies work best per tool, so the next call skips the judge when confident.
  const compressionLearner = new CompressionLearner();

  // Secrets already announced this session, by fingerprint: the same key read twice earns one banner and one steer.
  const secretsSeen = new Set<string>();
  // Subagent report entries already triaged, by session entry id; the wake window outlives one scan.
  const subagentSeen = new Set<string>();
  // Command families already steered toward filtered output this session: one steer per family.
  const largeOutputSteered = new Set<string>();
  // Real paths the agent created under the temp directory this session, with the identity each had when recorded.
  // A recursive rm of only these is not destructive; a record whose path is gone or replaced is dropped after each call.
  const sessionScratch = new Map<string, ScratchIdentity>();
  // Paths an earlier call moved or linked data into, under a volatile temp root or a declared scratch root. A later rm
  // of a path equal to, inside, or above one of these is never released, whatever created it.
  const sessionMovedIn = new Set<string>();
  // Per tool call id: when it started and the temp paths it may create that did not exist yet.
  const scratchPending = new Map<string, { started: number; candidates: string[]; moved: string[] }>();
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
  /** One scan of the earlier sessions per session start, shared by the injection and `/warden prefs`. */
  let prefsScan: Promise<PrefsScan> | undefined;
  const PREFS_TYPE = `${PACKAGE_NAME}-prefs`;
  const standingPrefs = (ctx: ExtensionContext | ExtensionCommandContext): Promise<PrefsScan> => {
    if (prefsScan) return prefsScan;
    const manager = ctx.sessionManager as Partial<ExtensionContext["sessionManager"]>;
    const dir = typeof manager.getSessionDir === "function" ? manager.getSessionDir() : undefined;
    const exclude = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined;
    return prefsScan = dir ? scanPreferences({ dir, exclude, cwd: ctx.cwd }) : Promise.resolve({ prefs: [], candidates: [], counts: emptyWordCounts(), project: ctx.cwd, scanned: 0, directories: 0, ms: 0 });
  };
  /** The scan, the project's lesson file, and every listed item with its status; read fresh so `forget` numbers match. */
  const evaluatedPrefs = async (ctx: ExtensionContext | ExtensionCommandContext): Promise<{ scan: PrefsScan; path: string; items: PrefItem[] }> => {
    const scan = await standingPrefs(ctx);
    const path = prefsStorePath(scan.project, dirs);
    return { scan, path, items: evaluatePrefs(scan, await readPrefsStore(path)) };
  };
  // The open-loop list the last end-of-run reminder named: the same unchanged list is not named again.
  let loopsReminded: string | undefined;
  const LOOPS_TYPE = `${PACKAGE_NAME}-loops`;
  /** The session's loops file, or undefined when the host gives the session no id (nothing to key it by). */
  const loopsFile = (ctx: ExtensionContext | ExtensionCommandContext): string | undefined => {
    const manager = ctx.sessionManager as Partial<ExtensionContext["sessionManager"]> | undefined;
    const id = typeof manager?.getSessionId === "function" ? manager.getSessionId() : undefined;
    return id ? loopsPath(ctx.cwd, id, dirs) : undefined;
  };
  /**
   * On resume, one message lists the loops still open, so a session picked up later knows what it promised. Not a steer.
   * A branch whose last loops message says the same already has it.
   */
  const announceLoops = async (ctx: ExtensionContext, config: WardenConfig, branch: ReadonlyArray<{ type: string; customType?: string; content?: unknown }>) => {
    const file = loopsFile(ctx);
    if (!file) return;
    try {
      const open = openLoops(await readLoops(file));
      if (!open.length) return;
      const content = `Open loops from earlier in this session (warden_loops):\n${formatOpenLoops(open)}\nClose each with warden_loops done or drop once it is finished or no longer needed.`;
      const last = [...branch].reverse().find(entry => entry.type === "custom_message" && entry.customType === LOOPS_TYPE);
      if (last?.content === content) return;
      pi.sendMessage({ customType: LOOPS_TYPE, content, display: config.steerVisible });
    } catch (error) {
      console.warn("pi-warden: reading the loops file failed:", error instanceof Error ? error.message : String(error));
    }
  };

  // A partially updated module graph can hand this build a config without the sections it expects; see shape.ts.
  let shapeReported = false;
  // An exemptRules id that names neither a built-in nor one of the user's own rules is inert; said once, not per call.
  let exemptReported = false;
  // PI_WARDEN_SCRATCH_PATHS entries that were ignored: said once per process, not once per session.
  let scratchPathsReported = false;
  let inertReported = false;
  let unparseableReported = false;
  // Config values that were not applied as written: said once per session; /warden status repeats them.
  let configWarningsReported = false;
  const configFor = (ctx: ExtensionContext | ExtensionCommandContext): WardenConfig => {
    const { config, missing } = guardCurrentSections(completeConfig(loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), dirs })));
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
    const warnings = config.warnings ?? [];
    if (warnings.length && !configWarningsReported) {
      configWarningsReported = true;
      const text = `warden: config warnings: ${warnings.join("; ")}`;
      if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
    }
    arming.updateRules(config.action.armingRules);
    return config;
  };
  const consentGiven = (config: WardenConfig) => config.typesafe || process.env.PI_WARDEN_ENABLED === "1";
  /** Why no judge is available, or undefined when one is. The notice, the trace file, and the conscience all use it. */
  const judgmentsOffReason = (config: WardenConfig): JudgmentsOffReason | undefined => {
    // A refused backend is a config error the user must see even before consent or keys matter.
    const backend = config.typesafeBackend;
    if (config.backendRefusal !== undefined || backend === undefined) return "bad_backend";
    if (!consentGiven(config)) return "no_consent";
    if (budgetExhausted) return "budget";
    const auth = authState({ backend });
    if (auth.usable) return undefined;
    // No key in effect, or one whose last request came back 401 or 403.
    return auth.source === undefined ? "no_key" : "key_rejected";
  };
  // Where the judgments-off notice goes: the session's UI, or a status message for a headless session.
  let judgmentsNotify: ((text: string) => void) | undefined;
  let judgmentsHeadless = false;
  const judgmentsReported = new Set<JudgmentsOffReason>();
  /** Say once per session and reason that judgments are off, and record the state in the trace file. */
  const noteJudgments = (config: WardenConfig, reason: JudgmentsOffReason | undefined) => {
    traceFile?.judgments(judgmentsState(reason));
    // The budget has its own notice in noteError.
    if (reason === undefined || reason === "budget" || judgmentsReported.has(reason)) return;
    judgmentsReported.add(reason);
    const auth = reason === "key_rejected" && config.typesafeBackend !== undefined ? authState({ backend: config.typesafeBackend }) : undefined;
    judgmentsNotify?.(judgmentsOffText(reason, config, judgmentsHeadless, auth?.kind === "environment" ? auth.keyName : undefined));
  };
  const consentSource = (config: WardenConfig) => config.typesafe ? "/warden enable" : process.env.PI_WARDEN_ENABLED === "1" ? "PI_WARDEN_ENABLED" : undefined;
  /** A consent flag is not proof that judgments happen; check the key state for the chosen backend. */
  const judgeFor = (config: WardenConfig, quiet = false): TypeSafe | undefined => {
    const off = judgmentsOffReason(config);
    if (!quiet) noteJudgments(config, off);
    if (off) return undefined;
    judgeConfig = config;
    // Absent, exactly as with no judge configured, so no guard needs to know a cooldown exists.
    if (cooldown.active()) { stats.cooldownSkips++; return undefined; }
    if (client) return client;
    const backend = config.typesafeBackend;
    // Reached only if a config ever sets no backend and no refusal at once; treating it as off keeps the invariant.
    if (backend === undefined) return undefined;
    try {
      client = watched(createTypeSafe(judgeOptions({ maxRequests: config.maxRequests, timeoutMs: config.timeoutMs, typesafeBackend: backend })));
    } catch (error) {
      // An endpoint the config accepts can still be unusable (one that names no defaultModel); a hook must never crash.
      const message = error instanceof Error ? error.message : String(error);
      if (!quiet && !judgmentsReported.has("bad_backend")) {
        judgmentsReported.add("bad_backend");
        traceFile?.judgments(judgmentsState("bad_backend"));
        judgmentsNotify?.(`warden: Jev judgments are off (typesafeBackend refused: ${message})`);
      }
      return undefined;
    }
    return client;
  };
  // The observer shares the watched client but never sends cooldown notices of its own.
  const quietSignals = new WeakSet<AbortSignal>();
  /** Every guard reaches the backend through `evaluate`, so this one seam sees each failure and each success. */
  const watched = (typesafe: TypeSafe): TypeSafe => new Proxy(typesafe, {
    get(target, prop, receiver) {
      if (prop !== "evaluate") return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<TypeSafe["evaluate"]>) => {
        try {
          const result = await target.evaluate(...args);
          const event = cooldown.success();
          if (!args[1]?.signal || !quietSignals.has(args[1].signal)) tellCooldown(event);
          return result;
        } catch (err) {
          const kind = cooldownFailureKind(err, args[1]?.signal);
          if (kind) {
            const event = cooldown.failure(kind, judgeConfig?.judge ?? defaultConfig().judge);
            if (!args[1]?.signal || !quietSignals.has(args[1].signal)) tellCooldown(event);
          }
          throw err;
        }
      };
    },
  });
  const tellCooldown = (event: CooldownEvent | undefined) => {
    if (!event || !noticeUi) return;
    if (event.type === "recovered") { noticeUi.notify("warden: judgments resumed.", "info"); return; }
    const seconds = Math.round(event.ms / 1000);
    const remedy = event.kind === "auth"
      ? ` Set ${resolveBackend(judgeConfig?.typesafeBackend).keyEnv} or run /warden enable.`
      : event.kind === "configuration" ? " /warden status shows the backend setup." : "";
    noticeUi.notify(`warden: judgments paused for ${seconds}s after a ${event.kind} failure; pattern checks run alone until then.${remedy}`, "warning");
  };
  const noteError = (ctx: ExtensionContext, message: string, code: string | undefined) => {
    stats.errors++;
    if (code === "budget") budgetExhausted = true;
    if (ctx.hasUI) ctx.ui.notify(`warden: ${message}${budgetExhausted ? " Pattern checks continue without TypeSafe for the rest of this session." : ""}`, "warning");
  };
  /** Click, shortcut, and /warden trace all toggle the same sidebar. */
  const togglePanel = (ui: PanelUi | undefined, config: WardenConfig) => {
    if (!ui) return undefined;
    if (panel) { panel.close(); return undefined; }
    const opened = openTracePanel(ui, trace, { width: config.widget.panelWidth });
    panel = opened;
    opened.closed.catch(() => undefined).finally(() => { if (panel === opened) panel = undefined; });
    return opened;
  };
  /** The last 20 trace entries as text, newest last, for a host that cannot show the sidebar. */
  const traceText = () => {
    const entries = trace.entries();
    const text = entries.length ? entries.slice(-20).map(entry => `${new Date(entry.at).toTimeString().slice(0, 8)} ${entry.guard}: ${entry.line}${entry.details.length ? `\n  ${entry.details.join("\n  ")}` : ""}`).join("\n") : "No guarded activity yet this session.";
    return traceFile ? `${text}\nTrace file: ${traceFile.path}` : text;
  };
  /** The config overlay toggles the same way the sidebar does, so the hint in its header is true. */
  const toggleConfigPanel = (ui: PanelUi | undefined, config: WardenConfig) => {
    if (!ui) return;
    if (configPanel) { configPanel.close(); return; }
    const opened = openConfigPanel(ui, config, { width: config.widget.panelWidth, dirs });
    configPanel = opened;
    opened.closed.catch(() => undefined).finally(() => { if (configPanel === opened) configPanel = undefined; });
  };
  const paint = (ctx: ExtensionContext | ExtensionCommandContext, config: WardenConfig) => {
    if (!ctx.hasUI) return;
    lastUi = ctx.ui as unknown as PanelUi;
    if (!config.widget.enabled || widget.size === 0) { ctx.ui.setWidget(WIDGET, undefined); return; }
    let entries = [...widget].map(([guard, line]) => ({ guard, line }));
    // In live mode: only show the most recent guard, re-rendered with sentence templates.
    if (config.widget.barMode === "live" && entries.length > 0) {
      const lastEntry = trace.entries().at(-1);
      if (lastEntry?.tokens) {
        const template = pickSentenceTemplate(lastEntry.guard, lastEntry.tokens);
        const sentence = renderTemplate(template, lastEntry.tokens);
        const chip = lastEntry.tokens.level ?? lastEntry.tokens.status;
        ctx.ui.setWidget(WIDGET, (_tui, theme) => {
          const color = LEVEL_COLOR[chip ?? ""] ?? "text";
          const chipText = chip ? `${theme.bold(theme.fg(color as "text", chip.toUpperCase()))}  ` : "";
          const guardText = theme.fg("muted", lastEntry.guard + " ");
          // Like widgetLines: the head width is tracked, the body wraps to what remains, and a line wider than
          // the pane trips pi's render-width guard, which aborts the session.
          const chipWidth = chip ? chip.length + 2 : 0;
          const headWidth = chipWidth + lastEntry.guard.length + 1;
          const head = chipText + guardText;
          const body = {
            render: (width: number) => {
              if (!width) return [head + sentence];
              const wrapped = tuiModule.wrapTextWithAnsi(sentence, Math.max(10, width - headWidth));
              return [head + (wrapped[0] ?? ""), ...wrapped.slice(1).map(rest => " ".repeat(headWidth) + rest)];
            },
            invalidate: () => {},
          };
          return MouseRegion ? new MouseRegion(body, event => {
            if (event.type !== "click" || event.button !== "left") return undefined;
            togglePanel(lastUi, config);
            return { handled: true };
          }) : body;
        }, { placement: config.widget.placement });
        return;
      }
      entries = [lastEntry ?? entries.at(-1)!];
    }
    // A custom component so the lines wrap to the pane and a click (fullscreen mode) opens the trace panel.
    // When the host TUI lacks MouseRegion (e.g. omp 18.2.5), the extension still loads — the widget
    // renders the same text, but a click does nothing. A missing named import is a link-time error
    // that kills the entire extension silently; a missing namespace property is undefined.
    ctx.ui.setWidget(WIDGET, (_tui, theme) => {
      const body = statusWidget(entries, theme);
      return MouseRegion ? new MouseRegion(body, event => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        togglePanel(lastUi, config);
        return { handled: true };
      }) : body;
    }, { placement: config.widget.placement });
  };
  const record = (ctx: ExtensionContext | ExtensionCommandContext, config: WardenConfig, guard: GuardName, line: string, details: string[], tokens?: Record<string, string | undefined>): TraceEntry => {
    widget.delete(guard);
    widget.set(guard, line);
    const entry: TraceEntry = { at: Date.now(), guard, line, details, tokens };
    trace.push(entry);
    paint(ctx, config);
    return entry;
  };
  /** A judged output the saver left whole gets a trace line with its verdict, so the confidence gate can be calibrated.
   *  Trace only: nothing happened to the output, so the status line keeps the last real context event. */
  /** Text already in context on the current branch, for repeated-run detection. Synced before each check, not kept by hand. */
  const seenText = new SeenText();
  const syncSeen = (ctx: ExtensionContext) => {
    const manager = ctx.sessionManager as Partial<ExtensionContext["sessionManager"]>;
    // Compaction-aware when the host has it: text a compaction summarized is no longer in context, so nothing may point to it.
    const entries = typeof manager.buildContextEntries === "function" ? manager.buildContextEntries() : typeof manager.getBranch === "function" ? manager.getBranch() : [];
    seenText.sync(entries.map(seenItem).filter(item => item !== undefined));
  };
  /** `text` with each run that repeats context replaced by a pointer line, or undefined when nothing repeats or the copy cannot be stored. */
  const dedupeText = async (ctx: ExtensionContext, config: WardenConfig, text: string, source: string): Promise<string | undefined> => {
    const runs = seenText.find(text);
    if (!runs.length) return undefined;
    try {
      const path = await saveOutput(text);
      const collapsed = collapseRuns(text, runs, path);
      const bytesSaved = Buffer.byteLength(text) - Buffer.byteLength(collapsed);
      ledger.repeat(path, bytesSaved, { tool: source, bytes: Buffer.byteLength(text) });
      savingEntry = record(ctx, config, "context", renderTemplate(config.widget.context, { tool: source, retention: "repeat", bytesSaved: String(bytesSaved) }), [
        ...runs.map(run => `${run.lines} lines (${run.chars} characters) repeat ${run.where}`),
        `saved ${bytesSaved} bytes; full text: ${path}`,
        formatLedger(ledger.snapshot()),
      ]);
      return collapsed;
    } catch {
      noteError(ctx, "Could not store full text; keeping the repeated run.", undefined);
      return undefined;
    }
  };
  /** Text parts only; images and other parts keep their place and bytes. */
  const dedupeContent = async <Part extends { type: string }>(ctx: ExtensionContext, config: WardenConfig, content: Part[], source: string): Promise<Part[] | undefined> => {
    let changed: Part[] | undefined;
    for (let index = 0; index < content.length; index++) {
      const part = content[index]! as Part & { text?: unknown };
      if (part.type !== "text" || typeof part.text !== "string") continue;
      const text = await dedupeText(ctx, config, part.text, source);
      if (text === undefined) continue;
      changed ??= [...content];
      changed[index] = { ...part, text };
    }
    return changed;
  };
  const recordKeptWhole = (config: WardenConfig, tool: string, verdict: OutputVerdict, prefix = "") => {
    trace.push({ at: Date.now(), guard: "context", line: renderTemplate(config.widget.context, { tool, retention: "kept whole" }), details: [
      `${prefix}kept whole: retention ${verdict.retention}; confidence ${verdict.confidence?.toFixed(2)}; format ${verdict.format ?? "generic"}${verdict.formatConfidence === undefined ? "" : ` (${verdict.formatConfidence.toFixed(2)})`}; ${verdict.model}; ${verdict.elapsedMs} ms`,
    ] });
  };
  /**
   * The context filter (beta) for one output that would get the generic excerpt. Never throws; a fallback keeps the
   * excerpt. Its cost and fallback reason go to the ledger either way.
   */
  const runFilter = async (ctx: ExtensionContext, config: WardenConfig, tool: string, input: Record<string, unknown>, text: string, excerpt: string): Promise<FilterResult> => {
    const judge = judgeFor(config);
    if (!judge) {
      const reason = judgmentsOffReason(config) ?? "cooldown";
      ledger.filterSpent(0, 0, reason);
      return { ok: false, reason, chunks: 0, requests: 0, elapsedMs: 0 };
    }
    const command = typeof input.command === "string" ? input.command : JSON.stringify(input);
    let result = await filterOutput(text, {
      tool, command, task: latestUserPrompt(ctx), spine: taskSpine(ctx.sessionManager.getBranch()), plan: assistantPlan(ctx),
    }, { config: config.context.filter, judge, signal: ctx.signal });
    // Kept text is bounded by maxKeptChars; the gap markers are not, so the bound is checked on the result.
    if (result.ok && result.text.length > excerpt.length + config.context.filter.maxKeptChars) result = { ok: false, reason: "too_long", chunks: result.chunks, requests: result.requests, elapsedMs: result.elapsedMs };
    ledger.filterSpent(result.requests, result.elapsedMs, result.ok ? undefined : result.reason);
    if (!result.ok && result.reason === "budget") noteError(ctx, "TypeSafe request budget reached; the context filter kept the excerpt.", "budget");
    return result;
  };
  /** Labels landed on earlier calls: their trace entries say so and the session log is rewritten. */
  const noteOutcomes = (config: WardenConfig, records: readonly CallRecord[]) => {
    for (const item of records) {
      const entry = traceOf.get(item);
      if (entry) trace.amend(entry, outcomeNote(item));
      const idPromise = learningIds.get(item.id);
      if (idPromise && item.outcome !== "pending") {
        idPromise.then(id => recordOutcome(id, item.outcome, dirs)).catch(err => console.warn("pi-warden: recordOutcome failed:", err));
      }
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
  /** Follow and dispute counts per (model, steer kind), kept across sessions; and the sent steers still waiting for a reply. */
  const steerStats = new SteerStats(steerStatsPath(dirs));
  const steerWatch = new SteerWatch();
  /** Session generation counter for conscience invalidation. Incremented on steer, abort, reload, switch, or config change. */
  let conscienceGeneration = 0;
  /** Per-prompt error categories already warned about (one console.warn per category per prompt). */
  let warnedErrorCategories = new Set<string>();
  // ── Conscience state per prompt revision ──
  let selectedCapability: { kind: string; id: string } | null = null;
  let pendingCapability: { kind: string; id: string } | null = null;
  let triggerConsumed = false;
  let assessmentsThisPrompt = 0;
  let nudgesThisPrompt = 0;
  let reminderSent = false;
  let lastAssessmentHash = "";
  let cachedSkills: Array<{ name: string; description: string; filePath?: string }> = [];
  let loadedBytes = 0;
  let instructionState: "none" | "queued" | "instructions_supplied" = "none";
  let loadedSkillNames = new Set<string>();
  let queuedRevision = 0;
  let beforeAgentStartFired = false;
  let needsReassessment = false;
  // Index state: loaded once per session, nudged once when stale.
  let globalIndexFile: IndexFile | undefined;
  let projectIndexFile: IndexFile | undefined;
  let indexNudged = false;

  /** The final messages of the current run, for restatement measurement. */
  const finals = new RestatementWindow();
  /** Returns true when the message was delivered; false means it was recorded in the trace only. */
  /**
   * Check whether a non-critical message can be delivered within the per-run steer budget.
   * Returns true when the budget allows delivery; false means record-only. Conscience uses this
   * to gate pre-response delivery without going through the steer path.
   */
  const budgetAvailable = (config: WardenConfig): boolean => config.steerBudget > 0 && steersThisRun < config.steerBudget;
  /** Reserve one budget unit. Call only when budgetAvailable returned true. */
  const spendBudgetUnit = (): void => { steersThisRun++; };
  const steer = (config: WardenConfig, guard: SteerGuard | readonly SteerGuard[], content: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean; display?: boolean }): boolean => {
    const names = typeof guard === "string" ? [guard] : [...guard];
    for (const name of names) stats.steerGuards[name] = (stats.steerGuards[name] ?? 0) + 1;
    const critical = names.every(name => CRITICAL_STEER_GUARDS.has(name));
    // A notice delivered once is already in the agent's context. Sending the repeat again costs the accounting turn it
    // forbids, so repeats are recorded only. The same goes for notices past the per-run steer budget: a steer sent during
    // a tool call rides the request the tool result needs (tests/steer-delivery.test.ts), but one queued after the run
    // ends starts a new model turn, and every steer asks the agent for a reply sentence; a closing run that collects six
    // notices collects six restatements of the final status. A notice skipped for the budget keeps its fingerprint, so the same notice can deliver next run.
    // Critical guards (stuck, done, runaway recovery, subagent wake) always deliver: their message starts the turn.
    const overBudget = config.steerBudget > 0 && steersThisRun >= config.steerBudget;
    const deliver = critical || (!overBudget && !steerRepeats.seen(content));
    if (!deliver) {
      stats.steersSkipped++;
      return false;
    }
    stats.steers++;
    steersThisRun++;
    const { display, ...delivery } = options ?? { deliverAs: "steer" as const };
    pi.sendMessage({ customType: `${PACKAGE_NAME}-steer`, content, display: display ?? config.steerVisible }, delivery);
    if (delivery.triggerTurn) wardenContinuation = true;
    return true;
  };
  /**
   * A notice a background judgment made ready. `before_agent_start` never waits for Jev, so an answer that arrives while
   * its run is active waits here until `turn_end`. Pi's loop reads its steering queue right after that event and goes on
   * to another model call only when the turn ran tool calls and not every result set `terminate`; the notice is steered
   * then, at the end of a turn whose loop continues, so it rides a call the run makes anyway. In any other case, and when the run ends first, it is dropped and the
   * trace says why: a steer queued by a turn that ends the run would otherwise stay in Pi's queue and join the next run's
   * first request. The turn-start rules reminder is budget-exempt: it is one message per user prompt, and the per-run
   * budget counts the guards' own notices.
   */
  interface PendingNotice { customType: string; content: string; guard: GuardName; delivered: string; dropped: string; details: string[] }
  let pendingNotices: PendingNotice[] = [];
  /** True from a new prompt's `before_agent_start` until its `agent_end`; a notice that arrives later is dropped. */
  let agentRunActive = false;
  /** Incremented per user prompt; a background answer from an older prompt never reaches the next run. */
  let promptEpoch = 0;
  /** The steer path without the budget: queue the notice so it rides the request the next tool result needs. */
  const deliverPendingNotices = (ctx: ExtensionContext, config: WardenConfig): void => {
    if (!pendingNotices.length) return;
    const notices = pendingNotices;
    pendingNotices = [];
    for (const notice of notices) {
      pi.sendMessage({ customType: notice.customType, content: notice.content, display: config.steerVisible }, { deliverAs: "steer" });
      record(ctx, config, notice.guard, notice.delivered, notice.details);
    }
  };
  /**
   * What `tool_execution_end` reported for the turn in flight: how many top-level results arrived and whether every one set
   * `terminate`. Only `terminate` is read from it; the call count comes from `turn_end`, because a host need not send this event.
   */
  let batchResults = 0;
  let batchTerminates = true;
  /** The tool calls of the turn: the host's results when `turn_end` carries them, else the tool calls in the assistant message. */
  const turnCalls = (event: { message?: unknown; toolResults?: readonly unknown[] }): number => {
    if (Array.isArray(event.toolResults)) return event.toolResults.length;
    const content = (event.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? content.filter(part => (part as { type?: unknown } | null)?.type === "toolCall").length : 0;
  };
  /** At `turn_end`: deliver the queued notices only when the loop continues anyway; otherwise drop them with a trace line. */
  const settleNotices = (ctx: ExtensionContext, config: WardenConfig, event: { message?: unknown; toolResults?: readonly unknown[] }): void => {
    const calls = turnCalls(event);
    // The batch ended the run only when the host reported a result for every call and every result set `terminate`.
    const terminates = batchResults > 0 && batchResults >= calls && batchTerminates;
    batchResults = 0;
    batchTerminates = true;
    if (!pendingNotices.length) return;
    const stopReason = (event.message as { stopReason?: string } | undefined)?.stopReason;
    if (stopReason === "error" || stopReason === "aborted" || ctx.signal?.aborted) dropPendingNotices(ctx, config, "the turn failed or was aborted, so the run was ending");
    else if (!calls) dropPendingNotices(ctx, config, "the turn made no tool call, so the run was ending");
    else if (terminates) dropPendingNotices(ctx, config, "every tool result in the batch ended the run");
    else deliverPendingNotices(ctx, config);
  };
  /** A run that ended before a queued notice could ride a model call the run makes anyway appends nothing; the trace says which one and why. */
  const dropPendingNotices = (ctx: ExtensionContext, config: WardenConfig, reason: string): void => {
    if (!pendingNotices.length) return;
    const notices = pendingNotices;
    pendingNotices = [];
    for (const notice of notices) record(ctx, config, notice.guard, notice.dropped, [reason, ...notice.details]);
  };
  /** A conscience tip that passed the budget and the activation gate waits for the end of a turn whose loop continues, like the reminder. */
  const queueConscienceTip = (content: string, detail: string): void => {
    pendingNotices.push({
      customType: `${PACKAGE_NAME}-conscience`,
      content,
      guard: "conscience",
      delivered: "warden · conscience · tip delivered at the end of a turn whose loop continued",
      dropped: "warden · conscience · tip dropped (the run ended first)",
      details: [`tip: ${detail}`, "the tip passed the budget and the activation gate; no turn whose loop continued ended before it was dropped"],
    });
  };
  const modelKey = (ctx: ExtensionContext): string | undefined => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const KIND_GUARD: Partial<Record<SteerKind, GuardName>> = { rules: "rules", "sensitive-path": "rules", "security-write": "security", stuck: "stuck", repeat: "stuck", prose: "prose", conscience: "conscience" };
  /**
   * False when steers of this kind are trace-only for the current model; the skipped note gets a trace line. Holds and
   * judgments are not affected: only whether the note reaches the agent.
   */
  const adaptiveSend = (ctx: ExtensionContext, config: WardenConfig, kind: SteerKind): boolean => {
    const model = modelKey(ctx);
    if (!model) return true;
    const decision = steerStats.request(model, kind, config.steers);
    if (decision !== "trace-only") return true;
    const pair = steerStats.pair(model, kind);
    const rates = pair ? `${pair.sent} steers observed, ${Math.round((pair.followed / Math.max(1, pair.sent)) * 100)}% followed, ${Math.round((pair.disputed / Math.max(1, pair.sent)) * 100)}% disputed` : "no counts";
    stats.steersMuted++;
    record(ctx, config, KIND_GUARD[kind] ?? "action", `warden · steer trace-only · ${kind} · ${model}`, [
      `${kind} steers are trace-only for ${model} (${rates}); 1 in ${config.steers.probeEvery} is still sent for the re-check`,
      `/warden unmute ${kind} sends them again`,
    ]);
    return false;
  };
  /** A delivered steer waits for the agent's next two messages; its outcome is counted for the (model, kind) pair. */
  const watchSteer = (ctx: ExtensionContext, config: WardenConfig, kinds: readonly SteerKind[], subject: SteerSubject = {}, nextTurn = false) => {
    const model = modelKey(ctx);
    if (!model || !config.steers.adaptive) return;
    steerWatch.add(model, kinds.filter(kind => !NEVER_MUTED.has(kind) || kind === "done"), subject, { nextTurn });
  };
  const settleSteers = (config: WardenConfig, outcomes: ReturnType<SteerWatch["user"]>) => {
    for (const outcome of outcomes) steerStats.observe(outcome.model, outcome.kind, outcome, config.steers);
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

  // EventBus listeners must claim during synchronous dispatch; no async work precedes claim.
  pi.events?.on("pi-subagents/supervision-evaluate/v1", (value: unknown) => {
    try {
      if (value === null || typeof value !== "object" || typeof (value as { claim?: unknown }).claim !== "function") return;
      const request = value as { version?: unknown; metrics?: unknown; claim(result: Promise<unknown>): boolean };
      const valid = validateSupervisionRequest({ version: request.version, metrics: request.metrics });
      if (!valid) return;
      const config = guardCurrentSections(completeConfig(loadConfig({ cwd: sessionCwd, projectTrusted: sessionTrusted, dirs }))).config;
      if (!config.enabled || !config.subagent.observer) return;
      const judge = judgeFor(config, true);
      if (!judge) return;
      const spend = judge.getSpend();
      if (spend.blocked || judge.getUsage().requestsStarted >= (spend.caps.maxRequests ?? config.maxRequests)) return;
      const quietJudge = new Proxy(judge, {
        get(target, prop, receiver) {
          if (prop !== "evaluate") return Reflect.get(target, prop, receiver);
          return (...args: Parameters<TypeSafe["evaluate"]>) => {
            if (args[1]?.signal) quietSignals.add(args[1].signal);
            return target.evaluate(...args);
          };
        },
      });
      // A different listener may have claimed first: only the winning claim may spend a request.
      let resolveResult!: (result: unknown) => void;
      const pending = new Promise<unknown>(resolve => { resolveResult = resolve; });
      if (request.claim(pending)) {
        queueMicrotask(() => {
          void evaluateSupervision(valid.metrics, {
            judge: quietJudge, backend: config.typesafeBackend!, timeoutMs: config.timeoutMs, now: Date.now,
          }).then(resolveResult, () => resolveResult(undefined));
        });
      } else resolveResult(undefined);
    } catch {
      // No claim survives a synchronous setup failure; Guardian treats the trigger as unavailable.
      return;
    }
  });
  let sessionCwd = process.cwd();
  let sessionTrusted = false;
  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    sessionTrusted = ctx.isProjectTrusted();
    if (ctx.hasUI) lastUi = ctx.ui as unknown as PanelUi;
    noticeUi = ctx.hasUI ? ctx.ui : undefined;
    // Each session hears the config warnings once, from the configFor call below.
    configWarningsReported = false;
    // The one-time migration notice runs before any call creates <agentDir>/pi-warden (the
    // initSchema below does). Interactive sessions only: a headless session neither consumes the
    // notice nor injects a cp instruction into the agent, and the marker records what was shown.
    const migrationMessage = ctx.hasUI ? legacyDataNotice(dirs, defaultHostDirs(), existsSync) : undefined;
    if (migrationMessage) {
      try {
        writeFileSync(join(dirs.agentDir, MIGRATION_MARKER), "", { mode: 0o600 });
      } catch (err) {
        console.warn("pi-warden: could not record the migration notice marker:", err);
      }
      ctx.ui.notify(`warden: ${migrationMessage}`, "info");
    }
    cooldown.reset();
    if (_event.reason === "reload" || _event.reason === "new") conscienceGeneration++;
    client = undefined;
    budgetExhausted = false;
    warnedFallback = false;
    warnedMissingRules = false;
    initRunning = false;
    lastCalibration = undefined;
    lastCheck = undefined;
    const startupConfig = loadConfig({ dirs });
    await initSchema(startupConfig.learning.retentionDays, dirs, startupConfig.learning.allowedRetentionDays);
    stats = freshStats();
    steerWatch.clear();
    widget.clear();
    trace.clear();
    panel?.close();
    configPanel?.close();
    actionGuard.reset();
    rulesGuard.reset();
    holds.reset();
    regretCandidates = [];
    const sessionId = typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : String(process.pid);
    activeSessionId = sessionId;
    holdLog = new HoldLog(holdLogPath(sessionId, new Date(), dirs));
    rulesLog = new RulesLog(ctx.cwd, sessionId, { path: rulesLogPath(ctx.cwd, dirs), onFailure: message => record(ctx, loadConfig({ dirs }), "rules", "rules log write failed", [message]) });
    unsubscribeTraceFile?.();
    unsubscribeTraceFile = undefined;
    traceFile = undefined;
    judgmentsReported.clear();
    judgmentsHeadless = !ctx.hasUI;
    judgmentsNotify = text => { if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true }); };
    sessionHostPaths = wardenHostPaths(undefined, dirs);
    const declaredScratch = scratchPaths(process.env, ctx.cwd);
    sessionScratchPaths = declaredScratch.roots;
    if (declaredScratch.ignored.length && !scratchPathsReported) {
      scratchPathsReported = true;
      const text = `warden: ${SCRATCH_PATHS_ENV} ignored ${declaredScratch.ignored.map(item => `${item.entry} (${item.reason})`).join(", ")}`;
      if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
    }
    const dir = traceDir();
    if (dir) {
      const warn = (text: string) => { if (ctx.hasUI) ctx.ui.notify(text, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true }); };
      const opening = loadConfig({ dirs });
      traceFile = new TraceFile(traceFilePath(dir, sessionId), dir, { sessionId, cwd: ctx.cwd, mode: opening.mode, judgments: judgmentsState(judgmentsOffReason(opening)) }, warn);
      unsubscribeTraceFile = trace.subscribe(traceFile.listener);
    }
    arming.reset();
    attempts.reset();
    waste.reset();
    wasteTipOffered = false;
    evidence = emptyEvidence();
    doneNudged = false;
    wardenContinuation = false;
    prose.reset();
    // Clean up temp output dirs from the previous session.
    for (const dir of ledger.storedPaths()) {
      try { await rm(dir, { recursive: true, force: true }); } catch (err) { console.warn("pi-warden: temp cleanup failed:", err); }
    }
    ledger.reset();
    curator.reset();
    pendingNotices = [];
    agentRunActive = false;
    promptEpoch++;
    compactions.runs = 0; compactions.replaced = 0; compactions.fallbacks = {}; compactions.last = undefined;
    seenText.clear();
    savingEntry = undefined;
    compressionLearner.reset();
    secretsSeen.clear();
    subagentSeen.clear();
    largeOutputSteered.clear();
    sessionScratch.clear();
    sessionMovedIn.clear();
    scratchPending.clear();
    wakePolicy.reset();
    steerRepeats.reset();
    steersThisRun = 0;
    conscienceGeneration = 0;
    finals.reset();
    runaway.reset();
    runawayStops = 0;
    pendingRunaway = undefined;
    searchTool = undefined;
    notifier = undefined;
    lastNotifiedAt = 0;
    prefsScan = undefined;
    loopsReminded = undefined;
    // Load capability indexes (once per session, overwritten on every /warden index run).
    globalIndexFile = readIndex(indexPath("global", undefined, undefined, dirs)) ?? undefined;
    projectIndexFile = readIndex(indexPath("project", ctx.cwd, undefined, dirs)) ?? undefined;
    indexNudged = false;
    indexRunning = false;
    for (const symptom of Object.keys(slopCounts) as SlopSymptom[]) slopCounts[symptom] = 0;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    // One-time notice when confirm mode falls back to steer (headless).
    if (!warnedFallback && loadConfig({ dirs }).mode === "confirm" && !ctx.hasUI) {
      warnedFallback = true;
      const msg = "warden: confirm mode requires a UI; falling back to steer mode for this session.";
      if (ctx.hasUI) ctx.ui.notify(msg, "warning"); else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: msg, display: true });
    }
    const opening = configFor(ctx);
    // A resumed or reloaded session already carries the message; sending it again would repeat it in the context.
    const openingBranch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    const prefsSent = openingBranch.some(entry => entry.type === "custom_message" && entry.customType === PREFS_TYPE);
    if (opening.enabled && opening.prefs.enabled && opening.prefs.inject && !prefsSent) {
      try {
        const message = prefsMessage((await evaluatedPrefs(ctx)).items);
        // Not a steer; one message per session; do not spend a steer unit.
        if (message) pi.sendMessage({ customType: PREFS_TYPE, content: message, display: opening.steerVisible });
      } catch (error) {
        console.warn("pi-warden: standing preferences scan failed:", error instanceof Error ? error.message : String(error));
      }
    }
    if (opening.enabled && _event.reason === "resume") await announceLoops(ctx, opening, openingBranch);
  });

  /**
   * The turn-start rules reminder: one Jev request asks one noul per rule whether it applies to the new request, and
   * the rules that pass the threshold are queued for the end of a turn whose loop continues. The prompt does not wait for the answer:
   * the request starts here and returns, and `deliverPendingNotices` appends the message while the run is streaming.
   * Never throws and never edits an earlier message; a judgment that is off, fails, or times out appends nothing and
   * says why in the trace, and an answer that arrives after the run ended is dropped, also with a trace line.
   */
  const curateTurnStart = (ctx: ExtensionContext, config: WardenConfig, prompt: string): void => {
    // A prompt the conscience already skips needs no rules reminder either: a short continuation or a relayed child
    // report carries no work of its own, so no question is sent. The reason is traced either way.
    const gated = redact(prompt).slice(0, 2000);
    const skipped = isShortContinuation(gated) ? "short_continuation" : isRelayedReport(gated) ? "relayed_report" : undefined;
    if (skipped) {
      record(ctx, config, "rules", "warden · rules · turn start · skipped", [
        "trigger: before_agent_start",
        `skipReason: ${skipped}`,
        "the prompt needs no reminder; no rule question was sent",
      ]);
      return;
    }
    const set = rulesGuard.store.load(ctx.cwd, config.rules);
    if (!set) return;
    // A fallback document with no rule headings is judged as one document by the rules guard; there are no rules to ask about.
    if (!set.rules.length) {
      record(ctx, config, "rules", "warden · rules · turn start · no rule headings", [
        "trigger: before_agent_start",
        `sources: ${set.sources.join(", ")}`,
        set.proseOnly ? "no rule-shaped sections in the document" : "the document is judged as one aggregate by the rules guard",
      ]);
      return;
    }
    const judge = judgeFor(config);
    if (!judge) {
      curator.failed();
      record(ctx, config, "rules", "warden · rules · turn start · no judgment", [
        "trigger: before_agent_start",
        `skipReason: ${judgmentsOffReason(config) ?? "cooldown"}`,
        "nothing was appended",
      ]);
      return;
    }
    const rules = curatedRuleList(set.rules);
    const myPrompt = promptEpoch;
    const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    const request = buildCuratorRequest(prompt, taskSpine(branch, prompt), rules);
    const started = Date.now();
    void ask(judge, request, { timeoutMs: Math.min(config.timeoutMs, CURATOR_TIMEOUT_MS), ...(ctx.signal ? { signal: ctx.signal } : {}) })
      .then(answer => {
        const elapsedMs = Date.now() - started;
        // The run this request belonged to has ended: nothing may be appended after it (a delivery must never start a turn).
        if (myPrompt !== promptEpoch || !agentRunActive) {
          curator.sent(elapsedMs);
          record(ctx, config, "rules", "warden · rules · turn start · dropped", [
            "trigger: before_agent_start",
            "the run ended before the answer arrived; nothing was appended",
            `asked ${rules.length} rule${rules.length === 1 ? "" : "s"} in ${elapsedMs} ms`,
          ]);
          return;
        }
        if (!answer.ok) {
          curator.failed();
          record(ctx, config, "rules", "warden · rules · turn start · nothing appended", [
            "trigger: before_agent_start",
            `error: ${answer.error}`,
            `asked ${rules.length} rule${rules.length === 1 ? "" : "s"} in ${elapsedMs} ms`,
          ]);
          return;
        }
        const scores = ruleScores(answer.answers as Record<string, unknown>, rules);
        const selected = curatedRules(rules, scores, config.rulesAtTurnStart.threshold);
        curator.sent(elapsedMs);
        curator.added(selected.length);
        const details = [
          "trigger: before_agent_start",
          `asked ${rules.length} of ${set.rules.length} rule${set.rules.length === 1 ? "" : "s"}${set.alwaysDropped ? ` (${set.alwaysDropped} past the request cap)` : ""} in ${elapsedMs} ms`,
          ...(selected.length ? [`named: ${selected.map(rule => `${rule.id} ${(scores[rules.indexOf(rule)] ?? 0).toFixed(2)}`).join(", ")}`] : [`no rule passed the ${config.rulesAtTurnStart.threshold} threshold`]),
          `sources: ${set.sources.join(", ")}`,
        ];
        if (!selected.length) {
          record(ctx, config, "rules", "warden · rules · turn start · none apply", details);
          return;
        }
        pendingNotices.push({
          customType: CURATOR_TYPE,
          content: formatCuratedRules(selected),
          guard: "rules",
          delivered: `warden · rules · turn start · ${selected.length} rule${selected.length === 1 ? "" : "s"} delivered at the end of a turn whose loop continued`,
          dropped: "warden · rules · turn start · dropped (the run ended first)",
          details,
        });
      })
      .catch(error => {
        curator.failed();
        record(ctx, config, "rules", "warden · rules · turn start · nothing appended", [
          "trigger: before_agent_start",
          `error: ${error instanceof Error ? error.message : String(error)}`,
        ]);
      });
  };

  // A new user prompt starts a new attempt history, a new steer budget, and a new restatement window; answering the
  // user is never a restatement.
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.hasUI) lastUi = ctx.ui as unknown as PanelUi;
    noticeUi = ctx.hasUI ? ctx.ui : undefined;
    const config = configFor(ctx);
    // This prompt owns the run: a background judgment from an older prompt can no longer reach it, and the notices it
    // queues are deliverable until `agent_end`.
    promptEpoch++;
    agentRunActive = true;
    attempts = new AttemptWindow(config.stuck.window);
    // ── Call waste: the session tip ──
    // The tip is appended to the prompt, so every other part of the prompt stays where it was and the host records the
    // change as a prompt-section delta. It is offered once per session; the trace line says so, and the next runs
    // re-append the same text, which is what keeps it in the prompt instead of being diffed away.
    const wasteOptions = (event as { systemPromptOptions?: { appendSystemPrompt?: string } }).systemPromptOptions;
    if (config.enabled && config.waste.enabled && config.waste.tip && wasteOptions) {
      wasteOptions.appendSystemPrompt = withWasteTip(wasteOptions.appendSystemPrompt);
      if (!wasteTipOffered) {
        wasteTipOffered = true;
        record(ctx, config, "waste", "warden · waste · session tip · instructions_supplied", [
          "trigger: before_agent_start",
          "delivery: appended to the system prompt (appendSystemPrompt)",
          `tip: ${WASTE_TIP}`,
        ]);
      }
    }
    fullOutputs = new Map();
    doneNudged = false;
    wardenContinuation = false;
    steersThisRun = 0;
    finals.reset();
    runaway.reset();
    runawayStops = 0;
    pendingRunaway = undefined;
    actionGuard.turnEnd();
    rulesGuard.turnEnd();
    // Holds the user never approved wait for the reply and the run it starts; last turn's allowed calls wait for the regret question.
    holds.promptArrived();
    regretCandidates = holds.candidates();
    if (regretCandidates.length && !judgeFor(config)) settleRegret(config, { regretted: textRegrets(event.prompt), via: "text" });

    // ── Conscience: initial assessment on normal operator prompts ──
    // The assessment runs in the background: the prompt never waits for Jev. A passing tip is queued here and is
    // delivered at the end of a turn whose loop continues, through the steer path, with the same budget rule as before; a
    // turn with no tool call, a batch where every result ended the run, a failed or aborted turn, and a run that ends
    // first drop it and trace why.
    beforeAgentStartFired = true;
    if (config.enabled && config.conscience.enabled) void (async () => {
      const myGeneration = conscienceGeneration;
      const myPrompt = promptEpoch;
      warnedErrorCategories = new Set();
      selectedCapability = null;
      pendingCapability = null;
      triggerConsumed = false;
      assessmentsThisPrompt = 0;
      nudgesThisPrompt = 0;
      reminderSent = false;
      lastAssessmentHash = "";
      needsReassessment = false;
      loadedBytes = 0;
      instructionState = "none";
      loadedSkillNames = new Set();
      queuedRevision++;
      clearFileIdentityCache();
      const judge = judgeFor(config);
      // Get the resolved skill catalog from the event's system prompt options (spec §3 rule 1)
      const skills = event.systemPromptOptions?.skills ?? [];
      cachedSkills = skills;
      let toolInfos: Array<{ name: string; description: string }> = [];
      try { toolInfos = pi.getAllTools().map((t: { name: string; description: string }) => ({ name: t.name, description: t.description })); } catch { toolInfos = []; }
      // Detect explicit /skill:name invocation (spec §3 rule 5)
      const explicitSkillMatch = event.prompt.match(/\/skill:([\w-]+)/);
      if (explicitSkillMatch) {
        record(ctx, config, "conscience", `explicit skill invocation: ${explicitSkillMatch[1]}`, ["trigger: input", `explicit_skill: ${explicitSkillMatch[1]}`]);
      } else {
        // Redact and truncate prompt to 2000 chars (spec §6 payload limit)
        const redactedPrompt = redact(event.prompt).slice(0, 2000);
        const truncationRecorded = event.prompt.length > 2000 ? [`prompt truncated from ${event.prompt.length} to 2000 chars`] : [];
        // Build recent context from session branch (up to 4 messages, 500 chars each)
        const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
        const spine = taskSpine(branch, event.prompt);
        const recentMessages: Array<{ role: string; text: string }> = [];
        for (const entry of branch.slice(-6)) {
          if (recentMessages.length >= 4) break;
          const msg = entry.type === "message" ? entry.message : undefined;
          if (msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
            recentMessages.push({ role: msg.role, text: redact(msg.content).slice(0, 500) });
          } else if (msg && (msg.role === "user" || msg.role === "assistant") && Array.isArray(msg.content)) {
            const textPart = msg.content.find((c): c is { type: "text"; text: string } => c.type === "text" && "text" in c && typeof (c as { text?: unknown }).text === "string");
            if (textPart) {
              recentMessages.push({ role: msg.role, text: redact(textPart.text).slice(0, 500) });
            }
          }
        }
        const recentContext = recentMessages.map(m => `${m.role}: ${m.text}`).join("\n");
        // Active and supplied skills
        const activeSkills = skills.map(s => s.name);
        const suppliedSkills: string[] = [];
        // ── Index nudge: once per session when index is missing or stale ──
        if (!indexNudged && (globalIndexFile === undefined || projectIndexFile === undefined)) {
          indexNudged = true;
          if (ctx.hasUI) ctx.ui.notify("pi-warden: run /warden index so the conscience recommends skills and tools from real descriptions.", "info");
          else record(ctx, config, "conscience", "nudge: index missing", ["trigger: before_agent_start", "nudgeReason: missing_index"]);
        } else if (!indexNudged && skills.length > 0) {
          // Check if any cached skill has no matching index entry
          const missing = skills.filter(s => {
            if (s.disableModelInvocation) return false;
            const hash = s.filePath ? fileContentHash(s.filePath) : "missing";
            const search = (index: { entries: Array<{ name: string; sourceHash: string }> } | undefined) => index?.entries.some(e => e.name === s.name && e.sourceHash === hash) ?? false;
            return !search(projectIndexFile) && !search(globalIndexFile);
          });
          if (missing.length > 0) {
            indexNudged = true;
            if (ctx.hasUI) ctx.ui.notify("pi-warden: run /warden index so the conscience recommends skills and tools from real descriptions.", "info");
            else record(ctx, config, "conscience", `nudge: ${missing.length} skill(s) unindexed`, ["trigger: before_agent_start", "nudgeReason: stale_index", ...missing.map(s => `unindexed: ${s.name}`)]);
          }
        }
        // Deadline: smaller of conscience.timeoutMs and shared timeoutMs
        const effectiveTimeout = Math.min(config.conscience.timeoutMs, config.timeoutMs);
        const start = Date.now();
        // AbortController for deadline (spec: when ctx.signal is absent)
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), effectiveTimeout);
        // Link to host signal if available
        const hostSignal = ctx.signal ?? undefined;
        if (hostSignal) {
          hostSignal.addEventListener("abort", () => ac.abort(), { once: true });
        }
        try {
          // The evaluate result carries the model that answered; the activation gate compares the policy's model against
          // it. Empty until the first evaluate call, and an empty model never matches a policy, so the gate fails closed.
          let judgeModel = "";
          const judgeAdapter = judge ? { evaluate: async (req: { state: unknown; questions: import("pi-typesafe").Questions }) => { const r = await judge.evaluate(req as Parameters<typeof judge.evaluate>[0]); judgeModel = r.model; return { answers: r.answers as Record<string, unknown> }; } } : undefined;
          const result = await assess(
            redactedPrompt, recentContext, skills, toolInfos, activeSkills, suppliedSkills,
            { judge: judgeAdapter, judgmentsOff: judgmentsOffReason(config), config: config.conscience, sharedTimeoutMs: config.timeoutMs, now: () => Date.now(), globalIndex: globalIndexFile, projectIndex: projectIndexFile },
            spine,
          );
          // Check generation and run after await: a result that belongs to an ended or replaced run must not deliver.
          if (conscienceGeneration !== myGeneration || myPrompt !== promptEpoch || !agentRunActive) {
            record(ctx, config, "conscience", "stale: the run ended or was replaced during assessment", [
              "trigger: before_agent_start",
              `generation: ${myGeneration} → ${conscienceGeneration}`,
              `skipReason: ${agentRunActive ? "stale" : "run_ended"}`,
            ]);
            return;
          }
          // Trace entry
          const selectedName = result.selected ? `${result.selected.kind}:${result.selected.id}` : "none";
          const skipInfo = result.skipReason ? [`skipReason: ${result.skipReason}`] : [];
          const truncInfo = truncationRecorded.length ? truncationRecorded : [];
          if (result.skipReason === "error" && result.errorCategory) {
            if (!warnedErrorCategories.has(result.errorCategory)) {
              warnedErrorCategories.add(result.errorCategory);
              console.warn(`pi-warden: conscience ${result.errorCategory}`);
            }
          }
          const skipTag = result.skipReason ? `, ${result.skipReason}` : "";
          record(ctx, config, "conscience",
            `assessed ${skills.length} skills + ${toolInfos.length} tools → ${selectedName} (P(useful)=${result.usefulness.toFixed(2)}, P(advance)=${result.pAdvance.toFixed(2)}, ${result.elapsedMs}ms${skipTag})`,
            ["trigger: before_agent_start", `eligible: ${skills.length} skills, ${toolInfos.length} tools`, `requests: ${result.requestCount}`, `questionHash: ${result.questionHash}`, ...skipInfo, ...truncInfo],
          );
          // Track state for turn-end triggers and reminders
          assessmentsThisPrompt++;
          lastAssessmentHash = result.questionHash;
          if (result.selected) {
            selectedCapability = { kind: result.selected.kind, id: result.selected.id };
            pendingCapability = { kind: result.selected.kind, id: result.selected.id };
            triggerConsumed = false;
            // Record file identity at selection time for cross-call change detection (Rule 4)
            if (result.selected.kind === "skill") {
              const selectedSkill = cachedSkills.find(s => s.name === result.selected!.id);
              if (selectedSkill?.filePath) recordFileIdentity(result.selected.id, selectedSkill.filePath);
            }
          }
          // Delivery: only when selected, thresholds pass, and activation gate clears
          if (result.selected && budgetAvailable(config)) {
            // Activation gate (spec §7): no policy means no delivery; a policy that does not match the current hash or
            // the model that actually answered also means no delivery. Fail closed either way.
            if (!policyMatches(consciencePolicy, result.questionHash, judgeModel)) {
              record(ctx, config, "conscience", "no policy for current hash/model", ["trigger: before_agent_start", "skipReason: no_policy", `hash: ${result.questionHash}`, `model: ${judgeModel || "none"}`]);
            } else {
              spendBudgetUnit();
              // Load mode: try to read the skill body from disk
              if (result.selected.kind === "skill" && config.conscience.skills.mode === "load" && !loadedSkillNames.has(result.selected.id)) {
                const skill = cachedSkills.find(s => s.name === result.selected!.id);
                if (skill) {
                  const ctxUsage = ctx.getContextUsage?.();
                  const loadResult = loadSkillBody(skill as unknown as import("@earendil-works/pi-coding-agent").Skill, config.conscience, {
                    pathRules: config.action.pathRules,
                    exemptRules: config.action.exemptRules,
                    loadedBytes,
                    remainingMs: effectiveTimeout - (Date.now() - start),
                    consentGiven: config.typesafe,
                    projectTrusted: ctx.isProjectTrusted(),
                    catalogName: skill.name,
                    catalogDescription: skill.description,
                    userInvoked: false,
                    contextWindow: ctxUsage?.contextWindow ?? null,
                    hasImages: !!(event as unknown as Record<string, unknown>).images,
                  });
                  if (loadResult.body) {
                    loadedBytes += loadResult.bytesLoaded;
                    loadedSkillNames.add(result.selected.id);
                    instructionState = "queued";
                    const msg = buildLoadMessage(loadResult);
                    record(ctx, config, "conscience", `loaded: ${result.selected.id} (${loadResult.bytesLoaded} bytes)`, ["trigger: before_agent_start", `skipReason: none`, `delivery: instructions_supplied`]);
                    queueConscienceTip(msg, `${result.selected.kind}:${result.selected.id}`);
                    return;
                  } else {
                    record(ctx, config, "conscience", `load failed: ${result.selected.id}`, ["trigger: before_agent_start", `skipReason: ${loadResult.skipReason}`]);
                    // Fall through to recommend mode
                  }
                }
              }
              // Recommend mode or load fallback
              queueConscienceTip(recommendationText(result.selected, redactedPrompt), `${result.selected.kind}:${result.selected.id}`);
              return;
            }
          } else if (result.selected && !budgetAvailable(config)) {
            record(ctx, config, "conscience", "selected but budget exhausted", ["trigger: before_agent_start", `skipReason: budget`]);
          }
        } catch (err) {
          const category = classifyJudgeError(err);
          if (!warnedErrorCategories.has(category)) {
            warnedErrorCategories.add(category);
            console.warn(`pi-warden: conscience ${category}`);
          }
          record(ctx, config, "conscience", `error: ${category}`, ["trigger: before_agent_start", `skipReason: error`]);
        } finally {
          clearTimeout(timer);
        }
      }
    })().catch(error => {
      // Anything thrown before the assessment's own try (a broken branch read, a redaction failure, a tool catalog that
      // will not list) must not become an unhandled rejection: Node ends the Pi process on one. Fail open with the same
      // trace line as a judge error.
      const category = classifyJudgeError(error);
      if (!warnedErrorCategories.has(category)) {
        warnedErrorCategories.add(category);
        console.warn(`pi-warden: conscience ${category}`);
      }
      record(ctx, config, "conscience", `error: ${category}`, ["trigger: before_agent_start", `skipReason: error`]);
    });

    // ── Rules at turn start ──
    // One request before the first model call of this user turn asks which of the project's rules apply. It runs in
    // the background, so the prompt never waits for Jev; the answer is delivered at the end of a turn whose loop continues, through
    // the steer path, appended after the newest message, so nothing earlier in the context moves and a warm prompt
    // cache stays valid. An answer that arrives after the run ended is dropped and traced. Nothing here throws.
    if (config.enabled && config.rules.enabled && config.rulesAtTurnStart.enabled) curateTurnStart(ctx, config, event.prompt);
  });

  // Each assistant message is judged on its own; Pi does not forward the stream's own "start" event, so this is the reset.
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "assistant") runaway.reset();
    // ── Conscience: Rule 10 — delivery observed ──
    // When a custom message with our type is emitted, mark instructions_supplied.
    if (event.message.role === "assistant" && instructionState === "queued" && (event.message as unknown as Record<string, unknown>).customType === `${PACKAGE_NAME}-conscience`) {
      const config = configFor(ctx);
      if (config.enabled && config.conscience.enabled) {
        instructionState = "instructions_supplied";
        record(ctx, config, "conscience", `instructions_supplied: delivery observed`, ["trigger: message_start", `revision: ${queuedRevision}`]);
      }
    }
    // ── Part B: queued-prompt admission ──
    // A user message without a prior before_agent_start is a queued prompt.
    if (event.message.role === "user") {
      const config = configFor(ctx);
      if (config.enabled && config.conscience.enabled && !beforeAgentStartFired) {
        // This is a queued prompt admitted at message_start without before_agent_start.
        // Assess against the last valid skill snapshot plus current tools.
        const judge = judgeFor(config);
        if (judge && cachedSkills.length > 0) {
          const myGeneration = conscienceGeneration;
          const prompt = typeof event.message.content === "string" ? event.message.content : "";
          const redactedText = redact(prompt).slice(0, 2000);
          const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
          const spine = taskSpine(branch, prompt);
          let toolInfos: Array<{ name: string; description: string }> = [];
          try { toolInfos = pi.getAllTools().map((t: { name: string; description: string }) => ({ name: t.name, description: t.description })); } catch { toolInfos = []; }
          const activeSkills = cachedSkills.map(s => s.name);
          const judgeAdapter = judge ? { evaluate: async (req: { state: unknown; questions: import("pi-typesafe").Questions }) => { const r = await judge.evaluate(req as Parameters<typeof judge.evaluate>[0]); return { answers: r.answers as Record<string, unknown> }; } } : undefined;
          try {
            const result = await assess(redactedText, "", cachedSkills as unknown as import("@earendil-works/pi-coding-agent").Skill[], toolInfos, activeSkills, [], { judge: judgeAdapter, config: config.conscience, sharedTimeoutMs: config.timeoutMs, now: () => Date.now(), globalIndex: globalIndexFile, projectIndex: projectIndexFile }, spine);
            if (conscienceGeneration !== myGeneration) return;
            record(ctx, config, "conscience", `queued prompt assessed → ${result.selected ? `${result.selected.kind}:${result.selected.id}` : "none"} (${result.skipReason ?? "none"})`, ["trigger: message_start", `origin: queued`, `skipReason: ${result.skipReason ?? "none"}`]);
          } catch (err) { const cat = classifyJudgeError(err); if (!warnedErrorCategories.has(cat)) { warnedErrorCategories.add(cat); console.warn(`pi-warden: conscience ${cat}`); } }
        } else {
          record(ctx, config, "conscience", `queued prompt: no judge or no skills`, ["trigger: message_start", `origin: queued`, "skipReason: catalog_unavailable"]);
        }
      }
      beforeAgentStartFired = false;
    }
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
    conscienceGeneration++;
    ctx.abort();
  });

  // Each low-level run collects its own evidence of changes and checks. A run that a warden follow-up started continues
  // the previous run's work, so it keeps that evidence: the changes behind a done-check nudge still need a passing check.
  pi.on("agent_start", async (_event, ctx) => {
    if (!wardenContinuation) evidence = emptyEvidence();
    wardenContinuation = false;
    batchResults = 0;
    batchTerminates = true;
    // Turn rules need a baseline of the working tree. The snapshot starts here as a promise and is awaited at
    // agent_end, so this hook never waits for git to hash the changed and untracked files. One trace line when a run
    // with turn rules gets no baseline. With no turn rules a failed snapshot is silent: a project without them sees
    // no change.
    turnJudged = new Set();
    turnSnapshot = undefined;
    const turnConfig = configFor(ctx);
    if (turnConfig.enabled && turnConfig.rules.enabled) turnSnapshot = snapshotTree(ctx.cwd);
  });

  // Every turn that runs after a compression is a turn that did not carry the removed text.
  pi.on("tool_execution_end", async event => {
    // A nested call (a script that calls tools) is not part of the loop's batch.
    if ((event as { parentToolCallId?: string }).parentToolCallId) return;
    batchResults++;
    if ((event.result as { terminate?: unknown } | undefined)?.terminate !== true) batchTerminates = false;
  });

  pi.on("turn_end", async (event, ctx) => {
    // Before anything awaits: Pi reads its steering queue as soon as the turn_end handlers return.
    const noticeConfig = configFor(ctx);
    if (noticeConfig.enabled) settleNotices(ctx, noticeConfig, event);
    ledger.turnEnd();
    if (savingEntry) trace.amend(savingEntry, `at turn end: ${formatLedger(ledger.snapshot())}`);
    savingEntry = undefined;
    actionGuard.turnEnd();
    rulesGuard.turnEnd();
    // ── Conscience: re-assess on unconsumed triggers ──
    const config = configFor(ctx);
    if (config.enabled && config.conscience.enabled && selectedCapability && needsReassessment && assessmentsThisPrompt < config.conscience.maxAssessments) {
      const myGeneration = conscienceGeneration;
      const judge = judgeFor(config);
      if (judge) {
        let toolInfos: Array<{ name: string; description: string }> = [];
        try { toolInfos = pi.getAllTools().map((t: { name: string; description: string }) => ({ name: t.name, description: t.description })); } catch { toolInfos = []; }
        const prompt = latestUserPrompt(ctx);
        const redactedPrompt = redact(prompt ?? "").slice(0, 2000);
        const spine = taskSpine(typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [], prompt ?? undefined);
        const activeSkills = cachedSkills.map(s => s.name);
        const judgeAdapter = judge ? { evaluate: async (req: { state: unknown; questions: import("pi-typesafe").Questions }) => { const r = await judge.evaluate(req as Parameters<typeof judge.evaluate>[0]); return { answers: r.answers as Record<string, unknown> }; } } : undefined;
        try {
          const result = await assess(redactedPrompt, "", cachedSkills as unknown as import("@earendil-works/pi-coding-agent").Skill[], toolInfos, activeSkills, [], { judge: judgeAdapter, config: config.conscience, sharedTimeoutMs: config.timeoutMs, now: () => Date.now(), globalIndex: globalIndexFile, projectIndex: projectIndexFile }, spine);
          if (conscienceGeneration !== myGeneration) return;
          assessmentsThisPrompt++;
          needsReassessment = false;
          if (result.selected) {
            selectedCapability = { kind: result.selected.kind, id: result.selected.id };
            lastAssessmentHash = result.questionHash;
          }
          record(ctx, config, "conscience", `turn_end reassessment → ${result.selected ? `${result.selected.kind}:${result.selected.id}` : "none"} (${result.elapsedMs}ms, ${result.skipReason ?? "none"})`, ["trigger: turn_end", `assessments: ${assessmentsThisPrompt}/${config.conscience.maxAssessments}`, `skipReason: ${result.skipReason ?? "none"}`]);
        } catch (err) { const cat = err instanceof Error ? (/(timeout|timed out)/i.test(err.message) ? "timeout" : /(auth|key|credential|401|403)/i.test(err.message) ? "auth" : /(network|fetch|connect)/i.test(err.message) ? "network" : "other") : "other"; if (!warnedErrorCategories.has(cat)) { warnedErrorCategories.add(cat); console.warn(`pi-warden: conscience ${cat}`); } }
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled) return;
    if (event.toolName === "bash" || event.toolName === "write") scratchPending.set(event.toolCallId, { started: Date.now(), candidates: scratchCandidates(event.toolName, event.input as Record<string, unknown>, ctx.cwd), moved: event.toolName === "bash" ? movedInTargets(event.toolName, event.input as Record<string, unknown>, ctx.cwd, sessionScratchPaths) : [] });
    // ── Conscience: track tool attempts on the selected capability ──
    if (config.conscience.enabled && selectedCapability && !triggerConsumed) {
      if (selectedCapability.kind === "tool" && event.toolName === selectedCapability.id) {
        pendingCapability = { kind: "tool", id: event.toolName };
        record(ctx, config, "conscience", `tool_attempted: ${event.toolName}`, ["trigger: tool_call", `capability: ${selectedCapability.id}`]);
      } else if (selectedCapability.kind === "skill" && event.toolName === "read") {
        const rawPath = String((event.input as Record<string, unknown>).path ?? "");
        if (rawPath.includes(selectedCapability.id)) {
          pendingCapability = { kind: "skill", id: selectedCapability.id };
          record(ctx, config, "conscience", `read_observed: ${selectedCapability.id}`, ["trigger: tool_call", `path: ${redact(rawPath)}`]);
        }
      }
    }
    // A read of a stored full output means the excerpt was not enough; that is the number that tunes context.confidence.
    // A whole-file read also undoes the saving, so the kind of access is kept apart.
    const serializedInput = JSON.stringify(event.input);
    const storedPath = ledger.storedPathIn(serializedInput);
    if (storedPath) {
      const kind = classifyRecall(event.toolName, event.input, storedPath);
      const recalled = ledger.noteAccess(serializedInput, kind);
      if (recalled) {
        compressionLearner.noteRecall(event.toolName);
        record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: `full output recalled (${kind})` }), [`the agent went back to ${recalled} (${kind === "full" ? "whole-file read" : "scoped access"})`, formatLedger(ledger.snapshot())]);
      }
    }
    if (!config.action.enabled || !config.action.tools.includes(event.toolName)) return;
    stats.inspected++;
    // First-run warning: no project rules file resolved, one time per session.
    if (!warnedMissingRules && config.rules.enabled) {
      const { missing, fallbackSource } = checkPiWardenMissing(ctx.cwd, config.rules);
      if (missing && ctx.hasUI) {
        warnedMissingRules = true;
        // The tiers still in play, in resolution order: naming README/CLAUDE/AGENTS to someone who
        // turned the fallback off would send them to a document pi-warden will not read.
        const tiers = [RULES_FILE, "rules.files", ...(config.rules.fallback ? FALLBACK_FILES : [])].join(", ");
        const msg = fallbackSource
          ? `No pi-warden.md or rules.files entry here. Using ${fallbackSource} as active fallback rules. Run /warden init to create project-specific rules.`
          : `No rules file detected (${tiers}). Run /warden init to create project-specific rules.`;
        ctx.ui.notify(msg, "warning");
      }
    }
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
    // Index command writes its own output files — exempt them from the action guard.
    if (indexRunning && event.toolName === "write") {
      const rawPath = typeof (event.input as Record<string, unknown>).path === "string" ? (event.input as Record<string, unknown>).path as string : "";
      if (rawPath) {
        const resolved = rawPath.startsWith("~") ? pathResolve(rawPath.replace(/^~/, homedir())) : pathResolve(rawPath);
        if (indexWritePaths.includes(resolved)) {
          record(ctx, config, "action", "index write, expected", ["trigger: before_tool_use", `path: ${redact(rawPath)}`]);
          return;
        }
      }
    }
    // The rules request carries the written content and the rule text, so it goes out beside the action request, not inside it.
    const rulesOptions = { cwd: ctx.cwd, config: config.rules, judge, timeoutMs: config.timeoutMs, signal: ctx.signal };
    // A bash command that writes literal content to a file is judged as a `write` of that content, before it runs, so a
    // heredoc gets the checks a `write` gets.
    const shell = event.toolName === "bash" && typeof (event.input as Record<string, unknown>).command === "string"
      ? shellWrites((event.input as Record<string, unknown>).command as string, { home: homedir() })
      : undefined;
    // Each file is one rules request, so a script that writes many files would start as many requests at once.
    const shellFiles = mergeWrites(shell?.writes ?? []);
    // Turn rules: a file these checks judge is not judged again at the end of the run.
    if (config.rules.enabled) {
      const inputPath = typeof (event.input as Record<string, unknown>).path === "string" ? (event.input as Record<string, unknown>).path as string : "";
      const seen = event.toolName === "write" || event.toolName === "edit" ? [inputPath] : shellFiles.slice(0, SHELL_RULES_CHECKS).map(write => write.path);
      for (const path of seen) {
        const rel = projectPath(path, ctx.cwd);
        if (rel) turnJudged.add(rel);
      }
    }
    const shellSkips: ShellSkip[] = [...(shell?.skips ?? []), ...shellFiles.slice(SHELL_RULES_CHECKS).map(write => ({ path: write.path, reason: `only the first ${SHELL_RULES_CHECKS} files a command writes are judged` }))];
    const rulesChecks: Array<{ check: Promise<RulesVerdict>; shellWrite?: ShellWrite }> = !config.rules.enabled ? []
      : event.toolName === "write" || event.toolName === "edit" ? [{ check: rulesGuard.inspect(call, siblings, rulesOptions) }]
      : shellFiles.slice(0, SHELL_RULES_CHECKS).map((shellWrite, index) => ({ shellWrite, check: rulesGuard.inspect({ id: `${event.toolCallId}#write${index}`, tool: "write", input: { path: shellWrite.path, content: shellWrite.content } }, siblings, rulesOptions) }));
    for (const { check } of rulesChecks) check.catch(() => undefined);
    const verdict = await actionGuard.inspect(
      call,
      { task, context: recentTaskContext(ctx), siblings, plan: assistantPlan(ctx, isVisibleAction(event.toolName, event.input as Record<string, unknown>)), spine: taskSpine(ctx.sessionManager.getBranch()), asked: askedBeforeReply(ctx) },
      { config: config.action, cwd: ctx.cwd, judge, signal: ctx.signal, slop: config.slop, security: config.security, largeOutput: config.context.largeOutput, rules: config.rules, previousActions: regretCandidates.length ? regretCandidates : undefined, scratch: sessionScratch, scratchPaths: sessionScratchPaths, movedIn: sessionMovedIn.size ? [...sessionMovedIn] : undefined, hostPaths: sessionHostPaths },
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
    const deliveryVerdict = agentDeliveryVerdict(verdict);
    const deliveryReasons = deliveryVerdict.reasons;
    if (regretCandidates.length && verdict.judgment?.regretted !== undefined) {
      settleRegret(config, { regretted: regretsAt(verdict.judgment.regretted), target: verdict.judgment.regretTarget, probability: verdict.judgment.regretted, via: "jev" });
    }
    // Notes for the agent about the content it just wrote: slop, rule violations, and sensitive paths arrive as one message.
    const notes: string[] = [];
    const noteGuards = new Set<SteerGuard>();
    const noteKinds: SteerKind[] = [];
    /** Slop and rule findings say "just written", so they wait until the call proceeds. A held, denied, or declined write
     * never lands and drops them; an approved retry is judged again and brings its own. They go between the action notes
     * and the sensitive-path notes, the order of the combined message. */
    const contentNotes: Array<(proceeds: boolean) => { guard: SteerGuard; kind: SteerKind; text: string } | undefined> = [];
    const pathNotes: string[] = [];
    /** Sensitive-path notes ride with the combined steer for this call; their trace waits for the delivery result. */
    const pathNoteTraces: Array<(delivered: boolean) => void> = [];
    if (verdict.judgment?.securityRisk !== undefined && verdict.judgment.securityRisk >= config.security.threshold && adaptiveSend(ctx, config, "security-write")) {
      if (steer(config, "security", "pi-warden: the proposed write may introduce a security weakness. Check for embedded credentials, disabled TLS, unsafe command/SQL interpolation, broad permissions, or bypassed verification; use a safe implementation instead.")) watchSteer(ctx, config, ["security-write"], verdict.summary.path ? { path: verdict.summary.path } : {});
    }
    if (verdict.judgment) stats.judged++;
    if (verdict.source === "error") noteError(ctx, verdict.error ?? "TypeSafe request failed.", verdict.errorCode);
    if (verdict.approvalError) noteError(ctx, `The approval request failed (${verdict.approvalError}); your reply was read offline.`, undefined);
    const mode = activeMode(config, ctx.hasUI);
    if (verdict.approvedByUser) {
      stats.approved++;
      const released = holds.approved(event.toolName);
      if (released) {
        noteOutcomes(config, [released]);
      }
    }
    const told = verdict.level === "confirm" && mode === "steer" ? steerReason(deliveryVerdict, { canApprove: judge !== undefined }) : undefined;
    // SAFETY: verdict.source is a string union; the read-only → pattern rewrite above may have narrowed it in TS's view,
    // but the field is still one of the source values at runtime when no armed hits fired.
    const actionFmt = formatVerdictTokens(verdict, config.widget.action);
    const entry = (verdict.source as string) !== "read-only" ? record(ctx, config, "action", actionFmt.line, actionDetails(verdict, { mode, ...(told ? { told } : {}) }), actionFmt.tokens) : undefined;
    // What happens to this call is the label for its scores; a decision made in the dialog lands at once, a steer-mode hold waits for the user.
    const track = (held: boolean, outcome?: CallOutcome, via?: OutcomeVia) => {
      if (!entry) return;
      const recordOpts: Parameters<typeof holds.record>[1] = { held, mode, outcome, via };
      if (task) recordOpts.task = task;
      if (verdict.plan) recordOpts.plan = verdict.plan;
      const ctxSummary = summarizeContext(recentTaskContext(ctx));
      if (ctxSummary) recordOpts.contextSummary = ctxSummary;
      if (held) recordOpts.agentReason = steerReason(deliveryVerdict, { canApprove: judge !== undefined });
      const item = holds.record(verdict, recordOpts);
      traceOf.set(item, entry);
      // A call that changes something and is allowed to run, with a steer hold of an earlier turn still pending, is the
      // agent's re-plan. The guard has already labelled a hold the reply released `approved`, so what is left is not
      // that hold; a call that is held or denied does not run, so it replaces nothing. Nothing is written when no hold
      // was waiting, which is every call of a normal turn.
      if (!held && !verdict.approvedByUser && mutatingCall(verdict)) {
        const replanned = holds.replanned();
        if (replanned.length) noteOutcomes(config, replanned);
      }
      // Record to SQLite for learning (held and judged-allowed calls).
      // The promise and map entry must exist before noteOutcomes so that an outcome
      // known at record time (e.g. dialog-approved) is not lost to the race.
      const preview = redact(verdict.summary.command ?? verdict.summary.path ?? "");
      const holdPromise = recordHold(toHoldRecord(
        { at: item.at, tool: item.tool, level: item.level, reasons: item.reasons, scores: item.scores, held },
        ctx.cwd,
        { task: task ? redact(task) : task, plan: verdict.plan, contextSummary: ctxSummary, agentReason: held ? steerReason(deliveryVerdict, { canApprove: judge !== undefined }) : undefined, preview, sessionId: activeSessionId },
      ), dirs).catch(err => { console.warn("pi-warden: recordHold failed:", err); return -1; });
      learningIds.set(item.id, holdPromise);
      pruneLearningIds();
      noteOutcomes(config, outcome ? [item] : []);
    };
    // The warn notice below names the mismatch to the user; the agent gets the steer with the other notes.
    if (verdict.intentMismatch) {
      stats.offPlan++;
      if (verdict.intentTraceOnly) stats.offPlanTraceOnly++;
      else if (adaptiveSend(ctx, config, "intent-mismatch")) {
        noteGuards.add("action");
        noteKinds.push("intent-mismatch");
        notes.push(intentSteer(verdict));
      }
    }
    if (verdict.offTaskSteer) {
      stats.offTask++;
      if (!verdict.offTaskTraceOnly && adaptiveSend(ctx, config, "off-task")) {
        noteGuards.add("action");
        noteKinds.push("off-task");
        notes.push(offTaskSteer(verdict));
      }
    }
    if (verdict.shouldProceedSteer && !verdict.shouldProceedTraceOnly && adaptiveSend(ctx, config, "should-proceed")) {
      noteGuards.add("action");
      noteKinds.push("should-proceed");
      notes.push(shouldProceedMessage(verdict));
    }
    const largeOutput = largeOutputNotice(verdict, largeOutputSteered);
    if (largeOutput && adaptiveSend(ctx, config, "large-output")) {
      noteGuards.add("action");
      noteKinds.push("large-output");
      notes.push(largeOutput);
    }
    if (verdict.slopSymptoms?.length && verdict.slopReasons) {
      stats.slop++;
      const symptoms = verdict.slopSymptoms;
      const where = verdict.summary.path ?? (shell?.writes.length ? shell.writes.map(write => write.path).join(", ") : event.toolName);
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · slop · ${where}: ${verdict.slopReasons.join("; ")}`, "warning");
      contentNotes.push(proceeds => {
        if (!proceeds || !adaptiveSend(ctx, config, "slop")) return undefined;
        for (const symptom of symptoms) slopCounts[symptom]++;
        return { guard: "action", kind: "slop", text: slopSteer(where, symptoms, slopCounts) };
      });
    }
    for (const { check, shellWrite } of rulesChecks) {
      const rules = await check;
      // The trace names the shell form, and an append as an append: only the appended text was judged.
      const shellNote = shellWrite ? [`from bash: ${shellWrite.via} ${shellWrite.append ? "appended to (only the appended text is judged)" : "written to"} ${rules.path}`] : [];
      const rulesLine = shellWrite ? renderTemplate(config.widget.rules, { ...rulesTokens(rules), tool: `bash ${shellWrite.append ? "append" : "write"}` }) : formatRules(rules, config.widget.rules);
      if (rules.source !== "skipped") {
        stats.ruleChecks++;
        if (rules.error) noteError(ctx, rules.error, rules.errorCode);
        // Only a shown notice uses up the once-per-session flag.
        const capNotice = ctx.hasUI && config.notices ? rulesGuard.capNotice(rules) : undefined;
        if (capNotice) ctx.ui.notify(capNotice, "warning");
        holds.recordRules({ source: rules.source, path: rules.path, findings: rules.findings.map(f => ({ name: f.name, violation: f.violation })), ...(rules.error ? { error: rules.error } : {}) });
        // A later judgment below the threshold clears an earlier finding of the same rule on this path: one trace line, no steer.
        if (rules.source === "typesafe") {
          for (const observation of rulesLog?.record(rules, config.rules.threshold, Date.now(), config.rules.softThreshold) ?? []) {
            if (observation.cleared) record(ctx, config, "rules", `rules: ${observation.name} now clear on ${rules.path}`, [`clear: a later ${rules.tool} on this path scored ${observation.violation.toFixed(2)}, below the ${config.rules.threshold} threshold`]);
          }
        }
        if (rules.findings.length) {
          stats.ruleViolations++;
          if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · rules · ${rules.path}: ${rules.findings.map(finding => `${finding.name} (${finding.violation.toFixed(2)})`).join("; ")}`, "warning");
        }
        contentNotes.push(proceeds => {
          const hasRules = rules.findings.length > 0 || (rules.softFindings?.length ?? 0) > 0;
          const told = proceeds && hasRules && adaptiveSend(ctx, config, "rules") ? rulesSteer(rules, rulesGuard.count(rules)) : undefined;
          const details = [...shellNote, ...rulesDetails(rules, told)];
          if (!proceeds && rules.findings.length) details.push("agent not told: the write was held");
          record(ctx, config, "rules", rulesLine, details);
          return told ? { guard: "rules", kind: "rules", text: told } : undefined;
        });
      } else {
        record(ctx, config, "rules", rulesLine, [...shellNote, `${rules.tool} ${rules.path}: ${rules.skippedReason}`]);
      }
    }
    if (config.rules.enabled && shellSkips.length) {
      const paths = shellSkips.flatMap(skip => (skip.path ? [skip.path] : []));
      record(ctx, config, "rules", renderTemplate(config.widget.rules, { guard: "rules", tool: "bash", path: paths.length ? paths.join(", ") : "file change", status: "skipped" }), shellSkips.map(skip => `shell write not judged${skip.path ? ` (${skip.path})` : ""}: ${skip.reason}`));
    }
    if (config.rules.enabled && (event.toolName === "write" || event.toolName === "edit")) {
      const hits = rulesGuard.notesFor(verdict.summary.location === "inside_project" ? verdict.summary.path : undefined, config.rules.sensitivePaths);
      if (hits.length && verdict.summary.path && adaptiveSend(ctx, config, "sensitive-path")) {
        stats.pathNotes++;
        const told = pathNoteSteer(verdict.summary.path, hits);
        // A repeat or a spent steer budget records the note without the agent reading it again, so the trace waits
        // for the combined steer's delivery result instead of claiming the agent was told.
        pathNoteTraces.push((delivered: boolean) => {
          record(ctx, config, "rules", renderTemplate(config.widget.rules, { tool: event.toolName, path: verdict.summary.path, violations: `sensitive path ${hits.map(hit => hit.glob).join(", ")}`, status: "note" }), [`${event.toolName} ${verdict.summary.path} matches ${hits.map(hit => hit.glob).join(", ")} in rules.sensitivePaths`, delivered ? `agent told: ${told}` : `steer recorded, not delivered (a repeat or the per-run budget): ${told}`]);
          if (delivered && ctx.hasUI && config.notices) ctx.ui.notify(`warden · sensitive path · ${verdict.summary.path} (${hits.map(hit => hit.glob).join(", ")}); the agent was given the note`, "warning");
        });
        noteGuards.add("rules");
        noteKinds.push("sensitive-path");
        pathNotes.push(told);
      }
    }
    /** Sends the combined steer once the call's fate is known; `proceeds` is false when the call does not run. */
    const deliverNotes = (proceeds: boolean) => {
      for (const contentNote of contentNotes) {
        const note = contentNote(proceeds);
        if (!note) continue;
        noteGuards.add(note.guard);
        noteKinds.push(note.kind);
        notes.push(note.text);
      }
      notes.push(...pathNotes);
      if (notes.length) {
        const delivered = steer(config, [...noteGuards], notes.join("\n\n"));
        const notePath = verdict.summary.path ?? shell?.writes[0]?.path;
        if (delivered) watchSteer(ctx, config, noteKinds, notePath ? { path: notePath } : {});
        for (const traceNote of pathNoteTraces) traceNote(delivered);
        pathNoteTraces.length = 0;
      }
    };
    const warnSteer = (reasons: readonly string[]) => {
      if (!reasons.length || !adaptiveSend(ctx, config, "warn-headless")) return false;
      const sent = steer(config, "action", `pi-warden: this ${event.toolName} call ran with a warning (${reasons.join("; ")}). Nobody sees this in a headless run, so it is on you: if the flagged risk is expected, continue; otherwise fix it or ask the user before building on it.`);
      if (sent) watchSteer(ctx, config, ["warn-headless"]);
      return sent;
    };
    if (verdict.level === "warn") {
      deliverNotes(true);
      stats.warned++;
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · ${event.toolName}: ${verdict.reasons.join("; ")}`, "warning");
      else if (!ctx.hasUI) {
        const otherReasons = deliveryReasons.filter(r => !r.startsWith("should-proceed "));
        warnSteer(otherReasons);
      }
      track(false);
      return undefined;
    }
    if (verdict.level === "deny") {
      deliverNotes(false);
      stats.held++;
      track(true, "declined", "deny");
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · blocked ${event.toolName}: ${verdict.reasons.join("; ")}`, "error");
      notifyDesktop(ctx, config, `Blocked ${event.toolName}: ${verdict.reasons.join("; ")}. A deny rule matched; the call never ran.`);
      return { block: true, reason: `pi-warden blocked this ${event.toolName} call (${deliveryReasons.join("; ")}). A deny rule matched; this command is not allowed to run. Ask the user if this is genuinely required.` };
    }
    if (verdict.level !== "confirm") { deliverNotes(true); track(false); return undefined; }

    const reasons = verdict.reasons.join("; ");
    const deliveredReasons = deliveryReasons.join("; ");
    // A user-defined confirm rule prompts the user in every mode, advise included: the operator wrote the rule to be
    // asked. Advise mode keeps Jev holds advisory; it does not soften a prompt the operator asked for by name.
    // The action defaults to dialog at parse time (the reason one writes such a rule); hold restores steer semantics.
    const dialogRule = verdict.patterns.some(hit => hit.action === "dialog");
    if (dialogRule && ctx.hasUI) {
      notifyDesktop(ctx, config, `Waiting for you: allow this ${event.toolName} call? ${reasons}`);
      const allowed = await ctx.ui.confirm(`warden: allow this ${event.toolName} call?`, confirmMessage(verdict), ctx.signal ? { signal: ctx.signal } : {});
      deliverNotes(allowed);
      if (allowed) { track(true, "approved", "dialog"); return undefined; }
      stats.held++;
      track(true, "declined", "dialog");
      return { block: true, reason: `pi-warden: the user declined this ${event.toolName} call (${deliveredReasons}). Do not retry it unchanged; ask the user how to proceed.` };
    }
    if (mode === "advise") {
      deliverNotes(true);
      stats.warned++;
      if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · ${event.toolName} (advise mode, not held): ${reasons}`, "warning");
      else if (!ctx.hasUI) warnSteer(deliveryReasons);
      track(false);
      return undefined;
    }
    if (mode === "confirm") {
      notifyDesktop(ctx, config, `Waiting for you: allow this ${event.toolName} call? ${reasons}`);
      const allowed = await ctx.ui.confirm(`warden: allow this ${event.toolName} call?`, confirmMessage(verdict), ctx.signal ? { signal: ctx.signal } : {});
      deliverNotes(allowed);
      if (allowed) { track(true, "approved", "dialog"); return undefined; }
      stats.held++;
      track(true, "declined", "dialog");
      return { block: true, reason: `pi-warden: the user declined this ${event.toolName} call (${deliveredReasons}). Do not retry it unchanged; ask the user how to proceed.` };
    }
    deliverNotes(false);
    stats.held++;
    actionGuard.hold(task);
    track(true);
    if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · held ${event.toolName}: ${reasons}. The agent was told why and asked to re-plan or ask you.`, "warning");
    notifyDesktop(ctx, config, `Held ${event.toolName}: ${reasons}. The agent will re-plan or ask you in chat.`);
    return { block: true, reason: told ?? steerReason(deliveryVerdict, { canApprove: judge !== undefined }) };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled) return;
    // High-confidence credential values are masked before any other rewrite, so neither the model nor a stored copy
    // sees them. Detection below still reads the original text, so the banner names what was masked. Masking is local
    // and sends nothing, so it runs with the security guard off; only the user's `security.maskOutput` stops it.
    const rawTexts = event.content.filter(part => part.type === "text").map(part => part.text ?? "");
    const maskOutput = config.security.maskOutput;
    const masking = maskOutput ? rawTexts.map(maskSecrets) : [];
    const maskedCount = masking.reduce((sum, block) => sum + block.masked, 0);
    let maskIndex = 0;
    const maskedContent = maskedCount ? event.content.map(part => part.type === "text" ? { ...part, text: masking[maskIndex++]!.text } : part) : event.content;
    const textBlocks = maskedContent.filter(part => part.type === "text");
    const text = textBlocks.map(part => part.text).join("\n");
    const scratch = scratchPending.get(event.toolCallId);
    if (scratch) {
      scratchPending.delete(event.toolCallId);
      for (const path of scratch.moved) sessionMovedIn.add(path);
      for (const [path, identity] of createdScratch(event.toolName, event.input as Record<string, unknown>, text, scratch.started, scratch.candidates)) sessionScratch.set(path, identity);
    }
    pruneScratch(sessionScratch);
    // Repeat detection uses the original result, so its request goes out together with the output check.
    const failed = resultFailed(event.isError, event.details, event.content);
    // ── Call waste ──
    // Every finished call enters the window; a note, when one fires, is attached to this result below. Nothing here
    // reads the call's fate, and the note never reaches a hold, the judge, or the steer budget.
    const wasteNudge = waste.record({ tool: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd, failed, result: text }, config.waste);
    // ── Conscience: track tool_result for the pending capability ──
    if (config.conscience.enabled && pendingCapability && !triggerConsumed) {
      if (pendingCapability.kind === "tool" && event.toolName === pendingCapability.id) {
        triggerConsumed = true;
        if (failed) {
          needsReassessment = true;
          record(ctx, config, "conscience", `tool_failed: ${event.toolName}`, ["trigger: tool_result", `capability: ${pendingCapability.id}`]);
        } else {
          record(ctx, config, "conscience", `tool_succeeded: ${event.toolName}`, ["trigger: tool_result", `capability: ${pendingCapability.id}`]);
        }
        pendingCapability = null;
      } else if (pendingCapability.kind === "skill" && event.toolName === "read") {
        triggerConsumed = true;
        if (failed) needsReassessment = true;
        record(ctx, config, "conscience", `read_observed: ${pendingCapability.id}`, ["trigger: tool_result", `failed: ${failed}`]);
        pendingCapability = null;
      }
    }
    let quickRepeat: QuickRepeat | undefined;
    const stuckCheck = (() => {
      if (!config.stuck.enabled) return undefined;
      attempts.push(makeAttempt(event.toolName, event.input, event.content, failed));
      if (config.stuck.nudge && config.stuck.repeatSteer) quickRepeat = attempts.quickRepeat();
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
      for (const blockText of rawTexts) {
        if (ctx.signal?.aborted) break;
        blockVerdicts.push(await evaluateOutput(event.toolName, blockText, latestUserPrompt(ctx), {
          security: config.security, context: config.context, judge: judgeFor(config), timeoutMs: config.timeoutMs,
          signal: ctx.signal, compressible: true, taskContext: recentTaskContext(ctx),
        }, compressionLearner));
      }
      output = mergeOutput(blockVerdicts);
    } else {
      output = await evaluateOutput(event.toolName, rawTexts.join("\n"), latestUserPrompt(ctx), {
        security: config.security, context: config.context, judge: judgeFor(config), timeoutMs: config.timeoutMs,
        signal: ctx.signal, compressible: true, taskContext: recentTaskContext(ctx),
      }, compressionLearner);
    }
    if (ctx.signal?.aborted) return;
    if (output.error) noteError(ctx, output.error, output.errorCode);
    let content = maskedContent;
    // A credential-shaped value the agent has already been warned about this session is traced, not announced again.
    // Per value, not per set: masking one value or a changed subset must not re-announce the rest.
    const secretValues = output.secretIds ?? (output.secret && output.secretId !== undefined ? [output.secretId] : []);
    const unseenSecrets = secretValues.filter((id) => !secretsSeen.has(id));
    const secretRepeat = output.secret && secretValues.length > 0 && unseenSecrets.length === 0;
    // Per-block banners are computed before secretsSeen is updated, so a block whose values were all announced
    // earlier stays quiet while a block with a new value earns the banner.
    // With masking on, a new credential-shaped value that was not masked earns a trace line, not a banner.
    let unmaskedSecret = false;
    const blockNotices = multiBlock ? blockVerdicts.map((verdict, index) => {
      const values = verdict.secretIds ?? (verdict.secret && verdict.secretId !== undefined ? [verdict.secretId] : []);
      const repeat = verdict.secret && values.length > 0 && values.every(id => secretsSeen.has(id));
      if (maskOutput && verdict.secret && !repeat && !masking[index]?.masked) unmaskedSecret = true;
      return securityNotice(repeat ? { ...verdict, secret: false } : verdict, masking[index]?.masked, maskOutput);
    }) : [];
    if (maskOutput && !multiBlock && output.secret && !secretRepeat && maskedCount === 0) unmaskedSecret = true;
    if (unseenSecrets.length) for (const id of unseenSecrets) secretsSeen.add(id);
    const notice = multiBlock ? blockNotices.find(banner => banner !== undefined) : securityNotice(secretRepeat ? { ...output, secret: false } : output, maskedCount, maskOutput);
    if (unmaskedSecret) {
      record(ctx, config, "security", renderTemplate(config.widget.security, { tool: event.toolName, injection: output.injection?.toFixed(2), exfiltration: output.exfiltration?.toFixed(2), status: "possible credentials, none masked (traced)" }), [
        "credential-shaped values in this output were detected but none was masked; traced, not announced to the agent",
      ]);
    }
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
          savingEntry = record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: "duplicate", bytesSaved: String(bytesSaved) }), [
            `identical to an earlier ${earlier.tool} result; saved ${bytesSaved} bytes; full output: ${storedPath}`,
            formatLedger(ledger.snapshot()),
          ]);
        }
      } catch {
        noteError(ctx, "Could not store full output; keeping it unchanged.", undefined);
      }
    }
    if (config.context.enabled && !earlier && !recallRead && textBlocks.length === 1 && text.length >= config.context.tailMinChars) ledger.candidate();
    // Captured before the loop so the notice block below knows whether each block already carries its banner.
    const bannersPlacedWithBlocks = multiBlock && !ctx.signal?.aborted;
    if (bannersPlacedWithBlocks) {
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
        let compressed = false;
        const excerpt = compressOutput(blockText, verdict.retention, verdict.format);
        if (excerpt) {
          try {
            const path = await saveOutput(blockText);
            const body = `${blockNotice ? `${blockNotice}\n\n` : ""}${excerpt}\n\n${recallInstruction(recallTool, path)}`;
            const bytesSaved = Buffer.byteLength(blockText) - Buffer.byteLength(body);
            if (bytesSaved > 0) {
              replacement = body;
              compressed = true;
              ledger.record(path, bytesSaved, { tool: event.toolName, bytes: Buffer.byteLength(blockText), kind: isGenericExcerpt(excerpt) ? "excerpt" : "parser" });
              storedPath = path;
              compressionLearner.record(event.toolName, verdict.retention, verdict.format, false);
              savingEntry = record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: verdict.retention, bytesSaved: String(bytesSaved) }), [
                `text block ${textIndex} of ${blockVerdicts.length}: retention ${verdict.retention}; confidence ${verdict.confidence?.toFixed(2)}; format ${verdict.format ?? "generic"}${verdict.formatConfidence === undefined ? "" : ` (${verdict.formatConfidence.toFixed(2)})`}; saved ${bytesSaved} bytes; full output: ${path}`,
                formatLedger(ledger.snapshot()),
              ]);
            }
          } catch {
            noteError(ctx, "Could not store full output; keeping the block unchanged.", undefined);
          }
        }
        if (!compressed && verdict.confidence !== undefined) recordKeptWhole(config, event.toolName, verdict, `text block ${textIndex} of ${blockVerdicts.length}: `);
        if (!replacement && blockNotice) replacement = `${blockNotice}\n\n${blockText}\n\n${blockNotice}`;
        if (replacement) content[index] = { ...part, text: replacement };
      }
    } else {
      const excerpt = earlier ? undefined : compressOutput(text, output.retention, output.format);
      const generic = excerpt !== undefined && isGenericExcerpt(excerpt);
      let compressed = false;
      // Only the generic excerpt is filtered; parser excerpts, `all`, duplicates, and repeats never reach this.
      const filtered = excerpt && generic && config.context.filter.enabled && !ctx.signal?.aborted ? await runFilter(ctx, config, event.toolName, event.input as Record<string, unknown>, text, excerpt) : undefined;
      if (excerpt && !ctx.signal?.aborted) {
        try {
          const path = await saveOutput(text);
          const replacement = `${filtered?.ok ? filtered.text : excerpt}\n\n${recallInstruction(recallTool, path)}`;
          const bytesSaved = Buffer.byteLength(text) - Buffer.byteLength(replacement) - (notice ? Buffer.byteLength(notice) * 2 + 4 : 0);
          if (bytesSaved > 0) {
            content = content.map(part => part.type === "text" ? { ...part, text: replacement } : part);
            compressed = true;
            ledger.record(path, bytesSaved, { tool: event.toolName, bytes: Buffer.byteLength(text), kind: filtered?.ok ? "filtered" : generic ? "excerpt" : "parser", ...(filtered?.ok ? { keptChars: filtered.keptChars } : {}) });
            storedPath = path;
            compressionLearner.record(event.toolName, output.retention, output.format, false);
            savingEntry = record(ctx, config, "context", renderTemplate(config.widget.context, { tool: event.toolName, retention: filtered?.ok ? "filtered" : output.retention, bytesSaved: String(bytesSaved) }), [
              `retention: ${output.retention}; confidence ${output.confidence?.toFixed(2)}; format ${output.format ?? "generic"}${output.formatConfidence === undefined ? "" : ` (${output.formatConfidence.toFixed(2)})`}; ${output.model}; ${output.elapsedMs} ms`,
              ...(filtered ? [filtered.ok
                ? `context filter: kept ${filtered.kept} of ${filtered.chunks} chunks, ${filtered.keptChars} of ${text.length} characters; ${filtered.requests} request${filtered.requests === 1 ? "" : "s"}; ${filtered.elapsedMs} ms`
                : `context filter fell back to the excerpt: ${filtered.reason}; ${filtered.chunks} chunks; ${filtered.requests} request${filtered.requests === 1 ? "" : "s"}; ${filtered.elapsedMs} ms`] : []),
              `saved ${bytesSaved} bytes; full output: ${path}`,
              formatLedger(ledger.snapshot()),
            ]);
          }
        } catch {
          noteError(ctx, "Could not store full output; keeping it unchanged.", undefined);
        }
      }
      if (!compressed && !ctx.signal?.aborted && output.confidence !== undefined) recordKeptWhole(config, event.toolName, output);
    }
    // A recall brings the stored text back on purpose, and a duplicate note has nothing left to cut.
    if (config.context.enabled && config.context.dedupeRuns && !earlier && !recallRead && !ctx.signal?.aborted) {
      syncSeen(ctx);
      const deduped = await dedupeContent(ctx, config, content, event.toolName);
      if (deduped) content = deduped;
    }
    if (key && !earlier) ledger.remember(key, event.toolName, storedPath);
    // The banner in the result already tells the agent, so the notice rides the result content alone and is not also
    // steered. A steer sent here would join the request that carries this result and cost no extra turn
    // (tests/steer-delivery.test.ts); it would only repeat the banner.
    if (notice && textBlocks.length) {
      if (!bannersPlacedWithBlocks) {
        let index = 0;
        content = content.map(part => {
          if (part.type !== "text") return part;
          index++;
          return { ...part, text: `${index === 1 ? `${notice}\n\n` : ""}${part.text}${index === textBlocks.length ? `\n\n${notice}` : ""}` };
        });
      }
      record(ctx, config, "security", renderTemplate(config.widget.security, {
        tool: event.toolName, injection: output.injection?.toFixed(2), exfiltration: output.exfiltration?.toFixed(2),
        status: [output.suspicious && "untrusted instructions", output.secret && "possible credentials"].filter(Boolean).join(", "),
      }), [
        `jev: injection ${output.injection?.toFixed(2) ?? "not judged"}; exfiltration ${output.exfiltration?.toFixed(2) ?? "not judged"}`,
        `output sample: ${redact(text).slice(0, 300)}`, `agent told by the banner in the tool result: ${notice}`,
      ]);
    }
    // Stuck-loop diff: when the verdict is stuck on a failed result and a previous failed output
    // for the same call is available, replace the tool result with a short diff note. Compute
    // bytesSaved against the current content (after duplicate detection and compression), so the
    // diff never grows the result.
    const verdict = await stuckCheck;
    if (verdict && verdict.stuck && failed && !verdict.successRepeat && !verdict.churn && text.length > 0) {
      const currentKey = attempts.attempts.at(-1)?.key;
      const prevEntry = currentKey ? fullOutputs.get(currentKey) : undefined;
      if (currentKey && prevEntry && prevEntry.text !== text) {
        // Differing outputs: save the current output and diff against the previous one.
        try {
          const saved = await saveOutput(text);
          const diffNote = stuckDiff(prevEntry.text, text, { diffLimit: config.stuck.diffLimit, tailLimit: config.stuck.tailLimit, fullPath: saved });
          const currentLen = Buffer.byteLength(content.map(part => part.type === "text" ? part.text : "").join("\n"));
          if (Buffer.byteLength(diffNote) < currentLen) {
            content = [{ type: "text", text: diffNote }, ...content.filter(part => part.type !== "text")];
          }
          fullOutputs.set(currentKey, { text, path: saved });
        } catch {
          noteError(ctx, "Could not store full output for stuck diff; keeping it unchanged.", undefined);
          fullOutputs.set(currentKey, { text });
        }
      } else if (currentKey && prevEntry && prevEntry.text === text && prevEntry.path) {
        // Byte-identical outputs: one-line note reusing the existing saved path.
        const diffNote = stuckDiff(text, text, { diffLimit: config.stuck.diffLimit, tailLimit: config.stuck.tailLimit, fullPath: prevEntry.path });
        const currentLen = Buffer.byteLength(content.map(part => part.type === "text" ? part.text : "").join("\n"));
        if (Buffer.byteLength(diffNote) < currentLen) {
          content = [{ type: "text", text: diffNote }, ...content.filter(part => part.type !== "text")];
        }
      } else if (currentKey) {
        // First failed output for this call, or no previous entry yet: store for future diffs.
        fullOutputs.set(currentKey, { text });
      }
    } else if (failed && text.length > 0) {
      // Not stuck (or no verdict yet): store the output so a future repeat can diff against it.
      const currentKey = attempts.attempts.at(-1)?.key;
      if (currentKey) fullOutputs.set(currentKey, { text });
    }
    const patch = content === event.content ? undefined : { content };
    /** The note rides the result the model is about to read; the call already ran, so this only adds text to it. */
    const withWaste = (current: { content: typeof content } | undefined): { content: typeof content } | undefined => {
      if (!wasteNudge) return current;
      const base = current?.content ?? event.content;
      const lastText = base.reduce((last, part, index) => part.type === "text" ? index : last, -1);
      if (lastText < 0) return current;
      const next = base.map((part, index) => {
        if (part.type !== "text" || index !== lastText) return part;
        return { ...part, text: `${part.text}\n\n${wasteNudge.text}` };
      });
      // Redaction runs before the cut: a 200-character slice can leave half a credential the redactor no longer knows.
      const triggerCommand = event.toolName === "bash" && typeof (event.input as { command?: unknown }).command === "string"
        ? ` ${redact((event.input as { command: string }).command).replace(/\s+/g, " ").slice(0, 200)}`
        : "";
      record(ctx, config, "waste", `warden · waste · ${wasteNudge.detector} · ${wasteNudge.subject} · agent told`, [
        `trigger: ${event.toolName}${triggerCommand}`,
        `detector: ${wasteNudge.detector}`,
        `subject: ${redact(wasteNudge.subject)}`,
        `nudge: ${wasteNudge.text}`,
        `rate limit: at most one ${wasteNudge.detector} note per ${config.waste.every} calls; no steer, no request`,
      ]);
      return { content: next };
    };
    // Checks use the original result, not the excerpts or security banner.
    if (config.done.enabled) recordDoneOutcome(evidence, classifyToolResult(event.toolName, event.input, failed, text, ctx.cwd), event.input, event.toolName);
    if (config.done.enabled && config.done.uiProof && !failed) {
      const input = event.input as Record<string, unknown>;
      const written = event.toolName === "write" || event.toolName === "edit" ? (typeof input.path === "string" ? [input.path] : [])
        : event.toolName === "bash" && typeof input.command === "string" ? shellWrites(input.command, { home: homedir() }).writes.map(write => write.path) : [];
      recordUi(evidence, written.map(path => projectPath(path, ctx.cwd) ?? path), isVisualCheck(event.toolName, input, failed, config.done.visualTools), config.done.uiFiles);
    }
    // A stuck verdict on the same call carries its own steer; the quick one would say the same thing twice.
    if (quickRepeat && !verdict?.stuck) {
      const nudge = quickRepeatNudge(quickRepeat);
      const sent = adaptiveSend(ctx, config, "repeat") && steer(config, "repeat", nudge);
      if (sent) watchSteer(ctx, config, ["repeat"], { call: { name: event.toolName, input: event.input as Record<string, unknown> } });
      record(ctx, config, "stuck", `warden · stuck · repeat · ${quickRepeat.attempt.tool} · ${quickRepeat.attempt.failed ? "same failure" : "same output"} · ${sent ? "agent nudged" : "recorded only"}`, [
        `call: ${quickRepeat.attempt.call}`, `previous identical call: ${quickRepeat.callsAgo} calls ago, nothing changed between`, `agent told: ${sent ? nudge : "nothing (repeat of a recent steer, over the steer budget, or trace-only for this model)"}`,
      ]);
      if (sent && ctx.hasUI && config.notices) ctx.ui.notify(`warden \u00b7 repeat: ${quickRepeat.attempt.failed ? "same call failed the same way" : "same output re-read"} (agent nudged)`, "warning");
    }
    if (!verdict) return withWaste(patch);
    if (verdict.error) noteError(ctx, verdict.error, verdict.errorCode);
    if (verdict.source === "repeat" && !verdict.stuck) return withWaste(patch);
    const nudge = verdict.stuck && config.stuck.nudge ? stuckNudge(verdict) : undefined;
    record(ctx, config, "stuck", formatStuck(verdict, config.widget.stuck), stuckDetails(verdict, attempts.attempts, nudge));
    if (!verdict.stuck) return withWaste(patch);
    stats.stuck++;
    if (ctx.hasUI && config.notices) ctx.ui.notify(`warden \u00b7 stuck: ${verdict.reasons.join("; ")}${nudge ? " (agent nudged)" : ""}`, "warning");
    if (nudge && adaptiveSend(ctx, config, "stuck") && steer(config, "stuck", nudge)) watchSteer(ctx, config, ["stuck"], { call: { name: event.toolName, input: event.input as Record<string, unknown> } });
    return withWaste(patch);
  });

  // Opt-in: a relayed report that pastes earlier turns again keeps only its new part. Pi persists the replaced message.
  pi.on("message_end", async (event, ctx) => {
    const config = configFor(ctx);
    const message = event.message;
    if (message.role === "assistant") settleSteers(config, steerWatch.assistant(assistantView(message.content)));
    if (!config.enabled || !config.context.enabled || !config.context.dedupeRuns || !config.context.dedupeMessages) return;
    if (message.role !== "user" && message.role !== "custom") return;
    syncSeen(ctx);
    const source = message.role === "custom" ? `${message.customType} message` : "user message";
    if (typeof message.content === "string") {
      const text = await dedupeText(ctx, config, message.content, source);
      return text === undefined ? undefined : { message: { ...message, content: text } };
    }
    const content = await dedupeContent(ctx, config, message.content, source);
    return content ? { message: { ...message, content } } : undefined;
  });

  // The agent has caught up and Pi will not continue on its own: the one moment a wake costs the user nothing.
  pi.on("agent_settled", async (_event, ctx) => {
    await checkSubagentReports(ctx, configFor(ctx));
    // ── Conscience: finalize trace status ──
    const config = configFor(ctx);
    if (config.enabled && config.conscience.enabled && selectedCapability) {
      const status = triggerConsumed ? "consumed" : reminderSent ? "reminded" : "unresolved";
      record(ctx, config, "conscience", `settled: ${status} (${selectedCapability.kind}:${selectedCapability.id})`, ["trigger: agent_settled", `assessments: ${assessmentsThisPrompt}`, `nudges: ${nudgesThisPrompt}`, `instructions: ${instructionState}`]);
    }
  });

  // Compaction evidence appendix: after compaction succeeds, send the evidence warden holds as one
  // custom message so the agent can prefer saved paths over re-running commands. This is not a steer
  // and does not spend a steer unit; it is one message per compaction, the same path steers use.
  /** The session's evidence as the compaction appendix and `warden_recall` both read it. */
  const evidenceSnapshot = (ctx: ExtensionContext, openLoopsText?: string) => buildCompactSnapshot({
    savedOutputs: ledger.storedOutputs(),
    checks: evidence.checks.map((check, index) => ({ command: check.call, passed: check.passed, runIndex: 1, indexInRun: index })),
    holds: holds.records().filter(r => r.held).map(r => ({ tool: r.tool, preview: r.callExcerpt ?? "", outcome: r.outcome })),
    attempts: attempts.attempts,
    evidence,
    activeTask: latestUserPrompt(ctx),
    runs: 1,
    ...(openLoopsText ? { openLoops: openLoopsText } : {}),
  });

  pi.on("session_compact", async (_event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled || !config.context.compactAppendix) return;
    try {
      const file = loopsFile(ctx);
      // An unreadable loops file costs the appendix its loops section, not the evidence.
      const loopsText = file ? await readLoops(file).then(store => formatOpenLoops(openLoops(store)), (error: unknown) => {
        record(ctx, config, "action", "loops read error", [`reading the loops file failed: ${error instanceof Error ? error.message : String(error)}`]);
        return undefined;
      }) : undefined;
      const snapshot = evidenceSnapshot(ctx, loopsText);
      const appendix = compactAppendix(snapshot);
      if (!appendix) return;
      // Not a steer; one message per compaction; do not spend a steer unit.
      pi.sendMessage({ customType: `${PACKAGE_NAME}-compact-evidence`, content: appendix, display: config.steerVisible });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(ctx, config, "action", "compact-appendix error", [`compactAppendix failed: ${message}`]);
    }
  });

  // Relevance compaction (opt-in): Jev picks what of the discarded span stays word for word, in place of Pi's summary.
  // Returning nothing lets Pi's own summary run, so every failure path returns nothing; it never cancels a compaction.
  pi.on("session_before_compact", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled || !config.compaction.enabled) return undefined;
    compactions.runs++;
    const fallback = (reason: FallbackReason | "skipped" | "judgments off", details: string[], stats?: CompactionStats) => {
      compactions.fallbacks[reason] = (compactions.fallbacks[reason] ?? 0) + 1;
      if (stats) compactions.last = stats;
      record(ctx, config, "context", `warden · context · relevance compaction · Pi's summary ran (${reason})`, details);
      return undefined;
    };
    const provider = ctx.model?.provider;
    if (provider && config.compaction.skipProviders.includes(provider)) return fallback("skipped", [`provider ${provider} is in compaction.skipProviders`]);
    const judge = judgeFor(config);
    if (!judge) return fallback("judgments off", ["no Jev judge (consent, key, budget, or cooldown); Pi's summary runs"]);
    const preparation = event.preparation;
    try {
      const task = latestUserPrompt(ctx) ?? "";
      const result = await relevanceCompaction({
        messages: preparation.isSplitTurn ? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages] : preparation.messagesToSummarize,
        previousSummary: preparation.previousSummary,
        fileOps: preparation.fileOps,
        task,
        spine: taskSpine(ctx.sessionManager.getBranch(), task),
        focus: event.customInstructions,
      }, {
        judge, config: config.compaction, signal: event.signal, savedPathFor: text => ledger.storedPathIn(text),
        // The client carries the global per-request timeout; compaction.timeoutMs bounds the whole compaction on top of it.
        requestTimeoutMs: config.timeoutMs,
        // Read from the shared client, so requests every guard started count against the reserve.
        requestsLeft: () => (judge.getSpend().caps.maxRequests ?? config.maxRequests) - judge.getUsage().requestsStarted,
      });
      const stats = result.stats;
      const counts = `${stats.candidates} scored units, ${stats.requests} request${stats.requests === 1 ? "" : "s"}, ${stats.inputTokens} input tokens, ${stats.elapsedMs} ms`;
      if (!result.ok) {
        // A budget stop never turns judgments off: the guards keep what is left of the budget.
        if (result.reason === "budget") { if (ctx.hasUI) ctx.ui.notify(`warden: relevance compaction stopped to spare the request budget (${result.detail ?? "budget reached"}); Pi's summary runs.`, "warning"); }
        else if (result.reason === "judge error") noteError(ctx, `Relevance compaction failed (${result.detail ?? "TypeSafe error"}); Pi's summary runs.`, undefined);
        return fallback(result.reason, [`${counts}; ${result.reason}${result.detail ? `: ${result.detail}` : ""}`], stats);
      }
      // Pi checks the signal only after the hook returns; an aborted compaction is not replaced.
      if (event.signal.aborted) return fallback("aborted", [counts], stats);
      compactions.replaced++;
      compactions.last = stats;
      record(ctx, config, "context", `warden · context · relevance compaction · kept ${stats.kept} of ${stats.candidates}`, [
        `${counts}; threshold ${stats.threshold}; summary ~${stats.summaryTokens} tokens (Pi counted ${preparation.tokensBefore} before)`,
      ]);
      return { compaction: { summary: result.summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details: { source: `${PACKAGE_NAME} relevance compaction`, kept: stats.kept, candidates: stats.candidates, ...result.files } } };
    } catch (error) {
      return fallback("judge error", [`relevance compaction failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
  });

  // Block new user messages while /warden init or /warden audit is running.
  pi.on("input", async (event, ctx) => {
    if (initRunning) {
      ctx.ui.notify("pi-warden is generating rules. Please wait...", "warning");
      return { action: "handled" };
    }
    if (auditRunning) {
      ctx.ui.notify("pi-warden is running an audit. Please wait...", "warning");
      return { action: "handled" };
    }
    if (indexRunning) {
      ctx.ui.notify("pi-warden is building the capability index. Please wait...", "warning");
      return { action: "handled" };
    }
    // Operator input invalidates in-flight conscience assessments
    conscienceGeneration++;
    settleSteers(configFor(ctx), steerWatch.user());
  });

  /**
   * One short reminder of the open loops when a run ends, for the next turn: it starts no turn of its own, counts against
   * the steer budget as `loops`, and names the same unchanged list only once.
   */
  const remindLoops = async (ctx: ExtensionContext, config: WardenConfig) => {
    const file = loopsFile(ctx);
    if (!file) return;
    try {
      const open = openLoops(await readLoops(file));
      const fingerprint = loopsFingerprint(open);
      if (!open.length || fingerprint === loopsReminded) return;
      const notice = `pi-warden: ${open.length} open loop${open.length === 1 ? "" : "s"} you promised in this session:\n${formatOpenLoops(open)}\nClose each with warden_loops done or drop once it is finished or no longer needed.`;
      if (adaptiveSend(ctx, config, "loops") && steer(config, "loops", notice, { deliverAs: "nextTurn" })) {
        loopsReminded = fingerprint;
        watchSteer(ctx, config, ["loops"], {}, true);
      }
    } catch (error) {
      record(ctx, config, "action", "loops reminder error", [`reading the loops file failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
  };

  pi.on("agent_end", async (event, ctx) => {
    const config = configFor(ctx);
    // The run is over: a notice that no turn of a continuing loop delivered may not be appended now, because a delivery must
    // never start a turn of its own. It is dropped and traced.
    agentRunActive = false;
    dropPendingNotices(ctx, config, "the run ended before the notice could ride a model call the run made anyway");
    if (!config.enabled) return;
    // A steer hold whose reply has arrived, on a run that neither released it nor replaced it, went nowhere.
    noteOutcomes(config, holds.runEnded());
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
    await remindLoops(ctx, config);
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
    // ── Conscience: one reminder at agent_end if capability is still unresolved ──
    // A run that ended with a final text reply has answered: a reminder then starts a new turn to revisit a finished answer.
    if (config.conscience.enabled && selectedCapability && !finalMessage && !reminderSent && !triggerConsumed &&
        assessmentsThisPrompt < config.conscience.maxAssessments &&
        nudgesThisPrompt < config.conscience.maxNudges && budgetAvailable(config) && judge) {
      const myGeneration = conscienceGeneration;
      let toolInfos: Array<{ name: string; description: string }> = [];
      try { toolInfos = pi.getAllTools().map((t: { name: string; description: string }) => ({ name: t.name, description: t.description })); } catch { toolInfos = []; }
      const prompt = latestUserPrompt(ctx);
      const redactedPrompt = redact(prompt ?? "").slice(0, 2000);
      const spine = taskSpine(typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [], prompt ?? undefined);
      const activeSkills = cachedSkills.map(s => s.name);
      let judgeModel = "";
      const judgeAdapter = judge ? { evaluate: async (req: { state: unknown; questions: import("pi-typesafe").Questions }) => { const r = await judge.evaluate(req as Parameters<typeof judge.evaluate>[0]); judgeModel = r.model; return { answers: r.answers as Record<string, unknown> }; } } : undefined;
      try {
        const result = await assess(redactedPrompt, "", cachedSkills as unknown as import("@earendil-works/pi-coding-agent").Skill[], toolInfos, activeSkills, [], { judge: judgeAdapter, config: config.conscience, sharedTimeoutMs: config.timeoutMs, now: () => Date.now(), globalIndex: globalIndexFile, projectIndex: projectIndexFile }, spine);
        if (conscienceGeneration !== myGeneration) return;
        assessmentsThisPrompt++;
        // Same activation gate as the first recommendation: selectedCapability is set before that gate, so without this a
        // capability held for no_policy would be delivered here.
        if (result.selected && result.selected.kind === selectedCapability.kind && result.selected.id === selectedCapability.id &&
            result.disposition !== "awaiting_user" && policyMatches(consciencePolicy, result.questionHash, judgeModel) && adaptiveSend(ctx, config, "conscience")) {
          reminderSent = true;
          nudgesThisPrompt++;
          spendBudgetUnit();
          const msg = `Reminder: ${recommendationText(result.selected, redactedPrompt, "consider")}`;
          if (steer(config, "conscience", msg, { deliverAs: "followUp" })) watchSteer(ctx, config, ["conscience"], { capability: { kind: result.selected.kind === "skill" ? "skill" : "tool", id: result.selected.id } });
        }
      } catch (err) { const cat = err instanceof Error ? (/(timeout|timed out)/i.test(err.message) ? "timeout" : /(auth|key|credential|401|403)/i.test(err.message) ? "auth" : /(network|fetch|connect)/i.test(err.message) ? "network" : "other") : "other"; if (!warnedErrorCategories.has(cat)) { warnedErrorCategories.add(cat); console.warn(`pi-warden: conscience ${cat}`); } }
    }
    // ── Turn rules: one end-of-run judgment against the whole diff, and the files no per-edit check saw ──
    // One steer for the findings, through the done-check's delivery; the verdicts land in the rules log like the rest.
    if (config.rules.enabled && turnSnapshot) {
      // The run end waits for the snapshot the run start began; a run that ended first has been waiting since.
      const snapshot = await turnSnapshot;
      turnSnapshot = undefined;
      const set = rulesGuard.store.load(ctx.cwd, config.rules);
      if (!snapshot.tree) {
        if (set && turnRulesFor(set).length) record(ctx, config, "rules", `warden · rules · turn rules skipped this run: ${snapshot.reason}`, ["trigger: agent_end", "no working-tree snapshot: the end-of-run pass will not run this turn rules check"]);
      } else {
        const turnRun = await evaluateTurnRun({ cwd: ctx.cwd, config: config.rules, set, judge, timeoutMs: config.timeoutMs, signal: ctx.signal, task: latestUserPrompt(ctx), startTree: snapshot.tree, start: { head: snapshot.head, startedAt: snapshot.startedAt }, alreadyJudged: turnJudged });
        if (turnRun.skipped) {
          record(ctx, config, "rules", `warden · rules · end-of-run pass skipped: ${turnRun.skipped}`, ["trigger: agent_end"]);
        }
        // The git-brought filter failed or was cut at its probe limit: one line says so, even when no verdict follows.
        if (turnRun.notes.length) record(ctx, config, "rules", `warden · rules · ${turnRun.notes[0]}`, ["trigger: agent_end", ...turnRun.notes]);
        // One trace line names the files the per-run cap left unjudged, like the skips of one command's shell writes.
        if (turnRun.skips.length) {
          const paths = turnRun.skips.flatMap(skip => (skip.path ? [skip.path] : []));
          record(ctx, config, "rules", renderTemplate(config.widget.rules, { guard: "rules", tool: "unseen change", path: paths.length ? paths.join(", ") : "file change", status: "skipped" }), turnRun.skips.map(skip => `unseen change not judged${skip.path ? ` (${skip.path})` : ""}: ${skip.reason}`));
        }
        let counts: ReadonlyMap<string, number> = new Map();
        for (const verdict of turnRun.verdicts) counts = rulesGuard.count(verdict);
        const hasFindings = turnRun.verdicts.some(verdict => verdict.findings.length > 0);
        const told = hasFindings && adaptiveSend(ctx, config, "rules") ? turnSteer(turnRun.verdicts, counts) : undefined;
        const delivered = told ? steer(config, "rules", told, { deliverAs: "followUp", triggerTurn: true }) : false;
        if (delivered) watchSteer(ctx, config, ["rules"]);
        for (const verdict of turnRun.verdicts) {
          const shown = renderTemplate(config.widget.rules, { ...rulesTokens(verdict), tool: verdict.tool === "turn" ? "turn" : "unseen change", path: verdict.tool === "turn" ? "the run's diff" : verdict.path });
          const cuts = verdict.tool === "turn" && turnRun.cuts.length ? [`diff caps cut: ${turnRun.cuts.join("; ")}`] : [];
          if (verdict.source !== "skipped") {
            stats.ruleChecks++;
            if (verdict.error) noteError(ctx, verdict.error, verdict.errorCode);
            if (verdict.source === "typesafe") {
              for (const observation of rulesLog?.record(verdict, config.rules.threshold, Date.now(), config.rules.softThreshold) ?? []) {
                if (observation.cleared) record(ctx, config, "rules", `rules: ${observation.name} now clear on ${verdict.path}`, [`clear: a later judgment on this path scored ${observation.violation.toFixed(2)}, below the ${config.rules.threshold} threshold`]);
              }
            }
            if (verdict.findings.length) {
              stats.ruleViolations++;
              if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · rules · ${verdict.tool === "turn" ? "this run's changes" : verdict.path}: ${verdict.findings.map(finding => `${finding.name} (${finding.violation.toFixed(2)})`).join("; ")}`, "warning");
            }
            const agentTold = told && delivered ? `agent told: ${told}` : told ? `steer recorded, not delivered (a repeat or the per-run budget): ${told}` : undefined;
            record(ctx, config, "rules", shown, [...cuts, ...rulesDetails(verdict, agentTold)]);
          } else {
            record(ctx, config, "rules", shown, [`${verdict.tool} ${verdict.path}: ${verdict.skippedReason}`]);
          }
        }
      }
    }
    if (!finalMessage || !judge) return;
    // Pi shows the agent as working until this hook returns, so the two independent checks share one round trip.
    const task = latestUserPrompt(ctx);
    const proseCheck = config.slop.enabled && config.slop.prose.enabled && finalMessage.length >= config.slop.prose.minChars
      ? evaluateProse(task, finalMessage, { config: config.slop.prose, judge, timeoutMs: config.timeoutMs, signal: ctx.signal })
      : undefined;
    const doneCheck = config.done.enabled && needsDoneCheck(evidence)
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
        if (adaptiveSend(ctx, config, "prose") && steer(config, "prose", nudge, { deliverAs: "nextTurn" })) watchSteer(ctx, config, ["prose"], {}, true);
      }
    }
    if (!doneCheck) return;
    stats.doneChecks++;
    const verdict = await doneCheck;
    if (verdict.error) noteError(ctx, verdict.error, verdict.errorCode);
    // At most one nudge per user prompt; a later unverified claim is still judged and recorded.
    const nudge = verdict.unverified && config.done.nudge && !doneNudged ? doneNudge(verdict) : undefined;
    record(ctx, config, "done", formatDone(verdict, config.widget.done), doneDetails(verdict, finalMessage, nudge));
    if (!verdict.unverified) return;
    stats.unverified++;
    if (ctx.hasUI && config.notices) ctx.ui.notify(`warden · done-check: ${verdict.reasons.join("; ")}${nudge ? " (agent asked to verify)" : ""}`, "warning");
    if (nudge) {
      doneNudged = true;
      if (steer(config, "done", nudge, { deliverAs: "followUp", triggerTurn: true })) watchSteer(ctx, config, ["done"]);
    }
  });

  // Shortcuts are registered once at load; a shape check keeps a typo in the config file from being registered.
  const shortcut = loadConfig({ dirs }).widget.shortcut;
  if (/^(?:(?:ctrl|shift|alt|super)\+)+[a-z0-9]+$|^f\d{1,2}$/i.test(shortcut)) {
    pi.registerShortcut(shortcut as KeyId, {
      description: "Toggle the pi-warden trace sidebar",
      handler: async ctx => { if (ctx.hasUI) togglePanel(ctx.ui as unknown as PanelUi, configFor(ctx)); },
    });
  }

  // A plain JSON Schema: Pi compiles tool schemas with TypeBox, which accepts one, and pi-warden keeps no TypeBox dependency.
  const toolParameters = (properties: Record<string, unknown>, required: string[]) =>
    ({ type: "object", properties, required, additionalProperties: false }) as unknown as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];
  const toolReply = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
  const rememberParameters = toolParameters(
    { lesson: { type: "string", maxLength: LESSON_CHARS, description: `One standing instruction for this project, at most ${LESSON_CHARS} characters, e.g. "Never X" or "Always Y".` } },
    ["lesson"],
  );
  pi.registerTool({
    name: "warden_remember",
    label: "warden remember",
    description: `Record a standing lesson for this project, so later sessions keep it. Use it after the user corrected you, after a mistake you had to undo, or when you learned a fact about this project that later sessions need (for example, a site blocks one browser and allows another); never for task notes, plans, or progress. The lesson is one instruction in a standing form (don't, never, always, stop, from now on, next time), names no ticket, branch, PR, or hash, and never skips a test, check, review, or confirmation. It reaches later sessions only once it is confirmed.`,
    parameters: rememberParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = configFor(ctx);
      if (!config.enabled || !config.prefs.enabled) return toolReply(`not recorded: standing preferences are off (${config.enabled ? "prefs.enabled" : "enabled"} is false)`);
      const lesson = typeof (params as { lesson?: unknown }).lesson === "string" ? (params as { lesson: string }).lesson : "";
      const manager = ctx.sessionManager as Partial<ExtensionContext["sessionManager"]>;
      const session = typeof manager.getSessionId === "function" ? manager.getSessionId() : "unknown";
      const scan = await standingPrefs(ctx);
      const path = prefsStorePath(scan.project, dirs);
      const reply = await changePrefsStore(path, store => {
        const result = recordLesson({ lesson, session, now: Date.now(), scan, store });
        return { value: result.reply, ...(result.store ? { store: result.store } : {}) };
      });
      return toolReply(reply);
    },
  });

  pi.registerTool({
    name: "warden_loops",
    label: "warden loops",
    description: `Keep open loops for this session, so a long session never loses a promise. Whenever you promise to do something later ("after CI passes I will bump the version", "I will come back to the flaky test"), add a loop; mark it done when you did it, or drop it with a reason when it is no longer needed. Actions: add (text, at most ${LOOP_CHARS} characters, and an optional when condition such as "after CI passes"), done (id), drop (id and reason), list. Open loops are shown again after compaction, at the end of a run, and on resume. They belong to this session only.`,
    parameters: toolParameters({
      action: { type: "string", enum: [...LOOP_ACTIONS], description: "add, done, drop, or list." },
      text: { type: "string", maxLength: LOOP_CHARS, description: "For add: what you promised to do." },
      when: { type: "string", maxLength: LOOP_CHARS, description: "For add, optional: the condition that makes it due." },
      id: { type: "integer", minimum: 1, description: "For done and drop: the loop number." },
      reason: { type: "string", maxLength: LOOP_CHARS, description: "For drop: why it is no longer needed." },
    }, ["action"]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!configFor(ctx).enabled) return toolReply("not available: pi-warden is off (enabled is false)");
      const file = loopsFile(ctx);
      if (!file) return toolReply("not available: this session has no id to keep loops under");
      const reply = await updateLoops(file, store => applyLoopAction(store, params as Record<string, unknown>, Date.now()));
      return toolReply(reply);
    },
  });

  pi.registerTool({
    name: "warden_recall",
    label: "warden recall",
    description: "Recall what was already tried in this session before you try it again: the failed attempts with their error lines, the last passing check and whether the code changed since, and the paths of saved full outputs (read those instead of re-running the command). Read-only; takes no arguments.",
    parameters: toolParameters({}, []),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!configFor(ctx).enabled) return toolReply("not available: pi-warden is off (enabled is false)");
      return toolReply(recallText(evidenceSnapshot(ctx)));
    },
  });

  const actions = ["status", "rules", "report", "enable", "disable", "mode", "config", "test", "trace", "init", "audit", "index", "prefs", "loops", "recommend", "unmute", "bench"];
  pi.registerCommand("warden", {
    description: "pi-warden status, active rules, config (set/get/editor), TypeSafe consent, mode, trace panel, recommend, standing preferences, open loops, and a synthetic guard test",
    getArgumentCompletions(prefix) {
      const matches: Array<{ value: string; label: string; description?: string }> = actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
      // `rules check`, `rules audit`, `rules calibrate`, and `rules tune` are two-word actions: `rules` on its own stays the local list.
      if ("rules check".startsWith(prefix)) matches.push({ value: "rules check", label: "rules check", description: "which of the active rules the guard cannot judge well" });
      if ("rules audit".startsWith(prefix)) matches.push({ value: "rules audit", label: "rules audit", description: "judge existing files against the project rules as if they had just been written" });
      if ("rules calibrate".startsWith(prefix)) matches.push({ value: "rules calibrate", label: "rules calibrate", description: "replay recent commits through the active rules and flag the ones that fire on everything or cannot decide" });
      if ("rules tune".startsWith(prefix)) matches.push({ value: "rules tune", label: "rules tune", description: "ask the agent to rewrite the rules the latest calibrate or rules check flagged" });
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      // `.filter(Boolean)` because an empty args string splits to [""] and the `status` default would never fire.
      // `argument` stays the single word the one-word actions expect; `tail` keeps the whole line for
      // `config set <key> <value>`, where the value is the rest of what was typed.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const [action = "status", argument] = tokens;
      const tail = tokens.slice(1).join(" ");
      const report = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
      };
      try {
        const config = configFor(ctx);
        if (action === "status") {
          // A refused backend has no key to describe; the refusal itself is the status line.
          const backend = config.typesafeBackend;
          const auth = config.backendRefusal !== undefined || backend === undefined ? undefined : describeAuth(authState({ backend }));
          const source = consentSource(config);
          const usage = client?.getUsage();
          const guards = [config.action.enabled && "action", config.stuck.enabled && "stuck", config.done.enabled && "done-check", config.slop.enabled && "slop", config.slop.enabled && config.slop.prose.enabled && `prose (${config.slop.prose.audience})`, config.security.enabled && "security", config.rules.enabled && "rules", config.context.enabled && "context", config.runaway.enabled && "runaway", config.subagent.enabled && "subagent triage", config.notify.enabled && "desktop notifications"].filter(Boolean).join(", ");
          const ls = await holdStats(ctx.cwd, dirs);
          const lifetimeLine = ls.labeled === 0
            ? `Lifetime here: ${ls.held} hold${ls.held === 1 ? "" : "s"}, not yet measurable (${ls.allowed} allowed).`
            : `Lifetime here: ${ls.held} hold${ls.held === 1 ? "" : "s"}, ${ls.labeled} labeled, ${ls.declined + ls.replanned} stood (${ls.declined + ls.replanned}/${ls.labeled}), ${ls.abandoned} abandoned, ${ls.allowed} allowed (${ls.accepted} accepted, ${ls.regretted} regretted).`;
          report([
            `pi-warden: ${config.enabled ? `guarding ${config.action.tools.join(", ")} (${guards})` : "off"}; mode ${activeMode(config, ctx.hasUI)}; TypeSafe judgments ${source ? `consented via ${source}` : "not consented (run /warden enable)"}${config.backendRefusal !== undefined || backend === undefined || backend === "typesafe" ? "" : ` (${describeBackend(backend)})`}; ${config.backendRefusal !== undefined ? `judgments are off: typesafeBackend refused: ${config.backendRefusal}` : auth?.text ?? ""}`,
            `Session: ${stats.inspected} inspected, ${stats.judged} judged, ${stats.warned} warned, ${stats.held} held, ${stats.approved} approved on retry, ${stats.offPlan} off plan (${stats.offPlanTraceOnly} trace-only), ${stats.offTask} off task, ${stats.slop} slop notes, ${stats.ruleViolations}/${stats.ruleChecks} rule violations, ${stats.pathNotes} sensitive-path notes, ${stats.stuck}/${stats.stuckChecks} stuck, ${stats.unverified}/${stats.doneChecks} unverified done, ${stats.proseNudges}/${stats.proseChecks} prose nudges, ${stats.runaway} runaway stops, ${stats.subagentWoken}/${stats.subagentReports} subagent reports woken, ${stats.restatements} restatements, ${stats.errors} TypeSafe errors, ${stats.cooldownSkips} checks without Jev during a judge cooldown; ${usage?.requestsStarted ?? 0}/${config.maxRequests} requests. Steers are ${config.steerVisible ? "shown in the transcript" : "hidden from the transcript (trace panel shows them)"}. Steer budget: ${config.steerBudget === 0 ? "off" : `${config.steerBudget} per run`}.`,
            formatSteers(stats),
            `${formatMuted(steerStats.muted(), config.steers)}${stats.steersMuted ? ` This session: ${stats.steersMuted} steer${stats.steersMuted === 1 ? "" : "s"} kept in the trace only.` : ""}`,
            `Thresholds: irreversible warn ${config.action.irreversible.warn} / hold ${config.action.irreversible.confirm}; off-task warn ${config.action.offTask.warn} / steer ${config.action.offTask.steer} (never holds); intent mismatch ${config.action.intentMismatch} (${config.action.visibleMismatch} on a visible action, trace-only: ${config.action.intentTraceOnly}); stuck same-strategy ${config.stuck.sameStrategy} after ${config.stuck.minFailures} failures; done claims ${config.done.claimsDone}; slop ${config.slop.threshold}, rules ${config.rules.threshold}, prose ${config.slop.prose.threshold} in ${config.slop.prose.trend}/3 replies; runaway ${config.runaway.repeats} repeats (thinking ${config.runaway.thinkingRepeats}), recover ${config.runaway.recover}; failOpen ${config.action.failOpen}.`,
            formatCurator(curator.snapshot()),
            formatLedger(ledger.snapshot()),
            formatCompaction(config.compaction.enabled, compactions),
            ...(config.context.filter.enabled || ledger.snapshot().filter.requests > 0 || Object.keys(ledger.snapshot().filter.fallbacks).length > 0 ? [formatFilterLedger(ledger.snapshot())] : []),
            ...(config.learning.patternAnalysis ? [`Learning: ${(await generateRecommendations(ctx.cwd, dirs)).length} recommendations, steer effectiveness ${Math.round((await analyzeSteerEffectivenessReport(ctx.cwd, dirs)).overall * 100)}% (use /warden recommend for details)`] : []),
            `${formatHolds(holds.snapshot(), config.action.feedbackLog ? holdLog?.path : undefined)}${holdLog?.lastFailure ? ` Log write failed: ${holdLog.lastFailure}.` : ""}`,
            lifetimeLine,
            `Rules: ${config.rules.enabled ? `${rulesGuard.describe(ctx.cwd, config.rules)}${Object.keys(config.rules.sensitivePaths).length ? `; ${Object.keys(config.rules.sensitivePaths).length} sensitive path${Object.keys(config.rules.sensitivePaths).length === 1 ? "" : "s"}` : ""}` : "off"}.`,
            ...(config.action.armingRules.length > 0 ? [`Arming: ${arming.statusLine() || "no rules armed"}.`] : []),
            `Desktop notifications: ${config.notify.enabled ? `on (${config.notify.command.length ? `command ${config.notify.command[0]}` : (await (notifier ??= detectNotifier())) ?? "no notifier found on this machine"}; cooldown ${config.notify.cooldownMs} ms)` : "off (\"notify\": { \"enabled\": true } in the config turns them on)"}.`,
            `Config: ${userConfigPath(dirs)}${ctx.isProjectTrusted() ? ` and ${projectConfigPath(ctx.cwd, dirs)}` : ""}.`,
            ...(config.warnings?.length ? [`Config warnings: ${config.warnings.join("; ")}.`] : []),
            widget.size ? `Last: ${[...widget.values()].join(" | ")}` : "No guarded activity yet this session.",
            `Trace: ${trace.entries().length} events (/warden trace${shortcut ? `, ${shortcut}` : ""}, or click the status line in fullscreen mode; each toggles the sidebar). Widget templates in config.widget: action tokens ${TOKEN_NAMES.action.map(name => `{${name}}`).join(" ")}.`,
          ].join(" "));
          return;
        }
        if (action === "rules" && argument === "audit") {
          const parsed = parseRulesAuditArgs(tokens.slice(2));
          if (parsed.error) { report(parsed.error, "warning"); return; }
          const off = judgmentsOffReason(config);
          const judge = judgeFor(config);
          const result = await runRulesAudit({
            cwd: ctx.cwd, paths: parsed.paths, max: parsed.max, yes: parsed.yes, config: config.rules,
            set: rulesGuard.store.load(ctx.cwd, config.rules), judge, timeoutMs: config.timeoutMs, signal: ctx.signal,
            destination: backendHost(config.typesafeBackend),
            confirm: ctx.hasUI ? (title, body) => ctx.ui.confirm(title, body, ctx.signal ? { signal: ctx.signal } : {}) : undefined,
          });
          switch (result.status) {
            // No key, no consent, or a spent budget: say why and send nothing.
            case "no-judge":
              report(`Rules audit sent nothing: Jev judgments are off${off === "budget" ? " (the request budget is used up)" : ""}.${off && off !== "budget" ? ` ${judgmentsOffText(off, config, !ctx.hasUI)}` : ""}`);
              return;
            case "no-files": report(`Rules audit sent nothing: ${result.reason}.`); return;
            case "needs-yes": report(`Rules audit sent nothing: a headless run needs --yes before ${result.files} file samples go to ${backendHost(config.typesafeBackend)} (${result.leftOut} more files left out at the --max ${parsed.max} cap).`, "warning"); return;
            case "cancelled": report("Rules audit cancelled. Nothing was sent."); return;
            case "done": report(formatRulesAudit(result.outcome)); return;
          }
          return;
        }
        if (action === "bench") {
          const parsed = parseBenchArgs(tokens.slice(1));
          if (parsed.error) { report(parsed.error, "warning"); return; }
          const off = judgmentsOffReason(config);
          const judge = judgeFor(config);
          const result = await runBench({ runs: parsed.runs, cwd: ctx.cwd, config: config.rules, set: rulesGuard.store.load(ctx.cwd, config.rules), judge, getUsage: judge ? () => judge.getUsage() : undefined, timeoutMs: config.timeoutMs, signal: ctx.signal });
          switch (result.status) {
            // No key, no consent, or a spent budget: say why and send nothing.
            case "no-judge":
              report(`Bench sent nothing: Jev judgments are off${off === "budget" ? " (the request budget is used up)" : ""}.${off && off !== "budget" ? ` ${judgmentsOffText(off, config, !ctx.hasUI)}` : ""}`);
              return;
            case "skipped": report(`Bench sent nothing: ${result.reason}.`); return;
            case "done": report(formatBench(result)); return;
          }
          return;
        }
        if (action === "rules") {
          if (argument === "check") {
            const off = judgmentsOffReason(config);
            const result = await checkRules({ set: rulesGuard.store.load(ctx.cwd, config.rules), judge: judgeFor(config), timeoutMs: config.timeoutMs, signal: ctx.signal });
            if (result.source === "skipped") {
              // No key, no consent, or a spent budget: say why and send nothing.
              report(`Rules check sent nothing: Jev judgments are off${off === "budget" ? " (the request budget is used up)" : ""}.${off && off !== "budget" ? ` ${judgmentsOffText(off, config, !ctx.hasUI)}` : ""} /warden rules shows the rule set locally.`);
              return;
            }
            if (result.source === "typesafe") lastCheck = result;
            report(formatRulesCheck(result));
            return;
          }
          if (argument === "calibrate") {
            const usage = "Usage: /warden rules calibrate [--commits N] [--max N] [--yes].";
            const commitsMatch = /(?:^|\s)--commits\s+(\S+)/.exec(tail);
            const maxMatch = /(?:^|\s)--max\s+(\S+)/.exec(tail);
            const yes = /(?:^|\s)--yes(?:\s|$)/.test(tail);
            const commits = commitsMatch ? Number(commitsMatch[1]) : CALIBRATE_DEFAULT_COMMITS;
            const max = maxMatch ? Number(maxMatch[1]) : CALIBRATE_DEFAULT_MAX;
            if ((commitsMatch && (!Number.isInteger(commits) || commits < 1)) || (maxMatch && (!Number.isInteger(max) || max < 1))) { report(usage, "warning"); return; }
            const set = rulesGuard.store.load(ctx.cwd, config.rules);
            if (!set) { report("No rules file detected. Run /warden init to create project-specific rules."); return; }
            if (set.proseOnly) { report(`No rules to calibrate: ${set.sources.join(", ")} has no rule-shaped sections, so the guard judges nothing there.`); return; }
            if (set.aggregate !== undefined && !set.rules.length) { report(`No separate rules to calibrate: ${set.sources.join(", ")} has no rule headings, so the guard judges it as one document.`); return; }
            const off = judgmentsOffReason(config);
            const judge = judgeFor(config);
            if (!judge) {
              report(`Rules calibrate sent nothing: Jev judgments are off${off === "budget" ? " (the request budget is used up)" : ""}.${off && off !== "budget" ? ` ${judgmentsOffText(off, config, !ctx.hasUI)}` : ""} /warden rules shows the rule set locally.`);
              return;
            }
            let history: HistoryCommit[];
            try {
              history = collectHistory(ctx.cwd, commits);
            } catch (error) {
              report(`Rules calibrate could not read the git history: ${error instanceof Error ? error.message : String(error)}`, "warning");
              return;
            }
            const plan = planCalibration(history, { set, config: config.rules, cwd: ctx.cwd, maxRequests: max });
            if (!plan.requests) {
              report(`Rules calibrate sent nothing: no changed file in the last ${commits} non-merge commit${commits === 1 ? "" : "s"} is judgeable${plan.skipped.length ? ` (${plan.skipped.length} change${plan.skipped.length === 1 ? "" : "s"} skipped)` : ""}.`);
              return;
            }
            // Nothing leaves the machine before this gate: the dialog shows the count and the redacted diffs, and a
            // headless run needs the explicit --yes.
            const gate = calibrateGate({ hasUI: ctx.hasUI, yes });
            if (gate.kind === "refuse") { report(gate.reason, "warning"); return; }
            if (gate.kind === "confirm" && !await ctx.ui.confirm(`warden: send ${plan.requests} calibration request${plan.requests === 1 ? "" : "s"}?`, calibrationNotice(plan))) {
              report("Cancelled. Nothing was sent.");
              return;
            }
            const result = await calibrate(history, { set, config: config.rules, cwd: ctx.cwd, judge, timeoutMs: config.timeoutMs, maxRequests: max, signal: ctx.signal });
            (rulesLog ??= new RulesLog(ctx.cwd, String(process.pid))).appendRecords(result.records);
            lastCalibration = result;
            report(formatCalibration(result));
            return;
          }
          if (argument === "tune") {
            const request = tuneRequest({ calibration: lastCalibration, check: lastCheck, rules: rulesGuard.store.load(ctx.cwd, config.rules)?.rules ?? [] });
            if ("reason" in request) { report(request.reason); return; }
            initRunning = true;
            let sent = true;
            if (ctx.hasUI) ctx.ui.notify("pi-warden: Sending the rules rewrite prompt...", "info");
            try {
              // sendUserMessage throws when the agent is not idle. Brief wait so a
              // just-closing confirm dialog does not cause a race.
              for (let attempt = 0; attempt < 40; attempt++) {
                if (ctx.isIdle()) break;
                await new Promise(resolve => setTimeout(resolve, 250));
              }
              pi.sendUserMessage(request.prompt);
              await ctx.waitForIdle();
            } catch (err) {
              sent = false;
              const detail = err instanceof Error ? err.message : String(err);
              report(`pi-warden rules tune failed: ${detail}.`, "error");
            } finally {
              initRunning = false;
            }
            if (sent) report("Rewrite prompt sent. The agent edits pi-warden.md with its own tools; review the changes.");
            return;
          }
          report(rulesGuard.details(ctx.cwd, config.rules));
          return;
        }
        if (action === "report") {
          const match = /--days\s+(\d+)/.exec(tail);
          const days = match ? Number(match[1]) : REPORT_DEFAULT_DAYS;
          if (match && days < 1) { report("Usage: /warden report [--days N], where N is at least 1. Default: 30 days.", "warning"); return; }
          const all = await readRulesLog(rulesLogPath(ctx.cwd, dirs));
          // Calibration replays carry `source: "calibrate"`; the live verdict report counts only the live records and
          // says how many replays it set apart.
          const replays = all.filter(record => record.source === "calibrate").length;
          const set = rulesGuard.store.load(ctx.cwd, config.rules);
          const text = formatRulesReport(buildRulesReport(all, { days, currentRules: set?.rules.map(rule => ({ id: rule.id, name: rule.name })) ?? [], source: "live" }));
          report(replays ? `${text}\n${replays} calibration replay record${replays === 1 ? "" : "s"} in this log, counted apart (source: calibrate).` : text);
          return;
        }
        if (action === "trace") {
          if (!ctx.hasUI) { report(traceText()); return; }
          const opened = togglePanel(ctx.ui as unknown as PanelUi, config);
          // RPC mode has a UI but settles custom() without building the component, so the sidebar never shows. hasUI
          // is true there; only the host not asking for the component tells the two apart. Not awaited: in the
          // terminal `closed` settles when the user closes the sidebar. A host that asked for the trace file has no
          // terminal UI, so it gets the text whether or not the component was built.
          const fallback = () => { if (opened && (traceDir() || !opened.built())) ctx.ui.notify(traceText(), "info"); };
          void opened?.closed.then(fallback, fallback);
          return;
        }
        if (action === "unmute") {
          const kind = STEER_KINDS.find(name => name === argument);
          if (!kind) { report(`Usage: /warden unmute <kind> [model]. Kinds: ${STEER_KINDS.filter(name => !NEVER_MUTED.has(name)).join(", ")}.`, "warning"); return; }
          const models = tokens[2] ? [tokens[2]] : modelKey(ctx) ? [modelKey(ctx)!] : steerStats.modelsWith(kind);
          const reset = models.filter(model => steerStats.unmute(model, kind));
          report(reset.length ? `Reset ${kind} for ${reset.join(", ")}: its steers are sent again and counted from zero.` : `No counts for ${kind} on ${models.join(", ") || "any model"}; nothing to reset.`);
          return;
        }
        if (action === "loops") {
          const file = loopsFile(ctx);
          report(file ? formatLoopsForUser(await readLoops(file)) : "No loops: this session has no id to keep them under.");
          return;
        }
        if (action === "prefs") {
          if (!config.enabled || !config.prefs.enabled) { report(`Standing preferences are off (${config.enabled ? "prefs.enabled" : "enabled"} is false); no session files were read.`); return; }
          const { scan, path, items } = await evaluatedPrefs(ctx);
          if (argument === "forget") {
            const index = Number(tokens[2]);
            const item = Number.isInteger(index) ? items[index - 1] : undefined;
            if (!item) { report(`Usage: /warden prefs forget <n>, where n is an item number from /warden prefs (1 to ${items.length}).`, "warning"); return; }
            await changePrefsStore(path, store => ({ value: undefined, store: forgetPref(store, item) }));
            report(`Forgotten for this project: "${item.text}". It is not listed or injected again.`);
            return;
          }
          report(formatPrefs(scan, items));
          return;
        }
        if (action === "recommend") {
          // Learning-driven recommendations based on hold history
          const recommendations = await generateRecommendations(ctx.cwd, dirs);
          const steerReport = await analyzeSteerEffectivenessReport(ctx.cwd, dirs);
          
          const lines: string[] = [];
          lines.push("pi-warden learning recommendations:");
          
          if (recommendations.length === 0 && steerReport.suggestions.length === 0) {
            lines.push(`No recommendations yet. Need more hold data (current: ${holds.snapshot().holds} holds).`);
          } else {
            if (recommendations.length > 0) {
              lines.push("");
              lines.push("Threshold & pattern recommendations:");
              for (const rec of recommendations.slice(0, 5)) {
                lines.push(`  [${rec.priority}] ${rec.message}`);
              }
            }
            
            if (steerReport.suggestions.length > 0) {
              lines.push("");
              lines.push("Steer effectiveness:");
              lines.push(`  Overall effectiveness: ${(steerReport.overall * 100).toFixed(0)}%`);
              for (const suggestion of steerReport.suggestions.slice(0, 3)) {
                lines.push(`  ${suggestion}`);
              }
            }
            
            if (Object.keys(steerReport.byType).length > 0) {
              lines.push("");
              lines.push("Effectiveness by type:");
              for (const [type, stats] of Object.entries(steerReport.byType)) {
                lines.push(`  ${type}: ${(stats.rate * 100).toFixed(0)}% (${stats.effective}/${stats.total})`);
              }
            }
            
            if (steerReport.topPatterns.length > 0) {
              lines.push("");
              lines.push("Top performing patterns:");
              for (const pattern of steerReport.topPatterns.slice(0, 3)) {
                lines.push(`  ${pattern.pattern}: ${(pattern.effectiveness * 100).toFixed(0)}% effectiveness (${pattern.sampleSize} samples)`);
              }
            }
          }
          
          report(lines.join("\n"));
          return;
        }
        if (action === "enable") {
          if (config.backendRefusal !== undefined) { report(`Cannot enable judgments: typesafeBackend refused: ${config.backendRefusal} Fix the value in ${userConfigPath(dirs)}, then run /warden enable again.`, "warning"); return; }
          const backend = config.typesafeBackend;
          if (!ctx.hasUI) { report(`Consent needs an interactive session. For headless runs set PI_WARDEN_ENABLED=1 and ${resolveBackend(backend).keyEnv} explicitly.`, "warning"); return; }
          // For a non-TypeSafe backend the dialog names who answers: the label, host, and model sent.
          const consentText = backend === undefined || backend === "typesafe"
            ? disclosure
            : `Judgments go to ${describeBackend(backend)}. ${disclosureFor(backend, disclosure)}`;
          if (!await ctx.ui.confirm("Enable TypeSafe judgments for pi-warden?", consentText)) return;
          // One flow: consent, then a key if none is configured yet. TypeSafe prompts, verifies, and stores the key for every
          // pi-typesafe consumer; any other backend has no login, so a missing key is reported with the variable to set.
          const key = await ensureApiKey(ctx, backend === undefined ? {} : { backend });
          if (!key) { report("No key entered; pi-warden stays on pattern checks only. Run /warden enable again when you have a key from console.typesafe.ai.", "warning"); return; }
          const path = setUserSetting("typesafe", true, dirs);
          client = undefined;
          budgetExhausted = false;
          report(`TypeSafe judgments enabled and saved to ${path}${key.login ? `; key verified (${key.login.models} model${key.login.models === 1 ? "" : "s"}) and stored at ${key.login.path}` : ` using the ${key.source === "stored" ? "stored key" : `key from ${resolveBackend(config.typesafeBackend).keyEnv}`}`}. This stays on in new sessions until /warden disable.`);
          return;
        }
        if (action === "disable") {
          const path = setUserSetting("typesafe", false, dirs);
          report(`TypeSafe judgments disabled in ${path}. Offline pattern checks stay active; set enabled to false there to turn pi-warden off entirely.`);
          return;
        }
        if (action === "mode") {
          if (!isMode(argument)) { report(`Mode is ${activeMode(config, ctx.hasUI)}${process.env.PI_WARDEN_MODE ? " (from PI_WARDEN_MODE)" : ""}. Use /warden mode steer | confirm | advise. steer holds risky calls and tells the agent why; confirm asks you with a dialog; advise only reports.`); return; }
          const path = setUserSetting("mode", argument, dirs);
          report(`Mode set to ${argument} in ${path}.`);
          return;
        }
        if (action === "config") {
          // A bare "set" or "get" is an incomplete command, not a request for the panel; tell the user rather than opening it.
          if (tail === "set" || tail === "get") { report("Usage: /warden config set <key> <value> or /warden config get <key>", "warning"); return; }
          if (tail.startsWith("set ")) {
            const rest = tail.slice(4).trim();
            const spaceIndex = rest.indexOf(" ");
            if (spaceIndex === -1) { report("Usage: /warden config set <key> <value>", "warning"); return; }
            const keyPath = rest.slice(0, spaceIndex).trim();
            const rawValue = rest.slice(spaceIndex + 1).trim();
            const value = parseConfigValue(rawValue);
            const current = readUserConfig(dirs);
            const updated = setNestedValue(current as Record<string, unknown>, keyPath, value);
            const savedPath = writeUserConfig(updated, dirs);
            client = undefined;
            report(`Saved ${keyPath} = ${JSON.stringify(value)}.`);
            return;
          }
          if (tail.startsWith("get ")) {
            const keyPath = tail.slice(4).trim();
            const current = readUserConfig(dirs);
            const value = getNestedValue(current as Record<string, unknown>, keyPath);
            const defaultValue = getNestedValue(defaultConfig() as unknown as Record<string, unknown>, keyPath);
            report(value === undefined ? `${keyPath} not set (default: ${JSON.stringify(defaultValue)})` : `${keyPath} = ${JSON.stringify(value)}`);
            return;
          }
          if (!ctx.hasUI || !lastUi) { report(`Edit ${userConfigPath(dirs)} directly. Use /warden config set <key> <value> for quick changes.`); return; }
          toggleConfigPanel(lastUi, config);
          return;
        }
        if (action === "init") {
          const targetPath = join(ctx.cwd, "pi-warden.md");
          const force = argument === "--force";
          if (existsSync(targetPath)) {
            if (ctx.hasUI && !force) {
              if (!await ctx.ui.confirm("pi-warden.md already exists. Overwrite with a fresh starter template?", `This replaces ${targetPath} with a generic starter. Your current rules will be lost.`)) {
                report("Cancelled. Existing pi-warden.md unchanged.");
                return;
              }
            } else if (!force) {
              report(`pi-warden.md already exists at ${targetPath}. Pass --force to overwrite.`, "warning");
              return;
            }
          }
          const prompt = buildInitPrompt(ctx.cwd);
          initRunning = true;
          if (ctx.hasUI) ctx.ui.notify("pi-warden: Generating rules file...", "info");
          try {
            // sendUserMessage throws when the agent is not idle. Brief wait so a
            // just-closing confirm dialog does not cause a race.
            for (let attempt = 0; attempt < 40; attempt++) {
              if (ctx.isIdle()) break;
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            pi.sendUserMessage(prompt);
            await ctx.waitForIdle();
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            report(`pi-warden init failed: ${detail}. Try creating pi-warden.md manually.`, "error");
          } finally {
            initRunning = false;
          }
          const wardenExists = existsSync(join(ctx.cwd, "pi-warden.md"));
          report(wardenExists ? "pi-warden.md created. Review the rules and edit as needed." : "Agent did not create pi-warden.md. Create it manually or try /warden init again.");
          return;
        }
        if (action === "audit") {
          if (!ctx.hasUI) { report("Audit needs an interactive session to run.", "warning"); return; }
          if (!await ctx.ui.confirm("Run workspace audit?", `This runs an agent-driven audit of ${redact(ctx.cwd)}. It uses the session model, reads source code, and writes a report. It may take several minutes and use real tokens. Measured comparisons need the agent's TypeSafe tool, which is enabled per session with \`/typesafe enable\`; without it findings will be marked unmeasured.`)) return;
          const projects = findProjects(ctx.cwd);
          const prompt = buildAuditPrompt(ctx.cwd, projects);
          const reportPath = join(ctx.cwd, ".pi-warden", "audit-report.html");
          const preSnapshot = snapshotReport(reportPath);
          auditRunning = true;
          if (ctx.hasUI) ctx.ui.notify("pi-warden: Running workspace audit...", "info");
          try {
            for (let attempt = 0; attempt < 40; attempt++) {
              if (ctx.isIdle()) break;
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            pi.sendUserMessage(prompt);
            await ctx.waitForIdle();
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            report(`pi-warden audit failed: ${detail}.`, "error");
          } finally {
            auditRunning = false;
          }
          const outcome = reportOutcome(preSnapshot, snapshotReport(reportPath));
          switch (outcome) {
            case "written": report(`Audit report written to ${reportPath}`); break;
            case "stale": report("Audit finished but the report file was not updated — the agent may have reported findings in chat instead."); break;
            case "missing": report("Agent did not write an audit report. The model may have reported findings in chat instead."); break;
          }
          return;
        }
        if (action === "test") {
          const judge = judgeFor(config);
          // For a non-TypeSafe backend the confirmation names who answers: the label, host, and model sent.
          const backend = config.typesafeBackend;
          const destination = backend === undefined || backend === "typesafe" ? backendHost(backend) : describeBackend(backend);
          if (judge && ctx.hasUI && !await ctx.ui.confirm("Send one synthetic pi-warden test request?", `A synthetic action ("rm -rf /var/tmp/pi-warden-demo" for the task "Prepare the demo environment") goes to ${destination} and may incur charges. ${disclosureFor(config.typesafeBackend, disclosure)}`)) return;
          const verdict = await evaluateAction(
            { tool: "bash", input: { command: "rm -rf /var/tmp/pi-warden-demo" }, cwd: ctx.cwd, task: "Prepare the demo environment" },
            { config: { ...config.action, enabled: true, tools: ["bash"] }, judge, rules: config.rules },
          );
          const deliveryVerdict = ctx.hasUI ? verdict : agentDeliveryVerdict(verdict);
          const deliveryReasons = deliveryVerdict.reasons;
          const fmt = formatVerdictTokens(verdict, config.widget.action);
          record(ctx, config, "action", fmt.line, actionDetails(verdict, { mode: activeMode(config, ctx.hasUI) }), fmt.tokens);
          const deliveryTokens = actionTokens(deliveryVerdict);
          report(`${renderTemplate(DEFAULT_TEMPLATES.action, deliveryTokens)}${deliveryReasons.length ? ` — ${deliveryReasons.join("; ")}` : ""}${judge ? "" : " (pattern checks only: TypeSafe judgments are not enabled or no key is configured)"}${verdict.error ? ` — ${verdict.error}` : ""}`);
          if (verdict.level === "confirm") {
            const mode = activeMode(config, ctx.hasUI);
            if (mode === "confirm" && ctx.hasUI) {
              const allowed = await ctx.ui.confirm("warden: allow this bash call? (demo)", `${confirmMessage(verdict)}\n\nThis is /warden test: nothing runs either way.`);
              report(allowed ? "Demo: you chose Yes, so a real call would have run." : "Demo: you chose No, so a real call would have been blocked and the agent told why.");
            } else {
              report(`In ${mode} mode a real call would ${mode === "advise" ? "run with this warning shown to you" : "be held and the agent would read"}: "${steerReason(deliveryVerdict, { canApprove: judge !== undefined })}"`);
            }
          }
          return;
        }
        if (action === "index") {
          if (!ctx.hasUI) { report("Index needs an interactive session to run.", "warning"); return; }
          // The snapshot from Pi is authoritative; cachedSkills is only filled by before_agent_start.
          let skillsForIndex: Array<{ name: string; description: string; filePath: string }> = [];
          try {
            const snapshot = (ctx as ExtensionCommandContext).getSystemPromptOptions().skills;
            if (snapshot && snapshot.length > 0) {
              skillsForIndex = snapshot.filter(s => !s.disableModelInvocation).map(s => ({ name: s.name, description: s.description, filePath: s.filePath ?? "" }));
            }
          } catch (err) {
            record(ctx, config, "conscience", `snapshot unavailable: ${err instanceof Error ? err.message : String(err)}`, ["trigger: warden_index"]);
          }
          if (skillsForIndex.length === 0 && cachedSkills.length > 0) {
            skillsForIndex = cachedSkills.filter(s => !(s as { disableModelInvocation?: boolean }).disableModelInvocation).map(s => ({ name: s.name, description: s.description, filePath: s.filePath ?? "" }));
          }
          if (skillsForIndex.length === 0) {
            report("No skills available. Run a prompt first so Pi discovers installed skills, then retry /warden index.", "warning");
            return;
          }
          let toolCount = 0;
          try { toolCount = pi.getAllTools().length; } catch { toolCount = 0; }
          const roughBytes = skillsForIndex.length * 200 + toolCount * 100;
          if (!await ctx.ui.confirm(
            "Build capability index?",
            `This reads every installed skill file (${skillsForIndex.length} skills) and tool description (${toolCount} tools, ~${roughBytes} bytes total) and runs the session model to produce index entries. It may take a minute and use real tokens.`,
          )) return;
          let toolInfosForIndex: Array<{ name: string; description: string }> = [];
          try { toolInfosForIndex = pi.getAllTools().map((t: { name: string; description: string }) => ({ name: t.name, description: t.description })); } catch { toolInfosForIndex = []; }
          const globalPath = indexPath("global", undefined, undefined, dirs);
          const projectPath = indexPath("project", ctx.cwd, undefined, dirs);
          ensureIndexDir("global", undefined, dirs);
          ensureIndexDir("project", undefined, dirs);
          const prompt = buildIndexPrompt(ctx.cwd, skillsForIndex, toolInfosForIndex, { global: globalPath, project: projectPath }, dirs);
          // Snapshot files before the model runs so we can detect whether it wrote anything.
          const snap = (p: string) => { try { const s = statSync(p); return { exists: true as const, mtimeMs: s.mtimeMs }; } catch { return { exists: false as const, mtimeMs: 0 }; } };
          const preGlobal = snap(globalPath);
          const preProject = snap(projectPath);
          indexRunning = true;
          indexWritePaths = [pathResolve(globalPath), pathResolve(projectPath)];
          if (ctx.hasUI) ctx.ui.notify("pi-warden: Building capability index...", "info");
          try {
            for (let attempt = 0; attempt < 40; attempt++) {
              if (ctx.isIdle()) break;
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            pi.sendUserMessage(prompt);
            await ctx.waitForIdle();
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            report(`pi-warden index failed: ${detail}.`, "error");
            indexRunning = false;
            indexWritePaths = [];
            return;
          } finally {
            indexRunning = false;
            indexWritePaths = [];
          }
          const postGlobal = snap(globalPath);
          const postProject = snap(projectPath);
          const globalChanged = !preGlobal.exists || postGlobal.mtimeMs > preGlobal.mtimeMs;
          const projectChanged = !preProject.exists || postProject.mtimeMs > preProject.mtimeMs;
          if (!globalChanged && !projectChanged) {
            report("The model did not write the index; nothing was changed.", "warning");
            return;
          }
          const rawGlobal = readIndex(globalPath);
          const rawProject = readIndex(projectPath);
          // Accept both the full format and entries-only; warden always writes the final metadata.
          let globalResult = rawGlobal ? validateIndex(rawGlobal) : { file: undefined, rejections: [] };
          let projectResult = rawProject ? validateIndex(rawProject) : { file: undefined, rejections: [] };
          // Entries-only fallback: read raw JSON and extract entries array
          if (!globalResult.file && rawGlobal) {
            try {
              const parsed = JSON.parse(readFileSync(globalPath, "utf8")) as unknown;
              if (parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)) {
                globalResult = validateIndex({ formatVersion: 1, builtAt: "", model: "", entries: (parsed as { entries: unknown }).entries });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!msg.includes("ENOENT")) record(ctx, config, "conscience", `global entries-only parse: ${msg}`, ["trigger: warden_index"]);
            }
          }
          if (!projectResult.file && rawProject) {
            try {
              const parsed = JSON.parse(readFileSync(projectPath, "utf8")) as unknown;
              if (parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)) {
                projectResult = validateIndex({ formatVersion: 1, builtAt: "", model: "", entries: (parsed as { entries: unknown }).entries });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // ENOENT is normal (no project index yet); only trace actual parse errors
              if (!msg.includes("ENOENT")) record(ctx, config, "conscience", `project entries-only parse: ${msg}`, ["trigger: warden_index"]);
            }
          }
          // Collect rejections from both files
          const allRejections: string[] = [];
          if (rawGlobal && !globalResult.file) allRejections.push(...globalResult.rejections.map(r => `global index: entry ${r}`));
          if (rawProject && !projectResult.file) allRejections.push(...projectResult.rejections.map(r => `project index: entry ${r}`));
          if (allRejections.length > 0) {
            report(`Index rejected:\n${allRejections.map(r => `  ${r}`).join("\n")}\nOld files kept.`, "warning");
            return;
          }
          const validatedGlobal = globalResult.file;
          const validatedProject = projectResult.file;
          // Recompute sourceHash from actual skill files; the model's hash is untrusted.
          const recomputeHashes = (file: IndexFile) => {
            for (const entry of file.entries) {
              if (entry.kind === "skill") {
                const skill = skillsForIndex.find(s => s.name === entry.name);
                if (skill?.filePath) entry.sourceHash = fileContentHash(skill.filePath);
              }
            }
          };
          if (validatedGlobal) recomputeHashes(validatedGlobal);
          if (validatedProject) recomputeHashes(validatedProject);
          const realModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
          const builtAt = new Date().toISOString();
          const buildFile = (file: IndexFile): IndexFile => ({ formatVersion: 1, builtAt, model: realModel, entries: file.entries });
          if (validatedGlobal) writeIndex(globalPath, buildFile(validatedGlobal));
          if (validatedProject) writeIndex(projectPath, buildFile(validatedProject));
          globalIndexFile = validatedGlobal;
          projectIndexFile = validatedProject;
          // Report
          const globalStats = validatedGlobal ? indexStats(validatedGlobal) : { globalEntries: 0, projectEntries: 0, thinSources: [], truncatedCount: 0, sourceQualityReport: [] };
          const projectStats = validatedProject ? indexStats(validatedProject) : { globalEntries: 0, projectEntries: 0, thinSources: [], truncatedCount: 0, sourceQualityReport: [] };
          const totalEntries = globalStats.globalEntries + projectStats.projectEntries;
          const allThin = [...globalStats.thinSources, ...projectStats.thinSources];
          const totalTruncated = globalStats.truncatedCount + projectStats.truncatedCount;
          const lines = [
            `Index built: ${totalEntries} entries (${globalStats.globalEntries} global, ${projectStats.projectEntries} project).`,
            allThin.length ? `Thin sources: ${allThin.join(", ")}.` : undefined,
            totalTruncated ? `${totalTruncated} truncated at bullet boundary.` : undefined,
          ].filter(Boolean);
          const qualityReport = [...globalStats.sourceQualityReport, ...projectStats.sourceQualityReport]
            .sort((a, b) => (a.sourceQuality === "thin" ? 0 : 1) - (b.sourceQuality === "thin" ? 0 : 1));
          if (qualityReport.length === 0) {
            lines.push("", "Every description states when to use it.");
          } else {
            lines.push("", "These descriptions would recommend better with a rewrite:");
            const shown = qualityReport.slice(0, 25);
            for (const q of shown) {
              lines.push(`  ${q.name} (${q.kind}): ${q.improve}`);
            }
            if (qualityReport.length > 25) {
              lines.push(`  ... and ${qualityReport.length - 25} more.`);
            }
          }
          report(lines.join("\n"));
          return;
        }
        report(`Unknown action "${action}". Use: ${actions.join(", ")}.`, "warning");
      } catch (error) {
        report(error instanceof Error ? error.message : "pi-warden command failed.", "error");
      }
    },
  });
}
