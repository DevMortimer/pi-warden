import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RulesConfig } from "./config.js";
import { redact } from "./redact.js";
import { RuleStore, RULES_FILE, FALLBACK_FILES } from "./rules.js";
import type { RulesSourceConfig } from "./rules.js";

/**
 * The rules content for escalation and context. The order is the rules guard's: pi-warden.md alone, else the files in
 * `rules.files`, in order, else the fallback names while `rules.fallback` is on. An empty document counts where the
 * guard counts it: a configured file is a source whatever it holds, a fallback document has to say something.
 */

export interface ResolvedRulesFile {
  content: string;
  /** The file name, or the configured names joined by commas, as the config spells them. */
  source: string;
}

const MAX_CHARS = 16_000; // ~4000 tokens
/** A rules file's text, or undefined when it is missing, unreadable, or a directory. */
function readRules(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Unreadable or non-file entries (e.g., directories matching a candidate name) are skipped.
    return undefined;
  }
}

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

/** Content is redacted before it leaves this machine, and capped once it is past the budget. */
function redactAndCap(source: string, raw: string): ResolvedRulesFile {
  return { content: raw.length > MAX_CHARS ? redact(extractRules(raw)) : redact(raw), source };
}

/**
 * Resolve the rules content the escalation request carries. Returns null when the config reaches no document.
 *
 * `RuleStore` judges with the documents this returns, in this order, so the request names the rules in force. What
 * differs is the cap: the request carries one budget for the whole field (`MAX_CHARS`) where the guard spends
 * `rules.maxChars` per resolution.
 */
export function resolveRulesFile(
  cwd: string,
  config?: Partial<RulesSourceConfig>,
): ResolvedRulesFile | null {
  const root = resolve(cwd, RULES_FILE);
  const rootContent = readRules(root);
  if (rootContent !== undefined) return redactAndCap(RULES_FILE, rootContent);

  const configured: { source: string; content: string }[] = [];
  for (const entry of config?.files ?? []) {
    const content = readRules(resolve(cwd, entry));
    if (content !== undefined) configured.push({ source: entry, content });
  }
  if (configured.length) {
    return redactAndCap(
      configured.map(file => file.source).join(", "),
      configured.map(file => file.content).join("\n\n"),
    );
  }

  if (config?.fallback === false) return null;
  for (const file of FALLBACK_FILES) {
    const content = readRules(resolve(cwd, file));
    // A blank fallback document is not a source: the store walks on to the next name, so this does too.
    if (content?.trim()) return redactAndCap(file, content);
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
