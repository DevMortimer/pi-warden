#!/usr/bin/env node
// Intentional paid calibration only with --yes. No submitted state or credentials are printed.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createTypeSafe, DEFAULT_USD_PER_MTOK, estimateUsd } from 'pi-typesafe';
import { cases, developmentCases, holdoutCases, fixtureVersion } from './supervision-cases.mjs';
import { evaluateSupervision, supervisionQuestions, supervisionPolicy, validateSupervisionRequest } from '../src/supervision.ts';
import { defaultHostDirs } from '../src/host-dirs.ts';

// One incremental v2 authorization of $0.01; prior v1 spend remains in the combined ledger.
export const priorSpendUsd = 0.000350;
export const calibrationCeilingUsd = 0.01;
export const requestReserveUsd = 0.0003;
export const activationCriteria = Object.freeze({ anomalyPrecision: 0.90, anomalyRecall: 0.70, falseSafeResume: 0, safeResumePrecision: 1 });
export function canRequestCalibration(spentUsd, reserveUsd = requestReserveUsd) {
  return Number.isFinite(spentUsd) && spentUsd >= 0 && Number.isFinite(reserveUsd)
    && reserveUsd >= requestReserveUsd && priorSpendUsd + spentUsd + reserveUsd <= priorSpendUsd + calibrationCeilingUsd + 1e-12
    && spentUsd < calibrationCeilingUsd;
}

// The caller supplies the marker for offline tests; only the CLI resolves the owner's agent data directory.
export function claimCalibrationMarker(markerPath) {
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  const fd = openSync(markerPath, 'wx', 0o600);
  closeSync(fd);
}

const labels = ['healthy', 'loop', 'no_progress', 'safe_to_resume', 'unavailable'];
const predicted = result => result && result.probability >= supervisionPolicy.probabilityThreshold
  && result.confidence >= supervisionPolicy.confidenceThreshold ? result.kind : 'unavailable';
const isAnomaly = label => label === 'loop' || label === 'no_progress';

export async function calibrate({ judge, rows = cases, print = console.log }) {
  if (rows.length > 30) throw new Error('Calibration limited to thirty requests');
  if (createHash('sha256').update(JSON.stringify(supervisionQuestions)).digest('hex') !== supervisionPolicy.questionHash) throw new Error('Question hash changed');
  const matrix = Object.fromEntries(labels.map(label => [label, Object.fromEntries(labels.map(answer => [answer, 0]))]));
  let spentUsd = 0, inputTokens = 0, outputTokens = 0, requests = 0;
  const splitMatrices = Object.fromEntries(['development', 'holdout'].map(split => [split, Object.fromEntries(labels.map(label => [label, Object.fromEntries(labels.map(answer => [answer, 0]))]))]));
  const models = new Set();
  for (const [index, row] of rows.entries()) {
    if (!labels.includes(row.expected) || !validateSupervisionRequest({ version: 1, metrics: row.metrics })) throw new Error('Invalid synthetic row');
    // Reserve $0.0003 before each request; bound the synthetic payload to 6 KiB.
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
    const result = await evaluateSupervision(row.metrics, {
      judge: measuredJudge, backend: 'typesafe', timeoutMs: 15000, now: Date.now,
    });
    if (!usage || !Number.isSafeInteger(usage.usage?.input_tokens) || !Number.isSafeInteger(usage.usage?.output_tokens)) throw new Error('No valid usage; stopped with no retry');
    inputTokens += usage.usage.input_tokens;
    outputTokens += usage.usage.output_tokens;
    spentUsd += estimateUsd(usage.usage.input_tokens, DEFAULT_USD_PER_MTOK);
    if (priorSpendUsd + spentUsd > priorSpendUsd + calibrationCeilingUsd) throw new Error('Combined calibration budget exceeded; stopped');
    if (usage.model !== supervisionPolicy.model || !result) throw new Error('Model/answer mismatch; stopped with no retry');
    models.add(usage.model);
    const answer = predicted(result);
    matrix[row.expected][answer]++;
    if (rows === cases) splitMatrices[index < developmentCases.length ? 'development' : 'holdout'][row.expected][answer]++;
  }
  const tp = matrix.loop.loop + matrix.loop.no_progress + matrix.no_progress.loop + matrix.no_progress.no_progress;
  const fp = labels.filter(label => !isAnomaly(label)).reduce((sum, label) => sum + matrix[label].loop + matrix[label].no_progress, 0);
  const fn = matrix.loop.healthy + matrix.loop.safe_to_resume + matrix.loop.unavailable + matrix.no_progress.healthy + matrix.no_progress.safe_to_resume + matrix.no_progress.unavailable;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const falseSafeResume = labels.filter(label => label !== 'safe_to_resume').reduce((sum, label) => sum + matrix[label].safe_to_resume, 0);
  const safeResumePrecision = matrix.safe_to_resume.safe_to_resume + falseSafeResume ? matrix.safe_to_resume.safe_to_resume / (matrix.safe_to_resume.safe_to_resume + falseSafeResume) : null;
  const passes = precision !== null && precision >= activationCriteria.anomalyPrecision && recall !== null && recall >= activationCriteria.anomalyRecall
    && falseSafeResume === activationCriteria.falseSafeResume && safeResumePrecision === activationCriteria.safeResumePrecision;
  print(`fixture ${fixtureVersion}; model ${[...models].join(',')}; requests ${requests}; input tokens ${inputTokens}; output tokens ${outputTokens}; incremental estimated USD $${spentUsd.toFixed(6)}; combined with prior $${(priorSpendUsd + spentUsd).toFixed(6)}`);
  for (const label of labels) print(`label ${label}: ${labels.map(answer => `${answer}=${matrix[label][answer]}`).join(' ')}`);
  print(`anomaly gate P>=${supervisionPolicy.probabilityThreshold} confidence>=${supervisionPolicy.confidenceThreshold}: tp=${tp} fp=${fp} fn=${fn}; precision=${precision ?? 'n/a'} recall=${recall ?? 'n/a'}`);
  print(`false safe resume=${falseSafeResume}; safe resume precision=${safeResumePrecision ?? 'n/a'}; frozen activation gate=${passes ? 'met (review required; production stays trace_only)' : 'not met'}`);
  if (rows === cases) for (const [split, counts] of Object.entries(splitMatrices)) print(`${split}: ${JSON.stringify(counts)}`);
  return { matrix, splitMatrices, precision, recall, falseSafeResume, safeResumePrecision, passes, requests, inputTokens, outputTokens, spentUsd, combinedSpendUsd: priorSpendUsd + spentUsd, models: [...models] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--yes')) {
    console.log(`DRY RUN: ${cases.length} synthetic-v2 requests (${developmentCases.length} development, ${holdoutCases.length} holdout), five Noul questions per request; prior $${priorSpendUsd.toFixed(6)}, incremental cap $${calibrationCeilingUsd.toFixed(2)}. Pass --yes once to spend.`);
  } else {
    if (cases.length !== 30 || developmentCases.length !== 15 || holdoutCases.length !== 15) throw new Error('Frozen fixture count changed');
    // Exclusive durable marker prevents a second invocation, including after a partial run or failure.
    // Owner may archive it only after reviewing the one authorized run; this script never retries.
    try {
      claimCalibrationMarker(join(defaultHostDirs().agentDir, 'pi-warden', '.supervision-calibration-v2-run'));
    } catch { console.error('Calibration already attempted or marker unavailable; no retry.'); process.exitCode = 1; }
    if (!process.exitCode) try {
      // Only the registered TypeSafe backend; a private .env, if used, must be loaded via Node's --env-file-if-exists.
      await calibrate({ judge: createTypeSafe({ backend: 'typesafe', model: supervisionPolicy.model, maxRequests: 30, timeoutMs: 15000 }) });
    } catch { console.error('Calibration stopped (no retry); no payload or key logged.'); process.exitCode = 1; }
  }
}
