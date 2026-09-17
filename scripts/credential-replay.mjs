// Offline replay of the credential notice over a finished A/B batch.
// Credential detection is the pattern layer, so no key and no requests are needed.
// Build first; run: node scripts/credential-replay.mjs --report eval/reports/<batch>
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecrets, partitionSecrets } from '../dist/index.js';

const values = (argv, name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const report = values(process.argv, '--report');
if (!report) {
  console.error('usage: node scripts/credential-replay.mjs --report eval/reports/<batch> [--show-values]');
  process.exit(2);
}
const showValues = process.argv.includes('--show-values');
const runsDir = join(report, 'runs');
if (!existsSync(runsDir)) {
  console.error(`no runs/ directory under ${report}`);
  process.exit(2);
}

/** Every text a guard would inspect in a saved session: tool results, user prompts, and custom messages. */
function texts(entry) {
  const out = [];
  const collect = (content) => {
    if (typeof content === 'string') out.push(content);
    else if (Array.isArray(content)) for (const part of content) if (part && typeof part === 'object' && typeof part.text === 'string') out.push(part.text);
  };
  if (entry.message) collect(entry.message.content);
  if (entry.type === 'custom_message') collect(entry.content);
  return out;
}

const seen = new Map();
let scanned = 0;
let sessionFiles = 0;
const runs = readdirSync(runsDir).filter((name) => !name.startsWith('.'));
for (const name of runs) {
  const sessions = join(runsDir, name, 'sessions');
  if (!existsSync(sessions)) continue;
  for (const file of readdirSync(sessions)) {
    if (!file.endsWith('.jsonl')) continue;
    sessionFiles++;
    for (const line of readFileSync(join(sessions, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      for (const text of texts(entry)) {
        scanned++;
        for (const value of findSecrets(text)) {
          const found = seen.get(value) ?? { value, count: 0, runs: new Set() };
          found.count++;
          found.runs.add(name);
          seen.set(value, found);
        }
      }
    }
  }
}

const label = (value) => (showValues ? value : `${value.slice(0, 12)}${'*'.repeat(Math.max(0, value.length - 12))} (len ${value.length})`);
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);
const rows = [...seen.values()].map((entry) => {
  const split = partitionSecrets([entry.value]);
  return { ...entry, announced: split.real.length > 0 };
});
rows.sort((a, b) => Number(b.announced) - Number(a.announced) || b.count - a.count);

console.log(`batch: ${report}`);
console.log(`runs scanned: ${runs.length}; texts inspected: ${scanned}; credential-shaped values: ${rows.length}\n`);
if (!sessionFiles) {
  console.log('No session logs found under runs/<run>/sessions. They are local-only by design');
  console.log('(eval/README.md), so the replay needs the machine that ran the batch. Only the');
  console.log('recorded steer count from runs.json can be reported here.\n');
}
console.log('value'.padEnd(30), 'texts', 'runs', 'notice');
for (const row of rows) console.log(`${`${label(row.value)} [${fingerprint(row.value)}]`.padEnd(30)} ${String(row.count).padStart(5)} ${String(row.runs.size).padStart(4)} ${row.announced ? 'announced once per value' : 'traced, never announced'}`);

const announced = rows.filter((row) => row.announced);
const traced = rows.filter((row) => !row.announced);
console.log(`\nannounced values: ${announced.length}; traced stand-ins: ${traced.length}`);
const runsJson = join(report, 'runs.json');
if (existsSync(runsJson)) {
  const parsed = JSON.parse(readFileSync(runsJson, 'utf8'));
  const recorded = (parsed.runs ?? []).reduce((total, run) => total + (run.steers ?? []).filter((steer) => /Possible credentials/.test(String(steer.text ?? steer.content ?? ''))).length, 0);
  console.log(`recorded credential steers in runs.json (behaviour before this change): ${recorded}`);
  console.log(`replayed credential steers (behaviour with this change): ${announced.reduce((total, row) => total + row.runs.size, 0)} in ${announced.reduce((total, row) => total + row.runs.size, 0)} runs`);
}
