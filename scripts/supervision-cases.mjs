// Synthetic v1 counters only. No transcripts, paths, commands, errors, prompts or real identifiers.
export const fixtureVersion = 'synthetic-v1';
const base = {
  rootId: 'synthetic-guardian', role: 'worker', lifecycle: 'active', reason: null, continuationPlan: null,
  observedCostUsd: 0.02, observerCostUsd: 0, softLimitUsd: 1, hardLimitUsd: 2, descendantCount: 0,
  progress: { materialProgressCount: 2, readsSinceProgress: 2, writesSinceProgress: 1, repeatedOperationCount: 0, equivalentErrorCount: 0, lastOperationSignature: null, lastProgressAgeMs: 1000 },
  mcp: { state: 'available', capabilityCount: 2 },
};
const row = (label, progress = {}, metrics = {}) => ({ expected: label, metrics: { ...base, ...metrics, progress: { ...base.progress, ...progress }, mcp: { ...base.mcp, ...metrics.mcp } } });
export const cases = [
  row('healthy', { materialProgressCount: 5, readsSinceProgress: 1, writesSinceProgress: 1 }),
  row('healthy', { materialProgressCount: 0, readsSinceProgress: 12, writesSinceProgress: 0, lastProgressAgeMs: null }), // expected discovery
  row('loop', { materialProgressCount: 0, repeatedOperationCount: 8, readsSinceProgress: 2, lastProgressAgeMs: 85000 }),
  row('loop', { materialProgressCount: 0, equivalentErrorCount: 5, repeatedOperationCount: 7, lastProgressAgeMs: 85000 }),
  row('no_progress', { materialProgressCount: 0, readsSinceProgress: 45, writesSinceProgress: 0, lastProgressAgeMs: 110000 }),
  row('healthy', { materialProgressCount: 9, readsSinceProgress: 0, writesSinceProgress: 0, repeatedOperationCount: 2, lastProgressAgeMs: 200 }), // genuine progress after repeat
  row('safe_to_resume', { materialProgressCount: 3, equivalentErrorCount: 0 }, { lifecycle: 'paused', reason: 'provider_failure', continuationPlan: 'retry_interrupted_turn_once' }),
  row('unavailable', { materialProgressCount: 0, equivalentErrorCount: 6, repeatedOperationCount: 8 }, { lifecycle: 'paused', reason: 'provider_failure', continuationPlan: 'retry_interrupted_turn_once' }),
  row('unavailable', { materialProgressCount: 2 }, { lifecycle: 'paused', reason: 'mcp_failure', continuationPlan: 'required_capability_unavailable', mcp: { state: 'unavailable', capabilityCount: 0 } }),
  row('healthy', { materialProgressCount: 1, readsSinceProgress: 19, lastProgressAgeMs: 10000 }), // boundary below reading evidence
  row('healthy', { materialProgressCount: 3, repeatedOperationCount: 5, lastProgressAgeMs: 2000 }), // boundary below repetition evidence
  row('healthy', { materialProgressCount: 1, readsSinceProgress: 20, lastProgressAgeMs: 1000 }), // recent progress despite reading threshold
];
