import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ArmingTracker } from "../src/arming.js";
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