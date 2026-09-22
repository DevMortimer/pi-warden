import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { authorize, aggregateLevel, escalateBlastRadius, escalateRulesViolation, isAuthEligible, isNegated, parseViolationJudgments, patternHitsToViolations, removeAuthorized, scopeMatches } from "../src/guard.js";
import type { Authorization, EscalatedViolation, Violation } from "../src/guard.js";
import { checkPiWardenMissing, extractRules, resolveRulesFile } from "../src/rules-file.js";
import { defaultConfig } from "../src/config.js";
import type { RulesConfig } from "../src/config.js";
import { buildInitPrompt, buildProjectContext, detectProjectType, generateStarterRules, writeStarterRules } from "../src/init.js";

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-warden-violation-"));
});
after(async () => { await rm(cwd, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Authorization: deterministic per-violation analysis.

test("authorize: force-push requires explicit 'force push' or 'force-push' in the prompt", () => {
  const violation: Violation = {
    id: "git-force-push", severity: "destructive", source: "pattern", description: "git force push",
    patternFamily: "git-force-push",
    scope: { command: "git push --force origin main", tool: "bash" },
  };
  // "push my branch" does NOT authorize force-push — user said push, not force push
  assert.equal(authorize("push my branch", violation).authorized, false);
  assert.equal(authorize("push my branch", violation).actionMatched, false);
  // "force push my branch" authorizes force-push
  assert.equal(authorize("force push my branch", violation).authorized, true);
  assert.equal(authorize("force push my branch", violation).actionMatched, true);
  // "force-push" hyphenated form also works
  assert.equal(authorize("force-push origin main", violation).authorized, true);
});

test("authorize: negation in the prompt prevents authorization", () => {
  const violation: Violation = {
    id: "git-force-push", severity: "destructive", source: "pattern", description: "git force push",
    patternFamily: "git-force-push",
    scope: { command: "git push --force origin main", tool: "bash" },
  };
  // Negation prevents authorization when the action verb is present
  assert.equal(authorize("don't force push", violation).authorized, false);
  assert.equal(authorize("don't force push", violation).negated, true);
  assert.equal(authorize("never force push", violation).negated, true);
  assert.equal(authorize("do not force-push", violation).negated, true);
  // "push" alone does not match the force-push verb family, so no authorization attempted
  assert.equal(authorize("don't push", violation).authorized, false);
  assert.equal(authorize("don't push", violation).actionMatched, false);
});

test("authorize: scope mismatch prevents authorization even when action matches", () => {
  const violation: Violation = {
    id: "rm-rf", severity: "destructive", source: "pattern", description: "rm -rf",
    patternFamily: "rm-rf",
    scope: { paths: ["eval/reports/"], tool: "bash" },
  };
  // "delete tmp.txt" does not match the scope of "eval/reports/"
  assert.equal(authorize("delete tmp.txt", violation).authorized, false);
  assert.equal(authorize("delete tmp.txt", violation).scopeMatched, false);
  // "delete eval/reports" matches via path
  assert.equal(authorize("delete eval/reports", violation).authorized, true);
  assert.equal(authorize("delete eval/reports", violation).scopeMatched, true);
});

test("authorize: hard-deny violations are not authorization-eligible", () => {
  const denyViolation: Violation = {
    id: "never-talos-reset", severity: "deny", source: "pattern", description: "blocked",
  };
  assert.equal(authorize("reset talos", denyViolation).authorized, false);
  assert.equal(authorize("reset talos", denyViolation).actionMatched, false);
});

test("authorize: sensitive-path violations are not authorization-eligible", () => {
  const sensitiveViolation: Violation = {
    id: "sensitive-path", severity: "sensitive", source: "pattern", description: "touches secrets",
  };
  assert.equal(authorize("read the env", sensitiveViolation).authorized, false);
});

// ---------------------------------------------------------------------------
// Scope matching.

test("scopeMatches: exact path match", () => {
  assert.equal(scopeMatches("delete eval/reports/", { paths: ["eval/reports/"] }), true);
  assert.equal(scopeMatches("delete something else", { paths: ["eval/reports/"] }), false);
});

test("scopeMatches: directory path with or without trailing slash", () => {
  assert.equal(scopeMatches("delete eval/reports", { paths: ["eval/reports/"] }), true, "trailing slash in path, omitted in prompt");
  assert.equal(scopeMatches("delete eval/reports/", { paths: ["eval/reports/"] }), true, "exact path");
  assert.equal(scopeMatches("delete reports", { paths: ["eval/reports/"] }), false, "generic word does not authorize specific path");
  assert.equal(scopeMatches("clean up reports directory", { paths: ["eval/reports/"] }), false, "generic word in context does not authorize");
});

test("scopeMatches: no scope always matches", () => {
  assert.equal(scopeMatches("do anything", {}), true);
  assert.equal(scopeMatches("do anything", { paths: undefined }), true);
});

// ---------------------------------------------------------------------------
// Violation eligibility.

test("isAuthEligible: risky and destructive are eligible; deny and sensitive are not", () => {
  assert.equal(isAuthEligible("risky"), true);
  assert.equal(isAuthEligible("destructive"), true);
  assert.equal(isAuthEligible("deny"), false);
  assert.equal(isAuthEligible("sensitive"), false);
});

// ---------------------------------------------------------------------------
// patternHitsToViolations: convert PatternHit[] to Violation[].

test("patternHitsToViolations: converts rm hits to per-target violations and skips non-rm bash", () => {
  const hits = [
    { id: "rm-rf", severity: "risky" as const, label: "rm -rf" },
    { id: "git-force-push", severity: "destructive" as const, label: "git force push" },
  ];
  const violations = patternHitsToViolations(hits, "bash", { command: "rm -rf /tmp/x" });
  assert.equal(violations.length, 1, "non-rm bash violations are skipped");
  assert.equal(violations[0]!.id, "rm-rf");
  assert.ok(violations[0]!.scope?.paths?.length, "rm violation has per-target path scope");
});

test("patternHitsToViolations: rm targets stop at shell operators", () => {
  const hits = [{ id: "rm-rf", severity: "risky" as const, label: "rm -rf" }];
  const violations = patternHitsToViolations(hits, "bash", {
    command: "rm -rf /tmp/build && npm run build && npm test && echo done",
  });
  assert.equal(violations.length, 1, "only the rm segment yields a target");
  assert.deepEqual(violations[0]!.scope?.paths, ["/tmp/build"]);
});

test("patternHitsToViolations: a multi-target rm keeps one violation per real target", () => {
  const hits = [{ id: "rm-rf", severity: "risky" as const, label: "rm -rf" }];
  const violations = patternHitsToViolations(hits, "bash", { command: "rm -rf a b c" });
  assert.deepEqual(violations.map(violation => violation.scope?.paths?.[0]), ["a", "b", "c"]);
});

test("patternHitsToViolations: every rm segment contributes its own targets", () => {
  const hits = [{ id: "rm-rf", severity: "risky" as const, label: "rm -rf" }];
  const violations = patternHitsToViolations(hits, "bash", { command: "rm -rf a; rm -rf b c" });
  assert.deepEqual(violations.map(violation => violation.scope?.paths?.[0]), ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// Escalation A: blast-radius.

test("escalateBlastRadius: authorized violation keeps original severity", () => {
  const violation: Violation = {
    id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf",
  };
  const authorized: Authorization = { authorized: true, actionMatched: true, scopeMatched: true, negated: false };
  assert.equal(escalateBlastRadius(violation, authorized, { violated: true, confidence: 0.95 }, { escalationThreshold: 0.85 }), "risky");
});

test("escalateBlastRadius: unconfirmed violation keeps original severity", () => {
  const violation: Violation = {
    id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf",
  };
  const notAuthorized: Authorization = { authorized: false, actionMatched: false, scopeMatched: false, negated: false };
  assert.equal(escalateBlastRadius(violation, notAuthorized, { violated: false, confidence: 0.5 }, { escalationThreshold: 0.85 }), "risky");
});

test("escalateBlastRadius: risky escalates to destructive when Jev confirms", () => {
  const violation: Violation = {
    id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf",
  };
  const notAuthorized: Authorization = { authorized: false, actionMatched: false, scopeMatched: false, negated: false };
  assert.equal(escalateBlastRadius(violation, notAuthorized, { violated: true, confidence: 0.9 }, { escalationThreshold: 0.85 }), "destructive");
});

test("escalateBlastRadius: destructive escalates to deny when Jev confirms", () => {
  const violation: Violation = {
    id: "git-force-push", severity: "destructive", source: "pattern", description: "git force push",
  };
  const notAuthorized: Authorization = { authorized: false, actionMatched: false, scopeMatched: false, negated: false };
  assert.equal(escalateBlastRadius(violation, notAuthorized, { violated: true, confidence: 0.95 }, { escalationThreshold: 0.85 }), "deny");
});

// ---------------------------------------------------------------------------
// Escalation B: rules guard.

test("escalateRulesViolation: Jev confirms against matched rule escalates to destructive", () => {
  const violation: Violation = {
    id: "no-console", severity: "risky", source: "rules-guard", description: "no console",
    matchedRule: "No console.log",
  };
  assert.equal(escalateRulesViolation(violation, { violated: true, confidence: 0.9 }, { escalationThreshold: 0.85 }), "destructive");
});

test("escalateRulesViolation: Jev does not confirm keeps original severity", () => {
  const violation: Violation = {
    id: "no-console", severity: "risky", source: "rules-guard", description: "no console",
    matchedRule: "No console.log",
  };
  assert.equal(escalateRulesViolation(violation, { violated: false, confidence: 0.3 }, { escalationThreshold: 0.85 }), "risky");
});

test("escalateRulesViolation: no matchedRule keeps original severity", () => {
  const violation: Violation = {
    id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf",
  };
  assert.equal(escalateRulesViolation(violation, { violated: true, confidence: 0.95 }, { escalationThreshold: 0.85 }), "risky");
});

// ---------------------------------------------------------------------------
// Aggregation.

test("aggregateLevel: no violations returns allow", () => {
  assert.equal(aggregateLevel([]), "allow");
});

test("aggregateLevel: highest severity wins", () => {
  const risky: EscalatedViolation = {
    id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf", escalatedSeverity: "risky",
  };
  assert.equal(aggregateLevel([risky]), "warn");

  const destructive: EscalatedViolation = {
    id: "git-force-push", severity: "destructive", source: "pattern", description: "git force push", escalatedSeverity: "destructive",
  };
  assert.equal(aggregateLevel([risky, destructive]), "confirm");

  const deny: EscalatedViolation = {
    id: "never-rule", severity: "deny", source: "pattern", description: "blocked", escalatedSeverity: "deny",
  };
  assert.equal(aggregateLevel([risky, destructive, deny]), "deny");
});

test("aggregateLevel: mix of authorized (removed) and remaining violations", () => {
  const remaining: EscalatedViolation = {
    id: "secret-literal", severity: "risky", source: "pattern", description: "secret", escalatedSeverity: "risky",
  };
  assert.equal(aggregateLevel([remaining]), "warn");
});

// ---------------------------------------------------------------------------
// removeAuthorized: filter out authorized violations.

test("removeAuthorized: removes only authorized violations", () => {
  const v1: Violation = { id: "git-commit", severity: "risky", source: "pattern", description: "commit" };
  const v2: Violation = { id: "secret-literal", severity: "risky", source: "pattern", description: "secret" };
  const auth1: Authorization = { authorized: true, actionMatched: true, scopeMatched: true, negated: false };
  const auth2: Authorization = { authorized: false, actionMatched: false, scopeMatched: false, negated: false };
  const remaining = removeAuthorized([v1, v2], [auth1, auth2]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.id, "secret-literal");
});

test("removeAuthorized: empty authorization array keeps all violations", () => {
  const v1: Violation = { id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf" };
  assert.equal(removeAuthorized([v1], []).length, 1);
});

// ---------------------------------------------------------------------------
// Full pipeline: authorization → remove → escalate → aggregate.

test("pipeline: authorized destructive action results in allow when no other violations", () => {
  const violation: Violation = {
    id: "rm-rf", severity: "destructive", source: "pattern", description: "rm -rf",
    patternFamily: "rm-rf",
    scope: { paths: ["eval/reports/"], tool: "bash" },
  };
  // User says "delete eval/reports"
  const auth = authorize("delete eval/reports", violation);
  assert.equal(auth.authorized, true, "user explicitly authorized this action on this scope");
  const remaining = removeAuthorized([violation], [auth]);
  assert.equal(remaining.length, 0, "authorized violation removed");
  assert.equal(aggregateLevel([]), "allow", "no remaining violations → allow");
});

test("pipeline: one authorized + one unauthorized violation", () => {
  const gitCommit: Violation = {
    id: "git-commit", severity: "risky", source: "pattern", description: "commit",
    patternFamily: "git-commit",
    scope: { command: "git commit", tool: "bash" },
  };
  const secret: Violation = {
    id: "secret-literal", severity: "risky", source: "pattern", description: "secret",
  };
  const authCommit = authorize("commit the changes", gitCommit);
  const authSecret = authorize("commit the changes", secret);
  assert.equal(authCommit.authorized, true);
  assert.equal(authSecret.authorized, false, "commit does not authorize secret");
  const remaining = removeAuthorized([gitCommit, secret], [authCommit, authSecret]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.id, "secret-literal");
  const escalated: EscalatedViolation[] = remaining.map(v => ({ ...v, escalatedSeverity: v.severity }));
  assert.equal(aggregateLevel(escalated), "warn");
});

test("pipeline: hard deny is never removable by authorization", () => {
  const denyViolation: Violation = {
    id: "never-deploy", severity: "deny", source: "pattern", description: "blocked",
  };
  const auth = authorize("deploy to production", denyViolation);
  assert.equal(auth.authorized, false, "deny violations are not auth-eligible");
  const remaining = removeAuthorized([denyViolation], [auth]);
  assert.equal(remaining.length, 1, "deny violation remains");
  const escalated: EscalatedViolation[] = remaining.map(v => ({ ...v, escalatedSeverity: v.severity }));
  assert.equal(aggregateLevel(escalated), "deny");
});

test("pipeline: normal push does NOT authorize force-push (regression)", () => {
  const forcePush: Violation = {
    id: "git-force-push", severity: "destructive", source: "pattern", description: "git force push",
    patternFamily: "git-force-push",
    scope: { command: "git push --force origin main", tool: "bash" },
  };
  const auth = authorize("push my branch", forcePush);
  assert.equal(auth.authorized, false, "'push my branch' does not authorize force-push");
  const remaining = removeAuthorized([forcePush], [auth]);
  assert.equal(remaining.length, 1, "force-push violation survives");
  const escalated: EscalatedViolation[] = remaining.map(v => ({ ...v, escalatedSeverity: v.severity }));
  assert.equal(aggregateLevel(escalated), "confirm", "unauthorized force-push stays at confirm");
});

// ---------------------------------------------------------------------------
// parseViolationJudgments: defaults for missing/malformed Jev responses.

test("parseViolationJudgments: parses noul probability answers (primary path)", () => {
  const violations: Violation[] = [
    { id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf" },
    { id: "git-push", severity: "destructive", source: "pattern", description: "git push" },
  ];
  const extra = { "violation_0": 0.92, "violation_1": 0.15 };
  const judgments = parseViolationJudgments(violations, extra);
  assert.equal(judgments.length, 2);
  assert.equal(judgments[0]!.violated, true);
  assert.equal(judgments[0]!.confidence, 0.92);
  assert.equal(judgments[1]!.violated, false);
  assert.equal(judgments[1]!.confidence, 0.15);
});

test("parseViolationJudgments: parses legacy choice string answers", () => {
  const violations: Violation[] = [
    { id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf" },
    { id: "git-push", severity: "destructive", source: "pattern", description: "git push" },
  ];
  const extra = { "violation_0": "violation", "violation_1": "compliant" };
  const judgments = parseViolationJudgments(violations, extra);
  assert.equal(judgments.length, 2);
  assert.equal(judgments[0]!.violated, true);
  assert.equal(judgments[0]!.confidence, 0.9);
  assert.equal(judgments[1]!.violated, false);
  assert.equal(judgments[1]!.confidence, 0.1);
});

test("parseViolationJudgments: defaults to violated=true when extra is undefined", () => {
  const violations: Violation[] = [
    { id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf" },
  ];
  const judgments = parseViolationJudgments(violations, undefined);
  assert.equal(judgments.length, 1);
  assert.equal(judgments[0]!.violated, true);
  assert.equal(judgments[0]!.confidence, 0.5);
});

test("parseViolationJudgments: noul answer at threshold boundary", () => {
  const violations: Violation[] = [
    { id: "rm-rf", severity: "risky", source: "pattern", description: "rm -rf" },
  ];
  // Exactly 0.5 is the boundary: >= 0.5 means violated
  const judgments50 = parseViolationJudgments(violations, { "violation_0": 0.5 });
  assert.equal(judgments50[0]!.violated, true);
  assert.equal(judgments50[0]!.confidence, 0.5);
  const judgments49 = parseViolationJudgments(violations, { "violation_0": 0.49 });
  assert.equal(judgments49[0]!.violated, false);
  assert.equal(judgments49[0]!.confidence, 0.49);
});

// ---------------------------------------------------------------------------
// Rules file resolution.

test("resolveRulesFile: pi-warden.md wins over fallbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-rulesfile-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\nAlways test.\n");
  await writeFile(join(dir, "pi-warden.md"), "# Project Rules\nNo console.log.\n");
  const resolved = resolveRulesFile(dir);
  assert.equal(resolved?.source, "pi-warden.md");
  assert.match(resolved?.content ?? "", /No console\.log/);
  await rm(dir, { recursive: true, force: true });
});

test("resolveRulesFile: AGENTS.md is used when pi-warden.md is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-rulesfile-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\nAlways test.\n");
  const resolved = resolveRulesFile(dir);
  assert.equal(resolved?.source, "AGENTS.md");
  await rm(dir, { recursive: true, force: true });
});

test("resolveRulesFile: returns null when no rules file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-rulesfile-"));
  assert.equal(resolveRulesFile(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test("resolveRulesFile: truncates large files using extractRules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-rulesfile-"));
  const largeContent = "# Rule\n" + "x".repeat(20000);
  await writeFile(join(dir, "pi-warden.md"), largeContent);
  const resolved = resolveRulesFile(dir);
  assert.ok(resolved!.content.length < largeContent.length, "content is truncated");
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractRules: token-aware truncation.

test("extractRules: keeps headings and their paragraphs within budget", () => {
  const content = "# Rule 1\nBody 1.\n\n# Rule 2\nBody 2.\n\n# Rule 3\n" + "x".repeat(20000);
  const extracted = extractRules(content, 100);
  assert.match(extracted, /# Rule 1/);
  assert.match(extracted, /# Rule 2/);
  // Rule 3 may be partially included or excluded based on budget
});

test("extractRules: short content passes through unchanged", () => {
  const content = "# Short Rule\nBody.";
  assert.equal(extractRules(content), content);
});

// ---------------------------------------------------------------------------
// checkPiWardenMissing: first-run warning support.

const rulesConfig = (over: Partial<RulesConfig> = {}): RulesConfig => ({ ...defaultConfig().rules, ...over });

test("checkPiWardenMissing: returns missing=false when pi-warden.md exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "pi-warden.md"), "# Rules\n");
  const result = checkPiWardenMissing(dir, rulesConfig());
  assert.equal(result.missing, false);
  await rm(dir, { recursive: true, force: true });
});

test("checkPiWardenMissing: returns fallbackSource when pi-warden.md missing but AGENTS.md exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
  const result = checkPiWardenMissing(dir, rulesConfig());
  assert.equal(result.missing, true);
  assert.equal(result.fallbackSource, "AGENTS.md");
  await rm(dir, { recursive: true, force: true });
});

test("checkPiWardenMissing: returns no fallback when nothing exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  const result = checkPiWardenMissing(dir, rulesConfig());
  assert.equal(result.missing, true);
  assert.equal(result.fallbackSource, undefined);
  await rm(dir, { recursive: true, force: true });
});

// A bound `rules.files` is a real source, and the resolution order never reaches the README/CLAUDE/AGENTS
// tier when one resolves. Warning there is noise that pushes the user toward creating a pi-warden.md,
// which would shadow the configured files outright.
test("checkPiWardenMissing: a resolved rules.files entry is not a fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
  await writeFile(join(dir, "warden-local-rules.md"), "# Local rule\nBody.\n");
  const result = checkPiWardenMissing(dir, rulesConfig({ files: [join(dir, "global-rules.md"), "warden-local-rules.md"] }));
  assert.equal(result.missing, false);
  assert.equal(result.fallbackSource, undefined);
  await rm(dir, { recursive: true, force: true });
});

// The configured tier wins even when the file reads like a fallback document, so the tier cannot be
// inferred from the name.
test("checkPiWardenMissing: a rules.files entry named AGENTS.md is configured, not a fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
  const result = checkPiWardenMissing(dir, rulesConfig({ files: ["AGENTS.md"] }));
  assert.equal(result.missing, false);
  assert.equal(result.fallbackSource, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("checkPiWardenMissing: still names the fallback when no configured file resolves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
  const result = checkPiWardenMissing(dir, rulesConfig({ files: ["absent-rules.md"] }));
  assert.equal(result.missing, true);
  assert.equal(result.fallbackSource, "AGENTS.md");
  await rm(dir, { recursive: true, force: true });
});

test("checkPiWardenMissing: fallback=false reaches no fallback document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
  const result = checkPiWardenMissing(dir, rulesConfig({ fallback: false }));
  assert.equal(result.missing, true);
  assert.equal(result.fallbackSource, undefined);
  await rm(dir, { recursive: true, force: true });
});

// A tier that answered means the project has a rules source of its own, whether or not the file says
// anything yet. Nagging would name the file the project already has, and the notice's remedy is the
// one thing that shadows a bound `rules.files`.
test("checkPiWardenMissing: an empty pi-warden.md is still a project rules file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "pi-warden.md"), "");
  await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
  const result = checkPiWardenMissing(dir, rulesConfig());
  assert.equal(result.missing, false);
  await rm(dir, { recursive: true, force: true });
});

test("checkPiWardenMissing: an empty configured file is the configured tier, not a missing source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-missing-"));
  await writeFile(join(dir, "rules.md"), "");
  await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
  const result = checkPiWardenMissing(dir, rulesConfig({ files: ["rules.md"] }));
  assert.equal(result.missing, false);
  assert.equal(result.fallbackSource, undefined);
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Init: starter rules file generation and writing.

test("detectProjectType: detects typescript from tsconfig.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  await writeFile(join(dir, "tsconfig.json"), "{}");
  assert.equal(detectProjectType(dir), "typescript");
  await rm(dir, { recursive: true, force: true });
});

test("detectProjectType: detects generic when no manifest exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  assert.equal(detectProjectType(dir), "generic");
  await rm(dir, { recursive: true, force: true });
});

test("generateStarterRules: includes safety rules and project type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  await writeFile(join(dir, "tsconfig.json"), "{}");
  const content = generateStarterRules(dir);
  assert.match(content, /No hardcoded secrets/);
  assert.match(content, /Comments explain why, not what/);
  assert.match(content, /Project type: typescript/);
  assert.match(content, /No explicit any/);
  await rm(dir, { recursive: true, force: true });
});

test("generateStarterRules: generic project has no type-specific rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  const content = generateStarterRules(dir);
  assert.match(content, /No hardcoded secrets/);
  assert.match(content, /Project type: generic/);
  assert.doesNotMatch(content, /No explicit any/);
  await rm(dir, { recursive: true, force: true });
});

test("writeStarterRules: writes pi-warden.md and returns result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  const result = writeStarterRules(dir);
  assert.equal(result.alreadyExists, false);
  assert.match(result.path, /pi-warden\.md$/);
  assert.match(result.content, /No hardcoded secrets/);
  // Verify the file was actually written
  const written = (await import("node:fs")).readFileSync(result.path, "utf8");
  assert.match(written, /No hardcoded secrets/);
  await rm(dir, { recursive: true, force: true });
});

test("writeStarterRules: returns alreadyExists=true without writing when file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  await writeFile(join(dir, "pi-warden.md"), "# Existing rules\nKeep these.\n");
  const result = writeStarterRules(dir);
  assert.equal(result.alreadyExists, true);
  assert.match(result.content, /Existing rules/);
  // File should be unchanged
  const content = (await import("node:fs")).readFileSync(result.path, "utf8");
  assert.match(content, /Existing rules/);
  await rm(dir, { recursive: true, force: true });
});

test("writeStarterRules: overwrite=true replaces existing file but preserves old rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  await writeFile(join(dir, "pi-warden.md"), "# Old rules\n");
  const result = writeStarterRules(dir, true);
  assert.equal(result.alreadyExists, true);
  assert.match(result.content, /No hardcoded secrets/);
  assert.match(result.content, /Old rules/, "existing rules are preserved in the new starter");
  await rm(dir, { recursive: true, force: true });
});

test("buildProjectContext: reads package.json when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "my-app", scripts: { test: "vitest", build: "tsc" } }));
  const ctx = buildProjectContext(dir);
  assert.match(ctx, /name: my-app/);
  assert.match(ctx, /scripts: test, build/);
  await rm(dir, { recursive: true, force: true });
});

test("buildInitPrompt: includes project context and safety rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  await writeFile(join(dir, "tsconfig.json"), "{}");
  const prompt = buildInitPrompt(dir);
  assert.match(prompt, /Project type: typescript/);
  assert.match(prompt, /No hardcoded secrets/);
  assert.match(prompt, /No explicit/);
  assert.match(prompt, /Under 50 rules/);
  await rm(dir, { recursive: true, force: true });
});

test("buildInitPrompt: generic project omits type-specific rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-init-"));
  const prompt = buildInitPrompt(dir);
  assert.match(prompt, /Project type: generic/);
  assert.doesNotMatch(prompt, /No explicit/);
  assert.match(prompt, /No hardcoded secrets/);
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Redaction: resolveRulesFile content must be safe to send off-machine.

test("resolveRulesFile: content is redacted before leaving the machine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-redact-"));
  await writeFile(join(dir, "pi-warden.md"), "# Rule\napi_key=sk-live-1234567890abcdef\npassword: hunter2\n");
  const resolved = resolveRulesFile(dir);
  assert.ok(resolved, "resolved a rules file");
  assert.ok(!resolved.content.includes("sk-live-1234567890abcdef"), "API key is redacted");
  assert.ok(!resolved.content.includes("hunter2"), "password is redacted");
  assert.match(resolved.content, /\[redacted\]/, "redacted marker present");
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractRules edge case: first block exceeding budget must not return empty.

test("extractRules: large first block still returns non-empty output", () => {
  const largeFirst = "# Rule One\n" + "x".repeat(20000);
  const extracted = extractRules(largeFirst, 100);
  assert.ok(extracted.length > 0, "extractRules does not collapse to empty when the first block exceeds budget");
});
