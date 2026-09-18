/** Types for eval/check.mjs. */

export interface Violation {
  id: string;
  file: string;
  line: number;
  excerpt: string;
}

export declare function violations(projectDir: string): Violation[];
export declare function violationCounts(list: readonly Violation[]): Record<string, number>;
