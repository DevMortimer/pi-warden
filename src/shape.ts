import { isMode } from "./config.js";
import type { WardenConfig } from "./config.js";
import { DEFAULT_TEMPLATES } from "./widget.js";

/** The config layout this extension build expects; compared with the loaded config module's CONFIG_SCHEMA. */
export const EXPECTED_SCHEMA = 5;

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
    mode: isMode(source.mode) ? source.mode : "steer",
    timeoutMs: source.timeoutMs ?? 5000,
    maxRequests: source.maxRequests ?? 500,
    steerVisible: source.steerVisible ?? false,
    action: section("action", { ...off, tools: [], failOpen: true, timeoutMs: 5000, irreversible: { warn: 1, confirm: 1 }, offTask: { warn: 1, confirm: 1 }, feedbackLog: false }),
    stuck: section("stuck", { ...off, window: 12, minFailures: 3, cooldown: 3, sameStrategy: 1, nudge: false }),
    done: section("done", { ...off, claimsDone: 1, nudge: false }),
    slop: section("slop", { ...off, threshold: 1, prose: proseOff() }),
    security: section("security", { ...off, threshold: 1 }),
    rules: section("rules", { ...off, threshold: 1, files: [], fallback: false, maxChars: 500, exclude: [], skip: [], sensitivePaths: {} }),
    context: section("context", { ...off, tailMinChars: 1, confidence: 1, duplicateMinChars: Number.MAX_SAFE_INTEGER, recallTool: "none", formatConfidence: 1 }),
    runaway: section("runaway", { ...off, repeats: Number.MAX_SAFE_INTEGER, thinkingRepeats: Number.MAX_SAFE_INTEGER, minChars: Number.MAX_SAFE_INTEGER, recover: false }),
    notify: section("notify", { ...off, cooldownMs: 0, command: [] }),
    widget: section("widget", { ...off, placement: "aboveEditor", shortcut: "", panelWidth: "40%", action: "", stuck: "", done: "", prose: "", security: "", context: "", runaway: "", rules: "" }),
  };
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
  // The runaway guard added its template later than the other sections; an older widget section renders the default line.
  if (typeof config.widget.runaway !== "string") config.widget = { ...config.widget, runaway: DEFAULT_TEMPLATES.runaway };
  if (typeof config.widget.rules !== "string") config.widget = { ...config.widget, rules: DEFAULT_TEMPLATES.rules };
  return { config, missing };
}

export function shapeWarning(missing: readonly string[], loadedSchema: number | undefined): string {
  return `warden: config sections ${missing.join(", ")} are missing (config module schema ${loadedSchema ?? "pre-3"}, extension expects ${EXPECTED_SCHEMA}); those guards are off. This happens when pi-warden was updated while Pi was running: restart Pi (a /reload is not enough).`;
}
