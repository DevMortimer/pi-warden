import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolved active rules file for escalation and context.
 * Resolution order: pi-warden.md → AGENTS.md → CLAUDE.md → README.md.
 */

export interface ResolvedRulesFile {
  path: string;
  content: string;
  source: string;
}

const RULES_CANDIDATES = [
  { path: "pi-warden.md", source: "pi-warden.md" },
  { path: "AGENTS.md", source: "AGENTS.md" },
  { path: "CLAUDE.md", source: "CLAUDE.md" },
  { path: "README.md", source: "README.md" },
];

const MAX_CHARS = 16_000; // ~4000 tokens

/** Token-aware truncation: extract heading blocks, cap at maxTokens (1 token ≈ 4 chars). */
export function extractRules(content: string, maxTokens = 4000): string {
  const lines = content.split("\n");
  const ruleBlocks: string[] = [];
  let currentBlock: string[] = [];
  let inRule = false;

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      if (currentBlock.length) ruleBlocks.push(currentBlock.join("\n"));
      currentBlock = [line];
      inRule = true;
    } else if (inRule) {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length) ruleBlocks.push(currentBlock.join("\n"));

  const result: string[] = [];
  let charCount = 0;
  for (const block of ruleBlocks) {
    if (charCount + block.length > maxTokens * 4) break;
    result.push(block);
    charCount += block.length;
  }
  return result.join("\n\n");
}

/** Resolve the active rules file. Returns the first existing file, or null. */
export function resolveRulesFile(cwd: string): ResolvedRulesFile | null {
  for (const candidate of RULES_CANDIDATES) {
    const fullPath = join(cwd, candidate.path);
    if (existsSync(fullPath)) {
      const raw = readFileSync(fullPath, "utf8");
      const content = raw.length > MAX_CHARS ? extractRules(raw) : raw;
      return { path: fullPath, content, source: candidate.source };
    }
  }
  return null;
}

/** Returns missing status and the fallback source if pi-warden.md is absent. */
export function checkPiWardenMissing(cwd: string): { missing: boolean; fallbackSource?: string } {
  if (existsSync(join(cwd, "pi-warden.md"))) return { missing: false };
  for (const candidate of RULES_CANDIDATES.slice(1)) {
    if (existsSync(join(cwd, candidate.path))) return { missing: true, fallbackSource: candidate.source };
  }
  return { missing: true };
}
