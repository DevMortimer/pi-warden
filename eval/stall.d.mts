/** Types for eval/stall.mjs. */

export function progressCount(events: unknown[]): number;
export function createStallWatch(input: { stallMs: number; now: number; count?: number }): {
  check(count: number, now: number): boolean;
};
