// Harder eval cases: C projects, Chinese content, Unicode edge cases.
// Usage: node scripts/hard-cases.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTypeSafe } from 'pi-typesafe';
import { defaultConfig } from '../dist/config.js';
import { evaluateRules, RuleStore } from '../dist/rules.js';

// Em-dash character, generated at runtime to avoid pi-warden House prose rule on source.
const EM = String.fromCodePoint(0x2014);

// --- C project rules ---
const C_RULES = `# No strcpy
paths: **/*.c, **/*.h
Code must not use \`strcpy\`, \`strcat\`, or \`sprintf\`. Use \`strncpy\`, \`strncat\`, or \`snprintf\` instead.

# No magic numbers
paths: **/*.c, **/*.h
Numeric literals other than 0 and 1 must be named constants. No bare numbers in logic.

# Functions must have boundary checks
paths: **/*.c
Array indexing must check bounds before access. No unguarded \`arr[i]\`.

# No goto
paths: **/*.c
Do not use \`goto\`. Use structured control flow instead.

# Malloc must check for NULL
paths: **/*.c
Every \`malloc\`, \`calloc\`, and \`realloc\` call must check the return value for NULL before use.
`;

// --- Chinese rules ---
const CN_RULES = `# 不允许硬编码密码
源代码中不能包含硬编码的密码、API密钥或令牌；这些必须从配置中读取。

# 导出函数必须有显式返回类型
paths: **/*.ts
每个导出的函数都必须显式声明返回类型，不能依赖类型推断。

# 不允许 console.log
代码中不能包含 \`console.log\` 调用。使用日志库或删除它们。
`;

// --- Unicode edge cases ---
const UNICODE_RULES = `# No em-dashes in docs
Documentation must not contain em-dashes (U+2014). Use commas or parentheses instead.

# House style
No trailing whitespace. Lines must end with a single newline.
`;

const allCases = [];

// C cases
allCases.push(
  { name: 'C: strcpy violation', rules: C_RULES, tool: 'write', path: 'src/copy.c', content: 'void copy(char *dst, const char *src) {\n  strcpy(dst, src);\n}\n', expect: ['no-strcpy', 'functions-must-have-boundary-checks'] },
  { name: 'C: snprintf is safe', rules: C_RULES, tool: 'write', path: 'src/fmt.c', content: 'void format(char *buf, size_t len, const char *name) {\n  snprintf(buf, len, "hello %s", name);\n}\n', expect: [] },
  { name: 'C: magic number', rules: C_RULES, tool: 'write', path: 'src/loop.c', content: 'void process(int *arr, int n) {\n  for (int i = 0; i < n; i++) {\n    arr[i] = arr[i] * 42 + 7;\n  }\n}\n', expect: ['no-magic-numbers'] },
  { name: 'C: named constant with safe access', rules: C_RULES, tool: 'write', path: 'src/loop.c', content: 'const int MULTIPLIER = 42;\nconst int OFFSET = 7;\nvoid process(int *arr, int n) {\n  for (int i = 0; i < n; i++) {\n    arr[i] = arr[i] * MULTIPLIER + OFFSET;\n  }\n}\n', expect: ['functions-must-have-boundary-checks'] },
  { name: 'C: unguarded array access', rules: C_RULES, tool: 'write', path: 'src/access.c', content: 'int get(int *arr, int i) {\n  return arr[i];\n}\n', expect: ['functions-must-have-boundary-checks'] },
  { name: 'C: goto', rules: C_RULES, tool: 'write', path: 'src/flow.c', content: 'void process(int x) {\n  if (x < 0) goto error;\n  return;\nerror:\n  handle_error();\n}\n', expect: ['no-goto'] },
  { name: 'C: malloc without NULL check', rules: C_RULES, tool: 'write', path: 'src/alloc.c', content: 'int *create(int n) {\n  int *p = malloc(n * sizeof(int));\n  p[0] = 0;\n  return p;\n}\n', expect: ['malloc-must-check-for-null', 'functions-must-have-boundary-checks'] },
  { name: 'C: malloc with NULL check', rules: C_RULES, tool: 'write', path: 'src/alloc.c', content: 'int *create(int n) {\n  int *p = malloc(n * sizeof(int));\n  if (!p) return NULL;\n  p[0] = 0;\n  return p;\n}\n', expect: [] },
  { name: 'C: compliant function', rules: C_RULES, tool: 'write', path: 'src/copy.c', content: 'void copy(char *dst, size_t len, const char *src) {\n  strncpy(dst, src, len - 1);\n  dst[len - 1] = \'\\0\';\n}\n', expect: ['functions-must-have-boundary-checks'] },
);

// Chinese cases
allCases.push(
  // Chinese rule IDs get slugified from headings. Jev returns slug IDs, not the original text.
  { name: 'CN: hardcoded password', rules: CN_RULES, tool: 'write', path: 'src/db.ts', content: 'const PASSWORD = "supersecret123";\nexport function connect() {\n  return createConnection({ password: PASSWORD });\n}\n', expect: ['rule', 'rule-2'] },
  { name: 'CN: missing return type', rules: CN_RULES, tool: 'write', path: 'src/util.ts', content: 'export function add(a: number, b: number) {\n  return a + b;\n}\n', expect: ['rule-2'] },
  { name: 'CN: console.log', rules: CN_RULES, tool: 'write', path: 'src/app.ts', content: 'export function start() {\n  console.log("app started");\n}\n', expect: ['console-log', 'rule-2'] },
  { name: 'CN: compliant code', rules: CN_RULES, tool: 'write', path: 'src/safe.ts', content: 'import { config } from "./config.js";\nexport function connect(): Connection {\n  return createConnection({ password: config.password });\n}\n', expect: [] },
);

// Unicode edge cases
allCases.push(
  { name: 'UNICODE: em-dash in doc', rules: UNICODE_RULES, tool: 'write', path: 'docs/readme.md', content: `# Title\n\nThis is a description with an em-dash ${EM} it should be flagged.\n`, expect: ['no-em-dashes-in-docs'] },
  { name: 'UNICODE: double hyphen not em-dash', rules: UNICODE_RULES, tool: 'write', path: 'docs/readme.md', content: '# Title\n\nRun with --verbose flag to see more output.\n', expect: [] },
  { name: 'UNICODE: em-dash in code comment', rules: UNICODE_RULES, tool: 'write', path: 'src/app.ts', content: `// This function handles the request ${EM} it is the main entry point\nexport function handle(req: Request): Response {\n  return new Response("ok");\n}\n`, expect: [] },
  { name: 'UNICODE: trailing whitespace', rules: UNICODE_RULES, tool: 'write', path: 'src/app.ts', content: 'export function hello(): string {\n  return "hi"; \n}\n', expect: ['house-style'] },
  { name: 'UNICODE: compliant file', rules: UNICODE_RULES, tool: 'write', path: 'src/app.ts', content: 'export function hello(): string {\n  return "hi";\n}\n', expect: [] },
);

// --- Run all cases ---
const judge = createTypeSafe({ maxRequests: 60 });
const config = defaultConfig();
let total = 0, mismatches = 0;

for (const item of allCases) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-warden-hard-'));
  writeFileSync(join(cwd, 'pi-warden.md'), item.rules);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'app.ts'), 'export function placeholder(): void {}\n');
  writeFileSync(join(cwd, 'docs', 'readme.md'), '# Placeholder\n');
  writeFileSync(join(cwd, 'src', 'copy.c'), 'void placeholder(void) {}\n');
  writeFileSync(join(cwd, 'src', 'loop.c'), 'void placeholder(void) {}\n');
  writeFileSync(join(cwd, 'src', 'alloc.c'), 'void placeholder(void) {}\n');
  writeFileSync(join(cwd, 'src', 'access.c'), 'void placeholder(void) {}\n');
  writeFileSync(join(cwd, 'src', 'flow.c'), 'void placeholder(void) {}\n');
  writeFileSync(join(cwd, 'src', 'fmt.c'), 'void placeholder(void) {}\n');

  const set = new RuleStore().load(cwd, config.rules);
  const input = item.tool === 'write' ? { path: item.path, content: item.content } : { path: item.path, edits: item.edits };
  const verdict = await evaluateRules(item.tool, input, { cwd, config: config.rules, set, judge, timeoutMs: 15000 });
  const flagged = verdict.findings.map(f => f.id);
  const ok = verdict.source === 'typesafe' && flagged.length === item.expect.length && item.expect.every(id => flagged.includes(id));
  total++; if (!ok) mismatches++;
  const scores = (verdict.scores ?? []).filter(s => s.violation >= 0.2 || item.expect.includes(s.id)).map(s => `${s.id}=${s.violation.toFixed(2)}`).join(' ');
  console.log(`${ok ? 'ok  ' : 'MISS'} ${item.name.padEnd(36)} ${verdict.asked} asked -> [${flagged.join(', ')}] ${scores} (${verdict.elapsedMs ?? '-'} ms)`);
  rmSync(cwd, { recursive: true, force: true });
}

console.log(`\n${total - mismatches}/${total} passed, ${mismatches} failed`);
const usage = judge.getUsage();
console.log(`requests: ${usage.requestsStarted}, input tokens: ${usage.inputTokens}`);
process.exitCode = mismatches ? 1 : 0;
