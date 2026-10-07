/**
 * Cause-check: the sibling of the done-check.
 *
 * The done-check catches "done" with no check behind it. This one catches "the cause is X" with no check behind it: a
 * final reply that names a likely cause, or hands a check to a person, when no tool result in the run tested it. The
 * agent gets one follow-up turn: check it with its own tools and give the evidence, or say plainly that the cause is
 * unverified and why it cannot check it. An unchecked cause is remembered per project for a week; the same cause on
 * the same topic on a later day gets a stronger steer that names the earlier date.
 *
 * One offline pass runs first (`causePreFilter`), so a reply with no causal or hand-off wording costs no request.
 */
import { ask, choice, noul } from "pi-typesafe";
import type { IntegrationErrorCode, Judge } from "pi-typesafe";
import type { CauseGuardConfig } from "./config.js";
import { redact } from "./redact.js";
import { commandOf } from "./tools.js";
import { DEFAULT_TEMPLATES, causeTokens, renderTemplate } from "./widget.js";

/** P(checked) at or above which the stated cause counts as checked by the run. */
const CHECKED_AT = 0.5;

/** One tool call of the run, as the judge reads it: a redacted call and a short redacted output sample. */
export interface CauseActivity {
  calls: Array<{ call: string; output: string }>;
}

export function emptyCauseActivity(): CauseActivity {
  return { calls: [] };
}

const ACTIVITY_LIMIT = 12;
const ACTIVITY_CALL_CHARS = 200;
const ACTIVITY_OUTPUT_CHARS = 200;

/** Record one finished tool call: its redacted command or path, and a short redacted output sample. */
export function recordCauseActivity(activity: CauseActivity, tool: string, input: Record<string, unknown>, output?: string): void {
  const view = commandOf(tool, input);
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
  const call = view?.command ?? (path === undefined ? tool : `${tool} ${path}`);
  const sample = output === undefined ? "" : redact(output.replace(/\s+/g, " ").slice(0, ACTIVITY_OUTPUT_CHARS));
  activity.calls.push({ call: redact(call.length > ACTIVITY_CALL_CHARS ? `${call.slice(0, ACTIVITY_CALL_CHARS)}…` : call), output: sample });
  if (activity.calls.length > ACTIVITY_LIMIT) activity.calls.splice(0, activity.calls.length - ACTIVITY_LIMIT);
}

/** A cause named as likely or as fact: the wording that makes a final reply worth judging. */
const CAUSE_WORDING = /\b(?:probably|likely|presumably|perhaps|maybe|i suspect|suspect(?:ed)? (?:that|the|this|it)|seems? to|appears? to|the cause|root cause|caused by|due to|the reason|reasons? (?:is|are)|the (?:bug|issue|problem|error|failure|regression|alert|warning) (?:is|was|comes|lies)|introduced by|stems from|traces? (?:back )?to|must have been|someone (?:changed|deleted|renamed|broke|edited)|points? to)\b/i;

/** A check handed to a person: wording that asks someone else to inspect what the agent could inspect. */
const HAND_OFF_WORDING = /\b(?:ask (?:them|him|her|someone|the team|the user|whoever|the owner)|check with|confirm with|find out (?:from|whether|if)|have (?:them|someone|the team) (?:check|confirm|verify|look)|(?:could|can|would) you (?:check|confirm|verify|find out|look)|please (?:check|confirm|verify)|worth (?:checking|verifying|confirming)|not sure (?:who|whether|if))\b/i;

/**
 * The offline pre-filter: true when the final reply carries causal or hand-off wording, so a reply about results or
 * next steps sends no request. Deliberately broad: a Jev answer still decides, and a missed ask loses a real catch.
 */
export function causePreFilter(text: string): boolean {
  return CAUSE_WORDING.test(text) || HAND_OFF_WORDING.test(text);
}

export const causeQuestions = {
  states_cause: noul(
    "Does `final_message` state a cause, explanation, or diagnosis for a problem, as a likely cause or as a fact?",
    {
      true: "Yes: it names why something happened or what is wrong, for example a component, a change, a condition, or an action by someone.",
      false: "No: it only reports status or results, names remaining work, asks a question, or describes a plan.",
    },
  ),
  hands_off: noul(
    "Does `final_message` ask a person to check, confirm, or find out something that the agent could inspect with its own tools?",
    {
      true: "Yes: it asks someone else, such as the user, a colleague, or another team, to verify or investigate a fact the agent could query, read, or run itself.",
      false: "No: it asks only for a decision a person must make, reports what it checked, or states a cause.",
    },
  ),
  checked: noul(
    "Did `run` check the cause `final_message` states, with a tool result that directly tested it?",
    {
      true: "Yes: a tool result inspected the stated cause or its effect, so the cause rests on evidence from the run.",
      false: "No: no tool result in `run` inspected the stated cause; the reply only asserts it or asks someone else.",
    },
  ),
  topic: choice("What is the stated cause about?", {
    data: "Data, state, or a value in a store, file, or database",
    code: "The code, its logic, or a dependency",
    config: "Configuration or environment",
    infra: "Infrastructure, deployment, or a service",
    permissions: "Access, permissions, or credentials",
    other: "None of these, or no cause stated",
  }),
};

export interface CauseJudgment {
  statesCause: number;
  handsOff: number;
  checked: number;
  topic: string;
  model: string;
  elapsedMs: number;
}

/** One remembered unchecked cause. */
export interface CauseStoreRecord {
  summary: string;
  at: number;
}

/** Project-level memory of unchecked causes, keyed by topic. */
export interface CauseStore {
  /** The newest earlier cause on the same topic within the window, or undefined. */
  recall(projectRoot: string, topic: string, now: number, windowDays: number): Promise<CauseStoreRecord | undefined>;
  /** Remember one unchecked cause. */
  record(projectRoot: string, record: { topic: string; summary: string; at: number }): Promise<void>;
}

export interface CauseVerdict {
  /** The reply states or hands off a cause and no tool result in the run checked it. */
  unchecked: boolean;
  /** Short redacted summary of the stated cause, stored for repeats. */
  summary: string;
  topic: string;
  /** An earlier unchecked cause on the same topic inside the window. */
  previous?: CauseStoreRecord;
  reasons: string[];
  judgment?: CauseJudgment;
  error?: string;
  errorCode?: IntegrationErrorCode;
}

export interface CauseOptions {
  config: CauseGuardConfig;
  judge: Judge;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  store?: CauseStore | undefined;
  projectRoot?: string | undefined;
  now?: number | undefined;
}

export function buildCauseRequest(task: string | undefined, finalMessage: string, activity: CauseActivity) {
  return {
    state: {
      task: task?.trim() ? (task.trim().length > 1500 ? `${task.trim().slice(0, 1500)}…` : task.trim()) : "(no user request recorded in this session)",
      final_message: redact(finalMessage.length > 2000 ? `${finalMessage.slice(0, 2000)}…` : finalMessage),
      run: {
        tool_calls: activity.calls.map(call => ({ call: call.call, output: call.output || "(no output recorded)" })),
      },
    },
    questions: causeQuestions,
  };
}

function clip(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export async function evaluateCause(task: string | undefined, finalMessage: string, activity: CauseActivity, options: CauseOptions): Promise<CauseVerdict> {
  const summary = redact(clip(finalMessage));
  if (!options.config.enabled) return { unchecked: false, summary, topic: "other", reasons: [] };
  const result = await ask(options.judge, buildCauseRequest(task, finalMessage, activity), { timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
  if (!result.ok) return { unchecked: false, summary, topic: "other", reasons: [], error: result.error, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
  const judgment: CauseJudgment = {
    statesCause: result.answers.states_cause.noul,
    handsOff: result.answers.hands_off.noul,
    checked: result.answers.checked.noul,
    topic: result.answers.topic.choice,
    model: result.model,
    elapsedMs: result.elapsedMs,
  };
  const states = Math.max(judgment.statesCause, judgment.handsOff) >= options.config.claimsCause;
  const unchecked = states && judgment.checked < CHECKED_AT;
  const reasons: string[] = [];
  if (unchecked) {
    const stated = judgment.statesCause >= judgment.handsOff
      ? `states a cause (${judgment.statesCause.toFixed(2)})`
      : `hands a check to a person (${judgment.handsOff.toFixed(2)})`;
    reasons.push(`the final reply ${stated} and no tool result in the run checked it (checked ${judgment.checked.toFixed(2)})`);
  }
  const now = options.now ?? Date.now();
  let previous: CauseStoreRecord | undefined;
  if (unchecked) {
    const projectRoot = options.projectRoot;
    const store = options.store;
    if (store !== undefined && projectRoot !== undefined) {
      previous = await store.recall(projectRoot, judgment.topic, now, options.config.windowDays);
      // A store that answers outside the window cannot escalate; the guard owns the 7-day rule.
      if (previous !== undefined && now - previous.at > options.config.windowDays * 86_400_000) previous = undefined;
      await store.record(projectRoot, { topic: judgment.topic, summary, at: now });
    }
    if (previous !== undefined) reasons.push(`the same unchecked cause on topic ${judgment.topic} was recorded on ${day(previous.at)}`);
  }
  return { unchecked, summary, topic: judgment.topic, reasons, judgment, ...(previous !== undefined ? { previous } : {}) };
}

/** The follow-up for the agent: check the cause with its own tools, or say plainly that it is unverified. */
export function causeNudge(verdict: CauseVerdict): string {
  const base = "check it with your own tools (a query, a log, a file, or a command) and give the evidence, or say plainly that the cause is unverified and why you cannot check it";
  if (verdict.previous !== undefined) {
    return `pi-warden: the final reply states a cause that nothing in the run checked. You gave the same unchecked cause on ${day(verdict.previous.at)}. ${base[0]!.toUpperCase()}${base.slice(1)}.`;
  }
  return `pi-warden: the final reply states a cause that nothing in the run checked. ${base[0]!.toUpperCase()}${base.slice(1)}.`;
}

export function formatCause(verdict: CauseVerdict, template: string = DEFAULT_TEMPLATES.cause): string {
  return renderTemplate(template, causeTokens(verdict));
}
