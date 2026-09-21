import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask, choice, noul } from "pi-typesafe";
import { redact } from "./redact.js";
import { detectProjectType } from "./init.js";
import type { Judge } from "./guard.js";
import { discoverSourceFiles, findProjects } from "./discover.js";
export { discoverSourceFiles, findProjects } from "./discover.js";

/** Minimum confidence score for a test to count as passing. */
const PASS_THRESHOLD = 0.5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestResult {
  questionAsked: string;
  jevAnswer: string;
  confidence: number;
  responseTimeMs: number;
  passed: boolean;
}

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
  testResult?: TestResult | undefined;
}

export interface AuditResult {
  findings: AuditFinding[];
  skipped: { project: string; reason: string }[];
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



function readFileSafe(path: string, maxChars = 4000): string | null {
  try { const raw = readFileSync(path, "utf8"); return raw.length > maxChars ? raw.slice(0, maxChars) + "\n... (truncated)" : raw; } catch (err) { console.warn(`audit: could not read ${path}: ${err instanceof Error ? err.message : err}`); return null; }
}



function readProjectInfo(projectPath: string, workspaceRoot: string): ProjectInfo {
  const name = projectPath === workspaceRoot ? workspaceRoot.split("/").pop() ?? "workspace" : projectPath.split("/").pop() ?? "unknown";
  const type = detectProjectType(projectPath);

  const readme = readFileSafe(join(projectPath, "README.md"), 2000);

  let manifest: string | null = null;
  const manifestFiles = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];
  for (const m of manifestFiles) {
    const p = join(projectPath, m);
    if (existsSync(p)) { manifest = readFileSafe(p, 3000); break; }
  }

  const srcFiles = discoverSourceFiles(projectPath);

  return {
    name, path: projectPath, type, files: srcFiles, readme, manifest,
    hasLinting: existsSync(join(projectPath, ".eslintrc")) || existsSync(join(projectPath, "eslint.config.js")) || existsSync(join(projectPath, "biome.json")),
    hasTests: existsSync(join(projectPath, "tests")) || existsSync(join(projectPath, "__tests__")) || existsSync(join(projectPath, "test")),
    hasTypeChecking: existsSync(join(projectPath, "tsconfig.json")),
    hasCI: existsSync(join(projectPath, ".github/workflows")),
    hasRules: existsSync(join(projectPath, "pi-warden.md")),
  };
}



// ─── Opportunity types ──────────────────────────────────────────────────────

const OPPORTUNITY_TYPES = [
  "decision-points",
  "scoring",
  "verification",
  "semantic-search",
  "content-quality",
  "routing",
  "classification",
  "extraction",
  "none",
] as const;

type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

interface OpportunityTemplate {
  task: string;
  jevOpportunity: string;
  informationNeeded: string;
  references: string;
  question: string;
  outputType: string;
  actionOnAnswer: string;
  riskIfWrong: string;
  priority: "high" | "medium" | "low";
  setupEffort: "low" | "medium" | "high";
  testingEase: "easy" | "medium" | "hard";
  frequency: string;
  costImpact: string;
}

const OPPORTUNITY_TEMPLATES: Record<Exclude<OpportunityType, "none">, OpportunityTemplate> = {
  "decision-points": {
    task: "Decision-point evaluation",
    jevOpportunity: "Jev could evaluate context and choose between options (routing, strategy, mode selection)",
    informationNeeded: "Current context, available options, constraints",
    references: "Option definitions, constraints, past outcomes",
    question: "Given this context, which option best matches the user's intent?",
    outputType: "choice: [option-a, option-b, ..., uncertain]",
    actionOnAnswer: "Select the chosen option and proceed",
    riskIfWrong: "Wrong option selected; may need user correction",
    priority: "high",
    setupEffort: "low",
    testingEase: "easy",
    frequency: "per request",
    costImpact: "medium — wrong choice is usually reversible",
  },
  scoring: {
    task: "Scoring and ranking",
    jevOpportunity: "Jev could score, rank, or rate items based on semantic criteria",
    informationNeeded: "Items to score, scoring criteria, context",
    references: "Scoring rubric, past scores, calibration data",
    question: "How well does this item match the criteria?",
    outputType: "score: 0-1",
    actionOnAnswer: "Use score for ranking, filtering, or threshold decisions",
    riskIfWrong: "Inaccurate ranking; items may be mis-prioritized",
    priority: "medium",
    setupEffort: "medium",
    testingEase: "medium",
    frequency: "per batch",
    costImpact: "low — scores inform but don't directly act",
  },
  verification: {
    task: "Verification and validation",
    jevOpportunity: "Jev could verify claims, validate outputs, or check correctness",
    informationNeeded: "Claim or output to verify, reference material, constraints",
    references: "Expected behavior, documentation, test cases",
    question: "Is this claim correct given the evidence?",
    outputType: "noul: probability of correctness",
    actionOnAnswer: "Accept, reject, or flag for review",
    riskIfWrong: "Incorrect verification may let errors through or block valid work",
    priority: "high",
    setupEffort: "low",
    testingEase: "easy",
    frequency: "per output",
    costImpact: "medium — false negatives block work, false positives let bugs through",
  },
  "semantic-search": {
    task: "Semantic search and matching",
    jevOpportunity: "Jev could find relevant passages, code, or documentation by meaning rather than keywords",
    informationNeeded: "Search query, corpus of documents or code",
    references: "Index of searchable content, relevance thresholds",
    question: "Which passages are most relevant to this query?",
    outputType: "choice: [relevant, not-relevant, uncertain]",
    actionOnAnswer: "Return matched passages or filter results",
    riskIfWrong: "Missing relevant results or returning noise",
    priority: "medium",
    setupEffort: "medium",
    testingEase: "medium",
    frequency: "per query",
    costImpact: "low — poor results are retryable",
  },
  "content-quality": {
    task: "Content quality assessment",
    jevOpportunity: "Jev could evaluate prose, documentation, or code quality against standards",
    informationNeeded: "Content to evaluate, quality criteria, style guide",
    references: "Style guide, quality standards, examples of good/bad",
    question: "Does this content meet the quality standards?",
    outputType: "noul: probability of meeting standards",
    actionOnAnswer: "Flag issues, suggest improvements, or approve",
    riskIfWrong: "Missing quality issues or over-flagging",
    priority: "low",
    setupEffort: "low",
    testingEase: "easy",
    frequency: "per content change",
    costImpact: "low — quality flags are advisory",
  },
  routing: {
    task: "Intent-based routing",
    jevOpportunity: "Jev could route requests to the right handler based on user intent",
    informationNeeded: "User input, available routes, route descriptions",
    references: "Route table, handler capabilities, past routing decisions",
    question: "Which handler best matches this user's intent?",
    outputType: "choice: [handler-a, handler-b, ..., uncertain]",
    actionOnAnswer: "Forward to the selected handler",
    riskIfWrong: "Request goes to wrong handler; may produce incorrect results",
    priority: "high",
    setupEffort: "low",
    testingEase: "easy",
    frequency: "per request",
    costImpact: "medium — wrong route may need retry",
  },
  classification: {
    task: "Classification and categorization",
    jevOpportunity: "Jev could classify items into categories based on content and context",
    informationNeeded: "Item to classify, available categories, classification criteria",
    references: "Category definitions, examples, classification rules",
    question: "Which category does this item belong to?",
    outputType: "choice: [cat-a, cat-b, ..., uncertain]",
    actionOnAnswer: "Apply category-specific processing",
    riskIfWrong: "Misclassification may trigger wrong processing path",
    priority: "medium",
    setupEffort: "low",
    testingEase: "easy",
    frequency: "per item",
    costImpact: "low — classification errors are usually correctable",
  },
  extraction: {
    task: "Information extraction",
    jevOpportunity: "Jev could extract structured information from unstructured text or code",
    informationNeeded: "Source text, extraction schema, context",
    references: "Schema definition, extraction examples, validation rules",
    question: "What structured information can be extracted from this content?",
    outputType: "noul: confidence in extraction accuracy",
    actionOnAnswer: "Populate structured fields, create records",
    riskIfWrong: "Incorrect extraction may corrupt downstream data",
    priority: "medium",
    setupEffort: "medium",
    testingEase: "medium",
    frequency: "per content block",
    costImpact: "medium — wrong extraction may require manual correction",
  },
};

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildAuditPrompt(projectInfo: ProjectInfo): string {
  return `Analyze this project and identify which types of AI (Jev) opportunities are present.

PROJECT: ${projectInfo.name}
TYPE: ${projectInfo.type}
FILES: ${projectInfo.files.join(", ")}
${projectInfo.readme ? `README (first 2000 chars):\n${projectInfo.readme}` : ""}
${projectInfo.manifest ? `Manifest:\n${projectInfo.manifest}` : ""}

Based on the code structure, file types, and project description, identify which opportunity types are relevant. Look for patterns that suggest each type:

- decision-points: if/else chains, switch statements, strategy patterns, config-driven behavior
- scoring: metrics, ratings, rankings, thresholds, calibration, priority calculations
- verification: assertions, validation, checks, tests, compliance checks
- semantic-search: search functionality, matching, similarity, lookup by meaning
- content-quality: documentation, comments, prose, code review, style checking
- routing: URL routing, command dispatch, handler selection, middleware chains
- classification: categorization, tagging, type detection, mode selection
- extraction: parsing, data extraction, field extraction, schema validation

Select ALL types that apply. If none apply, select "none".`;
}

// ─── Main audit ───────────────────────────────────────────────────────────────

export async function auditWorkspace(cwd: string, judge: Judge): Promise<AuditResult> {
  const projectPaths = findProjects(cwd);
  const findings: AuditFinding[] = [];
  const skipped: { project: string; reason: string }[] = [];

  for (const projectPath of projectPaths) {
    let info: ProjectInfo;
    try {
      info = readProjectInfo(projectPath, cwd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ project: projectPath.split("/").pop() ?? projectPath, reason });
      continue;
    }
    if (!info.files.length && !info.readme && !info.manifest) {
      skipped.push({ project: info.name, reason: "no readable source files or manifest found" });
      continue;
    }

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
      const choiceOptions: Record<string, string> = {};
      for (const t of OPPORTUNITY_TYPES) {
        choiceOptions[t] = t === "none"
          ? `The project has no clear opportunities for this AI type.`
          : `The project has code patterns suggesting ${t} opportunities where Jev could help.`;
      }
      const request = {
        state: safeState,
        questions: {
          audit: choice(redact(prompt), choiceOptions),
        },
      };
      const result = await ask(judge, request);
      if (!result.ok) throw new Error(result.error);
      const selected = (result.answers.audit as { choice?: string })?.choice;
      if (!selected || selected === "none") continue;
      const selectedTypes = selected.split(/,\s*/).map(s => s.trim()) as OpportunityType[];
      for (const t of selectedTypes) {
        if (t === "none" || !(t in OPPORTUNITY_TEMPLATES)) continue;
        const tmpl = OPPORTUNITY_TEMPLATES[t as Exclude<OpportunityType, "none">];
        findings.push({
          project: info.name,
          files: info.files.slice(0, 5),
          ...tmpl,
        });
      }
    } catch (err) {
      skipped.push({ project: info.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Sort by priority, then test each finding against Jev.
  findings.sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority));
  await testFindings(findings, judge, cwd);

  return { findings, skipped };
}

// ─── Testing phase ────────────────────────────────────────────────────────────

async function testFindings(findings: AuditFinding[], judge: Judge, projectPath: string): Promise<void> {
  for (const finding of findings) {
    const test = await buildAndRunTest(finding, judge, projectPath);
    finding.testResult = test;
  }
}

/**
 * Build a concrete test question from a finding's real project code, send it to
 * Jev, and measure the response.
 */
async function buildAndRunTest(finding: AuditFinding, judge: Judge, projectPath: string): Promise<TestResult> {
  const testQuestion = await buildTestQuestion(finding, projectPath);
  const safeState = {
    project: finding.project,
    files: finding.files.map(f => f.split("/").pop() ?? f),  // redact to basenames
    task: finding.task,
    question: testQuestion,
  };

  const t0 = performance.now();
  try {
    const result = await ask(judge, {
      state: safeState,
      questions: {
        test: noul(testQuestion, {
          true: "The answer is yes / correct / applicable.",
          false: "The answer is no / incorrect / not applicable.",
        }),
      },
    });
    const elapsed = performance.now() - t0;

    if (!result.ok) {
      return { questionAsked: testQuestion, jevAnswer: `error: ${result.error}`, confidence: 0, responseTimeMs: elapsed, passed: false };
    }

    const answer = result.answers.test;
    const confidence = typeof answer === "object" && answer !== null && "noul" in answer ? (answer as { noul: number }).noul : PASS_THRESHOLD;
    const passed = confidence > PASS_THRESHOLD;

    return {
      questionAsked: testQuestion,
      jevAnswer: passed ? "yes" : "no",
      confidence,
      responseTimeMs: elapsed,
      passed,
    };
  } catch (err) {
    const elapsed = performance.now() - t0;
    return {
      questionAsked: testQuestion,
      jevAnswer: `error: ${err instanceof Error ? err.message : String(err)}`,
      confidence: 0,
      responseTimeMs: elapsed,
      passed: false,
    };
  }
}

/**
 * Read the finding's files from disk and extract a concrete example to form a
 * real test question. Falls back to the finding's generic question if file
 * content is unavailable.
 */
async function buildTestQuestion(finding: AuditFinding, projectPath: string): Promise<string> {
  for (const file of finding.files) {
    const content = readFileSafe(join(projectPath, file), 8000);
    if (!content) continue;

    // Extract a concrete identifier, path, or value from the file.
    const example = extractExample(content, finding);
    if (example) {
      return `${finding.question}\n\nConcrete example from the codebase: ${example}`;
    }
  }
  return finding.question;
}

/**
 * Try to pull a concrete value from source code that makes the finding's
 * question testable. Returns null when nothing useful can be extracted.
 */
function extractExample(content: string, finding: AuditFinding): string | null {
  const lines = content.split("\n");

  // Look for export declarations, function declarations, or constants.
  for (const line of lines) {
    const trimmed = line.trim();

    // Exported function or const — a good concrete anchor.
    if (/^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed)) {
      const name = trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/)?.[1];
      if (name) return `function ${name} (from source)`;
    }

    // Const with a string value — potential config/route/path.
    const constMatch = trimmed.match(/(?:export\s+)?const\s+(\w+)\s*[:=]\s*["'`](.+)["'`]/);
    if (constMatch) return `const ${constMatch[1]} = "${constMatch[2]}" (from source)`;
  }

  // Fallback: first non-empty, non-comment line.
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")) {
      return trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed;
    }
  }

  return null;
}


function priorityOrder(p: string): number {
  return p === "high" ? 0 : p === "medium" ? 1 : 2;
}

// ─── HTML generation ──────────────────────────────────────────────────────────

const fmtUnknown = (val: string) => val === "unknown" ? `<span style="color:var(--text-secondary);font-style:italic">unknown</span>` : esc(val);

export function generateAuditHTML(result: AuditResult, cwd: string): string {
  const { findings, skipped } = result;
  const projectName = cwd.split("/").pop() ?? "workspace";
  const high = findings.filter(f => f.priority === "high").length;
  const medium = findings.filter(f => f.priority === "medium").length;
  const low = findings.filter(f => f.priority === "low").length;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  const firstHigh = findings.find(f => f.priority === "high");
  const firstMedium = findings.find(f => f.priority === "medium");

  // Test result summary stats.
  const tested = findings.filter(f => f.testResult);
  const passed = tested.filter(f => f.testResult!.passed);
  const avgConf = tested.length > 0 ? tested.reduce((s, f) => s + f.testResult!.confidence, 0) / tested.length : 0;
  const avgMs = tested.length > 0 ? tested.reduce((s, f) => s + f.testResult!.responseTimeMs, 0) / tested.length : 0;

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
  --pass: #16a34a; --pass-bg: #f0fdf4; --pass-border: #bbf7d0;
  --fail: #dc2626; --fail-bg: #fef2f2; --fail-border: #fecaca;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a; --surface: #1e293b; --text: #f1f5f9; --text-secondary: #94a3b8;
    --border: #334155; --shadow: 0 1px 3px rgba(0,0,0,0.3);
    --high-bg: #1c0a0a; --high-border: #7f1d1d; --medium-bg: #1a1207; --medium-border: #78350f;
    --low-bg: #071a0d; --low-border: #14532d; --accent: #60a5fa;
    --pass-bg: #071a0d; --pass-border: #14532d; --fail-bg: #1c0a0a; --fail-border: #7f1d1d;
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
header { margin-bottom: 2rem; }
header h1 { font-size: 2rem; font-weight: 700; margin-bottom: 0.25rem; }
header .subtitle { color: var(--text-secondary); font-size: 0.95rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; box-shadow: var(--shadow); text-align: center; }
.stat .number { font-size: 2rem; font-weight: 700; }
.stat .label { font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem; }
.stat.high .number { color: var(--high); }
.stat.medium .number { color: var(--medium); }
.stat.low .number { color: var(--low); }
.stat.pass .number { color: var(--pass); }
.stat.fail .number { color: var(--fail); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 1rem; overflow: hidden; }
.card-header { padding: 1rem 1.25rem; display: flex; align-items: center; gap: 0.75rem; cursor: pointer; }
.card-header:hover { background: var(--bg); }
.badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
.badge-high { background: var(--high-bg); color: var(--high); border: 1px solid var(--high-border); }
.badge-medium { background: var(--medium-bg); color: var(--medium); border: 1px solid var(--medium-border); }
.badge-low { background: var(--low-bg); color: var(--low); border: 1px solid var(--low-border); }
.badge-effort { background: var(--surface); border: 1px solid var(--border); color: var(--text-secondary); }
.badge-pass { background: var(--pass-bg); color: var(--pass); border: 1px solid var(--pass-border); }
.badge-fail { background: var(--fail-bg); color: var(--fail); border: 1px solid var(--fail-border); }
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
.test-result { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-top: 1rem; }
.test-result h4 { margin-top: 0; }
.test-row { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-top: 0.5rem; }
.test-item { font-size: 0.85rem; }
.test-item .label { color: var(--text-secondary); }
.test-item .value { font-weight: 600; }
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
    <div class="stat pass"><div class="number">${passed.length}/${tested.length}</div><div class="label">Tests Passed</div></div>
    <div class="stat"><div class="number">${(avgConf * 100).toFixed(0)}%</div><div class="label">Avg Confidence</div></div>
    <div class="stat"><div class="number">${avgMs.toFixed(0)}ms</div><div class="label">Avg Response</div></div>
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
      <thead><tr><th>Task</th><th>Project</th><th>Priority</th><th>Setup Effort</th><th>Testing Ease</th><th>Frequency</th><th>Avg Confidence</th><th>Response</th></tr></thead>
      <tbody>
${findings.map(f => {
  const conf = f.testResult ? `${(f.testResult.confidence * 100).toFixed(0)}%` : "—";
  const resp = f.testResult ? `${f.testResult.responseTimeMs.toFixed(0)}ms` : "—";
  return `        <tr><td>${esc(f.task)}</td><td>${esc(f.project)}</td><td><span class="badge badge-${f.priority}">${f.priority}</span></td><td>${esc(f.setupEffort)}</td><td>${esc(f.testingEase)}</td><td>${fmtUnknown(f.frequency)}</td><td>${conf}</td><td>${resp}</td></tr>`;
}).join("\n")}
      </tbody>
    </table>
  </section>

  ${skipped.length > 0 ? `
  <section>
    <h2>Skipped Projects</h2>
    <table>
      <thead><tr><th>Project</th><th>Reason</th></tr></thead>
      <tbody>
${skipped.map(s => `        <tr><td>${esc(s.project)}</td><td>${esc(s.reason)}</td></tr>`).join("\n")}
      </tbody>
    </table>
  </section>
` : ""}

  <footer>
    <p>pi-warden audit &middot; ${findings.length} findings across ${new Set(findings.map(f => f.project)).size} project(s) &middot; ${tested.length} Jev tests &middot; ${timestamp}</p>
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
  const testSection = f.testResult ? `
        <div class="test-result">
          <h4>Jev Test Result <span class="badge badge-${f.testResult.passed ? "pass" : "fail"}">${f.testResult.passed ? "passed" : "failed"}</span></h4>
          <div class="test-row">
            <div class="test-item"><span class="label">Question: </span><span class="value">${esc(f.testResult.questionAsked)}</span></div>
            <div class="test-item"><span class="label">Answer: </span><span class="value">${esc(f.testResult.jevAnswer)}</span></div>
            <div class="test-item"><span class="label">Confidence: </span><span class="value">${(f.testResult.confidence * 100).toFixed(1)}%</span></div>
            <div class="test-item"><span class="label">Response: </span><span class="value">${f.testResult.responseTimeMs.toFixed(0)}ms</span></div>
          </div>
        </div>` : "";
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
        ${testSection}
        <div class="meta">
          <span class="badge badge-effort">effort: ${esc(f.setupEffort)}</span>
          <span class="badge badge-effort">testing: ${esc(f.testingEase)}</span>
          <span class="badge badge-effort">frequency: ${fmtUnknown(f.frequency)}</span>
          <span class="badge badge-effort">cost: ${fmtUnknown(f.costImpact)}</span>
        </div>
      </div>
    </div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
