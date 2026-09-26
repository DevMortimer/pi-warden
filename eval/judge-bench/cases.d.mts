/** Types for eval/judge-bench/cases.mjs. */

export interface BenchCall {
  tool: string;
  failed: boolean;
  input: Record<string, unknown>;
  output: string;
}

export interface BenchCase {
  id: string;
  guard: "stuck" | "done";
  label: "stuck" | "progressing" | "done" | "not_done";
  category: string;
  format: string;
  source: "real-tool" | "authored";
  errorAt?: string;
  why: string;
  task: string;
  calls: BenchCall[];
  /** The agent's final message; done cases only. */
  final?: string;
}

export declare function loadCases(): BenchCase[];
