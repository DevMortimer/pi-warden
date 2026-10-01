/** Types for eval/batch.mjs. */

export const DEFAULT_SEED: number;
export const RETRY_DELAYS_MS: number[];
export const INFRA_STREAK_LIMIT: number;
export const EXCLUSION_LIMIT: number;

export interface Block {
  task: string;
  repeat: number;
  cells: string[];
  family?: string;
}

export interface BatchRun {
  task: string;
  cell: string;
  repeat: number;
  family?: string;
  infraError?: string;
  excludedBlock?: boolean;
  attempts?: number;
  infraRetries?: string[];
  [key: string]: unknown;
}

export interface BatchState {
  runs: BatchRun[];
  jevUsd: number;
  stops?: unknown[];
}

export interface BatchStop {
  kind: "jev-error" | "jev-cap" | "infra" | "interrupt";
  reason?: string;
  failures?: { task: string; cell: string; repeat: number; reason: string }[];
  [key: string]: unknown;
}

export interface AttemptResult {
  record?: BatchRun | null;
  infra?: string | null;
  jevError?: string | null;
  jevUsd?: number;
  aborted?: boolean;
  summary?: string;
}

export interface InfraCounts {
  perCell: Record<string, { runs: number; infraErrors: number; retriedOk: number; excludedRuns: number }>;
  excludedBlocks: number;
  plannedBlocks: number;
  share: number;
  inconclusive: boolean;
  providerErrorsRecovered: number;
  unknownJevCost: number;
}

export function seededRandom(seed: number): () => number;
export function shuffledCells(cells: string[], seed: number, taskId: string, repeat: number): string[];
export function blockOrder(input: { taskIds: string[]; cells: string[]; repeats: number; seed: number }): Block[];
export function firstRuns(blocks: Block[], count: number): Block[];
export function runKey(run: { task: string; cell: string; repeat: number }): string;
export function infraReason(events: unknown[], run?: { timedOut?: boolean; code?: number | null; err?: string; stalled?: boolean }): string | null;
export function recoveredErrors(events: unknown[]): number;
export function markExclusions(runs: BatchRun[]): BatchRun[];
export function metricRuns(runs: BatchRun[]): BatchRun[];
export function infraCounts(runs: BatchRun[], plannedBlocks: number): InfraCounts;
export function infraSection(runs: BatchRun[], plannedBlocks: number): string[];
export function runBatch(input: {
  blocks: Block[];
  state: BatchState;
  execute: (run: { task: string; cell: string; repeat: number; family?: string }, attempt: number) => Promise<AttemptResult>;
  persist?: (state: BatchState) => void;
  concurrency?: number;
  jevUsdCap?: number | null;
  total?: number;
  retryDelaysMs?: number[];
  streakLimit?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  control?: { stop: { kind: string } | null; streak: unknown[] };
}): Promise<{ stop: BatchStop | null }>;
