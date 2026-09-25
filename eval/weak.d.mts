/** Types for eval/weak.mjs. */

export type Snapshot = Record<string, string>;

export interface WeakCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  command: string;
  path?: string | undefined;
  failed: boolean;
  /** Warden held the call, so it never ran. */
  held: boolean;
  result: string;
}

export interface Steer {
  afterCall: number;
  kind: string;
  text: string;
}

export interface TraceSummary {
  entries: number;
  guards: Record<string, number>;
  judgmentsOff: string[];
}

export function snapshot(dir: string): Snapshot;
export function snapshotDiff(before: Snapshot, after: Snapshot): { removed: string[]; changed: string[]; added: string[] };
export function fileCount(dir: string): number;
export function callsWithResults(events: unknown[]): WeakCall[];
export function steersInOrder(events: unknown[]): Steer[];
export function repeatedFailures(calls: Pick<WeakCall, "tool" | "input" | "failed">[]): number;
export function traceGuards(traceDir: string): TraceSummary;
export function judgedRequests(agentDir: string): number;
export function isBlue(value: string): boolean;
export function headerDeclarations(css: string): { prop: string; value: string }[];
export function buildWeakReport(input: { runs: Record<string, unknown>[]; stamp: string; args?: Record<string, unknown>; cap?: number | null }): string[];
