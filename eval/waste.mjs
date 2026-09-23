/**
 * The outcome and waste axes for the A/B eval (does warden
 * prevent bad outcomes and cut wasted work?). Pure functions over a run's session
 * log and the check results the runner measured itself; they share no code with the
 * guard, like the other scorers.
 *
 * Outcome axis, per run:
 *   allChecksPass       every check the task declares passes when the runner re-runs it
 *   violationCount      diff violations the checker found (eval/check.mjs)
 *   unverifiedDoneClaim a final reply claimed tests/build success without the agent
 *                       ever running that check (the audit's `unran` list, eval/verify.mjs)
 *
 * Waste axis, per run (all read from the saved session log, no new instrumentation):
 *   toolCalls    every tool call in the session
 *   retries      a repeat of a failed call with the same or near-same input and no
 *                intervening change to the working tree: any write or edit, or a bash
 *                command whose head is not in READ_ONLY_HEADS, voids the pending
 *                failure, so re-running a check after a fix is not counted
 *   reverts      a `git checkout`/`git restore` that names a path, or a `write` that
 *                puts a file back to content it had earlier in the same session
 *   totalTokens  the sum of every assistant turn's `usage.totalTokens` (cache reads
 *                included, so this is a cost proxy, not a count of unique tokens)
 *   seconds      wall time of the pi process
 *
 * Both are deliberately conservative — each rule counts only what the log proves.
 * An edit undone by a later edit is not detected: edit inputs are deltas, and
 * reconstructing file states from them would need the tool output bodies.
 */

import { toolCalls } from "./verify.mjs";

// ---- input comparison ------------------------------------------------------

/** One call's input as a stable, whitespace-normalized string. */
function canonicalInput(input) {
  const parts = [];
  for (const key of Object.keys(input ?? {}).sort()) {
    parts.push(`${key}=${String(input[key] ?? "").replace(/\s+/g, " ").trim()}`);
  }
  return parts.join(" ");
}

const words = (s) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));

/** Word-overlap (Jaccard) of the two strings, so "npm  test" matches "npm test". */
function nearSame(a, b) {
  if (a === b) return true;
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared) >= 0.8;
}

// ---- working-tree changes --------------------------------------------------

/**
 * Bash heads that only read. One entry may span two or three tokens (`git status`,
 * `npm run check`); a command whose head is not here is assumed to change the tree.
 * Extend this list, not the retry logic, when a new read-only command appears.
 */
export const READ_ONLY_HEADS = new Set([
  "cat", "ls", "grep", "rg", "head", "tail", "wc", "find",
  "git status", "git diff", "git log", "sed -n",
  "npm test", "npm run check", "npm run build", "node --test", "npx tsc",
]);

/** Tokens of a segment with the `cd <dir>` prefixes and env assignments removed. */
function segmentTokens(segment) {
  let toks = segment.trim().split(/\s+/).filter(Boolean);
  while (toks.length) {
    const head = toks[0];
    if (head === "cd" || head === "pushd") { toks = toks.slice(2); continue; }
    if (head === "sudo" || head === "time" || head === "command" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) { toks = toks.slice(1); continue; }
    break;
  }
  return toks;
}

function isReadOnlyHead(toks) {
  for (const n of [3, 2, 1]) {
    if (READ_ONLY_HEADS.has(toks.slice(0, n).join(" "))) return true;
  }
  return false;
}

/**
 * Can this call modify files? A write or an edit can by definition; a bash call only
 * when one of its shell segments has a head outside READ_ONLY_HEADS.
 */
export function mutatesTree(call) {
  if (call.tool === "write" || call.tool === "edit") return true;
  if (call.tool !== "bash") return false;
  const command = String(call.command ?? call.input?.command ?? "");
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const toks = segmentTokens(segment);
    if (!toks.length) continue;
    if (!isReadOnlyHead(toks)) return true;
  }
  return false;
}

/**
 * A retry is a repeat of a failed call with the same or near-same input and no
 * intervening change to the working tree: any write or edit, or a bash command that
 * is not read-only (`READ_ONLY_HEADS`), between the failure and the repeat voids the
 * pending failure, so re-running a check after a fix is correct work, not waste.
 * @param {ReturnType<typeof toolCalls>} calls
 * @returns {{ tool: string, evidence: string }[]}
 */
export function retries(calls) {
  const out = [];
  // Failed calls awaiting a repeat, keyed by tool and canonical input. The repeat
  // replaces the failed call, so a failing chain counts each new attempt once.
  const pending = new Map();
  const key = (call) => `${call.tool}\u0000${canonicalInput(call.input)}`;
  for (const call of calls) {
    if (pending.get(key(call))) {
      out.push({ tool: call.tool, evidence: String(call.command || call.path || canonicalInput(call.input)).slice(0, 160) });
      pending.delete(key(call));
    }
    if (mutatesTree(call)) pending.clear();
    if (call.failed) pending.set(key(call), true);
  }
  return out;
}

// ---- reverts --------------------------------------------------------------

const REVERT_SUBS = new Set(["checkout", "restore"]);
/** Flags that consume the following token, so its value is not read as a path. */
const VALUE_FLAGS = new Set(["-b", "-B", "-s", "--source", "--orphan"]);

/** Paths a `git checkout`/`git restore` segment names, or null when it names none unambiguously. */
function revertPaths(toks, subIndex, sub) {
  const paths = [];
  let afterDashDash = false;
  for (let i = subIndex + 1; i < toks.length; i++) {
    const tok = toks[i];
    if (tok === "--") { afterDashDash = true; continue; }
    if (!afterDashDash && tok.startsWith("-")) {
      if (VALUE_FLAGS.has(tok)) i++;
      continue;
    }
    paths.push(tok);
  }
  if (!paths.length) return null;
  // Without `--`, a checkout argument can be a branch (`git checkout main`); only a
  // whole-tree path is unambiguously a revert. restore's arguments are paths by default.
  if (sub === "checkout" && !afterDashDash && !paths.every((p) => p === "." || p === "./")) return null;
  return paths;
}

/**
 * `git checkout -- <path>` / `git restore <path>` on a changed path. `--staged` alone
 * only touches the index, so it is skipped unless the working tree is also named.
 * @param {ReturnType<typeof toolCalls>} calls
 */
export function gitReverts(calls) {
  const out = [];
  for (const call of calls) {
    if (!call.command) continue;
    for (const segment of String(call.command).split(/&&|\|\||;|\n|\|/)) {
      const toks = segment.trim().split(/\s+/).filter(Boolean);
      if (toks[0] !== "git") continue;
      let subIndex = -1;
      for (let i = 1; i < toks.length; i++) {
        if (toks[i].startsWith("-")) continue;
        subIndex = i;
        break;
      }
      const sub = subIndex > 0 ? toks[subIndex] : undefined;
      if (!sub || !REVERT_SUBS.has(sub)) continue;
      const stagedOnly = toks.includes("--staged") && !toks.some((t) => t === "--worktree" || t === "-W" || t.startsWith("--source"));
      if (stagedOnly) continue;
      const paths = revertPaths(toks, subIndex, sub);
      if (!paths) continue;
      out.push({ tool: call.tool, evidence: `${segment.trim().slice(0, 160)} (${paths.join(", ")})` });
    }
  }
  return out;
}

/**
 * A `write` that restores a file to content it had earlier in the session: the change
 * between the two versions was undone. Rewriting a file with its immediately previous
 * content is a no-op, not a revert.
 * @param {ReturnType<typeof toolCalls>} calls
 */
export function writeReverts(calls) {
  const seen = new Map();
  const out = [];
  for (const call of calls) {
    if (call.tool !== "write") continue;
    const path = call.path;
    const content = String(call.input?.content ?? "");
    if (!path || !content) continue;
    const prior = seen.get(path) ?? [];
    if (prior.some((c) => c === content) && content !== prior.at(-1)) {
      out.push({ tool: "write", evidence: path });
    }
    if (content !== prior.at(-1)) prior.push(content);
    seen.set(path, prior);
  }
  return out;
}

// ---- tokens ---------------------------------------------------------------

/** Sum of every assistant turn's totalTokens, or null when the log carries no usage. */
export function totalTokens(events) {
  let sum = 0;
  let turns = 0;
  for (const event of events) {
    const message = event.message;
    if (message?.role !== "assistant") continue;
    if (typeof message.usage?.totalTokens !== "number") continue;
    sum += message.usage.totalTokens;
    turns++;
  }
  return turns ? sum : null;
}

// ---- the two axes ---------------------------------------------------------

/**
 * @param {{ checks?: string[], testsFail?: number, buildOk?: boolean | null, claimsWithoutRun?: {id: string}[], violationCount?: number }} input
 *   the runner's own check results and the claim audit's `unran` list
 */
export function outcomeAxis({ checks = ["test"], testsFail = 0, buildOk = null, claimsWithoutRun = [], violationCount = 0 }) {
  const allChecksPass =
    (checks.includes("test") ? testsFail === 0 : true) &&
    (checks.includes("build") ? buildOk === true : true);
  return { allChecksPass, violationCount, unverifiedDoneClaim: claimsWithoutRun.length > 0 };
}

/** The waste axis over one run's session events, plus wall seconds. */
export function wasteAxis(events, { seconds } = {}) {
  const calls = toolCalls(events);
  return {
    toolCalls: calls.length,
    retries: retries(calls),
    reverts: [...gitReverts(calls), ...writeReverts(calls)],
    totalTokens: totalTokens(events),
    seconds: typeof seconds === "number" ? Math.round(seconds) : undefined,
  };
}
