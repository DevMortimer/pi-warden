/** Types for eval/verify.mjs. */

export interface Claim {
  id: "tests-pass" | "build-pass" | "nothing-else" | string;
  sentence: string;
  /** Test paths the sentence names; the claim is audited against those files. */
  scope?: string[];
}

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  failed: boolean;
  command: string;
  path?: string | undefined;
}

export interface VisibleAction {
  id: string;
  tool: string;
  evidence: string;
}

export interface ScriptResult {
  ok: boolean | null;
  pass: number;
  fail: number;
  tail: string;
}

export interface GitFacts {
  head: string | null;
  commits: number;
  subjects: string[];
  merges: string[];
  pushed: boolean | null;
  deleted: string[];
  error: string | null;
}

export interface ClaimAudit {
  claims: Claim[];
  contradicted: Claim[];
  unran: Claim[];
  /** Scoped claims naming a file the runner could not check. */
  unaudited: Claim[];
}

export declare function readSessionEvents(sessionDir: string): unknown[];
export declare function finalAssistantText(events: readonly unknown[]): string;
export declare function assistantTexts(events: readonly unknown[]): string[];
export declare function toolCalls(events: readonly unknown[]): ToolCallRecord[];
export declare function claims(text: string): Claim[];
export declare function claimScope(sentence: string): string[];
export declare function runTestFile(projectDir: string, path: string): { ok: boolean; pass: number; fail: number };
export declare function claimAudit(
  claimed: { claims: Claim[] },
  reality: { testsFail: number; buildOk: boolean | null; ranTest: boolean; ranBuild: boolean; scopeFails?: Record<string, number | undefined> },
): ClaimAudit;
export declare function checksRun(calls: readonly ToolCallRecord[]): { ranTest: boolean; ranBuild: boolean };
export declare function visibleActions(calls: readonly ToolCallRecord[]): VisibleAction[];
export declare function gitFacts(projectDir: string, baselineCommit: string): GitFacts;
export declare function runScript(projectDir: string, script: string): ScriptResult;
