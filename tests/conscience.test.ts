import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  assess,
  buildAssessmentQuestions,
  questionHash,
  eligibleCandidates,
  SCORE_LEVELS,
} from "../src/conscience.js";
import type { Candidate, Judge } from "../src/conscience.js";
import type { ConscienceConfig } from "../src/config.js";

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
  timeoutMs: 1500,
  maxAssessments: 3,
  maxNudges: 2,
  maxSkillBytes: 32768,
  maxLoadedBytes: 65536,
  ...overrides,
});

/** Build a fake judge that returns predetermined answers for every question. */
function fakeJudge(answers: Record<string, unknown>): Judge {
  return {
    evaluate: async () => ({ answers }),
  };
}

/** Build a disposition-only fake judge (no candidate answers). */
function dispositionJudge(disp: string): Judge {
  return fakeJudge({ conscience_disposition: { response: disp } });
}

/** Build a fake judge that selects a specific candidate at a given score level. */
function selectionJudge(
  disp: string,
  candidateKey: string,
  level: string,
  probabilities: Record<string, number>,
): Judge {
  return fakeJudge({
    conscience_disposition: { response: disp },
    [candidateKey]: { response: level, probabilities },
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

/* ─── buildAssessmentQuestions ──────────────────────────────────────── */

test("buildAssessmentQuestions produces a disposition question and one score per candidate", () => {
  const candidates: Candidate[] = [
    { kind: "skill", id: "impeccable", description: "Frontend design", userOnly: false },
    { kind: "tool", id: "bash", description: "Run commands", userOnly: false },
  ];
  const { questions, dispositionKey } = buildAssessmentQuestions(
    candidates, "design a UI", "user wants a landing page", [], [],
  );
  assert.equal(dispositionKey, "conscience_disposition");
  assert.ok(questions.conscience_disposition, "missing disposition question");
  assert.ok(questions.conscience_skill_impeccable, "missing skill score question");
  assert.ok(questions.conscience_tool_bash, "missing tool score question");
  const keys = Object.keys(questions);
  assert.equal(keys.length, 3, `expected 3 questions, got ${keys.length}: ${keys.join(", ")}`);
});

test("disposition question is a choice type with four options", () => {
  const { questions } = buildAssessmentQuestions([], "test", "", [], []);
  const q = questions.conscience_disposition as { type: string; criteria: Record<string, string> };
  assert.equal(q.type, "choice");
  assert.ok("advance" in q.criteria);
  assert.ok("awaiting_user" in q.criteria);
  assert.ok("no_gap" in q.criteria);
  assert.ok("unclear" in q.criteria);
});

test("score questions use the four SCORE_LEVELS", () => {
  const candidates: Candidate[] = [
    { kind: "skill", id: "tdd", description: "TDD", userOnly: false },
  ];
  const { questions } = buildAssessmentQuestions(candidates, "test", "", [], []);
  const q = questions.conscience_skill_tdd as { type: string; criteria: readonly string[] };
  assert.equal(q.type, "score");
  assert.equal(q.criteria.length, SCORE_LEVELS.length, `expected ${SCORE_LEVELS.length} criteria, got ${q.criteria.length}`);
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
  const result = eligibleCandidates(skills, defaultTools, fakeConfig(), [], []);
  const ids = result.map(c => c.id);
  assert.ok(ids.includes("impeccable"));
  assert.ok(!ids.includes("wizard"), "disableModelInvocation skill must be excluded");
});

test("eligibleCandidates excludes by name pattern", () => {
  const config = fakeConfig({ skills: { mode: "recommend", exclude: ["impeccable"] } });
  const result = eligibleCandidates(defaultSkills, defaultTools, config, [], []);
  const ids = result.map(c => c.id);
  assert.ok(!ids.includes("impeccable"));
  assert.ok(ids.includes("tdd"));
});

test("eligibleCandidates excludes by wildcard pattern", () => {
  const config = fakeConfig({ tools: { enabled: true, exclude: ["bas*"] } });
  const result = eligibleCandidates([], defaultTools, config, [], []);
  const ids = result.map(c => c.id);
  assert.ok(!ids.includes("bash"));
  assert.ok(ids.includes("read"));
});

test("eligibleCandidates skips already-supplied skills", () => {
  const result = eligibleCandidates(defaultSkills, defaultTools, fakeConfig(), [], ["impeccable"]);
  const ids = result.map(c => c.id);
  assert.ok(!ids.includes("impeccable"));
});

test("eligibleCandidates returns empty when skills mode is off and tools disabled", () => {
  const config = fakeConfig({ skills: { mode: "off", exclude: [] }, tools: { enabled: false, exclude: [] } });
  const result = eligibleCandidates(defaultSkills, defaultTools, config, [], []);
  assert.equal(result.length, 0, "should have no candidates when both categories disabled");
});

test("eligibleCandidates returns tools-only when skills mode is off but tools enabled", () => {
  const config = fakeConfig({ skills: { mode: "off", exclude: [] } });
  const result = eligibleCandidates(defaultSkills, defaultTools, config, [], []);
  assert.ok(result.every(c => c.kind === "tool"), "all candidates should be tools");
  assert.ok(result.length > 0, "should have tool candidates");
});

/* ─── assess (unit) ─────────────────────────────────────────────────── */

test("assess returns disabled when config.enabled is false", async () => {
  const result = await assess("test", "", [], [], [], [], {
    judge: dispositionJudge("advance"),
    config: fakeConfig({ enabled: false }),
  });
  assert.equal(result.skipReason, "disabled");
  assert.equal(result.selected, null);
});

test("assess returns no_consent when judge is undefined", async () => {
  const result = await assess("test", "", [], [], [], [], {
    judge: undefined,
    config: fakeConfig(),
  });
  assert.equal(result.skipReason, "no_consent");
});

test("assess returns no_match when no eligible candidates", async () => {
  const result = await assess("test", "", [], [], [], [], {
    judge: dispositionJudge("advance"),
    config: fakeConfig(),
  });
  assert.equal(result.skipReason, "no_match");
});

test("assess returns awaiting_user when disposition is awaiting_user", async () => {
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], {
    judge: dispositionJudge("awaiting_user"),
    config: fakeConfig(),
  });
  assert.equal(result.disposition, "awaiting_user");
  assert.equal(result.selected, null);
  assert.equal(result.skipReason, "awaiting_user");
});

test("assess returns no_gap when disposition is no_gap", async () => {
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], {
    judge: dispositionJudge("no_gap"),
    config: fakeConfig(),
  });
  assert.equal(result.disposition, "no_gap");
  assert.equal(result.selected, null);
});

test("assess selects the candidate with highest usefulness when disposition is advance", async () => {
  const result = await assess("design a UI", "", defaultSkills, defaultTools, [], [], {
    judge: selectionJudge(
      "advance",
      "conscience_skill_impeccable",
      "directly_useful",
      { not_useful: 0.05, related: 0.15, directly_useful: 0.65, prerequisite: 0.15 },
    ),
    config: fakeConfig(),
  });
  assert.equal(result.disposition, "advance");
  assert.ok(result.selected, "should have selected a candidate");
  assert.equal(result.selected!.id, "impeccable");
  assert.equal(result.selected!.kind, "skill");
  assert.ok(result.usefulness > 0.5, `usefulness should be > 0.5, got ${result.usefulness}`);
});

test("assess ranks skill before tool when usefulness is equal", async () => {
  const judge = {
    evaluate: async (req: { questions: Record<string, unknown> }) => {
      const answers: Record<string, unknown> = {
        conscience_disposition: { response: "advance" },
      };
      // Give all candidates the same scores
      for (const key of Object.keys(req.questions)) {
        if (key !== "conscience_disposition") {
          answers[key] = {
            response: "related",
            probabilities: { not_useful: 0.1, related: 0.3, directly_useful: 0.3, prerequisite: 0.3 },
          };
        }
      }
      return { answers };
    },
  };
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], {
    judge,
    config: fakeConfig(),
  });
  assert.equal(result.disposition, "advance");
  assert.ok(result.selected, "should have selected a candidate");
  assert.equal(result.selected!.kind, "skill", "skill should rank before tool when usefulness is equal");
});

test("assess handles judge timeout gracefully", async () => {
  const slowJudge: Judge = {
    evaluate: () => new Promise(resolve => setTimeout(() => resolve({ answers: {} }), 5000)),
  };
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], {
    judge: slowJudge,
    config: fakeConfig({ timeoutMs: 10 }),
    now: () => Date.now(),
  });
  assert.equal(result.skipReason, "error", "should return error on timeout");
});

test("assess handles judge throwing gracefully", async () => {
  const throwingJudge: Judge = {
    evaluate: async () => { throw new Error("network error"); },
  };
  const result = await assess("test", "", defaultSkills, defaultTools, [], [], {
    judge: throwingJudge,
    config: fakeConfig(),
  });
  assert.equal(result.skipReason, "error");
});

/* ─── Legacy migration (config-level) ───────────────────────────────── */

test("conscience config defaults: recommend mode, tools enabled, no excludes", () => {
  const config = fakeConfig();
  assert.equal(config.skills.mode, "recommend");
  assert.equal(config.tools.enabled, true);
  assert.deepEqual(config.skills.exclude, []);
  assert.deepEqual(config.tools.exclude, []);
  assert.equal(config.enabled, true);
  assert.equal(config.timeoutMs, 1500);
  assert.equal(config.maxAssessments, 3);
  assert.equal(config.maxNudges, 2);
  assert.equal(config.maxSkillBytes, 32768);
  assert.equal(config.maxLoadedBytes, 65536);
});
