// The three request states per case. All arms share the guard's own `questions` object.
//   A: the real builder (buildStuckRequest / buildDoneRequest), fed the way the extension feeds it.
//   B: A's shape with larger raw slices. stuck: head 400 + tail 400 of each output. done: plus the last 1500 chars of
//      each check that ran after the last edit.
//   C: A's fields plus a compact `evidence` object built by the generic parser in parse.mjs.
// `lib` is pi-warden's public API: the runner passes dist/, the offline tests pass src/. Every string that enters a
// state goes through lib.redact().
import { parseFailure, signature } from "./parse.mjs";

const EDIT_TOOLS = new Set(["edit", "write"]);
const DIFF_CAP = 600;
const FALLBACK_HEAD = 300;
const FALLBACK_TAIL = 300;

export function headTail(text, head, tail) {
  return text.length <= head + tail ? text : `${text.slice(0, head)}… [${text.length - head - tail} middle chars] …${text.slice(-tail)}`;
}
const tailOf = (text, n) => (text.length <= n ? text : `[${text.length - n} earlier chars] …${text.slice(-n)}`);
const content = call => [{ type: "text", text: call.output }];

/** Test, build, lint and type-check runners, and the ad-hoc scripts the bench uses as checks. */
const RUNNER = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|e2e)|(?:npx|pnpm|bunx)\s+(?:tsc|jest|vitest|eslint|playwright)|node\s+--test|pytest|jest|vitest|tsc|eslint|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|make\s+\w+|sbcl\s+--script)\b/;

function editPairs(input) {
  if (Array.isArray(input.edits)) return input.edits.map(e => [String(e.oldText ?? ""), String(e.newText ?? "")]);
  if (input.oldText !== undefined || input.newText !== undefined) return [[String(input.oldText ?? ""), String(input.newText ?? "")]];
  return [];
}

/** Removed and added lines of one edit, as a multiset difference, so unchanged context lines drop out. */
function lineDelta(oldText, newText) {
  const count = new Map();
  for (const l of oldText.split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  const added = [];
  for (const l of newText.split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added.push(l);
  }
  const removed = [];
  for (const [l, n] of count) for (let i = 0; i < n; i++) removed.push(l);
  return { removed, added };
}

function editDiff(call, redact) {
  const path = String(call.input.path ?? "?");
  if (call.tool === "write") {
    const lines = String(call.input.content ?? "").split("\n");
    const text = lines.map(l => `+${l}`).join("\n");
    return { path: redact(path), added: lines.length, removed: 0, removedLines: [], addedLines: lines, diff: redact(text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}… [diff capped]` : text) };
  }
  const removedLines = [];
  const addedLines = [];
  for (const [o, n] of editPairs(call.input)) {
    const d = lineDelta(o, n);
    removedLines.push(...d.removed);
    addedLines.push(...d.added);
  }
  const text = [...removedLines.map(l => `-${l}`), ...addedLines.map(l => `+${l}`)].join("\n");
  return { path: redact(path), added: addedLines.length, removed: removedLines.length, removedLines, addedLines, diff: redact(text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}… [diff capped]` : text) };
}

/** The parsed failure in state form, or head+tail of the raw output when nothing could be parsed. */
function failureView(output, redact) {
  const p = parseFailure(output);
  if (p.format === "unparsed") return { view: { output_head_tail: redact(headTail(output.trim(), FALLBACK_HEAD, FALLBACK_TAIL)) }, parsed: p };
  const view = { parser: p.format };
  if (p.failing.length) view.failing_tests = p.failing.map(redact);
  if (p.failing_more) view.failing_tests_more = p.failing_more;
  if (p.errors.length) view.errors = p.errors.map(redact);
  if (p.location) view.location = redact(p.location);
  if (p.summary) view.summary = redact(p.summary);
  if (p.format === "generic") view.output_tail = redact(tailOf(output.trim(), FALLBACK_TAIL));
  return { view, parsed: p };
}

// ---------- stuck ----------

/**
 * Whether the real guard would decide this window in code, before any request: an exact repeat, a success repeat or
 * churn (src/stuck.ts evaluateStuck). Such windows never reach the judge in production.
 */
export function stuckCodeDecision(lib, attempts, config) {
  const window = new lib.AttemptWindow(config.window);
  for (const attempt of attempts) window.push(attempt);
  if (window.exactRepeats() >= config.minFailures) return "exact-repeat";
  if (window.successRepeats() >= config.minFailures) return "success-repeat";
  if (window.churnCount() >= config.churnThreshold) return "churn";
  return undefined;
}

export function stuckArms(lib, c, config = lib.defaultConfig().stuck) {
  const redact = lib.redact;
  const calls = c.calls.slice(-config.window);
  const attempts = calls.map(call => lib.makeAttempt(call.tool, call.input, content(call), call.failed));
  const A = lib.buildStuckRequest(attempts, redact(c.task));
  const B = {
    state: { ...A.state, attempts: A.state.attempts.map((a, i) => ({ ...a, output: redact(headTail(calls[i].output.trim(), 400, 400)) })) },
    questions: A.questions,
  };

  const runs = [];
  const edits = [];
  const failedSigs = [];
  let reads = 0;
  calls.forEach((call, i) => {
    const n = i + 1;
    if (EDIT_TOOLS.has(call.tool)) {
      const d = editDiff(call, redact);
      edits.push({ n, path: d.path, added_lines: d.added, removed_lines: d.removed, diff: d.diff });
      return;
    }
    const command = lib.commandOf(call.tool, call.input)?.command ?? "";
    if (!call.failed && !RUNNER.test(command)) {
      if (failedSigs.length) reads++;
      return;
    }
    const run = { n, outcome: call.failed ? "failed" : "ok" };
    if (call.failed) {
      const { view, parsed } = failureView(call.output, redact);
      const sig = signature(parsed, call.output);
      const earlier = failedSigs.findIndex(s => s.sig === sig);
      Object.assign(run, view, { same_failure_as_run: earlier >= 0 ? failedSigs[earlier].n : null });
      if (parsed.exit !== undefined) run.exit_code = parsed.exit;
      failedSigs.push({ n, sig });
    }
    runs.push(run);
  });
  const firstFail = failedSigs[0]?.n ?? 0;
  const lastFail = failedSigs.at(-1)?.n ?? 0;
  const C = {
    state: {
      ...A.state,
      evidence: {
        runs,
        edits,
        digest: {
          failed_runs: failedSigs.length,
          distinct_failures: new Set(failedSigs.map(s => s.sig)).size,
          latest_failure_seen_before: failedSigs.length > 1 && failedSigs.slice(0, -1).some(s => s.sig === failedSigs.at(-1).sig),
          edits_between_failed_runs: edits.filter(e => e.n > firstFail && e.n < lastFail).length,
          information_calls_between_failed_runs: reads,
        },
      },
    },
    questions: A.questions,
  };
  return { A, B, C, codeDecided: stuckCodeDecision(lib, attempts, config) };
}

// ---------- done ----------

export function fileType(path) {
  const p = path.replace(/\\/g, "/");
  const base = p.split("/").at(-1);
  if (/(?:^|\/)(?:tests?|__tests__|spec|testdata)\/|[._-](?:test|spec)\.[\w]+$|_test\.go$/.test(p)) return "test";
  if (/\.(?:md|mdx|rst|txt|adoc)$/i.test(p) || /^(?:LICENSE|NOTICE|AUTHORS)$/.test(base)) return "doc";
  if (/\.(?:json|ya?ml|toml|ini|cfg|conf|lock|env)$/i.test(p) || /^(?:Makefile|Dockerfile|\.[\w.-]+rc)$/.test(base) || /^\.github\//.test(p)) return "config";
  if (/\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|dart|c|cc|cpp|h|php|lisp|el|clj|ex|exs|sh|css|scss|html|vue|svelte|sql)$/i.test(p)) return "code";
  return "other";
}

const COMMENT_LINE = /^\s*(?:$|#|\/\/|;|--|\/\*|\*|<!--)/;
const SYMBOL = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)|^\s*(?:export\s+)?(?:pub\s+)?(?:async\s+)?(?:def|fn|func|defun)\s+(?:\([^)]*\)\s*)?\(?([A-Za-z_][\w-]*)|^\s*(?:export\s+)?(?:interface|class|type|struct)\s+([A-Za-z_]\w*)|^\s*(?:pub\s+)?const\s+([A-Z_][A-Z0-9_]*))/gm;

function symbols(lines) {
  const out = new Set();
  for (const m of lines.join("\n").matchAll(SYMBOL)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (name) out.add(name);
  }
  return [...out];
}

/** A pass summary line from a runner, when one is visible. */
function passSummary(output) {
  const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find(l => /\b\d+ pass(?:ed)?\b|^# pass \d+|test result: ok|^ok\s+\S+|No tests found|^Tests:|^Tests\s+\d+/.test(l));
  return line;
}

export function doneArms(lib, c) {
  const redact = lib.redact;
  const evidence = lib.emptyEvidence();
  const checkCalls = [];
  let lastMutation = -1;
  c.calls.forEach((call, i) => {
    const outcome = lib.classifyToolResult(call.tool, call.input, call.failed, call.output);
    lib.recordOutcome(evidence, outcome, call.input, call.tool);
    if (outcome === "mutation") lastMutation = i;
    if (outcome === "check-pass" || outcome === "check-fail") checkCalls.push({ call, index: i });
  });
  const final = c.final ?? "";
  const A = lib.buildDoneRequest(redact(c.task), final, evidence);
  const fresh = checkCalls.filter(x => x.index > lastMutation);
  const B = {
    state: { ...A.state, run: { ...A.state.run, check_outputs: fresh.map(({ call }) => ({ call: redact(lib.commandOf(call.tool, call.input)?.command ?? "check"), output_tail: redact(tailOf(call.output.trim(), 1500)) })) } },
    questions: A.questions,
  };

  const files = new Map();
  for (const call of c.calls.filter(x => EDIT_TOOLS.has(x.tool))) {
    const d = editDiff(call, redact);
    const raw = String(call.input.path ?? "?");
    const f = files.get(d.path) ?? { path: d.path, raw, type: fileType(raw), edits: 0, added: 0, removed: 0, lines: [], names: new Set() };
    f.edits++;
    f.added += d.added;
    f.removed += d.removed;
    f.lines.push(...d.removedLines, ...d.addedLines);
    for (const name of symbols([...d.removedLines, ...d.addedLines])) f.names.add(name);
    files.set(d.path, f);
  }
  const list = [...files.values()];
  const checks = fresh.map(({ call }) => {
    const o = { call: redact(lib.commandOf(call.tool, call.input)?.command ?? "check"), passed: !call.failed };
    if (call.failed) Object.assign(o, failureView(call.output, redact).view);
    else {
      const summary = passSummary(call.output);
      if (summary) o.summary = redact(summary);
    }
    return o;
  });
  // Which changed files a fresh check names, when its output or command names files at all.
  const checkText = fresh.map(({ call }) => `${lib.commandOf(call.tool, call.input)?.command ?? ""}\n${call.output}`).join("\n");
  const namesFiles = /[\w-]+\/[\w./-]+|\b[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|lisp|rb)\b/.test(checkText);
  const changedCode = list.filter(f => f.type === "code" || f.type === "test");
  let exercised;
  if (fresh.length && namesFiles && changedCode.length) {
    const seen = f => {
      const stem = f.raw.split("/").at(-1).replace(/\.[^.]+$/, "").replace(/[._-](?:test|spec)$/, "");
      const dir = f.raw.split("/").slice(0, -1).join("/");
      return checkText.includes(f.raw) || new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(checkText) || (dir !== "" && checkText.includes(dir));
    };
    exercised = { named_in_checks: changedCode.filter(seen).map(f => f.path), not_named_in_checks: changedCode.filter(f => !seen(f)).map(f => f.path) };
  }
  const C = {
    state: {
      ...A.state,
      evidence: {
        files: list.slice(0, 15).map(f => ({
          path: f.path,
          type: f.type,
          edits: f.edits,
          added_lines: f.added,
          removed_lines: f.removed,
          ...(f.lines.length && f.lines.every(l => COMMENT_LINE.test(l)) ? { comment_or_blank_lines_only: true } : {}),
          ...(f.names.size ? { symbols: [...f.names].slice(0, 8).map(redact) } : {}),
        })),
        file_types: list.reduce((m, f) => ({ ...m, [f.type]: (m[f.type] ?? 0) + 1 }), {}),
        checks_after_last_edit: checks,
        checks_before_last_edit: evidence.checks.length - fresh.length,
        ...(exercised ? { changed_code_in_check_output: exercised } : {}),
      },
    },
    questions: A.questions,
  };
  return { A, B, C, reached: lib.needsDoneCheck(evidence), evidence };
}

export function buildArms(lib, c) {
  return c.guard === "stuck" ? stuckArms(lib, c) : doneArms(lib, c);
}
