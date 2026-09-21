import { existsSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";
import { discoverSourceFiles, findProjects } from "./discover.js";
export { discoverSourceFiles, findProjects } from "./discover.js";

// ─── Prompt builder ─────────────────────────────────────────────────────────

/**
 * Build the user message that sends the workspace to the session model for an
 * agent-driven audit.  The model reads source, finds Jev opportunities, produces
 * measurable evidence, and writes an HTML report.
 *
 * `projects` comes from {@link findProjects}.  `cwd` is the workspace root.
 */
export function buildAuditPrompt(cwd: string, projects: string[]): string {
  const projectName = cwd.split("/").pop() ?? "workspace";

  // Collect project summaries so the model knows the workspace shape.
  const summaries: string[] = [];
  for (const projectPath of projects) {
    const name = projectPath.split("/").pop() ?? projectPath;
    let files: string[];
    try {
      files = discoverSourceFiles(projectPath);
    } catch (err) {
      console.warn(`audit: could not discover files in ${redact(projectPath)}: ${err instanceof Error ? err.message : err}`);
      files = [];
    }
    const manifests = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];
    let manifest = "";
    for (const m of manifests) {
      const p = join(projectPath, m);
      if (existsSync(p)) { manifest = m; break; }
    }
    summaries.push(
      `- ${name} (${files.length} source files${manifest ? `, manifest: ${manifest}` : ""})`
    );
  }

  const reportPath = join(cwd, ".pi-warden", "audit-report.html");

  return [
    `# Workspace Audit — ${projectName}`,
    "",
    "You are auditing this workspace to find concrete places where hand-written heuristics can be replaced by typed Jev (TypeSafe) questions.",
    "",
    "## Workspace inventory",
    summaries.join("\n"),
    "",
    "## What to do",
    "",
    "1. **Read the actual source** of each project. Do not rely on README or manifest alone. Open the files listed above (and any others you discover) and read the code.",
    "",
    "2. **Find concrete replacement candidates.** Look for:",
    "   - if/else or switch chains that classify, route, or decide",
    "   - regex classifiers or keyword lists that label text",
    "   - threshold tables or scoring heuristics",
    "   - ranking or sorting by hand-built criteria",
    "   - validation logic that checks correctness of free-form output",
    "   - routing decisions based on intent or content",
    "",
    "   For each candidate, cite the exact **file:line** location.",
    "",
    "3. **Produce measurable data for every finding.** For each candidate, gather evidence such as:",
    "   - Count the branches, keyword entries, or cases the current code handles",
    "   - Count cases it misses (e.g. grep for keywords it does not cover, list known false positives from comments or issues)",
    "   - Run the existing test suite and count pass/fail relevant to this code path",
    "   - Write a throwaway script under the OS temp directory that feeds sample inputs through both the current code and a Jev question (using `typesafe_evaluate` when available in the session)",
    "",
    "   A finding without measurable comparison data must be marked **\"unmeasured\"** — do not dress it up.",
    "",
    "4. **Rank findings** by expected improvement (high/medium/low) and setup effort (low/medium/high).",
    "",
    `5. **Write a self-contained HTML report** to \`${reportPath}\` (create the \`.pi-warden\` directory if it does not exist).`,
    "   - Plain HTML + inline CSS, no external assets, no scripts that fetch anything.",
    "   - Sections: summary, findings table, one section per finding with evidence, methodology, and what was not measured.",
    "   - One short chat line at the end naming the file path and the finding count.",
    "",
    "## Constraints",
    "",
    "- Read-only: do not modify any project source while auditing. The only files you may write are the report and throwaway scripts under the OS temp directory.",
    "- Be specific. Every finding must name a file:line in this workspace.",
    "- Prefer fewer, well-evidenced findings over many thin ones.",
    "- If no replacement opportunities exist in a project, say so briefly and move on.",
  ].join("\n");
}
