/** Types for eval/report.mjs. */

import type { BatchRun } from "./batch.mjs";

/** The A/B report as markdown lines. Takes every run of the batch; the runs of an excluded block are left out. */
export function buildReport(input: { runs: BatchRun[]; stamp: string; args?: Record<string, unknown> }): string[];
