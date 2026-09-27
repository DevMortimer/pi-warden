/** Types for scripts/rules-replay.mjs. */
import type { RuleSet, RulesOptions, RulesTarget, RulesVerdict } from "../src/rules.js";
import type { RulesConfig, WardenConfig } from "../src/config.js";

export declare const SAMPLE_SEED: number;

export interface ReplayArgs {
  project?: string | undefined;
  since?: string | undefined;
  max?: number | undefined;
  budget: number;
  out?: string | undefined;
  dryRun: boolean;
  score?: string | undefined;
}

/** The slice of pi-warden's API the replay drives; the CLI supplies dist/, tests supply src/. */
export interface ReplayLib {
  defaultConfig(): WardenConfig;
  RuleStore: new () => RuleStore;
  projectPath(target: string, cwd: string): string | undefined;
  describeTarget(tool: string, input: Record<string, unknown>, cwd: string): RulesTarget | undefined;
  skipReason(target: RulesTarget | undefined, set: RuleSet | undefined, config: RulesConfig): string | undefined;
  evaluateRules(tool: string, input: Record<string, unknown>, options: RulesOptions): Promise<RulesVerdict>;
  redact(text: string): string;
}

interface RuleStore {
  load(cwd: string, config: Pick<RulesConfig, "files" | "fallback" | "maxChars">): RuleSet | undefined;
}

export interface ReplayDeps {
  lib: ReplayLib;
  /** Supplies the judge for a real run; a dry run never calls it. */
  createJudge?: (options: { maxRequests: number; timeoutMs: number }) => unknown;
  log?: (line: string) => void;
  /** Session logs (default: PI_SESSIONS_DIR, then ~/.pi/agent/sessions). */
  sessionsDir?: string;
}

export interface ReviewItem {
  n: number;
  kind: "flagged" | "unflagged";
  tool: "write" | "edit";
  /** Project-relative path. */
  file: string;
  rule: string;
  score: number;
  excerpt: string;
  label: "" | "real" | "false-alarm" | "unsure";
  alsoRules?: string[];
}

export interface ReviewSheet {
  generated: string;
  seed: number;
  labels: Record<string, string>;
  items: ReviewItem[];
}

export interface ReplayAggregates {
  date: string;
  project: string;
  sessions: number;
  calls: Record<string, number>;
  unrebuiltReasons: Record<string, number>;
  skippedReasons: Record<string, number>;
  flaggedPerRule: Record<string, number>;
  requests: { budget: number; spent: number; planned?: number };
  labels: string;
  usage?: unknown;
  wallMs: number;
}

export interface LabelTally {
  items: number;
  real: number;
  "false-alarm": number;
  unsure: number;
  unlabelled: number;
  decided: number;
}

export interface SheetScore {
  flagged: LabelTally & { precision: number };
  unflagged: LabelTally & { missRate: number };
}

export declare function parseArgs(argv: readonly string[]): ReplayArgs;
export declare function sample<T>(items: readonly T[], n: number, seed?: number): T[];
export declare function scoreSheet(sheet: Pick<ReviewSheet, "items">): SheetScore;
export declare function main(argv: readonly string[], deps: ReplayDeps): Promise<
  { scored: SheetScore } | { aggregates: ReplayAggregates; sheet: ReviewSheet; out?: string }
>;
