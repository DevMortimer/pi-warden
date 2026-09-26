/** Types for eval/judge-bench/run.mjs. */

export interface RunDeps {
  lib: unknown;
  createJudge: (options: { maxRequests: number; timeoutMs: number }) => unknown;
  ask: (judge: unknown, request: unknown, options: { timeoutMs: number }) => Promise<{ ok: boolean; answers?: Record<string, unknown>; model?: string; errorCode?: string }>;
  log?: (line: string) => void;
}

export declare function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  repeats: number;
  concurrency: number;
  budget: number | undefined;
  out: string | undefined;
  seed: number;
  timeout: number;
  rescore: string | undefined;
};

export declare function main(argv: readonly string[], deps: RunDeps): Promise<{ sent: number; planned?: number; wallMs?: number; rescored?: boolean }>;
