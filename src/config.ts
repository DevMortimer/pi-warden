import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  /** Maximum TypeSafe requests per session for this guard. */
  maxRequests: number;
  irreversible: Threshold;
  offTask: Threshold;
}

export interface WardenConfig {
  /** Master switch. false disables every guard, including offline pattern checks. */
  enabled: boolean;
  /** Consent to send task and action summaries to api.typesafe.ai. Set by /warden enable; never by a project file. */
  typesafe: boolean;
  /** Decision when confirmation is required and no UI can ask. PI_WARDEN_HEADLESS overrides it. */
  headless: "block" | "allow";
  action: ActionGuardConfig;
}

export const PACKAGE_NAME = "pi-warden";
export const PROJECT_CONFIG_FILE = `${PACKAGE_NAME}.json`;

export function defaultConfig(): WardenConfig {
  return {
    enabled: true,
    typesafe: false,
    headless: "block",
    action: {
      enabled: true,
      tools: ["bash", "write", "edit"],
      failOpen: true,
      timeoutMs: 5000,
      maxRequests: 500,
      irreversible: { warn: 0.5, confirm: 0.7 },
      offTask: { warn: 0.6, confirm: 0.85 },
    },
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

function applyAction(base: ActionGuardConfig, raw: unknown): ActionGuardConfig {
  if (!isObject(raw)) return base;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0) : base.tools;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    tools,
    failOpen: boolean(raw.failOpen, base.failOpen),
    timeoutMs: positiveInteger(raw.timeoutMs, base.timeoutMs),
    maxRequests: positiveInteger(raw.maxRequests, base.maxRequests),
    irreversible: threshold(raw.irreversible, base.irreversible),
    offTask: threshold(raw.offTask, base.offTask),
  };
}

/** Unknown keys and invalid values fall back to the base; nothing throws on a malformed file. */
export function applyUserOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  return {
    enabled: boolean(raw.enabled, base.enabled),
    typesafe: boolean(raw.typesafe, base.typesafe),
    headless: raw.headless === "allow" || raw.headless === "block" ? raw.headless : base.headless,
    action: applyAction(base.action, raw.action),
  };
}

/** Project files may tune the guard but cannot grant TypeSafe consent or change headless policy. */
export function applyProjectOverrides(base: WardenConfig, raw: unknown): WardenConfig {
  if (!isObject(raw)) return base;
  return { ...base, enabled: boolean(raw.enabled, base.enabled), action: applyAction(base.action, raw.action) };
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
export function setUserSetting(key: "typesafe" | "enabled" | "headless", value: boolean | "block" | "allow"): string {
  return writeUserConfig({ ...readUserConfig(), [key]: value });
}
