import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { COMMAND_TOOLS } from "./tools.js";
import { defaultWidgetConfig } from "./widget.js";
import type { WidgetConfig } from "./widget.js";

export interface Threshold {
  /** P(yes) at or above this shows a warning and continues. */
  warn: number;
  /** P(yes) at or above this asks the user before the tool runs. */
  confirm: number;
}

export interface ActionGuardConfig {
  enabled: boolean;
  /** Tool names inspected before execution. Read-only tools are skipped to keep latency low. */
  tools: string[];
  /** When TypeSafe cannot answer (timeout, outage, budget), allow the call with a warning instead of asking. */
  failOpen: boolean;
  /** Per-request TypeSafe timeout. The call is judged as an error after this. */
  timeoutMs: number;
  irreversible: Threshold;
  offTask: Threshold;
}

export interface StuckGuardConfig {
  enabled: boolean;
  /** Tool results remembered per user prompt. */
  window: number;
  /** Failures in the window before Jev is asked. */
  minFailures: number;
  /** Tool results between two Jev checks. */
  cooldown: number;
  /** P(same strategy) at or above this reports the agent as stuck. */
  sameStrategy: number;
  /** Also steer the agent with a short message, not only the user. */
  nudge: boolean;
}

export interface DoneGuardConfig {
  enabled: boolean;
  /** P(final message claims completion) at or above this warns when no check passed in the run. */
  claimsDone: number;
  /** Also send the agent a follow-up asking it to verify. Triggers one more LLM turn. */
  nudge: boolean;
}

export interface ProseConfig {
  enabled: boolean;
  /** Who reads the agent's replies: "technical", "plain", or a free-text description. Drives the jargon question. */
  audience: string;
  /** P(symptom) at or above this counts as a hit. */
  threshold: number;
  /** A symptom must hit in this many of the last three replies before the agent is nudged. */
  trend: number;
  /** Replies with fewer characters are not judged. */
  minChars: number;
}

export interface SlopGuardConfig {
  enabled: boolean;
  /** P(symptom) at or above this is reported for written code: stub, comments, dead, hedging. */
  threshold: number;
  prose: ProseConfig;
}

export interface SecurityConfig {
  enabled: boolean;
  /** P(injection or exfiltration) at or above this adds an untrusted-output notice. */
  threshold: number;
}

export interface ContextConfig {
  enabled: boolean;
  /** Only new tool output is compressed; warm history and system prompts are never changed. */
  tailMinChars: number;
  /** Minimum P(the full output is not needed), 1 - P(all), before code removes output. */
  confidence: number;
}

export type WardenMode = "steer" | "confirm" | "advise";

export interface WardenConfig {
  /** Master switch. false disables every guard, including offline pattern checks. */
  enabled: boolean;
  /** Consent to send task and action summaries to api.typesafe.ai. Set by /warden enable; never by a project file. */
  typesafe: boolean;
  /**
   * steer (default): a confirm-level call is held and the agent receives the judgment as its tool result, so it re-plans or asks
   * the user in chat. confirm: open a dialog and let the user decide (falls back to steer without a UI). advise: never hold; report only.
   * PI_WARDEN_MODE overrides it.
   */
  mode: WardenMode;
  /** Per-request TypeSafe timeout for every guard. */
  timeoutMs: number;
  /** Maximum TypeSafe requests per session across all guards. */
  maxRequests: number;
  action: ActionGuardConfig;
  stuck: StuckGuardConfig;
  done: DoneGuardConfig;
  slop: SlopGuardConfig;
  security: SecurityConfig;
  context: ContextConfig;
  /** The status line above the editor and the trace panel. */
  widget: WidgetConfig;
  /** Show steer messages in the transcript. They are always visible in the trace panel. */
  steerVisible: boolean;
}

export const PACKAGE_NAME = "pi-warden";
export const PROJECT_CONFIG_FILE = `${PACKAGE_NAME}.json`;

export function defaultConfig(): WardenConfig {
  return {
    enabled: true,
    typesafe: false,
    mode: "steer",
    timeoutMs: 5000,
    maxRequests: 500,
    action: {
      enabled: true,
      tools: [...COMMAND_TOOLS, "write", "edit"],
      failOpen: true,
      timeoutMs: 5000,
      irreversible: { warn: 0.5, confirm: 0.7 },
      offTask: { warn: 0.6, confirm: 0.85 },
    },
    stuck: { enabled: true, window: 12, minFailures: 3, cooldown: 3, sameStrategy: 0.7, nudge: true },
    done: { enabled: true, claimsDone: 0.7, nudge: true },
    slop: { enabled: true, threshold: 0.7, prose: { enabled: true, audience: "technical", threshold: 0.7, trend: 2, minChars: 200 } },
    security: { enabled: true, threshold: 0.7 },
    context: { enabled: true, tailMinChars: 12000, confidence: 0.8 },
    widget: defaultWidgetConfig(),
    steerVisible: false,
  };
}

/** Mirrors Pi's agent directory rule so the file sits next to pi-typesafe's auth.json. */
export function userConfigPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, PACKAGE_NAME, "config.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", PROJECT_CONFIG_FILE);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function probability(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function threshold(value: unknown, fallback: Threshold): Threshold {
  if (!isObject(value)) return fallback;
  const warn = probability(value.warn, fallback.warn);
  const confirm = probability(value.confirm, fallback.confirm);
  return { warn: Math.min(warn, confirm), confirm };
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function isMode(value: unknown): value is WardenMode {
  return value === "steer" || value === "confirm" || value === "advise";
}

function applyAction(base: ActionGuardConfig, raw: unknown, timeoutMs: number): ActionGuardConfig {
  const withTimeout = { ...base, timeoutMs };
  if (!isObject(raw)) return withTimeout;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0) : base.tools;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    tools,
    failOpen: boolean(raw.failOpen, base.failOpen),
    timeoutMs,
    irreversible: threshold(raw.irreversible, base.irreversible),
    offTask: threshold(raw.offTask, base.offTask),
  };
}

function applyStuck(base: StuckGuardConfig, raw: unknown): StuckGuardConfig {
  if (!isObject(raw)) return base;
  const window = positiveInteger(raw.window, base.window);
  return {
    enabled: boolean(raw.enabled, base.enabled),
    window,
    minFailures: Math.min(window, positiveInteger(raw.minFailures, base.minFailures)),
    cooldown: positiveInteger(raw.cooldown, base.cooldown),
    sameStrategy: probability(raw.sameStrategy, base.sameStrategy),
    nudge: boolean(raw.nudge, base.nudge),
  };
}

function applyDone(base: DoneGuardConfig, raw: unknown): DoneGuardConfig {
  if (!isObject(raw)) return base;
  return { enabled: boolean(raw.enabled, base.enabled), claimsDone: probability(raw.claimsDone, base.claimsDone), nudge: boolean(raw.nudge, base.nudge) };
}

function applyProse(base: ProseConfig, raw: unknown): ProseConfig {
  if (!isObject(raw)) return base;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    audience: typeof raw.audience === "string" && raw.audience.trim() ? raw.audience.trim() : base.audience,
    threshold: probability(raw.threshold, base.threshold),
    trend: Math.min(3, positiveInteger(raw.trend, base.trend)),
    minChars: positiveInteger(raw.minChars, base.minChars),
  };
}

function applySlop(base: SlopGuardConfig, raw: unknown): SlopGuardConfig {
  if (!isObject(raw)) return base;
  // 0.2.x used `placeholder` for the stub threshold; it still sets the shared threshold.
  return { enabled: boolean(raw.enabled, base.enabled), threshold: probability(raw.threshold ?? raw.placeholder, base.threshold), prose: applyProse(base.prose, raw.prose) };
}

function applyWidget(base: WidgetConfig, raw: unknown): WidgetConfig {
  if (!isObject(raw)) return base;
  const template = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value : fallback);
  return {
    enabled: boolean(raw.enabled, base.enabled),
    placement: raw.placement === "belowEditor" || raw.placement === "aboveEditor" ? raw.placement : base.placement,
    shortcut: typeof raw.shortcut === "string" ? raw.shortcut.trim() : base.shortcut,
    panelWidth: typeof raw.panelWidth === "number" && Number.isSafeInteger(raw.panelWidth) && raw.panelWidth >= 20 ? raw.panelWidth
      : typeof raw.panelWidth === "string" && /^[1-9]\d?%$/.test(raw.panelWidth.trim()) ? raw.panelWidth.trim() : base.panelWidth,
    action: template(raw.action, base.action),
    stuck: template(raw.stuck, base.stuck),
    done: template(raw.done, base.done),
    prose: template(raw.prose, base.prose),
    security: template(raw.security, base.security),
    context: template(raw.context, base.context),
  };
}

/** Shared request settings; `action.timeoutMs`/`action.maxRequests` from 0.1.x files are still honoured. */
function applyShared(base: WardenConfig, raw: Json): Pick<WardenConfig, "timeoutMs" | "maxRequests"> {
  const legacy = isObject(raw.action) ? raw.action : {};
  return {
    timeoutMs: positiveInteger(raw.timeoutMs ?? legacy.timeoutMs, base.timeoutMs),
    maxRequests: positiveInteger(raw.maxRequests ?? legacy.maxRequests, base.maxRequests),
  };
}

function applyGuards(base: WardenConfig, raw: Json, timeoutMs: number): Pick<WardenConfig, "action" | "stuck" | "done" | "slop" | "security" | "context"> {
  return {
    action: applyAction(base.action, raw.action, timeoutMs),
    stuck: applyStuck(base.stuck, raw.stuck),
    done: applyDone(base.done, raw.done),
    slop: applySlop(base.slop, raw.slop),
    security: isObject(raw.security) ? {
      enabled: boolean(raw.security.enabled, base.security.enabled),
      threshold: probability(raw.security.threshold, base.security.threshold),
    } : base.security,
    context: isObject(raw.context) ? {
      enabled: boolean(raw.context.enabled, base.context.enabled),
      tailMinChars: positiveInteger(raw.context.tailMinChars, base.context.tailMinChars),
      confidence: probability(raw.context.confidence, base.context.confidence),
    } : base.context,
  };
}

/** Unknown keys and invalid values fall back to the base; nothing throws on a malformed file. */
export function applyUserOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  const shared = applyShared(base, raw);
  return {
    enabled: boolean(raw.enabled, base.enabled),
    typesafe: boolean(raw.typesafe, base.typesafe),
    mode: isMode(raw.mode) ? raw.mode : base.mode,
    ...shared,
    ...applyGuards(base, raw, shared.timeoutMs),
    widget: applyWidget(base.widget, raw.widget),
    steerVisible: boolean(raw.steerVisible, base.steerVisible),
  };
}

/** Project files may tune the guards but cannot grant TypeSafe consent, change the mode, or raise budgets. */
export function applyProjectOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  return { ...base, enabled: boolean(raw.enabled, base.enabled), ...applyGuards(base, raw, base.timeoutMs) };
}

export interface LoadOptions {
  cwd?: string;
  /** Project overrides are applied only when the caller vouches for the project (Pi's trust decision). */
  projectTrusted?: boolean;
}

export function loadConfig(options: LoadOptions = {}): WardenConfig {
  let config = applyUserOverrides(defaultConfig(), readJson(userConfigPath()));
  if (options.cwd && options.projectTrusted) config = applyProjectOverrides(config, readJson(projectConfigPath(options.cwd)));
  return config;
}

/** Reads only the user file, for editing and persisting consent. */
export function readUserConfig(): Json {
  return readJson(userConfigPath()) ?? {};
}

export function writeUserConfig(raw: Json): string {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600, flag: "w" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}

/** Persists one top-level user setting without disturbing the rest of the file. */
export function setUserSetting(key: "typesafe" | "enabled" | "mode", value: boolean | WardenMode): string {
  return writeUserConfig({ ...readUserConfig(), [key]: value });
}
