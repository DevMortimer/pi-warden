import { isMode } from "./config.js";
import type { WardenConfig } from "./config.js";
import { resolveBackend } from "./backend.js";
import { DEFAULT_TEMPLATES } from "./widget.js";

/** The config layout this extension build expects; compared with the loaded config module's CONFIG_SCHEMA. */
export const EXPECTED_SCHEMA = 7;

export interface ShapeResult {
  config: WardenConfig;
  /** Sections that were absent from the loaded config and are now disabled. Empty when the config was complete. */
  missing: string[];
}

const off = { enabled: false };
const proseOff = () => ({ ...off, audience: "technical", threshold: 1, trend: 3, minChars: 1 });

/**
 * `loadConfig()` always returns a complete object, yet live sessions crashed at `config.slop.prose.enabled` after a package
 * update. A partially updated module graph (extension from one version, config from another) is the only known way to get
 * there. Whatever the cause, a missing section disables that guard and is reported instead of throwing inside Pi's event loop.
 */
export function completeConfig(loaded: Partial<WardenConfig> | undefined): ShapeResult {
  const source = (loaded ?? {}) as Partial<WardenConfig>;
  const missing: string[] = [];
  const section = <K extends keyof WardenConfig>(key: K, fallback: WardenConfig[K]): WardenConfig[K] => {
    const value = source[key];
    if (value !== undefined && value !== null && typeof value === "object") return value as WardenConfig[K];
    missing.push(key);
    return fallback;
  };
  const config: WardenConfig = {
    enabled: source.enabled ?? true,
    typesafe: source.typesafe ?? false,
    typesafeBackend: resolveBackend(source.typesafeBackend),
    mode: isMode(source.mode) ? source.mode : "steer",
    timeoutMs: source.timeoutMs ?? 5000,
    maxRequests: source.maxRequests ?? 500,
    steerVisible: source.steerVisible ?? false,
    notices: source.notices ?? false,
    steerBudget: typeof source.steerBudget === "number" && source.steerBudget >= 0 ? source.steerBudget : 3,
    action: section("action", { ...off, tools: [], failOpen: true, timeoutMs: 5000, irreversible: { warn: 1, confirm: 1 }, offTask: { warn: 1, steer: 1 }, intentMismatch: 1, visibleMismatch: 1, shouldProceed: { hold: 0.6, steer: false }, feedbackLog: false, commandRules: [], commandDenyRules: [], exemptRules: [], pathRules: [], armingRules: [], escalationThreshold: 0.85, floor: "evidence" }),
    stuck: section("stuck", { ...off, window: 12, minFailures: 3, cooldown: 3, sameStrategy: 1, churnThreshold: 5, nudge: false, diffLimit: 3000, tailLimit: 1000 }),
    done: section("done", { ...off, claimsDone: 1, nudge: false }),
    slop: section("slop", { ...off, threshold: 1, prose: proseOff() }),
    security: section("security", { ...off, threshold: 1 }),
    rules: section("rules", { ...off, threshold: 1, files: [], fallback: false, maxChars: 500, exclude: [], skip: [], sensitivePaths: {} }),
    context: section("context", { ...off, tailMinChars: 1, confidence: 1, duplicateMinChars: Number.MAX_SAFE_INTEGER, recallTool: "none", formatConfidence: 1, compactAppendix: true }),
    runaway: section("runaway", { ...off, repeats: Number.MAX_SAFE_INTEGER, thinkingRepeats: Number.MAX_SAFE_INTEGER, minChars: Number.MAX_SAFE_INTEGER, recover: false }),
    notify: section("notify", { ...off, cooldownMs: 0, command: [] }),
    subagent: section("subagent", { ...off, wake: false, threshold: 1, cooldownMs: 0 }),
    widget: section("widget", { ...off, placement: "aboveEditor", barMode: "live", shortcut: "", panelWidth: "40%", action: "", stuck: "", done: "", prose: "", security: "", context: "", runaway: "", rules: "", subagent: "" }),
    learning: section("learning", { adaptiveThresholds: true, patternAnalysis: true, minHoldsForAdaptive: 20, adaptationRate: 0.1, retentionDays: 365 }),
    conscience: section("conscience", { enabled: false, skills: { mode: "recommend", exclude: [] }, tools: { enabled: true, exclude: [] }, timeoutMs: 1500, maxAssessments: 3, maxNudges: 2, maxSkillBytes: 32768, maxLoadedBytes: 65536, recommendThreshold: 0.80, advanceThreshold: 0.70, loadThreshold: 1.0 }),
  };
  // A missing/invalid runtime section falls back to disabled conscience, no loads, and the existing update warning.
  if (typeof config.conscience !== "object" || config.conscience === null) {
    missing.push("conscience");
    config.conscience = { enabled: false, skills: { mode: "recommend", exclude: [] }, tools: { enabled: true, exclude: [] }, timeoutMs: 1500, maxAssessments: 3, maxNudges: 2, maxSkillBytes: 32768, maxLoadedBytes: 65536, recommendThreshold: 0.80, advanceThreshold: 0.70, loadThreshold: 1.0 };
  }
  if (typeof config.conscience.skills !== "object" || config.conscience.skills === null) {
    config.conscience = { ...config.conscience, skills: { mode: "recommend", exclude: [] } };
  }
  if (typeof config.conscience.tools !== "object" || config.conscience.tools === null) {
    config.conscience = { ...config.conscience, tools: { enabled: true, exclude: [] } };
  }
  if (typeof config.slop.prose !== "object" || config.slop.prose === null) {
    missing.push("slop.prose");
    config.slop = { ...config.slop, prose: proseOff() };
  }
  // 0.7 added fields inside the context section; an older config module leaves them undefined.
  if (typeof config.context.duplicateMinChars !== "number" || typeof config.context.formatConfidence !== "number" || typeof config.context.recallTool !== "string") {
    missing.push("context.saver");
    config.context = { ...config.context, duplicateMinChars: Number.MAX_SAFE_INTEGER, recallTool: "none", formatConfidence: 1 };
  }
  if (typeof config.widget.panelWidth !== "string" && typeof config.widget.panelWidth !== "number") config.widget = { ...config.widget, panelWidth: "40%" };
  // The feedback log flag was added inside the action section later than the section itself; an older config module leaves it undefined and the log stays on.
  if (typeof config.action.feedbackLog !== "boolean") config.action = { ...config.action, feedbackLog: true };
  if (typeof config.action.intentMismatch !== "number") config.action = { ...config.action, intentMismatch: 0.9 };
  if (typeof config.action.visibleMismatch !== "number") config.action = { ...config.action, visibleMismatch: 0.8 };
  if (typeof config.action.shouldProceed !== "object" || config.action.shouldProceed === null || typeof config.action.shouldProceed.hold !== "number") config.action = { ...config.action, shouldProceed: { hold: 0.6, steer: false } };
  if (typeof config.action.shouldProceed.steer !== "boolean") config.action = { ...config.action, shouldProceed: { ...config.action.shouldProceed, steer: false } };
  if (typeof config.action.escalationThreshold !== "number") config.action = { ...config.action, escalationThreshold: 0.85 };
  if (config.action.floor !== "level" && config.action.floor !== "evidence") config.action = { ...config.action, floor: "evidence" };
  // The command rules were added inside the action section later than the section itself; an older config module leaves them undefined.
  if (!Array.isArray(config.action.commandRules)) config.action = { ...config.action, commandRules: [] };
  if (!Array.isArray(config.action.commandDenyRules)) config.action = { ...config.action, commandDenyRules: [] };
  if (!Array.isArray(config.action.exemptRules)) config.action = { ...config.action, exemptRules: [] };
  if (!Array.isArray(config.action.pathRules)) config.action = { ...config.action, pathRules: [] };
  if (!Array.isArray(config.action.armingRules)) config.action = { ...config.action, armingRules: [] };
  // 0.12 renamed offTask.confirm to offTask.steer; an older config module still delivers `confirm`.
  if (typeof config.action.offTask?.steer !== "number") config.action = { ...config.action, offTask: { warn: config.action.offTask?.warn ?? 1, steer: (config.action.offTask as { confirm?: number } | undefined)?.confirm ?? 1 } };
  // The runaway guard added its template later than the other sections; an older widget section renders the default line.
  if (typeof config.widget.runaway !== "string") config.widget = { ...config.widget, runaway: DEFAULT_TEMPLATES.runaway };
  if (typeof config.widget.rules !== "string") config.widget = { ...config.widget, rules: DEFAULT_TEMPLATES.rules };
  if (typeof config.widget.subagent !== "string") config.widget = { ...config.widget, subagent: DEFAULT_TEMPLATES.subagent };
  return { config, missing };
}

export function shapeWarning(missing: readonly string[], loadedSchema: number | undefined): string {
  return `warden: config sections ${missing.join(", ")} are missing (config module schema ${loadedSchema ?? "pre-3"}, extension expects ${EXPECTED_SCHEMA}); those guards are off. This happens when pi-warden was updated while Pi was running: restart Pi (a /reload is not enough).`;
}
