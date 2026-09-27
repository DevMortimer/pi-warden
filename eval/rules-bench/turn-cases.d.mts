/** Types for eval/rules-bench/turn-cases.mjs. */

export interface TurnCase {
  id: string;
  split: "tune" | "holdout";
  label: "violation" | "clean";
  kind: "violation" | "near-miss" | "not-applicable";
  rule: string;
  task: string;
  diff: string;
}

export interface ShellCase {
  id: string;
  split: "tune" | "holdout";
  label: "violation" | "clean";
  kind: "violation" | "near-miss" | "not-applicable";
  rule: string;
  path: string;
  task: string;
  files: Record<string, string>;
  command: string;
}

export declare const TURN_RULES_FIXTURE: string;
export declare const SHELL_RULES_FIXTURE: string;
export declare const SEED_DIR: string;
export declare const SPLITS: string[];
export declare const KINDS: string[];
export declare const CUTOFFS: number[];
export declare const TURN_CASES: TurnCase[];
export declare const SHELL_CASES: ShellCase[];
export declare function loadTurnCases(): TurnCase[];
export declare function loadShellCases(): ShellCase[];
export declare function ruleIds(fixture: string): string[];
