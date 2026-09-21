import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask, noul } from "pi-typesafe";
import { redact } from "./redact.js";
import type { Judge } from "./guard.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditFinding {
  project: string;
  files: string[];
  task: string;
  jevOpportunity: string;
  informationNeeded: string;
  references: string;
  question: string;
  outputType: string;
  actionOnAnswer: string;
  riskIfWrong: string;
  example?: string | undefined;
  priority: "high" | "medium" | "low";
  setupEffort: "low" | "medium" | "high";
  testingEase: "easy" | "medium" | "hard";
  frequency: string;
  costImpact: string;
}

interface ProjectInfo {
  name: string;
  path: string;
  type: string;
  files: string[];
  readme: string | null;
  manifest: string | null;
  hasLinting: boolean;
  hasTests: boolean;
  hasTypeChecking: boolean;
  hasCI: boolean;
  hasRules: boolean;
}

// ─── Workspace scanning ──────────────────────────────────────────────────────

function findProjects(cwd: string): string[] {
  const projects: string[] = [];
  const manifests = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];

  for (const m of manifests) {
    if (existsSync(join(cwd, m))) { projects.push(cwd); break; }
  }

  let entries: string[];
  try { entries = readdirSync(cwd); } catch { return projects; }

  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const sub = join(cwd, entry);
    try { if (!existsSync(join(sub, "package.json")) && !existsSync(join(sub, "Cargo.toml")) && !existsSync(join(sub, "pyproject.toml")) && !existsSync(join(sub, "go.mod"))) continue; } catch { continue; }
    if (!projects.includes(sub)) projects.push(sub);
  }

  return projects;
}

function readFileSafe(path: string, maxChars = 4000): string | null {
  try { const raw = readFileSync(path, "utf8"); return raw.length > maxChars ? raw.slice(0, maxChars) + "\n... (truncated)" : raw; } catch (err) { console.warn(`audit: could not read ${path}: ${err instanceof Error ? err.message : err}`); return null; }
}

function listSourceFiles(dir: string, max = 50): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { recursive: true })) {
      if (typeof entry !== "string") continue;
      if (/\.(ts|tsx|js|jsx|rs|py|go|vue|svelte)$/.test(entry)) files.push(entry);
      if (files.length >= max) break;
    }
  } catch (err) { console.warn(`audit: could not list ${dir}: ${err instanceof Error ? err.message : err}`); }
  return files;
}

function readProjectInfo(projectPath: string, workspaceRoot: string): ProjectInfo {
  const name = projectPath === workspaceRoot ? workspaceRoot.split("/").pop() ?? "workspace" : projectPath.split("/").pop() ?? "unknown";
  const type = detectType(projectPath);

  const readme = readFileSafe(join(projectPath, "README.md"), 2000);

  let manifest: string | null = null;
  const manifestFiles = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];
  for (const m of manifestFiles) {
    const p = join(projectPath, m);
    if (existsSync(p)) { manifest = readFileSafe(p, 3000); break; }
  }

  const srcFiles = [
    ...listSourceFiles(join(projectPath, "src")),
    ...listSourceFiles(join(projectPath, "lib")),
    ...listSourceFiles(join(projectPath, "app")),
    ...listSourceFiles(join(projectPath, "internal")),
  ];

  return {
    name, path: projectPath, type, files: srcFiles, readme, manifest,
    hasLinting: existsSync(join(projectPath, ".eslintrc")) || existsSync(join(projectPath, "eslint.config.js")) || existsSync(join(projectPath, "biome.json")),
    hasTests: existsSync(join(projectPath, "tests")) || existsSync(join(projectPath, "__tests__")) || existsSync(join(projectPath, "test")),
    hasTypeChecking: existsSync(join(projectPath, "tsconfig.json")),
    hasCI: existsSync(join(projectPath, ".github/workflows")),
    hasRules: existsSync(join(projectPath, "pi-warden.md")),
  };
}

function detectType(projectPath: string): string {
  if (existsSync(join(projectPath, "tsconfig.json"))) return "typescript";
  if (existsSync(join(projectPath, "Cargo.toml"))) return "rust";
  if (existsSync(join(projectPath, "pyproject.toml"))) return "python";
  if (existsSync(join(projectPath, "go.mod"))) return "go";
  if (existsSync(join(projectPath, "package.json"))) return "javascript";
  return "generic";
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildAuditPrompt(projectInfo: ProjectInfo): string {
  return `Audit this project for tasks where Jev (an AI judgment model) could improve the codebase.

PROJECT: ${projectInfo.name}
TYPE: ${projectInfo.type}
FILES: ${projectInfo.files.join(", ")}
${projectInfo.readme ? `README (first 2000 chars):\n${projectInfo.readme}` : ""}
${projectInfo.manifest ? `Manifest:\n${projectInfo.manifest}` : ""}

For each task where Jev could help, report:

1. FILES — which files contain this task
2. TODAY — how the task works now (2-3 sentences)
3. JEV — where Jev could help (1-2 sentences)
4. READ — what information Jev needs to read
5. CHECK — what references it should verify against
6. QUESTION — one specific question Jev should answer
7. OUTPUT — allowed choices, score scale (0-1), or probability
8. DO — what the app does with Jev's answer
9. RISK — what happens if the answer is wrong or uncertain

Look for:
- Decision points: choosing between options, routing, strategy selection
- Scoring: metrics, ratings, rankings, thresholds, calibration
- Verification: validation, assertions, checks, truth testing
- Search by meaning: finding relevant passages, semantic matching
- Content quality: prose checking, documentation, code review

For each finding, estimate:
- PRIORITY: high/medium/low (how much Jev improves over current approach)
- EFFORT: low/medium/high (setup work needed)
- TESTING: easy/medium/hard (how to verify Jev's answers)
- FREQUENCY: how often this task runs (or "unknown")
- COST: effect of a wrong answer (or "unknown")

If a project has no clear Jev opportunities, say so explicitly.

Return findings as a JSON array. Example format:
[
  {
    "project": "my-app",
    "files": ["src/router.ts"],
    "task": "Route selection based on user role",
    "jevOpportunity": "Jev could evaluate whether a route matches the user's intent",
    "informationNeeded": "User role, route config, current path",
    "references": "Route table, role permissions",
    "question": "Does this route match the user's intended destination?",
    "outputType": "choice: [match, no-match, uncertain]",
    "actionOnAnswer": "Route to the matched path or show an error",
    "riskIfWrong": "User reaches wrong page (low impact)",
    "priority": "medium",
    "setupEffort": "low",
    "testingEase": "easy",
    "frequency": "every navigation",
    "costImpact": "low — wrong route is reversible"
  }
]

Return ONLY the JSON array. No other text.`;
}

// ─── Main audit ───────────────────────────────────────────────────────────────

export async function auditWorkspace(cwd: string, judge?: Judge): Promise<AuditFinding[]> {
  const projectPaths = findProjects(cwd);
  const findings: AuditFinding[] = [];

  for (const projectPath of projectPaths) {
    const info = readProjectInfo(projectPath, cwd);

    if (judge) {
      try {
        const prompt = buildAuditPrompt(info);
        const safeState = {
          project: info.name,
          type: info.type,
          files: info.files.map(f => f.split("/").pop() ?? f),
          readme: redact(info.readme ?? ""),
          manifest: redact(info.manifest ?? ""),
          hasLinting: info.hasLinting,
          hasTests: info.hasTests,
          hasTypeChecking: info.hasTypeChecking,
          hasCI: info.hasCI,
          hasRules: info.hasRules,
        };
        const request = {
          state: safeState,
          questions: {
            audit: noul(redact(prompt), {
              true: "The project has opportunities where Jev could improve the codebase.",
              false: "The project has no clear Jev opportunities.",
            }),
          },
        };
        const result = await ask(judge, request);
        if (!result.ok) throw new Error(result.error);
        const parsed = parseFindings(result.answers.audit as unknown as string, info);
        findings.push(...parsed);
        continue;
      } catch (err) {
        console.warn(`audit: Jev evaluation failed for ${info.name}, falling back to static analysis: ${err instanceof Error ? err.message : err}`);
      }
    }

    findings.push(...staticAnalysis(info));
  }

  return findings.sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority));
}

function parseFindings(raw: unknown, info: ProjectInfo): AuditFinding[] {
  try {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const arr = JSON.parse(jsonMatch[0]) as Record<string, unknown>[];
    return arr.map((item): AuditFinding => ({
      project: info.name,
      files: Array.isArray(item.files) ? item.files.map(String) : [],
      task: String(item.task ?? item.TODAY ?? item.description ?? ""),
      jevOpportunity: String(item.jevOpportunity ?? item.JEV ?? ""),
      informationNeeded: String(item.informationNeeded ?? item.READ ?? ""),
      references: String(item.references ?? item.CHECK ?? ""),
      question: String(item.question ?? item.QUESTION ?? ""),
      outputType: String(item.outputType ?? item.OUTPUT ?? "choice"),
      actionOnAnswer: String(item.actionOnAnswer ?? item.DO ?? ""),
      riskIfWrong: String(item.riskIfWrong ?? item.RISK ?? "unknown"),
      example: item.example ? String(item.example) : undefined,
      priority: validatePriority(item.priority),
      setupEffort: validateEffort(item.setupEffort ?? item.effort),
      testingEase: validateEase(item.testingEase ?? item.testing),
      frequency: String(item.frequency ?? "unknown"),
      costImpact: String(item.costImpact ?? item.cost ?? "unknown"),
    }));
  } catch (err) {
    console.warn(`audit: could not parse Jev response for ${info.name}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

function validatePriority(val: unknown): "high" | "medium" | "low" {
  return val === "high" || val === "medium" || val === "low" ? val : "medium";
}
function validateEffort(val: unknown): "low" | "medium" | "high" {
  return val === "low" || val === "medium" || val === "high" ? val : "medium";
}
function validateEase(val: unknown): "easy" | "medium" | "hard" {
  return val === "easy" || val === "medium" || val === "hard" ? val : "medium";
}
function priorityOrder(p: string): number {
  return p === "high" ? 0 : p === "medium" ? 1 : 2;
}

// ─── Static analysis (fallback when no Jev) ──────────────────────────────────

interface PatternDef {
  id: string;
  task: string;
  jevOpportunity: string;
  question: string;
  outputType: string;
  actionOnAnswer: string;
  riskIfWrong: string;
  priority: "high" | "medium" | "low";
  setupEffort: "low" | "medium" | "high";
  testingEase: "easy" | "medium" | "hard";
  frequency: string;
  costImpact: string;
  regex: RegExp;
}

const PATTERNS: PatternDef[] = [
  { id: "if-else-chain", task: "If-else / switch decision chains", jevOpportunity: "Jev could evaluate which branch best matches the current context", question: "Which branch most accurately handles this case?", outputType: "choice: [branch-a, branch-b, ..., uncertain]", actionOnAnswer: "Select the matched branch dynamically", riskIfWrong: "Incorrect code path executed (medium impact)", priority: "high", setupEffort: "medium", testingEase: "easy", frequency: "per request", costImpact: "medium — wrong branch may cause errors", regex: /if\s*\([^)]+\)\s*\{[\s\S]*\}\s*else\s+if\s*\(/ },
  { id: "strategy-select", task: "Strategy / plugin selection", jevOpportunity: "Jev could pick the best strategy based on context and requirements", question: "Which strategy is most appropriate for this input and context?", outputType: "choice: [strategy-a, strategy-b, ...]", actionOnAnswer: "Load and execute the selected strategy", riskIfWrong: "Suboptimal strategy chosen (variable impact)", priority: "high", setupEffort: "medium", testingEase: "easy", frequency: "per invocation", costImpact: "medium — wrong strategy degrades results", regex: /strategy|plugin|handler|provider|backend/i },
  { id: "config-routing", task: "Configuration-based routing", jevOpportunity: "Jev could decide which config value applies to the current scenario", question: "Which configuration applies to this specific scenario?", outputType: "choice: [config-a, config-b, ...]", actionOnAnswer: "Apply the selected configuration", riskIfWrong: "Wrong config applied (low-medium impact)", priority: "medium", setupEffort: "low", testingEase: "easy", frequency: "per startup or request", costImpact: "low — config is usually reversible", regex: /config\s*\.\s*\w+\s*\?\s*\w+|switch\s*\(\s*\w+\.mode\s*\)/ },
  { id: "metric-score", task: "Metric scoring or ranking", jevOpportunity: "Jev could provide nuanced scoring that accounts for context and edge cases", question: "How should this item be scored given the current context?", outputType: "score: 0-1", actionOnAnswer: "Use score for filtering, ranking, or threshold decisions", riskIfWrong: "Incorrect ranking or filtering (variable impact)", priority: "high", setupEffort: "medium", testingEase: "medium", frequency: "per evaluation", costImpact: "medium — wrong score affects downstream decisions", regex: /score|rating|rank|threshold|calibrat|metric|weight/i },
  { id: "threshold-tune", task: "Threshold tuning and calibration", jevOpportunity: "Jev could dynamically adjust thresholds based on context", question: "What threshold is appropriate for this context and risk level?", outputType: "score: 0-1 (threshold value)", actionOnAnswer: "Adjust comparison threshold", riskIfWrong: "Too strict or too lenient (medium impact)", priority: "medium", setupEffort: "medium", testingEase: "medium", frequency: "per evaluation or periodically", costImpact: "medium — affects sensitivity of checks", regex: /threshold|calibrat|tuning|sensitivity|tolerance/i },
  { id: "validation", task: "Validation and assertion logic", jevOpportunity: "Jev could validate whether output is semantically correct, not just syntactically", question: "Does this output correctly satisfy the requirements?", outputType: "choice: [valid, invalid, uncertain]", actionOnAnswer: "Flag invalid output for correction", riskIfWrong: "Invalid output passes or valid output rejected (high impact)", priority: "high", setupEffort: "medium", testingEase: "hard", frequency: "per output", costImpact: "high — incorrect validation can cause data issues", regex: /assert|valid|check|verify|invariant|precondition|postcondition/i },
  { id: "semantic-search", task: "Search and retrieval", jevOpportunity: "Jev could find results by meaning rather than exact keyword match", question: "Which results are most semantically relevant to this query?", outputType: "score: 0-1 (relevance)", actionOnAnswer: "Rank and filter results by semantic relevance", riskIfWrong: "Irrelevant results shown (low-medium impact)", priority: "high", setupEffort: "high", testingEase: "medium", frequency: "per search", costImpact: "low — user can refine search", regex: /search|find|match|retriev|recommend|lookup|query/i },
  { id: "content-quality", task: "Content quality assessment", jevOpportunity: "Jev could evaluate prose, documentation, or code quality semantically", question: "How well does this content serve its intended audience and purpose?", outputType: "score: 0-1 (quality)", actionOnAnswer: "Flag low-quality content for improvement", riskIfWrong: "Good content flagged or bad content missed (low impact)", priority: "medium", setupEffort: "low", testingEase: "easy", frequency: "per write or review", costImpact: "low — content quality is usually iterative", regex: /prose|documentation|readme|changelog|comment|doc/i },
];

function staticAnalysis(info: ProjectInfo): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const readCache = new Map<string, string>();

  for (const file of info.files) {
    const fullPath = join(info.path, file);
    let content = readCache.get(fullPath);
    if (content === undefined) {
      content = readFileSafe(fullPath, 20000) ?? "";
      readCache.set(fullPath, content);
    }

    for (const pattern of PATTERNS) {
      if (pattern.regex.test(content)) {
        findings.push({
          project: info.name,
          files: [file],
          task: pattern.task,
          jevOpportunity: pattern.jevOpportunity,
          informationNeeded: `Source code of ${file}`,
          references: "Project requirements and existing behavior",
          question: pattern.question,
          outputType: pattern.outputType,
          actionOnAnswer: pattern.actionOnAnswer,
          riskIfWrong: pattern.riskIfWrong,
          priority: pattern.priority,
          setupEffort: pattern.setupEffort,
          testingEase: pattern.testingEase,
          frequency: pattern.frequency,
          costImpact: pattern.costImpact,
        });
      }
    }
  }

  if (findings.length === 0 && info.files.length > 0) {
    findings.push({
      project: info.name,
      files: info.files.slice(0, 3),
      task: "Codebase review and quality checks",
      jevOpportunity: "Jev could review code changes for quality, consistency, and potential issues",
      informationNeeded: "Source code, project conventions, and requirements",
      references: "Project standards, coding guidelines, and existing patterns",
      question: "Does this code change follow the project's conventions and meet quality standards?",
      outputType: "choice: [pass, needs-improvement, uncertain]",
      actionOnAnswer: "Flag code that needs improvement or passes review",
      riskIfWrong: "Code quality issues missed (low impact)",
      priority: "low",
      setupEffort: "low",
      testingEase: "easy",
      frequency: "per code change",
      costImpact: "low — code review is iterative",
    });
  }

  return findings;
}

// ─── HTML generation ──────────────────────────────────────────────────────────

export function generateAuditHTML(findings: AuditFinding[], cwd: string): string {
  const projectName = cwd.split("/").pop() ?? "workspace";
  const high = findings.filter(f => f.priority === "high").length;
  const medium = findings.filter(f => f.priority === "medium").length;
  const low = findings.filter(f => f.priority === "low").length;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  const firstHigh = findings.find(f => f.priority === "high");
  const firstMedium = findings.find(f => f.priority === "medium");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jev Opportunity Audit — ${esc(projectName)}</title>
<style>
:root {
  --bg: #fafafa; --surface: #ffffff; --text: #1a1a2e; --text-secondary: #555;
  --border: #e2e8f0; --shadow: 0 1px 3px rgba(0,0,0,0.08);
  --high: #dc2626; --high-bg: #fef2f2; --high-border: #fecaca;
  --medium: #d97706; --medium-bg: #fffbeb; --medium-border: #fde68a;
  --low: #16a34a; --low-bg: #f0fdf4; --low-border: #bbf7d0;
  --accent: #2563eb; --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a; --surface: #1e293b; --text: #f1f5f9; --text-secondary: #94a3b8;
    --border: #334155; --shadow: 0 1px 3px rgba(0,0,0,0.3);
    --high-bg: #1c0a0a; --high-border: #7f1d1d; --medium-bg: #1a1207; --medium-border: #78350f;
    --low-bg: #071a0d; --low-border: #14532d; --accent: #60a5fa;
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
header { margin-bottom: 2rem; }
header h1 { font-size: 2rem; font-weight: 700; margin-bottom: 0.25rem; }
header .subtitle { color: var(--text-secondary); font-size: 0.95rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; box-shadow: var(--shadow); text-align: center; }
.stat .number { font-size: 2rem; font-weight: 700; }
.stat .label { font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem; }
.stat.high .number { color: var(--high); }
.stat.medium .number { color: var(--medium); }
.stat.low .number { color: var(--low); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 1rem; overflow: hidden; }
.card-header { padding: 1rem 1.25rem; display: flex; align-items: center; gap: 0.75rem; cursor: pointer; }
.card-header:hover { background: var(--bg); }
.badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
.badge-high { background: var(--high-bg); color: var(--high); border: 1px solid var(--high-border); }
.badge-medium { background: var(--medium-bg); color: var(--medium); border: 1px solid var(--medium-border); }
.badge-low { background: var(--low-bg); color: var(--low); border: 1px solid var(--low-border); }
.badge-effort { background: var(--surface); border: 1px solid var(--border); color: var(--text-secondary); }
.card-title { flex: 1; font-size: 1.05rem; font-weight: 600; }
.card-project { font-size: 0.8rem; color: var(--text-secondary); }
.card-chevron { color: var(--text-secondary); transition: transform 0.2s; font-size: 1.2rem; }
.card.open .card-chevron { transform: rotate(90deg); }
.card-body { display: none; padding: 0 1.25rem 1.25rem; border-top: 1px solid var(--border); }
.card.open .card-body { display: block; }
.card-body h4 { font-size: 0.85rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; margin: 1rem 0 0.3rem; }
.card-body p, .card-body pre { font-size: 0.9rem; color: var(--text); }
.card-body pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem; overflow-x: auto; font-size: 0.82rem; }
.meta { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; background: var(--surface); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); border: 1px solid var(--border); }
th { background: var(--bg); text-align: left; padding: 0.75rem 1rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); border-bottom: 2px solid var(--border); }
td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: var(--bg); }
.recommendation { background: var(--surface); border: 2px solid var(--accent); border-radius: var(--radius); box-shadow: var(--shadow); padding: 1.5rem; margin: 2rem 0; }
.recommendation h3 { color: var(--accent); margin-bottom: 0.75rem; }
section { margin: 2.5rem 0; }
section h2 { font-size: 1.25rem; font-weight: 700; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--border); }
footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: 0.8rem; }
.files { margin-top: 0.25rem; font-size: 0.82rem; color: var(--text-secondary); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Jev Opportunity Audit</h1>
    <p class="subtitle">${esc(projectName)} &middot; ${timestamp}</p>
  </header>

  <div class="stats">
    <div class="stat"><div class="number">${findings.length}</div><div class="label">Total Findings</div></div>
    <div class="stat high"><div class="number">${high}</div><div class="label">High Priority</div></div>
    <div class="stat medium"><div class="number">${medium}</div><div class="label">Medium Priority</div></div>
    <div class="stat low"><div class="number">${low}</div><div class="label">Low Priority</div></div>
  </div>

  ${firstHigh || firstMedium ? `<div class="recommendation">
  <h3>Recommended First Step</h3>
  <p>Start with <strong>"${esc((firstHigh ?? firstMedium!)?.task ?? "")}</strong> in <strong>${esc((firstHigh ?? firstMedium!)?.project ?? "")}</strong> &mdash; it has ${firstHigh ? "high" : "medium"} priority with ${firstHigh?.setupEffort ?? firstMedium?.setupEffort ?? "medium"} setup effort.</p>
  <p style="margin-top:0.5rem;font-size:0.9rem;color:var(--text-secondary)">Question to ask Jev: <em>"${esc((firstHigh ?? firstMedium!)?.question ?? "")}"</em></p>
</div>` : ""}

  <section>
    <h2>Findings</h2>
    ${findings.map((f, i) => card(f, i)).join("\n")}
  </section>

  <section>
    <h2>Comparison</h2>
    <table>
      <thead><tr><th>Task</th><th>Project</th><th>Priority</th><th>Setup Effort</th><th>Testing Ease</th><th>Frequency</th></tr></thead>
      <tbody>
${findings.map(f => `        <tr><td>${esc(f.task)}</td><td>${esc(f.project)}</td><td><span class="badge badge-${f.priority}">${f.priority}</span></td><td>${esc(f.setupEffort)}</td><td>${esc(f.testingEase)}</td><td>${esc(f.frequency)}</td></tr>`).join("\n")}
      </tbody>
    </table>
  </section>

  <footer>
    <p>Generated by pi-warden audit &middot; ${findings.length} findings across ${new Set(findings.map(f => f.project)).size} project(s) &middot; ${timestamp}</p>
  </footer>
</div>
<script>
document.querySelectorAll('.card-header').forEach(h => {
  h.addEventListener('click', () => h.closest('.card')?.classList.toggle('open'));
});
</script>
</body>
</html>`;
}

function card(f: AuditFinding, i: number): string {
  const id = `f-${i}`;
  const fileLinks = f.files.map(file => `<code>${esc(file)}</code>`).join(", ");
  return `    <div class="card" id="${id}">
      <div class="card-header">
        <span class="badge badge-${f.priority}">${f.priority}</span>
        <span class="card-title">${esc(f.task)}</span>
        <span class="card-project">${esc(f.project)}</span>
        <span class="card-chevron">&#9654;</span>
      </div>
      <div class="card-body">
        <div class="files">${fileLinks}</div>
        <h4>Current Approach</h4><p>${esc(f.task)}: ${esc(f.informationNeeded)}</p>
        <h4>Jev Opportunity</h4><p>${esc(f.jevOpportunity)}</p>
        <h4>Information Needed</h4><p>${esc(f.informationNeeded)}</p>
        <h4>References</h4><p>${esc(f.references)}</p>
        <h4>Question for Jev</h4><pre>${esc(f.question)}</pre>
        <h4>Output Type</h4><p>${esc(f.outputType)}</p>
        <h4>Action on Answer</h4><p>${esc(f.actionOnAnswer)}</p>
        <h4>Risk if Wrong</h4><p>${esc(f.riskIfWrong)}</p>
        ${f.example ? `<h4>Example</h4><pre>${esc(f.example)}</pre>` : ""}
        <div class="meta">
          <span class="badge badge-effort">effort: ${esc(f.setupEffort)}</span>
          <span class="badge badge-effort">testing: ${esc(f.testingEase)}</span>
          <span class="badge badge-effort">frequency: ${esc(f.frequency)}</span>
          <span class="badge badge-effort">cost: ${esc(f.costImpact)}</span>
        </div>
      </div>
    </div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
