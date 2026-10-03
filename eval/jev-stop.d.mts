/** Types for eval/jev-stop.mjs. */

export function ledgerCounts(agentDir: string): { started: number; succeeded: number; failed: number };
export function abandonedJevRequests(agentDir: string): number;
export interface JevCheckInput { agentDir: string; traceDir: string; killed?: boolean; startedAt?: string; endedAt?: string }
export function traceFacts(traceDir: string): { judged: Array<{ at: number; offTask: boolean }>; failed: boolean };
export function cancelledTraceSample(input: { agentDir: string; traceDir: string; startedAt?: string; endedAt?: string }): boolean;
export function jevCheck(input: JevCheckInput): { failure: string | null; cancelledTraceSamples: number };
export function jevFailure(input: JevCheckInput): string | null;
