// Offline replay of the credential layer, over a finished A/B batch or over recorded session logs. Detection is a
// pattern layer, so no key and no requests are needed. Build first.
//
//   node scripts/credential-replay.mjs --report eval/reports/<batch> [--show-values]
//   node scripts/credential-replay.mjs --files <list> [--lib <dist/index.js>] [--since <date>] [--skip <list>] --out <jsonl>
//   node scripts/credential-replay.mjs --compare --before <jsonl> --after <jsonl> --removed <file>
//
// The session modes write one JSON line per session file, so a file that hangs under one build still leaves every
// other file measured: rerun with the file added to `--skip`. `--lib` picks the build under test, which is how the
// same corpus is replayed against the code before and after a change. Replay text stays outside the repository.
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const values = (argv, name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const REPLACEMENT = '[redacted]';
const library = values(process.argv, '--lib', new URL('../dist/index.js', import.meta.url).pathname);

/** The replacement step of maskSecrets, so one replay measures the same code path for every build. */
function maskText({ findSecrets, partitionSecrets }, text) {
  const { real } = partitionSecrets(findSecrets(text), text);
  let out = text;
  let masked = 0;
  for (const value of [...real].sort((a, b) => b.length - a.length)) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(REPLACEMENT);
    masked++;
  }
  return { text: out, masked, values: real };
}

const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);

// --- Replay over a finished A/B batch (saved session copies under runs/<run>/sessions) ---
function reportMode(report) {
  const showValues = process.argv.includes('--show-values');
  const runsDir = join(report, 'runs');
  if (!existsSync(runsDir)) {
    console.error(`no runs/ directory under ${report}`);
    process.exit(2);
  }

  /** Every text a guard would inspect in a saved session: tool results, user prompts, and custom messages. */
  const texts = (entry) => {
    const out = [];
    const collect = (content) => {
      if (typeof content === 'string') out.push(content);
      else if (Array.isArray(content)) for (const part of content) if (part && typeof part === 'object' && typeof part.text === 'string') out.push(part.text);
    };
    if (entry.message) collect(entry.message.content);
    if (entry.type === 'custom_message') collect(entry.content);
    return out;
  };

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
}

/** The text blocks of one recorded tool result, with the tool that produced it. */
function toolTexts(entry) {
  const message = entry.message;
  if (!message || message.role !== 'toolResult') return undefined;
  const out = [];
  const content = message.content;
  if (typeof content === 'string') out.push(content);
  else if (Array.isArray(content)) for (const part of content) if (part && typeof part === 'object' && typeof part.text === 'string') out.push(part.text);
  return { tool: String(message.toolName ?? 'unknown'), texts: out };
}

/** Session files under `root` last written at or after `since`, or the paths listed in a file. */
function sessionFiles(root, since, listFile) {
  if (listFile) return readFileSync(listFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const files = [];
  const sinceMs = Date.parse(since);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl') && statSync(path).mtimeMs >= sinceMs) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * One JSON line per session file: every recorded tool result, the values it masks, and the masking cost. Files are
 * appended as they finish, so a build that hangs on one file still leaves the rest measured.
 */
async function sessionsMode(lib, root, since, out) {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) {
    console.error(`--since is not a date: ${since}`);
    process.exit(2);
  }
  const skip = new Set(values(process.argv, '--skip') ? readFileSync(values(process.argv, '--skip'), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean) : []);
  const files = sessionFiles(root, since, values(process.argv, '--files')).filter((file) => !skip.has(file));
  let checked = false;
  const occurrences = new Map();
  for (const file of files) {
    const relative = file.slice(root.length + 1);
    let entriesScanned = 0;
    let textsScanned = 0;
    let charsScanned = 0;
    let maskMs = 0;
    const results = [];
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (!line.trim() || !line.includes('toolResult')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (Date.parse(entry.timestamp ?? '') < sinceMs) continue;
      const result = toolTexts(entry);
      if (!result) continue;
      entriesScanned++;
      result.texts.forEach((text, block) => {
        textsScanned++;
        charsScanned += text.length;
        const started = performance.now();
        const masked = maskText(lib, text);
        const ms = performance.now() - started;
        maskMs += ms;
        // The replay must measure the shipped masking, not a copy of it. A build without maskSecrets is the point of
        // `--lib` (the earlier build), and the check runs where the export exists.
        if (!checked && typeof lib.maskSecrets === 'function') {
          checked = true;
          const shipped = lib.maskSecrets(text);
          if (shipped.text !== masked.text || shipped.masked !== masked.masked) {
            console.error('the replay masking step and maskSecrets disagree; the numbers below are not the shipped path');
            process.exit(3);
          }
        }
        if (!masked.masked) return;
        // The same text twice in one session is two results: the occurrence counter keeps their keys apart.
        const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
        const seen = (occurrences.get(`${relative}:${digest}`) ?? 0) + 1;
        occurrences.set(`${relative}:${digest}`, seen);
        results.push({
          key: `${relative}:${result.tool}:${block}:${digest}:${seen}`,
          tool: result.tool,
          timestamp: entry.timestamp,
          chars: text.length,
          ms: Number(ms.toFixed(4)),
          masked: masked.masked,
          values: masked.values.map((value) => ({ h: fingerprint(value), len: value.length, v: value })),
        });
      });
    }
    appendFileSync(out, `${JSON.stringify({ file: relative, entriesScanned, textsScanned, charsScanned, maskMs: Number(maskMs.toFixed(2)), results })}\n`);
  }
  console.log(`${files.length} session files replayed into ${out}`);
}

const percentile = (sorted, ratio) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))] : 0;
const mean = (numbers) => numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : 0;

/** Per-tool-result masking time over the results that carry a masked value. */
function timing(entries) {
  const sorted = entries.map((entry) => entry.ms).sort((a, b) => a - b);
  return { count: sorted.length, median: Number(percentile(sorted, 0.5).toFixed(3)), p99: Number(percentile(sorted, 0.99).toFixed(3)), max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)) };
}

/** Values the change stops masking, listed with their text in a file that stays outside the repository. */
function compareMode(beforePath, afterPath, removedPath) {
  const read = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const files = (rows) => new Map(rows.map((row) => [row.file, row]));
  const before = files(read(beforePath));
  const after = files(read(afterPath));
  const beforeResults = [...before.values()].flatMap((row) => row.results);
  const afterResults = [...after.values()].flatMap((row) => row.results);
  const afterByKey = new Map(afterResults.map((result) => [result.key, result]));
  const afterValues = new Set(afterResults.flatMap((result) => result.values.map((value) => value.h)));
  const beforeValues = new Set(beforeResults.flatMap((result) => result.values.map((value) => value.h)));
  const removed = new Map();
  const touched = new Set();
  for (const [file, row] of before) {
    for (const result of row.results) {
      const now = afterByKey.get(result.key);
      const keep = new Set((now?.values ?? []).map((value) => value.h));
      for (const value of result.values) {
        if (keep.has(value.h)) continue;
        touched.add(result.key);
        const removedRow = removed.get(value.h) ?? { h: value.h, len: value.len, v: value.v, count: 0, where: new Set() };
        removedRow.count++;
        removedRow.where.add(`${file} (${result.tool})`);
        removed.set(value.h, removedRow);
      }
    }
  }
  const rows = [...removed.values()].sort((a, b) => b.count - a.count || a.h.localeCompare(b.h));
  const added = [...afterValues].filter((h) => !beforeValues.has(h));
  const uncovered = [...after.keys()].filter((file) => !before.has(file));
  const textsBefore = [...before.values()].reduce((total, row) => total + row.textsScanned, 0);
  const textsAfter = [...after.values()].reduce((total, row) => total + row.textsScanned, 0);
  const lines = [
    '# Credential values the change stops masking',
    `# before: ${beforePath}`,
    `# after:  ${afterPath}`,
    `# ${rows.length} distinct values over ${touched.size} tool results`,
    '',
    ...rows.map((row) => `${row.h} len=${row.len} results=${row.count} ${[...row.where].slice(0, 4).join(' | ')}${row.where.size > 4 ? ` | +${row.where.size - 4} more` : ''}\n    ${row.v}`),
    '',
  ];
  writeFileSync(removedPath, lines.join('\n'));
  console.log(`files replayed: before ${before.size}; after ${after.size} (before data missing for ${uncovered.length}, where the earlier build hung)`);
  console.log(`text blocks inspected: before ${textsBefore}; after ${textsAfter}`);
  console.log(`results with masked values: before ${beforeResults.length}; after ${afterResults.length}`);
  console.log(`values masked: before ${beforeValues.size}; after ${afterValues.size} distinct`);
  console.log(`results that lost every mask: ${touched.size}`);
  console.log(`values no longer masked (removed): ${rows.length} distinct; values newly masked (added): ${added.length}`);
  console.log(`masking ms per masked result — before ${JSON.stringify(timing(beforeResults))}`);
  console.log(`masking ms per masked result — after  ${JSON.stringify(timing(afterResults))}`);
  console.log(`all-text masking ms (sum of the per-file totals): before ${[...before.values()].reduce((total, row) => total + row.maskMs, 0).toFixed(0)}; after ${[...after.values()].reduce((total, row) => total + row.maskMs, 0).toFixed(0)}`);
  console.log(`all-text masking ms mean per text block: before ${mean([...before.values()].map((row) => row.maskMs / Math.max(1, row.textsScanned))).toFixed(3)}; after ${mean([...after.values()].map((row) => row.maskMs / Math.max(1, row.textsScanned))).toFixed(3)}`);
  console.log(`removed-mask list: ${removedPath}`);
}

if (process.argv.includes('--compare')) {
  const beforePath = values(process.argv, '--before');
  const afterPath = values(process.argv, '--after');
  const removedPath = values(process.argv, '--removed');
  if (!beforePath || !afterPath || !removedPath) {
    console.error('usage: node scripts/credential-replay.mjs --compare --before <jsonl> --after <jsonl> --removed <file>');
    process.exit(2);
  }
  compareMode(beforePath, afterPath, removedPath);
} else if (process.argv.includes('--files') || process.argv.includes('--sessions')) {
  const out = values(process.argv, '--out');
  if (!out) {
    console.error('usage: node scripts/credential-replay.mjs --files <list> | --sessions <dir> [--lib <dist/index.js>] [--since <date>] [--skip <list>] --out <jsonl>');
    process.exit(2);
  }
  const module = await import(library);
  const root = values(process.argv, '--sessions', join(homedir(), '.pi', 'agent', 'sessions'));
  await sessionsMode(module, root, values(process.argv, '--since', '1970-01-01'), out);
} else {
  const report = values(process.argv, '--report');
  if (!report) {
    console.error('usage: node scripts/credential-replay.mjs --report eval/reports/<batch> [--show-values]');
    console.error('       node scripts/credential-replay.mjs --files <list> --out <jsonl> [--lib <dist/index.js>]');
    console.error('       node scripts/credential-replay.mjs --compare --before <jsonl> --after <jsonl> --removed <file>');
    process.exit(2);
  }
  reportMode(report);
}
