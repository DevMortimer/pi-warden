/** Types for scripts/prune-dist.mjs. */

/**
 * Delete every file under `outDir` that is not the output of a current source under `sourceDir`.
 * Returns the deleted paths, relative to `outDir`, sorted.
 */
export declare function pruneDist(sourceDir: string, outDir: string): string[];
