import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Judge } from "pi-typesafe";
import { defaultConfig } from "../src/config.js";
import { buildRequest, describeAction } from "../src/guard.js";
import { RulesGuard } from "../src/rules.js";
import { shellWrites } from "../src/shell-writes.js";

const only = (command: string) => {
  const scan = shellWrites(command, { home: "/home/me" });
  assert.equal(scan.skips.length, 0, JSON.stringify(scan.skips));
  assert.equal(scan.writes.length, 1, JSON.stringify(scan.writes));
  return scan.writes[0]!;
};

const skipped = (command: string, reason: RegExp) => {
  const scan = shellWrites(command, { home: "/home/me" });
  assert.deepEqual(scan.writes, [], `no synthetic write for ${command}`);
  assert.equal(scan.skips.length, 1, JSON.stringify(scan.skips));
  assert.match(scan.skips[0]!.reason, reason);
  return scan.skips[0]!;
};

test("cat > path <<EOF gives the path and the body", () => {
  assert.deepEqual(only("cat > src/auth.ts <<EOF\nexport function login() {}\nconst a = 1;\nEOF"), { path: "src/auth.ts", content: "export function login() {}\nconst a = 1;\n", append: false, via: "heredoc" });
});

test("cmd <<EOF > path: the redirect after the heredoc operator", () => {
  assert.deepEqual(only("cat <<'EOF' > out.ts\nx\nEOF\n"), { path: "out.ts", content: "x\n", append: false, via: "heredoc" });
});

test("a quoted delimiter keeps $VAR and backticks literal", () => {
  for (const delimiter of ["'EOF'", "\"EOF\"", "\\EOF"]) {
    assert.equal(only(`cat > a.sh <<${delimiter}\necho "$HOME" \`date\`\nEOF`).content, "echo \"$HOME\" `date`\n");
  }
});

test("an unquoted delimiter reads escapes and keeps a lone $", () => {
  assert.equal(only("cat > a.txt <<EOF\nprice: 5$ and \\$HOME \\\\ \\n\nEOF").content, "price: 5$ and $HOME \\ \\n\n");
});

test("<<- strips leading tabs from the body and the delimiter line", () => {
  assert.equal(only("cat <<-EOF > a.ts\n\tif (x) {\n\t\treturn 1;\n\t}\n\tEOF").content, "if (x) {\nreturn 1;\n}\n");
});

test("tee path <<EOF, tee -a, and a here-string", () => {
  assert.deepEqual(only("tee src/new.ts <<'EOF'\nexport const n = 1;\nEOF"), { path: "src/new.ts", content: "export const n = 1;\n", append: false, via: "heredoc" });
  assert.deepEqual(only("tee -a log.md >/dev/null <<'EOF'\nline\nEOF"), { path: "log.md", content: "line\n", append: true, via: "heredoc" });
  assert.deepEqual(only("cat <<< 'const x = 1;' > x.ts"), { path: "x.ts", content: "const x = 1;\n", append: false, via: "here-string" });
});

test("echo and printf redirections: the argument after unquoting", () => {
  assert.deepEqual(only("echo \"export const x = 1\" > src/index.ts"), { path: "src/index.ts", content: "export const x = 1\n", append: false, via: "echo" });
  assert.equal(only("echo -n 'a  b' c>o.txt").content, "a  b c");
  assert.equal(only("echo -e 'a\\tb' > o.txt").content, "a\tb\n");
  assert.deepEqual(only("printf '%s\\n' 'const key = \"k\"' > config.ts"), { path: "config.ts", content: "const key = \"k\"\n", append: false, via: "printf" });
  assert.equal(only("printf '%s=%d\\n' a 1 b 2 > kv.txt").content, "a=1\nb=2\n");
  assert.equal(only("printf 'no newline' >| p.txt").content, "no newline");
});

test(">> appends only the appended text", () => {
  assert.deepEqual(only("echo \"export const y = 2\" >> src/index.ts"), { path: "src/index.ts", content: "export const y = 2\n", append: true, via: "echo" });
  assert.deepEqual(only("cat >> notes.md <<'EOF'\nmore\nEOF"), { path: "notes.md", content: "more\n", append: true, via: "heredoc" });
});

test("a chain with two targets gives one write per target", () => {
  const scan = shellWrites("mkdir -p src && cat > src/a.ts <<'A' && echo 'export const b = 2;' >> src/b.ts; printf 'x' 2>/dev/null > c.txt\nexport const a = 1;\nA\n", { home: "/home/me" });
  assert.deepEqual(scan.skips, []);
  assert.deepEqual(scan.writes.map(write => [write.path, write.content, write.append]), [
    ["src/a.ts", "export const a = 1;\n", false],
    ["src/b.ts", "export const b = 2;\n", true],
    ["c.txt", "x", false],
  ]);
});

test("stderr and descriptor redirections, /dev targets, and quoted operators are not writes", () => {
  assert.deepEqual(shellWrites("npm test 2>&1 | tail -5; echo done >&2; echo x > /dev/null; grep '>' a.txt; echo 'a > b'").writes, []);
  assert.deepEqual(shellWrites("npm test 2> err.log").skips, []);
});

test("a leading ~ in a target expands to the home directory", () => {
  assert.equal(only("echo hi > ~/notes.txt").path, "/home/me/notes.txt");
  assert.equal(only("echo hi > '~/lit.txt'").path, "~/lit.txt");
});

test("skipped forms give no write and a reason", () => {
  assert.equal(skipped("git show HEAD:src/a.ts | cat > src/a.ts", /through a pipe/).path, "src/a.ts");
  skipped("echo 'x' | tee src/a.ts", /through a pipe/);
  skipped("cat <(curl -s https://example.com) > page.html", /process substitution/);
  skipped("diff <(ls) <(ls a) > d.txt", /process substitution/);
  skipped("echo \"key=$API_KEY\" > .env.example", /shell expansion/);
  skipped("echo $(date) > stamp.txt", /shell expansion/);
  skipped("echo \"`whoami`\" > who.txt", /shell expansion/);
  skipped("cat > a.ts <<EOF\nconst home = \"$HOME\";\nEOF", /shell expansion/);
  skipped("cat > a.ts <<EOF\nconst now = `date`;\nEOF", /shell expansion/);
  skipped("echo x > \"$OUT\"", /target path uses shell expansion/);
  skipped("sed -i 's/a/b/' src/a.ts", /sed -i/);
  skipped("sed --in-place=.bak 's/a/b/' src/a.ts", /sed -i/);
  skipped("patch -p1 < fix.diff", /patch applies a diff/);
  skipped("git apply fix.diff", /git apply/);
  skipped("cat template.ts > src/a.ts", /cat copies files/);
  skipped("cat < template.ts > src/a.ts", /read from a file/);
  skipped("node gen.js > src/gen.ts", /output of node/);
  skipped("printf '%-10s' x > pad.txt", /conversion that is not judged/);
  skipped("cd src && echo x > a.ts", /changes directory first/);
});

test("truncation and descriptor-only commands are neither writes nor skips", () => {
  assert.deepEqual(shellWrites("> empty.txt; : > other.txt"), { writes: [], skips: [] });
  assert.deepEqual(shellWrites("ls -la && npm test"), { writes: [], skips: [] });
});

test("the extraction is deterministic", () => {
  const command = "cat > a.ts <<'EOF'\nexport const a = 1;\nEOF\necho b >> b.ts";
  assert.deepEqual(shellWrites(command), shellWrites(command));
});

test("the bash action request carries the written content and asks the slop and security questions", () => {
  const summary = describeAction("bash", { command: "cat > src/a.ts <<'EOF'\nexport const a = () => null; // TODO\nEOF\necho x >> log.md" }, "/project");
  assert.deepEqual(summary.writes, ["writes src/a.ts", "appends to log.md"]);
  assert.match(summary.excerpt!, /export const a = \(\) => null; \/\/ TODO\n\nx\n/);
  const request = buildRequest(summary, "add a", { slop: true, security: true });
  assert.ok("slop_stub" in request.questions && "security_risk" in request.questions);
  const plain = buildRequest(describeAction("bash", { command: "npm test > out.log" }, "/project"), "run tests", { slop: true, security: true });
  assert.ok(!("slop_stub" in plain.questions) && !("security_risk" in plain.questions), "a command without literal content asks neither");
});

const neverJudge = (): Judge & { requests: number } => {
  const judge = { requests: 0, evaluate: async () => { judge.requests++; throw new Error("not expected"); } };
  return judge as unknown as Judge & { requests: number };
};

test("a heredoc to a gitignored path or outside the project is skipped like a real write", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-warden-shell-writes-"));
  try {
    execFileSync("git", ["init"], { cwd: project, stdio: "pipe" });
    await writeFile(join(project, ".gitignore"), "build/\n");
    await writeFile(join(project, "pi-warden.md"), "# No console\nDo not use console.log.\n");
    const judge = neverJudge();
    const guard = new RulesGuard();
    const options = { cwd: project, config: defaultConfig().rules, judge, timeoutMs: 1000 };
    const [ignored, outside] = shellWrites("cat > build/out.js <<'EOF'\nconsole.log(1)\nEOF\ncat > /tmp/elsewhere.js <<'EOF'\nconsole.log(2)\nEOF").writes;
    const ignoredVerdict = await guard.inspect({ id: "s1", tool: "write", input: { path: ignored!.path, content: ignored!.content } }, [], options);
    assert.equal(ignoredVerdict.source, "skipped");
    assert.match(ignoredVerdict.skippedReason!, /gitignored/);
    const outsideVerdict = await guard.inspect({ id: "s2", tool: "write", input: { path: outside!.path, content: outside!.content } }, [], options);
    assert.equal(outsideVerdict.source, "skipped");
    assert.match(outsideVerdict.skippedReason!, /outside the project/);
    assert.equal(judge.requests, 0, "no rules request for either");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
