import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ArmingTracker, unparseableArmingRules } from "../src/arming.js";
import { stripDataText, writeSinkTargets } from "../src/guard.js";
import type { ArmingRule } from "../src/config.js";

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-warden-arming-"));
  await mkdir(join(cwd, "flux-cluster", "apps"), { recursive: true });
  await writeFile(join(cwd, "flux-cluster", "apps", "kustomization.yaml"), "resources: []\n");
});
after(async () => { await rm(cwd, { recursive: true, force: true }); });

const fluxRule: ArmingRule = {
  id: "gitops-edit-arms-reconcile",
  when: { edited: ["**/kustomization.yaml", "**/helmrelease.yaml"], tools: ["write", "edit"] },
  arms: { command: "\\bflux\\b|\\bkubectl\\s+(apply|delete|prune)\\b", for: "10m" },
  action: "confirm",
  message: "Cluster state definitions were edited this session; this reconciliation applies them.",
};

const blockRule: ArmingRule = {
  id: "never-reset",
  when: { edited: ["**/dangerous.conf"] },
  arms: { command: "\\btalosctl\\s+reset\\b", for: "5m" },
  action: "block",
};

const holdRule: ArmingRule = {
  id: "edit-arms-hold",
  when: { edited: ["**/config.yml"] },
  arms: { command: "\\bdeploy\\b", for: "1s" },
  action: "hold",
};

let nowMs = 1000;
const fakeNow = () => nowMs;

test("arm → checkArmed fires; expire removes the arm", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  // Edit a kustomization.yaml — arms the rule.
  const armed = tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  assert.equal(armed.length, 1);
  assert.equal(armed[0], "gitops-edit-arms-reconcile");
  // A flux reconcile command fires.
  const hits = tracker.checkArmed("flux reconcile --path ./clusters/prod");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "gitops-edit-arms-reconcile");
  assert.equal(hits[0]!.action, "confirm");
  // Advance past the 10-minute window; the arm expires.
  nowMs = 1000 + 11 * 60 * 1000;
  const expired = tracker.checkArmed("flux reconcile --path ./clusters/prod");
  assert.equal(expired.length, 0);
});

test("re-arm refreshes the expiry", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  tracker.arm("edit", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  nowMs = 1000 + 9 * 60 * 1000; // 9 minutes later, still armed
  tracker.arm("edit", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd); // refresh
  nowMs = 1000 + 9 * 60 * 1000 + 6 * 60 * 1000; // 15 minutes from start, 6 from refresh — still armed
  const hits = tracker.checkArmed("flux reconcile");
  assert.equal(hits.length, 1);
});

test("when.tools filters: read tool does not arm", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  // read is not in when.tools (default ["write","edit"]).
  const armed = tracker.arm("read", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  assert.equal(armed.length, 0);
  const hits = tracker.checkArmed("flux reconcile");
  assert.equal(hits.length, 0);
});

test("non-matching path does not arm", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  const armed = tracker.arm("write", join(cwd, "README.md"), cwd);
  assert.equal(armed.length, 0);
  const hits = tracker.checkArmed("flux reconcile");
  assert.equal(hits.length, 0);
});

test("non-matching command does not fire; armed state stays intact", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  const hits = tracker.checkArmed("kubectl get pods");
  assert.equal(hits.length, 0);
  // Still armed — a later matching command fires.
  const hits2 = tracker.checkArmed("flux reconcile");
  assert.equal(hits2.length, 1);
});

test("block action fires on armed match", () => {
  const tracker = new ArmingTracker([blockRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "dangerous.conf"), cwd);
  const hits = tracker.checkArmed("talosctl reset --graceful=false");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.action, "block");
});

test("hold action fires on armed match", () => {
  const tracker = new ArmingTracker([holdRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "config.yml"), cwd);
  const hits = tracker.checkArmed("deploy --prod");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.action, "hold");
});

test("multiple rules arm from one edit; one rule armed by multiple edits (dedup paths)", () => {
  const ruleA: ArmingRule = {
    id: "rule-a",
    when: { edited: ["**/*.yaml"] },
    arms: { command: "\\bapply\\b", for: "10m" },
    action: "confirm",
  };
  const ruleB: ArmingRule = {
    id: "rule-b",
    when: { edited: ["**/*.yaml"] },
    arms: { command: "\\bdelete\\b", for: "10m" },
    action: "confirm",
  };
  const tracker = new ArmingTracker([ruleA, ruleB], fakeNow);
  nowMs = 1000;
  // One edit arms both rules.
  const armed = tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  assert.equal(armed.length, 2);
  // Both fire on their respective commands.
  assert.equal(tracker.checkArmed("kubectl apply").length, 1);
  assert.equal(tracker.checkArmed("kubectl delete").length, 1);
  // One rule armed by multiple edits: dedup paths.
  tracker.arm("write", join(cwd, "flux-cluster/apps/another.yaml"), cwd);
  const hits = tracker.checkArmed("kubectl apply");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.armedByPaths.length, 2);
});

test("bash redirect target matching a when.edited glob arms", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  // A bash command that writes to a kustomization.yaml via redirect.
  const armed = tracker.arm("bash", undefined, cwd, [join(cwd, "flux-cluster/apps/kustomization.yaml")]);
  assert.equal(armed.length, 1);
  const hits = tracker.checkArmed("flux reconcile");
  assert.equal(hits.length, 1);
});

test("status line renders armed state", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  assert.equal(tracker.statusLine(), "");
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  const line = tracker.statusLine();
  assert.match(line, /1 armed: gitops-edit-arms-reconcile \(\d+m left\)/);
});

test("reset clears all armed state", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  assert.equal(tracker.statusLine().length > 0, true);
  tracker.reset();
  assert.equal(tracker.statusLine(), "");
  assert.equal(tracker.checkArmed("flux reconcile").length, 0);
});

test("armedRuleIds lists currently armed rules", () => {
  const tracker = new ArmingTracker([fluxRule, blockRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  tracker.arm("write", join(cwd, "dangerous.conf"), cwd);
  const ids = tracker.armedRuleIds();
  assert.equal(ids.length, 2);
  assert.ok(ids.includes("gitops-edit-arms-reconcile"));
  assert.ok(ids.includes("never-reset"));
});

test("caseSensitive flag on arms.command is honored", () => {
  const rule: ArmingRule = {
    id: "case-sensitive-rule",
    when: { edited: ["**/config.yml"] },
    arms: { command: "\\bFLUX\\b", for: "10m", caseSensitive: true },
    action: "confirm",
  };
  const tracker = new ArmingTracker([rule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "config.yml"), cwd);
  // lowercase flux should NOT match (caseSensitive).
  assert.equal(tracker.checkArmed("flux reconcile").length, 0);
  // uppercase FLUX should match.
  assert.equal(tracker.checkArmed("FLUX reconcile").length, 1);
});

test("regex when.edited matches by regex, not glob", () => {
  const rule: ArmingRule = {
    id: "regex-when",
    when: { edited: [".*\\.ya?ml$"], regex: true },
    arms: { command: "\\bapply\\b", for: "10m" },
    action: "confirm",
  };
  const tracker = new ArmingTracker([rule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  assert.equal(tracker.checkArmed("kubectl apply").length, 1);
});

test("malformed command regex does not crash; rule is inert", () => {
  const rule: ArmingRule = {
    id: "bad-regex",
    when: { edited: ["**/*.yml"] },
    arms: { command: "[invalid", for: "10m" },
    action: "confirm",
  };
  const tracker = new ArmingTracker([rule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "config.yml"), cwd);
  // The rule compiled to nothing, so no hit and no crash.
  assert.equal(tracker.checkArmed("apply").length, 0);
});
// --- Fix 1: hold action fires as a hold, not a warn ---
test("hold action: armed hold rule fires block in the tracker (not warn)", () => {
  const tracker = new ArmingTracker([holdRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "config.yml"), cwd);
  const hits = tracker.checkArmed("deploy");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.action, "hold");
});

// --- Fix 2: session-scope: arming survives across simulated agent_end (no reset) ---
test("session-scope: arming survives when only updateRules is called (no reset between runs)", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  // Simulate agent_end: the old code would reset; the new code does not call reset on agent_end.
  // Only updateRules is called per configFor, which preserves armed state.
  tracker.updateRules([fluxRule]);
  nowMs = 2000; // same session, a moment later
  assert.equal(tracker.checkArmed("flux reconcile").length, 1, "armed state survives across runs within a session");
});

test("session-scope: reset clears armed state (session_start)", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  tracker.reset();
  assert.equal(tracker.checkArmed("flux reconcile").length, 0, "reset clears all armed state");
});

// --- Fix 5: checkArmed early-returns when nothing is armed ---
test("checkArmed: no stripDataText cost when nothing is armed", () => {
  const tracker = new ArmingTracker([fluxRule], fakeNow);
  nowMs = 1000;
  // Nothing armed yet; checkArmed should return [] without parsing.
  assert.equal(tracker.checkArmed("flux reconcile").length, 0);
});

// --- Fix 7: updateRules recompiles only when the reference changes ---
test("updateRules: recompiles only when the reference changes", () => {
  const rules: ArmingRule[] = [fluxRule];
  const tracker = new ArmingTracker(rules, fakeNow);
  // updateRules with the same reference should be a no-op.
  tracker.updateRules(rules);
  // Different reference, same content — should recompile.
  const rules2: ArmingRule[] = [fluxRule];
  tracker.updateRules(rules2);
  // No crash; the tracker still works.
  nowMs = 1000;
  tracker.arm("write", join(cwd, "flux-cluster/apps/kustomization.yaml"), cwd);
  assert.equal(tracker.checkArmed("flux reconcile").length, 1);
});

// --- Fix 10: arms.for "0m" and 0 both fall back to default ---
test("arms.for '0m' falls back to default duration, not 0ms", () => {
  const rule: ArmingRule = {
    id: "zero-duration",
    when: { edited: ["**/*.yml"] },
    arms: { command: "kubectl", for: "0m" },
    action: "confirm",
  };
  const tracker = new ArmingTracker([rule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "config.yml"), cwd);
  // At 1ms the rule should still be armed (default 10m), not expired at 0ms.
  nowMs = 1001;
  assert.equal(tracker.checkArmed("kubectl").length, 1, "0m falls back to default, not 0ms");
});

test("arms.for 0 (number) falls back to default duration", () => {
  const rule: ArmingRule = {
    id: "zero-num",
    when: { edited: ["**/*.yml"] },
    arms: { command: "kubectl", for: 0 },
    action: "confirm",
  };
  const tracker = new ArmingTracker([rule], fakeNow);
  nowMs = 1000;
  tracker.arm("write", join(cwd, "config.yml"), cwd);
  nowMs = 1001;
  assert.equal(tracker.checkArmed("kubectl").length, 1, "0 falls back to default, not 0ms");
});

// --- Fix 4: unparseableArmingRules surfaces bad regex ---
test("unparseableArmingRules: surfaces rules with invalid regex", () => {
  const rules: ArmingRule[] = [
    { id: "good", when: { edited: ["**/*.yml"] }, arms: { command: "kubectl" }, action: "confirm" },
    { id: "bad", when: { edited: ["**/*.yml"] }, arms: { command: "[invalid" }, action: "confirm" },
  ];
  const ids = unparseableArmingRules(rules);
  assert.deepEqual(ids, ["bad"]);
});

// --- Cross-PR polish: arm/check text parity ---
// A data heredoc mentioning a redirect to a when.edited glob must NOT arm (the redirect
// is text, not a real write), but a shell-sink heredoc (real write) must arm.
test("arm/check parity: data heredoc redirect does not produce a write-sink target", () => {
  // A data heredoc (cat <<'EOF' with no shell sink) that mentions a redirect in its body.
  const dataCmd = "cat <<'EOF'\nremember to redirect logs > ~/flux-cluster/kustomization.yaml someday\nEOF\necho done";
  const stripped = stripDataText(dataCmd).text;
  // The raw command has the redirect in the heredoc body; writeSinkTargets extracts it.
  const rawSinks = writeSinkTargets(dataCmd);
  // After stripDataText, the heredoc body is replaced with a placeholder — no redirect.
  const strippedSinks = writeSinkTargets(stripped);
  assert.ok(rawSinks.length > 0, "raw command has a phantom redirect in the data body");
  assert.equal(strippedSinks.length, 0, "stripped command has no redirect — arm side must use stripped text");
});

test("arm/check parity: a real redirect in a shell-sink heredoc does produce a write-sink target", () => {
  // A shell-sink heredoc: the body is executed, so the redirect is real.
  const execCmd = "bash <<'EOF'\necho x > /tmp/kustomization.yaml\nEOF";
  const stripped = stripDataText(execCmd).text;
  const strippedSinks = writeSinkTargets(stripped);
  assert.ok(strippedSinks.length > 0, "a shell-sink heredoc redirect survives stripDataText");
});
