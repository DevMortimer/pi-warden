import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolRecommendationQuestions } from "../src/tool-recommendation.js";

const tool = (name: string, description: string) => ({ name, description });
const skill = (name: string, description: string, disableModelInvocation = false) => ({
  name, description, disableModelInvocation,
  filePath: "", baseDir: "",
  sourceInfo: { path: "", source: "", scope: "user" as const, origin: "top-level" as const },
});

test("returns both tool_recommendation_yes and tool_recommendation_choice", () => {
  const q = buildToolRecommendationQuestions([], [], "bash");
  assert.ok(q.tool_recommendation_yes, "missing tool_recommendation_yes");
  assert.ok(q.tool_recommendation_choice, "missing tool_recommendation_choice");
});

test("yes question is noul type with true/false labels", () => {
  const q = buildToolRecommendationQuestions([], [], "bash");
  const yes = q.tool_recommendation_yes as { type: string; criteria: { true?: string; false?: string } };
  assert.equal(yes.type, "noul");
  assert.ok(yes.criteria.true!.startsWith("Yes:"), "true label should start with Yes:");
  assert.ok(yes.criteria.false!.startsWith("No:"), "false label should start with No:");
});

test("choice question is choice type with 'current' option", () => {
  const q = buildToolRecommendationQuestions([], [], "bash");
  const ch = q.tool_recommendation_choice as { type: string; criteria: Record<string, string> };
  assert.equal(ch.type, "choice");
  assert.ok("current" in ch.criteria, "should have 'current' option");
  assert.ok(ch.criteria["current"].includes("bash"), "current option should name the tool");
});

test("tools appear with tool: prefix in choice criteria", () => {
  const tools = [tool("read", "Read files"), tool("bash", "Run commands")];
  const q = buildToolRecommendationQuestions(tools, [], "grep");
  const ch = q.tool_recommendation_choice as { type: string; criteria: Record<string, string> };
  assert.ok("tool:read" in ch.criteria);
  assert.ok("tool:bash" in ch.criteria);
  assert.equal(ch.criteria["tool:read"], "Read files");
});

test("skills appear with skill: prefix in choice criteria", () => {
  const skills = [skill("tdd", "Test-driven development")];
  const q = buildToolRecommendationQuestions([], skills, "bash");
  const ch = q.tool_recommendation_choice as { type: string; criteria: Record<string, string> };
  assert.ok("skill:tdd" in ch.criteria);
  assert.equal(ch.criteria["skill:tdd"], "Test-driven development");
});

test("disableModelInvocation appends (user-invoked only)", () => {
  const skills = [skill("wizard", "Step-by-step wizard", true)];
  const q = buildToolRecommendationQuestions([], skills, "bash");
  const ch = q.tool_recommendation_choice as { type: string; criteria: Record<string, string> };
  assert.ok(ch.criteria["skill:wizard"]!.includes("(user-invoked only)"));
});

test("long descriptions are truncated to 120 chars", () => {
  const longDesc = "a".repeat(200);
  const tools = [tool("big", longDesc)];
  const q = buildToolRecommendationQuestions(tools, [], "bash");
  const ch = q.tool_recommendation_choice as { type: string; criteria: Record<string, string> };
  assert.equal(ch.criteria["tool:big"]!.length, 120);
  assert.ok(ch.criteria["tool:big"]!.endsWith("..."));
});

test("short descriptions are not truncated", () => {
  const tools = [tool("short", "tiny")];
  const q = buildToolRecommendationQuestions(tools, [], "bash");
  const ch = q.tool_recommendation_choice as { type: string; criteria: Record<string, string> };
  assert.equal(ch.criteria["tool:short"], "tiny");
});

test("empty tools and skills arrays produce only the current option", () => {
  const q = buildToolRecommendationQuestions([], [], "bash");
  const ch = q.tool_recommendation_choice as { type: string; criteria: Record<string, string> };
  const keys = Object.keys(ch.criteria);
  assert.deepEqual(keys, ["current"]);
});
