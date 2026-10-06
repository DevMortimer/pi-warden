#!/usr/bin/env node
// Intentional paid calibration only with --yes. No submitted state or credentials are printed.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createTypeSafe, DEFAULT_USD_PER_MTOK, estimateUsd } from 'pi-typesafe';
import { cases, fixtureVersion } from './supervision-cases.mjs';
import { evaluateSupervision, supervisionQuestions, supervisionPolicy, validateSupervisionRequest } from '../src/supervision.ts';

// The total authorized ceiling is $0.10; reserve $0.02 for Task 5, not this process.
export const calibrationCeilingUsd = 0.08;
// Per-request reserve dominates this fixture's bounded payload by orders of magnitude.
// Never launch a request unless BOTH this reserve and prior actual usage fit inside $0.08.
export const requestReserveUsd = 0.006;
export function canRequestCalibration(spentUsd, reserveUsd = requestReserveUsd) {
  return Number.isFinite(spentUsd) && spentUsd >= 0 && Number.isFinite(reserveUsd)
    && reserveUsd >= requestReserveUsd && spentUsd + reserveUsd <= calibrationCeilingUsd + 1e-12
    && spentUsd < calibrationCeilingUsd;
}

const labels = ['healthy', 'loop', 'no_progress', 'safe_to_resume', 'unavailable'];
const predicted = result => result && result.probability >= supervisionPolicy.probabilityThreshold
  && result.confidence >= supervisionPolicy.confidenceThreshold ? result.kind : 'unavailable';
const isAnomaly = label => label === 'loop' || label === 'no_progress';

export async function calibrate({ judge, rows = cases, print = console.log }) {
  if (rows.length > 12) throw new Error('Calibration limited to twelve requests to preserve the Task 5 reserve');
  if (createHash('sha256').update(JSON.stringify(supervisionQuestions)).digest('hex') !== supervisionPolicy.questionHash) throw new Error('Question hash changed');
  const matrix = Object.fromEntries(labels.map(label => [label, Object.fromEntries(labels.map(answer => [answer, 0]))]));
  let spentUsd = 0, inputTokens = 0, outputTokens = 0, requests = 0;
  const models = new Set();
  for (const row of rows) {
    if (!labels.includes(row.expected) || !validateSupervisionRequest({ version: 1, metrics: row.metrics })) throw new Error('Invalid synthetic row');
    // Reserve a full $0.006 for each pending request, even though its payload is below 8 KiB.
    // At $0.042/MTok that would require >140k input tokens in one tiny request.
    if (!canRequestCalibration(spentUsd)) throw new Error('Calibration ceiling reached before next request');
    const requestBytes = Buffer.byteLength(JSON.stringify({ state: row.metrics, questions: supervisionQuestions }));
    if (requestBytes > 8192) throw new Error('Request exceeds synthetic payload bound');
    let usage;
    const measuredJudge = { evaluate: async (...args) => {
      const result = await judge.evaluate(...args);
      usage = result;
      return result;
    } };
    requests++;
    const result = await evaluateSupervision(row.metrics, {
      judge: measuredJudge, backend: 'typesafe', timeoutMs: 15000, now: Date.now,
    });
    if (!usage || !Number.isSafeInteger(usage.usage?.input_tokens) || !Number.isSafeInteger(usage.usage?.output_tokens)) throw new Error('No valid usage; stopped with no retry');
    inputTokens += usage.usage.input_tokens;
    outputTokens += usage.usage.output_tokens;
    spentUsd += estimateUsd(usage.usage.input_tokens, DEFAULT_USD_PER_MTOK);
    if (spentUsd > calibrationCeilingUsd) throw new Error('Calibration budget exceeded; stopped');
    if (usage.model !== supervisionPolicy.model || !result) throw new Error('Model/answer mismatch; stopped with no retry');
    models.add(usage.model);
    matrix[row.expected][predicted(result)]++;
  }
  const tp = matrix.loop.loop + matrix.loop.no_progress + matrix.no_progress.loop + matrix.no_progress.no_progress;
  const fp = labels.filter(label => !isAnomaly(label)).reduce((sum, label) => sum + matrix[label].loop + matrix[label].no_progress, 0);
  const fn = matrix.loop.healthy + matrix.loop.safe_to_resume + matrix.loop.unavailable + matrix.no_progress.healthy + matrix.no_progress.safe_to_resume + matrix.no_progress.unavailable;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  print(`fixture ${fixtureVersion}; model ${[...models].join(',')}; requests ${requests}; input tokens ${inputTokens}; output tokens ${outputTokens}; estimated USD $${spentUsd.toFixed(6)}`);
  for (const label of labels) print(`label ${label}: ${labels.map(answer => `${answer}=${matrix[label][answer]}`).join(' ')}`);
  print(`anomaly gate P>=${supervisionPolicy.probabilityThreshold} confidence>=${supervisionPolicy.confidenceThreshold}: tp=${tp} fp=${fp} fn=${fn}; precision=${precision ?? 'n/a'} recall=${recall ?? 'n/a'}`);
  return { matrix, precision, recall, requests, inputTokens, outputTokens, spentUsd, models: [...models] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--yes')) {
    console.log(`DRY RUN: ${Math.min(cases.length, 12)} synthetic requests, five Noul questions per request; ceiling $0.08 of $0.10 (Task 5 reserve $0.02). Pass --yes to spend.`);
  } else {
    if (cases.length > 12) throw new Error('Fixture exceeds twelve-request cap');
    try {
      // Only the registered TypeSafe backend; a private .env, if used, must be loaded via Node's --env-file-if-exists.
      await calibrate({ judge: createTypeSafe({ backend: 'typesafe', model: supervisionPolicy.model, maxRequests: 12, timeoutMs: 15000 }) });
    } catch { console.error('Calibration stopped (no retry); no payload or key logged.'); process.exitCode = 1; }
  }
}
