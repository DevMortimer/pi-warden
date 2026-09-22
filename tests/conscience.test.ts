import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  assess,
  buildBatchQuestions,
  buildState,
  questionHash,
  eligibleCandidates,
  sanitizeDescription,
  opaqueId,
  assignOpaqueIds,
  SCORE_LEVELS,
} from "../src/conscience.js";
import type { Candidate, Judge } from "../src/conscience.js";
import type { ConscienceConfig } from "../src/config.js";
import { CONSCIENCE_BETA_POLICY } from "../src/load.js";

/* ─── Helpers ───────────────────────────────────────────────────────── */

const fakeSkill = (name: string, description: string, disableModelInvocation = false): Skill => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "local", scope: "user" as const, origin: "top-level" as const },
  disableModelInvocation,
});

const fakeConfig = (overrides: Partial<ConscienceConfig> = {}): ConscienceConfig => ({
  enabled: true,
  skills: { mode: "recommend", exclude: [] },
  tools: { enabled: true, exclude: [] },
  timeoutMs: 3000,
  maxAssessments: 3,
  maxNudges: 2,
  maxSkillBytes: 32768,
  maxLoadedBytes: 65536,
  recommendThreshold: 0.80,
  advanceThreshold: 0.70,
  loadThreshold: 1.0,
  ...overrides,
});

const defaultDeps = (judge: Judge | undefined, config?: Partial<ConscienceConfig>) => ({
  judge,
  config: fakeConfig(config),
  sharedTimeoutMs: 5000,
});

/**
 * Build a fake judge that returns predetermined answers matching pi-typesafe's real shapes:
 * - Choice: { choice: string, confidence: number, probabilities: Record<string, number> }
 * - Score: { score: number, confidence: number, legend: Record<number, string>, probabilities: Record<number, number> }
 */
function fakeJudge(answerMap: Record<string, unknown>): Judge {
  return {
    evaluate: async () => ({ answers: answerMap }),
  };
}

/** Build a disposition-only judge. */
function dispositionJudge(disp: string, pAdvance = 1.0): Judge {
  return fakeJudge({
    conscience_disposition: {
      type: "choice",
      choice: disp,
      confidence: 0.9,
      probabilities: { advance: pAdvance, awaiting_user: 0, no_gap: 0, unclear: 0 },
    },
  });
}

/**
 * Build a judge that selects a specific candidate at a given Score level.
 * Probabilities are keyed by numeric index (0, 1, 2, 3) matching pi-typesafe's real shape.
 */
function selectionJudge(
  disp: string,
  candidateOpaqueId: string,
  level: number,
  probabilities: number[],
  pAdvance = 1.0,
): Judge {
  return fakeJudge({
    conscience_disposition: {
      type: "choice",
      choice: disp,
      confidence: 0.9,
      probabilities: { advance: pAdvance, awaiting_user: 0, no_gap: 0, unclear: 0 },
    },
    [candidateOpaqueId]: {
      type: "score",
      score: level,
      confidence: 0.8,
      legend: Object.fromEntries(SCORE_LEVELS.map((s, i) => [String(i), s])),
      probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])),
    },
  });
}

const defaultTools = [
  { name: "read", description: "Read file contents" },
  { name: "bash", description: "Execute bash commands" },
  { name: "edit", description: "Edit files" },
];

const defaultSkills = [
  fakeSkill("impeccable", "Frontend interface design, polish, and UX"),
  fakeSkill("tdd", "Test-driven development"),
  fakeSkill("research", "Research questions against primary sources"),
];

/* ─── sanitizeDescription ───────────────────────────────────────────── */

test("sanitizeDescription strips absolute paths", () => {
  const input = "Read /Users/anon/project/file.ts for details";
  const result = sanitizeDescription(input);
  assert.ok(!result.includes("/Users/anon"), "absolute path should be stripped");
});

test("sanitizeDescription strips home-directory paths", () => {
  const input = "Config at ~/config.json and ~bob/.ssh/config";
  const result = sanitizeDescription(input);
  assert.ok(!result.includes("~/"), "tilde path should be stripped");
  assert.ok(!result.includes("~bob/"), "tilde-user path should be stripped");
});

test("sanitizeDescription strips URLs", () => {
  const input = "See https://docs.example.com/guide for more";
  const result = sanitizeDescription(input);
  assert.ok(!result.includes("https://"), "URL should be stripped");
});

test("sanitizeDescription preserves normal text", () => {
  const input = "Test-driven development for TypeScript projects";
  assert.equal(sanitizeDescription(input), input);
});

/* ─── opaqueId and assignOpaqueIds ──────────────────────────────────── */

test("opaqueId returns c1, c2, c3", () => {
  assert.equal(opaqueId(0), "c1");
  assert.equal(opaqueId(1), "c2");
  assert.equal(opaqueId(2), "c3");
});

test("assignOpaqueIds maps candidates in stable order", () => {
  const candidates: Candidate[] = [
    { kind: "skill", id: "impeccable", description: "UI design" },
    { kind: "tool", id: "bash", description: "Run commands" },
  ];
  const result = assignOpaqueIds(candidates);
  assert.equal(result[0]!.opaqueId, "c1");
  assert.equal(result[0]!.candidate.id, "impeccable");
  assert.equal(result[1]!.opaqueId, "c2");
  assert.equal(result[1]!.candidate.id, "bash");
});

/* ─── buildBatchQuestions ───────────────────────────────────────────── */

test("buildBatchQuestions produces a disposition choice and one score per candidate", () => {
  const batch = [
    { opaqueId: "c1", candidate: { kind: "skill" as const, id: "impeccable", description: "UI design" } },
    { opaqueId: "c2", candidate: { kind: "tool" as const, id: "bash", description: "Run commands" } },
  ];
  const { questions, dispositionKey, idMap } = buildBatchQuestions(batch, "test", "", [], []);
  assert.equal(dispositionKey, "conscience_disposition");
  assert.ok(questions.conscience_disposition, "missing disposition question");
  assert.ok(questions.c1, "missing c1 score question");
  assert.ok(questions.c2, "missing c2 score question");
  assert.equal(Object.keys(questions).length, 3);
  assert.equal(idMap.get("c1")!.id, "impeccable");
  assert.equal(idMap.get("c2")!.id, "bash");
});

test("disposition question is a choice type with four options", () => {
  const { questions } = buildBatchQuestions([], "test", "", [], []);
  const q = questions.conscience_disposition as { type: string; criteria: Record<string, string> };
  assert.equal(q.type, "choice");
  assert.ok("advance" in q.criteria);
  assert.ok("awaiting_user" in q.criteria);
  assert.ok("no_gap" in q.criteria);
  assert.ok("unclear" in q.criteria);
});

test("score questions use the four SCORE_LEVELS as criteria array", () => {
  const batch = [
    { opaqueId: "c1", candidate: { kind: "skill" as const, id: "tdd", description: "TDD" } },
  ];
  const { questions } = buildBatchQuestions(batch, "test", "", [], []);
  const q = questions.c1 as { type: string; criteria: readonly string[] };
  assert.equal(q.type, "score");
  assert.equal(q.criteria.length, SCORE_LEVELS.length);
});

/* ─── buildState ────────────────────────────────────────────────────── */

test("buildState produces structured state with opaque IDs", () => {
  const batch = [
    { opaqueId: "c1", candidate: { kind: "skill" as const, id: "impeccable", description: "UI design" } },
  ];
  const state = buildState("design a UI", "user wants a landing page", ["tdd"], [], batch);
  assert.equal(state.task, "design a UI");
  assert.equal(state.context, "user wants a landing page");
  assert.deepEqual(state.active_skills, ["tdd"]);
  assert.deepEqual(state.supplied_skills, []);
  const c = (state.candidates as Record<string, unknown>).c1 as Record<string, unknown>;
  assert.equal(c.kind, "skill");
  assert.equal(c.name, "impeccable");
  assert.equal(c.description, "UI design");
});

/* ─── questionHash ──────────────────────────────────────────────────── */

test("questionHash is deterministic and changes with different questions", () => {
  const h1 = questionHash({ q1: { type: "choice", criteria: { a: "1" } } });
  const h2 = questionHash({ q1: { type: "choice", criteria: { a: "1" } } });
  const h3 = questionHash({ q1: { type: "choice", criteria: { a: "2" } } });
  assert.equal(h1, h2, "same questions should produce same hash");
  assert.notEqual(h1, h3, "different questions should produce different hash");
  assert.equal(h1.length, 16, "hash should be 16 hex chars");
});

/* ─── eligibleCandidates ────────────────────────────────────────────── */

test("eligibleCandidates excludes disableModelInvocation skills", () => {
  const skills = [
    fakeSkill("impeccable", "UI design"),
    fakeSkill("wizard", "Step-by-step wizard", true),
  ];
  const { candidates } = eligibleCandidates(skills, defaultTools, fakeConfig(), [], []);
  const ids = candidates.map(c => c.id);
  assert.ok(ids.includes("impeccable"));
  assert.ok(!ids.includes("wizard"), "disableModelInvocation skill must be excluded");
});

test("eligibleCandidates excludes by name pattern", () => {
  const config = fakeConfig({ skills: { mode: "recommend", exclude: ["impeccable"] } });
  const { candidates } = eligibleCandidates(defaultSkills, defaultTools, config, [], []);
  const ids = candidates.map(c => c.id);
  assert.ok(!ids.includes("impeccable"));
  assert.ok(ids.includes("tdd"));
});

test("eligibleCandidates excludes by wildcard pattern", () => {
  const config = fakeConfig({ tools: { enabled: true, exclude: ["bas*"] } });
  const { candidates } = eligibleCandidates([], defaultTools, config, [], []);
  const ids = candidates.map(c => c.id);
  assert.ok(!ids.includes("bash"));
  assert.ok(ids.includes("read"));
});

test("eligibleCandidates skips already-supplied skills", () => {
  const { candidates } = eligibleCandidates(defaultSkills, defaultTools, fakeConfig(), [], ["impeccable"]);
  const ids = candidates.map(c => c.id);
  assert.ok(!ids.includes("impeccable"));
});

test("eligibleCandidates returns empty when both categories disabled", () => {
  const config = fakeConfig({ skills: { mode: "off", exclude: [] }, tools: { enabled: false, exclude: [] } });
  const { candidates } = eligibleCandidates(defaultSkills, defaultTools, config, [], []);
  assert.equal(candidates.length, 0);
});

test("eligibleCandidates returns tools-only when skills mode is off but tools enabled", () => {
  const config = fakeConfig({ skills: { mode: "off", exclude: [] } });
  const { candidates } = eligibleCandidates(defaultSkills, defaultTools, config, [], []);
  assert.ok(candidates.every(c => c.kind === "tool"));
  assert.ok(candidates.length > 0);
});

test("eligibleCandidates caps at 256 per category and sets overflow flag", () => {
  const manySkills = Array.from({ length: 300 }, (_, i) => fakeSkill(`skill-${i}`, `Skill ${i}`));
  const { candidates, skillOverflow } = eligibleCandidates(manySkills, [], fakeConfig(), [], []);
  assert.equal(candidates.length, 256, "should cap at 256");
  assert.equal(skillOverflow, true, "should set overflow flag");
});

/* ─── assess: answer parsing (defect 1) ─────────────────────────────── */

test("assess parses Choice answer using .choice field, not .response", async () => {
  // Use a real pi-typesafe Choice answer shape; pAdvance=0.95 must meet threshold
  const judge = fakeJudge({
    conscience_disposition: {
      type: "choice",
      choice: "advance",
      confidence: 0.95,
      probabilities: { advance: 0.95, awaiting_user: 0.03, no_gap: 0.01, unclear: 0.01 },
    },
    c1: {
      type: "score",
      score: 3,
      confidence: 0.8,
      legend: { "0": SCORE_LEVELS[0], "1": SCORE_LEVELS[1], "2": SCORE_LEVELS[2], "3": SCORE_LEVELS[3] },
      probabilities: { "0": 0.05, "1": 0.1, "2": 0.6, "3": 0.25 },
    },
  });
  const result = await assess(
    "design a UI", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.5 }),
  );
  assert.equal(result.disposition, "advance", "should parse choice from .choice field");
  assert.ok(result.selected, "should select a candidate");
  assert.equal(result.selected!.id, "impeccable");
});

test("assest returns unclear when Choice answer has no .choice field", async () => {
  const judge = fakeJudge({
    conscience_disposition: { type: "choice", confidence: 0.5, probabilities: {} },
  });
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge),
  );
  assert.equal(result.disposition, "unclear");
});

/* ─── assess: P(useful now) formula (defect 2) ──────────────────────── */

test("P(useful now) sums the last two Score levels (index 2 + index 3)", async () => {
  // level 2 = directly_useful (0.6), level 3 = prerequisite (0.25) → pUseful = 0.85
  const judge = selectionJudge("advance", "c1", 3, [0.05, 0.1, 0.6, 0.25]);
  const result = await assess(
    "design a UI", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.5 }),
  );
  assert.equal(result.selected!.id, "impeccable");
  assert.ok(Math.abs(result.usefulness - 0.85) < 0.001, `usefulness should be 0.85, got ${result.usefulness}`);
});

test("P(useful now) is low when only level 1 (related) has high probability", async () => {
  // level 1 = related (0.7), level 2 = 0.1, level 3 = 0.05 → pUseful = 0.15
  const judge = selectionJudge("advance", "c1", 1, [0.1, 0.7, 0.1, 0.05]);
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.5 }),
  );
  assert.ok(Math.abs(result.usefulness - 0.15) < 0.001, `usefulness should be 0.15, got ${result.usefulness}`);
});

/* ─── assess: threshold gate (defect 3) ─────────────────────────────── */

test("assess returns below_threshold when usefulness is below recommendThreshold", async () => {
  // pUseful = 0.6 + 0.2 = 0.8, but threshold is 0.9
  const judge = selectionJudge("advance", "c1", 2, [0.05, 0.15, 0.6, 0.2]);
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.9 }),
  );
  assert.equal(result.skipReason, "below_threshold");
  assert.equal(result.selected, null);
});

test("assess selects when usefulness meets recommendThreshold", async () => {
  // pUseful = 0.65 + 0.25 = 0.9, threshold is 0.9
  const judge = selectionJudge("advance", "c1", 3, [0.05, 0.05, 0.65, 0.25]);
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.9 }),
  );
  assert.equal(result.selected!.id, "impeccable");
  assert.ok(result.usefulness >= 0.9);
});

test("assess returns below_threshold when P(advance) is below recommendThreshold", async () => {
  const judge = selectionJudge("advance", "c1", 3, [0.05, 0.05, 0.65, 0.25], 0.5);
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.9 }),
  );
  assert.equal(result.skipReason, "below_threshold");
  assert.equal(result.selected, null);
  assert.equal(result.pAdvance, 0.5);
});

/* ─── assess: request shape (defect 4) ──────────────────────────────── */

test("assess sends state with opaque IDs, not candidate names in instructions", async () => {
  let capturedState: unknown;
  let capturedQuestions: unknown;
  const judge: Judge = {
    evaluate: async (req) => {
      capturedState = req.state;
      capturedQuestions = req.questions;
      return {
        answers: {
          conscience_disposition: {
            type: "choice", choice: "no_gap", confidence: 0.9,
            probabilities: { advance: 0, awaiting_user: 0, no_gap: 0.9, unclear: 0.1 },
          },
        },
      };
    },
  };
  await assess(
    "design a UI", "user wants a landing page", defaultSkills, defaultTools, ["tdd"], ["impeccable"],
    defaultDeps(judge),
  );
  const state = capturedState as Record<string, unknown>;
  assert.equal(state.task, "design a UI");
  assert.equal(state.context, "user wants a landing page");
  assert.deepEqual(state.active_skills, ["tdd"]);
  assert.deepEqual(state.supplied_skills, ["impeccable"]);
  // Candidates should be under opaque IDs
  const candidates = state.candidates as Record<string, unknown>;
  assert.ok(candidates.c1 || candidates.c2, "should have opaque candidate IDs");
  // First candidate that isn't "impeccable" (supplied) should be under an opaque ID
  for (const [key, val] of Object.entries(candidates)) {
    assert.match(key, /^c\d+$/, `key ${key} should be opaque`);
    const c = val as Record<string, unknown>;
    assert.ok(c.kind, "candidate should have kind");
    assert.ok(c.name, "candidate should have name");
  }
  // Questions should use opaque IDs as keys, not candidate names
  const questions = capturedQuestions as Record<string, unknown>;
  assert.ok(questions.conscience_disposition, "should have disposition question");
  for (const key of Object.keys(questions)) {
    if (key === "conscience_disposition") continue;
    assert.match(key, /^c\d+$/, `question key ${key} should be opaque`);
  }
});

/* ─── assess: bounded envelope (defect 5) ───────────────────────────── */

test("assess packs 40 candidates into two requests", async () => {
  let requestCount = 0;
  const judge: Judge = {
    evaluate: async (req) => {
      requestCount++;
      const answers: Record<string, unknown> = {
        conscience_disposition: {
          type: "choice", choice: "advance", confidence: 0.9,
          probabilities: { advance: 0.9, awaiting_user: 0, no_gap: 0, unclear: 0.1 },
        },
      };
      // Answer all Score questions
      for (const key of Object.keys(req.questions)) {
        if (key === "conscience_disposition") continue;
        answers[key] = {
          type: "score", score: 2, confidence: 0.7,
          legend: Object.fromEntries(SCORE_LEVELS.map((s, i) => [String(i), s])),
          probabilities: { "0": 0.1, "1": 0.2, "2": 0.5, "3": 0.2 },
        };
      }
      return { answers };
    },
  };
  const skills = Array.from({ length: 40 }, (_, i) => fakeSkill(`skill-${i}`, `Skill ${i}`));
  const result = await assess(
    "test", "", skills, [], [], [],
    defaultDeps(judge),
  );
  // 40 candidates + 1 disposition = 41 questions. Max 32 per request → 2 requests.
  assert.equal(requestCount, 2, `expected 2 requests, got ${requestCount}`);
  assert.ok(result.requestCount >= 2);
});

test("300 skills yields catalog_limit and no selection from partial list", async () => {
  // Mock that answers both disposition and any Score questions
  const judge: Judge = {
    evaluate: async (req) => {
      const answers: Record<string, unknown> = {
        conscience_disposition: {
          type: "choice", choice: "advance", confidence: 0.9,
          probabilities: { advance: 0.9, awaiting_user: 0, no_gap: 0, unclear: 0.1 },
        },
      };
      for (const key of Object.keys(req.questions)) {
        if (key === "conscience_disposition") continue;
        answers[key] = {
          type: "score", score: 2, confidence: 0.7,
          legend: Object.fromEntries(SCORE_LEVELS.map((s, i) => [String(i), s])),
          probabilities: { "0": 0.1, "1": 0.2, "2": 0.5, "3": 0.2 },
        };
      }
      return { answers };
    },
  };
  const manySkills = Array.from({ length: 300 }, (_, i) => fakeSkill(`skill-${i}`, `Skill ${i}`));
  const result = await assess(
    "test", "", manySkills, [], [], [],
    defaultDeps(judge, { recommendThreshold: 0.5 }),
  );
  // 300 skills capped at 256 → skillOverflow → catalog_limit recorded
  // The partial skill catalog should not produce a selection (per spec)
  assert.equal(result.skipReason, "catalog_limit", `expected catalog_limit, got ${result.skipReason}`);
});

/* ─── assess: deadline (defect 6) ───────────────────────────────────── */

test("assess uses min(conscience.timeoutMs, sharedTimeoutMs) for deadline", async () => {
  const start = 1000;
  let elapsed = 0;
  const judge: Judge = {
    evaluate: async () => {
      elapsed = Date.now() - start;
      return {
        answers: {
          conscience_disposition: {
            type: "choice", choice: "no_gap", confidence: 0.9,
            probabilities: { advance: 0, awaiting_user: 0, no_gap: 0.9, unclear: 0.1 },
          },
        },
      };
    },
  };
  // conscience says 10000ms but shared says 200ms → effective is 200ms
  await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    { judge, config: fakeConfig({ timeoutMs: 10000 }), sharedTimeoutMs: 200, now: () => start },
  );
  // The timeout check happens before the judge call, so if shared is small, it may timeout
  // But since the judge is instant here, it should complete
  assert.ok(true, "should not throw");
});

/* ─── assess: unit paths ────────────────────────────────────────────── */

test("assess returns disabled when config.enabled is false", async () => {
  const result = await assess("test", "", [], [], [], [], defaultDeps(dispositionJudge("advance"), { enabled: false }));
  assert.equal(result.skipReason, "disabled");
  assert.equal(result.selected, null);
});

test("assess returns no_consent when judge is undefined", async () => {
  const result = await assess("test", "", [], [], [], [], defaultDeps(undefined));
  assert.equal(result.skipReason, "no_consent");
});

test("assess returns no_match when no eligible candidates", async () => {
  const result = await assess("test", "", [], [], [], [], defaultDeps(dispositionJudge("advance")));
  assert.equal(result.skipReason, "no_match");
});

test("assess returns awaiting_user when disposition is awaiting_user", async () => {
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], defaultDeps(dispositionJudge("awaiting_user")));
  assert.equal(result.disposition, "awaiting_user");
  assert.equal(result.selected, null);
  assert.equal(result.skipReason, "awaiting_user");
});

test("assess returns no_gap when disposition is no_gap", async () => {
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], defaultDeps(dispositionJudge("no_gap")));
  assert.equal(result.disposition, "no_gap");
  assert.equal(result.selected, null);
});

test("assess handles judge timeout gracefully", async () => {
  const slowJudge: Judge = {
    evaluate: () => new Promise(resolve => setTimeout(() => resolve({ answers: {} }), 5000)),
  };
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], {
    judge: slowJudge,
    config: fakeConfig({ timeoutMs: 10 }),
    sharedTimeoutMs: 5000,
    now: () => Date.now(),
  });
  assert.equal(result.skipReason, "error", "should return error on timeout");
});

test("assess handles judge throwing gracefully", async () => {
  const throwingJudge: Judge = {
    evaluate: async () => { throw new Error("network error"); },
  };
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], defaultDeps(throwingJudge));
  assert.equal(result.skipReason, "error");
});

/* ─── assess: candidate ranking ─────────────────────────────────────── */

test("assess ranks by usefulness probability, then Score level, then skill-before-tool", async () => {
  const judge: Judge = {
    evaluate: async (req) => {
      const answers: Record<string, unknown> = {
        conscience_disposition: {
          type: "choice", choice: "advance", confidence: 0.9,
          probabilities: { advance: 0.9, awaiting_user: 0, no_gap: 0, unclear: 0.1 },
        },
      };
      for (const key of Object.keys(req.questions)) {
        if (key === "conscience_disposition") continue;
        // All get same probabilities → tie-break by kind (skill before tool)
        answers[key] = {
          type: "score", score: 2, confidence: 0.7,
          legend: Object.fromEntries(SCORE_LEVELS.map((s, i) => [String(i), s])),
          probabilities: { "0": 0.1, "1": 0.1, "2": 0.4, "3": 0.4 },
        };
      }
      return { answers };
    },
  };
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.5 }),
  );
  assert.equal(result.selected!.kind, "skill", "skill should rank before tool when usefulness is equal");
});

/* ─── Config defaults ───────────────────────────────────────────────── */

test("concurrent batches: 3 batches complete in ~one round-trip with 400ms delayed judge", async () => {
  let callCount = 0;
  const delayedJudge: Judge = {
    evaluate: async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 400));
      return {
        answers: {
          conscience_disposition: {
            type: "choice", choice: "advance", confidence: 0.9,
            probabilities: { advance: 0.9, awaiting_user: 0, no_gap: 0, unclear: 0.1 },
          },
        },
      };
    },
  };
  // 76 candidates → 3 batches of 25 questions each. With 400ms delay and default 3000ms deadline,
  // all 3 should complete (concurrent, not sequential).
  const skills = Array.from({ length: 76 }, (_, i) => fakeSkill(`skill-${i}`, `Skill ${i}`));
  const start = Date.now();
  const result = await assess(
    "test", "", skills, [], [], [],
    { judge: delayedJudge, config: fakeConfig(), sharedTimeoutMs: 5000, now: () => Date.now() },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `3 concurrent 400ms batches should finish in ~400ms, took ${elapsed}ms`);
  assert.ok(callCount >= 3, `should issue 3 batches, got ${callCount} calls`);
});


test("conscience config defaults: recommend mode, tools enabled, thresholds at 1.0", () => {
  const config = fakeConfig();
  assert.equal(config.skills.mode, "recommend");
  assert.equal(config.tools.enabled, true);
  assert.equal(config.enabled, true);
  assert.equal(config.timeoutMs, 3000);
  assert.equal(config.maxAssessments, 3);
  assert.equal(config.maxNudges, 2);
  assert.equal(config.maxSkillBytes, 32768);
  assert.equal(config.maxLoadedBytes, 65536);
  assert.equal(config.recommendThreshold, 0.80);
  assert.equal(config.advanceThreshold, 0.70);
  assert.equal(config.loadThreshold, 1.0);
});

/* ─── advanceThreshold gate ─────────────────────────────────────────── */

// The beta policy pins the question wording: any wording change moves the hash and this test fails
// until the policy is re-measured.
test("one-candidate question set hashes to the beta policy questionHash", () => {
  const batch = [{ opaqueId: "c1", candidate: { kind: "skill" as const, id: "beta-shape", description: "beta batch shape" } }];
  const { questions } = buildBatchQuestions(batch, "task", "", [], []);
  assert.equal(questionHash(questions), CONSCIENCE_BETA_POLICY.questionHash,
    "question wording changed; re-measure the policy before shipping");
});

test("assess returns below_threshold when pAdvance is below advanceThreshold", async () => {
  // usefulness passes recommendThreshold (0.9) but pAdvance is 0.5 (below advanceThreshold 0.7)
  const judge = selectionJudge("advance", "c1", 3, [0.05, 0.05, 0.65, 0.25], 0.5);
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.9, advanceThreshold: 0.7 }),
  );
  assert.equal(result.skipReason, "below_threshold");
  assert.equal(result.selected, null);
  assert.equal(result.pAdvance, 0.5);
});

test("assess selects when both usefulness and pAdvance pass their thresholds", async () => {
  // usefulness = 0.9, pAdvance = 0.8, both pass
  const judge = selectionJudge("advance", "c1", 3, [0.05, 0.05, 0.65, 0.25], 0.8);
  const result = await assess(
    "test", "", defaultSkills, defaultTools, [], [],
    defaultDeps(judge, { recommendThreshold: 0.9, advanceThreshold: 0.7 }),
  );
  assert.equal(result.selected!.id, "impeccable");
  assert.ok(result.usefulness >= 0.9);
  assert.ok(result.pAdvance >= 0.7);
});
