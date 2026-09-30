import { defaultConfig } from "../src/config.js";
import type { ActionGuardConfig } from "../src/config.js";

/**
 * The action config a test uses when its subject is not the spend cut: every call reaches the judge, the acting request
 * carries the full state and the trace-only questions, and no verdict is reused.
 *
 * The shipped default turns all three on (the ask gate, the lean request, the reuse window); `tests/action-cut.test.ts`
 * covers those, and its tests use `defaultConfig().action` unchanged.
 */
export function judgedAction(overrides: Partial<ActionGuardConfig> = {}): ActionGuardConfig {
  return { ...defaultConfig().action, ask: { enabled: false }, cacheMinutes: 0, traceSample: 0, leanRequest: false, ...overrides };
}
