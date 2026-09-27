/** Types for eval/rules-bench/turn.mjs. */
import type { Judge } from "pi-typesafe";
import type { RulesConfig, WardenConfig } from "../../src/config.js";
import type { Rule, RuleSet, RulesVerdict } from "../../src/rules.js";
import type { SnapshotResult, TurnRunOptions, TurnRunResult } from "../../src/turn-rules.js";

export interface BenchRow {
  id: string;
  source: "turn" | "shell";
  rule: string;
  split: string;
  label: string;
  kind: string;
  verdictSource: string;
  outcome?: string;
  violation?: number;
}

export interface BenchArgs {
  dryRun: boolean;
  split: string;
  only: string;
  concurrency: number;
  budget?: number | undefined;
  out?: string | undefined;
  timeout: number;
  rescore?: string | undefined;
}

export interface BenchLib {
  defaultConfig: () => WardenConfig;
  parseRules: (markdown: string) => Rule[];
  RuleStore: new () => { load: (cwd: string, config: Pick<RulesConfig, "files" | "fallback" | "maxChars">) => RuleSet | undefined };
  snapshotTree: (cwd: string) => Promise<SnapshotResult>;
  evaluateTurnRules: (task: string, diff: string, rules: readonly Rule[], options: { judge: Judge; config: RulesConfig; timeoutMs: number; sources: readonly string[] }) => Promise<RulesVerdict>;
  evaluateTurnRun: (options: TurnRunOptions) => Promise<TurnRunResult>;
}

export interface BenchDeps {
  lib: BenchLib;
  createJudge: (options: { maxRequests: number; timeoutMs: number }) => Judge & { getUsage?: () => unknown };
  log?: (line: string) => void;
}

export declare function parseArgs(argv: string[]): BenchArgs;
export declare function tables(rows: readonly BenchRow[]): string;
export declare function main(argv: string[], deps: BenchDeps): Promise<{ sent: number; planned?: number; wallMs?: number; rescored?: boolean }>;
