import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { choice, noul, TypeSafeIntegrationError } from "pi-typesafe";
import type { IntegrationErrorCode, TypeSafe } from "pi-typesafe";
import type { ActionGuardConfig } from "./config.js";
import { redact } from "./redact.js";

export type Level = "allow" | "warn" | "confirm";
export type Severity = "destructive" | "risky" | "sensitive";

export interface PatternHit {
  id: string;
  severity: Severity;
  /** Short human label; never contains the matched text. */
  label: string;
}

export interface ActionInput {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  /** Latest user request, used to judge whether the action is on task. */
  task?: string | undefined;
}

/** Redacted, truncated view of a tool call. This object is what leaves the machine. */
export interface ActionSummary {
  tool: string;
  command?: string;
  path?: string;
  location?: "inside_project" | "outside_project";
  exists?: boolean;
  bytes?: number;
  excerpt?: string;
  editCount?: number;
  edits?: Array<{ oldText: string; newText: string }>;
  input?: string;
}

export type ScopeLabel = "expected_step" | "plausible_side_step" | "unrelated" | "unclear";

export interface Judgment {
  irreversible: number;
  offTask: number;
  scope: ScopeLabel;
  scopeConfidence: number;
  model: string;
  elapsedMs: number;
}

export interface Verdict {
  level: Level;
  source: "skipped" | "read-only" | "pattern" | "typesafe" | "error";
  summary: ActionSummary;
  patterns: PatternHit[];
  /** Human-readable reasons without secrets or full commands. */
  reasons: string[];
  judgment?: Judgment;
  /** Safe TypeSafe error message when the judge could not answer. */
  error?: string;
  errorCode?: IntegrationErrorCode;
}

/** The subset of pi-typesafe's client the guard needs; tests supply a fake. */
export type Judge = Pick<TypeSafe, "evaluate">;

export interface EvaluateOptions {
  config: ActionGuardConfig;
  /** Omit to run offline pattern checks only (no consent, no network). */
  judge?: Judge | undefined;
  signal?: AbortSignal | undefined;
}

const LEVEL_RANK: Record<Level, number> = { allow: 0, warn: 1, confirm: 2 };
const higher = (a: Level, b: Level): Level => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

const TASK_LIMIT = 1500;
const COMMAND_LIMIT = 2000;
const EXCERPT_LIMIT = 600;
const EDIT_LIMIT = 200;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more chars]`;
}

// ---------------------------------------------------------------------------
// Pattern pass: cheap, offline, deliberately narrow. Jev supplies the judgment; this is the floor.

interface Rule { id: string; severity: Severity; label: string; test: RegExp }

const SHELL_RULES: Rule[] = [
  { id: "git-force-push", severity: "destructive", label: "git force push", test: /\bgit\s+push\b[^\n;&|]*\s(?:-f|--force)(?![-\w])/ },
  { id: "git-force-with-lease", severity: "risky", label: "git push --force-with-lease", test: /\bgit\s+push\b[^\n;&|]*--force-with-lease/ },
  { id: "git-reset-hard", severity: "destructive", label: "git reset --hard", test: /\bgit\s+reset\b[^\n;&|]*--hard/ },
  { id: "git-clean", severity: "destructive", label: "git clean (removes untracked files)", test: /\bgit\s+clean\b[^\n;&|]*\s-[a-zA-Z]*[fFxX]/ },
  { id: "git-checkout-discard", severity: "risky", label: "git checkout/restore discards working changes", test: /\bgit\s+checkout\s+(?:--\s+\S|(?:\.|\*)(?=\s|$))|\bgit\s+restore\b(?:(?![^\n;&|]*--staged)|(?=[^\n;&|]*(?:--worktree|\s-\w*W)))/ },
  { id: "git-branch-force-delete", severity: "risky", label: "git branch -D", test: /\bgit\s+branch\b[^\n;&|]*\s-D\b/ },
  { id: "git-stash-drop", severity: "risky", label: "git stash drop/clear", test: /\bgit\s+stash\s+(?:drop|clear)\b/ },
  { id: "sql-drop", severity: "destructive", label: "SQL DROP", test: /\bdrop\s+(?:table|database|schema|index|view|user|role)\b/i },
  { id: "sql-truncate", severity: "destructive", label: "SQL TRUNCATE", test: /\btruncate\s+(?:table\s+)?\w/i },
  { id: "sql-delete", severity: "destructive", label: "SQL DELETE FROM", test: /\bdelete\s+from\s+\w/i },
  { id: "block-device-write", severity: "destructive", label: "write to a block device", test: /(?:\bdd\b[^\n;&|]*\bof=\/dev\/|>\s*\/dev\/(?:sd|hd|nvme|disk|mmcblk|vd)|\bmkfs(?:\.\w+)?\b|\bwipefs\b|\bfdisk\b|\bparted\b)/ },
  { id: "chmod-777", severity: "destructive", label: "chmod -R 777", test: /\bchmod\b[^\n;&|]*\s-[a-zA-Z]*R[a-zA-Z]*\s+[0-7]*777\b|\bchmod\b[^\n;&|]*\s777\s+[^\n;&|]*\s-[a-zA-Z]*R/ },
  { id: "fork-bomb", severity: "destructive", label: "fork bomb", test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: "remote-script-exec", severity: "destructive", label: "pipe remote script into a shell", test: /\b(?:curl|wget)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/ },
  { id: "kill-all", severity: "destructive", label: "kill every process", test: /\bkill\s+(?:-\w+\s+)*-1\b|\bkillall5\b/ },
  { id: "power", severity: "destructive", label: "shutdown/reboot", test: /(?:^|[;&|(]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff)\b/m },
  { id: "npm-publish", severity: "destructive", label: "publish a package", test: /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/ },
  { id: "infra-destroy", severity: "destructive", label: "destroy infrastructure", test: /\b(?:terraform|tofu|pulumi)\s+destroy\b|\bkubectl\s+delete\b|\bhelm\s+(?:uninstall|delete)\b|\bdocker\s+(?:system\s+prune|volume\s+rm|rm\s+-[a-z]*f)/ },
  { id: "find-delete", severity: "risky", label: "find -delete / -exec rm", test: /\bfind\b[^\n;&|]*(?:-delete\b|-exec\w*\s+rm\b)/ },
  { id: "sudo", severity: "risky", label: "sudo", test: /(?:^|[\s;&|(])sudo\s/ },
];

const SENSITIVE_PATH = /(?:^|[\s/"'=:(])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w.-]+)?(?=$|[\s"';|&)])|(?:^|[\s"'=:/~])\.?(?:ssh\/(?:id_\w+|authorized_keys|known_hosts)|aws\/credentials|gnupg\/|netrc\b|npmrc\b|pypirc\b|docker\/config\.json|kube\/config\b|pi\/agent\/auth\.json|pi\/agent\/pi-typesafe\/auth\.json)|\b\w+\.(?:pem|p12|pfx|keystore|jks)\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i;

function splitShell(command: string): string[] {
  return command.split(/\n|;|&&|\|\||\||&/).map(part => part.trim()).filter(Boolean);
}

/** rm with both recursive and force flags. Absolute, home, variable, or wildcard targets are destructive; relative ones are risky. */
function classifyRm(segment: string, cwd?: string): PatternHit | undefined {
  const match = /(?:^|\s)rm\s+(.*)$/.exec(segment);
  if (!match) return undefined;
  const tokens = match[1]!.split(/\s+/).filter(Boolean);
  const flags = tokens.filter(token => token.startsWith("-"));
  const targets = tokens.filter(token => !token.startsWith("-"));
  const recursive = flags.some(flag => flag === "--recursive" || (/^-[a-zA-Z]+$/.test(flag) && /[rR]/.test(flag)));
  const force = flags.some(flag => flag === "--force" || (/^-[a-zA-Z]+$/.test(flag) && flag.includes("f")));
  if (!recursive) return undefined;
  const dangerousTarget = targets.some(target => {
    const clean = target.replace(/^["']|["']$/g, "");
    if (clean === "/" || clean === "~" || clean === "*" || clean === "." || clean === ".." || clean.startsWith("~/") || clean.startsWith("$") || clean.startsWith("/*") || clean === "./" || clean === "../") return true;
    if (isAbsolute(clean)) return cwd ? !isInside(clean, cwd) : true;
    return clean.split(/[\\/]/).includes("..");
  });
  if (dangerousTarget) return { id: "rm-recursive-dangerous-target", severity: "destructive", label: "recursive rm on an absolute, home, variable, or parent path" };
  if (force) return { id: "rm-rf", severity: "risky", label: "rm -rf on a project path" };
  return { id: "rm-recursive", severity: "risky", label: "recursive rm" };
}

function isInside(target: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function matchPatterns(tool: string, input: Record<string, unknown>, cwd?: string): PatternHit[] {
  const hits = new Map<string, PatternHit>();
  const add = (hit: PatternHit | undefined) => { if (hit && !hits.has(hit.id)) hits.set(hit.id, hit); };
  const command = typeof input.command === "string" ? input.command : undefined;
  if (command) {
    for (const rule of SHELL_RULES) if (rule.test.test(command)) add({ id: rule.id, severity: rule.severity, label: rule.label });
    for (const segment of splitShell(command)) add(classifyRm(segment, cwd));
    if (SENSITIVE_PATH.test(command)) add({ id: "sensitive-path", severity: "sensitive", label: "touches a secrets or credentials file" });
  }
  const path = typeof input.path === "string" ? input.path : undefined;
  if (path && SENSITIVE_PATH.test(path)) add({ id: "sensitive-path", severity: "sensitive", label: "touches a secrets or credentials file" });
  return [...hits.values()];
}

// ---------------------------------------------------------------------------
// Read-only shell detection: a latency optimisation, not a security boundary. Runs only when no pattern matched.

const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "grep", "rg", "egrep", "fgrep", "ag", "find", "fd", "pwd", "echo", "printf", "which", "whereis", "type",
  "file", "stat", "du", "df", "tree", "diff", "sort", "uniq", "cut", "tr", "cd", "true", "false", "test", "[", "date", "basename", "dirname", "realpath",
  "readlink", "jq", "column", "nl", "strings", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "hexdump", "xxd", "od", "uname", "hostname", "whoami", "id", "uptime",
]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "grep", "cat-file", "rev-list", "name-rev"]);

export function isReadOnlyCommand(command: string): boolean {
  if (!command.trim() || /\$\(|`/.test(command)) return false;
  const stripped = command.replace(/\d?>\s*&\s*\d/g, "").replace(/&?\d?>\s*\/dev\/null/g, "");
  if (stripped.includes(">")) return false;
  for (const segment of splitShell(stripped)) {
    const tokens = segment.split(/\s+/);
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
    const head = tokens[index];
    if (!head) return false;
    if (head === "git") {
      const rest = tokens.slice(index + 1).join(" ");
      const sub = tokens[index + 1];
      if (!sub) return false;
      if (sub === "branch") { if (/\s-[a-zA-Z]*[dDmMcCu]|--(?:delete|move|copy|set-upstream|unset-upstream|edit-description)/.test(` ${rest}`)) return false; continue; }
      if (sub === "remote") { if (tokens.slice(index + 2).some(token => !token.startsWith("-"))) return false; continue; }
      if (sub === "tag") { if (!tokens.slice(index + 2).every(token => token === "-l" || token === "--list" || token.startsWith("-n"))) return false; continue; }
      if (sub === "config") { if (!/--get|--list|-l\b/.test(rest)) return false; continue; }
      if (!READ_ONLY_GIT.has(sub)) return false;
      continue;
    }
    if (head === "find" && /-(?:delete|exec\w*|ok\w*|fprint\w*|fls)\b/.test(segment)) return false;
    if (!READ_ONLY_COMMANDS.has(head)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Action summary: what is shown to the user and what is sent to TypeSafe.

function displayPath(target: string, cwd: string): { path: string; location: "inside_project" | "outside_project" } {
  const absolute = resolve(cwd, target);
  if (isInside(absolute, cwd)) {
    const rel = relative(resolve(cwd), absolute);
    return { path: rel === "" ? "." : rel.split(sep).join("/"), location: "inside_project" };
  }
  const home = homedir();
  const shown = absolute === home || absolute.startsWith(home + sep) ? `~${absolute.slice(home.length)}` : absolute;
  return { path: shown, location: "outside_project" };
}

export function describeAction(tool: string, input: Record<string, unknown>, cwd: string): ActionSummary {
  const summary: ActionSummary = { tool };
  if (typeof input.command === "string") summary.command = redact(truncate(input.command, COMMAND_LIMIT));
  if (typeof input.path === "string" && input.path.trim()) {
    const shown = displayPath(input.path, cwd);
    summary.path = shown.path;
    summary.location = shown.location;
    summary.exists = existsSync(resolve(cwd, input.path));
  }
  if (tool === "write" && typeof input.content === "string") {
    summary.bytes = Buffer.byteLength(input.content, "utf8");
    summary.excerpt = redact(truncate(input.content, EXCERPT_LIMIT));
  }
  if (tool === "edit" && Array.isArray(input.edits)) {
    summary.editCount = input.edits.length;
    summary.edits = input.edits.slice(0, 3).map(edit => {
      const item = (edit ?? {}) as { oldText?: unknown; newText?: unknown };
      return {
        oldText: redact(truncate(typeof item.oldText === "string" ? item.oldText : "", EDIT_LIMIT)),
        newText: redact(truncate(typeof item.newText === "string" ? item.newText : "", EDIT_LIMIT)),
      };
    });
  }
  if (summary.command === undefined && summary.path === undefined) summary.input = redact(truncate(JSON.stringify(input), COMMAND_LIMIT));
  return summary;
}

// ---------------------------------------------------------------------------
// TypeSafe request: named state fields, three independent questions.

export const questions = {
  irreversible: noul(
    "Would executing `action` destroy, overwrite, or discard data or state that could not be recovered afterwards?",
    {
      true: "Yes: it force-pushes or rewrites shared history, deletes untracked or uncommitted work, drops or truncates database objects, overwrites files outside the project, publishes or deploys, or removes something no build or checkout can regenerate.",
      false: "No: it only reads, builds, tests, or creates new files, or it deletes generated output, caches, or temporary files that a build or checkout can recreate, or it is a change `task` explicitly asked for.",
    },
  ),
  off_task: noul(
    "Is `action` outside the scope of what `task` asks for?",
    {
      true: "Yes: `task` does not call for this action, and it is not a normal preparatory, verification, or cleanup step for `task`.",
      false: "No: `action` is a direct or reasonable step toward completing `task`.",
    },
  ),
  scope: choice("How does `action` relate to `task`?", {
    expected_step: "A step that `task` directly requires",
    plausible_side_step: "Reasonable preparation, inspection, verification, or cleanup while doing `task`",
    unrelated: "Not connected to `task`",
    unclear: "`task` or `action` gives too little information to tell",
  }),
};

export function buildRequest(summary: ActionSummary, task: string | undefined) {
  return {
    state: {
      task: task?.trim() ? truncate(task.trim(), TASK_LIMIT) : "(no user request recorded in this session)",
      action: summary as unknown as Record<string, string | number | boolean>,
    },
    questions,
  };
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const percent = (value: number) => value.toFixed(2);

// ---------------------------------------------------------------------------

export async function evaluateAction(action: ActionInput, options: EvaluateOptions): Promise<Verdict> {
  const { config, judge } = options;
  const summary = describeAction(action.tool, action.input, action.cwd);
  if (!config.enabled || !config.tools.includes(action.tool)) {
    return { level: "allow", source: "skipped", summary, patterns: [], reasons: [] };
  }
  const patterns = matchPatterns(action.tool, action.input, action.cwd);
  const reasons: string[] = [];
  let level: Level = "allow";
  for (const hit of patterns) {
    level = higher(level, hit.severity === "destructive" ? "confirm" : "warn");
    reasons.push(`${hit.severity}: ${hit.label}`);
  }
  if (summary.location === "outside_project") {
    if (action.tool === "write" && summary.exists) {
      level = higher(level, "confirm");
      reasons.push("overwrites an existing file outside the project");
    } else {
      level = higher(level, "warn");
      reasons.push(`${action.tool === "write" ? "creates" : "changes"} a file outside the project`);
    }
  }
  if (action.tool === "bash" && patterns.length === 0 && typeof action.input.command === "string" && isReadOnlyCommand(action.input.command)) {
    return { level, source: "read-only", summary, patterns, reasons };
  }
  if (!judge) return { level, source: "pattern", summary, patterns, reasons };

  try {
    const result = await judge.evaluate(buildRequest(summary, action.task), { signal: combineSignals(config.timeoutMs, options.signal) });
    const judgment: Judgment = {
      irreversible: result.answers.irreversible.noul,
      offTask: result.answers.off_task.noul,
      scope: result.answers.scope.choice,
      scopeConfidence: result.answers.scope.confidence,
      model: result.model,
      elapsedMs: result.elapsedMs,
    };
    if (judgment.irreversible >= config.irreversible.confirm) {
      level = higher(level, "confirm");
      reasons.push(`irreversible ${percent(judgment.irreversible)}`);
    } else if (judgment.irreversible >= config.irreversible.warn) {
      level = higher(level, "warn");
      reasons.push(`possibly irreversible ${percent(judgment.irreversible)}`);
    }
    if (judgment.offTask >= config.offTask.confirm && judgment.scope === "unrelated") {
      level = higher(level, "confirm");
      reasons.push(`off-task ${percent(judgment.offTask)} (unrelated to the request)`);
    } else if (judgment.offTask >= config.offTask.warn) {
      level = higher(level, "warn");
      reasons.push(`off-task ${percent(judgment.offTask)} (${judgment.scope.replace(/_/g, " ")})`);
    }
    return { level, source: "typesafe", summary, patterns, reasons, judgment };
  } catch (error) {
    const known = error instanceof TypeSafeIntegrationError ? error : undefined;
    const message = known?.message ?? "TypeSafe request failed.";
    if (!config.failOpen) {
      level = higher(level, "confirm");
      reasons.push("TypeSafe unavailable and failOpen is false");
    } else {
      reasons.push("TypeSafe unavailable; allowed by failOpen");
    }
    return { level, source: "error", summary, patterns, reasons, error: message, ...(known ? { errorCode: known.code } : {}) };
  }
}

/** One-line rendering for widgets and logs. Includes no command text. */
export function formatVerdict(verdict: Verdict): string {
  const parts = [`warden · ${verdict.summary.tool}`];
  if (verdict.judgment) parts.push(`irreversible ${percent(verdict.judgment.irreversible)}`, `off-task ${percent(verdict.judgment.offTask)}`, verdict.judgment.scope.replace(/_/g, " "));
  if (verdict.patterns.length) parts.push(`patterns: ${verdict.patterns.map(hit => hit.id).join(", ")}`);
  if (verdict.source === "error") parts.push("typesafe error");
  if (verdict.source === "read-only") parts.push("read-only");
  parts.push(verdict.level);
  return parts.join(" · ");
}
