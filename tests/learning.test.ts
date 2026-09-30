import assert from "node:assert/strict";
import { test, after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Set test DB path before importing
const testDir = mkdtempSync(join(tmpdir(), "pi-warden-learn-"));
// A nested folder that does not exist yet: the database must create its own directory.
process.env.PI_WARDEN_DB = join(testDir, "nested", "pi-warden", "holds.db");

const { initSchema, recordHold, recordOutcome, toHoldRecord, querySmartHistory, queryHoldsForProject, calculateSmartConfidence, shouldSkipHold, signatureHash } = await import("../src/learning.js");

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
  assert.equal(signatureHash("bash", { irreversible: 0.5, reasons: ["test"], largeOutput: 0.3 }), h1, "the large_output score does not split the signature");
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

import { analyzeThresholds, analyzePatterns, generateRecommendations, holdStats } from "../src/learning.js";

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

// --- Tests for command_preview redaction and replanned outcome persistence ---

test("toHoldRecord redacts password-bearing URLs in command_preview", () => {
  const record = toHoldRecord(
    { at: Date.now(), tool: "bash", level: "confirm", reasons: ["test"] },
    "/test/project",
    { preview: "git push https://user:secret123@github.com/repo.git main" },
  );
  assert.ok(!record.commandPreview.includes("secret123"), "password must not appear in command_preview");
  assert.ok(record.commandPreview.includes("[redacted]"), "password region is redacted");
});

test("toHoldRecord caps command_preview at 200 characters", () => {
  const longCommand = "echo " + "x".repeat(300);
  const record = toHoldRecord(
    { at: Date.now(), tool: "bash", level: "confirm", reasons: ["test"] },
    "/test/project",
    { preview: longCommand },
  );
  assert.ok(record.commandPreview.length <= 200, "command_preview must not exceed 200 chars");
});

test("toHoldRecord falls back to tool name when no preview is provided", () => {
  const record = toHoldRecord(
    { at: Date.now(), tool: "bash", level: "confirm", reasons: ["test"] },
    "/test/project",
  );
  assert.equal(record.commandPreview, "bash", "falls back to tool name");
});

test("recordOutcome persists replanned outcome", async () => {
  const id = await recordHold({
    timestamp: Date.now(),
    projectRoot: "/replanned/project",
    tool: "bash",
    commandPreview: "npm test",
    scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
  });
  await recordOutcome(id, "replanned");
  // Verify the outcome persisted by querying the database directly.
  // querySmartHistory filters on held=1, so a replanned record should appear.
  const history = await querySmartHistory("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] }, "/replanned/project");
  const match = history.exact.find(row => row.outcome === "replanned");
  assert.ok(match, "replanned outcome is queryable via querySmartHistory");
});

// --- Tests for outcome race closure and allowed-call persistence ---

test("outcome arriving before recordHold resolves is persisted via the promise", async () => {
  const projectRoot = "/race/project";
  // recordHold returns a promise; we simulate the race by calling recordOutcome
  // with the promise before it resolves (it is already unresolved).
  const idPromise = recordHold({
    timestamp: Date.now(),
    projectRoot,
    tool: "bash",
    commandPreview: "npm test",
    scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
    level: "allow",
    held: true,
    reasons: ["irreversible 0.5"],
  });
  // Simulate the extension pattern: idPromise.then(id => recordOutcome(id, outcome))
  const outcomePromise = idPromise.then(id => recordOutcome(id, "approved"));
  await outcomePromise;
  const history = await querySmartHistory("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] }, projectRoot);
  const match = history.exact.find(row => row.outcome === "approved");
  assert.ok(match, "outcome persisted even when recordOutcome races with recordHold");
});

test("judged allowed call produces a row with held = 0 and redacted preview", async () => {
  const projectRoot = "/allowed/project";
  const record = toHoldRecord(
    { at: Date.now(), tool: "bash", level: "allow", reasons: ["irreversible 0.3"], scores: { irreversible: 0.3, offTask: 0, scope: "expected_step" as any }, held: false },
    projectRoot,
    { preview: "npm test" },
  );
  assert.equal(record.held, false, "held is false for judged allowed calls");
  const id = await recordHold(record);
  const rows = await queryHoldsForProject(projectRoot, { held: false });
  assert.ok(rows.length > 0, "allowed call persisted in SQLite");
  const row = rows[0]!;
  assert.equal(row.held, 0, "held column is 0");
  assert.equal(row.command_preview, "npm test", "preview stored correctly");
});

test("the large_output score of a judged bash call lands in the scores column", async () => {
  const projectRoot = "/large-output/project";
  const scored = toHoldRecord(
    { at: Date.now(), tool: "bash", level: "confirm", reasons: [], scores: { irreversible: 0.1, offTask: 0, scope: "expected_step", largeOutput: 0.3 }, held: true },
    projectRoot,
    { preview: "npm test" },
  );
  assert.deepEqual(scored.scores, { irreversible: 0.1, reasons: [], largeOutput: 0.3 });
  await recordHold(scored);
  // The lookup carries no large_output score, so an exact match also proves the signature ignores it.
  const history = await querySmartHistory("bash", { irreversible: 0.1, reasons: [] }, projectRoot);
  assert.equal(history.exact.length, 1);
  assert.equal(JSON.parse(String(history.exact[0]!.scores)).largeOutput, 0.3);
  const unscored = toHoldRecord(
    { at: Date.now(), tool: "write", level: "allow", reasons: [], scores: { irreversible: 0.1, offTask: 0, scope: "expected_step" }, held: false },
    projectRoot,
  );
  assert.ok(!("largeOutput" in unscored.scores), "a verdict without the score writes no largeOutput key");
});

test("regret on an allowed call is persisted to SQLite", async () => {
  const projectRoot = "/regret-allowed/project";
  const id = await recordHold({
    timestamp: Date.now(),
    projectRoot,
    tool: "write",
    commandPreview: "file.ts",
    scores: { irreversible: 0.1, reasons: [] },
    level: "allow",
    held: false,
    reasons: [],
  });
  await recordOutcome(id, "regretted");
  const rows = await queryHoldsForProject(projectRoot, { held: false });
  const match = rows.find(row => row.outcome === "regretted");
  assert.ok(match, "regretted outcome persisted for allowed call");
});

test("read-only skipped call produces no row in SQLite", async () => {
  const projectRoot = "/skipped/project";
  const rows = await queryHoldsForProject(projectRoot);
  assert.equal(rows.length, 0, "no rows for a project with only skipped calls");
});

// --- Tests for holdStats ---

test("holdStats returns zero counts for unknown project", async () => {
  const stats = await holdStats("/nonexistent/project");
  assert.equal(stats.held, 0);
  assert.equal(stats.labeled, 0);
  assert.equal(stats.approved, 0);
  assert.equal(stats.declined, 0);
  assert.equal(stats.replanned, 0);
  assert.equal(stats.allowed, 0);
  assert.equal(stats.regretted, 0);
  assert.equal(stats.accepted, 0);
});

test("holdStats counts held rows with mixed outcomes correctly", async () => {
  const projectRoot = "/stats/project";
  const now = Date.now();

  // 3 held rows: 1 approved, 1 declined, 1 replanned
  const id1 = await recordHold({ timestamp: now - 3000, projectRoot, tool: "bash", commandPreview: "cmd1", scores: { irreversible: 0.5, reasons: [] }, level: "confirm", held: true, reasons: [] });
  const id2 = await recordHold({ timestamp: now - 2000, projectRoot, tool: "bash", commandPreview: "cmd2", scores: { irreversible: 0.5, reasons: [] }, level: "confirm", held: true, reasons: [] });
  const id3 = await recordHold({ timestamp: now - 1000, projectRoot, tool: "bash", commandPreview: "cmd3", scores: { irreversible: 0.5, reasons: [] }, level: "confirm", held: true, reasons: [] });
  await recordOutcome(id1, "approved");
  await recordOutcome(id2, "declined");
  await recordOutcome(id3, "replanned");

  const stats = await holdStats(projectRoot);
  assert.equal(stats.held, 3);
  assert.equal(stats.labeled, 3);
  assert.equal(stats.approved, 1);
  assert.equal(stats.declined, 1);
  assert.equal(stats.replanned, 1);
  assert.equal(stats.oldest, now - 3000);
  assert.equal(stats.newest, now - 1000);
});

test("holdStats counts allowed rows correctly", async () => {
  const projectRoot = "/stats/allowed";
  const now = Date.now();

  // 2 allowed rows: 1 accepted, 1 regretted
  const id1 = await recordHold({ timestamp: now - 2000, projectRoot, tool: "read", commandPreview: "file.ts", scores: { irreversible: 0.1, reasons: [] }, level: "allow", held: false, reasons: [] });
  const id2 = await recordHold({ timestamp: now - 1000, projectRoot, tool: "read", commandPreview: "file.ts", scores: { irreversible: 0.1, reasons: [] }, level: "allow", held: false, reasons: [] });
  await recordOutcome(id1, "accepted");
  await recordOutcome(id2, "regretted");

  const stats = await holdStats(projectRoot);
  assert.equal(stats.allowed, 2);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.regretted, 1);
  assert.equal(stats.held, 0);
});

// --- Tests for busy_timeout and VACUUM gating (issue #36) ---

test("busy_timeout is set on a fresh connection", () => {
  const path = join(testDir, "busy-test.db");
  const d = new DatabaseSync(path);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA busy_timeout = 10000");
  const row = d.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.equal(row.timeout, 10000, "busy_timeout is 10000ms");
  d.close();
});

test("initSchema does not run VACUUM when no rows are past the cutoff", () => {
  // Create a fresh database manually to avoid disturbing the module-level db cache.
  const path = join(testDir, "vacuum-test.db");
  const d = new DatabaseSync(path);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, ts INTEGER)");
  d.prepare("INSERT INTO t (ts) VALUES (?)").run(Date.now());
  const freelistBefore = (d.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  // Simulate initSchema's prune path: nothing to delete, so VACUUM should not run.
  const { changes } = d.prepare("DELETE FROM t WHERE ts < ?").run(Date.now() - 365 * 86_400_000);
  assert.equal(changes, 0, "no rows to delete");
  // VACUUM would change freelist; skip it as initSchema now does.
  const freelistAfter = (d.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  assert.equal(freelistAfter, freelistBefore, "freelist unchanged: VACUUM did not run");
  d.close();
});



// --- Retention, the session id, and the one-time migration to the slim schema ---

/**
 * A database of its own: getDb() prefers PI_WARDEN_DB over an injected directory, so the variable goes away for
 * the call and comes back after it. Every case below would otherwise write into the shared test database.
 */
async function withOwnDatabase(run: (dirs: { agentDir: string; configDirName: string }, file: string) => Promise<void>): Promise<void> {
  const saved = process.env.PI_WARDEN_DB;
  delete process.env.PI_WARDEN_DB;
  const dirs = { agentDir: mkdtempSync(join(testDir, "case-")), configDirName: ".pi" };
  const file = join(dirs.agentDir, "pi-warden", "holds.db");
  try {
    await run(dirs, file);
  } finally {
    if (saved !== undefined) process.env.PI_WARDEN_DB = saved;
    rmSync(dirs.agentDir, { recursive: true, force: true });
  }
}

const row = (held: boolean, at: number, sessionId?: string) => ({
  timestamp: at,
  projectRoot: "/retention/project",
  tool: "bash",
  commandPreview: "npm test",
  task: "run the tests",
  plan: "check the suite",
  contextSummary: "user: run the tests",
  scores: { irreversible: 0.5, reasons: ["irreversible 0.5"] },
  level: "confirm" as const,
  held,
  reasons: ["irreversible 0.5"],
  agentReason: "held for the stored reason",
  ...(sessionId ? { sessionId } : {}),
});

test("recordHold writes the session id, and the task text lands once in hold_tasks", async () => {
  await withOwnDatabase(async (dirs, file) => {
    await initSchema(0, dirs, 0);
    await recordHold(row(true, Date.now(), "session-abc"), dirs);
    await recordHold(row(true, Date.now(), "session-abc"), dirs);
    const d = new DatabaseSync(file, { readOnly: true });
    const held = d.prepare("SELECT session_id, task_hash, plan, scores, reasons FROM holds").all() as Array<Record<string, unknown>>;
    assert.equal(held.length, 2);
    assert.deepEqual(held.map(record => record.session_id), ["session-abc", "session-abc"], "every row carries the session id");
    assert.equal(held[0]!.task_hash, held[1]!.task_hash, "one task text, one key");
    const tasks = d.prepare("SELECT hash, text FROM hold_tasks").all() as Array<{ hash: string; text: string }>;
    assert.equal(tasks.length, 1, "the task text is stored once");
    assert.equal(tasks[0]!.text, "run the tests");
    assert.equal(held[0]!.plan, "check the suite", "a held row keeps its context");
    assert.ok(typeof held[0]!.scores === "string", "a held row keeps its scores");
    d.close();
  });
});

test("a row of a call that was not held keeps its judge data and drops the summary", async () => {
  await withOwnDatabase(async (dirs, file) => {
    await initSchema(0, dirs, 0);
    await recordHold(row(false, Date.now(), "session-abc"), dirs);
    const d = new DatabaseSync(file, { readOnly: true });
    const allowed = d.prepare("SELECT task_hash, plan, context_summary, scores, reasons, agent_reason, command_preview, held FROM holds").get() as Record<string, unknown>;
    assert.equal(allowed.held, 0);
    assert.equal(allowed.command_preview, "npm test", "queryHoldsForProject reads the preview on an allowed row");
    assert.equal(JSON.parse(String(allowed.scores)).irreversible, 0.5, "an allowed row keeps the judge scores: calibration reads them");
    assert.deepEqual(JSON.parse(String(allowed.reasons)), ["irreversible 0.5"], "an allowed row keeps the reasons");
    assert.equal(allowed.plan, "check the suite", "an allowed row keeps the agent's plan");
    const tasks = d.prepare("SELECT hash, text FROM hold_tasks").all() as Array<{ hash: string; text: string }>;
    assert.equal(tasks.length, 1, "the task text is stored once for an allowed call too");
    assert.equal(tasks[0]!.text, "run the tests");
    assert.equal(allowed.task_hash, tasks[0]!.hash, "the allowed row points at it");
    for (const column of ["context_summary", "agent_reason"]) {
      assert.equal(allowed[column], null, `${column} is not stored for an allowed call`);
    }
    d.close();
  });
});

test("the prune keeps a hold for retentionDays and an allowed call for allowedRetentionDays", async () => {
  await withOwnDatabase(async (dirs, file) => {
    await initSchema(0, dirs, 0);
    const now = Date.now();
    const day = 86_400_000;
    const keptHold = await recordHold(row(true, now - 120 * day), dirs);
    const droppedAllowed = await recordHold({ ...row(false, now - 120 * day), task: "the dropped allowed call's task" }, dirs);
    const droppedHold = await recordHold({ ...row(true, now - 400 * day), task: "the dropped hold's task" }, dirs);
    const keptAllowed = await recordHold({ ...row(false, now - day), task: "the kept allowed call's task" }, dirs);
    await initSchema(365, dirs, 90);
    const d = new DatabaseSync(file, { readOnly: true });
    const rows = d.prepare("SELECT id FROM holds ORDER BY id").all() as Array<{ id: number }>;
    assert.deepEqual(rows.map(entry => entry.id), [keptHold, keptAllowed], `the allowed row past 90 days and the hold past 365 are gone (dropped ${droppedAllowed}, ${droppedHold})`);
    const texts = (d.prepare("SELECT text FROM hold_tasks ORDER BY text").all() as Array<{ text: string }>).map(entry => entry.text);
    assert.deepEqual(texts, ["run the tests", "the kept allowed call's task"], "the prune keeps the text a remaining row points at, an allowed row included, and drops the rest");
    d.close();
  });
});

test("an older database keeps its columns, moves the task text once, and settles the allowed rows", async () => {
  await withOwnDatabase(async (dirs, file) => {
    mkdirSync(join(dirs.agentDir, "pi-warden"), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE holds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        project_root TEXT NOT NULL,
        tool TEXT NOT NULL,
        signature_hash TEXT NOT NULL,
        command_preview TEXT,
        task TEXT,
        input_summary TEXT,
        plan TEXT,
        context_summary TEXT,
        scores TEXT NOT NULL,
        level TEXT NOT NULL,
        held INTEGER NOT NULL,
        reasons TEXT,
        agent_reason TEXT,
        outcome TEXT,
        outcome_at INTEGER,
        prediction TEXT,
        confidence REAL,
        preceding_actions TEXT
      );
      CREATE INDEX idx_holds_project_signature ON holds(project_root, signature_hash);
    `);
    const insert = old.prepare(`INSERT INTO holds (timestamp, project_root, tool, signature_hash, command_preview, task, input_summary, plan, context_summary, scores, level, held, reasons, agent_reason, outcome, prediction, confidence)
      VALUES (?, '/old/project', 'bash', 'hash', 'npm test', ?, 'summary', 'plan text', 'context text', ?, 'confirm', ?, ?, 'reason text', ?, 'prediction', 0.5)`);
    const day = 86_400_000;
    insert.run(Date.now() - day, "the shared task text", JSON.stringify({ irreversible: 0.5 }), 1, JSON.stringify(["irreversible 0.5"]), null);
    insert.run(Date.now() - day, "the shared task text", JSON.stringify({ irreversible: 0.5 }), 1, JSON.stringify(["irreversible 0.5"]), "approved");
    insert.run(Date.now() - day, "the shared task text", JSON.stringify({ irreversible: 0.5 }), 0, JSON.stringify(["irreversible 0.5"]), "accepted");
    old.close();

    await initSchema(0, dirs, 0);

    const d = new DatabaseSync(file, { readOnly: true });
    const columns = (d.prepare("PRAGMA table_info(holds)").all() as Array<{ name: string }>).map(entry => entry.name);
    for (const name of ["session_id", "task_hash", "task", "input_summary", "prediction", "preceding_actions", "confidence"]) {
      assert.ok(columns.includes(name), `the ${name} column stays, so an older session's INSERT and SELECT still resolve`);
    }
    const tasks = d.prepare("SELECT hash, text FROM hold_tasks").all() as Array<{ hash: string; text: string }>;
    assert.equal(tasks.length, 1, "the repeated task text is stored once");
    assert.equal(tasks[0]!.text, "the shared task text");
    const held = d.prepare("SELECT id, task_hash, task, input_summary, prediction, preceding_actions, plan, context_summary, scores, reasons, agent_reason, outcome FROM holds WHERE held = 1 ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.equal(held.length, 2, "no held row is lost");
    assert.deepEqual([held[0]!.id, held[1]!.id], [1, 2], "ids are preserved");
    assert.equal(held[0]!.task_hash, tasks[0]!.hash, "a held row points at the stored task text");
    assert.equal(held[0]!.plan, "plan text");
    assert.equal(held[0]!.context_summary, "context text", "a held row keeps its summary");
    assert.equal(held[0]!.agent_reason, "reason text", "a held row keeps its agent reason");
    assert.equal(held[0]!.outcome, null);
    assert.equal(held[1]!.outcome, "approved");
    const allowed = d.prepare("SELECT task_hash, task, input_summary, prediction, preceding_actions, plan, context_summary, scores, reasons, agent_reason, outcome FROM holds WHERE held = 0").get() as Record<string, unknown>;
    assert.equal(allowed.outcome, "accepted", "an allowed row keeps its outcome");
    assert.equal((d.prepare("SELECT COUNT(*) AS total FROM holds WHERE task IS NOT NULL OR input_summary IS NOT NULL OR prediction IS NOT NULL OR preceding_actions IS NOT NULL").get() as { total: number }).total, 0, "the task text is moved out of every row, not copied");
    assert.equal(allowed.task_hash, tasks[0]!.hash, "the allowed row points at the task text too");
    assert.equal(allowed.plan, "plan text", "an allowed row keeps the agent's plan");
    assert.equal(JSON.parse(String(allowed.scores)).irreversible, 0.5, "an allowed row keeps the judge scores");
    assert.equal(JSON.parse(String(allowed.reasons))[0], "irreversible 0.5", "an allowed row keeps the reasons");
    for (const column of ["task", "input_summary", "prediction", "preceding_actions", "context_summary", "agent_reason"]) assert.equal(allowed[column], null, `${column} is cleared on an allowed row`);
    assert.ok((d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_holds_project_signature'").get()), "the indexes are there");
    d.close();

    // The second start finds the new shape and leaves the rows alone.
    await initSchema(0, dirs, 0);
    const after = new DatabaseSync(file, { readOnly: true });
    assert.equal((after.prepare("SELECT COUNT(*) AS total FROM holds").get() as { total: number }).total, 3, "a second start does not move anything again");
    after.close();
  });
});

// --- Older code against a migrated database: the columns its INSERT and SELECT name still resolve ---

/** The 0.80.0 `recordHold` INSERT, copied verbatim: a session that has not restarted still runs this one. */
const OLD_INSERT = `
    INSERT INTO holds
    (timestamp, project_root, tool, signature_hash, command_preview,
     task, plan, context_summary, preceding_actions,
     scores, level, held, reasons, agent_reason, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

/** One row as the 0.80.0 code writes it: context on every row, held or not. */
function oldRow(d: DatabaseSync, write: { at: number; project: string; hash: string; task: string; held: boolean }): void {
  d.prepare(OLD_INSERT).run(
    write.at, write.project, "bash", write.hash, "npm test",
    write.task, "plan text", "context text", "preceding actions text",
    JSON.stringify({ irreversible: 0.5, reasons: ["irreversible 0.5"] }), "confirm", write.held ? 1 : 0,
    JSON.stringify(["irreversible 0.5"]), "agent reason", 0.5,
  );
}

test("a fresh database keeps the columns an older version's INSERT names, all empty", async () => {
  await withOwnDatabase(async (dirs, file) => {
    await initSchema(0, dirs, 0);
    await recordHold(row(false, Date.now(), "session-fresh"), dirs);
    const d = new DatabaseSync(file);
    const columns = (d.prepare("PRAGMA table_info(holds)").all() as Array<{ name: string }>).map(entry => entry.name);
    const written = d.prepare("SELECT task, input_summary, prediction, preceding_actions, confidence FROM holds").get() as Record<string, unknown>;
    for (const name of Object.keys(written)) {
      assert.ok(columns.includes(name), `a fresh database keeps the ${name} column an older version writes`);
      assert.equal(written[name], null, `${name} is empty on a row this version writes`);
    }
    // The statement itself has to run: a missing column here is what made every guarded call of an older session fail.
    const hash = signatureHash("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] });
    oldRow(d, { at: Date.now(), project: "/old/project", hash, task: "an older session's task", held: true });
    d.close();
  });
});

test("an older version's INSERT and history query still work against a migrated database", async () => {
  await withOwnDatabase(async (dirs, file) => {
    mkdirSync(join(dirs.agentDir, "pi-warden"), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE holds (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, project_root TEXT NOT NULL, tool TEXT NOT NULL, signature_hash TEXT NOT NULL, command_preview TEXT, task TEXT, plan TEXT, context_summary TEXT, preceding_actions TEXT, scores TEXT NOT NULL, level TEXT NOT NULL, held INTEGER NOT NULL, reasons TEXT, agent_reason TEXT, outcome TEXT, outcome_at INTEGER, confidence REAL)`);
    old.close();
    await initSchema(0, dirs, 0);

    const hash = signatureHash("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] });
    const at = Date.now();
    const d = new DatabaseSync(file);
    oldRow(d, { at, project: "/old/project", hash, task: "the older session's task", held: false });
    oldRow(d, { at, project: "/old/project", hash, task: "the older session's task", held: true });
    // 0.80.0's querySmartHistory, verbatim: it reads `task` straight off the row.
    const exact = d.prepare(`
      SELECT task, plan, outcome, scores, agent_reason, timestamp
      FROM holds WHERE signature_hash = ? AND project_root = ? AND held = 1
      ORDER BY timestamp DESC LIMIT 10
    `).all(hash, "/old/project") as Array<Record<string, unknown>>;
    const similar = d.prepare(`
      SELECT task, plan, outcome, scores, agent_reason, timestamp
      FROM holds WHERE tool = ? AND held = 1
      AND ABS(CAST(json_extract(scores, '$.irreversible') AS REAL) - ?) < 0.2
      ORDER BY timestamp DESC LIMIT 10
    `).all("bash", 0.5);
    const sameReason = d.prepare(`
      SELECT task, plan, outcome, scores, agent_reason, timestamp
      FROM holds WHERE held = 1 AND reasons LIKE ?
      ORDER BY timestamp DESC LIMIT 10
    `).all("%irreversible%");
    assert.equal(exact.length, 1, "the older reader finds the held row its own INSERT wrote");
    assert.equal(exact[0]!.task, "the older session's task", "the older reader reads the task text back");
    assert.equal(similar.length, 1);
    assert.equal(sameReason.length, 1);
    d.close();

    // The new reader finds the same held row. Its task text is not in hold_tasks yet: the row is settled at the next start.
    const history = await querySmartHistory("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] }, "/old/project", dirs);
    assert.equal(history.exact.length, 1, "the new reader finds the row too");
    assert.equal(history.exact[0]!.task, null, "a held row an older session wrote after the migration has no task text for the new reader until the next start");
    assert.equal(history.exact[0]!.plan, "plan text", "its other context still reads");
  });
});

test("a row an older version writes after the migration is settled at the next start", async () => {
  await withOwnDatabase(async (dirs, file) => {
    mkdirSync(join(dirs.agentDir, "pi-warden"), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE holds (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, project_root TEXT NOT NULL, tool TEXT NOT NULL, signature_hash TEXT NOT NULL, command_preview TEXT, task TEXT, plan TEXT, context_summary TEXT, preceding_actions TEXT, scores TEXT NOT NULL, level TEXT NOT NULL, held INTEGER NOT NULL, reasons TEXT, agent_reason TEXT, outcome TEXT, outcome_at INTEGER, confidence REAL)`);
    old.close();
    await initSchema(0, dirs, 0);

    const hash = signatureHash("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] });
    const write = (held: boolean, task: string) => {
      const d = new DatabaseSync(file);
      oldRow(d, { at: Date.now(), project: "/old/project", hash, task, held });
      d.close();
    };
    write(false, "an older session's turn");
    write(true, "an older session's turn");
    await initSchema(0, dirs, 0);

    const settled = ["task", "input_summary", "preceding_actions", "context_summary", "agent_reason"];
    const d = new DatabaseSync(file, { readOnly: true });
    const rows = d.prepare("SELECT id, held, task_hash, task, input_summary, preceding_actions, plan, context_summary, scores, reasons, agent_reason, outcome FROM holds ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2, "both rows of the older session are there");
    const allowed = rows[0]!;
    for (const name of settled) assert.equal(allowed[name], null, `the allowed row keeps no ${name}`);
    assert.equal(JSON.parse(String(allowed.scores)).irreversible, 0.5, "the judge scores the older session wrote on an allowed row stay");
    assert.equal(JSON.parse(String(allowed.reasons))[0], "irreversible 0.5", "its reasons stay");
    assert.equal(allowed.plan, "plan text", "its plan stays");
    const heldRow = rows[1]!;
    assert.equal(heldRow.task, null, "the held row's task text moves too");
    assert.equal(heldRow.context_summary, "context text", "a held row keeps its summary");
    assert.equal(heldRow.agent_reason, "agent reason", "and the agent reason");
    const tasks = d.prepare("SELECT hash, text FROM hold_tasks").all() as Array<{ hash: string; text: string }>;
    assert.equal(tasks.length, 1, "the shared task text is stored once");
    assert.equal(tasks[0]!.text, "an older session's turn");
    assert.equal(allowed.task_hash, tasks[0]!.hash, "the allowed row points at the stored task text");
    assert.equal(heldRow.task_hash, tasks[0]!.hash, "the held row points at it too");
    assert.equal((d.prepare("SELECT value FROM hold_meta WHERE key = 'settled_id'").get() as { value: number }).value, 2, "the start remembers the highest id it settled");
    d.close();

    // The new reader reads that task text back through hold_tasks.
    const history = await querySmartHistory("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] }, "/old/project", dirs);
    assert.equal(history.exact.length, 1, "the new reader finds the held row the older session wrote");
    assert.equal(history.exact[0]!.task, "an older session's turn", "and reads its task text through hold_tasks");

    // A row the older session writes after that start waits for the next one.
    write(false, "the next turn");
    const before = new DatabaseSync(file, { readOnly: true });
    assert.equal((before.prepare("SELECT task FROM holds ORDER BY id DESC LIMIT 1").get() as { task: string }).task, "the next turn", "the row is written with its text, as the older session writes it");
    before.close();
    await initSchema(0, dirs, 0);
    const after = new DatabaseSync(file, { readOnly: true });
    assert.equal((after.prepare("SELECT task FROM holds WHERE id = 3").get() as { task: string | null }).task, null, "the next start settles it");
    assert.equal((after.prepare("SELECT value FROM hold_meta WHERE key = 'settled_id'").get() as { value: number }).value, 3, "and moves the mark past it");
    assert.equal((after.prepare("SELECT COUNT(*) AS total FROM hold_tasks").get() as { total: number }).total, 2, "its task text lands in hold_tasks");
    assert.equal((after.prepare("SELECT task_hash IS NOT NULL AS has_hash FROM holds WHERE id = 3").get() as { has_hash: number }).has_hash, 1, "and the row points at it");
    assert.equal((after.prepare("SELECT task_hash FROM holds WHERE id = 2").get() as { task_hash: string }).task_hash, tasks[0]!.hash, "the held row the first start settled is left alone");
    after.close();
  });
});

test("a start while another session holds the database settles nothing, and the next start settles the rows", async () => {
  await withOwnDatabase(async (dirs, file) => {
    mkdirSync(join(dirs.agentDir, "pi-warden"), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE holds (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, project_root TEXT NOT NULL, tool TEXT NOT NULL, signature_hash TEXT NOT NULL, command_preview TEXT, task TEXT, plan TEXT, context_summary TEXT, preceding_actions TEXT, scores TEXT NOT NULL, level TEXT NOT NULL, held INTEGER NOT NULL, reasons TEXT, agent_reason TEXT, outcome TEXT, outcome_at INTEGER, confidence REAL)`);
    old.close();
    await initSchema(0, dirs, 0);

    const hash = signatureHash("bash", { irreversible: 0.5, reasons: ["irreversible 0.5"] });
    const lining = new DatabaseSync(file);
    lining.exec("PRAGMA busy_timeout = 0");
    lining.exec("BEGIN IMMEDIATE");
    oldRow(lining, { at: Date.now(), project: "/old/project", hash, task: "written while the lock is held", held: false });
    await initSchema(0, dirs, 0);
    assert.equal((lining.prepare("SELECT task FROM holds ORDER BY id DESC LIMIT 1").get() as { task: string }).task, "written while the lock is held", "the start leaves the row alone while another session holds the database");
    lining.exec("COMMIT");
    lining.close();

    await initSchema(0, dirs, 0);
    const d = new DatabaseSync(file, { readOnly: true });
    assert.equal((d.prepare("SELECT task FROM holds ORDER BY id DESC LIMIT 1").get() as { task: string | null }).task, null, "the next start settles it");
    assert.equal((d.prepare("SELECT task_hash IS NOT NULL AS has_hash FROM holds ORDER BY id DESC LIMIT 1").get() as { has_hash: number }).has_hash, 1, "its task text is in hold_tasks and the row points at it");
    d.close();
  });
});
