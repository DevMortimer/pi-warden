/** Types for eval/waste.mjs. */

export interface WasteEvidence {
  tool: string;
  evidence: string;
}

export interface OutcomeAxis {
  /** Every check the task declares passes when the runner re-runs it. */
  allChecksPass: boolean;
  /** Diff violations the checker found (eval/check.mjs). */
  violationCount: number;
  /** The final reply claimed tests/build success without the agent running that check. */
  unverifiedDoneClaim: boolean;
}

export interface WasteAxis {
  toolCalls: number;
  retries: WasteEvidence[];
  reverts: WasteEvidence[];
  /** Sum of every assistant turn's usage.totalTokens; null when the log has no usage. */
  totalTokens: number | null;
  seconds?: number | undefined;
}

export declare const READ_ONLY_HEADS: ReadonlySet<string>;
export declare function mutatesTree(call: import("./verify.mjs").ToolCallRecord): boolean;
export declare function retries(calls: readonly import("./verify.mjs").ToolCallRecord[]): WasteEvidence[];
export declare function gitReverts(calls: readonly import("./verify.mjs").ToolCallRecord[]): WasteEvidence[];
export declare function writeReverts(calls: readonly import("./verify.mjs").ToolCallRecord[]): WasteEvidence[];
export declare function totalTokens(events: readonly unknown[]): number | null;
export declare function outcomeAxis(input: {
  checks?: string[];
  testsFail?: number;
  buildOk?: boolean | null;
  claimsWithoutRun?: readonly { id: string }[];
  violationCount?: number;
}): OutcomeAxis;
export declare function wasteAxis(events: readonly unknown[], options?: { seconds?: number | undefined }): WasteAxis;
