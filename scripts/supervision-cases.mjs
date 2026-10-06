// Synthetic v2 counters only. Frozen development and NEW holdout labels; no private identifiers or text.
export const fixtureVersion = 'synthetic-v2';
const base = {
  rootId: 'synthetic-guardian', role: 'worker', lifecycle: 'active', reason: null, continuationPlan: null,
  observedCostUsd: 0.02, observerCostUsd: 0, softLimitUsd: 1, hardLimitUsd: 2, descendantCount: 0,
  progress: { materialProgressCount: 2, readsSinceProgress: 2, writesSinceProgress: 1, repeatedOperationCount: 0, equivalentErrorCount: 0, lastOperationSignature: null, lastProgressAgeMs: 1000 },
  mcp: { state: 'available', capabilityCount: 2 },
};
const row = (label, progress = {}, metrics = {}) => ({ expected: label, metrics: { ...base, ...metrics, progress: { ...base.progress, ...progress }, mcp: { ...base.mcp, ...metrics.mcp } } });
const retry = { lifecycle: 'paused', reason: 'provider_failure', continuationPlan: 'retry_interrupted_turn_once' };
const blocked = { lifecycle: 'paused', reason: 'mcp_failure', continuationPlan: 'required_capability_unavailable', mcp: { state: 'unavailable', capabilityCount: 0 } };
export const developmentCases = [
  row('healthy', { materialProgressCount: 5, readsSinceProgress: 1, lastProgressAgeMs: 200 }),
  row('healthy', { materialProgressCount: 0, readsSinceProgress: 12, writesSinceProgress: 0, lastProgressAgeMs: null }), // early discovery
  row('healthy', { materialProgressCount: 1, readsSinceProgress: 19, lastProgressAgeMs: 1000 }),
  row('loop', { materialProgressCount: 0, repeatedOperationCount: 6, lastProgressAgeMs: 60000 }),
  row('loop', { materialProgressCount: 0, equivalentErrorCount: 3, lastProgressAgeMs: 85000 }),
  row('loop', { materialProgressCount: 1, repeatedOperationCount: 8, lastProgressAgeMs: 110000 }),
  row('no_progress', { materialProgressCount: 0, readsSinceProgress: 20, lastProgressAgeMs: null }, { observedCostUsd: 0.5 }),
  row('no_progress', { materialProgressCount: 2, readsSinceProgress: 25, lastProgressAgeMs: 60000 }),
  row('no_progress', { materialProgressCount: 0, readsSinceProgress: 45, lastProgressAgeMs: 110000 }),
  row('safe_to_resume', { materialProgressCount: 3, equivalentErrorCount: 0 }, retry),
  row('safe_to_resume', { materialProgressCount: 1, equivalentErrorCount: 1 }, retry),
  row('safe_to_resume', { materialProgressCount: 2 }, { lifecycle: 'paused', reason: 'process_failure', continuationPlan: 'resume_from_checkpoint_once' }),
  row('unavailable', { equivalentErrorCount: 3 }, retry),
  row('unavailable', { repeatedOperationCount: 6, equivalentErrorCount: 5 }, retry),
  row('unavailable', { materialProgressCount: 2 }, blocked),
];
// Holdout is not for tuning after the paid run; labels and order are frozen before measurement.
export const holdoutCases = [
  row('healthy', { materialProgressCount: 0, readsSinceProgress: 19, writesSinceProgress: 0, lastProgressAgeMs: null }, { observedCostUsd: 0.499 }),
  row('healthy', { materialProgressCount: 3, repeatedOperationCount: 5, lastProgressAgeMs: 200 }),
  row('healthy', { materialProgressCount: 3, readsSinceProgress: 20, lastProgressAgeMs: 1000 }), // recent progress at threshold
  row('loop', { materialProgressCount: 0, repeatedOperationCount: 7, lastProgressAgeMs: 61000 }),
  row('loop', { materialProgressCount: 0, equivalentErrorCount: 4, lastProgressAgeMs: 75000 }),
  row('loop', { materialProgressCount: 1, repeatedOperationCount: 6, equivalentErrorCount: 3, lastProgressAgeMs: 85000 }),
  row('no_progress', { materialProgressCount: 0, readsSinceProgress: 21, lastProgressAgeMs: null }, { observedCostUsd: 0.51 }),
  row('no_progress', { materialProgressCount: 1, readsSinceProgress: 30, lastProgressAgeMs: 61000 }),
  row('no_progress', { materialProgressCount: 0, readsSinceProgress: 40, lastProgressAgeMs: 90000 }),
  row('safe_to_resume', { materialProgressCount: 4, equivalentErrorCount: 0 }, retry),
  row('safe_to_resume', { materialProgressCount: 1, equivalentErrorCount: 1, lastProgressAgeMs: 5000 }, retry),
  row('safe_to_resume', { materialProgressCount: 3 }, { lifecycle: 'paused', reason: 'process_failure', continuationPlan: 'resume_from_checkpoint_once' }),
  row('unavailable', { materialProgressCount: 0, equivalentErrorCount: 4 }, retry),
  row('unavailable', { materialProgressCount: 2 }, blocked),
  row('unavailable', { materialProgressCount: 1, equivalentErrorCount: 6 }, { lifecycle: 'paused', reason: 'provider_failure', continuationPlan: 'resume_from_checkpoint_once' }),
];
export const cases = [...developmentCases, ...holdoutCases];
