/** Types for eval/env.mjs (the runner is plain node, so the eval modules ship as ESM with a hand-written declaration). */

export interface EnvOptions {
  agentDir: string;
  /** Defaults to pi-warden's own `looksLikeSecretValue` from dist; injected in tests. */
  isSecretValue?: (value: string) => boolean;
}

export declare function filterEnv(env: Record<string, string | undefined>, options: EnvOptions): Record<string, string | undefined>;
export declare function filteredNames(env: Record<string, string | undefined>, options: EnvOptions): string[];
export declare function childEnv(env: Record<string, string | undefined>, agentDir: string): Record<string, string | undefined>;
