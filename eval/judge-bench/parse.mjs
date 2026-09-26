// Generic failure parser for check and command output, used by arm C. It knows the shapes of common runners and
// compilers (node test/TAP, jest, vitest, pytest, tsc, eslint, cargo, go, Playwright, a `FAIL name: …` test script,
// Python and Node tracebacks). When no shape matches it returns `generic` (an error line only) or `unparsed`, and the
// caller falls back to the head and tail of the output.

const MAX_ITEMS = 6;
const clip = (s, n = 200) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const uniq = xs => [...new Set(xs.map(x => clip(x, 160)).filter(Boolean))];
const all = (text, re) => [...text.matchAll(re)];

export function exitCode(text) {
  const ms = all(text, /(?:exited with code|exit code:?|exit status|Error)\s+(\d+)\s*$/gim);
  return ms.length ? Number(ms.at(-1)[1]) : undefined;
}

function result(format, { failing = [], errors = [], location, summary }, exit) {
  const f = uniq(failing);
  const e = uniq(errors);
  return {
    format,
    failing: f.slice(0, MAX_ITEMS),
    ...(f.length > MAX_ITEMS ? { failing_more: f.length - MAX_ITEMS } : {}),
    errors: e.slice(0, MAX_ITEMS),
    ...(location ? { location: clip(location, 160) } : {}),
    ...(summary ? { summary: clip(summary, 160) } : {}),
    ...(exit !== undefined ? { exit } : {}),
  };
}

/** Lines after index `from` up to (not including) the first line that matches `stop`. */
function blockAfter(lines, from, stop) {
  const out = [];
  for (let i = from + 1; i < lines.length && !stop.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

const PARSERS = [
  ["tsc", t => {
    const ms = all(t, /^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm);
    if (!ms.length) return undefined;
    return { errors: ms.map(m => `${m[4]} ${m[1]}: ${m[5]}`), location: `${ms[0][1]}:${ms[0][2]}:${ms[0][3]}`, summary: `${ms.length} type error${ms.length === 1 ? "" : "s"}` };
  }],
  ["cargo", t => {
    const tests = all(t, /^test (\S+) \.\.\. FAILED$/gm).map(m => m[1]);
    const compile = all(t, /^error(\[E\d+\])?: (.+)\n\s*--> (\S+)/gm);
    if (!tests.length && !compile.length) return undefined;
    const panics = all(t, /panicked at (\S+?):\n((?:.+\n?){1,3})/g).map(m => ({ at: m[1], msg: m[2].split("\n").filter(l => l.trim() && !/^note:/.test(l)).join(" ") }));
    const summary = /^test result: FAILED\. (.+?); finished/m.exec(t)?.[1];
    return {
      failing: tests,
      errors: [...compile.map(m => `${m[1] ?? ""}${m[2]}`), ...panics.map(p => p.msg)],
      location: compile[0]?.[3] ?? panics[0]?.at,
      summary: summary ?? (compile.length ? "build failed" : undefined),
    };
  }],
  ["go", t => {
    const fails = all(t, /^\s*--- FAIL: (\S+)/gm).map(m => m[1]);
    const build = all(t, /^(\S+\.go):(\d+):(\d+): (.+)$/gm);
    if (!fails.length && !build.length) return undefined;
    const details = all(t, /^\s+(\S+_test\.go:\d+): (.+)$/gm);
    const pkgs = all(t, /^FAIL\t(\S+)(?:\t| \[)/gm).map(m => m[1]);
    return {
      failing: fails,
      errors: details.length ? details.map(m => m[2]) : build.map(m => `${m[1]}: ${m[4]}`),
      location: details[0]?.[1] ?? (build.length ? `${build[0][1]}:${build[0][2]}` : undefined),
      summary: pkgs.length ? `FAIL ${[...new Set(pkgs)].join(", ")}${/\[build failed\]/.test(t) ? " [build failed]" : ""}` : undefined,
    };
  }],
  ["pytest", t => {
    const failed = all(t, /^(?:FAILED|ERROR) (\S+)(?: - (.+))?$/gm);
    const summary = /(\d+ failed(?:, \d+ passed)?(?:, \d+ errors?)?) in [\d.]+s/.exec(t)?.[1];
    if (!failed.length && !summary) return undefined;
    // The short summary carries one message per failure; the `E` lines are the fallback when it is off (-rN).
    const messages = failed.map(m => m[2]).filter(Boolean);
    const e = all(t, /^E[ \t]+(\S.*)$/gm).map(m => m[1]);
    const loc = /^(\S+\.py):(\d+): \w+/m.exec(t);
    return { failing: failed.map(m => m[1]), errors: messages.length ? messages : e.slice(0, 3), location: loc ? `${loc[1]}:${loc[2]}` : undefined, summary };
  }],
  ["eslint", t => {
    const lines = t.split("\n");
    const errors = [];
    let file;
    for (const line of lines) {
      if (/^\/?\S+\.\w+$/.test(line.trim()) && !/^\s/.test(line)) file = line.trim();
      const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)$/.exec(line);
      if (m && m[3] === "error") errors.push(`${file ? `${file.split("/").slice(-2).join("/")}:${m[1]}` : m[1]} ${m[5]}: ${m[4]}`);
    }
    if (!errors.length) return undefined;
    return { errors, summary: /✖ (\d+ problems? \(.+?\))/.exec(t)?.[1] };
  }],
  ["tap", t => {
    const lines = t.split("\n");
    const failing = [];
    const errors = [];
    let location;
    lines.forEach((line, i) => {
      const m = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line);
      if (!m) return;
      failing.push(m[1]);
      const block = blockAfter(lines, i, /^\s*(?:\.\.\.|ok \d+|not ok \d+|# Subtest)/);
      const eAt = block.findIndex(l => /^\s+error:/.test(l));
      if (eAt >= 0) {
        const inline = /^\s+error:\s*(?:\|-?)?\s*(.*)$/.exec(block[eAt])[1];
        const msg = inline && !/^\|/.test(inline) ? inline.replace(/^['"]|['"]$/g, "") : block.slice(eAt + 1).map(l => l.trim()).filter(l => l && !/^[+-] (?:actual|expected)|^\^$/.test(l)).slice(0, 3).join(" ");
        errors.push(msg);
      }
      location ??= /^\s+location:\s*'?(.+?)'?$/m.exec(block.join("\n"))?.[1];
    });
    const spec = all(t, /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm).map(m => m[1]).filter(n => !/^failing tests:?$|^\d+ problems? \(/i.test(n));
    if (!failing.length && !spec.length) return undefined;
    const fail = /^# fail (\d+)$/m.exec(t)?.[1];
    const tests = /^# tests (\d+)$/m.exec(t)?.[1];
    return { failing: failing.length ? failing : spec, errors, location, summary: fail ? `${fail} of ${tests} tests failed` : undefined };
  }],
  ["playwright", t => {
    const heads = all(t, /^\s+\d+\) \[([^\]]+)\] › (.+?) ─+$/gm);
    if (!heads.length) return undefined;
    const lines = t.split("\n");
    const errors = [];
    lines.forEach((line, i) => {
      if (!/^\s+\d+\) \[[^\]]+\] › /.test(line)) return;
      const block = blockAfter(lines, i, /^\s+\d+\) \[|^\s+\d+ failed$/);
      const err = block.find(l => /^\s+Error: /.test(l));
      const detail = block.filter(l => /^\s+(?:Expected|Received)(?: string)?:/.test(l)).map(l => l.trim());
      if (err) errors.push([err.trim(), ...detail].join(" "));
    });
    const loc = /^\s+at (\S+:\d+:\d+)$/m.exec(t)?.[1];
    const failed = /^\s+(\d+) failed$/m.exec(t)?.[1];
    const passed = /^\s+(\d+) passed/m.exec(t)?.[1];
    return { failing: heads.map(m => `[${m[1]}] ${m[2]}`), errors, location: loc, summary: failed ? `${failed} failed${passed ? `, ${passed} passed` : ""}` : undefined };
  }],
  ["jest", t => {
    const bullets = all(t, /^\s*● (.+)$/gm).map(m => m[1].trim()).filter(n => n !== "Console");
    if (!bullets.length) return undefined;
    const lines = t.split("\n");
    const errors = [];
    lines.forEach((line, i) => {
      if (!/^\s*● /.test(line) || /● Console/.test(line)) return;
      const block = blockAfter(lines, i, /^\s*● |^(?:PASS|FAIL) |^Test Suites:/).map(l => l.trim()).filter(Boolean);
      const first = block.find(l => !/^\d+ \||^>|^\|/.test(l));
      const detail = block.filter(l => /^(?:Expected|Received):|^[-+] {2,}"/.test(l)).slice(0, 4);
      if (first) errors.push([first, ...detail].join(" "));
    });
    const suiteFail = all(t, /^FAIL (\S+)/gm).map(m => m[1]);
    const failing = bullets.map(b => (b === "Test suite failed to run" ? `${suiteFail[0] ?? "suite"} (suite failed to run)` : b));
    const loc = /at .*?\(?((?:[\w.\-~]+\/)*[\w.\-]+\.[cm]?[jt]sx?:\d+:\d+)\)?/.exec(t)?.[1];
    const summary = /^Tests:\s+(.+)$/m.exec(t)?.[1];
    return { failing, errors, location: loc, summary };
  }],
  ["vitest", t => {
    const fails = all(t, /^ FAIL {1,2}(\S+ > .+)$/gm).map(m => m[1]);
    const crosses = all(t, /^\s+× (.+?)(?: \d+m?s)?$/gm).map(m => m[1]);
    if (!fails.length && !crosses.length) return undefined;
    const errors = all(t, /^(\w*Error: .+)$/gm).map(m => m[1]);
    const loc = /❯ (\S+:\d+:\d+)/.exec(t)?.[1];
    const summary = /^\s+Tests\s+(.+)$/m.exec(t)?.[1];
    return { failing: fails.length ? fails : crosses, errors, location: loc, summary };
  }],
  ["test-script", t => {
    const fails = all(t, /^FAIL (\S+?): (.+)$/gm);
    if (!fails.length) return undefined;
    return { failing: fails.map(m => m[1]), errors: fails.map(m => m[2]), summary: /^(\d+ passed, \d+ failed)$/m.exec(t)?.[1] };
  }],
  ["python-traceback", t => {
    if (!/^Traceback \(most recent call last\):/m.test(t)) return undefined;
    const last = all(t, /^([\w.]*(?:Error|Exception|Exit|Interrupt)\w*): (.*)$/gm).at(-1);
    const frames = all(t, /^\s+File "(.+?)", line (\d+)/gm);
    return { errors: last ? [`${last[1]}: ${last[2]}`] : [], location: frames.length ? `${frames.at(-1)[1]}:${frames.at(-1)[2]}` : undefined };
  }],
  ["lisp-condition", t => {
    const m = /^Unhandled (\S+)(?: in thread[^\n]*)?\n(?:\s+\{[^}]*\}>:\n)?\s*(.+)$/m.exec(t);
    if (!m) return undefined;
    return { errors: [`${m[1]}: ${m[2]}`] };
  }],
  ["node-error", t => {
    const m = /^(\w*Error)(?: \[\w+\])?: (.+)$/m.exec(t);
    if (!m || !/^\s+at /m.test(t)) return undefined;
    const loc = /^\s+at (?:.*?\()?((?:file:\/\/)?\S+?:\d+:\d+)\)?$/m.exec(t.split("\n").filter(l => !/node:/.test(l)).join("\n"))?.[1];
    return { errors: [`${m[1]}: ${m[2]}`], location: loc };
  }],
];

/** Parses a failed or check output into failing tests, error lines, a location, a summary and an exit code. */
export function parseFailure(text) {
  const t = text.replace(/\r/g, "");
  const exit = exitCode(t);
  for (const [format, parse] of PARSERS) {
    const found = parse(t);
    if (found) return result(format, found, exit);
  }
  const line = t.split("\n").map(l => l.trim()).find(l => /\b(?:\w*Error|ERR!|error|FAIL(?:ED)?|Exception|panic|fatal|cannot|not found|No such file|denied)\b/.test(l) && !/^Command exited with code/.test(l));
  if (line) return result("generic", { errors: [line] }, exit);
  return result("unparsed", {}, exit);
}

/**
 * Normalises what changes between identical runs: durations, clock times and dates, addresses, long numbers, thread
 * ids, temp paths, and line:column positions. Other digits stay, so "expected 3" and "expected 4" still differ.
 */
export function normalise(s) {
  return (s ?? "")
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'"):]+/g, "<tmp>")
    .replace(/\bpytest-\d+\b/g, "pytest-#")
    .replace(/\.tmp[0-9a-zA-Z]+/g, ".tmp#")
    .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?Z?/g, "<time>")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<time>")
    .replace(/\brun=[0-9a-f]{6,}\b/g, "run=#")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|µs|us|ns)\b/g, "#t")
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/\(\d+\)/g, "(#)")
    .replace(/\d{5,}/g, "#")
    .replace(/:\d+(?::\d+)?\b/g, ":#")
    .replace(/\(\d+,\d+\)/g, "(#)")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Order-free signature of a failure: which tests failed and with which errors. Pass counts are left out, so a run
 * narrowed by a flag (`-x`, a test filter) still matches the full run that failed the same way.
 */
export function signature(parsed, raw = "") {
  if (parsed.format === "unparsed") return JSON.stringify(["unparsed", normalise(raw.slice(-400))]);
  return JSON.stringify([[...parsed.failing].map(normalise).sort(), [...parsed.errors].map(normalise).sort()]);
}
