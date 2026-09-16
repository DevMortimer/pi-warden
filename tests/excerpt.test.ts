import assert from "node:assert/strict";
import { test } from "node:test";
import { formatExcerpt, formatQuestion } from "../src/excerpt.js";
import type { OutputFormat } from "../src/excerpt.js";

const noise = (n: number) => Array.from({ length: n }, (_, i) => `progress step ${i} complete`).join("\n");

test("the format question offers every parser and an explicit other", () => {
  const options = Object.keys(formatQuestion.format.criteria).sort();
  assert.deepEqual(options, ["eslint", "git_diff", "git_log", "node_test", "npm_install", "other", "pytest", "tsc", "vitest_jest"]);
  assert.equal(formatExcerpt("anything", "other"), undefined);
});

test("vitest and jest excerpts keep failing tests with their assertion lines and the summary, not passing noise", () => {
  const vitest = [noise(200), " ✓ tests/b.test.ts (3 tests) 5ms", " ❯ tests/a.test.ts (2 tests | 1 failed) 12ms", "   ✓ subtracts", "   × adds numbers", "     → expected 3 to be 4", "", " Test Files  1 failed | 1 passed (2)", "      Tests  1 failed | 4 passed (5)", "   Duration  1.20s"].join("\n");
  const out = formatExcerpt(vitest, "vitest_jest")!;
  assert.match(out, /× adds numbers/);
  assert.match(out, /expected 3 to be 4/);
  assert.match(out, /Tests {2}1 failed \| 4 passed/);
  assert.ok(!out.includes("progress step 5 complete"));
  assert.ok(!out.includes("✓ subtracts"));
  const jest = ["PASS src/a.test.ts", "FAIL src/b.test.ts", "  ● Calculator › adds", "", "    expect(received).toBe(expected)", "    Expected: 4", "    Received: 3", "      at Object.<anonymous> (src/b.test.ts:9:20)", "", "Test Suites: 1 failed, 1 passed, 2 total", "Tests:       1 failed, 3 passed, 4 total"].join("\n");
  const jestOut = formatExcerpt(jest, "vitest_jest")!;
  assert.match(jestOut, /● Calculator › adds/);
  assert.match(jestOut, /Expected: 4/);
  assert.match(jestOut, /Tests: {7}1 failed/);
  assert.equal(formatExcerpt(noise(50), "vitest_jest"), undefined, "no markers, no parser");
});

test("node:test excerpts work for TAP and the spec reporter", () => {
  const tap = ["TAP version 13", "# Subtest: adds", "ok 1 - adds", "# Subtest: fails", "not ok 2 - fails", "  ---", "  error: 'expected 1 to equal 2'", "  code: 'ERR_ASSERTION'", "  ...", "1..2", "# tests 2", "# pass 1", "# fail 1"].join("\n");
  const out = formatExcerpt(tap, "node_test")!;
  assert.match(out, /not ok 2 - fails/);
  assert.match(out, /expected 1 to equal 2/);
  assert.match(out, /# fail 1/);
  assert.ok(!out.includes("ok 1 - adds"));
  const spec = ["✔ adds (1.2ms)", "✖ fails (0.8ms)", "  AssertionError [ERR_ASSERTION]: expected 1 to equal 2", "      at TestContext.<anonymous> (file:///t.js:4:10)", "ℹ tests 2", "ℹ pass 1", "ℹ fail 1"].join("\n");
  const specOut = formatExcerpt(spec, "node_test")!;
  assert.match(specOut, /✖ fails/);
  assert.match(specOut, /ℹ fail 1/);
});

test("tsc, eslint, and pytest excerpts keep locations and messages", () => {
  const tsc = [noise(30), "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.", "src/b.ts:3:1 - error TS1005: ';' expected.", "", "Found 2 errors in 2 files.", "", "Errors  Files", "     1  src/a.ts:12"].join("\n");
  const tscOut = formatExcerpt(tsc, "tsc")!;
  assert.match(tscOut, /src\/a\.ts\(12,5\): error TS2322/);
  assert.match(tscOut, /src\/b\.ts:3:1 - error TS1005/);
  assert.match(tscOut, /Found 2 errors/);
  const eslint = ["", "/repo/src/a.ts", "  10:3  error    'x' is assigned a value but never used  no-unused-vars", "  12:1  warning  Unexpected console statement            no-console", "", "/repo/src/clean.ts", "", "✖ 2 problems (1 error, 1 warning)", ""].join("\n");
  const eslintOut = formatExcerpt(eslint, "eslint")!;
  assert.match(eslintOut, /\/repo\/src\/a\.ts\n {2}10:3 {2}error/);
  assert.match(eslintOut, /✖ 2 problems/);
  assert.ok(!eslintOut.includes("clean.ts"), "files without problems are dropped");
  const pytest = ["============================= test session starts ==============================", "collected 3 items", "", "tests/test_a.py ..F                                                       [100%]", "", "=================================== FAILURES ===================================", "__________________________________ test_add ____________________________________", "", "    def test_add():", ">       assert add(1, 2) == 4", "E       assert 3 == 4", "E        +  where 3 = add(1, 2)", "", "tests/test_a.py:7: AssertionError", "=========================== short test summary info ============================", "FAILED tests/test_a.py::test_add - assert 3 == 4", "========================= 1 failed, 2 passed in 0.05s =========================="].join("\n");
  const pytestOut = formatExcerpt(pytest, "pytest")!;
  assert.match(pytestOut, /_+ test_add _+/);
  assert.match(pytestOut, /E {7}assert 3 == 4/);
  assert.match(pytestOut, /FAILED tests\/test_a\.py::test_add/);
  assert.match(pytestOut, /1 failed, 2 passed/);
  assert.ok(!pytestOut.includes("collected 3 items"));
});

test("git and npm excerpts reduce to file counts, commit subjects, and package manager notices", () => {
  const diff = ["diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", "diff --git a/src/new.ts b/src/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+export {};", "+// new"].join("\n");
  const diffOut = formatExcerpt(diff, "git_diff")!;
  assert.match(diffOut, /src\/a\.ts {2}\+2 -1/);
  assert.match(diffOut, /src\/new\.ts {2}\+2 -0 {2}\(new file mode 100644\)/);
  assert.match(diffOut, /2 files changed, \+4 -1/);
  assert.ok(!diffOut.includes("const c = 4"));
  const log = ["commit 0123456789abcdef0123456789abcdef01234567", "Author: A <a@example.invalid>", "Date:   Mon Jan 1 00:00:00 2024 +0000", "", "    Fix the parser", "", "    Longer body text that is not needed.", "", "commit 89abcdef0123456789abcdef0123456789abcdef", "Author: B <b@example.invalid>", "", "    Add tests"].join("\n");
  const logOut = formatExcerpt(log, "git_log")!;
  assert.match(logOut, /0123456789ab {2}Fix the parser/);
  assert.match(logOut, /89abcdef0123 {2}Add tests/);
  assert.ok(!logOut.includes("Longer body"));
  assert.ok(!logOut.includes("Author"));
  const status = ["On branch main", "Changes not staged for commit:", "  (use \"git add <file>...\" to update what will be committed)", "", "\tmodified:   src/a.ts", "", "Untracked files:", "\tnew.txt", ""].join("\n");
  assert.match(formatExcerpt(status, "git_log")!, /modified: {3}src\/a\.ts/);
  const npm = [noise(20), "npm warn deprecated inflight@1.0.6: This module is not supported", "", "added 412 packages, and audited 413 packages in 9s", "", "62 packages are looking for funding", "", "2 moderate severity vulnerabilities", "", "To address all issues, run:", "  npm audit fix"].join("\n");
  const npmOut = formatExcerpt(npm, "npm_install")!;
  assert.match(npmOut, /npm warn deprecated inflight/);
  assert.match(npmOut, /added 412 packages/);
  assert.match(npmOut, /2 moderate severity vulnerabilities/);
  assert.ok(!npmOut.includes("progress step"));
  assert.equal(formatExcerpt(noise(20), "npm_install"), undefined);
});

test("excerpts are capped and always end with the last non-empty lines", () => {
  const many = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts(1,1): error TS2322: Type 'a' is not assignable to type 'b'.`).join("\n") + "\nFound 500 errors in 500 files.";
  const out = formatExcerpt(many, "tsc")!;
  assert.ok(out.length <= 6200, `length ${out.length}`);
  assert.match(out, /omitted for size/);
  assert.match(out, /Found 500 errors in 500 files\.$/);
  for (const format of ["vitest_jest", "node_test", "tsc", "eslint", "pytest", "git_diff", "git_log", "npm_install"] as OutputFormat[]) {
    assert.equal(formatExcerpt("", format), undefined, `${format} on empty text`);
  }
});
