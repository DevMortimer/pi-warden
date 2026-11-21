import { basename } from "node:path";
import type { TaintConfig } from "./config.js";
import {
  inEphemeralRoot,
  inHostPath,
  isNegated,
  resolveActionPath,
  resolveEphemeralRoots,
  stripDataText,
  stripShellComments,
  writeSinkTargets,
} from "./guard.js";
import { findSecrets, partitionSecrets, redact } from "./redact.js";
import { projectPath } from "./rules.js";
import { commandOf } from "./tools.js";

export type TaintSourceKind = "untrusted" | "secret" | "injection";

export type TaintSinkKind =
  | "http-exfil"
  | "pkg-publish"
  | "git-push"
  | "gh-mutate"
  | "mcp-write"
  | "external-write";

export type TaintRuleId =
  | "taint-injection-egress"
  | "taint-lethal-trifecta"
  | "taint-secret-egress"
  | "taint-untrusted-egress";

export interface TaintSourceEvent {
  kind: TaintSourceKind;
  tool: string;
  label: string;
  turn: number;
  pattern?: string;
}

export interface TaintSinkClassification {
  kind: TaintSinkKind;
  /** Redacted target identifier (hostname, MCP service, or basename) for diagnostics and call-scoped rulings. */
  target?: string;
  /** Short human label for verdicts and traces. */
  label: string;
}

export interface TaintSourceInput {
  tool: string;
  input: Record<string, unknown>;
  cwd?: string | undefined;
  failed?: boolean | undefined;
  outputText?: string | undefined;
  /** Real secret verdict from evaluateOutput when already computed; omitted falls back to local partitionSecrets scan. */
  outputSecret?: boolean | undefined;
  /** Prompt-injection/exfiltration verdict from evaluateOutput (Jev). */
  outputSuspicious?: boolean | undefined;
  allowHosts?: readonly string[] | undefined;
}

export interface TaintSourceClassification {
  untrusted: boolean;
  untrustedLabel?: string;
  secret: boolean;
  secretLabel?: string;
  injection: boolean;
  injectionLabel?: string;
  injectionPattern?: string;
}

export interface TaintSinkInput {
  tool: string;
  input: Record<string, unknown>;
  cwd?: string | undefined;
  allowHosts?: readonly string[] | undefined;
  ephemeralRoots?: readonly string[] | undefined;
  hostPaths?: readonly string[] | undefined;
}

export interface TaintCheckOptions {
  tool: string;
  input: Record<string, unknown>;
  cwd?: string | undefined;
  config: TaintConfig;
  ephemeralRoots?: readonly string[] | undefined;
  hostPaths?: readonly string[] | undefined;
  exemptRules?: readonly string[] | undefined;
}

export interface TaintCheckResult {
  decision: "allow" | "warn" | "hold";
  hold: boolean;
  id?: TaintRuleId;
  label?: string;
  reason?: string;
  sink?: TaintSinkClassification;
  sources: string[];
  /** True when a post-taint single-use call-scoped user ruling released this sink without laundering session taint. */
  rulingApplied?: boolean;
  /** True only for taint-lethal-trifecta on developer collaboration sinks eligible for Jev semantic declassification. */
  jevDeclassifiable?: boolean;
}

export interface TaintObservationResult {
  untrustedAdded: boolean;
  secretAdded: boolean;
  injectionArmed: boolean;
  injectionSource?: string;
  injectionPattern?: string;
}

export interface TaintSnapshot {
  promptTurn: number;
  untrustedCount: number;
  secretCount: number;
  injectionCount: number;
  heldCount: number;
  warnedCount: number;
  declassifiedCount: number;
  rulingsGranted: number;
  sources: {
    untrusted: readonly TaintSourceEvent[];
    secret: readonly TaintSourceEvent[];
    injection: readonly TaintSourceEvent[];
  };
}

const MAX_SOURCE_HISTORY = 64;

const UNTRUSTED_TOOLS = new Set([
  "tiny_search",
  "tiny_fetch",
  "web_search",
  "fetch_content",
  "fetch_and_index",
  "webfetch",
  "web_fetch",
]);

const JEV_DECLASSIFIABLE_SINKS: ReadonlySet<TaintSinkKind> = new Set([
  "git-push",
  "gh-mutate",
  "mcp-write",
]);

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Covers guard.ts's SENSITIVE_PATH targets plus .ssh/*, auth.json, *credentials*, and *.key while keeping template files clean.
const TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist)$/i;
const TAINT_SENSITIVE_PATH = /(?:^|[\s/"'=:(~])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w.-]+)?(?=$|[\s"';|&)])|(?:^|[\s"'=:/~])\.?(?:ssh\/[^\s"'|;&)]+|aws\/credentials\b|gnupg\/[^\s"'|;&)]*|netrc\b|npmrc\b|pypirc\b|docker\/config\.json\b|kube\/config\b|(?:[\w.-]+\/)*auth\.json\b)|(?:^|[\s"'=:/~])[\w.-]*credentials[\w.-]*(?=$|[\s"';|&)])|(?:^|[\s"'=:/~])[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks)(?=$|[\s"';|&)])|\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i;

const SHELL_READ_VERB = /(?:^|[;&|(\n]\s*)(?:(?:sudo|env)\s+)*(?:cat|head|tail|less|more|sed|awk|grep|rg|bat|nl|strings|base64|xxd|od|source|\.)(?:\s|$)/;
const SHELL_INPUT_REDIRECT = /<\s*["']?([^\s"';|&)]+)["']?/;

const HTTP_CLIENT_RE = /(?:^|[;&|(\n]\s*)(?:(?:sudo|env)\s+)*(?:curl|wget|http|Invoke-WebRequest|iwr)\b/i;
const HTTP_EXFIL_FLAG_RE = /(?:^|\s)(?:-[a-zA-Z]*[dFT](?:\s|$|=)|--data(?:-[a-z]+)?(?:=|\s|$)|--form(?:-string)?(?:=|\s|$)|--upload-file(?:=|\s|$)|--json(?:=|\s|$)|--post-(?:data|file)(?:=|\s|$)|--body-(?:data|file)(?:=|\s|$))/;
const HTTP_MUTATE_METHOD_RE = /(?:^|\s)(?:-X\s*|--request[=\s]+|--method[=\s]+)(?:POST|PUT|PATCH|DELETE)\b|\bhttp\s+(?:POST|PUT|PATCH|DELETE)\b/i;
const HTTP_HEADER_EXPANSION_RE = /(?:^|\s)(?:-H|--header)(?:=|\s+)["']?[^"'\n]*(?:\$[A-Za-z_{]|\$\(|`)/;
const SHELL_VAR_EXPANSION_RE = /\$[A-Za-z_{]|\$\(|`/;

const REMOTE_COPY_RE = /\b(?:scp|sftp|rsync)\b/i;
const NETCAT_RE = /(?:^|[;&|(\n]\s*)(?:(?:sudo|env)\s+)*(?:nc|ncat|netcat|socat)\b/i;
const GH_READ_RE = /\bgh\s+(?:issue\s+(?:view|list)|pr\s+(?:view|list|comments|diff|checks)|api)\b/i;
const GH_MUTATE_RE = /\bgh\s+(?:pr\s+(?:create|comment|edit|merge|close|review|ready)|issue\s+(?:create|comment|edit|close|reopen)|gist\s+(?:create|edit)|repo\s+(?:create|delete|edit|fork))\b/i;
const GH_API_MUTATE_RE = /\bgh\s+api\b[\s\S]*(?:(?:-X|--method)(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)-[fF]\s|--(?:raw-)?field(?:=|\s)|--input(?:=|\s))/i;
const PKG_PUBLISH_RE = /\b(?:(?:npm|pnpm|yarn|cargo)\s+publish|twine\s+upload|gh\s+release\s+(?:create|upload))\b/i;
const GIT_PUSH_RE = /\bgit(?:\s+(?:-[a-zA-Z]|--[a-z-]+(?:=\S+)?|-C\s+\S+))*\s+push\b/i;

const MCP_MUTATE_RE = /\b(?:create|update|post|send|write|delete|remove|comment|upload|publish|reply|edit|patch|put|merge|close|assign|archive|notify|dispatch|trigger|mutate)\b/i;
const MCP_READ_ONLY_RE = /\b(?:read|list|get|search|find|query|describe|status|info|snapshot|inspect|view|fetch|show|check|evaluate_script|take_screenshot|console_messages|network_requests)\b/i;

const OFFLINE_INJECTION_RULES: ReadonlyArray<{ name: string; test: (text: string) => boolean }> = [
  {
    name: "ignore-previous-instructions",
    test: text => /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/i.test(text),
  },
  {
    name: "injected-role-tag",
    test: text => /<(?:system|developer|admin)[_ -]?(?:prompt|instruction|override)?\b[^>]*>/i.test(text),
  },
  {
    name: "new-system-instructions",
    test: text => /\bnew\s+system\s+instructions?\s*:/i.test(text),
  },
  {
    name: "developer-mode-override",
    test: text => /\byou\s+are\s+now\s+in\s+developer\s+mode\b/i.test(text),
  },
  {
    name: "exfiltration-directive",
    test: text => {
      // Sensitive file exfiltration (.env, id_rsa, .ssh/) with an outbound verb within 160 chars.
      if (/(?:\b(?:send|upload|post|curl|fetch|exfiltrate)\b[\s\S]{0,160}(?:\.env\b|\.ssh\/|\bid_rsa\b|\bid_ed25519\b))|(?:(?:\.env\b|\.ssh\/|\bid_rsa\b|\bid_ed25519\b)[\s\S]{0,160}\b(?:send|upload|post|curl|fetch|exfiltrate)\b)/i.test(text)) {
        return true;
      }
      // Broader secret/token/api-key terms require a directive/target cue so routine OAuth docs never arm false positives.
      const pair = /(?:\b(?:send|upload|post|curl|fetch|exfiltrate)\b[\s\S]{0,160}(?:api[_ -]?key|\bsecrets?\b|\btokens?\b|\bssh\b))|(?:(?:api[_ -]?key|\bsecrets?\b|\btokens?\b|\bssh\b)[\s\S]{0,160}\b(?:send|upload|post|curl|fetch|exfiltrate)\b)/i;
      const cue = /\b(?:to\s+https?:\/\/|exfiltrat\w*|silently|without\s+telling|do\s+not\s+tell|dump|steal|grab|extract)\b/i;
      return pair.test(text) && cue.test(text);
    },
  },
];

const DEV_NULL_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

export function isJevDeclassifiableSink(kind: TaintSinkKind): boolean {
  return JEV_DECLASSIFIABLE_SINKS.has(kind);
}

/** High-precision offline prompt-injection detector run on untrusted tool outputs when Jev is off or before Jev responds. */
export function detectOfflineInjection(text: string): string | undefined {
  if (!text) return undefined;
  for (const rule of OFFLINE_INJECTION_RULES) {
    if (rule.test(text)) return rule.name;
  }
  return undefined;
}

function normalizeHost(rawHost: string): string {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    host = close !== -1 ? host.slice(1, close) : host.slice(1);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  return host.replace(/\.$/, "");
}

function isTrustedHost(rawHost: string, allowHosts: readonly string[] = []): boolean {
  if (!rawHost || SHELL_VAR_EXPANSION_RE.test(rawHost)) return false;
  const host = normalizeHost(rawHost);
  if (!host) return false;
  if (
    host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "0.0.0.0"
    || host.endsWith(".localhost")
    || LOOPBACK_IPV4.test(host)
  ) {
    return true;
  }
  for (const entry of allowHosts) {
    const allowed = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!allowed) continue;
    if (allowed.startsWith(".")) {
      const bare = allowed.slice(1);
      if (host === bare || host.endsWith(allowed)) return true;
    } else if (host === allowed) {
      return true;
    }
  }
  return false;
}

interface ParsedUrl {
  raw: string;
  host: string;
}

function extractUrls(text: string): ParsedUrl[] {
  const out: ParsedUrl[] = [];
  const matches = text.matchAll(/https?:\/\/[^\s"'<>|;&)]+/gi);
  for (const match of matches) {
    const raw = match[0];
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {
      const fallback = /^https?:\/\/(?:\[([^\]]+)\]|([^/:?#]+))/i.exec(raw);
      host = fallback?.[1] ?? fallback?.[2] ?? "";
    }
    if (host) out.push({ raw, host });
  }
  return out;
}

function isMcpTool(tool: string): boolean {
  return tool === "mcp" || tool.startsWith("mcp__");
}

function isExternalWebTool(tool: string): boolean {
  if (UNTRUSTED_TOOLS.has(tool)) return true;
  return tool.startsWith("browser_") || tool.startsWith("chrome_devtools") || tool.startsWith("agent_browser");
}

function isSensitivePath(candidate: string): boolean {
  const trimmed = candidate.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return false;
  if (TEMPLATE_SUFFIX.test(trimmed)) return false;
  return TAINT_SENSITIVE_PATH.test(trimmed);
}

function safePathLabel(rawPath: string, cwd?: string): string {
  const rel = cwd ? projectPath(rawPath, cwd) : undefined;
  return redact(rel ?? (basename(rawPath) || rawPath));
}

function extractInputUrls(input: Record<string, unknown>): ParsedUrl[] {
  const urls: ParsedUrl[] = [];
  for (const key of ["url", "uri", "href", "endpoint"]) {
    const value = input[key];
    if (typeof value === "string") urls.push(...extractUrls(value));
  }
  if (Array.isArray(input.urls)) {
    for (const item of input.urls) {
      if (typeof item === "string") urls.push(...extractUrls(item));
    }
  }
  return urls;
}

function splitSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|\n])+/).map(part => part.trim()).filter(Boolean);
}

function extractRemoteHostFromCopy(segment: string): string | undefined {
  for (const match of segment.matchAll(/(?:^|\s)(?:[\w.-]+@)?(\[[^\]]+\]|[a-zA-Z0-9.-]+):[^\s]+/g)) {
    const host = match[1]!;
    // Skip Windows drive letters (e.g. C:\foo) and URL schemes (http:).
    if (host.length <= 1 || /^(?:https?|file|ssh|sftp|rsync)$/i.test(host)) continue;
    return host;
  }
  return undefined;
}

function extractNetcatHost(segment: string): string | undefined {
  const tokens = segment.trim().split(/\s+/).slice(1);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      if (/^-[pwsTiIXx]$/.test(token)) index++;
      continue;
    }
    // socat uses endpoints like TCP:host:port or OPENSSL:host:port.
    const socat = /^(?:TCP4?|UDP4?|OPENSSL|SSL):([^:,\s]+)(?::\d+)?/i.exec(token);
    if (socat) return socat[1];
    if (/^\d+$/.test(token)) continue;
    return token.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function mcpServiceName(tool: string, input: Record<string, unknown>): string {
  if (tool.startsWith("mcp__")) {
    const rest = tool.slice("mcp__".length);
    const server = rest.split(/__|_/)[0];
    return server || rest;
  }
  for (const key of ["server", "call", "tool"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().split(/[:/]/)[0]!;
    }
  }
  return "mcp";
}

function mcpActionString(tool: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  if (tool.startsWith("mcp__")) parts.push(tool.slice("mcp__".length));
  for (const key of ["action", "tool", "method", "call", "operation", "command", "name"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }
  return parts.join(" ");
}

/** Classify whether a finished tool result admits untrusted data, sensitive/secret data, or suspected prompt injection. */
export function classifyTaintSource(source: TaintSourceInput): TaintSourceClassification {
  const { tool, input, cwd, failed = false, outputText, outputSecret, outputSuspicious, allowHosts = [] } = source;
  let untrusted = false;
  let untrustedLabel: string | undefined;
  let secret = false;
  let secretLabel: string | undefined;
  let injection = false;
  let injectionLabel: string | undefined;
  let injectionPattern: string | undefined;

  if (!failed) {
    if (isExternalWebTool(tool)) {
      const urls = extractInputUrls(input);
      const external = urls.filter(url => !isTrustedHost(url.host, allowHosts));
      if (urls.length === 0 || external.length > 0) {
        untrusted = true;
        const host = external[0]?.host;
        untrustedLabel = host ? `${tool} (${redact(normalizeHost(host))})` : tool;
      }
    } else if (isMcpTool(tool)) {
      untrusted = true;
      untrustedLabel = redact(tool);
    } else {
      const view = commandOf(tool, input);
      if (view) {
        const clean = stripShellComments(view.command);
        const stripped = stripDataText(clean).text;
        for (const segment of splitSegments(stripped)) {
          if (HTTP_CLIENT_RE.test(segment)) {
            const urls = extractUrls(segment);
            const external = urls.filter(url => !isTrustedHost(url.host, allowHosts));
            if (urls.length === 0 || external.length > 0) {
              untrusted = true;
              const host = external[0]?.host;
              untrustedLabel = host ? `http (${redact(normalizeHost(host))})` : "http";
              break;
            }
          }
          if (GH_READ_RE.test(segment) && !isTrustedHost("github.com", allowHosts)) {
            untrusted = true;
            untrustedLabel = "gh";
            break;
          }
        }
      }
    }

    if ((tool === "read" || tool === "view_file") && typeof input.path === "string" && isSensitivePath(input.path)) {
      secret = true;
      secretLabel = `${tool} (${safePathLabel(input.path, cwd)})`;
    } else {
      const view = commandOf(tool, input);
      if (view) {
        const clean = stripShellComments(view.command);
        for (const segment of splitSegments(clean)) {
          const isRead = SHELL_READ_VERB.test(segment);
          const redirect = SHELL_INPUT_REDIRECT.exec(segment);
          if (redirect && isSensitivePath(redirect[1]!)) {
            secret = true;
            secretLabel = `bash (${safePathLabel(redirect[1]!, cwd)})`;
            break;
          }
          if (isRead) {
            const match = TAINT_SENSITIVE_PATH.exec(segment);
            if (match && !TEMPLATE_SUFFIX.test(match[0].trim())) {
              secret = true;
              const token = match[0].trim().replace(/^["'=:(]+|["';|&)]+$/g, "");
              secretLabel = `bash (${safePathLabel(token, cwd)})`;
              break;
            }
          }
        }
      }
    }
  }

  // Real secrets detected in tool output taint the session even if the command exited non-zero.
  if (outputSecret === true) {
    secret = true;
    secretLabel ??= `${tool} (credential in output)`;
  } else if (outputSecret === undefined && outputText) {
    if (partitionSecrets(findSecrets(outputText)).real.length > 0) {
      secret = true;
      secretLabel ??= `${tool} (credential in output)`;
    }
  }

  if (outputSuspicious === true) {
    injection = true;
    injectionLabel = untrustedLabel ?? redact(tool);
    injectionPattern = "jev-suspicious-output";
  } else if (untrusted && !failed && outputText) {
    // Offline injection patterns scan untrusted external outputs only so local test fixtures never self-trigger.
    const matched = detectOfflineInjection(outputText);
    if (matched) {
      injection = true;
      injectionLabel = untrustedLabel ?? redact(tool);
      injectionPattern = matched;
    }
  }

  return {
    untrusted,
    ...(untrustedLabel ? { untrustedLabel } : {}),
    secret,
    ...(secretLabel ? { secretLabel } : {}),
    injection,
    ...(injectionLabel ? { injectionLabel } : {}),
    ...(injectionPattern ? { injectionPattern } : {}),
  };
}

/** Classify whether a proposed tool call targets an egress or external mutation sink. Local project edits, scratch roots, and loopback/allowHosts return undefined. */
export function classifyTaintSink(sinkInput: TaintSinkInput): TaintSinkClassification | undefined {
  const { tool, input, cwd, allowHosts = [], ephemeralRoots = [], hostPaths = [] } = sinkInput;

  if (tool === "write" || tool === "edit") {
    const rawPath = typeof input.path === "string" ? input.path.trim() : "";
    if (!rawPath) return undefined;
    if (cwd && projectPath(rawPath, cwd) !== undefined) return undefined;
    const resolved = resolveActionPath(rawPath, cwd ?? process.cwd());
    const roots = resolveEphemeralRoots(ephemeralRoots);
    if (inEphemeralRoot(resolved, roots, cwd)) return undefined;
    if (hostPaths.length > 0 && inHostPath(resolved, hostPaths)) return undefined;
    const target = redact(basename(resolved) || rawPath);
    return { kind: "external-write", target, label: `external file write (${target})` };
  }

  if (isMcpTool(tool)) {
    const actionText = mcpActionString(tool, input);
    const service = redact(mcpServiceName(tool, input));
    if (MCP_MUTATE_RE.test(actionText)) {
      return { kind: "mcp-write", target: service, label: `MCP write (${service})` };
    }
    if (!MCP_READ_ONLY_RE.test(actionText)) {
      const hasRecipient = typeof input.channel === "string" || typeof input.to === "string" || typeof input.recipient === "string";
      const hasPayload = typeof input.text === "string" || typeof input.message === "string" || typeof input.body === "string";
      if (hasRecipient && hasPayload) {
        return { kind: "mcp-write", target: service, label: `MCP write (${service})` };
      }
    }
    return undefined;
  }

  const view = commandOf(tool, input);
  if (!view) return undefined;
  const clean = stripShellComments(view.command);
  const stripped = stripDataText(clean).text;
  const segments = splitSegments(stripped);

  // Priority 1: direct HTTP / network exfiltration (never eligible for Jev declassification).
  for (const segment of segments) {
    if (HTTP_CLIENT_RE.test(segment)) {
      const urls = extractUrls(segment);
      const untrustedUrls = urls.filter(url => !isTrustedHost(url.host, allowHosts));
      if (urls.length > 0 && untrustedUrls.length === 0) continue;
      const hasOutboundFlag = HTTP_EXFIL_FLAG_RE.test(segment)
        || HTTP_MUTATE_METHOD_RE.test(segment)
        || HTTP_HEADER_EXPANSION_RE.test(segment)
        || untrustedUrls.some(url => SHELL_VAR_EXPANSION_RE.test(url.raw));
      if (hasOutboundFlag) {
        const host = untrustedUrls[0]?.host;
        const target = host && !SHELL_VAR_EXPANSION_RE.test(host) ? redact(normalizeHost(host)) : "remote-host";
        return { kind: "http-exfil", target, label: `external HTTP write (${target})` };
      }
    }
    if (REMOTE_COPY_RE.test(segment)) {
      const host = extractRemoteHostFromCopy(segment);
      if (host && !isTrustedHost(host, allowHosts)) {
        const target = redact(normalizeHost(host));
        return { kind: "http-exfil", target, label: `remote transfer (${target})` };
      }
    }
    if (NETCAT_RE.test(segment)) {
      const host = extractNetcatHost(segment);
      if (host && !isTrustedHost(host, allowHosts)) {
        const target = redact(normalizeHost(host));
        return { kind: "http-exfil", target, label: `remote socket (${target})` };
      }
    }
  }

  // Priority 2: package/release publish.
  if (PKG_PUBLISH_RE.test(stripped)) {
    return { kind: "pkg-publish", target: "package-registry", label: "package or release publish" };
  }

  // Priority 3: shell redirection outside project and ephemeral scratch roots.
  const roots = resolveEphemeralRoots(ephemeralRoots);
  for (const rawTarget of writeSinkTargets(stripped)) {
    if (DEV_NULL_TARGETS.has(rawTarget)) continue;
    if (cwd && projectPath(rawTarget, cwd) !== undefined) continue;
    const resolved = resolveActionPath(rawTarget, cwd ?? process.cwd());
    if (inEphemeralRoot(resolved, roots, cwd)) continue;
    if (hostPaths.length > 0 && inHostPath(resolved, hostPaths)) continue;
    const target = redact(basename(resolved) || rawTarget);
    return { kind: "external-write", target, label: `external redirect write (${target})` };
  }

  // Priority 4: remote git push.
  if (GIT_PUSH_RE.test(stripped)) {
    return { kind: "git-push", target: "git-remote", label: "git push" };
  }

  // Priority 5: mutating GitHub CLI commands.
  if ((GH_MUTATE_RE.test(stripped) || GH_API_MUTATE_RE.test(stripped)) && !isTrustedHost("github.com", allowHosts)) {
    return { kind: "gh-mutate", target: "github", label: "GitHub write command" };
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptContainsTarget(prompt: string, target: string): boolean {
  if (!target || target === "remote-host") return false;
  const escaped = escapeRegExp(target);
  return new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, "i").test(prompt);
}

function anyUnnegatedVerb(prompt: string, verbs: readonly string[]): boolean {
  const lower = prompt.toLowerCase();
  for (const verb of verbs) {
    const present = new RegExp(`\\b${escapeRegExp(verb)}(?:s|es|ed|ing)?\\b`, "i").test(lower);
    if (present && !isNegated(prompt, verb)) return true;
  }
  return false;
}

function promptAuthorizesSink(prompt: string, sink: TaintSinkClassification): boolean {
  if (!prompt.trim()) return false;
  switch (sink.kind) {
    case "git-push": {
      if (isNegated(prompt, "push")) return false;
      if (/\bgit\s+push\b/i.test(prompt)) return true;
      return /\bpush(?:ing|ed)?\b/i.test(prompt)
        && /\b(?:branch|origin|main|master|pr|pull\s+request|remote|upstream|tag|changes?|commits?|it)\b/i.test(prompt);
    }
    case "gh-mutate": {
      const ghVerbs = ["open", "create", "comment", "edit", "merge", "close", "post", "submit", "update", "reply"];
      const hasGhNoun = /\b(?:pr|pull\s+request|issue|gist|github|gh)\b/i.test(prompt);
      if (!hasGhNoun) return false;
      if (/\bgh\s+(?:pr|issue|gist|api)\b/i.test(prompt) && !ghVerbs.some(verb => isNegated(prompt, verb))) return true;
      return anyUnnegatedVerb(prompt, ghVerbs);
    }
    case "pkg-publish": {
      const hasNoun = /\b(?:npm|pnpm|yarn|package|release|crate|cargo|pypi|twine|registry)\b/i.test(prompt);
      if (!hasNoun) return false;
      return anyUnnegatedVerb(prompt, ["publish", "upload", "release"]);
    }
    case "http-exfil": {
      const verbs = ["post", "send", "upload", "curl", "fetch", "put", "patch", "delete", "submit", "call"];
      if (!anyUnnegatedVerb(prompt, verbs)) return false;
      if (sink.target && sink.target !== "remote-host") return promptContainsTarget(prompt, sink.target);
      return /\b(?:url|endpoint|webhook|http)\b/i.test(prompt);
    }
    case "mcp-write": {
      if (!sink.target || !promptContainsTarget(prompt, sink.target)) return false;
      return anyUnnegatedVerb(prompt, ["post", "send", "create", "update", "write", "delete", "comment", "upload", "publish", "notify", "reply", "message"]);
    }
    case "external-write": {
      if (!sink.target || !promptContainsTarget(prompt, sink.target)) return false;
      return anyUnnegatedVerb(prompt, ["write", "save", "create", "update", "edit", "overwrite", "copy", "export", "output"]);
    }
  }
}

function summarizeSources(events: readonly TaintSourceEvent[]): string {
  const unique: string[] = [];
  for (const event of events) {
    if (!unique.includes(event.label)) unique.push(event.label);
    if (unique.length >= 3) break;
  }
  return unique.join(", ");
}

function formatHoldReason(
  id: TaintRuleId,
  sink: TaintSinkClassification,
  untrusted: readonly TaintSourceEvent[],
  secret: readonly TaintSourceEvent[],
  injection: readonly TaintSourceEvent[],
): string {
  const recovery = "Recovery: (1) ask the user to explicitly confirm this exact outbound step in their next reply to grant a single-use call ruling, or (2) complete local edits and tests without sending data externally.";
  if (id === "taint-injection-egress") {
    return `${id}: suspected prompt injection from ${summarizeSources(injection)} before ${sink.label}. ${recovery}`;
  }
  if (id === "taint-lethal-trifecta") {
    return `${id}: session admitted untrusted external data (${summarizeSources(untrusted)}) and sensitive/secret data (${summarizeSources(secret)}) before ${sink.label}. ${recovery}`;
  }
  if (id === "taint-secret-egress") {
    return `${id}: session admitted sensitive/secret data (${summarizeSources(secret)}) before ${sink.label}. ${recovery}`;
  }
  return `${id}: session admitted untrusted external data (${summarizeSources(untrusted)}) before ${sink.label}.`;
}

/**
 * APPA-style recoverable session taint monitor: dual-phase output admission (Gate 2) and prospective sink dispatch
 * (Gate 1), with single-use call-scoped post-taint user recovery rulings that never launder underlying session taint.
 */
export class TaintMonitor {
  private promptTurn = 0;
  private latestPrompt = "";
  private untrustedSources: TaintSourceEvent[] = [];
  private secretSources: TaintSourceEvent[] = [];
  private injectionSources: TaintSourceEvent[] = [];
  private untrustedCount = 0;
  private secretCount = 0;
  private injectionCount = 0;
  private maxUntrustedTurn = -1;
  private maxSecretTurn = -1;
  private maxInjectionTurn = -1;
  private consumedRulings = new Set<string>();
  private heldCount = 0;
  private warnedCount = 0;
  private declassifiedCount = 0;
  private rulingsGranted = 0;

  reset(): void {
    this.promptTurn = 0;
    this.latestPrompt = "";
    this.untrustedSources = [];
    this.secretSources = [];
    this.injectionSources = [];
    this.untrustedCount = 0;
    this.secretCount = 0;
    this.injectionCount = 0;
    this.maxUntrustedTurn = -1;
    this.maxSecretTurn = -1;
    this.maxInjectionTurn = -1;
    this.consumedRulings.clear();
    this.heldCount = 0;
    this.warnedCount = 0;
    this.declassifiedCount = 0;
    this.rulingsGranted = 0;
  }

  /** Record a fresh user prompt turn; only prompts strictly newer than a taint event can grant a call-scoped ruling. */
  noteUserPrompt(promptText: string | undefined): void {
    if (typeof promptText !== "string" || !promptText.trim()) return;
    this.promptTurn++;
    this.latestPrompt = promptText.trim();
  }

  /** Gate 2: admit a completed tool result into the partial session taint lattice. */
  observeResult(input: TaintSourceInput): TaintObservationResult {
    const classified = classifyTaintSource(input);
    let untrustedAdded = false;
    let secretAdded = false;
    let injectionArmed = false;

    if (classified.untrusted) {
      untrustedAdded = true;
      this.untrustedCount++;
      this.maxUntrustedTurn = Math.max(this.maxUntrustedTurn, this.promptTurn);
      this.pushSource(this.untrustedSources, {
        kind: "untrusted",
        tool: input.tool,
        label: classified.untrustedLabel ?? redact(input.tool),
        turn: this.promptTurn,
      });
    }
    if (classified.secret) {
      secretAdded = true;
      this.secretCount++;
      this.maxSecretTurn = Math.max(this.maxSecretTurn, this.promptTurn);
      this.pushSource(this.secretSources, {
        kind: "secret",
        tool: input.tool,
        label: classified.secretLabel ?? redact(input.tool),
        turn: this.promptTurn,
      });
    }
    if (classified.injection) {
      injectionArmed = true;
      this.injectionCount++;
      this.maxInjectionTurn = Math.max(this.maxInjectionTurn, this.promptTurn);
      this.pushSource(this.injectionSources, {
        kind: "injection",
        tool: input.tool,
        label: classified.injectionLabel ?? redact(input.tool),
        turn: this.promptTurn,
        ...(classified.injectionPattern ? { pattern: classified.injectionPattern } : {}),
      });
    }

    return {
      untrustedAdded,
      secretAdded,
      injectionArmed,
      ...(classified.injectionLabel ? { injectionSource: classified.injectionLabel } : {}),
      ...(classified.injectionPattern ? { injectionPattern: classified.injectionPattern } : {}),
    };
  }

  /** Gate 1: prospectively check a tool call before dispatch against active session taint and call-scoped rulings. */
  checkSink(options: TaintCheckOptions): TaintCheckResult {
    const { tool, input, cwd, config, ephemeralRoots, hostPaths, exemptRules = [] } = options;
    if (!config.enabled) return { decision: "allow", hold: false, sources: [] };
    const sink = classifyTaintSink({ tool, input, cwd, allowHosts: config.allowHosts, ephemeralRoots, hostPaths });
    if (!sink) return { decision: "allow", hold: false, sources: [] };

    const exempt = new Set(exemptRules);
    const hasUntrusted = this.untrustedCount > 0;
    const hasSecret = this.secretCount > 0;
    const hasInjection = this.injectionCount > 0;

    // Rule 1: suspected prompt injection blocks every egress/mutation sink until user confirms.
    if (hasInjection && config.holdInjectionEgress && !exempt.has("taint-injection-egress")) {
      if (this.tryConsumeRuling(sink, this.maxInjectionTurn)) {
        return { decision: "allow", hold: false, sink, sources: this.injectionSources.map(s => s.label), rulingApplied: true };
      }
      return {
        decision: "hold",
        hold: true,
        id: "taint-injection-egress",
        label: `prompt-injection taint before ${sink.label}`,
        reason: formatHoldReason("taint-injection-egress", sink, this.untrustedSources, this.secretSources, this.injectionSources),
        sink,
        sources: this.injectionSources.map(s => s.label),
        jevDeclassifiable: false,
      };
    }

    // Rule 2: Lethal Trifecta (untrusted + secret -> any egress/mutation sink).
    if (hasUntrusted && hasSecret && config.holdTrifecta && !exempt.has("taint-lethal-trifecta")) {
      const taintTurn = Math.max(this.maxUntrustedTurn, this.maxSecretTurn);
      if (this.tryConsumeRuling(sink, taintTurn)) {
        return {
          decision: "allow",
          hold: false,
          sink,
          sources: [...this.untrustedSources.map(s => s.label), ...this.secretSources.map(s => s.label)],
          rulingApplied: true,
        };
      }
      return {
        decision: "hold",
        hold: true,
        id: "taint-lethal-trifecta",
        label: `untrusted + secret taint before ${sink.label}`,
        reason: formatHoldReason("taint-lethal-trifecta", sink, this.untrustedSources, this.secretSources, this.injectionSources),
        sink,
        sources: [...this.untrustedSources.map(s => s.label), ...this.secretSources.map(s => s.label)],
        jevDeclassifiable: isJevDeclassifiableSink(sink.kind),
      };
    }

    // Rule 3: direct secret egress (secret -> http-exfil, pkg-publish, or external-write).
    if (
      hasSecret
      && config.holdSecretEgress
      && (sink.kind === "http-exfil" || sink.kind === "pkg-publish" || sink.kind === "external-write")
      && !exempt.has("taint-secret-egress")
    ) {
      if (this.tryConsumeRuling(sink, this.maxSecretTurn)) {
        return { decision: "allow", hold: false, sink, sources: this.secretSources.map(s => s.label), rulingApplied: true };
      }
      return {
        decision: "hold",
        hold: true,
        id: "taint-secret-egress",
        label: `secret taint before ${sink.label}`,
        reason: formatHoldReason("taint-secret-egress", sink, this.untrustedSources, this.secretSources, this.injectionSources),
        sink,
        sources: this.secretSources.map(s => s.label),
        jevDeclassifiable: false,
      };
    }

    // Rule 4: untrusted-only HTTP write warns without holding; routine git push / gh mutate stays unblocked.
    if (
      hasUntrusted
      && !hasSecret
      && !hasInjection
      && config.warnUntrustedHttpWrite
      && sink.kind === "http-exfil"
      && !exempt.has("taint-untrusted-egress")
    ) {
      return {
        decision: "warn",
        hold: false,
        id: "taint-untrusted-egress",
        label: `untrusted external input before ${sink.label}`,
        reason: formatHoldReason("taint-untrusted-egress", sink, this.untrustedSources, this.secretSources, this.injectionSources),
        sink,
        sources: this.untrustedSources.map(s => s.label),
        jevDeclassifiable: false,
      };
    }

    return { decision: "allow", hold: false, sink, sources: [] };
  }

  noteHeld(): void {
    this.heldCount++;
  }

  noteWarned(): void {
    this.warnedCount++;
  }

  noteDeclassified(): void {
    this.declassifiedCount++;
  }

  hasActivity(): boolean {
    return this.untrustedCount > 0
      || this.secretCount > 0
      || this.injectionCount > 0
      || this.heldCount > 0
      || this.warnedCount > 0
      || this.declassifiedCount > 0;
  }

  snapshot(): TaintSnapshot {
    return {
      promptTurn: this.promptTurn,
      untrustedCount: this.untrustedCount,
      secretCount: this.secretCount,
      injectionCount: this.injectionCount,
      heldCount: this.heldCount,
      warnedCount: this.warnedCount,
      declassifiedCount: this.declassifiedCount,
      rulingsGranted: this.rulingsGranted,
      sources: {
        untrusted: [...this.untrustedSources],
        secret: [...this.secretSources],
        injection: [...this.injectionSources],
      },
    };
  }

  private pushSource(list: TaintSourceEvent[], event: TaintSourceEvent): void {
    if (list.length >= MAX_SOURCE_HISTORY) list.shift();
    list.push(event);
  }

  private tryConsumeRuling(sink: TaintSinkClassification, maxTaintedTurn: number): boolean {
    // Only a user prompt arriving strictly after the tainting turn can grant a single-use call ruling.
    if (this.promptTurn <= maxTaintedTurn) return false;
    const key = `${this.promptTurn}:${sink.kind}`;
    if (this.consumedRulings.has(key)) return false;
    if (!promptAuthorizesSink(this.latestPrompt, sink)) return false;
    this.consumedRulings.add(key);
    this.rulingsGranted++;
    return true;
  }
}

export function formatTaintStatus(snapshot: TaintSnapshot): string {
  const axes: string[] = [];
  if (snapshot.untrustedCount > 0) axes.push(`untrusted (${snapshot.untrustedCount})`);
  if (snapshot.secretCount > 0) axes.push(`secret (${snapshot.secretCount})`);
  if (snapshot.injectionCount > 0) axes.push(`injection (${snapshot.injectionCount})`);

  const actions: string[] = [];
  if (snapshot.heldCount > 0) actions.push(`${snapshot.heldCount} sink${snapshot.heldCount === 1 ? "" : "s"} held`);
  if (snapshot.declassifiedCount > 0) actions.push(`${snapshot.declassifiedCount} declassified by Jev`);
  if (snapshot.warnedCount > 0) actions.push(`${snapshot.warnedCount} warned`);
  if (snapshot.rulingsGranted > 0) actions.push(`${snapshot.rulingsGranted} user ruling${snapshot.rulingsGranted === 1 ? "" : "s"}`);

  if (axes.length === 0 && actions.length === 0) return "Taint: clean.";
  const left = axes.length ? axes.join(", ") : "clean";
  return actions.length ? `Taint: ${left} · ${actions.join(" · ")}.` : `Taint: ${left}.`;
}
