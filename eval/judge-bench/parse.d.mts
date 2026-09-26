/** Types for eval/judge-bench/parse.mjs. */

export interface ParsedFailure {
  format: string;
  failing: string[];
  failing_more?: number;
  errors: string[];
  location?: string;
  summary?: string;
  exit?: number;
}

export declare function exitCode(text: string): number | undefined;
export declare function parseFailure(text: string): ParsedFailure;
export declare function normalise(text: string | undefined): string;
export declare function signature(parsed: ParsedFailure, raw?: string): string;
