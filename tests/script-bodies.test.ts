/**
 * The action guard reads a script that a command runs from disk: a shell script, a `package.json` script, a make
 * recipe, or a file an interpreter runs. The body gets the same pattern floor as a typed command, and a body hit makes
 * the ask gate ask. These tests pin the forms, the safety limits (outside the project, symlinked out, over 64 KB, one
 * level only), the exemption, and the redacted, capped `script_lines` the request carries.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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

// --- Text the shell never runs: comments, messages, and files a command only reads -------------

/** A project folder of its own, so its `package.json` and `scripts/` do not touch the fixtures above. */
const inertProject = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-inert-"));
  await mkdir(join(dir, "scripts"));
  await writeFile(join(dir, "scripts", "clean.sh"), '#!/bin/sh\nrm -rf "$1"\n');
  await chmod(join(dir, "scripts", "clean.sh"), 0o755);
  await writeFile(join(dir, "comment.sh"), '#!/bin/sh\n# never rm -rf "$dir" here\necho ok\n');
  await writeFile(join(dir, "say.sh"), '#!/bin/sh\necho "never rm -rf \\"$dir\\" here"\n');
  await writeFile(join(dir, "say-printf.sh"), "#!/bin/sh\nprintf '%s\\n' \"never rm -rf $dir here\"\n");
  await writeFile(join(dir, "noted.sh"), '#!/bin/sh\n# old: rm -rf "$HOME/projects"\nrm -rf "$1"\n');
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { clean: 'rm -rf "$1"' } }));
  return dir;
};
const bodyIds = (command: string, dir: string, options?: Parameters<typeof matchPatterns>[3]) =>
  matchPatterns("bash", { command }, dir, options).filter(hit => hit.via !== undefined).map(hit => `${hit.id} (via ${hit.via})`);

test("delete text in a script's comments or in its echo and printf messages is not held", async () => {
  const dir = await inertProject();
  try {
    for (const command of ["sh comment.sh", "sh say.sh", "sh say-printf.sh", "bash ./say.sh"]) assert.deepEqual(bodyIds(command, dir), [], command);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a grep or sed of a script, with \\| in its pattern, does not read the script as one that runs", async () => {
  const dir = await inertProject();
  try {
    for (const command of [
      'sed -n "/alpha\\|down=/p" scripts/clean.sh',
      "sed -n '/alpha\\|down=/p' scripts/clean.sh",
      'rtk grep -n "alpha\\|down=" scripts/clean.sh | head -20',
      "grep -n alpha\\|down= scripts/clean.sh",
      'awk "/x;y/" scripts/clean.sh',
    ]) {
      assert.deepEqual(bodyIds(command, dir), [], command);
      assert.deepEqual(scriptSources(stripDataText(command).text, dir), [], command);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("issue 190: a read-only grep of a file whose docstring names a confirmed command is not held", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-warden-190-"));
  try {
    await mkdir(join(repo, "scripts"));
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "scripts", "nest_sentry.py"), '#!/usr/bin/env python3\n"""Nest sentry.\n\nkill switch＝launchctl bootout gui/$UID/com.youtube-bgmv.nest-sentry。\n"""\nscan_alive = True\n');
    await chmod(join(repo, "scripts", "nest_sentry.py"), 0o644);
    await writeFile(join(repo, "scripts", "overseer_wake.py"), "down = 0\n");
    await writeFile(join(repo, "tests", "test_sentry.py"), "def test_scan_alive():\n    pass\n");
    const commandRules = [{ id: "launchctl-stop", pattern: "\\blaunchctl\\s+(bootout|unload|remove)\\b", severity: "confirm" as const }];
    const command = `cd ${repo}/ && rtk grep -n "scan_alive\\|COPILOT-DOWN\\|down=" scripts/nest_sentry.py scripts/overseer_wake.py | head -20; echo ===TESTS===; rtk grep -rln "scan_alive\\|COPILOT-DOWN" tests/ | head`;
    assert.deepEqual(scriptSources(stripDataText(command).text, repo), []);
    assert.deepEqual(matchPatterns("bash", { command }, repo, { commandRules }), []);
    // The same file, run by a shell in the same line, is read and confirmed.
    assert.deepEqual(bodyIds("grep -n down= scripts/nest_sentry.py; sh scripts/nest_sentry.py", repo, { commandRules }), ["launchctl-stop (via scripts/nest_sentry.py)"]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("every way of running a script is still read, also next to a read of the same file", async () => {
  const dir = await inertProject();
  try {
    for (const [command, via] of [
      ["sh scripts/clean.sh /tmp/x", "scripts/clean.sh"],
      ["bash scripts/clean.sh", "scripts/clean.sh"],
      ["./scripts/clean.sh", "./scripts/clean.sh"],
      [". scripts/clean.sh", "scripts/clean.sh"],
      ["source scripts/clean.sh", "scripts/clean.sh"],
      ["npm run clean", "npm run clean"],
      ["grep x scripts/clean.sh; sh scripts/clean.sh", "scripts/clean.sh"],
      ['grep "a\\|b" scripts/clean.sh && sh scripts/clean.sh', "scripts/clean.sh"],
      ["echo it\\'s; sh scripts/clean.sh", "scripts/clean.sh"],
      ["echo hi # it's\nsh scripts/clean.sh # it's", "scripts/clean.sh"],
      ["true `echo x` # it's\nsh scripts/clean.sh", "scripts/clean.sh"],
      ['echo "$(true && sh scripts/clean.sh x)"', "scripts/clean.sh"],
      ["cat <<'EOF' | bash\nsh scripts/clean.sh\nEOF", "scripts/clean.sh"],
      ['echo "unclosed; sh scripts/clean.sh', "scripts/clean.sh"],
    ] as const) assert.ok(bodyIds(command, dir).includes(`rm-recursive-dangerous-target (via ${via})`), `${command}: ${bodyIds(command, dir).join(", ")}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the hit lines of a script body leave out its comment lines", async () => {
  const dir = await inertProject();
  try {
    const hit = matchPatterns("bash", { command: "sh noted.sh" }, dir).find(entry => entry.via === "noted.sh");
    assert.ok(hit, "the code line still hits");
    assert.deepEqual(hit!.lines, ['rm -rf "$1"']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// --- Backslash-newlines and here-strings, read as bash reads them -------------------------------

/** A project of its own with one file per entry. */
const projectWith = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-continued-"));
  for (const [path, body] of Object.entries(files)) await writeFile(join(dir, path), body);
  return dir;
};

test("a backslash-newline before or inside a command that runs a script does not hide the script", async () => {
  const dir = await projectWith({
    "a.sh": "#!/bin/sh\nrm -rf ~\n",
    "package.json": JSON.stringify({ scripts: { clean: "rm -rf ~" } }),
    Makefile: "clean:\n\trm -rf ~\n",
  });
  try {
    for (const [command, via] of [
      ["true &&\\\nsh a.sh", "a.sh"],
      ["cd . && \\\n  sh a.sh", "a.sh"],
      ["\\\nsh a.sh", "a.sh"],
      ["cd . && \\\n  bash ./a.sh", "./a.sh"],
      ["cd . && \\\n  npm run clean", "npm run clean"],
      ["cd . && \\\n  make clean", "make clean"],
      ["sh \\\na.sh", "a.sh"],
      ["sh a\\\n.sh", "a.sh"],
      // A construct the comment scan does not model keeps the old reading: still held.
      ["echo $[1]; true &&\\\nsh a.sh", "a.sh"],
    ] as const) assert.ok(bodyIds(command, dir).includes(`rm-recursive-dangerous-target (via ${via})`), `${JSON.stringify(command)}: ${bodyIds(command, dir).join(", ")}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a here-string or a quoted << in a script body does not hide the delete after it", async () => {
  const bodies: Record<string, string> = {
    "sh-herestring.sh": "#!/bin/sh\ncat <<< b\nrm -rf ~\n",
    "bash-herestring.sh": "#!/bin/bash\ncat <<< b\nrm -rf ~\n",
    "sh-quoted-delimiter.sh": "#!/bin/sh\ncat <<E\"O\"F >/dev/null\nEOF\nrm -rf ~\n",
    "env-herestring.sh": "#!/usr/bin/env bash\ncat <<< b\nrm -rf ~\n",
    "bare-herestring.sh": "cat <<< b\nrm -rf ~\n",
    "single-quoted.sh": "#!/bin/sh\necho '<<F'\nrm -rf ~\n",
    "double-quoted.sh": "#!/bin/sh\necho \"<<F\"\nrm -rf ~\n",
    "tight-herestring.sh": "#!/bin/sh\ncat <<<b\nrm -rf ~\n",
  };
  const dir = await projectWith(bodies);
  try {
    for (const file of Object.keys(bodies)) assert.ok(bodyIds(`sh ${file}`, dir).includes(`rm-recursive-dangerous-target (via ${file})`), `${file}: ${bodyIds(`sh ${file}`, dir).join(", ")}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the ask gate reads a script named after a backslash-newline", async () => {
  const dir = await projectWith({ "push.sh": "git push origin main\n", "quiet.sh": "echo ok\n" });
  try {
    for (const command of ["\\\nsh push.sh", "cd . && \\\n  sh push.sh"]) {
      const decision = actionAskGate("bash", { command }, stripDataText(command).text, dir);
      assert.equal(decision.ask, true, JSON.stringify(command));
      assert.match(decision.why, /^runs a script with /, JSON.stringify(command));
      const judge = judgeOf();
      await evaluateAction({ tool: "bash", input: { command }, cwd: dir, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge });
      assert.equal(judge.calls.length, 1, `${JSON.stringify(command)}: evaluateAction asks the judge`);
    }
    assert.equal(actionAskGate("bash", { command: "cd . && \\\n  sh quiet.sh" }, stripDataText("cd . && \\\n  sh quiet.sh").text, dir).ask, false, "a harmless script stays offline");
    // A typed push split by a backslash-newline: the gate reads the joined text, not only a message that names a push.
    for (const command of ["g\\\nit push origin main", 'g\\\nit push origin main | echo "a; git push origin main"']) {
      const judge = judgeOf();
      await evaluateAction({ tool: "bash", input: { command }, cwd: dir, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge });
      assert.equal(judge.calls.length, 1, `${JSON.stringify(command)}: evaluateAction asks the judge`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the ask gate reads the command without its comments: a push only in a comment sends no request", async () => {
  const push = ["git", "push", "origin", "main"].join(" ");
  // mkdir is not read-only, so it reaches the gate; the read-only check already skipped the comment after ls.
  for (const [command, requests] of [[`ls # ${push}`, 0], [`ls; ${push}`, 1], [`mkdir -p build # ${push}`, 0], [`mkdir -p build; ${push}`, 1]] as const) {
    const judge = judgeOf();
    await evaluateAction({ tool: "bash", input: { command }, cwd, task: "list files" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge });
    assert.equal(judge.calls.length, requests, JSON.stringify(command));
  }
});

test("the drive's comment, echo message, and sed shapes still run", async () => {
  const dir = await inertProject();
  try {
    for (const command of [
      'touch "$HOME/pwv-a" # then rm -rf "$HOME/pwv-keep/../pwv-keep"',
      "sh ./say.sh",
      'sed -n "/alpha\\|down=/p" scripts/clean.sh; touch "$HOME/pwv-c"',
    ]) assert.deepEqual(matchPatterns("bash", { command }, dir), [], command);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** A project with `a.sh` and `sub/a.sh`, each of which deletes its first argument, and a `package.json` script in `sub/`. */
const shapesProject = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-shapes-"));
  await mkdir(join(dir, "sub"));
  for (const path of ["a.sh", "sub/a.sh"]) {
    await writeFile(join(dir, path), '#!/bin/sh\nrm -rf "$1"\n');
    await chmod(join(dir, path), 0o755);
  }
  await writeFile(join(dir, "sub", "package.json"), JSON.stringify({ scripts: { clean: 'rm -rf "$1"' } }));
  await writeFile(join(dir, "push.sh"), "git push origin main\n");
  return dir;
};
const labels = (command: string, dir: string) => scriptSources(command, dir).map(source => source.source);

test("scriptSources reads a script run inside a compound command, a substitution, -c, stdin, or a wrapper, and labels it", async () => {
  const dir = await shapesProject();
  try {
    for (const [command, label] of [
      ["(sh a.sh x)", "a.sh"],
      ["{ sh a.sh x; }", "a.sh"],
      ["if sh a.sh x; then :; fi", "a.sh"],
      ["if false; then :; else sh a.sh x; fi", "a.sh"],
      ["for i in 1; do sh a.sh x; done", "a.sh"],
      ["case x in x)sh a.sh x;esac", "a.sh"],
      ["f() { sh a.sh x; }; f", "a.sh"],
      ["function f { sh a.sh x; }; f", "a.sh"],
      ["! sh a.sh x", "a.sh"],
      ["{ ./a.sh x; }", "./a.sh"],
      ["(set -- x; . ./a.sh)", "./a.sh"],
      ["out=$(sh a.sh x)", "a.sh"],
      ["out=`sh a.sh x`", "a.sh"],
      ["diff <(sh a.sh x) /dev/null", "a.sh"],
      ["(cd sub && sh a.sh x)", "sub/a.sh"],
      ["bash -lc 'cd sub && sh a.sh x'", "sub/a.sh"],
      ["sh -c './a.sh x'", "./a.sh"],
      ['eval "sh a.sh x"', "a.sh"],
      ['sh "a.sh" x', "a.sh"],
      ['"./a.sh" x', "./a.sh"],
      ['set -- x; source "a.sh"', "a.sh"],
      ["sh < a.sh", "a.sh"],
      ["< a.sh bash", "a.sh"],
      ["bash -s x < a.sh", "a.sh"],
      ["cat a.sh | sh", "a.sh"],
      ["cat a.sh | bash -s x", "a.sh"],
      ["bash <(cat a.sh)", "a.sh"],
      ["source <(cat a.sh)", "a.sh"],
      ["timeout 5 sh a.sh x", "a.sh"],
      ["nice -n 5 sh a.sh x", "a.sh"],
      ["env -i PATH=/usr/bin:/bin sh a.sh x", "a.sh"],
      ["echo x | xargs sh a.sh", "a.sh"],
      ["(cd sub && npm run clean)", "npm run clean"],
      ['cat <("./a.sh" x)', "./a.sh"],
      ['echo "$("./a.sh" x)"', "./a.sh"],
      ["((cd sub && sh a.sh x))", "sub/a.sh"],
      ["cat <<'EOF' | bash\nsh a.sh x\nEOF", "a.sh"],
    ] as const) assert.deepEqual(labels(command, dir), [label], command);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("scriptSources reads no script where bash runs none, and follows a cd only in its own subshell", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ['echo "(sh a.sh x)"', "bash -c 'echo sh a.sh x'", "cat a.sh | grep x", "(cd sub && cat a.sh)", "if [ -f a.sh ]; then echo found; fi"]) {
      assert.deepEqual(labels(command, dir), [], command);
    }
    assert.deepEqual(labels("sh a.sh < sub/a.sh", dir), ["a.sh"], "a named file runs; the file on stdin is its input");
    assert.deepEqual(labels("(cd sub) && sh a.sh x", dir), ["a.sh"], "a cd in a subshell does not move the command after it");
    assert.deepEqual(labels("cd sub | true; sh a.sh x", dir), ["a.sh"], "a cd in a pipeline does not move the command after it");
    assert.deepEqual(labels("sh a.sh x; cd sub && sh a.sh x", dir), ["a.sh", "sub/a.sh"], "each directory's script is read");
    // A cd that may be skipped leaves both directories possible; one that always runs fails only on a missing target.
    for (const command of ["false && cd sub; ./a.sh x", "if true; then cd sub; fi; ./a.sh x", "f() { cd sub; }; ./a.sh x"]) {
      assert.deepEqual(labels(command, dir), ["sub/a.sh", "./a.sh"], command);
    }
    assert.deepEqual(labels("cd sub; ./a.sh x", dir), ["sub/a.sh"], "an unconditional cd to a directory that exists");
    assert.deepEqual(labels("cd missing; ./a.sh x", dir), ["./a.sh"], "a cd to a missing directory fails and stays");
    assert.deepEqual(labels("cat > notes.txt <<'EOF'\nsh a.sh x\nEOF", dir), [], "a heredoc written to a file runs nothing");
    assert.deepEqual(labels("cat > notes.txt <<EOF\n$(sh a.sh x)\nEOF", dir), ["a.sh"], "a substitution in an unquoted heredoc runs");
    // A wrapper execs a program, so a builtin after it changes nothing in this shell.
    assert.deepEqual(labels("timeout 5 cd sub; sh a.sh x", dir), ["a.sh"], "timeout 5 cd runs no builtin cd");
    assert.deepEqual(labels("nice -n 5 . ./a.sh", dir), [], "nice . runs no builtin source");
    assert.deepEqual(labels("builtin cd sub && sh a.sh x", dir), ["sub/a.sh"], "builtin cd is the builtin");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a branch or a function the floor does not evaluate is still read: the floor fails closed", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ["if false; then sh a.sh x; fi", "f() { sh a.sh x; }", "false && sh a.sh x"]) {
      assert.ok(bodyIds(command, dir).includes("rm-recursive-dangerous-target (via a.sh)"), `${command}: ${bodyIds(command, dir).join(", ")}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("source <(cat FILE) is held: bash 4 and later run it, though bash 3.2 runs nothing from it", async () => {
  const dir = await shapesProject();
  try {
    assert.deepEqual(bodyIds("source <(cat a.sh)", dir), ["rm-recursive-dangerous-target (via a.sh)"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a delete is read by the command word bash runs: quoted, escaped, a path, an empty expansion, or after a case pattern", async () => {
  const del = ["r", "m"].join("");
  for (const command of [`\\${del} -rf ~`, `"${del}" -rf ~`, `r''m -rf ~`, `/bin/${del} -rf ~`, `\${x}${del} -rf ~`, `sudo /bin/${del} -rf ~`,
    `case x in x)${del} -rf ~;; esac`, `bash -c '/bin/${del} -rf ~'`, `(cd /tmp && "${del}" -rf ~)`, `out=$(\\${del} -rf ~)`]) {
    assert.ok(matchPatterns("bash", { command }, cwd).some(hit => hit.id === "rm-recursive-dangerous-target"), command);
  }
  for (const command of [`echo "/bin/${del} -rf ~"`, `echo /bin/${del} -rf ~`, `grep '"${del}" -rf' notes.txt`]) {
    assert.ok(!matchPatterns("bash", { command }, cwd).some(hit => hit.id === "rm-recursive-dangerous-target"), command);
  }
  // A user rule reads the command as typed: the plain `rm` is only for the delete classifier.
  const commandRules = [{ id: "bin-rm", pattern: `/bin/${del}\\b`, severity: "confirm" as const }];
  assert.ok(matchPatterns("bash", { command: `/bin/${del} -rf build` }, cwd, { commandRules }).some(hit => hit.id === "bin-rm"));
});

test("script_lines carries a body delete written as /bin/rm", async () => {
  const dir = await shapesProject();
  try {
    await writeFile(join(dir, "b.sh"), `#!/bin/sh\n/bin/${["r", "m"].join("")} -rf ~\n`);
    const judge = judgeOf();
    await evaluateAction({ tool: "bash", input: { command: "(sh b.sh)" }, cwd: dir, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge });
    assert.equal(judge.calls.length, 1);
    assert.match(String(judge.calls[0]!.state.script_lines), /\/bin\/rm -rf ~/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the ask gate asks for a push in a script run inside a subshell, and not for a cat of it", async () => {
  const dir = await shapesProject();
  try {
    for (const [command, requests] of [["(sh push.sh)", 1], ["(cat push.sh)", 0]] as const) {
      const decision = actionAskGate("bash", { command }, stripDataText(command).text, dir);
      if (requests) assert.match(decision.why, /^runs a script with /, command);
      const judge = judgeOf();
      await evaluateAction({ tool: "bash", input: { command }, cwd: dir, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge });
      assert.equal(judge.calls.length, requests, command);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// --- Deep nesting, the roots rule, a quoted ~, and the other ways a shell is fed its code ---------

const DEL = `${["r", "m"].join("")} -rf ~`;
const parens = (n: number, inner: string) => "( ".repeat(n) + inner + " )".repeat(n);
/** Each construct the reader enters, nested `n` deep around `inner`. */
const nestings = (n: number, inner: string): Record<string, string> => ({
  "( )": parens(n, inner),
  "(( ))": "((".repeat(n) + inner + "))".repeat(n),
  "$( )": "echo " + "$(".repeat(n) + inner + ")".repeat(n),
  "backticks inside $( )": "echo " + "$(`".repeat(n / 2) + inner + "`)".repeat(n / 2),
  "<( )": "cat " + "<(true; cat ".repeat(n) + `<(${inner})` + ")".repeat(n),
  "{ }": "{ ".repeat(n) + `${inner};` + " }".repeat(n),
  "if": "if true; then ".repeat(n) + `${inner};` + " fi;".repeat(n),
  "case": "case x in x) ".repeat(n) + inner + " ;; esac".repeat(n),
  "${ }": "echo " + "${x:-".repeat(n) + `$(${inner}; true)` + "}".repeat(n),
  "\"$( )\"": "echo " + "\"$(echo ".repeat(n) + inner + ")\"".repeat(n),
  "an array of $( )": "a=($(".repeat(n) + inner + "))".repeat(n),
  "find -exec": "find . -exec ".repeat(n) + inner + " \\;".repeat(n),
  "a -c string inside": `sh -c '${parens(n, inner)}'`,
  "a -c string innermost": parens(n, `sh -c '${inner}'`),
  "eval inside": `eval '${parens(n, inner)}'`,
  "eval innermost": parens(n, `eval '${inner}'`),
  "a heredoc fed to a shell inside": `sh <<'EOF'\n${parens(n, inner)}\nEOF`,
  "a heredoc fed to a shell innermost": "(".repeat(n) + `sh <<'EOF'\n${inner}\nEOF\n` + ")".repeat(n),
  "env -S innermost": parens(n, `env -S '${inner}'`),
  "an unclosed (": "(".repeat(n) + inner,
  "an unclosed ((": "((".repeat(n) + inner,
});
const destructive = (hits: readonly PatternHit[]) => hits.some(hit => hit.severity === "destructive");

test("a delete nested 10,000 deep in any construct is held, and nothing the floor runs throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-deep-"));
  try {
    for (const [name, command] of Object.entries(nestings(10_000, DEL))) {
      assert.ok(destructive(matchPatterns("bash", { command }, dir)), `${name}: the floor holds it`);
      assert.doesNotThrow(() => scriptSources(command, dir), name);
      assert.doesNotThrow(() => actionAskGate("bash", { command }, stripDataText(command).text, dir), name);
    }
    // The same texts 2,000 deep as script bodies, under the 64 KB limit: the script search reads them, and script_lines
    // reaches the request.
    for (const [name, command] of Object.entries(nestings(2_000, DEL))) {
      await writeFile(join(dir, "deep.sh"), `${command}\n`);
      assert.ok(destructive(matchPatterns("bash", { command: "sh deep.sh" }, dir)), `${name}: the floor holds the body`);
      const judge = judgeOf();
      await evaluateAction({ tool: "bash", input: { command: "sh deep.sh" }, cwd: dir, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge });
      assert.equal(judge.calls.length, 1, name);
      assert.ok(judge.calls[0]!.state.script_lines, `${name}: script_lines is present`);
    }
    const heredocs = `${"cat <<E\nx\nE\n".repeat(80_000)}${DEL}\n`;
    assert.ok(destructive(matchPatterns("bash", { command: heredocs }, dir)), "80,000 heredocs, then a delete");
    assert.doesNotThrow(() => scriptSources(heredocs, dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** The paths a run asks the file system about. */
const fsPaths = (run: () => void): string[] => {
  const calls: string[] = [];
  const names = ["statSync", "lstatSync", "realpathSync", "readFileSync", "existsSync", "readdirSync", "openSync", "accessSync", "readlinkSync"] as const;
  const originals = names.map(name => fs[name]);
  names.forEach((name, index) => {
    const original = originals[index] as (...args: unknown[]) => unknown;
    const wrapped = function (this: unknown, path: unknown, ...rest: unknown[]) { calls.push(String(path)); return original.call(this, path, ...rest); };
    if ("native" in original) Object.assign(wrapped, { native: original.native });
    (fs as unknown as Record<string, unknown>)[name] = wrapped;
  });
  syncBuiltinESMExports();
  try { run(); } finally {
    names.forEach((name, index) => { (fs as unknown as Record<string, unknown>)[name] = originals[index]; });
    syncBuiltinESMExports();
  }
  return calls;
};

test("a path that dots out of a root, or names stdin, never reaches the file system", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-roots-"));
  try {
    await writeFile(join(dir, "a.sh"), "echo ok\n");
    const roots = [dir, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", tmpdir()];
    for (const command of ["sh /tmp/../net/x/a.sh", "sh /private/tmp/../../Volumes/x/a.sh", "source /tmp/../net/x/a.sh", "cat /tmp/../net/x/a.sh | sh", "sh ~/../../net/x/a.sh",
      "cd /tmp/../net/x; sh a.sh", "sh /dev/stdin < a.sh", "sh /dev/stdin", "bash /dev/fd/0 < a.sh", ". /dev/stdin < a.sh"]) {
      const outside = fsPaths(() => { scriptSources(command, dir); matchPatterns("bash", { command }, dir); })
        .map(path => resolve(dir, path)).filter(path => !roots.some(root => path === root || path.startsWith(`${root}/`)));
      assert.deepEqual(outside, [], command);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a quoted ~ is not expanded: bash looks for a folder named ~", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-tilde-"));
  const home = process.env.HOME;
  try {
    await mkdir(join(dir, "home"));
    await mkdir(join(dir, "proj"));
    await writeFile(join(dir, "home", "h.sh"), `#!/bin/sh\n${DEL}\n`);
    process.env.HOME = join(dir, "home");
    const proj = join(dir, "proj");
    for (const command of ['source "~/h.sh"', '. "~/h.sh"', "sh '~/h.sh'", 'sh "~/h.sh"', 'cd "~" && sh h.sh', "cd '~'; ./h.sh"]) {
      assert.deepEqual(labels(command, proj), [], command);
    }
    assert.deepEqual(labels("source ~/h.sh", proj), ["~/h.sh"], "an unquoted ~ is the home folder");
    assert.deepEqual(labels("cd ~ && sh h.sh", proj).length, 1, "cd ~ moves to the home folder");
  } finally {
    process.env.HOME = home;
    await rm(dir, { recursive: true, force: true });
  }
});

test("C1: a script fed on stdin by cat < FILE or read from /dev/stdin is read from the < file", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ["cat < a.sh | sh", "cat < a.sh | bash -s x", "sh /dev/stdin < a.sh", "bash /dev/stdin < a.sh", "bash /dev/fd/0 < a.sh",
      "source /dev/stdin < a.sh", ". /dev/stdin < a.sh", "cat a.sh | sh /dev/stdin"]) assert.deepEqual(labels(command, dir), ["a.sh"], command);
    assert.deepEqual(labels("cat a.sh | cat | sh", dir), [], "a second program between the file and the shell stays unread");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("C2: a file's text run as code by -c, eval, or a here-string is read as a script", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ['sh -c "$(cat a.sh)"', 'bash -c "$(< a.sh)"', 'eval "$(cat a.sh)"', 'eval "$(< a.sh)"', 'sh <<< "$(cat a.sh)"',
      'sh -c "`cat a.sh`"', 'eval "`cat a.sh`"']) assert.deepEqual(labels(command, dir), ["a.sh"], command);
    assert.deepEqual(labels('echo "$(cat a.sh)"', dir), [], "a file's text printed is not code");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("C3: the string of env -S is read as a command line", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ["env -S 'sh a.sh x'", "env -S'sh a.sh x'", "env --split-string='sh a.sh x'", "env --split-string 'sh a.sh x'", "env -i -S 'sh a.sh' x"]) {
      assert.deepEqual(labels(command, dir), ["a.sh"], command);
    }
    assert.ok(destructive(matchPatterns("bash", { command: `env -S '\\${DEL}'` }, dir)), "a delete in the string");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("C4: the command of find -exec, -execdir, -ok, and -okdir is read up to its terminator", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ["find . -exec ./a.sh \\;", "find . -exec ./a.sh ';'", "find . -name a.sh -exec ./a.sh {} +", "find . -execdir ./a.sh \\;",
      "find . -ok ./a.sh \\;", "find . -okdir ./a.sh \\;", "find . -exec sh a.sh \\; -print"]) {
      assert.deepEqual(labels(command, dir), [command.includes("sh a.sh") ? "a.sh" : "./a.sh"], command);
    }
    assert.deepEqual(labels("find . -name a.sh -exec sh {} \\;", dir), [], "a {} operand is not a literal path");
    assert.ok(destructive(matchPatterns("bash", { command: `find . -exec sh -c '\\${DEL}' \\;` }, dir)), "a delete in a -c string of -exec");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("C5: a substitution inside an array assignment runs", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ["arr=($(sh a.sh x))", "declare -a arr=(1 $(sh a.sh x) 3)", "f() { local arr=($(sh a.sh x)); }; f", "arr=(\"$(sh a.sh x)\")"]) {
      assert.deepEqual(labels(command, dir), ["a.sh"], command);
    }
    assert.deepEqual(labels("arr=(sh a.sh x)", dir), [], "array elements are words, not a command");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("C6: a heredoc whose end line closes the substitution is held: bash 3.2 and 5 run it, dash does not", async () => {
  const dir = await shapesProject();
  try {
    for (const command of [`x=$(sh <<EOF\n${DEL}\nEOF)`, `cat <(sh <<EOF\n${DEL}\nEOF) >/dev/null`]) {
      assert.ok(destructive(matchPatterns("bash", { command }, dir)), command);
    }
    assert.deepEqual(labels("x=$(sh <<EOF\nsh a.sh x\nEOF)", dir), ["a.sh"]);
    assert.deepEqual(labels("cat <(bash <<EOF\nsh a.sh x\nEOF) >/dev/null", dir), ["a.sh"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("C7: a delete word written \\rm, \"rm\", r''m, /bin/rm, or ${x}rm inside a -c string, eval, or a heredoc in one is held", () => {
  const word = ["r", "m"].join("");
  for (const command of [`sh -c '\\${word} -rf ~'`, `sh -c "\\"${word}\\" -rf ~"`, `sh -c "\\\\${word} -rf ~"`, `eval '\\${word} -rf ~'`, `eval "\\"${word}\\" -rf ~"`,
    `bash -c 'sh -c '\\''\\${word} -rf ~'\\'''`, `sh -c "r''m -rf ~"`, `eval 'r""m -rf ~'`, `sh -c "/bin/${word} -rf \\"\\$HOME\\""`, `eval '\${x}${word} -rf ~'`,
    `bash -c "sh <<EOF\n\\\\${word} -rf ~\nEOF"`]) {
    assert.ok(destructive(matchPatterns("bash", { command }, cwd)), command);
  }
  assert.ok(!destructive(matchPatterns("bash", { command: `sh -c 'echo \\${word} -rf ~'` }, cwd)), "an echo of the delete runs none");
});

test("the ask gate asks for a push fed to a shell on stdin, by env -S, as a file's text, or in an array's substitution", async () => {
  const dir = await shapesProject();
  try {
    for (const command of ["cat < push.sh | sh", "env -S 'sh push.sh'", 'sh -c "$(cat push.sh)"', "arr=($(sh push.sh))", "sh /dev/stdin < push.sh"]) {
      const decision = actionAskGate("bash", { command }, stripDataText(command).text, dir);
      assert.match(decision.why, /^runs a script with /, command);
      const judge = judgeOf();
      await evaluateAction({ tool: "bash", input: { command }, cwd: dir, task: "run it" }, { config: { ...defaultConfig().action, traceSample: 0 }, judge });
      assert.equal(judge.calls.length, 1, command);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
