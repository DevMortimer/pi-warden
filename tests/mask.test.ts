import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EpochMasker, maskContext } from "../src/mask.js";
import type { MaskMessage } from "../src/mask.js";
import type { ContextMaskConfig } from "../src/config.js";

const CWD = "/workspace/project";

function baseConfig(overrides: Partial<ContextMaskConfig> = {}): ContextMaskConfig {
  return {
    enabled: true,
    epochTurns: 8,
    keepRecentTurns: 6,
    minSweepBytes: 1024,
    minObsChars: 2000,
    images: true,
    supersededReads: true,
    resolvedChecks: true,
    ...overrides,
  };
}

function assistantCall(id: string, name: string, args: Record<string, unknown>, text = ""): MaskMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      { type: "toolCall", id, name, arguments: args },
    ],
  };
}

function toolResultText(id: string, toolName: string, text: string, isError = false): MaskMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError,
    content: [{ type: "text", text }],
  };
}

function toolResultImage(id: string, toolName: string, data: string, mimeType = "image/png"): MaskMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError: false,
    content: [{ type: "image", data, mimeType }],
  };
}

function fillerTurns(start: number, count: number): MaskMessage[] {
  const out: MaskMessage[] = [];
  for (let i = start; i < start + count; i++) {
    out.push(assistantCall(`fill_${i}`, "bash", { command: `echo step-${i}` }));
    out.push(toolResultText(`fill_${i}`, "bash", `step-${i}`));
  }
  return out;
}

test("EpochMasker commits at epoch boundary and keeps prefix byte-identical across turns 9..15", () => {
  const masker = new EpochMasker();
  const config = baseConfig({ epochTurns: 8, keepRecentTurns: 6, minSweepBytes: 1024 });
  const imgData = "A".repeat(4096);
  const messages: MaskMessage[] = [
    { role: "user", content: "inspect the UI and fix the bug" },
    assistantCall("c1", "read", { path: "shot.png" }),
    toolResultImage("c1", "read", imgData, "image/png"),
  ];

  // Turns 1..7: below epochTurns (8), nothing swept or changed.
  for (let turn = 2; turn <= 7; turn++) {
    messages.push(assistantCall(`c${turn}`, "bash", { command: `echo t${turn}` }));
    messages.push(toolResultText(`c${turn}`, "bash", `t${turn}`));
    const res = masker.apply(messages, { config, cwd: CWD });
    assert.equal(res.swept, false, `turn ${turn} must not sweep before epoch boundary`);
    assert.equal(res.changed, false, `turn ${turn} must leave messages unchanged`);
  }

  // Turn 8: epoch boundary reached (8 - 0 >= 8); turn 1 is outside keepRecentTurns (6).
  messages.push(assistantCall("c8", "bash", { command: "echo t8" }));
  messages.push(toolResultText("c8", "bash", "t8"));
  const turn8 = masker.apply(messages, { config, cwd: CWD });
  assert.equal(turn8.swept, true, "turn 8 commits epoch 1 sweep");
  assert.equal(turn8.changed, true);
  assert.equal(turn8.stats.images, 1);
  assert.ok(turn8.stats.newBytesSaved > 3500);
  const maskedPart = (turn8.messages[2]!.content as Array<{ type: string; text?: string }>)[0]!;
  assert.equal(maskedPart.type, "text");
  assert.match(maskedPart.text ?? "", /\[pi-warden: earlier tool image \(~4 KB image\/png\) masked after 7 turns; re-read or capture again if still needed\]/);

  // Turns 9..15: add another large old image on turn 9 (becomes older than keepRecentTurns by turn 15),
  // but between epochs (totalTurns - 8 < 8) the frozen prefix MUST stay 100% deeply equal!
  let prev = turn8.messages;
  for (let turn = 9; turn <= 15; turn++) {
    messages.push(assistantCall(`c${turn}`, "read", { path: `shot-${turn}.png` }));
    messages.push(toolResultImage(`c${turn}`, "read", "B".repeat(4096), "image/png"));
    const res = masker.apply(messages, { config, cwd: CWD });
    assert.equal(res.swept, false, `turn ${turn} is mid-epoch and must not sweep`);
    assert.equal(res.changed, true, `turn ${turn} still applies frozen epoch 1 replacement`);
    assert.deepEqual(
      res.messages.slice(0, prev.length),
      prev,
      `turn ${turn} prefix must be 100% deeply equal to turn ${turn - 1} for KV prompt-cache reuse`,
    );
    assert.equal(
      JSON.stringify(res.messages.slice(0, prev.length)),
      JSON.stringify(prev),
      `turn ${turn} serialized prefix must be byte-for-byte identical`,
    );
    // Latest turns after cutoff stay completely untouched (image intact).
    const lastResult = res.messages.at(-1)!;
    assert.equal((lastResult.content as Array<{ type: string }>)[0]!.type, "image");
    prev = res.messages;
  }

  // Turn 16: second epoch boundary (16 - 8 >= 8) now sweeps the newer aged images (turns 9..10).
  messages.push(assistantCall("c16", "bash", { command: "echo t16" }));
  messages.push(toolResultText("c16", "bash", "t16"));
  const turn16 = masker.apply(messages, { config, cwd: CWD });
  assert.equal(turn16.swept, true, "turn 16 triggers second epoch sweep");
  assert.ok(turn16.stats.images >= 1);
  // Original turn 1 masked text remains identical (never re-computed with new turnsAgo).
  assert.deepEqual(turn16.messages[2], turn8.messages[2]);
});

test("EpochMasker masks stale toolResult images, never user/custom images or recent toolResult images", () => {
  const userImg = "U".repeat(5000);
  const customImg = "C".repeat(5000);
  const oldToolImg = "O".repeat(5000);
  const recentToolImg = "R".repeat(5000);

  const messages: MaskMessage[] = [
    { role: "user", content: [{ type: "text", text: "check screenshot" }, { type: "image", data: userImg, mimeType: "image/png" }] },
    { role: "custom", customType: "note", content: [{ type: "image", data: customImg, mimeType: "image/jpeg" }] },
    assistantCall("old_img", "read", { path: "old.png" }),
    toolResultImage("old_img", "read", oldToolImg, "image/png"),
    ...fillerTurns(2, 6),
    assistantCall("recent_img", "read", { path: "recent.png" }),
    toolResultImage("recent_img", "read", recentToolImg, "image/png"),
  ];

  const res = maskContext(messages, { config: baseConfig({ epochTurns: 8, keepRecentTurns: 6, minSweepBytes: 1024 }), cwd: CWD });
  assert.equal(res.swept, true);
  assert.equal(res.stats.images, 1);

  // User image is NEVER touched.
  const userParts = res.messages[0]!.content as Array<{ type: string; data?: string }>;
  assert.equal(userParts[1]!.type, "image");
  assert.equal(userParts[1]!.data, userImg);

  // Custom message image is NEVER touched.
  const customParts = res.messages[1]!.content as Array<{ type: string; data?: string }>;
  assert.equal(customParts[0]!.type, "image");
  assert.equal(customParts[0]!.data, customImg);

  // Old toolResult image IS masked.
  const oldParts = res.messages[3]!.content as Array<{ type: string; text?: string }>;
  assert.equal(oldParts[0]!.type, "text");
  assert.match(oldParts[0]!.text ?? "", /earlier tool image/);

  // Recent toolResult image inside keepRecentTurns is NEVER touched.
  const recentParts = res.messages.at(-1)!.content as Array<{ type: string; data?: string }>;
  assert.equal(recentParts[0]!.type, "image");
  assert.equal(recentParts[0]!.data, recentToolImg);
});

test("EpochMasker masks superseded read by later covering read or write, preserves non-overlapping ranges and failed later reads", () => {
  const longFile = Array.from({ length: 80 }, (_, i) => `export const line${i} = "${"x".repeat(30)}";`).join("\n");
  assert.ok(longFile.length >= 2000);
  const homeFile = join(homedir(), "private-notes", "secret-doc.txt");

  const messages: MaskMessage[] = [
    { role: "user", content: "refactor files" },
    // 1. Superseded by later full read (relative vs ./ path).
    assistantCall("r_full", "read", { path: "src/a.ts" }),
    toolResultText("r_full", "read", longFile),
    // 2. Superseded by later write (external ~/ path; safeLabel must not leak homedir).
    assistantCall("r_home", "read", { path: "~/private-notes/secret-doc.txt" }),
    toolResultText("r_home", "read", longFile),
    // 3. Ranged read (1..20) followed only by non-overlapping range (50..70) -> NOT superseded.
    assistantCall("r_nonoverlap", "read", { path: "src/b.ts", offset: 1, limit: 20 }),
    toolResultText("r_nonoverlap", "read", longFile),
    // 4. Ranged read (10..30) followed by covering range (1..50) -> superseded.
    assistantCall("r_covered", "read", { path: "src/c.ts", offset: 10, limit: 20 }),
    toolResultText("r_covered", "read", longFile),
    // 5. Read followed only by failed later read -> NOT superseded.
    assistantCall("r_fail_later", "read", { path: "src/d.ts" }),
    toolResultText("r_fail_later", "read", longFile),
    // Later calls inside the recent window (6 turns: turns 6..11, totalTurns = 11, cutoff = assistant[5]).
    assistantCall("later_full", "read", { path: "./src/a.ts" }),
    toolResultText("later_full", "read", longFile),
    assistantCall("later_write", "write", { path: homeFile, content: "updated" }),
    toolResultText("later_write", "write", "wrote"),
    assistantCall("later_nonoverlap", "read", { path: "src/b.ts", offset: 50, limit: 20 }),
    toolResultText("later_nonoverlap", "read", longFile),
    assistantCall("later_cover", "read", { path: "src/c.ts", offset: 1, limit: 50 }),
    toolResultText("later_cover", "read", longFile),
    assistantCall("later_fail", "read", { path: "src/d.ts" }),
    toolResultText("later_fail", "read", "ENOENT", true),
    assistantCall("tail_pad", "bash", { command: "echo done" }),
    toolResultText("tail_pad", "bash", "done"),
  ];

  const res = maskContext(messages, { config: baseConfig({ epochTurns: 8, keepRecentTurns: 6, minSweepBytes: 1024, minObsChars: 2000 }), cwd: CWD });
  assert.equal(res.swept, true);
  assert.equal(res.stats.reads, 3, "only the 3 genuinely superseded reads are masked");

  const textAt = (id: string) => {
    const msg = res.messages.find(m => m.role === "toolResult" && m.toolCallId === id)!;
    return (msg.content as Array<{ text?: string }>)[0]!.text ?? "";
  };

  assert.match(textAt("r_full"), /\[pi-warden: superseded read of src\/a\.ts \(80 lines, \d+ chars\) masked; newer file content appears later in context\]/);
  const homeMasked = textAt("r_home");
  assert.match(homeMasked, /\[pi-warden: superseded read of secret-doc\.txt \(80 lines, \d+ chars\) masked; newer file content appears later in context\]/);
  assert.equal(homeMasked.includes(homedir()), false, "external path must never leak raw home directory");
  assert.equal(homeMasked.includes("private-notes"), false, "external path uses basename only");
  assert.match(textAt("r_covered"), /\[pi-warden: superseded read of src\/c\.ts/);

  // Non-overlapping range and failed later read stay completely intact.
  assert.equal(textAt("r_nonoverlap"), longFile);
  assert.equal(textAt("r_fail_later"), longFile);
});

test("EpochMasker masks middle of resolved bash check only after same-family check passes", () => {
  const failingLines = [
    ...Array.from({ length: 5 }, (_, i) => `HEAD-${i + 1}: running suite`),
    ...Array.from({ length: 80 }, (_, i) => `MID-${i + 1}: ${"verbose diagnostic detail ".repeat(2)}`),
    ...Array.from({ length: 10 }, (_, i) => i === 9 ? "ℹ fail 2" : `TAIL-${i + 1}: failure trace`),
  ];
  const failingOutput = failingLines.join("\n");
  assert.ok(failingOutput.length >= 2000);

  const messages: MaskMessage[] = [
    { role: "user", content: "fix failing tests" },
    // 1. Failing npm test -> later passing npm test => MASKED.
    assistantCall("t_npm_fail", "bash", { command: "npm test" }),
    toolResultText("t_npm_fail", "bash", failingOutput, true),
    // 2. Failing pytest -> later ONLY another failing pytest => NOT masked.
    assistantCall("t_py_fail", "bash", { command: "pytest" }),
    toolResultText("t_py_fail", "bash", `${failingOutput}\n2 failed in 1.2s`, true),
    // 3. Failing jest -> later passing cargo test (different family) => NOT masked.
    assistantCall("t_jest_fail", "bash", { command: "npx jest" }),
    toolResultText("t_jest_fail", "bash", `${failingOutput}\nTests: 1 failed, 1 total`, true),
    ...fillerTurns(4, 3),
    // Later passing npm test (same family as #1)
    assistantCall("t_npm_pass", "bash", { command: "npm test" }),
    toolResultText("t_npm_pass", "bash", "ℹ tests 10\nℹ pass 10\nℹ fail 0", false),
    // Later failing pytest (still failing -> does not resolve #2)
    assistantCall("t_py_fail2", "bash", { command: "pytest" }),
    toolResultText("t_py_fail2", "bash", "1 failed in 0.5s", true),
    // Later passing cargo test (different family -> does not resolve #3)
    assistantCall("t_cargo_pass", "bash", { command: "cargo test" }),
    toolResultText("t_cargo_pass", "bash", "test result: ok. 5 passed; 0 failed", false),
  ];

  const res = maskContext(messages, { config: baseConfig({ epochTurns: 8, keepRecentTurns: 6, minSweepBytes: 1024, minObsChars: 2000 }), cwd: CWD });
  assert.equal(res.swept, true);
  assert.equal(res.stats.checks, 1);

  const textAt = (id: string) => (res.messages.find(m => m.role === "toolResult" && m.toolCallId === id)!.content as Array<{ text?: string }>)[0]!.text!;
  const maskedNpm = textAt("t_npm_fail");
  assert.ok(maskedNpm.startsWith("HEAD-1: running suite\n"));
  assert.ok(maskedNpm.includes("HEAD-5: running suite\n[pi-warden: 80 lines of superseded npm test output masked; a newer passing npm test check appears later in context]\nTAIL-1: failure trace"));
  assert.ok(maskedNpm.endsWith("ℹ fail 2"));
  assert.equal(maskedNpm.includes("MID-40:"), false, "middle lines are omitted");

  // Unpassed pytest and different-family jest stay whole.
  assert.ok(textAt("t_py_fail").includes("MID-40:"));
  assert.ok(textAt("t_jest_fail").includes("MID-40:"));
});

test("EpochMasker respects minSweepBytes, handles compaction shortening, and honours silentTrial", () => {
  const masker = new EpochMasker();
  const smallImg = "A".repeat(600);
  const messages: MaskMessage[] = [
    { role: "user", content: "check" },
    assistantCall("c1", "read", { path: "tiny.png" }),
    toolResultImage("c1", "read", smallImg, "image/png"),
    ...fillerTurns(2, 7),
  ];

  // Below minSweepBytes (32768): does not sweep, frozen stays empty, lastSweepTurn unchanged.
  const skipped = masker.apply(messages, { config: baseConfig({ minSweepBytes: 32768 }), cwd: CWD });
  assert.equal(skipped.swept, false);
  assert.equal(skipped.changed, false);
  assert.equal(masker.frozenCount, 0);

  // Silent trial: records once at epoch boundary, advances lastSweepTurn, returns unmodified messages.
  const silentCalls: string[] = [];
  const silentMasker = new EpochMasker();
  const bigMsgs: MaskMessage[] = [
    { role: "user", content: "check" },
    assistantCall("big1", "read", { path: "big.png" }),
    toolResultImage("big1", "read", "X".repeat(5000), "image/png"),
    ...fillerTurns(2, 7),
  ];
  const s1 = silentMasker.apply(bigMsgs, {
    config: baseConfig({ minSweepBytes: 1024 }),
    cwd: CWD,
    silentTrial: summary => { silentCalls.push(summary); return true; },
  });
  assert.equal(s1.swept, false);
  assert.equal(s1.changed, false);
  assert.equal(s1.suppressed, true);
  assert.equal(silentCalls.length, 1);
  assert.equal((s1.messages[2]!.content as Array<{ type: string }>)[0]!.type, "image", "silent arm leaves image untouched");
  // Next turn in same epoch does not re-trigger silentTrial.
  bigMsgs.push(assistantCall("t9", "bash", { command: "echo 9" }), toolResultText("t9", "bash", "9"));
  const s2 = silentMasker.apply(bigMsgs, {
    config: baseConfig({ minSweepBytes: 1024 }),
    cwd: CWD,
    silentTrial: summary => { silentCalls.push(summary); return true; },
  });
  assert.equal(silentCalls.length, 1, "silent arm records at most once per epoch");
  assert.equal(s2.changed, false);

  // Compaction: commit a sweep, then shorten history below lastSweepTurn.
  const liveMasker = new EpochMasker();
  const committed = liveMasker.apply(bigMsgs, { config: baseConfig({ minSweepBytes: 1024 }), cwd: CWD });
  assert.equal(committed.swept, true);
  assert.equal(liveMasker.frozenCount, 1);

  const compacted: MaskMessage[] = [
    { role: "user", content: "summary after compaction" },
    assistantCall("post1", "bash", { command: "echo ok" }),
    toolResultText("post1", "bash", "ok"),
  ];
  const afterCompact = liveMasker.apply(compacted, { config: baseConfig({ minSweepBytes: 1024 }), cwd: CWD });
  assert.equal(afterCompact.swept, false);
  assert.equal(afterCompact.changed, false);
  assert.equal(liveMasker.frozenCount, 0, "pruned keys dropped by compaction");
});

test("EpochMasker returns unchanged when disabled or history is empty/short", () => {
  const masker = new EpochMasker();
  assert.equal(masker.apply([], { config: baseConfig(), cwd: CWD }).changed, false);
  const msgs: MaskMessage[] = [
    { role: "user", content: "hi" },
    assistantCall("c1", "read", { path: "big.png" }),
    toolResultImage("c1", "read", "Z".repeat(50_000), "image/png"),
    ...fillerTurns(2, 7),
  ];
  const off = masker.apply(msgs, { config: baseConfig({ enabled: false }), cwd: CWD });
  assert.equal(off.changed, false);
  assert.equal(off.swept, false);
});
