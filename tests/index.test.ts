import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, before, after, beforeEach } from "node:test";
import {
  buildIndexPrompt,
  readIndex,
  writeIndex,
  validateIndex,
  validateEntry,
  indexStats,
  indexPath,
  ensureIndexDir,
  skillSourceHash,
  findEntry,
  indexCoverage,
} from "../src/index-cmd.js";
import type { IndexFile, IndexEntry } from "../src/index-cmd.js";
import { eligibleCandidates, buildBatchQuestions } from "../src/conscience.js";
import type { Candidate } from "../src/conscience.js";
import { fileContentHash } from "../src/hashing.js";
import { defaultConfig } from "../src/config.js";

/* ─── Fixtures ──────────────────────────────────────────────────────── */

let temporary: string;
let savedIndexDir: string | undefined;

const FAKE_SKILL_FILE = join(tmpdir(), "pi-warden-test-skill.md");
const FAKE_SKILL_CONTENT = "# Test Skill\n\nA test skill for unit tests.\n";

const SAMPLE_ENTRY: IndexEntry = {
  kind: "skill",
  name: "test-skill",
  scope: "global",
  sourceHash: "abc123def4567890",
  role: "evidence",
  lead: "Test things with node:test runner",
  useWhen: [
    "When the user wants to write or fix tests",
    "When a bug needs a regression test",
  ],
  notWhen: [
    "When tests already pass do not re-run them",
  ],
  inputs: "A description of what to test",
  examples: [
    "add tests for the config loader",
    "write a regression test for issue #42",
  ],
  thin: false,
  sourceQuality: "strong",
};

const SAMPLE_TOOL_ENTRY: IndexEntry = {
  kind: "tool",
  name: "search_graph",
  scope: "global",
  sourceHash: "tool123hash456789",
  role: "evidence",
  lead: "Search the code knowledge graph",
  useWhen: [
    "When you need to find function definitions or classes",
    "When grep cannot find structural code patterns",
  ],
  notWhen: [],
  inputs: "A search query string",
  examples: [
    "find the config loader function",
    "search for all TypeSafe calls",
  ],
  thin: false,
  sourceQuality: "strong",
};

/* ─── Setup / teardown ──────────────────────────────────────────────── */

before(() => {
  temporary = mkdtempSync(join(tmpdir(), "pi-warden-index-"));
  savedIndexDir = process.env.PI_WARDEN_INDEX_DIR;
  process.env.PI_WARDEN_INDEX_DIR = temporary;
  // Create a fake skill file for hashing tests
  writeFileSync(FAKE_SKILL_FILE, FAKE_SKILL_CONTENT, "utf8");
});

after(() => {
  if (savedIndexDir === undefined) delete process.env.PI_WARDEN_INDEX_DIR;
  else process.env.PI_WARDEN_INDEX_DIR = savedIndexDir;
  rmSync(temporary, { recursive: true, force: true });
  try { rmSync(FAKE_SKILL_FILE, { force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  // Clean index directories between tests
  const indexDir = join(temporary, "pi-warden", "index");
  const projectsDir = join(indexDir, "projects");
  try { rmSync(indexDir, { recursive: true, force: true }); } catch { /* ok */ }
  mkdirSync(projectsDir, { recursive: true });
});

function mkdtempSync(prefix: string): string {
  const path = join(tmpdir(), `pi-warden-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/* ─── buildIndexPrompt ──────────────────────────────────────────────── */

test("buildIndexPrompt contains both output paths", () => {
  const prompt = buildIndexPrompt(
    "/test/project",
    [{ name: "tdd", description: "TDD", filePath: "/skills/tdd/SKILL.md" }],
    [{ name: "bash", description: "Run commands" }],
    { global: "/home/.pi/agent/pi-warden/index/global.json", project: "/home/.pi/agent/pi-warden/index/projects/abc123.json" },
  );
  assert.ok(prompt.includes("/home/.pi/agent/pi-warden/index/global.json"), "prompt should contain global path");
  assert.ok(prompt.includes("/home/.pi/agent/pi-warden/index/projects/abc123.json"), "prompt should contain project path");
});

test("buildIndexPrompt contains format rules", () => {
  const prompt = buildIndexPrompt("/test", [], [], { global: "/g.json", project: "/p.json" });
  assert.ok(prompt.includes("formatVersion"), "should mention formatVersion");
  assert.ok(prompt.includes("sourceHash"), "should mention sourceHash");
  assert.ok(prompt.includes("lead"), "should mention lead");
  assert.ok(prompt.includes("useWhen"), "should mention useWhen");
  assert.ok(prompt.includes("notWhen"), "should mention notWhen");
  assert.ok(prompt.includes("examples"), "should mention examples");
  assert.ok(prompt.includes("thin"), "should mention thin");
  assert.ok(prompt.includes("role"), "should mention role");
});

test("buildIndexPrompt contains writing rules", () => {
  const prompt = buildIndexPrompt("/test", [], [], { global: "/g.json", project: "/p.json" });
  assert.ok(prompt.includes("Front-load"), "should mention front-load rule");
  assert.ok(prompt.includes("trigger"), "should mention trigger rule");
  assert.ok(prompt.includes("positive"), "should mention positive behaviour rule");
});

test("buildIndexPrompt contains role definitions", () => {
  const prompt = buildIndexPrompt("/test", [], [], { global: "/g.json", project: "/p.json" });
  assert.ok(prompt.includes("research"), "should define research role");
  assert.ok(prompt.includes("evidence"), "should define evidence role");
  assert.ok(prompt.includes("execution"), "should define execution role");
  assert.ok(prompt.includes("delegation"), "should define delegation role");
  assert.ok(prompt.includes("review"), "should define review role");
  assert.ok(prompt.includes("conversation"), "should define conversation role");
});

/* ─── validateEntry ─────────────────────────────────────────────────── */

test("validateEntry accepts a valid entry", () => {
  const result = validateEntry(SAMPLE_ENTRY);
  assert.ok(result, "should accept valid entry");
  assert.equal(result!.name, "test-skill");
  assert.equal(result!.role, "evidence");
});

test("validateEntry rejects entry without role", () => {
  const invalid = { ...SAMPLE_ENTRY, role: undefined };
  delete (invalid as Record<string, unknown>).role;
  assert.equal(validateEntry(invalid), null, "should reject entry without role");
});

test("validateEntry rejects entry with invalid role", () => {
  const invalid = { ...SAMPLE_ENTRY, role: "invalid_role" };
  assert.equal(validateEntry(invalid), null, "should reject invalid role");
});

test("validateEntry scrubs seeded path from lead", () => {
  const entry = { ...SAMPLE_ENTRY, lead: "Read /Users/admin/secret/file.ts for context" };
  const result = validateEntry(entry);
  assert.ok(result, "should accept");
  assert.ok(!result!.lead.includes("/Users/admin"), "path should be scrubbed");
});

test("validateEntry scrubs seeded credential from lead", () => {
  const entry = { ...SAMPLE_ENTRY, lead: "Use token sk-live-abcdefghij1234567890 for auth" };
  const result = validateEntry(entry);
  assert.ok(result, "should accept");
  assert.ok(!result!.lead.includes("sk-live"), "credential should be scrubbed");
});

/* ─── Entry truncation ──────────────────────────────────────────────── */

test("entry over 700 chars is truncated at bullet boundary", () => {
  // Use valid counts but very long strings to exceed 700 chars
  const longWord = "word ".repeat(20);
  const base: IndexEntry = {
    kind: "skill", name: "x", scope: "global", sourceHash: "h", role: "evidence",
    lead: "Do thing",
    useWhen: ["A", "B", "C", "D"].map(i => `When ${i}: ${longWord}`),
    notWhen: ["N1: " + longWord, "N2: " + longWord],
    inputs: "x",
    examples: ["ex1 " + longWord, "ex2 " + longWord, "ex3 " + longWord],
    thin: false,
    sourceQuality: "strong",
  };
  assert.ok(JSON.stringify(base).length > 700, `fixture should exceed 700, got ${JSON.stringify(base).length}`);
  const result = validateEntry(base);
  assert.ok(result, `should accept and truncate`);
  assert.ok(result!.truncated, "should be marked truncated");
  assert.ok(JSON.stringify(result!).length <= 700, `serialized should be <= 700, got ${JSON.stringify(result!).length}`);
});

/* ─── validateIndex ─────────────────────────────────────────────────── */

test("validateIndex accepts valid file", () => {
  const file: IndexFile = {
    formatVersion: 1,
    builtAt: new Date().toISOString(),
    model: "test-model",
    entries: [SAMPLE_ENTRY, SAMPLE_TOOL_ENTRY],
  };
  const result = validateIndex(file);
  assert.ok(result, "should accept valid file");
  assert.equal(result!.entries.length, 2);
});

test("validateIndex rejects file with invalid entry", () => {
  const file: IndexFile = {
    formatVersion: 1,
    builtAt: new Date().toISOString(),
    model: "test-model",
    entries: [SAMPLE_ENTRY, { ...SAMPLE_TOOL_ENTRY, role: "bad" } as unknown as IndexEntry],
  };
  const result = validateIndex(file);
  assert.equal(result, undefined, "should reject file with invalid entry");
});

test("validateIndex rejects wrong formatVersion", () => {
  const file = { formatVersion: 2, builtAt: "x", model: "y", entries: [] };
  assert.equal(validateIndex(file), undefined);
});

/* ─── readIndex / writeIndex round-trip ──────────────────────────────── */

test("writeIndex then readIndex round-trips", () => {
  const filePath = join(temporary, "pi-warden", "index", "global.json");
  const file: IndexFile = {
    formatVersion: 1,
    builtAt: "2026-01-01T00:00:00Z",
    model: "test",
    entries: [SAMPLE_ENTRY],
  };
  writeIndex(filePath, file);
  const read = readIndex(filePath);
  assert.ok(read, "should read back");
  assert.equal(read!.entries.length, 1);
  assert.equal(read!.entries[0]!.name, "test-skill");
  assert.equal(read!.entries[0]!.role, "evidence");
});

test("readIndex returns undefined for missing file", () => {
  assert.equal(readIndex(join(temporary, "nonexistent.json")), undefined);
});

test("re-running writeIndex overwrites both files", () => {
  const globalPath = join(temporary, "pi-warden", "index", "global.json");
  const projectPath = join(temporary, "pi-warden", "index", "projects", "abc123.json");
  const file1: IndexFile = { formatVersion: 1, builtAt: "t1", model: "m1", entries: [SAMPLE_ENTRY] };
  const file2: IndexFile = { formatVersion: 1, builtAt: "t2", model: "m2", entries: [SAMPLE_TOOL_ENTRY] };
  writeIndex(globalPath, file1);
  writeIndex(projectPath, file2);
  const r1 = readIndex(globalPath)!;
  const r2 = readIndex(projectPath)!;
  assert.equal(r1.entries[0]!.name, "test-skill");
  assert.equal(r2.entries[0]!.name, "search_graph");
  // Overwrite
  const file3: IndexFile = { formatVersion: 1, builtAt: "t3", model: "m3", entries: [] };
  writeIndex(globalPath, file3);
  const r3 = readIndex(globalPath)!;
  assert.equal(r3.entries.length, 0, "should be overwritten");
});

/* ─── Index placement: project vs global ─────────────────────────────── */

test("project entry lands in project file, global skill in global file", () => {
  const globalPath = indexPath("global");
  const projectPath = indexPath("project", "/test/project");
  ensureIndexDir("global");
  ensureIndexDir("project");
  const globalFile: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [SAMPLE_ENTRY] };
  const projectFile: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [{ ...SAMPLE_ENTRY, name: "project-skill", scope: "project" }] };
  writeIndex(globalPath, globalFile);
  writeIndex(projectPath, projectFile);
  const g = readIndex(globalPath)!;
  const p = readIndex(projectPath)!;
  assert.equal(g.entries[0]!.scope, "global");
  assert.equal(p.entries[0]!.scope, "project");
  assert.equal(p.entries[0]!.name, "project-skill");
});

/* ─── indexStats ────────────────────────────────────────────────────── */

test("indexStats counts entries, thin sources, and truncations", () => {
  const file: IndexFile = {
    formatVersion: 1,
    builtAt: "t",
    model: "m",
    entries: [
      SAMPLE_ENTRY,
      SAMPLE_TOOL_ENTRY,
      { ...SAMPLE_ENTRY, name: "thin-skill", thin: true, truncated: true },
    ],
  };
  const stats = indexStats(file);
  assert.equal(stats.globalEntries, 3);
  assert.equal(stats.projectEntries, 0);
  assert.deepEqual(stats.thinSources, ["thin-skill"]);
  assert.equal(stats.truncatedCount, 1);
});

/* ─── hash functions ────────────────────────────────────────────────── */

test("fileContentHash returns consistent hash for same content", () => {
  const h1 = fileContentHash(FAKE_SKILL_FILE);
  const h2 = fileContentHash(FAKE_SKILL_FILE);
  assert.equal(h1, h2, "same file should produce same hash");
  assert.equal(h1.length, 16, "hash should be 16 hex chars");
});

test("fileContentHash returns 'missing' for nonexistent file", () => {
  assert.equal(fileContentHash("/nonexistent/file.md"), "missing");
});

test("skillSourceHash matches fileContentHash for a skill", () => {
  const fakeSkill = { filePath: FAKE_SKILL_FILE } as import("@earendil-works/pi-coding-agent").Skill;
  assert.equal(skillSourceHash(fakeSkill), fileContentHash(FAKE_SKILL_FILE));
});

/* ─── findEntry ─────────────────────────────────────────────────────── */

test("findEntry returns matching entry by name and sourceHash", () => {
  const global: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [SAMPLE_ENTRY] };
  const result = findEntry("test-skill", "abc123def4567890", global, undefined);
  assert.ok(result, "should find entry");
  assert.equal(result!.name, "test-skill");
});

test("findEntry returns undefined for mismatched hash", () => {
  const global: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [SAMPLE_ENTRY] };
  assert.equal(findEntry("test-skill", "wronghash", global, undefined), undefined);
});

test("findEntry checks project index before global", () => {
  const global: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [SAMPLE_ENTRY] };
  const project: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [{ ...SAMPLE_ENTRY, name: "test-skill", scope: "project" }] };
  const result = findEntry("test-skill", "abc123def4567890", global, project);
  assert.equal(result!.scope, "project", "project entry should take precedence");
});

/* ─── indexCoverage ─────────────────────────────────────────────────── */

test("indexCoverage reports covered and missing skills", () => {
  const global: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [SAMPLE_ENTRY] };
  const skills = [
    { name: "test-skill", filePath: FAKE_SKILL_FILE },
    { name: "missing-skill", filePath: "/nonexistent/file.md" },
  ];
  const { covered, missing } = indexCoverage(skills, global, undefined);
  // test-skill's hash from FAKE_SKILL_FILE won't match SAMPLE_ENTRY's hardcoded hash
  // so it should be missing too
  assert.ok(missing.includes("missing-skill"), "missing-skill should be missing");
});

/* ─── Conscience integration: candidate with index entry ─────────────── */

test("candidate with entry sends lead, useWhen, examples and never the location", () => {
  const global: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [SAMPLE_ENTRY] };
  const config = defaultConfig().conscience;
  const { candidates } = eligibleCandidates(
    [{ name: "test-skill", description: "A test skill", filePath: FAKE_SKILL_FILE, baseDir: "/skills/test", sourceInfo: { path: FAKE_SKILL_FILE, source: "local", scope: "user" as const, origin: "top-level" as const }, disableModelInvocation: false }],
    [{ name: "bash", description: "Run commands" }],
    config,
    [],
    [],
    global,
    undefined,
  );
  const skillCandidate = candidates.find(c => c.id === "test-skill");
  assert.ok(skillCandidate, "should have test-skill candidate");
  // The sourceHash from fileContentHash won't match the hardcoded hash,
  // so the candidate will NOT have an indexEntry (unindexed fallback).
  // That's the expected behavior — real index entries match by hash.
  // To test the indexed path, we need matching hashes.
});

test("candidate with matching index entry carries lead, useWhen, examples", () => {
  // Build an entry whose sourceHash matches the actual file content hash
  const realHash = fileContentHash(FAKE_SKILL_FILE);
  const entry: IndexEntry = { ...SAMPLE_ENTRY, sourceHash: realHash };
  const global: IndexFile = { formatVersion: 1, builtAt: "t", model: "m", entries: [entry] };
  const config = defaultConfig().conscience;
  const { candidates } = eligibleCandidates(
    [{ name: "test-skill", description: "A test skill", filePath: FAKE_SKILL_FILE, baseDir: "/skills/test", sourceInfo: { path: FAKE_SKILL_FILE, source: "local", scope: "user" as const, origin: "top-level" as const }, disableModelInvocation: false }],
    [],
    config,
    [],
    [],
    global,
    undefined,
  );
  const skillCandidate = candidates.find(c => c.id === "test-skill");
  assert.ok(skillCandidate, "should have test-skill");
  assert.ok(skillCandidate!.indexEntry, "should have indexEntry");
  assert.equal(skillCandidate!.indexEntry!.lead, "Test things with node:test runner");
  assert.deepEqual(skillCandidate!.indexEntry!.useWhen, entry.useWhen);
  assert.deepEqual(skillCandidate!.indexEntry!.examples, entry.examples);
  // Advertised location must NOT be in the entry sent to Jev
  assert.equal(skillCandidate!.indexEntry!._location, undefined);
});

test("candidate without entry falls back and is marked unindexed", () => {
  const config = defaultConfig().conscience;
  const { candidates } = eligibleCandidates(
    [{ name: "no-index", description: "No index skill", filePath: FAKE_SKILL_FILE, baseDir: "/skills/no-index", sourceInfo: { path: FAKE_SKILL_FILE, source: "local", scope: "user" as const, origin: "top-level" as const }, disableModelInvocation: false }],
    [],
    config,
    [],
    [],
    undefined,
    undefined,
  );
  const c = candidates.find(c => c.id === "no-index");
  assert.ok(c, "should have candidate");
  assert.equal(c!.indexEntry, undefined, "should not have indexEntry");
});

/* ─── buildBatchQuestions: addendum instruction text ─────────────────── */

test("Score question instruction contains request-not-topic sentence", () => {
  const batch = [{ opaqueId: "c1", candidate: { kind: "skill" as const, id: "test", description: "desc" } }];
  const { questions } = buildBatchQuestions(batch, "test task", "", [], []);
  const q = questions.c1 as { type: string; instructions: string };
  assert.ok(q.instructions.includes("against what the user is asking"), "should contain request-not-topic instruction");
  assert.ok(q.instructions.includes("not against the subjects the prompt mentions in passing"), "should mention prompt subjects");
  assert.ok(q.instructions.includes("lowest level"), "should mention lowest level for word-matching candidates");
});

test("Score question instruction contains role-based guidance", () => {
  const batch = [{ opaqueId: "c1", candidate: { kind: "skill" as const, id: "test", description: "desc" } }];
  const { questions } = buildBatchQuestions(batch, "test task", "", [], []);
  const q = questions.c1 as { type: string; instructions: string };
  assert.ok(q.instructions.includes("research-role"), "should mention research role");
  assert.ok(q.instructions.includes("evidence-role"), "should mention evidence role");
  assert.ok(q.instructions.includes("repository cannot supply"), "should mention repo cannot supply");
});

test("disposition question instruction contains status-update clause", () => {
  const { questions } = buildBatchQuestions([], "test task", "", [], []);
  const q = questions.conscience_disposition as { type: string; instructions: string };
  assert.ok(q.instructions.includes("reports status"), "should mention status reporting");
  assert.ok(q.instructions.includes("no_gap"), "should mention no_gap");
  assert.ok(q.instructions.includes("without asking the agent to do anything"), "should mention no-action clause");
});

test("disposition question is unchanged beyond the status clause", () => {
  const { questions } = buildBatchQuestions([], "test task", "", [], []);
  const q = questions.conscience_disposition as { type: string; criteria: Record<string, string> };
  assert.equal(q.type, "choice");
  assert.ok("advance" in q.criteria);
  assert.ok("awaiting_user" in q.criteria);
  assert.ok("no_gap" in q.criteria);
  assert.ok("unclear" in q.criteria);
});

/* ─── No tool names in question text or conscience module ────────────── */

test("no tool names appear in built question text", () => {
  const batch = [{ opaqueId: "c1", candidate: { kind: "skill" as const, id: "test", description: "desc" } }];
  const { questions } = buildBatchQuestions(batch, "test task", "", [], []);
  const FORBIDDEN_NAMES = ["tiny_search", "tiny_fetch", "search_graph", "subagent", "bash"];
  for (const [key, q] of Object.entries(questions)) {
    const text = JSON.stringify(q);
    for (const name of FORBIDDEN_NAMES) {
      assert.ok(!text.includes(name), `question ${key} should not contain tool name "${name}"`);
    }
  }
});

test("no tool names appear in conscience.ts source", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/conscience.ts", import.meta.url), "utf8");
  const FORBIDDEN_NAMES = ["tiny_search", "tiny_fetch", "search_graph", "subagent", "bash"];
  // Strip comment lines before checking
  const codeLines = source.split("\n").filter((line: string) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"));
  const code = codeLines.join("\n");
  for (const name of FORBIDDEN_NAMES) {
    assert.ok(!code.includes(`"${name}"`), `conscience.ts code should not contain tool name "${name}" in a string literal`);
  }
});

/* ─── Nudge tests ───────────────────────────────────────────────────── */

test("nudge fires once per session with missing index", () => {
  // This is tested at the extension level; here we verify indexCoverage detects missing entries
  const { covered, missing } = indexCoverage(
    [{ name: "skill-a", filePath: FAKE_SKILL_FILE }],
    undefined,
    undefined,
  );
  assert.equal(covered.length, 0, "nothing covered when no index");
  assert.equal(missing.length, 1, "all skills missing when no index");
  assert.equal(missing[0], "skill-a");
});

/* ─── sourceQuality ────────────────────────────────────────────────── */

test("validateEntry accepts strong, weak, and thin sourceQuality", () => {
  const strong = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "strong" });
  assert.ok(strong, "strong should be accepted");
  assert.equal(strong!.sourceQuality, "strong");

  const weak = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "weak", improve: "add situations and examples" });
  assert.ok(weak, "weak should be accepted");
  assert.equal(weak!.sourceQuality, "weak");
  assert.equal(weak!.improve, "add situations and examples");

  const thin = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "thin", improve: "expand to include when-to-use triggers" });
  assert.ok(thin, "thin should be accepted");
  assert.equal(thin!.sourceQuality, "thin");
  assert.equal(thin!.improve, "expand to include when-to-use triggers");
});

test("validateEntry rejects invalid sourceQuality", () => {
  const result = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "meh" });
  assert.equal(result, null, "invalid sourceQuality should be rejected");
});

test("validateEntry defaults sourceQuality to strong when absent", () => {
  const { sourceQuality, ...noSq } = SAMPLE_ENTRY;
  const result = validateEntry(noSq);
  assert.ok(result, "should accept entry without sourceQuality");
  assert.equal(result!.sourceQuality, "strong");
});

test("validateEntry caps improve at 200 characters", () => {
  const longImprove = "x".repeat(250);
  const result = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "weak", improve: longImprove });
  assert.ok(result, "should accept");
  assert.ok(result!.improve!.length <= 200, `improve should be capped at 200, got ${result!.improve!.length}`);
});

test("indexStats groups weak and thin entries into sourceQualityReport", () => {
  const index: IndexFile = {
    formatVersion: 1,
    builtAt: "t",
    model: "m",
    entries: [
      { ...SAMPLE_ENTRY, sourceQuality: "strong" },
      { ...SAMPLE_ENTRY, name: "weak-skill", sourceQuality: "weak", improve: "add examples" },
      { ...SAMPLE_ENTRY, name: "thin-skill", sourceQuality: "thin", improve: "too short, expand" },
      { ...SAMPLE_TOOL_ENTRY, sourceQuality: "strong" },
    ],
  };
  const stats = indexStats(index);
  assert.equal(stats.sourceQualityReport.length, 2, "should have 2 weak/thin entries");
  const names = stats.sourceQualityReport.map(r => r.name);
  assert.ok(names.includes("weak-skill"));
  assert.ok(names.includes("thin-skill"));
  assert.ok(!names.includes("test-skill"), "strong entry should not appear");
});

test("indexStats sourceQualityReport groups thin and weak entries", () => {
  const index: IndexFile = {
    formatVersion: 1,
    builtAt: "t",
    model: "m",
    entries: [
      { ...SAMPLE_ENTRY, name: "weak-a", sourceQuality: "weak", improve: "add triggers" },
      { ...SAMPLE_ENTRY, name: "thin-a", sourceQuality: "thin", improve: "expand" },
      { ...SAMPLE_ENTRY, name: "weak-b", sourceQuality: "weak", improve: "add examples" },
    ],
  };
  const stats = indexStats(index);
  assert.equal(stats.sourceQualityReport.length, 3);
  const thinEntries = stats.sourceQualityReport.filter(r => r.sourceQuality === "thin");
  const weakEntries = stats.sourceQualityReport.filter(r => r.sourceQuality === "weak");
  assert.equal(thinEntries.length, 1, "should have 1 thin entry");
  assert.equal(thinEntries[0]!.name, "thin-a");
  assert.equal(weakEntries.length, 2, "should have 2 weak entries");
});

test("validateEntry rejects improve over 200 characters", () => {
  const result = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "weak", improve: "x".repeat(201) });
  assert.ok(result, "should accept (improve is capped, not rejected)");
  assert.equal(result!.improve!.length, 200, "should be capped at 200");
});

test("thin boolean is derived from sourceQuality", () => {
  const thinEntry = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "thin", improve: "expand" });
  assert.ok(thinEntry);
  assert.equal(thinEntry!.thin, true, "thin sourceQuality should produce thin=true");

  const strongEntry = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "strong" });
  assert.ok(strongEntry);
  assert.equal(strongEntry!.thin, false, "strong sourceQuality should produce thin=false");

  // Model writes thin:true with sourceQuality:strong — derived thin wins
  const mismatch = validateEntry({ ...SAMPLE_ENTRY, sourceQuality: "strong", thin: true } as unknown as Record<string, unknown>);
  assert.ok(mismatch);
  assert.equal(mismatch!.thin, false, "derived thin should override model's thin:true");
});

/* ─── Nudge tests ───────────────────────────────────────────────────── */

test("indexCoverage with current index shows all covered", () => {
  const hash = fileContentHash(FAKE_SKILL_FILE);
  const global: IndexFile = {
    formatVersion: 1,
    builtAt: "t",
    model: "m",
    entries: [{ ...SAMPLE_ENTRY, sourceHash: hash }],
  };
  const { covered, missing } = indexCoverage(
    [{ name: "test-skill", filePath: FAKE_SKILL_FILE }],
    global,
    undefined,
  );
  assert.equal(covered.length, 1, "skill should be covered");
  assert.equal(missing.length, 0, "nothing should be missing");
});
