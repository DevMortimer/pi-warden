/** Types for eval/judge-bench/arms.mjs. `lib` is pi-warden's public API (src/index.ts or dist/index.js). */
import type { BenchCase } from "./cases.mjs";

export interface BenchRequest {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}

export interface BenchArms {
  A: BenchRequest;
  B: BenchRequest;
  C: BenchRequest;
  /** stuck: set when the real guard decides the window in code, before any request. */
  codeDecided?: string;
  /** done: whether the run reaches the judge under the real gate. */
  reached?: boolean;
}

export declare function headTail(text: string, head: number, tail: number): string;
export declare function fileType(path: string): "code" | "test" | "doc" | "config" | "other";
export declare function buildArms(lib: unknown, c: BenchCase): BenchArms;
