import type { EditView, Rule, RuleOutcome, RulesTarget } from "./rules.js";

/**
 * Deterministic System-0 rule compiler and precondition router.
 *
 * Separates mechanical constraint enforcement and file/language preconditions (<1 ms, $0,
 * `source: "code"`) from semantic judgment (`source: "typesafe"`). Mechanical rules run even when
 * TypeSafe is disabled, and locally-settled rules are stripped before sending semantic rules to Jev.
 */

export type System0Kind =
  | "explicit-header"
  | "ai-attribution"
  | "forbidden-terms"
  | "empty-catch"
  | "forbidden-call"
  | "precondition";

export interface System0RuleResult {
  rule: Rule;
  outcome: RuleOutcome;
  violation: number;
  decisive: boolean;
  kind: System0Kind;
  reason?: string;
}

export interface CompiledRule {
  rule: Rule;
  kinds: System0Kind[];
  /** Evaluates the rule locally. Returns `undefined` when semantic judgment is still needed. */
  evaluate: (target: RulesTarget, addedText: string) => System0RuleResult | undefined;
}

export interface System0Evaluation {
  /** Rules decisively settled in System-0 (`violation`, `compliant`, or `not_applicable`). */
  decisive: System0RuleResult[];
  /** Rules that still require semantic evaluation when a judge is active. */
  semantic: Rule[];
  /** Non-decisive System-0 rules that fall back to `compliant` when running offline without a judge. */
  offlineCompliant: System0RuleResult[];
}

const NON_CODE_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "json", "jsonc", "yaml", "yml", "toml",
  "css", "scss", "sass", "less", "html", "htm", "svg", "lock", "csv", "ini", "xml",
]);

const JS_TS_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);
const PYTHON_EXTENSIONS = new Set(["py", "pyi", "pyw"]);

const NON_PYTHON_PRECONDITION_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "css", "scss", "sass", "less", "html", "htm", "md", "markdown", "mdx",
  "rs", "go", "sql", "java", "kt", "rb", "c", "cpp", "h", "hpp",
]);

const NON_TS_PRECONDITION_EXTENSIONS = new Set([
  "py", "pyi", "pyw", "rs", "go", "sql", "md", "markdown", "mdx",
  "css", "scss", "sass", "less", "html", "htm", "rb", "java", "kt",
  "yaml", "yml", "toml", "sh", "bash", "zsh",
]);

const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^./]+$|_test\.[^./]+$/i;
const SQL_MIGRATION_PATH = /migration|\.sql$/i;
const SQL_DDL = /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|ADD\s+COLUMN|CREATE\s+INDEX|DROP\s+INDEX)\b/i;

const ATTRIBUTION_LINE = /^\s*(?:(?:\/\/|#|<!--|--|\*)\s*)?(?:Co-authored-by:|Generated (?:by|with)\b|🤖\s*Generated)/im;
const UNIFIED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const UNIFIED_FILE_HEADER = /^(?:---|\+\+\+) /m;

/** Upper bound on LCS DP table cells so diff extraction stays strictly sub-millisecond. */
const MAX_LCS_CELLS = 200_000;

function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRegexLiteral(raw: string): RegExp | undefined {
  const match = /^\/(.+)\/([dgimsuvy]*)$/.exec(raw.trim());
  if (!match) return undefined;
  // Strip stateful global/sticky flags so repeated `.test()` calls are pure.
  const flags = match[2]!.replace(/[gy]/g, "");
  try {
    return new RegExp(match[1]!, flags);
  } catch {
    return undefined;
  }
}

/** Extracts `+` lines (excluding `+++` headers) from a unified diff string. */
function addedLinesFromDiff(diff: string): string[] {
  const added: string[] = [];
  for (const line of diff.split(/\r\n|\r|\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++ ") && line !== "+++") {
      added.push(line.slice(1));
    }
  }
  return added;
}

/** Computes lines present in `after` that were not matched in `before`, preserving order. */
function addedLinesBetween(before: string, after: string): string[] {
  const a = before.split(/\r\n|\r|\n/);
  const b = after.split(/\r\n|\r|\n/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= prefix && bEnd >= prefix && a[aEnd] === b[bEnd]) {
    aEnd--;
    bEnd--;
  }
  const aMid = a.slice(prefix, aEnd + 1);
  const bMid = b.slice(prefix, bEnd + 1);
  if (!bMid.length) return [];
  if (!aMid.length) return bMid;

  const m = aMid.length;
  const n = bMid.length;
  if (m * n > MAX_LCS_CELLS) {
    const counts = new Map<string, number>();
    for (const line of aMid) counts.set(line, (counts.get(line) ?? 0) + 1);
    const out: string[] = [];
    for (const line of bMid) {
      const remaining = counts.get(line) ?? 0;
      if (remaining > 0) counts.set(line, remaining - 1);
      else out.push(line);
    }
    return out;
  }

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    const lineA = aMid[i - 1]!;
    for (let j = 1; j <= n; j++) {
      row[j] = lineA === bMid[j - 1]! ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
  }
  const added: string[] = [];
  let i = m;
  let j = n;
  while (j > 0) {
    if (i > 0 && aMid[i - 1] === bMid[j - 1]) {
      i--;
      j--;
    } else if (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!) {
      added.push(bMid[j - 1]!);
      j--;
    } else {
      i--;
    }
  }
  added.reverse();
  return added;
}

function addedLinesFromEdit(edit: EditView): string[] {
  const isDiff = edit.id === "diff" || (UNIFIED_HUNK.test(edit.newText) && UNIFIED_FILE_HEADER.test(edit.newText));
  if (isDiff) return addedLinesFromDiff(edit.newText);
  if (edit.before !== undefined && edit.after !== undefined) {
    return addedLinesBetween(edit.before, edit.after);
  }
  if (edit.before !== undefined) {
    const beforeLines = edit.before.split(/\r\n|\r|\n/);
    const beforeSet = new Set(beforeLines);
    const newLines = edit.newText.split(/\r\n|\r|\n/);
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < newLines.length && beforeLines[prefix] === newLines[prefix]) prefix++;
    let bEnd = beforeLines.length - 1;
    let nEnd = newLines.length - 1;
    while (bEnd >= prefix && nEnd >= prefix && beforeLines[bEnd] === newLines[nEnd]) {
      bEnd--;
      nEnd--;
    }
    const middle = newLines.slice(prefix, nEnd + 1);
    return middle.filter(line => !beforeSet.has(line) || /^[\s{}()[\];,]+$/.test(line));
  }
  return edit.newText.split(/\r\n|\r|\n/);
}

/**
 * Extracts only the newly added text from a `RulesTarget` so System-0 checks never blame an edit
 * for pre-existing violations in unchanged context or removed `-` diff lines.
 */
export function extractAddedText(target: RulesTarget): string {
  if (target.tool === "write") return target.content ?? "";
  if (!target.edits?.length) return "";
  return target.edits.flatMap(addedLinesFromEdit).join("\n");
}

// ---------------------------------------------------------------------------
// Balanced JS/TS/C-style empty-catch scanner & Python `except: pass` detector

/**
 * Finds whether `source` introduces an empty or comment-only brace-delimited `catch` block,
 * ignoring `catch` tokens inside string literals or comments.
 */
function scanBraceCatches(source: string): { hasCatch: boolean; hasEmptyCatch: boolean } {
  const len = source.length;
  let i = 0;
  let hasCatch = false;

  const skipString = (quote: string) => {
    i++;
    while (i < len) {
      const ch = source[i]!;
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) { i++; return; }
      i++;
    }
  };

  const skipLineComment = () => {
    i += 2;
    while (i < len && source[i] !== "\n") i++;
  };

  const skipBlockComment = () => {
    i += 2;
    while (i + 1 < len && !(source[i] === "*" && source[i + 1] === "/")) i++;
    if (i + 1 < len) i += 2;
  };

  const skipWsAndComments = () => {
    while (i < len) {
      const ch = source[i]!;
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i++; continue; }
      if (ch === "/" && source[i + 1] === "/") { skipLineComment(); continue; }
      if (ch === "/" && source[i + 1] === "*") { skipBlockComment(); continue; }
      break;
    }
  };

  const isIdentChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

  while (i < len) {
    const ch = source[i]!;
    if (ch === "'" || ch === "\"" || ch === "`") { skipString(ch); continue; }
    if (ch === "/" && source[i + 1] === "/") { skipLineComment(); continue; }
    if (ch === "/" && source[i + 1] === "*") { skipBlockComment(); continue; }
    if (
      source.startsWith("catch", i)
      && !isIdentChar(source[i - 1])
      && !isIdentChar(source[i + 5])
    ) {
      const afterWord = i + 5;
      i = afterWord;
      skipWsAndComments();
      // Optional binding: `catch (err)` or `catch (err: unknown)`
      if (source[i] === "(") {
        let depth = 1;
        i++;
        while (i < len && depth > 0) {
          const c = source[i]!;
          if (c === "'" || c === "\"" || c === "`") { skipString(c); continue; }
          if (c === "/" && source[i + 1] === "/") { skipLineComment(); continue; }
          if (c === "/" && source[i + 1] === "*") { skipBlockComment(); continue; }
          if (c === "(") depth++;
          else if (c === ")") depth--;
          i++;
        }
        skipWsAndComments();
      }
      if (source[i] === "{") {
        hasCatch = true;
        i++;
        const bodyStart = i;
        let depth = 1;
        let hasCode = false;
        while (i < len && depth > 0) {
          const c = source[i]!;
          if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
          if (c === "/" && source[i + 1] === "/") { skipLineComment(); continue; }
          if (c === "/" && source[i + 1] === "*") { skipBlockComment(); continue; }
          if (c === "'" || c === "\"" || c === "`") { hasCode = true; skipString(c); continue; }
          if (c === "{") { depth++; hasCode = true; i++; continue; }
          if (c === "}") { depth--; i++; continue; }
          hasCode = true;
          i++;
        }
        if (depth === 0 && !hasCode && i > bodyStart) {
          return { hasCatch: true, hasEmptyCatch: true };
        }
      }
      continue;
    }
    i++;
  }
  return { hasCatch, hasEmptyCatch: false };
}

/** Detects bare Python `except ...:\n    pass` (or `except ...: pass`) without comment/re-raise/log. */
function scanPythonExcepts(source: string): { hasExcept: boolean; hasEmptyExcept: boolean } {
  const lines = source.split(/\r\n|\r|\n/);
  let hasExcept = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const match = /^([ \t]*)except(?:\b[^\n:]*)?:(.*)$/.exec(lines[idx]!);
    if (!match) continue;
    hasExcept = true;
    const indent = match[1]!.length;
    const rest = match[2]!.trim();
    if (rest.length > 0) {
      if (rest === "pass") return { hasExcept: true, hasEmptyExcept: true };
      continue;
    }
    const bodyLines: string[] = [];
    for (let j = idx + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.trim()) continue;
      const lineIndent = /^([ \t]*)/.exec(line)![1]!.length;
      if (lineIndent <= indent) break;
      bodyLines.push(line.trim());
    }
    if (bodyLines.length === 1 && bodyLines[0] === "pass") {
      return { hasExcept: true, hasEmptyExcept: true };
    }
  }
  return { hasExcept, hasEmptyExcept: false };
}

// ---------------------------------------------------------------------------
// Rule pattern extractors

function isAttributionRule(rule: Rule): boolean {
  const combined = `${rule.name}\n${rule.body}`;
  if (/\b(?:no|never|forbid(?:s|den)?|ban|avoid)\b[^\n]{0,60}\battribution\b/i.test(rule.name)) return true;
  return /\b(?:no|never|forbid(?:s|den)?|do\s+not|don't|must\s+not|without)\b[^.\n]{0,80}(?:generated\s+by|co-authored-by|attribution)/i.test(combined)
    && /(?:generated\s+by|co-authored-by|ai\s+attribution|tool\s+or\s+ai\s+attribution)/i.test(combined);
}

function extractForbiddenTerms(rule: Rule): string[] | undefined {
  const combined = `${rule.name}\n${rule.body}`;
  const forbidsTerms = /\b(?:no|never|forbid(?:s|den)?|ban(?:s|ned)?|must\s+not|do\s+not|don't)\b[^.\n]{0,90}\b(?:internal|private|harness|codenames?|roles?|terms?|words?|jargon|terminolog(?:y|ies))\b/i.test(combined);
  if (!forbidsTerms) return undefined;

  const sentences = rule.body.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (!/\b(?:no|never|forbid|not|avoid|ban|without)\b/i.test(sentence)) continue;
    for (const match of sentence.matchAll(/\(([^()]{3,200})\)/g)) {
      const rawItems = match[1]!.split(",").map((part, index) => {
        let cleaned = part.trim();
        if (index === 0) cleaned = cleaned.replace(/^(?:e\.g\.|for\s+example|such\s+as|like)\s+/i, "");
        return cleaned.replace(/^["'`]|["'`]$/g, "").trim();
      }).filter(Boolean);
      if (rawItems.length < 2) continue;
      if (rawItems.every(item => /^[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,2}$/i.test(item))) {
        return rawItems;
      }
    }
  }
  return undefined;
}

function isSwallowedErrorRule(rule: Rule): boolean {
  if (/\b(?:errors?\s+(?:are\s+)?not\s+swallowed|no\s+(?:empty|swallowed)\s+(?:catch|except|errors?)|never\s+swallow\s+errors?|do\s+not\s+swallow\s+errors?)\b/i.test(rule.name)) {
    return true;
  }
  const combined = `${rule.name}\n${rule.body}`;
  return /\b(?:catch|except)\b/i.test(combined)
    && /\b(?:empty\s+catch|swallow(?:ed|ing)?\s+(?:errors?|exceptions?)|comment[- ]only\s+(?:catch|body))\b/i.test(combined);
}

interface ForbiddenCallSpec {
  languages: ReadonlySet<string>;
  libraryOnly: boolean;
  patterns: RegExp[];
  label: string;
}

function extractForbiddenCallSpec(rule: Rule): ForbiddenCallSpec | undefined {
  const heading = rule.name;
  const combined = `${rule.name}\n${rule.body}`;
  const libraryOnly = /\bin\s+(?:library|production)\s+code\b/i.test(combined);

  if (/\b(?:no|never|forbid(?:s|den)?|ban|avoid|do\s+not\s+use)\b[^\n]{0,60}\bconsole\.log\b/i.test(heading)) {
    return { languages: JS_TS_EXTENSIONS, libraryOnly, patterns: [/\bconsole\.log\s*\(/], label: "console.log(" };
  }
  if (/\b(?:no|never|forbid(?:s|den)?|ban|avoid|do\s+not\s+use)\b[^\n]{0,60}\bdebugger\b/i.test(heading)) {
    return { languages: JS_TS_EXTENSIONS, libraryOnly, patterns: [/\bdebugger\b/], label: "debugger" };
  }
  if (/\b(?:no|never|forbid(?:s|den)?|ban|avoid|do\s+not\s+use)\b[^\n]{0,60}\b(?:print\b|stdlib\s+logging\b)/i.test(heading)) {
    const patterns: RegExp[] = [];
    if (/\bprint\b/i.test(heading)) patterns.push(/(?:^|[^\w.])print\s*\(/m);
    if (/\blogging\b/i.test(heading)) patterns.push(/^\s*(?:import\s+logging\b|from\s+logging\s+import\b)/m);
    if (patterns.length) {
      return { languages: PYTHON_EXTENSIONS, libraryOnly, patterns, label: "print/logging" };
    }
  }
  return undefined;
}

function isMigrationRule(rule: Rule): boolean {
  return /\bmigrations?\b/i.test(rule.name);
}

function targetLanguagePrecondition(rule: Rule): "python" | "ts-react" | undefined {
  const combined = `${rule.name}\n${rule.body}`;
  const mentionsPython = /\b(?:python|pytest|pyproject(?:\.toml)?|stdlib\s+logging|pipfile|venv)\b|\bdef\s+[a-z_]\w*\s*\(/i.test(combined);
  const mentionsJsTs = /\b(?:typescript|javascript|tsx|jsx|react\s+(?:component|hook|jsx)|useEffect|useState|tsconfig|node|npm)\b/i.test(combined)
    || /\bno\s+explicit\s+any\b/i.test(rule.name);
  const mentionsOther = /\b(?:rust|golang|sql)\b/i.test(combined);
  if (mentionsPython && !mentionsJsTs && !mentionsOther) return "python";
  if (mentionsJsTs && !mentionsPython && !mentionsOther) return "ts-react";
  return undefined;
}

// ---------------------------------------------------------------------------
// Public compiler & evaluator

/**
 * Compiles a parsed `Rule` into a deterministic System-0 evaluator and precondition router.
 * Purely semantic rules compile with `kinds: []` and always return `undefined` (handed to Jev).
 */
export function compileRule(rule: Rule): CompiledRule {
  const kinds: System0Kind[] = [];
  const extensions = rule.extensions?.length ? new Set(rule.extensions) : undefined;
  if (extensions) kinds.push("precondition");

  const forbidRegexes = (rule.forbid ?? [])
    .map(raw => ({ raw, regex: parseRegexLiteral(raw) }))
    .filter((entry): entry is { raw: string; regex: RegExp } => entry.regex !== undefined);
  const forbidTokens = rule.forbidTokens?.filter(Boolean) ?? [];
  const requireTokens = rule.requireTokens?.filter(Boolean) ?? [];
  const hasExplicitCheck = forbidRegexes.length > 0 || forbidTokens.length > 0 || requireTokens.length > 0;
  if (hasExplicitCheck) kinds.push("explicit-header");

  const attribution = !hasExplicitCheck && isAttributionRule(rule);
  if (attribution) kinds.push("ai-attribution");

  const forbiddenTerms = !hasExplicitCheck && !attribution ? extractForbiddenTerms(rule) : undefined;
  const forbiddenTermRegexes = forbiddenTerms?.map(term => ({
    term,
    regex: new RegExp(`\\b${escapeRegExp(term).replace(/\s+/g, "\\s+")}\\b`, "i"),
  }));
  if (forbiddenTermRegexes) kinds.push("forbidden-terms");

  const swallowedError = !hasExplicitCheck && !attribution && !forbiddenTermRegexes && isSwallowedErrorRule(rule);
  if (swallowedError) kinds.push("empty-catch");

  const forbiddenCall = !hasExplicitCheck && !attribution && !forbiddenTermRegexes && !swallowedError
    ? extractForbiddenCallSpec(rule)
    : undefined;
  if (forbiddenCall) kinds.push("forbidden-call");

  const migration = isMigrationRule(rule);
  const languageScope = targetLanguagePrecondition(rule);
  if ((migration || languageScope) && !kinds.includes("precondition")) kinds.push("precondition");

  return {
    rule,
    kinds,
    evaluate(target: RulesTarget, addedText: string): System0RuleResult | undefined {
      const ext = fileExtension(target.path);

      // 0. Explicit `extensions:` header scopes the rule before any evaluator runs.
      if (extensions && (!ext || !extensions.has(ext))) {
        return {
          rule,
          outcome: "not_applicable",
          violation: 0,
          decisive: true,
          kind: "precondition",
          reason: `extension .${ext || "(none)"} not in extensions: ${rule.extensions!.join(", ")}`,
        };
      }

      // 1. Explicit deterministic headers (`forbid:`, `forbid-token:`, `require-token:`).
      if (hasExplicitCheck) {
        for (const { raw, regex } of forbidRegexes) {
          if (regex.test(addedText)) {
            return { rule, outcome: "violation", violation: 1, decisive: true, kind: "explicit-header", reason: `matched forbid pattern ${raw}` };
          }
        }
        for (const token of forbidTokens) {
          if (addedText.includes(token)) {
            return { rule, outcome: "violation", violation: 1, decisive: true, kind: "explicit-header", reason: `matched forbidden token "${token}"` };
          }
        }
        if (addedText.trim().length > 0) {
          for (const token of requireTokens) {
            if (!addedText.includes(token)) {
              return { rule, outcome: "violation", violation: 1, decisive: true, kind: "explicit-header", reason: `missing required token "${token}"` };
            }
          }
        }
        return { rule, outcome: "compliant", violation: 0, decisive: true, kind: "explicit-header" };
      }

      // 2a. AI / tool attribution lines.
      if (attribution) {
        return ATTRIBUTION_LINE.test(addedText)
          ? { rule, outcome: "violation", violation: 1, decisive: true, kind: "ai-attribution", reason: "matched tool or AI attribution line" }
          : { rule, outcome: "compliant", violation: 0, decisive: true, kind: "ai-attribution" };
      }

      // 2b. Explicit forbidden internal-term list.
      if (forbiddenTermRegexes) {
        for (const { term, regex } of forbiddenTermRegexes) {
          if (regex.test(addedText)) {
            return { rule, outcome: "violation", violation: 1, decisive: true, kind: "forbidden-terms", reason: `matched forbidden term "${term}"` };
          }
        }
        return { rule, outcome: "compliant", violation: 0, decisive: true, kind: "forbidden-terms" };
      }

      // 2c. Swallowed error / empty catch blocks.
      if (swallowedError) {
        if (ext && NON_CODE_EXTENSIONS.has(ext)) {
          return { rule, outcome: "not_applicable", violation: 0, decisive: true, kind: "empty-catch" };
        }
        if (!/\b(?:catch|except)\b/.test(addedText)) {
          return { rule, outcome: "compliant", violation: 0, decisive: true, kind: "empty-catch" };
        }
        const py = PYTHON_EXTENSIONS.has(ext) ? scanPythonExcepts(addedText) : { hasExcept: false, hasEmptyExcept: false };
        if (py.hasEmptyExcept) {
          return { rule, outcome: "violation", violation: 1, decisive: true, kind: "empty-catch", reason: "empty Python except: pass block" };
        }
        const brace = !PYTHON_EXTENSIONS.has(ext) ? scanBraceCatches(addedText) : { hasCatch: false, hasEmptyCatch: false };
        if (brace.hasEmptyCatch) {
          return { rule, outcome: "violation", violation: 1, decisive: true, kind: "empty-catch", reason: "empty or comment-only catch block" };
        }
        if (!py.hasExcept && !brace.hasCatch) {
          return { rule, outcome: "compliant", violation: 0, decisive: true, kind: "empty-catch" };
        }
        // Non-trivial catch/except body: defer to Jev when online, or fall back to compliant offline.
        return { rule, outcome: "compliant", violation: 0, decisive: false, kind: "empty-catch" };
      }

      // 2d. Forbidden `console.log` / `debugger` / Python `print(` / `stdlib logging`.
      if (forbiddenCall) {
        if (ext && !forbiddenCall.languages.has(ext)) {
          return { rule, outcome: "not_applicable", violation: 0, decisive: true, kind: "forbidden-call" };
        }
        if (forbiddenCall.libraryOnly && TEST_PATH.test(target.path)) {
          return { rule, outcome: "not_applicable", violation: 0, decisive: true, kind: "forbidden-call" };
        }
        for (const pattern of forbiddenCall.patterns) {
          if (pattern.test(addedText)) {
            return { rule, outcome: "violation", violation: 1, decisive: true, kind: "forbidden-call", reason: `matched forbidden ${forbiddenCall.label}` };
          }
        }
        return { rule, outcome: "compliant", violation: 0, decisive: true, kind: "forbidden-call" };
      }

      // 3. Precondition routing (`not_applicable` pre-gate before Jev).
      if (migration && !SQL_MIGRATION_PATH.test(target.path) && !SQL_DDL.test(addedText)) {
        return { rule, outcome: "not_applicable", violation: 0, decisive: true, kind: "precondition", reason: "not a SQL migration file or DDL edit" };
      }
      if (languageScope === "python" && ext && NON_PYTHON_PRECONDITION_EXTENSIONS.has(ext)) {
        return { rule, outcome: "not_applicable", violation: 0, decisive: true, kind: "precondition", reason: `Python rule not applicable to .${ext}` };
      }
      if (languageScope === "ts-react" && ext && NON_TS_PRECONDITION_EXTENSIONS.has(ext)) {
        return { rule, outcome: "not_applicable", violation: 0, decisive: true, kind: "precondition", reason: `TypeScript/React rule not applicable to .${ext}` };
      }

      return undefined;
    },
  };
}

/**
 * Evaluates a set of applicable rules against `target` in System-0.
 * Partitioned into `decisive` (settled locally at $0), `semantic` (forwarded to Jev when enabled),
 * and `offlineCompliant` (non-decisive System-0 checks that resolve cleanly when no judge is active).
 */
export function evaluateSystem0(target: RulesTarget, rules: readonly Rule[]): System0Evaluation {
  const addedText = extractAddedText(target);
  const decisive: System0RuleResult[] = [];
  const semantic: Rule[] = [];
  const offlineCompliant: System0RuleResult[] = [];

  for (const rule of rules) {
    const result = compileRule(rule).evaluate(target, addedText);
    if (!result) {
      semantic.push(rule);
    } else if (result.decisive) {
      decisive.push(result);
    } else {
      semantic.push(rule);
      offlineCompliant.push(result);
    }
  }
  return { decisive, semantic, offlineCompliant };
}
