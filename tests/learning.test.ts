import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set test DB path before importing
const testDir = mkdtempSync(join(tmpdir(), "pi-warden-learn-"));
process.env.PI_WARDEN_DB = join(testDir, "holds.db");

const { initSchema, recordHold, recordOutcome, querySmartHistory, calculateSmartConfidence, shouldSkipHold, signatureHash } = await import("../src/learning.js");

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("initSchema creates database with correct columns", async () => {
  await initSchema();
  assert.ok(existsSync(process.env.PI_WARDEN_DB!), "database file exists");
});

test("signatureHash produces consistent hashes", () => {
  const h1 = signatureHash("bash", { irreversible: 0.5, reasons: ["test"] });
  const h2 = signatureHash("bash", { irreversible: 0.5, reasons: ["test"] });
  assert.equal(h1, h2, "same input produces same hash");
  assert.equal(h1.length, 16, "hash is 16 hex chars");
});

test("recordHold inserts a hold and returns an id", async () => {
  const id = await recordHold({
    timestamp: Date.now(),
    projectRoot: "/test/project",
    tool: "bash",
    commandPreview: "npm test",
    task: "run tests",
    plan: "execute test suite",
    scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
    agentReason: "Running tests as requested",
  });
  assert.ok(id > 0, "recordHold returns positive id");
});

test("recordOutcome updates the outcome", async () => {
  const id = await recordHold({
    timestamp: Date.now(),
    projectRoot: "/test/project",
    tool: "bash",
    commandPreview: "npm test",
    task: "run tests",
    scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
  });
  await recordOutcome(id, "approved");
});

test("querySmartHistory finds exact matches in same project", async () => {
  await recordHold({
    timestamp: Date.now(),
    projectRoot: "/test/project",
    tool: "bash",
    commandPreview: "npm test",
    task: "run tests",
    scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
  });

  const history = await querySmartHistory("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] }, "/test/project");
  assert.ok(history.exact.length > 0, "finds exact matches");
});

test("querySmartHistory does not find matches in different project", async () => {
  const history = await querySmartHistory("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] }, "/other/project");
  assert.equal(history.exact.length, 0, "no matches in different project");
});

test("calculateSmartConfidence returns 0 for empty history", () => {
  const conf = calculateSmartConfidence({ exact: [], similar: [], sameReason: [], signatureHash: "abc" });
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
    signatureHash: "abc",
  });
  assert.ok(conf.confidence > 0.7, "high confidence for approvals");
});

test("shouldSkipHold never skips destructive patterns", async () => {
  const skip = await shouldSkipHold("bash", { irreversible: 0.9, reasons: ["destructive: git reset"] }, "/test/project");
  assert.equal(skip.skip, false, "never skips destructive patterns");
  assert.ok(skip.reason.includes("destructive"), "reason mentions destructive");
});

test("shouldSkipHold skips when confidence is high with enough exact approvals", async () => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const id = await recordHold({
      timestamp: now - i * 1000,
      projectRoot: "/skip/project",
      tool: "bash",
      commandPreview: "npm test",
      scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
      level: "allow",
      held: true,
      reasons: ["irreversible 0.5"],
    });
    await recordOutcome(id, "approved");
  }
  const skip = await shouldSkipHold("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] }, "/skip/project");
  assert.equal(skip.skip, true, "skips when confidence > 0.8 with >= 3 exact approvals");
  assert.ok(skip.confidence > 0.8, "confidence exceeds threshold");
});

test("querySmartHistory finds similar matches by irr proximity", async () => {
  await recordHold({
    timestamp: Date.now(),
    projectRoot: "/sim/project",
    tool: "bash",
    commandPreview: "rm -rf /tmp/test",
    scores: { irreversible: 0.6, reasons: ["irreversible 0.6"] },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.6"],
  });
  const history = await querySmartHistory("bash", { irreversible: 0.7, reasons: ["irreversible 0.7"] }, "/sim/project");
  assert.ok(history.similar.length > 0, "finds similar matches within irr threshold");
});

// --- Tests for new learning features ---

import { analyzeThresholds, analyzePatterns, generateRecommendations } from "../src/learning.js";

test("analyzeThresholds returns empty for insufficient data", async () => {
  const adjustments = await analyzeThresholds("project-alpha");
  assert.equal(adjustments.length, 0, "no adjustments without enough data");
});

test("analyzeThresholds suggests lowering threshold when precision is low", async () => {
  const projectRoot = "project-beta";
  // Create many holds that get approved (low precision)
  for (let i = 0; i < 25; i++) {
    const id = await recordHold({
      timestamp: Date.now() - i * 1000,
      projectRoot,
      tool: "bash",
      commandPreview: "test-command",
      scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
      level: "confirm",
      held: true,
      reasons: ["irreversible 0.5"],
    });
    await recordOutcome(id, "approved");
  }
  const adjustments = await analyzeThresholds(projectRoot);
  assert.ok(adjustments.length > 0, "suggests adjustment for low precision");
  const first = adjustments[0];
  assert.ok(first, "first adjustment exists");
  assert.equal(first.guard, "action", "adjustment is for action guard");
  assert.ok(first.suggestedThreshold < first.currentThreshold, "suggests lower threshold");
});

test("analyzePatterns returns empty for insufficient data", async () => {
  const insights = await analyzePatterns("project-gamma");
  assert.equal(insights.length, 0, "no insights without enough data");
});

test("generateRecommendations combines threshold and pattern insights", async () => {
  const projectRoot = "project-delta";
  // Create some data
  for (let i = 0; i < 10; i++) {
    await recordHold({
      timestamp: Date.now() - i * 1000,
      projectRoot,
      tool: "bash",
      commandPreview: "test-command",
      scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
      level: "confirm",
      held: true,
      reasons: ["irreversible 0.5"],
    });
  }
  const recommendations = await generateRecommendations(projectRoot);
  assert.ok(Array.isArray(recommendations), "returns an array");
});

// --- Tests for steer effectiveness report ---

import { analyzeSteerEffectivenessReport } from "../src/learning.js";

test("analyzeSteerEffectivenessReport returns empty for insufficient data", async () => {
  const report = await analyzeSteerEffectivenessReport("project-nu");
  assert.equal(report.overall, 0, "overall effectiveness is 0 for empty data");
  assert.equal(Object.keys(report.byType).length, 0, "no steer types");
  assert.equal(report.suggestions.length, 0, "no suggestions");
  assert.equal(report.topPatterns.length, 0, "no top patterns");
});

test("analyzeSteerEffectivenessReport tracks effectiveness by type", async () => {
  const projectRoot = "project-xi";
  // Create holds with different outcomes
  for (let i = 0; i < 10; i++) {
    const id = await recordHold({
      timestamp: Date.now() - i * 1000,
      projectRoot,
      tool: "bash",
      commandPreview: "test-command",
      scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
      level: "confirm",
      held: true,
      reasons: ["irreversible 0.5"],
      agentReason: "irreversible action detected",
    });
    await recordOutcome(id, "approved");
  }
  const report = await analyzeSteerEffectivenessReport(projectRoot);
  assert.ok(report.overall > 0, "overall effectiveness is positive");
  assert.ok(Object.keys(report.byType).length > 0, "has steer types");
  assert.ok(report.topPatterns.length > 0, "has top patterns");
});


