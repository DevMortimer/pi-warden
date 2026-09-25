// Tunes the project-rules questions against a case set. Billable: one request per case. Usage: node scripts/rules-cases.mjs
// Run `npm run build` first; this reads dist/.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTypeSafe } from 'pi-typesafe';
import { defaultConfig } from '../dist/config.js';
import { evaluateRules, RuleStore } from '../dist/rules.js';

const RULES = `# No console statements
Code must not contain \`console.log\`, \`console.debug\`, or \`console.info\` calls. Use the logger or remove them.

# No explicit any type
paths: **/*.ts, **/*.tsx
TypeScript code must not use the \`any\` type. Use a specific type, \`unknown\`, or a generic parameter.

# TODO comments need a reference
Any \`TODO\` or \`FIXME\` comment must include a ticket reference, for example \`TODO(JIRA-123): ...\`. A bare TODO is a violation.

# No empty catch blocks
A \`catch\` block must not be empty. It must handle the error, log it, or rethrow it.

# Switch statements must have a default case
Every \`switch\` statement must include a \`default\` case, even if it only throws on an unexpected value.

# No hardcoded credentials
Source code must not contain hardcoded passwords, API keys, or tokens; these come from configuration.

# Exported functions must have explicit return types
paths: **/*.ts, **/*.tsx
Every exported function must declare its return type explicitly rather than relying on inference.

# Boolean names start with is/has/should/can
A boolean variable or property must be named with a predicate prefix such as \`is\`, \`has\`, \`should\`, or \`can\`.

# Every exported function documents its return value
paths: src/**/*.js
An exported function or arrow constant in \`src/\` carries a JSDoc block with a \`@returns\` tag directly above it.
`;

const cases = [
  { name: 'console.log in code', tool: 'write', path: 'src/user.ts', content: 'export function findUser(id: string): User | undefined {\n  console.log("looking up", id);\n  return users.get(id);\n}\n', expect: ['no-console-statements'] },
  { name: 'any parameter', tool: 'write', path: 'src/parse.ts', content: 'export function parse(input: any): number {\n  return Number(input);\n}\n', expect: ['no-explicit-any-type'] },
  { name: 'python file: ts-scoped rules not asked', tool: 'write', path: 'scripts/tool.py', content: 'def parse(value):\n    # any value works here\n    return int(value)\n', expect: [], asked: 6 },
  { name: 'bare TODO', tool: 'edit', path: 'src/queue.ts', edits: [{ oldText: 'return items;', newText: '// TODO handle the empty case\nreturn items;' }], expect: ['todo-comments-need-a-reference'] },
  { name: 'TODO with ticket', tool: 'edit', path: 'src/queue.ts', edits: [{ oldText: 'return items;', newText: '// TODO(QUEUE-41): handle the empty case once the API returns a count\nreturn items;' }], expect: [] },
  { name: 'empty catch', tool: 'write', path: 'src/load.ts', content: 'export async function load(path: string): Promise<string> {\n  try {\n    return await readFile(path, "utf8");\n  } catch {}\n  return "";\n}\n', expect: ['no-empty-catch-blocks'] },
  { name: 'switch without default', tool: 'write', path: 'src/level.ts', content: 'export function color(level: Level): string {\n  switch (level) {\n    case "warn": return "yellow";\n    case "error": return "red";\n  }\n  return "white";\n}\n', expect: ['switch-statements-must-have-a-default-case'] },
  { name: 'hardcoded token', tool: 'write', path: 'src/client.ts', content: 'const TOKEN = "ghp_1234567890abcdefghijklmnopqrstuv";\nexport function client(): Client {\n  return new Client({ token: TOKEN });\n}\n', expect: ['no-hardcoded-credentials'] },
  { name: 'missing return type + bad boolean name', tool: 'write', path: 'src/flags.ts', content: 'export function enabled(config: Config) {\n  const active = config.mode !== "off";\n  return active;\n}\n', expect: ['exported-functions-must-have-explicit-return-types', 'boolean-names-start-with-is-has-should-can'] },
  { name: 'compliant module', tool: 'write', path: 'src/sum.ts', content: 'export function sum(values: readonly number[]): number {\n  let total = 0;\n  for (const value of values) total += value;\n  return total;\n}\n', expect: [] },
  { name: 'compliant test with console in a string', tool: 'write', path: 'tests/logger.test.ts', content: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { format } from "../src/logger.js";\n\ntest("format names the level", () => {\n  assert.equal(format("warn", "x"), "[warn] x");\n  assert.ok(!format("warn", "console.log").includes("undefined"));\n});\n', expect: [] },
  { name: 'markdown doc mentioning console.log', tool: 'write', path: 'docs/debugging.md', content: '# Debugging\n\nDo not leave `console.log` calls in committed code; use the logger.\n', expect: [] },
  { name: 'two edits, violation in the second', tool: 'edit', path: 'src/user.ts', edits: [{ oldText: 'const row = await db.get(id);', newText: 'const row = await db.get(id.trim());' }, { oldText: 'return row;', newText: 'console.log(row);\nreturn row;' }], expect: ['no-console-statements'], edit: 'edit_2' },
  { name: 'body edit under a @returns JSDoc', tool: 'edit', path: 'src/slug.js', edits: [{ oldText: '  return title.toLowerCase();', newText: '  return title.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase();' }], expect: [] },
  { name: 'import added above a documented function', tool: 'edit', path: 'src/slug.js', edits: [{ oldText: '/**\n * URL slug', newText: 'import { money } from "./format.js";\n\n/**\n * URL slug' }, { oldText: '  return title.toLowerCase();', newText: '  return money(title.length);' }], expect: [] },
  { name: 'edit removes a required @returns', tool: 'edit', path: 'src/slug.js', edits: [{ oldText: '/**\n * URL slug for a room or event title.\n * @returns {string} lower-case slug\n */', newText: '/** URL slug for a room or event title. */' }], expect: ['every-exported-function-documents-its-return-value'] },
];

const cwd = mkdtempSync(join(tmpdir(), 'pi-warden-rules-cases-'));
writeFileSync(join(cwd, 'pi-warden.md'), RULES);
mkdirSync(join(cwd, 'src'), { recursive: true });
writeFileSync(join(cwd, 'src', 'queue.ts'), 'export function drain(items: string[]): string[] {\n  return items;\n}\n');
writeFileSync(join(cwd, 'src', 'user.ts'), 'import { db } from "./db.js";\n\nexport async function findUser(id: string): Promise<Row | undefined> {\n  const row = await db.get(id);\n  return row;\n}\n');
writeFileSync(join(cwd, 'src', 'slug.js'), '/**\n * URL slug for a room or event title.\n * @returns {string} lower-case slug\n */\nexport function slugify(title) {\n  return title.toLowerCase();\n}\n');

const judge = createTypeSafe({ maxRequests: 40 });
const config = defaultConfig();
const set = new RuleStore().load(cwd, config.rules);
console.log(`# rules: ${set.rules.length} from pi-warden.md\n`);
let total = 0, mismatches = 0;
for (const item of cases) {
  const input = item.tool === 'write' ? { path: item.path, content: item.content } : { path: item.path, edits: item.edits };
  const verdict = await evaluateRules(item.tool, input, { cwd, config: config.rules, set, judge, timeoutMs: 15000 });
  const flagged = verdict.findings.map(finding => finding.id);
  const ok = verdict.source === 'typesafe' && flagged.length === item.expect.length && item.expect.every(id => flagged.includes(id)) && (item.edit === undefined || verdict.editId === item.edit) && (item.asked === undefined || verdict.asked === item.asked);
  total++; if (!ok) mismatches++;
  const scores = (verdict.scores ?? []).filter(score => score.violation >= 0.2 || item.expect.includes(score.id)).map(score => `${score.id}=${score.violation.toFixed(2)}`).join(' ');
  console.log(`${ok ? 'ok  ' : 'MISS'} ${item.name.padEnd(44)} ${verdict.source === 'typesafe' ? `${verdict.asked} asked` : verdict.error ?? verdict.skippedReason} → [${flagged.join(', ')}]${verdict.editId ? ` in ${verdict.editId}` : ''} ${scores} (${verdict.elapsedMs ?? '-'} ms)`);
}
console.log(`\n${total - mismatches}/${total} as expected`);
const usage = judge.getUsage();
console.log(`requests: ${usage.requestsStarted}, input tokens: ${usage.inputTokens}`);
rmSync(cwd, { recursive: true, force: true });
