/** Types for eval/cost.mjs. */

import type { PriceWindow } from "./config.mjs";

export interface SessionCall {
  at: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface CallCost extends SessionCall {
  atIso: string | null;
  window: PriceWindow | null;
  usd: number | null;
}

export interface RunCost {
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; turns: number };
  jev: { requests: number; inputTokens: number; outputTokens: number; unreadable?: boolean };
  agentUsd: number | null;
  jevUsd: number | null;
  usd: number | null;
  jevUnknown?: boolean;
  reason?: string;
  windows?: Record<string, { calls: number; usd: number }>;
}

export function sessionCalls(events: unknown[]): SessionCall[];
export function sessionTokens(events: unknown[]): RunCost["tokens"];
export function jevUsage(agentDir: string): RunCost["jev"];
export function jevDollars(jev: RunCost["jev"]): number;
export function callCosts(events: unknown[], model: string): CallCost[];
export function runCost(input: { events: unknown[]; agentDir: string; model: string }): RunCost;
