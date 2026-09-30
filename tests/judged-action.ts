import { defaultConfig } from "../src/config.js";
import type { ActionGuardConfig } from "../src/config.js";

/**
 * The action config a test uses when its subject is not the spend cut: the ask gate is off, so every call reaches the
 * judge, and no trace-only sample rides a second request.
 *
 * The shipped default turns the ask gate and the trace-only sample on; `tests/action-cut.test.ts` covers those.
 */
export function judgedAction(overrides: Partial<ActionGuardConfig> = {}): ActionGuardConfig {
  return { ...defaultConfig().action, ask: { enabled: false }, traceSample: 0, ...overrides };
}
