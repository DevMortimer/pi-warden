// Tunes the deslopify questions against a case set. Billable: one request per case. Usage: node scripts/slop-cases.mjs [code|prose]
import { createTypeSafe, noul } from 'pi-typesafe';

const judge = createTypeSafe({ maxRequests: 60 });
const only = process.argv[2];

const codeQuestions = {
  stub: noul('Does the content `action` writes leave placeholder, stub, mock, or "implement later" code where `task` needs a working implementation?', {
    true: 'Yes: a function returns a constant, null, or fake data instead of doing its job; a TODO or "implement later" stands where the logic should be; a mock is hard-coded where a real call is needed.',
    false: 'No: the code does what `task` asks, or the incomplete part is clearly outside what `task` asked for.',
  }),
  comments: noul('Do the explanatory comments in the content `action` writes mostly restate what the adjacent code already shows, instead of explaining intent, constraints, or non-obvious behaviour? Commented-out code is not an explanatory comment and is judged elsewhere.', {
    true: 'Yes: comments such as "// increment the counter" above counter++, "// return the result", "// loop over items", banners repeating the function name, or doc comments that only repeat parameter names.',
    false: 'No: there are few or no comments, or the comments explain why, an invariant, a workaround, a limitation, a reference, or a decision a reader could not infer from the code.',
  }),
  dead: noul('Does the content `action` writes include dead or redundant code: commented-out code, unused imports or variables, duplicated logic, or branches that cannot be reached?', {
    true: 'Yes: blocks of commented-out code, variables or imports that are never used, the same logic written twice, or checks that are always true or false.',
    false: 'No: every line participates in the behaviour.',
  }),
  hedging: noul('Does the content `action` writes contain vague or hedging text: "this should work", "for now", "might need changes", TODO notes without a plan, or explanations that say nothing specific?', {
    true: 'Yes: uncertain or apologetic notes in code or docs, placeholders like "TBD", or prose that does not commit to what the code does.',
    false: 'No: the text states what the code does and why, or there is no such text.',
  }),
};

const codeCases = [
  { name: 'TODO stub', task: 'Implement parseDuration(text) returning milliseconds', content: 'export function parseDuration(text: string): number {\n  // TODO: implement later\n  return 0;\n}\n', expect: ['stub', 'hedging'] },
  { name: 'fake data mock', task: 'Implement fetchUser(id) against the REST API', content: 'export async function fetchUser(id: string) {\n  // placeholder until the API is ready\n  return { id, name: "Test User", email: "test@example.com" };\n}\n', expect: ['stub', 'hedging'] },
  { name: 'restating comments', task: 'Add a helper that sums an array', content: '// This function sums an array\nexport function sum(values: number[]): number {\n  // initialize the total to zero\n  let total = 0;\n  // loop over every value\n  for (const value of values) {\n    // add the value to the total\n    total += value;\n  }\n  // return the total\n  return total;\n}\n', expect: ['comments'] },
  { name: 'banner + jsdoc echo', task: 'Add a config loader', content: '// ============================\n// loadConfig\n// ============================\n/**\n * Loads the config.\n * @param path - the path\n * @returns the config\n */\nexport function loadConfig(path: string): Config {\n  return JSON.parse(readFileSync(path, "utf8"));\n}\n', expect: ['comments'] },
  { name: 'commented-out code', task: 'Switch the logger to pino', content: 'import pino from "pino";\n// import winston from "winston";\n// const logger = winston.createLogger({ level: "info" });\nexport const logger = pino({ level: "info" });\n// logger.add(new winston.transports.Console());\n', expect: ['dead'] },
  { name: 'unused import and var', task: 'Add a slugify helper', content: 'import { readFileSync } from "node:fs";\nimport path from "node:path";\nexport function slugify(text: string): string {\n  const original = text;\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n', expect: ['dead'] },
  { name: 'duplicated logic', task: 'Validate the signup form', content: 'export function validate(form: Form) {\n  const errors: string[] = [];\n  if (!form.email || !/^[^@]+@[^@]+$/.test(form.email)) errors.push("email");\n  if (!form.email || !/^[^@]+@[^@]+$/.test(form.email)) errors.push("email");\n  if (form.password.length < 8) errors.push("password");\n  return errors;\n}\n', expect: ['dead'] },
  { name: 'hedging notes', task: 'Add retry to the HTTP client', content: 'export async function withRetry<T>(fn: () => Promise<T>) {\n  // this should work for most cases, might need tweaking later\n  // for now we just try 3 times, TBD if we need backoff\n  for (let i = 0; i < 3; i++) {\n    try { return await fn(); } catch {}\n  }\n  throw new Error("failed");\n}\n', expect: ['hedging'] },
  { name: 'stub + hedging', task: 'Implement the payment webhook handler', content: 'export async function handleWebhook(req: Request) {\n  // TODO figure out verification, not sure how Stripe signs these\n  // for now accept everything\n  return new Response("ok");\n}\n', expect: ['stub', 'hedging'] },
  { name: 'focused implementation', task: 'Implement parseDuration(text) returning milliseconds', content: 'const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };\n\nexport function parseDuration(text: string): number {\n  const match = /^(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h)$/.exec(text.trim());\n  if (!match) throw new Error(`Invalid duration: ${text}`);\n  return Number(match[1]) * UNITS[match[2]];\n}\n', expect: [] },
  { name: 'good explanatory comment', task: 'Fix the date parsing bug', content: 'export function localDayKey(date: Date): string {\n  // Intl is used instead of toISOString because the reset must follow the presenter\'s calendar day, not UTC;\n  // a 01:00 local time in UTC+8 is the previous day in UTC and would reset "yesterday" during a 9am pitch.\n  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);\n}\n', expect: [] },
  { name: 'test with fixtures', task: 'Add tests for slugify', content: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../src/slugify.js";\n\ntest("slugify", () => {\n  assert.equal(slugify("Hello, World!"), "hello-world");\n  assert.equal(slugify("  a  b  "), "a-b");\n  assert.equal(slugify("ÄÖÜ"), "");\n});\n', expect: [] },
  { name: 'small focused edit', task: 'Fix the off-by-one in pagination', edits: [{ oldText: 'const end = start + pageSize + 1;', newText: 'const end = start + pageSize;' }], expect: [] },
  { name: 'intentional stub outside task', task: 'Add the CLI flag parsing; the server part comes later', content: 'export function parseFlags(argv: string[]) {\n  const flags = new Map<string, string>();\n  for (const arg of argv) { const [k, v = "true"] = arg.replace(/^--/, "").split("="); flags.set(k, v); }\n  return flags;\n}\n\nexport function startServer(): never {\n  throw new Error("startServer is not part of this change; see the follow-up ticket");\n}\n', expect: [] },
  { name: 'mock in a test file', task: 'Add a unit test for the user service', content: 'const api = { fetchUser: async (id: string) => ({ id, name: "Test User" }) };\ntest("greets the user", async () => {\n  assert.equal(await greet(api, "1"), "Hello, Test User");\n});\n', expect: [] },
  { name: 'defensive unreachable', task: 'Harden the parser', content: 'export function parse(input: string): number {\n  const n = Number(input);\n  if (typeof n !== "number") throw new Error("not a number");\n  if (n === n && Number.isNaN(n)) throw new Error("NaN");\n  return n;\n}\n', expect: ['dead'] },
];

const proseQuestions = {
  wordy: noul('Is `reply` longer than its content requires: a preamble, restating the request, summarising what it just said, or filler sentences that add no information?', {
    true: 'Yes: it opens with what it is about to do, repeats the question, ends with a summary of the same points, or pads with sentences that could be removed without losing anything.',
    false: 'No: each sentence carries information the reader needs; length matches the substance.',
  }),
  cliches: noul('Does `reply` use assistant clichés or filler phrasing: "Great question", "Certainly!", "I hope this helps", "it\'s worth noting", "delve", "let me know if", unrequested bullet lists of caveats, or emoji headings?', {
    true: 'Yes: one or more such phrases or patterns are present.',
    false: 'No: the wording is direct and specific to the subject.',
  }),
  jargon: noul('Would a reader described by `audience` struggle with `reply` because of unexplained technical terms or assumed background?', {
    true: 'Yes: terms, acronyms, or concepts appear without explanation that this audience would not know.',
    false: 'No: the reply matches what this audience can follow, or the audience is technical.',
  }),
};

const proseCases = [
  { name: 'padded reply', audience: 'technical', task: 'Why does the test fail under TZ=UTC?', reply: 'Great question! Let me walk you through what is happening here. The test fails under TZ=UTC because, as I mentioned, the date handling uses the local calendar day. To summarize: the test constructs a Date and then compares the local day key with the ISO string, and these differ across time zones. In conclusion, the test fails under TZ=UTC due to the time zone difference. I hope this helps! Let me know if you have any other questions.', expect: ['wordy', 'cliches'] },
  { name: 'tight reply', audience: 'technical', task: 'Why does the test fail under TZ=UTC?', reply: 'The test builds `new Date(2026, 7, 9, 1, 0)` in local time and asserts that `localDayKey` differs from the ISO date. Under UTC, local and ISO days are the same, so the second assertion fails. Pin the zone in the test (`withTimeZone("Asia/Kuala_Lumpur")`) or pick an instant whose local and UTC days differ in every zone.', expect: [] },
  { name: 'jargon for plain audience', audience: 'plain (a founder without programming background)', task: 'Is the payment bug fixed?', reply: 'Yes. The webhook handler was not verifying the HMAC signature, so replayed idempotency keys hit the ORM before the mutex acquired the row lock, causing a double insert on the ledger table. I added signature verification and wrapped the insert in a serializable transaction.', expect: ['jargon'] },
  { name: 'plain for plain audience', audience: 'plain (a founder without programming background)', task: 'Is the payment bug fixed?', reply: 'Yes. Payments could be recorded twice when the payment provider sent the same notification twice. The system now checks that each notification is genuine and only records it once. I tested it by sending the same notification twice; only one payment was recorded.', expect: [] },
  { name: 'caveat list', audience: 'technical', task: 'Rename the column', reply: 'Renamed `created` to `created_at` in the migration and the model.\n\nA few things worth noting:\n- Make sure to run the migration\n- Be aware that this might affect other parts of the codebase\n- Consider adding tests\n- Note that this is a breaking change if anything depends on the old name\n\nLet me know if you\'d like me to look into any of these! 🚀', expect: ['cliches'] },
  { name: 'long but dense', audience: 'technical', task: 'Summarise what changed', reply: 'Three changes. (1) `src/parser.ts`: `parse()` reads `input.when` instead of `input.date`; the fixture had used `when` since the API v2 migration. (2) `tests/parser.test.ts`: the local-day assertion is pinned to Asia/Kuala_Lumpur so it fails on the CI pool (UTC) for the right reason. (3) `package.json`: `node --test` gets `--test-timeout=10000`; the parser test exceeded the 2 s default on the CI runner. 31 tests pass locally and on CI.', expect: [] },
];

let total = 0, miss = 0;
const line = (ok, name, detail) => { total++; if (!ok) miss++; console.log(`${ok ? 'ok  ' : 'MISS'} ${name.padEnd(28)} ${detail}`); };
const threshold = 0.7;

if (!only || only === 'code') {
  console.log('# code slop — per-symptom Noul, threshold 0.7');
  for (const c of codeCases) {
    const action = c.edits ? { tool: 'edit', path: 'src/x.ts', edits: c.edits } : { tool: 'write', path: 'src/x.ts', excerpt: c.content };
    const r = await judge.evaluate({ state: { task: c.task, action }, questions: codeQuestions });
    const scores = Object.fromEntries(Object.entries(r.answers).map(([k, v]) => [k, v.noul]));
    const flagged = Object.keys(scores).filter(k => scores[k] >= threshold).sort();
    const ok = JSON.stringify(flagged) === JSON.stringify([...c.expect].sort());
    line(ok, c.name, Object.entries(scores).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ') + (ok ? '' : `  expected [${c.expect}] got [${flagged}]`));
  }
}
if (!only || only === 'prose') {
  console.log('\n# prose slop — per-symptom Noul, threshold 0.7');
  for (const c of proseCases) {
    const r = await judge.evaluate({ state: { task: c.task, audience: c.audience, reply: c.reply }, questions: proseQuestions });
    const scores = Object.fromEntries(Object.entries(r.answers).map(([k, v]) => [k, v.noul]));
    const flagged = Object.keys(scores).filter(k => scores[k] >= threshold).sort();
    const ok = JSON.stringify(flagged) === JSON.stringify([...c.expect].sort());
    line(ok, c.name, Object.entries(scores).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ') + (ok ? '' : `  expected [${c.expect}] got [${flagged}]`));
  }
}
const u = judge.getUsage();
console.log(`\n${total - miss}/${total} matched; ${u.requestsSucceeded} requests, ${u.inputTokens} input tokens`);
