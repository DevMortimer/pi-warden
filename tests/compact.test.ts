import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompactSnapshot, compactAppendix, type CompactSnapshot } from "../src/compact.js";
import { ContextLedger } from "../src/saver.js";
import { redact } from "../src/redact.js";

function attempt(key: string, call: string, failed: boolean, output: string) {
  return { key, call, failed, output };
}

const EMPTY: CompactSnapshot = { savedOutputs: [], checks: [], holds: [], failedAttempts: [], verification: undefined, stuck: undefined, activeTask: undefined };

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
    failedAttempts: [{ call: "npm run build", error: "error TS2322: Type 'string' is not assignable to type 'number'." }],
    verification: { kind: "passed", command: "npm run check", changedSince: false },
    stuck: { failures: 3, window: 8 },
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
  assert.match(text, /### Tried and failed/);
  assert.match(text, /### Verification/);
  // Checks are present (the strings contain the command names).
  assert.match(text, /npm run check/);
  assert.match(text, /npm run test/);
  // Held actions contain the tool and outcome.
  assert.match(text, /bash.*approved/);
  assert.match(text, /write.*replanned/);
  // Stuck state shows failures out of the window, and no placeholder values.
  assert.match(text, /failures: 3 of the last 8 tool results/);
  assert.doesNotMatch(text, /undefined|unknown/);
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
    activeTask: undefined, runs: 1,
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
    activeTask: undefined, runs: 1,
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
    activeTask: undefined, runs: 1,
  });
  assert.equal(built.checks[0]!.when, "current run");
});

test("buildCompactSnapshot: run label includes run index when runs>1", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [{ command: "tsc", passed: false, runIndex: 2, indexInRun: 1 }], holds: [],
    activeTask: undefined, runs: 2,
  });
  assert.equal(built.checks[0]!.when, "run 2, #2");
});

test("buildCompactSnapshot: stuck state counts failures in the attempt window", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [], holds: [],
    attempts: [attempt("a", "npm test", true, "boom"), attempt("b", "ls", false, "ok"), attempt("a", "npm test", true, "boom")],
    activeTask: "test", runs: 1,
  });
  assert.deepEqual(built.stuck, { failures: 2, window: 3 });
});

test("buildCompactSnapshot: activeTask is redacted", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [], holds: [],
    activeTask: "Use the secret key sk-1234567890abcdef1234", runs: 1,
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
    failedAttempts: [],
    verification: undefined,
    stuck: { failures: 5, window: 12 },
    activeTask: "c".repeat(200),
  };
  const text = compactAppendix(snapshot);
  assert.ok(text.length <= 2000, `expected <=2000 chars, got ${text.length}`);
  if (text.length === 2000) {
    assert.match(text, /\u2026 \[truncated\]/);
  }
});

test("tried and failed: each distinct failed call once, latest error, oldest first, at most 5", () => {
  const attempts = [
    attempt("k1", "npm test", true, "FAIL tests/a.test.ts\n  Expected true, got false\n\n1 failing"),
    attempt("k2", "git push", true, "fatal: no upstream configured"),
    attempt("k3", "cat notes.md", false, "all fine"),
    attempt("k1", "npm test", true, "Error: Cannot find module './b.js'\n    at load (node:internal)\n"),
    ...["k4", "k5", "k6", "k7"].map(key => attempt(key, `make ${key}`, true, `${key} exploded`)),
  ];
  const built = buildCompactSnapshot({ savedOutputs: [], checks: [], holds: [], attempts, activeTask: undefined, runs: 1 });
  assert.deepEqual(built.failedAttempts.map(a => a.call), ["npm test", "make k4", "make k5", "make k6", "make k7"], "git push is the oldest of six and drops");
  assert.equal(built.failedAttempts[0]!.error, "Error: Cannot find module './b.js'", "the latest error of a repeated call, its error line not the stack frame");
  const text = compactAppendix(built);
  assert.match(text, /### Tried and failed/);
  assert.equal(text.match(/npm test/g)?.length, 1, "deduplicated by call");
  assert.match(text, /- npm test → Error: Cannot find module '\.\/b\.js'/);
  assert.ok(text.indexOf("make k4") < text.indexOf("make k7"), "oldest to newest");
  assert.doesNotMatch(text, /cat notes\.md/, "successful calls are not listed");
});

test("tried and failed: entries are at most 160 characters and redacted", () => {
  const built = buildCompactSnapshot({
    savedOutputs: [], checks: [], holds: [],
    attempts: [attempt("k", `curl -H 'Authorization: Bearer sk-live-abcdefghij1234567890abcdef' ${"x".repeat(200)}`, true, `[500 earlier chars] …error: ${"y".repeat(300)}`)],
    activeTask: undefined, runs: 1,
  });
  const text = compactAppendix(built);
  const entry = text.split("\n").find(line => line.startsWith("- curl"))!;
  assert.ok(entry.length - 2 <= 160, `entry is ${entry.length - 2} chars`);
  assert.ok(!text.includes("sk-live-abcdefghij1234567890abcdef"));
  assert.doesNotMatch(text, /earlier chars/);
});

test("verification: passed and unchanged, passed then changed, none passed, nothing to say", () => {
  const verification = (evidence: { mutations: number; checksBeforeMutation?: number; checks: Array<{ call: string; passed: boolean }> }) =>
    compactAppendix(buildCompactSnapshot({ savedOutputs: [], checks: [], holds: [], evidence, activeTask: undefined, runs: 1 }));
  // Edit, then a passing check: the check covers the code.
  assert.match(verification({ mutations: 1, checksBeforeMutation: 0, checks: [{ call: "npm run check", passed: true }] }),
    /- last passing check: npm run check; code changed since last passing check: no/);
  // Passing check, then an edit, then a failing check: the pass no longer covers the code.
  assert.match(verification({ mutations: 1, checksBeforeMutation: 1, checks: [{ call: "npm test", passed: true }, { call: "npm run lint", passed: false }] }),
    /- last passing check: npm test; code changed since last passing check: yes/);
  // Edits and only failing checks.
  assert.match(verification({ mutations: 2, checksBeforeMutation: 1, checks: [{ call: "npm test", passed: false }] }),
    /- no check has passed yet; code was changed/);
  // No edit, no pass.
  assert.doesNotMatch(verification({ mutations: 0, checks: [{ call: "npm test", passed: false }] }), /### Verification/);
});

test("saved outputs show the real tool and byte size", () => {
  const ledger = new ContextLedger();
  ledger.record("/tmp/pi-warden-output-a/output.txt", 30_000, { tool: "bash", bytes: 34_567 });
  ledger.record("/tmp/pi-warden-output-b/output.txt", 9_000, { tool: "ctx_execute", bytes: 12_345 });
  const text = compactAppendix(buildCompactSnapshot({ savedOutputs: ledger.storedOutputs(), checks: [], holds: [], activeTask: undefined, runs: 1 }));
  assert.match(text, /- bash → \/tmp\/pi-warden-output-a\/output\.txt \(34567 bytes\)/);
  assert.match(text, /- ctx_execute → \/tmp\/pi-warden-output-b\/output\.txt \(12345 bytes\)/);
  assert.doesNotMatch(text, /unknown|\(0 bytes\)/);
});

test("saved outputs recorded without a source show only the path", () => {
  const ledger = new ContextLedger();
  ledger.record("/tmp/pi-warden-output-c/output.txt", 5_000);
  assert.deepEqual(ledger.storedOutputs(), [{ tool: undefined, path: "/tmp/pi-warden-output-c/output.txt", bytes: undefined }]);
  const text = compactAppendix(buildCompactSnapshot({ savedOutputs: ledger.storedOutputs(), checks: [], holds: [], activeTask: undefined, runs: 1 }));
  assert.match(text, /\n- \/tmp\/pi-warden-output-c\/output\.txt\n/);
  assert.doesNotMatch(text, /unknown|bytes\)|undefined|→/);
});

test("over the cap: saved outputs shrink to the 3 newest, then holds go, and failed attempts and verification stay whole", () => {
  const attempts = Array.from({ length: 5 }, (_, i) => attempt(`k${i}`, `npm run step-${i} ${"a".repeat(60)}`, true, `error: step ${i} ${"e".repeat(120)}`));
  const built = buildCompactSnapshot({
    savedOutputs: Array.from({ length: 8 }, (_, i) => ({ tool: "bash", path: `/tmp/pi-warden-output-${i}/output.txt`, bytes: 1000 + i })),
    checks: [{ command: "npm run check", passed: true, runIndex: 1, indexInRun: 0 }],
    holds: Array.from({ length: 10 }, (_, i) => ({ tool: "bash", preview: `rm -rf build-${i} ${"h".repeat(60)}`, outcome: "approved" })),
    attempts,
    evidence: { mutations: 1, checksBeforeMutation: 1, checks: [{ call: "npm run check", passed: true }] },
    activeTask: "Fix the build",
    runs: 1,
  });
  const text = compactAppendix(built);
  assert.ok(text.length <= 2000, `got ${text.length}`);
  assert.doesNotMatch(text, /\[truncated\]/);
  assert.doesNotMatch(text, /### Held actions/, "holds dropped");
  assert.equal(text.match(/pi-warden-output-/g)?.length, 3, "three newest saved outputs kept");
  assert.match(text, /pi-warden-output-7/);
  assert.doesNotMatch(text, /pi-warden-output-4\//);
  for (let i = 0; i < 5; i++) assert.match(text, new RegExp(`npm run step-${i}`));
  assert.match(text, /code changed since last passing check: yes/);
});

test("sample appendix: 2 failed attempts, 1 passing check, a later edit, 2 saved outputs", () => {
  const text = compactAppendix(buildCompactSnapshot({
    savedOutputs: [
      { tool: "bash", path: "/tmp/pi-warden-output-a/output.txt", bytes: 48213 },
      { tool: "ctx_execute", path: "/tmp/pi-warden-output-b/output.txt", bytes: 20480 },
    ],
    checks: [{ command: "npm run check", passed: true, runIndex: 1, indexInRun: 0 }],
    holds: [],
    attempts: [
      attempt("k1", "npm run build", true, "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error."),
      attempt("k2", "node scripts/migrate.mjs --dry-run", true, "Error: ENOENT: no such file or directory, open 'data/seed.json'\n    at open (node:fs)"),
      attempt("k3", "npm run check", false, "all passed"),
    ],
    evidence: { mutations: 2, checksBeforeMutation: 1, checks: [{ call: "npm run check", passed: true }] },
    activeTask: "Make the migration script read the seed file",
    runs: 1,
  }));
  if (process.env.PI_WARDEN_PRINT_SAMPLE) console.log(text);
  assert.match(text, /### Tried and failed[\s\S]*npm run build → src\/a\.ts\(3,7\): error TS2322[\s\S]*node scripts\/migrate\.mjs --dry-run → Error: ENOENT/);
  assert.match(text, /code changed since last passing check: yes/);
  assert.match(text, /ctx_execute → \/tmp\/pi-warden-output-b\/output\.txt \(20480 bytes\)/);
});
