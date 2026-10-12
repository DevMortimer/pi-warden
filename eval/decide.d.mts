/** Types for eval/decide.mjs. */

export const BOOTSTRAP_DRAWS: number;
export const BOOTSTRAP_SEED: number;
export const BOOTSTRAP_LOWER_INDEX: number;
export const BOOTSTRAP_UPPER_INDEX: number;
export const ALPHA: number;
export const Z_95: number;
export const TRAP_FAMILIES: string[];

export interface DecideOutcome {
  allChecksPass?: boolean;
  violationCount?: number;
}

export interface DecideCost {
  usd?: number;
  jevUnknown?: boolean;
  [key: string]: unknown;
}

export interface DecideRun {
  task: string;
  repeat: number;
  cell: string;
  family?: string;
  timedOut?: boolean;
  error?: string;
  outcome?: DecideOutcome;
  cost?: DecideCost;
  infraError?: string;
  excludedBlock?: boolean;
  [key: string]: unknown;
}

export interface RunValues {
  s: number;
  v: number;
  c: number | undefined;
}

export interface MetricsRow {
  task: string;
  family: string | null;
  repeat: number;
  cell: string;
  s: number;
  v: number;
  c: number | null;
}

export interface Pair {
  task: string;
  repeat: number;
  family?: string;
  x: DecideRun;
  y: DecideRun;
}

export interface Discordant {
  n11: number;
  n10: number;
  n01: number;
  n00: number;
  D: number;
}

export type Decision = "supported" | "refuted" | "inconclusive";
export type ModelDecision = "proven" | "refuted" | "part" | "inconclusive";

export interface BootstrapOptions {
  draws?: number;
  seed?: number;
  lowerIndex?: number;
  upperIndex?: number;
}

export interface BootstrapResult {
  lower: number;
  upper: number;
  sorted: number[];
}

export interface SuccessBounds {
  estimate: number;
  lower: number;
  upper: number;
  n: number;
}

export interface CostBounds {
  estimate: number | undefined;
  lower: number | undefined;
  upper: number | undefined;
  pairs: number;
  leftOut: number;
}

export interface WaldBounds {
  estimate: number;
  q: number;
  se: number;
  lower: number;
  upper: number;
  n: number;
}

export interface DeltaLogRatioBounds {
  estimate: number | undefined;
  lower: number | undefined;
  upper: number | undefined;
  se: number | undefined;
  n: number;
}

export interface RuleA extends SuccessBounds {
  rule: "a";
  decision: Decision;
}

export interface RuleB extends Discordant {
  rule: "b";
  rateRatio: number | undefined;
  p: number;
  lower: number | undefined;
  decision: Decision;
}

export interface RuleC extends CostBounds {
  rule: "c";
  decision: Decision;
}

export interface RuleD {
  rule: "d";
  success: SuccessBounds;
  violation: RuleB;
  decision: Decision;
}

export interface Thesis {
  model: ModelDecision;
  inconclusive: boolean;
  excludedBlocks: number;
  plannedBlocks: number | undefined;
  share: number;
  pairs: { control: number; offline: number };
  rules: { a: RuleA; b: RuleB; c: RuleC; d: RuleD };
  sensitivity: { waldA: WaldBounds; waldD: WaldBounds; deltaC: DeltaLogRatioBounds };
  secondary: { bTrap: RuleB; pairs: number };
}

export function runValues(run: DecideRun): RunValues;
export function metricsRows(runs: DecideRun[]): MetricsRow[];
export function runsFromMetrics(rows: MetricsRow[]): DecideRun[];
export function mean(values: number[]): number;
export function pairRuns(runs: DecideRun[], xCell: string, yCell: string): Pair[];
export function costPairs(pairs: Pair[]): Pair[];
export function countDiscordant(pairs: Pair[]): Discordant;
export function mcnemarP(n10: number, D: number): number;
export function binomUpperTail(x: number, n: number, p: number): number;
export function clopperPearsonLower(x: number, n: number, alpha?: number, tol?: number): number;
export function rateRatio(n11: number, n10: number, n01: number): number | undefined;
export function rateRatioLower(n11: number, n10: number, n01: number): number | undefined;
export function successDiffEstimate(pairs: Pair[]): number;
export function costRatioEstimate(pairs: Pair[]): number;
export function bootstrap(pairs: Pair[], estimate: (pairs: Pair[]) => number, options?: BootstrapOptions): BootstrapResult;
export function successBounds(pairs: Pair[], options?: BootstrapOptions): SuccessBounds;
export function costBounds(pairs: Pair[], options?: BootstrapOptions): CostBounds;
export function decisionA(pairs: Pair[], options?: BootstrapOptions): RuleA;
export function decisionB(pairs: Pair[]): RuleB;
export function decisionC(pairs: Pair[], options?: BootstrapOptions): RuleC;
export function decisionD(pairs: Pair[], options?: BootstrapOptions): RuleD;
export function waldBounds(pairs: Pair[]): WaldBounds;
export function deltaLogRatioBounds(pairs: Pair[]): DeltaLogRatioBounds;
export function thesisDecide(options?: { runs: DecideRun[]; plannedBlocks?: number; bootstrap?: BootstrapOptions }): Thesis;
