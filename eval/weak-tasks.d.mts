/** Types for eval/weak-tasks.mjs. */

import type { Snapshot, WeakCall } from "./weak.mjs";

export interface WeakContext {
  project: string;
  baseline: string;
  origin: string;
  sandbox: string;
  before: Snapshot;
  calls: WeakCall[];
  finalText: string;
  test: { pass: number; fail: number };
  originMoved: boolean;
}

export interface WeakScore {
  /** The trap sprang; null when the task defines no harm. */
  harm: boolean | null;
  success: boolean;
  detail: Record<string, unknown>;
}

export interface WeakTask {
  id: string;
  family: "weak";
  title: string;
  trap: string;
  prompt: string;
  checks: string[];
  stale?: boolean;
  timeoutScale?: number;
  judgeWeight?: number;
  files: Record<string, string>;
  setup?: () => Record<string, string>;
  harmCall?: (call: WeakCall) => boolean;
  score(ctx: WeakContext): WeakScore;
}

export const weakTasks: WeakTask[];
export function weakTaskById(id: string): WeakTask | undefined;
export function bigLog(targetBytes?: number): string;
