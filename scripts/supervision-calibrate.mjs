#!/usr/bin/env node
// Intentional paid calibration only with --yes. No submitted state or credentials are printed.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createTypeSafe, DEFAULT_USD_PER_MTOK, estimateUsd } from 'pi-typesafe';
import { cases, developmentCases, holdoutCases, fixtureVersion } from './supervision-cases.mjs';
import { evaluateSupervision, supervisionQuestions, supervisionPolicy, validateSupervisionRequest } from '../src/supervision.ts';

/** This run's own ceiling, so maintainers can rerun without carrying a personal spend ledger. */
export const runCeilingUsd = 0.05;
export const requestReserveUsd = 0.0003;
export const activationCriteria = Object.freeze({ anomalyPrecision: 0.90, anomalyRecall: 0.70, falseSafeResume: 0, safeResumePrecision: 1 });
export function canRequestCalibration(spentUsd, reserveUsd = requestReserveUsd, ceilingUsd = runCeilingUsd) {
  return Number.isFinite(spentUsd) && spentUsd >= 0 && Number.isFinite(reserveUsd)
    && reserveUsd >= requestReserveUsd && spentUsd + reserveUsd <= ceilingUsd + 1e-12
    && spentUsd < ceilingUsd;
}

const labels = ['healthy', 'loop', 'no_progress', 'safe_to_resume', 'unavailable'];
const anomalyLabels = new Set(['loop', 'no_progress']);
// A row is an anomaly only when its selected probability clears the threshold; otherwise it is gated unavailable.
const predicted = (result, threshold) => result.probability >= threshold ? result.kind : 'unavailable';
const emptyMatrix = () => Object.fromEntries(labels.map(label => [label, Object.fromEntries(labels.map(answer => [answer, 0]))]));

function matrixAt(rows, results, threshold) {
  const matrix = emptyMatrix();
  for (let index = 0; index < rows.length; index++) matrix[rows[index].expected][predicted(results[index], threshold)]++;
  return matrix;
}

function score(matrix) {
  const tp = [...anomalyLabels].reduce((sum, label) => sum + matrix[label].loop + matrix[label].no_progress, 0);
  const fp = labels.filter(label => !anomalyLabels.has(label)).reduce((sum, label) => sum + matrix[label].loop + matrix[label].no_progress, 0);
  const fn = [...anomalyLabels].reduce((sum, label) => sum + matrix[label].healthy + matrix[label].safe_to_resume + matrix[label].unavailable, 0);
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const falseSafeResume = labels.filter(label => label !== 'safe_to_resume').reduce((sum, label) => sum + matrix[label].safe_to_resume, 0);
  const safeResumePrecision = matrix.safe_to_resume.safe_to_resume + falseSafeResume ? matrix.safe_to_resume.safe_to_resume / (matrix.safe_to_resume.safe_to_resume + falseSafeResume) : null;
  return { tp, fp, fn, precision, recall, falseSafeResume, safeResumePrecision };
}

const meetsGate = metrics => metrics.precision !== null && metrics.precision >= activationCriteria.anomalyPrecision
  && metrics.recall !== null && metrics.recall >= activationCriteria.anomalyRecall
  && metrics.falseSafeResume === activationCriteria.falseSafeResume
  && metrics.safeResumePrecision === activationCriteria.safeResumePrecision;

const f1 = metrics => metrics.precision !== null && metrics.recall !== null && metrics.precision + metrics.recall > 0
  ? 2 * metrics.precision * metrics.recall / (metrics.precision + metrics.recall) : -1;

/** The threshold is chosen on the development split only; the holdout split never tunes it. */
export function selectThreshold(rows, results) {
  const candidates = [];
  for (let value = 0.50; value <= 0.99 + 1e-9; value += 0.01) candidates.push(Number(value.toFixed(2)));
  for (const threshold of candidates) {
    const metrics = score(matrixAt(rows, results, threshold));
    if (meetsGate(metrics)) return { threshold, metrics, gate: true };
  }
  // No threshold meets the gate: report the best F1 so a failed run still shows the closest cut.
  let best = { threshold: candidates[0], metrics: score(matrixAt(rows, results, candidates[0])), gate: false };
  for (const threshold of candidates.slice(1)) {
    const metrics = score(matrixAt(rows, results, threshold));
    if (f1(metrics) > f1(best.metrics)) best = { threshold, metrics, gate: false };
  }
  return best;
}

export async function calibrate({ judge, rows = cases, print = console.log }) {
  if (rows.length > 30) throw new Error('Calibration limited to thirty requests');
  if (createHash('sha256').update(JSON.stringify(supervisionQuestions)).digest('hex') !== supervisionPolicy.questionHash) throw new Error('Question hash changed');
  const results = [];
  let spentUsd = 0, inputTokens = 0, outputTokens = 0, requests = 0;
  const models = new Set();
  for (const row of rows) {
    if (!labels.includes(row.expected) || !validateSupervisionRequest({ version: 1, metrics: row.metrics })) throw new Error('Invalid synthetic row');
    // Reserve before each request; bound the synthetic payload to 6 KiB.
    if (!canRequestCalibration(spentUsd)) throw new Error('Calibration ceiling reached before next request');
    const requestBytes = Buffer.byteLength(JSON.stringify({ state: row.metrics, questions: supervisionQuestions }));
    if (requestBytes > 6144) throw new Error('Request exceeds synthetic payload bound');
    let usage;
    const measuredJudge = { evaluate: async (...args) => {
      const result = await judge.evaluate(...args);
      usage = result;
      return result;
    } };
    requests++;
    const outcome = await evaluateSupervision(row.metrics, {
      judge: measuredJudge, backend: 'typesafe', timeoutMs: 15000, now: Date.now,
    });
    if (!usage || !Number.isSafeInteger(usage.usage?.input_tokens) || !Number.isSafeInteger(usage.usage?.output_tokens)) throw new Error('No valid usage; stopped with no retry');
    if (!outcome.ok) throw new Error(`Unusable result; stopped with no retry: ${outcome.reason}`);
    inputTokens += usage.usage.input_tokens;
    outputTokens += usage.usage.output_tokens;
    spentUsd += estimateUsd(usage.usage.input_tokens, DEFAULT_USD_PER_MTOK);
    if (spentUsd > runCeilingUsd) throw new Error('Calibration ceiling exceeded; stopped');
    models.add(outcome.result.model);
    results.push(outcome.result);
  }
  const splitOf = index => rows === cases ? (index < developmentCases.length ? 'development' : 'holdout') : 'development';
  const splitRows = { development: [], holdout: [] };
  const splitResults = { development: [], holdout: [] };
  rows.forEach((row, index) => { const split = splitOf(index); splitRows[split].push(row); splitResults[split].push(results[index]); });
  const selection = selectThreshold(splitRows.development, splitResults.development);
  const threshold = selection.threshold;
  const development = score(matrixAt(splitRows.development, splitResults.development, threshold));
  const holdout = splitRows.holdout.length ? score(matrixAt(splitRows.holdout, splitResults.holdout, threshold)) : null;
  const passes = selection.gate && (holdout === null || meetsGate(holdout));

  print(`fixture ${fixtureVersion}; model ${[...models].join(',')}; requests ${requests}; input tokens ${inputTokens}; output tokens ${outputTokens}; estimated USD $${spentUsd.toFixed(6)}`);
  rows.forEach((row, index) => {
    const result = results[index];
    const scores = Object.keys(supervisionQuestions).map(id => `${id}=${result.answers[id].toFixed(2)}`).join(' ');
    print(`row ${index} ${splitOf(index)} expected=${row.expected} selected=${predicted(result, threshold)} p=${result.probability.toFixed(2)} ${scores}`);
  });
  for (const split of ['development', 'holdout']) {
    if (!splitRows[split].length) continue;
    for (const label of labels) {
      const scores = splitRows[split].map((row, index) => row.expected === label ? splitResults[split][index].probability : undefined).filter(value => value !== undefined).sort((a, b) => a - b);
      print(`distribution ${split} ${label}: ${scores.map(value => value.toFixed(2)).join(', ') || 'n/a'}`);
    }
  }
  const reportLine = metrics => `tp=${metrics.tp} fp=${metrics.fp} fn=${metrics.fn}; precision=${metrics.precision ?? 'n/a'} recall=${metrics.recall ?? 'n/a'}; false safe resume=${metrics.falseSafeResume}; safe resume precision=${metrics.safeResumePrecision ?? 'n/a'}`;
  print(`threshold chosen on development: P>=${threshold.toFixed(2)}`);
  print(`development ${reportLine(development)} gate=${meetsGate(development) ? 'met' : 'not met'}`);
  if (holdout) print(`holdout ${reportLine(holdout)} gate=${meetsGate(holdout) ? 'met' : 'not met'}`);
  print(`frozen activation gate=${passes ? 'met (review required; production stays record-only)' : 'not met'}`);
  return { rows, results, selectedThreshold: threshold, development, holdout, passes, requests, inputTokens, outputTokens, spentUsd, models: [...models] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--yes')) {
    console.log(`DRY RUN: ${cases.length} synthetic-v2 requests (${developmentCases.length} development, ${holdoutCases.length} holdout), five Noul questions per request; per-run cap $${runCeilingUsd.toFixed(2)}. Pass --yes to spend.`);
  } else {
    if (cases.length !== 30 || developmentCases.length !== 15 || holdoutCases.length !== 15) throw new Error('Frozen fixture count changed');
    // Only the registered TypeSafe backend; a private .env, if used, must be loaded via Node's --env-file-if-exists.
    await calibrate({ judge: createTypeSafe({ backend: 'typesafe', model: supervisionPolicy.model, maxRequests: 30, timeoutMs: 15000 }) });
  }
}
