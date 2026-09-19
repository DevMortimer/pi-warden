import type { ActionGuardConfig, SecurityConfig, SlopGuardConfig } from "./config.js";
import { evaluateAction, textApproves } from "./guard.js";
import type { PreviousAction, TaskMessage, Verdict } from "./guard.js";
import type { Judge, Questions } from "pi-typesafe";

/** One tool call as the agent proposed it. `id` is Pi's tool call id, stable across hooks and retries. */
export interface ToolCallRef {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** What the session says about the call: the latest user prompt, recent messages for scope, and the sibling calls of the same assistant message. */
export interface Conversation {
  task: string | undefined;
  /** Scope context only: approval still comes from `task`, never from this history. */
  context?: readonly TaskMessage[] | undefined;
  /** Tool calls in the same assistant message, this one included; they are judged together. */
  siblings?: readonly ToolCallRef[] | undefined;
  /** The agent's own words in that message (or its latest text under this prompt); shared by the siblings. Explains, never authorizes. */
  plan?: string | undefined;
}

export interface InspectOptions {
  config: ActionGuardConfig;
  cwd: string;
  /** Omit to run offline pattern checks only (no consent, no network). */
  judge?: Judge | undefined;
  signal?: AbortSignal | undefined;
  slop?: SlopGuardConfig | undefined;
  security?: SecurityConfig | undefined;
  /** Calls allowed in the previous turn; the regret question about them rides this call's request, never a sibling's. */
  previousActions?: readonly PreviousAction[] | undefined;
  /** Extra questions over the same state, answered in verdict.extra and never acted on. */
  questions?: Questions | undefined;
}

interface Prejudged { key: string; verdict: Promise<Verdict>; used: boolean }

/**
 * The Action guard for one session. `evaluateAction` judges a single call; this module owns what spans calls:
 *
 * - **Hold and approval.** After a hold in steer mode, the next guarded call that runs under a *new* user prompt asks Jev
 *   whether that prompt approves it. The retry rarely repeats the held string byte for byte (a `command -v` dropped, a
 *   different timeout), so approval is judged against the action itself, never matched against the earlier command text.
 *   A re-hold under the reply keeps the original reference prompt; otherwise the reply could never approve anything.
 *   Without a judge, a reply that reads as approval stands in for the question.
 * - **Sibling prejudging.** Calls of one assistant message are judged as soon as the first of them is inspected, so their
 *   requests go out together. A judgment is used once and only for the input it was made for; an earlier hook may have
 *   changed the call's input, and a stale judgment is discarded, not reused. Prejudgments do not outlive their turn.
 */
export class ActionGuard {
  private readonly prejudged = new Map<string, Prejudged>();
  private lastHoldPrompt: string | undefined;
  private holdPending = false;

  /** Judges one call. The verdict's `approvedByUser` means a pending hold was released by the user's reply. */
  async inspect(call: ToolCallRef, conversation: Conversation, options: InspectOptions): Promise<Verdict> {
    const { task } = conversation;
    // A hold happened under an earlier prompt and the user has since replied: ask whether the reply approves this action.
    const retryAfterHold = this.holdPending && this.lastHoldPrompt !== task;
    const judgeCall = (tool: string, input: Record<string, unknown>, previousActions?: readonly PreviousAction[]) => evaluateAction(
      { tool, input, cwd: options.cwd, task, context: conversation.context, plan: conversation.plan },
      { config: options.config, judge: options.judge, signal: options.signal, slop: options.slop, security: options.security, retryAfterHold, previousActions, questions: options.questions },
    );
    // A retry after a hold stays sequential because an approval consumed by one sibling changes the question for the next.
    if (options.judge && !retryAfterHold) {
      for (const sibling of conversation.siblings ?? []) {
        if (sibling.id === call.id || this.prejudged.has(sibling.id) || !options.config.tools.includes(sibling.tool)) continue;
        const verdict = judgeCall(sibling.tool, sibling.input);
        verdict.catch(() => undefined);
        this.prejudged.set(sibling.id, { key: JSON.stringify(sibling.input), verdict, used: false });
      }
    }
    const key = JSON.stringify(call.input);
    const ready = this.prejudged.get(call.id);
    const pending = ready && !ready.used && ready.key === key && !retryAfterHold ? ready.verdict : judgeCall(call.tool, call.input, options.previousActions);
    this.prejudged.set(call.id, { key, verdict: pending, used: true });
    const verdict = await pending;
    if (retryAfterHold && !options.judge && verdict.level === "confirm" && textApproves(task)) {
      verdict.level = "allow";
      verdict.approvedByUser = true;
      verdict.reasons = ["user approved in the latest message", ...verdict.reasons];
    }
    if (verdict.approvedByUser) this.holdPending = false;
    return verdict;
  }

  /** The call inspected under `task` was held: the next inspection under a different prompt asks whether that prompt approves it. */
  hold(task: string | undefined): void {
    if (!this.holdPending) this.lastHoldPrompt = task;
    this.holdPending = true;
  }

  /** Siblings that were never inspected (an earlier one terminated the batch, or Esc) do not outlive their turn. */
  turnEnd(): void {
    this.prejudged.clear();
  }

  reset(): void {
    this.prejudged.clear();
    this.lastHoldPrompt = undefined;
    this.holdPending = false;
  }
}
