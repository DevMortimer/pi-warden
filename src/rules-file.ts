import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RulesConfig } from "./config.js";
import { redact } from "./redact.js";
import { RuleStore, RULES_FILE, FALLBACK_FILES } from "./rules.js";

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
  { path: RULES_FILE, source: RULES_FILE },
  ...FALLBACK_FILES.map(f => ({ path: f, source: f })),
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
  const budget = maxTokens * 4;
  for (const block of ruleBlocks) {
    if (charCount + block.length > budget) {
      // Include a partial block so the result is never empty when rules exist.
      if (!result.length && budget > 0) result.push(block.slice(0, budget));
      break;
    }
    result.push(block);
    charCount += block.length;
  }
  return result.join("\n\n");
}

/** Resolve the active rules file. Returns the first existing file, or null. Content is redacted before it leaves this machine. */
export function resolveRulesFile(cwd: string): ResolvedRulesFile | null {
  for (const candidate of RULES_CANDIDATES) {
    const fullPath = join(cwd, candidate.path);
    if (existsSync(fullPath)) {
      let raw: string;
      try {
        raw = readFileSync(fullPath, "utf8");
      } catch {
        // Unreadable or non-file entries (e.g., directories matching a candidate name) are skipped.
        continue;
      }
      const content = raw.length > MAX_CHARS ? redact(extractRules(raw)) : redact(raw);
      return { path: fullPath, content, source: candidate.source };
    }
  }
  return null;
}

const missingStore = new RuleStore();

/**
 * Whether the first-run "no project rules" notice should fire, and which document is being judged.
 *
 * RuleStore.loadTiered owns the resolution order, so ask it which tier answered instead of walking
 * the filesystem here. Inferring one warns while the configured files are the ones in force, names a
 * fallback document the config turned off, or names a `rules.files` entry after the file it points at.
 */
export function checkPiWardenMissing(
  cwd: string,
  config: Pick<RulesConfig, "files" | "fallback" | "maxChars">,
): { missing: boolean; fallbackSource?: string | undefined } {
  const { set, tier } = missingStore.loadTiered(cwd, config);
  if (tier === "none") return { missing: true };
  // A project that has a rules source of its own is not missing one, empty file or not: /warden init
  // would name the file the project already has, and a pi-warden.md would shadow a bound `rules.files`.
  return tier === "fallback" ? { missing: true, fallbackSource: set?.sources[0] } : { missing: false };
}
