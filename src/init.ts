import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  const lines = [
    "Copy this file to the root of your project as `pi-warden.md` and edit it.",
    "Every `#` heading below is one rule. The text under a heading is what Jev reads when it judges a write or an edit.",
    "",
    `<!-- Project context: ${context} -->`,
    "",
    SAFETY_RULES,
  ];

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
