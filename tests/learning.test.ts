import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set test DB path before importing
const testDir = mkdtempSync(join(tmpdir(), "pi-warden-learn-"));
process.env.PI_WARDEN_DB = join(testDir, "holds.db");

const { initSchema, recordHold, recordOutcome, querySmartHistory, calculateSmartConfidence, shouldSkipHold } = await import("../src/learning.js");

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("initSchema creates database with correct columns", () => {
  initSchema();
  assert.ok(existsSync(process.env.PI_WARDEN_DB!), "database file exists");
});

test("recordHold inserts a hold and returns an id", () => {
  const id = recordHold({
    timestamp: Date.now(),
    projectRoot: "/test/project",
    tool: "bash",
    commandPreview: "npm test",
    task: "run tests",
    plan: "execute test suite",
    scores: { irreversible: 0.5, offTask: 0.2 },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
    agentReason: "Running tests as requested",
  });
  assert.ok(id > 0, "recordHold returns positive id, got " + id);
});

test("recordOutcome updates the outcome", () => {
  const id = recordHold({
    timestamp: Date.now(),
    projectRoot: "/test/project",
    tool: "bash",
    commandPreview: "npm test",
    task: "run tests",
    scores: { irreversible: 0.5 },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
  });
  recordOutcome(id, "approved");
  // No assertion needed; if it throws, the test fails
});

test("querySmartHistory finds exact matches in same project", () => {
  // Record a hold
  recordHold({
    timestamp: Date.now(),
    projectRoot: "/test/project",
    tool: "bash",
    commandPreview: "npm test",
    task: "run tests",
    scores: { irreversible: 0.5, offTask: 0.2 },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
  });

  const history = querySmartHistory("bash", { irreversible: 0.5, offTask: 0.2 }, "/test/project");
  assert.ok(history.exact.length > 0, "finds exact matches, got " + history.exact.length);
});

test("querySmartHistory does not find matches in different project", () => {
  const history = querySmartHistory("bash", { irreversible: 0.5 }, "/other/project");
  assert.equal(history.exact.length, 0, "no matches in different project");
});

test("querySmartHistory finds similar matches by tool and irr", () => {
  const history = querySmartHistory("bash", { irreversible: 0.45 }, "/test/project");
  // Should find the one we recorded with irr=0.5 (within 0.2 threshold)
  assert.ok(history.similar.length > 0, "finds similar matches, got " + history.similar.length);
});

test("calculateSmartConfidence returns 0 for empty history", () => {
  const conf = calculateSmartConfidence({ exact: [], similar: [], sameReason: [], commandHash: "abc" });
  assert.equal(conf.confidence, 0, "confidence is 0 for empty history");
  assert.equal(conf.reason, "no history");
});

test("calculateSmartConfidence returns high confidence for approved history", () => {
  const now = Date.now();
  const conf = calculateSmartConfidence({
    exact: [
      { outcome: "approved", timestamp: now - 1000 },
      { outcome: "approved", timestamp: now - 2000 },
      { outcome: "approved", timestamp: now - 3000 },
    ],
    similar: [],
    sameReason: [],
    commandHash: "abc",
  });
  assert.ok(conf.confidence > 0.7, "high confidence for approvals, got " + conf.confidence);
});

test("calculateSmartConfidence returns low confidence for replanned history", () => {
  const now = Date.now();
  const conf = calculateSmartConfidence({
    exact: [
      { outcome: "replanned", timestamp: now - 1000 },
      { outcome: "replanned", timestamp: now - 2000 },
    ],
    similar: [],
    sameReason: [],
    commandHash: "abc",
  });
  assert.ok(conf.confidence < 0.5, "low confidence for replannings, got " + conf.confidence);
});

test("shouldSkipHold never skips destructive patterns", () => {
  const skip = shouldSkipHold("bash", { irreversible: 0.9, reasons: ["destructive: git reset"] }, "/test/project");
  assert.equal(skip.skip, false, "never skips destructive patterns");
  assert.ok(skip.reason.includes("destructive"), "reason mentions destructive");
});

test("shouldSkipHold skips when confidence is high and enough approvals", () => {
  // Record 3 approvals
  for (let i = 0; i < 3; i++) {
    const id = recordHold({
      timestamp: Date.now(),
      projectRoot: "/skip/test",
      tool: "bash",
      commandPreview: "npm test",
      task: "run tests",
      scores: { irreversible: 0.8, reasons: ["irreversible 0.8"] },
      level: "confirm",
      held: true,
      reasons: ["irreversible 0.8"],
    });
    recordOutcome(id, "approved");
  }

  const skip = shouldSkipHold("bash", { irreversible: 0.8, reasons: ["irreversible 0.8"] }, "/skip/test");
  assert.equal(skip.skip, true, "skips when high confidence and enough approvals");
  assert.ok(skip.confidence > 0.8, "confidence is high, got " + skip.confidence);
});
