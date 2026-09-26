/** Types for eval/judge-bench/score.mjs. */

export declare const APPLIES_THRESHOLD: number;
export declare function signTest(better: number, worse: number): number;
export declare function predict(
  c: { guard: "stuck" | "done" },
  answers: Record<string, unknown>,
  meta: { codeDecided?: string; reached?: boolean },
  t: { sameStrategy: number; claimsDone: number; applies: number },
): { flag: boolean; p: number };
