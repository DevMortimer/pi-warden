import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Fallback rules files to read when scaffolding. Excludes pi-warden.md because that IS the file being generated. */
const RULES_FALLBACK_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"];

/** Paths to scan for project context when generating a starter rules file. */
const CONTEXT_CANDIDATES = [
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
];

/**
 * Detect a rough project type from common manifest files.
 * Returns a label like "typescript", "rust", "python", "go", or "generic".
 */
export function detectProjectType(cwd: string): string {
  if (existsSync(join(cwd, "tsconfig.json"))) return "typescript";
  if (existsSync(join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(join(cwd, "pyproject.toml"))) return "python";
  if (existsSync(join(cwd, "go.mod"))) return "go";
  if (existsSync(join(cwd, "package.json"))) return "javascript";
  return "generic";
}

/**
 * Read a manifest file and extract a brief summary (name, scripts, dependencies).
 * Returns a short string, or null if the file doesn't parse.
 */
function manifestSummary(cwd: string, filename: string): string | null {
  const path = join(cwd, filename);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parts: string[] = [];
    if (raw.name) parts.push(`name: ${raw.name}`);
    if (raw.scripts) {
      const scripts = Object.keys(raw.scripts).slice(0, 8);
      if (scripts.length) parts.push(`scripts: ${scripts.join(", ")}`);
    }
    if (raw.dependencies) {
      const deps = Object.keys(raw.dependencies).slice(0, 10);
      if (deps.length) parts.push(`deps: ${deps.join(", ")}`);
    }
    return parts.join("; ") || null;
  } catch {
    // Best-effort: unparseable manifest is not a failure, just skip this candidate.
    return null;
  }
}

/**
 * Build project context for the starter rules file.
 * Caps total context at 8000 characters.
 */
export function buildProjectContext(cwd: string): string {
  const parts: string[] = [];
  const projectType = detectProjectType(cwd);
  parts.push(`Project type: ${projectType}`);

  for (const candidate of CONTEXT_CANDIDATES) {
    const summary = manifestSummary(cwd, candidate);
    if (summary) parts.push(`${candidate}: ${summary}`);
  }

  const context = parts.join("\n");
  return context.length > 8000 ? context.slice(0, 8000) + "\n...(truncated)" : context;
}

/** Read the first existing fallback rules file's content, or null if none exists. */
function readExistingRules(cwd: string): string | null {
  for (const file of RULES_FALLBACK_FILES) {
    const fullPath = join(cwd, file);
    if (existsSync(fullPath)) {
      try {
        return readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** Read the existing pi-warden.md content, or null if it doesn't exist. */
function readExistingPiWarden(cwd: string): string | null {
  const fullPath = join(cwd, "pi-warden.md");
  if (!existsSync(fullPath)) return null;
  try {
    return readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
}

/** Standard safety rules that ship in every starter pi-warden.md. */
const SAFETY_RULES = `# No hardcoded secrets
Source code must not contain passwords, API keys, tokens, or connection URLs with credentials.
Read them from the environment, a function parameter, or the config module.

# Comments explain why, not what
A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment
that restates what the next line plainly does is a violation.

# Errors are not swallowed
A \`catch\` block must handle the error, report it, or re-raise it. An empty catch block, or
one whose body is only a comment, is a violation.

# No partial implementations
Implement features fully. A comment that says "for now", "simplified", or "later", or a
stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead
of stubbing it.

# Do not run destructive commands that erase uncommitted work
\`git reset --hard\`, \`git checkout -- .\`, \`git clean -fd\`, and similar commands that discard
untracked or uncommitted changes are forbidden. These destroy work that has no backup. If a
clean tree is needed, create a worktree instead or ask the user.
`;

/**
 * Generate a starter pi-warden.md file.
 * Returns the content; does not write it.
 */
export function generateStarterRules(cwd: string): string {
  const projectType = detectProjectType(cwd);
  const context = buildProjectContext(cwd);
  const existingRules = readExistingRules(cwd);
  const lines = [
    "Copy this file to the root of your project as `pi-warden.md` and edit it.",
    "Every `#` heading below is one rule. The text under a heading is what Jev reads when it judges a write or an edit.",
    "",
    `<!-- Project context: ${context} -->`,
    "",
    SAFETY_RULES,
  ];
  const existingPiWarden = readExistingPiWarden(cwd);
  if (existingPiWarden) {
    lines.push("", "## Existing pi-warden.md rules (preserved)", existingPiWarden, "");
  } else if (existingRules) {
    lines.push("", "## Existing project rules (preserved from fallback file)", existingRules, "");
  }

  // Add type-specific rules.
  if (projectType === "typescript" || projectType === "javascript") {
    lines.push(
      "# No explicit any",
      "paths: **/*.ts, **/*.tsx",
      "Do not use the `any` type. Use a precise type, `unknown` with a runtime check, or a generic parameter.",
      "",
      "# Exported functions declare their return type",
      "paths: src/**/*.ts",
      "Every exported function or method declares its return type instead of relying on inference.",
      "",
    );
  }

  lines.push(
    "# New exported functions get a test",
    "paths: src/**",
    "A newly added exported function or class comes with at least one test that exercises its main behaviour.",
    "",
  );

  return lines.join("\n");
}

/**
 * Build a ready-to-paste prompt for the model to generate pi-warden.md.
 * Includes extracted project context and standard safety rules as a foundation.
 */
export function buildInitPrompt(cwd: string): string {
  const context = buildProjectContext(cwd);
  const projectType = detectProjectType(cwd);
  const existingRules = readExistingRules(cwd);
  const lines = [
    "Create a `pi-warden.md` file for this project. Every `#` heading is one rule; the text under it is what Jev judges against.",
    "",
    "## Project context",
    context,
    "",
    "## Rules to always include",
    SAFETY_RULES,
  ];
  const existingPiWarden = readExistingPiWarden(cwd);
  if (existingPiWarden) {
    lines.push("", "## Existing pi-warden.md rules (preserve these)", existingPiWarden, "");
  } else if (existingRules) {
    lines.push("", "## Existing project rules (preserve these)", existingRules, "");
  }

  if (projectType === "typescript" || projectType === "javascript") {
    lines.push(
      "## Type-specific rules",
      "- No explicit `any` in **/*.ts, **/*.tsx",
      "- Exported functions declare their return type in src/**/*.ts",
      "",
    );
  }

  lines.push(
    "## Requirements",
    "- Under 50 rules",
    "- Each rule is a `#` heading with a description under it",
    "- Optional `paths:` line under a heading limits the rule to matching files",
    "- No stubs, no TODOs, no placeholders",
    "- Write the file to pi-warden.md at the project root",
  );

  return lines.join("\n");
}

/**
 * Result of an /warden init attempt.
 */
export interface InitResult {
  /** Whether a pi-warden.md already existed. */
  alreadyExists: boolean;
  /** The path that was written (or would be overwritten). */
  path: string;
  /** The content written. */
  content: string;
}

/**
 * Write a starter pi-warden.md to the project root.
 * If it already exists, returns alreadyExists: true without writing.
 */
export function writeStarterRules(cwd: string, overwrite = false): InitResult {
  const targetPath = join(cwd, "pi-warden.md");
  const alreadyExists = existsSync(targetPath);

  if (alreadyExists && !overwrite) {
    return { alreadyExists: true, path: targetPath, content: readFileSync(targetPath, "utf8") };
  }

  const content = generateStarterRules(cwd);
  writeFileSync(targetPath, content, "utf8");
  return { alreadyExists, path: targetPath, content };
}
