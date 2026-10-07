/**
 * The action guard reads a script that a command runs from disk: a shell script, a `package.json` script, a make
 * recipe, or a file an interpreter runs. The body gets the same pattern floor as a typed command, and a body hit makes
 * the ask gate ask. These tests pin the forms, the safety limits (outside the project, symlinked out, over 64 KB, one
 * level only), the exemption, and the redacted, capped `script_lines` the request carries.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { actionAskGate } from "../src/ask-gate.js";
import { defaultConfig } from "../src/config.js";
import { evaluateAction, matchPatterns, stripDataText } from "../src/guard.js";
import type { Judge, PatternHit } from "../src/guard.js";
import { scriptSources } from "../src/script-bodies.js";

let cwd: string;

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-warden-script-"));
  await writeFile(join(cwd, "cleanup.sh"), 'rm -rf "$HOME/projects"\ngit push --force origin main\n');
  await writeFile(join(cwd, "only-rm.sh"), 'rm -rf "$HOME/projects"\n');
  await writeFile(join(cwd, "harmless.sh"), "echo ok\n");
  await writeFile(join(cwd, "other.sh"), 'rm -rf "$HOME/projects"\n');
  await writeFile(join(cwd, "nested.sh"), "bash other.sh\n");
  await writeFile(join(cwd, "package.json"), JSON.stringify({
    scripts: {
      clean: "rm -rf ~/projects && git push --force",
      prebuild: "rm -rf ~/projects",
      build: "echo ok",
      test: "rm -rf ~/projects",
      start: "git push --force origin main",
    },
  }));
  await writeFile(join(cwd, "Makefile"), "clean:\n\trm -rf ~/projects\n\nbuild:\n\t@echo ok\n");
  await writeFile(join(cwd, "script.js"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("/etc/passwd", "x");\n');
  await writeFile(join(cwd, "harm.js"), 'console.log("ok");\n');
  await writeFile(join(cwd, "script.py"), "import shutil\nshutil.rmtree('/tmp/x')\n");
  await writeFile(join(cwd, "harm.py"), "print('ok')\n");
  await writeFile(join(cwd, "big.sh"), `${"echo padding\n".repeat(6000)}rm -rf "$HOME/projects"\n`);
  await writeFile(join(cwd, "secret.sh"), "git push --force https://user:supersecretpw@example.com/repo main\n");
  await writeFile(join(cwd, "cap.sh"), Array.from({ length: 8 }, (_, i) => `rm -rf "$HOME/p${i}"`).join("\n") + "\n");
  await symlink("/etc/hosts", join(cwd, "escape.sh"));
});
after(async () => { await rm(cwd, { recursive: true, force: true }); });

const bodyHit = (command: string, options?: Parameters<typeof matchPatterns>[3]): PatternHit | undefined =>
  matchPatterns("bash", { command }, cwd, options).find(hit => hit.via !== undefined);
const asks = (command: string) => actionAskGate("bash", { command }, stripDataText(command).text, cwd);

test("a shell that runs a file gets that file's pattern hit, and its label names the file", () => {
  for (const command of ["bash cleanup.sh", "sh ./cleanup.sh", "zsh cleanup.sh", "dash cleanup.sh", "./cleanup.sh", "source cleanup.sh", ". cleanup.sh"]) {
    const hit = bodyHit(command);
    assert.ok(hit, `expected a body hit for: ${command}`);
    assert.ok(hit!.id === "rm-recursive-dangerous-target" || hit!.id === "git-force-push", `${command}: ${hit!.id}`);
    assert.match(hit!.label, /\(via .*cleanup\.sh\)/, `${command}: ${hit!.label}`);
    assert.equal(asks(command).ask, true, `${command}: the gate asks`);
    assert.match(asks(command).why, /^runs a script with /, `${command}: ${asks(command).why}`);
  }
});

test("a package.json script is read with pre and post scripts, and its label names the script", () => {
  const expected: Record<string, string> = {
    "npm run clean": "npm run clean",
    "pnpm run clean": "pnpm run clean",
    "yarn run clean": "yarn run clean",
    "bun run clean": "bun run clean",
    "npm test": "npm test",
    "npm start": "npm start",
    "npm run build": "npm run build",
  };
  for (const [command, source] of Object.entries(expected)) {
    const hit = bodyHit(command);
    assert.ok(hit, `expected a body hit for: ${command}`);
    assert.match(hit!.label, new RegExp(`\\(via ${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`), `${command}: ${hit!.label}`);
    assert.equal(asks(command).ask, true, `${command}: the gate asks`);
  }
});

test("a make recipe is read for the named target and for the default target", () => {
  const named = bodyHit("make clean");
  assert.ok(named);
  assert.match(named!.label, /\(via make clean\)/);
  const fallback = bodyHit("make");
  assert.ok(fallback);
  assert.match(fallback!.label, /\(via make\)/);
  assert.equal(bodyHit("make build"), undefined, "a harmless recipe is not a hit");
});

test("an interpreter file runs the ask gate's interpreter shape, not the shell floor", () => {
  for (const command of ["node script.js", "python3 script.py"]) {
    assert.equal(bodyHit(command), undefined, `${command}: no shell floor hit`);
    const decision = asks(command);
    assert.equal(decision.ask, true, `${command}: the gate asks`);
    assert.match(decision.why, /^runs a script with /, `${command}: ${decision.why}`);
  }
  assert.equal(asks("node harm.js").ask, false, "a harmless interpreter file stays offline");
  assert.equal(asks("python3 harm.py").ask, false);
});

test("harmless script forms behave as before: no hit, no ask", () => {
  assert.equal(bodyHit("bash harmless.sh"), undefined);
  assert.equal(asks("bash harmless.sh").ask, false);
  assert.equal(asks("node --test").ask, false, "no FILE argument, so nothing is read");
});

test("a body outside the project, a symlink that points out, and a body over 64 KB are not read", () => {
  assert.equal(asks("bash /etc/hosts").ask, false);
  assert.deepEqual(scriptSources("bash /etc/hosts", cwd), []);
  assert.deepEqual(scriptSources("bash escape.sh", cwd), [], "the symlink resolves outside the project and a temp root");
  assert.deepEqual(scriptSources("bash big.sh", cwd), [], "a body over 64 KB is not read");
  assert.equal(bodyHit("bash big.sh"), undefined);
});

test("a script the body calls is not followed", () => {
  assert.equal(bodyHit("bash nested.sh"), undefined);
  assert.equal(scriptSources("bash nested.sh", cwd).length, 1);
  assert.equal(asks("bash nested.sh").ask, false);
});

test("exemptRules silences a body hit", () => {
  assert.ok(bodyHit("bash only-rm.sh"));
  const exempted = bodyHit("bash only-rm.sh", { exemptRules: ["rm-recursive-dangerous-target"] });
  assert.equal(exempted, undefined);
});

test("a heredoc written and then run keeps the body in scope, as today", () => {
  const command = "cat <<'EOF' > run.sh\nrm -rf \"$HOME/projects\"\nEOF\nbash run.sh";
  assert.ok(matchPatterns("bash", { command }, cwd).some(hit => hit.id === "rm-recursive-dangerous-target"));
});

const judgeOf = (): Judge & { calls: Array<{ state: Record<string, unknown> }> } => {
  const calls: Array<{ state: Record<string, unknown> }> = [];
  return {
    calls,
    async evaluate(request) {
      calls.push(request as never);
      return { model: "jev-test", answers: { irreversible: { type: "noul", noul: 0.1 }, mutates: { type: "noul", noul: 0.6 }, visible: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 10, output_tokens: 0 }, elapsedMs: 1 } as never;
    },
  };
};

test("the request carries script_lines, redacted and capped", async () => {
  const capped = judgeOf();
  await evaluateAction({ tool: "bash", input: { command: "bash cap.sh" }, cwd, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge: capped });
  const capLines = capped.calls[0]!.state.script_lines as string;
  assert.ok(capLines, "script_lines is present");
  assert.ok(capLines.split("\n").length <= 5, "at most five lines");
  assert.ok(capLines.length <= 600, "at most 600 characters");

  const secret = judgeOf();
  await evaluateAction({ tool: "bash", input: { command: "bash secret.sh" }, cwd, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge: secret });
  const secretLines = secret.calls[0]!.state.script_lines as string;
  assert.ok(secretLines.includes("[redacted]"), secretLines);
  assert.ok(!secretLines.includes("supersecretpw"), "the credential value is not sent");
});
