import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompactSnapshot, compactAppendix, type CompactSnapshot } from "../src/compact.js";
import { redact } from "../src/redact.js";

const EMPTY: CompactSnapshot = { savedOutputs: [], checks: [], holds: [], stuck: undefined, activeTask: undefined };

test("empty snapshot returns empty string", () => {
  assert.equal(compactAppendix(EMPTY), "");
});

test("full snapshot produces a bounded appendix with all sections", () => {
  const snapshot: CompactSnapshot = {
    savedOutputs: [{ tool: "bash", path: "/tmp/pi-warden/out.txt", bytes: 12000 }],
    checks: [
      { command: "npm run check", passed: true, when: "current run" },
      { command: "npm run test", passed: false, when: "run 2, #2" },
    ],
    holds: [
      { tool: "bash", preview: "rm -rf /tmp/demo", outcome: "approved" },
      { tool: "write", preview: "src/config.ts", outcome: "replanned" },
    ],
    stuck: { failures: 3, sameStrategyScore: 0.85, currentCallFamily: "bash" },
    activeTask: "Fix the login redirect",
  };
  const text = compactAppendix(snapshot);
  assert.ok(text.length > 0, "non-empty for a full snapshot");
  assert.ok(text.length <= 2000, `under 2000 chars (got ${text.length})`);
  assert.match(text, /=== PI-WARDEN COMPACT EVIDENCE ===/);
  assert.match(text, /=== END PI-WARDEN COMPACT EVIDENCE ===/);
  assert.match(text, /Evidence warden kept across compaction/);
  assert.match(text, /### Saved full outputs/);
  assert.match(text, /### Last checks/);
  assert.match(text, /### Held actions/);
  assert.match(text, /### Stuck state/);
  assert.match(text, /### Active task/);
  // Checks are present (the strings contain the command names).
  assert.match(text, /npm run check/);
  assert.match(text, /npm run test/);
  // Held actions contain the tool and outcome.
  assert.match(text, /bash.*approved/);
  assert.match(text, /write.*replanned/);
  // Stuck state shows failures and same-strategy score.
  assert.match(text, /failures: 3/);
  assert.match(text, /same-strategy: 0\.85/);
});

test("holds are capped at 10", () => {
  const holds = Array.from({ length: 15 }, (_, i) => ({
    tool: "bash",
    preview: `call-${i}`,
    outcome: "approved",
  }));
  const snapshot: CompactSnapshot = { ...EMPTY, holds };
  const text = compactAppendix(snapshot);
  // Only the last 10 should appear (buildCompactSnapshot caps at 10).
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [], holds,
    stuck: undefined, activeTask: undefined, runs: 1,
  });
  assert.equal(built.holds.length, 10);
  assert.equal(compactAppendix(built).match(/approved/g)?.length, 10);
});

test("checks are capped at 5", () => {
  const checks = Array.from({ length: 8 }, (_, i) => ({
    command: `cmd-${i}`,
    passed: i % 2 === 0,
    runIndex: 1,
    indexInRun: i,
  }));
  const built = buildCompactSnapshot({
    savedOutputs: [], checks, holds: [],
    stuck: undefined, activeTask: undefined, runs: 1,
  });
  assert.equal(built.checks.length, 5);
  const text = compactAppendix(built);
  assert.equal(text.match(/cmd-/g)?.length, 5);
});

test("redaction of a seeded credential in the active task", () => {
  const snapshot: CompactSnapshot = { ...EMPTY, activeTask: "Set the API key sk-test-1234567890abcdef1234" };
  const text = compactAppendix(snapshot);
  assert.ok(!text.includes("sk-test-1234567890abcdef1234"), "credential must be redacted");
  assert.match(text, /\[redacted\]/);
});

test("redaction of a credential in a held preview", () => {
  const snapshot: CompactSnapshot = {
    ...EMPTY,
    holds: [{ tool: "bash", preview: "TOKEN=ghp_Qk7mZ2pR9vT4xL8nW3sY6bD1cF5hJ0aM", outcome: "approved" }],
  };
  const text = compactAppendix(snapshot);
  assert.ok(!text.includes("ghp_Qk7mZ2pR9vT4xL8nW3sY6bD1cF5hJ0aM"), "GitHub token must be redacted");
  assert.match(text, /\[redacted\]/);
});

test("redaction of a credential in a check command", () => {
  const snapshot: CompactSnapshot = {
    ...EMPTY,
    checks: [{ command: "curl -H 'Authorization: Bearer sk-live-abcdefghij1234567890abcdef' https://api.example.com", passed: true, when: "current run" }],
  };
  const text = compactAppendix(snapshot);
  assert.ok(!text.includes("sk-live-abcdefghij1234567890abcdef"), "API key must be redacted");
});

test("buildCompactSnapshot: run label is 'current run' when runs=1", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [{ command: "tsc", passed: true, runIndex: 1, indexInRun: 0 }], holds: [],
    stuck: undefined, activeTask: undefined, runs: 1,
  });
  assert.equal(built.checks[0]!.when, "current run");
});

test("buildCompactSnapshot: run label includes run index when runs>1", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [{ command: "tsc", passed: false, runIndex: 2, indexInRun: 1 }], holds: [],
    stuck: undefined, activeTask: undefined, runs: 2,
  });
  assert.equal(built.checks[0]!.when, "run 2, #2");
});

test("buildCompactSnapshot: stuck state captures failures and call family", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [], holds: [],
    stuck: { failures: 4, sameStrategyScore: 0.72, currentCallFamily: "bash" }, activeTask: "test", runs: 1,
  });
  assert.equal(built.stuck?.failures, 4);
  assert.equal(built.stuck?.sameStrategyScore, 0.72);
  assert.equal(built.stuck?.currentCallFamily, "bash");
});

test("buildCompactSnapshot: activeTask is redacted", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [], holds: [],
    stuck: undefined, activeTask: "Use the secret key sk-1234567890abcdef1234", runs: 1,
  });
  assert.ok(!built.activeTask!.includes("sk-1234567890abcdef1234"));
});

test("appendix is capped at 2000 characters", () => {
  // Build a snapshot with many holds and checks to approach the limit.
  const holds = Array.from({ length: 10 }, (_, i) => ({ tool: "bash", preview: "a".repeat(100), outcome: "approved" }));
  const checks = Array.from({ length: 5 }, (_, i) => ({ command: "b".repeat(80), passed: i % 2 === 0, when: `run 1, #${i + 1}` }));
  const snapshot: CompactSnapshot = {
    savedOutputs: [{ tool: "bash", path: "/tmp/out.txt", bytes: 99999 }],
    checks, holds,
    stuck: { failures: 5, sameStrategyScore: 0.9, currentCallFamily: "bash" },
    activeTask: "c".repeat(200),
  };
  const text = compactAppendix(snapshot);
  assert.ok(text.length <= 2000, `expected <=2000 chars, got ${text.length}`);
  if (text.length === 2000) {
    assert.match(text, /\u2026 \[truncated\]/);
  }
});

test("stuck state without sameStrategyScore still shows failures", () => {
  const snapshot: CompactSnapshot = {
    ...EMPTY,
    stuck: { failures: 3, sameStrategyScore: undefined, currentCallFamily: undefined },
  };
  const text = compactAppendix(snapshot);
  assert.match(text, /failures: 3/);
  assert.doesNotMatch(text, /same-strategy/);
  assert.doesNotMatch(text, /family/);
});
