/**
 * `/warden index` command: builds a local capability index that the conscience
 * uses instead of bare names and descriptions. The session model writes the
 * entries in a fixed format; the extension validates and sanitizes them.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { sanitizeDescription } from "./conscience.js";
import type { CapabilityRole } from "./conscience.js";
import { fileContentHash, toolSourceHash } from "./hashing.js";

export { fileContentHash, toolSourceHash } from "./hashing.js";

/* ─── Types ─────────────────────────────────────────────────────────── */

export type SourceQuality = "strong" | "weak" | "thin";

export interface IndexEntry {
  kind: "skill" | "tool";
  name: string;
  scope: "global" | "project";
  sourceHash: string;
  role: CapabilityRole;
  lead: string;
  useWhen: string[];
  notWhen: string[];
  inputs: string;
  examples: string[];
  thin: boolean;
  sourceQuality: SourceQuality;
  /** One sentence, at most 20 words, saying what the description lacks. Present for weak/thin entries. */
  improve?: string;
  /** True when the entry was truncated at a bullet boundary. */
  truncated?: boolean;
  /** Advertised location — kept local-only, never copied into judge state. */
  _location?: string;
}

export interface IndexFile {
  formatVersion: 1;
  builtAt: string;
  model: string;
  entries: IndexEntry[];
}

/* ─── Path resolution ───────────────────────────────────────────────── */

/** Resolve Pi's agent directory (mirrors config.ts userConfigPath logic). */
function resolveAgentDir(): string {
  const configured = process.env.PI_WARDEN_INDEX_DIR?.trim()
    ?? process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    const expanded = configured === "~" || configured.startsWith("~/")
      ? join(homedir(), configured.slice(1))
      : configured;
    return expanded;
  }
  return join(homedir(), ".pi", "agent");
}

export function indexPath(kind: "global" | "project", projectRoot?: string): string {
  const base = join(resolveAgentDir(), "pi-warden", "index");
  if (kind === "global") return join(base, "global.json");
  // Project index keyed by first 12 hex chars of SHA-256(projectRoot)
  const hash = createHash("sha256").update(projectRoot ?? "").digest("hex").slice(0, 12);
  return join(base, "projects", `${hash}.json`);
}

export function ensureIndexDir(kind: "global" | "project"): void {
  const dir = kind === "global"
    ? join(resolveAgentDir(), "pi-warden", "index")
    : join(resolveAgentDir(), "pi-warden", "index", "projects");
  mkdirSync(dir, { recursive: true });
}

/* ─── Content hashing ───────────────────────────────────────────────── */

/** Compute a sourceHash for a skill from its file content. */
export function skillSourceHash(skill: Skill): string {
  return fileContentHash(skill.filePath);
}

/* ─── Index I/O ─────────────────────────────────────────────────────── */

export function readIndex(filePath: string): IndexFile | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isIndexFile(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeIndex(filePath: string, index: IndexFile): void {
  ensureIndexDir(filePath.includes("/projects/") ? "project" : "global");
  writeFileSync(filePath, JSON.stringify(index, null, 2), "utf8");
}

function isIndexFile(value: unknown): value is IndexFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.formatVersion === 1
    && typeof obj.builtAt === "string"
    && typeof obj.model === "string"
    && Array.isArray(obj.entries);
}

/* ─── Validation and sanitization ───────────────────────────────────── */

/** Max serialized characters per entry. */
const MAX_ENTRY_CHARS = 700;

const VALID_ROLES: ReadonlySet<string> = new Set(["research", "evidence", "execution", "delegation", "review", "conversation"]);
const VALID_SOURCE_QUALITY: ReadonlySet<string> = new Set(["strong", "weak", "thin"]);
const MAX_IMPROVE_CHARS = 200;

/** Validate a single entry; returns the sanitized entry or null on failure. */
export function validateEntry(entry: unknown): IndexEntry | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (e.kind !== "skill" && e.kind !== "tool") return null;
  if (typeof e.name !== "string" || !e.name) return null;
  if (e.scope !== "global" && e.scope !== "project") return null;
  if (typeof e.sourceHash !== "string") return null;
  if (typeof e.role !== "string" || !VALID_ROLES.has(e.role)) return null;
  if (typeof e.lead !== "string" || !e.lead) return null;
  if (!Array.isArray(e.useWhen) || e.useWhen.length < 2 || e.useWhen.length > 4) return null;
  if (!Array.isArray(e.notWhen)) return null;
  if (typeof e.inputs !== "string") return null;
  if (!Array.isArray(e.examples) || e.examples.length < 2 || e.examples.length > 3) return null;
  // sourceQuality: absent defaults to strong; any other invalid value rejects the entry
  if (e.sourceQuality !== undefined && (typeof e.sourceQuality !== "string" || !VALID_SOURCE_QUALITY.has(e.sourceQuality))) return null;
  const sq: SourceQuality = typeof e.sourceQuality === "string" ? e.sourceQuality as SourceQuality : "strong";
  // thin boolean must equal sourceQuality === "thin"
  const thin = sq === "thin";
  // improve: optional string, capped at MAX_IMPROVE_CHARS, required for weak/thin
  let improve: string | undefined;
  if (sq === "weak" || sq === "thin") {
    improve = typeof e.improve === "string" ? sanitizeDescription(String(e.improve)).slice(0, MAX_IMPROVE_CHARS) : "";
  }
  const sanitized: IndexEntry = {
    kind: e.kind,
    name: String(e.name),
    scope: e.scope,
    sourceHash: String(e.sourceHash),
    role: e.role as CapabilityRole,
    lead: sanitizeDescription(String(e.lead)),
    useWhen: (e.useWhen as unknown[]).map(s => sanitizeDescription(String(s))),
    notWhen: (e.notWhen as unknown[]).map(s => sanitizeDescription(String(s))),
    inputs: sanitizeDescription(String(e.inputs)),
    examples: (e.examples as unknown[]).map(s => sanitizeDescription(String(s))),
    thin,
    sourceQuality: sq,
  };
  if (improve) sanitized.improve = improve;
  if (e._location) sanitized._location = String(e._location);
  // Check serialized size
  const serialized = JSON.stringify(sanitized);
  if (serialized.length > MAX_ENTRY_CHARS) {
    // Truncate at a bullet boundary
    const truncated = truncateEntry(sanitized);
    if (truncated) return truncated;
    return null; // Could not truncate sensibly
  }
  return sanitized;
}

/** Truncate an entry at a bullet boundary (end of a useWhen or notWhen item). */
function truncateEntry(entry: IndexEntry): IndexEntry | null {
  // Build the most-reduced base: no notWhen, minimum useWhen
  const base = {
    ...entry,
    notWhen: [] as string[],
    useWhen: entry.useWhen.slice(0, 2),
  };
  // Account for the truncated flag that will be added (~17 chars)
  if (JSON.stringify(base).length + 18 <= MAX_ENTRY_CHARS) {
    base.truncated = true;
    return base;
  }
  // Try removing useWhen items one by one from the minimum
  const useWhenArr = [...base.useWhen];
  while (useWhenArr.length > 2) {
    useWhenArr.pop();
    const trial = { ...base, useWhen: useWhenArr, truncated: true };
    if (JSON.stringify(trial).length <= MAX_ENTRY_CHARS) {
      return trial;
    }
  }
  // Last resort: truncate examples on the reduced base
  const exArr = [...entry.examples];
  while (exArr.length > 2) {
    exArr.pop();
    const trial = { ...base, examples: exArr, truncated: true };
    if (JSON.stringify(trial).length <= MAX_ENTRY_CHARS) {
      return trial;
    }
  }
  return null;
}

/** Validate an entire index file. Returns the validated file or undefined on failure. */
export function validateIndex(raw: unknown): IndexFile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.formatVersion !== 1) return undefined;
  if (typeof obj.builtAt !== "string") return undefined;
  if (typeof obj.model !== "string") return undefined;
  if (!Array.isArray(obj.entries)) return undefined;
  const entries: IndexEntry[] = [];
  let truncatedCount = 0;
  for (const entry of obj.entries) {
    const validated = validateEntry(entry);
    if (validated) {
      entries.push(validated);
      if (validated.truncated) truncatedCount++;
    } else {
      // Invalid entry: reject entire file
      return undefined;
    }
  }
  return { formatVersion: 1, builtAt: obj.builtAt, model: obj.model, entries };
}

export interface SourceQualityReport {
  name: string;
  kind: "skill" | "tool";
  sourceQuality: SourceQuality;
  improve: string;
}

export function indexStats(index: IndexFile): { globalEntries: number; projectEntries: number; thinSources: string[]; truncatedCount: number; sourceQualityReport: SourceQualityReport[] } {
  let globalEntries = 0;
  let projectEntries = 0;
  const thinSources: string[] = [];
  let truncatedCount = 0;
  const sourceQualityReport: SourceQualityReport[] = [];
  for (const entry of index.entries) {
    if (entry.scope === "global") globalEntries++;
    else projectEntries++;
    if (entry.thin) thinSources.push(entry.name);
    if (entry.truncated) truncatedCount++;
    if (entry.sourceQuality === "weak" || entry.sourceQuality === "thin") {
      sourceQualityReport.push({ name: entry.name, kind: entry.kind, sourceQuality: entry.sourceQuality, improve: entry.improve ?? "" });
    }
  }
  return { globalEntries, projectEntries, thinSources, truncatedCount, sourceQualityReport };
}

/* ─── Prompt builder ─────────────────────────────────────────────────── */

/** The writing-for-agents rules the prompt includes as instructions. */
const WRITING_RULES = `## Entry writing rules
- Front-load the leading word so the trigger is the first word of \`lead\`.
- One trigger per bullet; synonyms collapsed.
- Cut what the name already carries from descriptions.
- State the target behaviour positively; use a prohibition only as a guardrail paired with the positive alternative.
- Keep entries short: they are always-loaded material.`;

/**
 * Build the user message that asks the session model to produce index entries.
 * The prompt includes the format spec, writing rules, and both absolute output paths.
 */
export function buildIndexPrompt(
  cwd: string,
  skills: Array<{ name: string; description: string; filePath: string }>,
  tools: Array<{ name: string; description: string }>,
  outputPaths: { global: string; project: string },
): string {
  const skillLines = skills.map(s => `- ${s.name}: ${s.description} (file: ${s.filePath})`).join("\n");
  const toolLines = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");

  return [
    "# Build a capability index",
    "",
    "You are building a local capability index. Write valid JSON only.",
    "",
    "## Skills",
    skillLines || "(none)",
    "",
    "## Tools",
    toolLines || "(none)",
    "",
    WRITING_RULES,
    "",
    "## Format",
    "",
    "Write each file as an object with only an `entries` array (the tool adds metadata):",
    "",
    "```json",
    "{",
    '  "entries": [',
    "    {",
    '      "kind": "skill" | "tool",',
    '      "name": "<skill or tool name>",',
    '      "scope": "global" | "project",',
    '      "sourceHash": "<first 16 hex chars of SHA-256 of the skill file content; for tools, SHA-256 of name:description>",',
    '      "role": "<one of: research, evidence, execution, delegation, review, conversation>",',
    '      "lead": "<at most 12 words; first word is the trigger>",',
    '      "useWhen": ["<situation 1>", "<situation 2>"] (2-4 bullets, each starting with the situation),',
    '      "notWhen": ["<situation> do <alternative>"] (0-2 bullets, each ending with what to do instead),',
    '      "inputs": "<one line describing what it needs>",',
    '      "examples": ["<prompt phrasing 1>", "<prompt phrasing 2>"] (2-3 phrasings a user would type),',
    '      "thin": true when the source description is under 80 characters or the skill body under 300 characters,',
    '      "sourceQuality": "strong" | "weak" | "thin",',
    '      "improve": "<one sentence, at most 20 words, saying what the description lacks>" (only for weak or thin entries)',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "## Scope",
    "- Skills from ~/.pi/agent/skills/ and user-level directories: scope `global`",
    "- Skills from the project directory: scope `project`",
    "- All tools: scope `global`",
    "",
    "## Roles",
    "Choose exactly one role per entry:",
    "- `research`: finds information outside the repo (web search, docs fetch)",
    "- `evidence`: inspects the repo or runtime (code graph, traces, reads)",
    "- `execution`: changes or runs things",
    "- `delegation`: spawns or manages agents",
    "- `review`: judges or checks work",
    "- `conversation`: thinking, planning, clarifying",
    "",
    "## Output paths",
    "",
    `Global index: ${outputPaths.global}`,
    `Project index: ${outputPaths.project}`,
    "",
    "Write one file per scope. The tool adds `formatVersion`, `builtAt`, and `model` metadata after validation.",
    "Write valid JSON only. No markdown, no explanation, no code fences.",
  ].join("\n");
}

/* ─── Index lookup for conscience ────────────────────────────────────── */

/** Find an index entry by name and sourceHash. */
export function findEntry(
  name: string,
  sourceHash: string,
  globalIndex: IndexFile | undefined,
  projectIndex: IndexFile | undefined,
): IndexEntry | undefined {
  const search = (index: IndexFile | undefined): IndexEntry | undefined => {
    if (!index) return undefined;
    return index.entries.find(e => e.name === name && e.sourceHash === sourceHash);
  };
  return search(projectIndex) ?? search(globalIndex);
}

/** Check whether all cached skills have matching entries in the index. */
export function indexCoverage(
  skills: Array<{ name: string; filePath?: string }>,
  globalIndex: IndexFile | undefined,
  projectIndex: IndexFile | undefined,
): { covered: string[]; missing: string[] } {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const skill of skills) {
    if (!skill.filePath) { missing.push(skill.name); continue; }
    const hash = fileContentHash(skill.filePath);
    const entry = findEntry(skill.name, hash, globalIndex, projectIndex);
    if (entry) covered.push(skill.name);
    else missing.push(skill.name);
  }
  return { covered, missing };
}
