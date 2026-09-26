// The three request states per case. All arms share the guard's own `questions` object.
//   A: the real builder (buildStuckRequest / buildDoneRequest) as it ships, fed the way the extension feeds it.
//      For stuck that includes the structured `evidence` section (`stuck.evidence`, default on) built by src/evidence.ts.
//   B: A's shape with larger raw slices. stuck: head 400 + tail 400 of each output. done: plus the last 1500 chars of
//      each check that ran after the last edit.
//   C: the shipped builders with the new switch off: stuck carries `evidence: false`, which is exactly the state the
//      guard sent before the evidence section existed. (The done arm's evidence is built by doneArms below.)
// `lib` is pi-warden's public API: the runner passes dist/, the offline tests pass src/. Every string that enters a
// state goes through lib.redact().
const EDIT_TOOLS = new Set(["edit", "write"]);
const FALLBACK_HEAD = 300;
const FALLBACK_TAIL = 300;

export function headTail(text, head, tail) {
  return text.length <= head + tail ? text : `${text.slice(0, head)}… [${text.length - head - tail} middle chars] …${text.slice(-tail)}`;
}
const tailOf = (text, n) => (text.length <= n ? text : `[${text.length - n} earlier chars] …${text.slice(-n)}`);
const content = call => [{ type: "text", text: call.output }];

/** The parsed failure in state form, or head+tail of the raw output when nothing could be parsed. */
function failureView(lib, output, redact) {
  const p = lib.parseFailure(output);
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

/**
 * Arm A is the shipped builder with its evidence section on; arm C is the same builder with the switch off (the state
 * the guard sent before the evidence section existed); arm B is A with larger raw slices, to test whether more raw
 * text adds anything on top. Every stuck state comes from the real guard (src/stuck.ts -> src/evidence.ts).
 */
export function stuckArms(lib, c, config = lib.defaultConfig().stuck) {
  const redact = lib.redact;
  const calls = c.calls.slice(-config.window);
  const attempts = calls.map(call => lib.makeAttempt(call.tool, call.input, content(call), call.failed));
  const A = lib.buildStuckRequest(attempts, redact(c.task), { evidence: true });
  const B = {
    state: { ...A.state, attempts: A.state.attempts.map((a, i) => ({ ...a, output: redact(headTail(calls[i].output.trim(), 400, 400)) })) },
    questions: A.questions,
  };
  const C = lib.buildStuckRequest(attempts, redact(c.task), { evidence: false });
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
  /** The shipped diff helper, with the strings redacted the way every arm state redacts them. */
  const changeOf = call => {
    const d = lib.editDiff(call.tool, call.input);
    return { path: redact(d.path), added: d.added, removed: d.removed, removedLines: d.removedLines, addedLines: d.addedLines, diff: redact(d.diff) };
  };
  for (const call of c.calls.filter(x => EDIT_TOOLS.has(x.tool))) {
    const d = changeOf(call);
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
    if (call.failed) Object.assign(o, failureView(lib, call.output, redact).view);
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
