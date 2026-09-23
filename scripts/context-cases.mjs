// Tunes the context saver: retention and format judgments against labelled synthetic outputs, and the large-output question
// against labelled bash commands before they run. Billable: one request per case.
// Build first; run: node --env-file-if-exists=.env scripts/context-cases.mjs
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createTypeSafe } from 'pi-typesafe';
import { buildRequest, compressOutput, defaultConfig, describeAction, evaluateOutput } from '../dist/index.js';

const repeat = (line, n) => Array.from({ length: n }, (_, i) => line.replace('{i}', String(i))).join('\n') + '\n';

// `compress`: whether Jev should let code replace the output. `format`: the parser Jev should name (or 'other'); `formatOptional`
// marks cases where either the named format or `other` is acceptable because the generic excerpt would also serve.
export const contextCases = [
  { name: 'vitest failing run', task: 'Run the tests and fix the failures', tool: 'bash', compress: true, format: 'vitest_jest',
    text: repeat(' ✓ tests/case{i}.test.ts (4 tests) 3ms', 700) + ' ❯ tests/parser.test.ts (2 tests | 1 failed) 12ms\n   × parses dates\n     → expected "2024-01-01" to be "2024-01-02"\n\n Test Files  1 failed | 700 passed (701)\n      Tests  1 failed | 2801 passed (2802)\n   Duration  4.12s\n' },
  { name: 'jest passing run', task: 'Run the tests', tool: 'bash', compress: true, format: 'vitest_jest',
    text: repeat('PASS src/module{i}.test.ts', 600) + '\nTest Suites: 600 passed, 600 total\nTests:       2400 passed, 2400 total\nSnapshots:   0 total\nTime:        18.2 s\nRan all test suites.\n' },
  { name: 'node:test TAP with failure', task: 'Make the test suite pass', tool: 'bash', compress: true, format: 'node_test',
    text: 'TAP version 13\n' + repeat('# Subtest: case {i}\nok {i} - case {i}\n  ---\n  duration_ms: 0.4\n  ...', 400) + 'not ok 401 - rejects empty input\n  ---\n  error: \'expected [Function] to throw\'\n  code: \'ERR_ASSERTION\'\n  ...\n1..401\n# tests 401\n# pass 400\n# fail 1\n' },
  { name: 'tsc errors', task: 'Fix the type errors', tool: 'bash', compress: true, format: 'tsc',
    text: repeat('src/generated/types{i}.ts(1,1): error TS2322: Type \'string\' is not assignable to type \'number\'.', 300) + '\nFound 300 errors in 300 files.\n' },
  { name: 'eslint report', task: 'Fix the lint errors', tool: 'bash', compress: true, format: 'eslint',
    text: repeat('/repo/src/file{i}.ts\n  10:3  error  \'x\' is assigned a value but never used  no-unused-vars\n', 250) + '\n✖ 250 problems (250 errors, 0 warnings)\n' },
  { name: 'pytest failing run', task: 'Run pytest and fix failures', tool: 'bash', compress: true, format: 'pytest',
    text: '============================= test session starts ==============================\ncollected 900 items\n\n' + repeat('tests/test_mod{i}.py ........                                                [ 50%]', 300) + '\n=================================== FAILURES ===================================\n__________________________________ test_total __________________________________\n\n    def test_total():\n>       assert total([1, 2]) == 4\nE       assert 3 == 4\n\ntests/test_sum.py:7: AssertionError\n=========================== short test summary info ============================\nFAILED tests/test_sum.py::test_total - assert 3 == 4\n========================= 1 failed, 899 passed in 2.31s ========================\n' },
  { name: 'large git diff for review', task: 'Review this diff for bugs before I merge it', tool: 'bash', compress: false, format: 'git_diff', formatOptional: true,
    text: repeat('diff --git a/src/f{i}.ts b/src/f{i}.ts\n--- a/src/f{i}.ts\n+++ b/src/f{i}.ts\n@@ -1,3 +1,3 @@\n-export const value{i} = {i};\n+export const value{i} = {i} + 1;\n', 250) },
  // Commit bodies carry the changelog content; the git_log parser would drop them, so the full log must stay.
  { name: 'git log for a changelog', task: 'Summarize the recent commits for the changelog', tool: 'bash', compress: false, format: 'git_log', formatOptional: true,
    text: repeat('commit 0123456789abcdef0123456789abcdef0{i}\nAuthor: Dev <dev@example.invalid>\nDate:   Mon Jan 1 00:00:00 2024 +0000\n\n    Change number {i}\n\n    Body text for change {i} explains a distinct motivation that the changelog entry needs.\n', 200) },
  // 200 subjects are exact text the task needs in full, and the parser's 6K cap would drop some; Jev sits near 0.55 and code keeps all.
  { name: 'git log for subjects only', task: 'List the subjects of the last 200 commits', tool: 'bash', compress: false, format: 'git_log',
    text: repeat('commit 0123456789abcdef0123456789abcdef0{i}\nAuthor: Dev <dev@example.invalid>\nDate:   Mon Jan 1 00:00:00 2024 +0000\n\n    Change number {i}\n\n    Body text for change {i} that repeats the subject in more words.\n', 200) },
  { name: 'npm install', task: 'Install dependencies and run the build', tool: 'bash', compress: true, format: 'npm_install',
    text: repeat('npm http fetch GET 200 https://registry.npmjs.org/package-{i} 41ms (cache miss)', 500) + 'npm warn deprecated inflight@1.0.6: This module is not supported\n\nadded 412 packages, and audited 413 packages in 9s\n\n2 moderate severity vulnerabilities\n' },
  { name: 'repetitive build log', task: 'Build the project and report errors', tool: 'ctx_execute', compress: true, format: 'other',
    text: repeat('[webpack] compiling module {i}/1500 ... done', 1500) + 'ERROR in ./src/app.ts: Module not found: ./missing\nwebpack compiled with 1 error\n' },
  { name: 'source file under review', task: 'Review this file and point out bugs', tool: 'read', compress: false, format: 'other',
    text: repeat('export function handler{i}(input: Input): Output {\n  if (!input.id) throw new Error("missing id {i}");\n  return { id: input.id, index: {i} };\n}\n', 250) },
  { name: 'exact output requested', task: 'Print the complete output exactly; do not omit any lines', tool: 'bash', compress: false, format: 'other',
    text: repeat('record {i}: status=ok latency=12ms', 1200) },
  { name: 'json data to transform', task: 'Convert this JSON export into CSV', tool: 'read', compress: false, format: 'other',
    text: '[\n' + repeat('  {"id": {i}, "name": "item {i}", "price": {i}.5, "tags": ["a", "b"]},', 600) + ']\n' },
  { name: 'docs page to summarize', task: 'Read the API docs and summarize the authentication flow', tool: 'fetch_content', compress: false, format: 'other',
    text: repeat('## Section {i}\n\nThe client sends a request with a bearer token. The server validates the token, checks scopes, and returns a session. Section {i} covers a distinct edge case that a summary would need.\n', 150) },
];

// `large`: whether the command prints far more than the task needs, so the agent should filter or redirect it first.
export const largeOutputCases = [
  { name: 'cat of a big log', task: 'Find why the server crashed last night', command: 'cat /var/log/app/server.log', large: true },
  { name: 'find / without filters', task: 'Locate the nginx config file', command: 'find /', large: true },
  { name: 'npm test verbose', task: 'Run the tests and fix the failures', command: 'npm test -- --verbose', large: true },
  { name: 'git log -p', task: 'Which commit changed the retry limit?', command: 'git log -p', large: true },
  { name: 'ls', task: 'What is in this folder?', command: 'ls', large: false },
  { name: 'git status --short', task: 'Commit the README change', command: 'git status --short', large: false },
  { name: 'head -20 file', task: 'Check the CSV header', command: 'head -20 data/export.csv', large: false },
  { name: 'wc -l of a big log', task: 'How many requests did the server log today?', command: 'wc -l /var/log/app/access.log', large: false },
];

export async function runLargeOutputCases(judge, report) {
  const threshold = defaultConfig().context.largeOutput.threshold;
  for (const item of largeOutputCases) {
    const request = buildRequest(describeAction('bash', { command: item.command }, process.cwd()), item.task, { largeOutput: true });
    const started = Date.now();
    try {
      const result = await judge.evaluate(request);
      const score = result.answers.large_output?.noul;
      const flagged = typeof score === 'number' && score >= threshold;
      report(flagged === item.large, item.name, `large_output=${score?.toFixed(2) ?? '-'} threshold=${threshold} (${Date.now() - started} ms)`);
    } catch (error) {
      report(false, item.name, `error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function runContextCases(judge, report) {
  const config = defaultConfig();
  for (const item of contextCases) {
    const verdict = await evaluateOutput(item.tool, item.text, item.task, { security: config.security, context: config.context, timeoutMs: config.timeoutMs, judge });
    const compressed = verdict.retention !== 'all';
    const formatOk = verdict.format === item.format || (item.format === 'other' && verdict.format === undefined) || (item.formatOptional && verdict.format === undefined);
    const excerpt = compressed ? compressOutput(item.text, verdict.retention, verdict.format) : undefined;
    const usedParser = excerpt ? /Exact lines selected for the/.test(excerpt) : false;
    const detail = `retention=${verdict.retention} confidence=${verdict.confidence?.toFixed(2)} format=${verdict.format ?? 'other'} (${verdict.formatConfidence?.toFixed(2) ?? '-'}) ${excerpt ? `${item.text.length}→${excerpt.length} chars${usedParser ? ' via parser' : ' generic'}` : 'kept'} (${verdict.elapsedMs} ms)${verdict.error ? ` error=${verdict.error}` : ''}`;
    report(!verdict.error && compressed === item.compress && formatOk, item.name, detail);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let failures = 0;
  const judge = createTypeSafe({ maxRequests: 30 });
  const print = (ok, name, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'MISS'} ${name.padEnd(28)} ${detail}`);
  };
  await runContextCases(judge, print);
  await runLargeOutputCases(judge, print);
  const total = contextCases.length + largeOutputCases.length;
  console.log(`\n${total - failures}/${total} matched expectations.`);
  process.exitCode = failures ? 1 : 0;
}
