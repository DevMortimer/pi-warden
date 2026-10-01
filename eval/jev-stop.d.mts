/** Types for eval/jev-stop.mjs. */

export function ledgerCounts(agentDir: string): { started: number; succeeded: number; failed: number };
export function abandonedJevRequests(agentDir: string): number;
export function jevFailure(input: { agentDir: string; traceDir: string; killed?: boolean }): string | null;
