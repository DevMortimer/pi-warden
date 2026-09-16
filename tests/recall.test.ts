import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRecall, detectSearchTool, recallInstruction } from "../src/recall.js";

const path = "/tmp/pi-warden-output-x/output.txt";

test("a configured recall tool is used without probing; auto probes the chain and settles on a real tool or none", async () => {
  assert.equal(await detectSearchTool("findstr"), "findstr");
  assert.equal(await detectSearchTool("none"), "none");
  const detected = await detectSearchTool("auto", 5000);
  assert.ok(["rg", "ag", "ugrep", "git-grep", "grep", "select-string", "findstr", "none"].includes(detected), detected);
  if (process.platform !== "win32") assert.notEqual(detected, "none", "a POSIX machine has at least grep");
});

test("the recall footer names the file, a scoped search, and a ranged read, and warns against a whole-file read", () => {
  const rg = recallInstruction("rg", path);
  assert.match(rg, new RegExp(`Full output: ${path}`));
  assert.match(rg, /rg -n -C 3 '<pattern>'/);
  assert.match(rg, /offset and limit/);
  assert.match(rg, /Do not read the whole file/);
  assert.match(recallInstruction("git-grep", path), /git grep --no-index/);
  assert.match(recallInstruction("select-string", path), /Select-String -Path/);
  assert.match(recallInstruction("findstr", path), /findstr \/n \/c:"<pattern>"/);
  const none = recallInstruction("none", path);
  assert.ok(!none.includes("<pattern>"));
  assert.match(none, /offset and limit/);
});

test("recall classification: whole-file reads and bare cat are full; searches, ranges, and pipelines are scoped", () => {
  assert.equal(classifyRecall("read", { path }, path), "full");
  assert.equal(classifyRecall("read", { path, offset: 100, limit: 40 }, path), "scoped");
  assert.equal(classifyRecall("bash", { command: `cat ${path}` }, path), "full");
  assert.equal(classifyRecall("bash", { command: `cat ${path} | grep -n error` }, path), "full", "the segment that names the file dumps it whole");
  assert.equal(classifyRecall("bash", { command: `rg -n 'error' ${path}` }, path), "scoped");
  assert.equal(classifyRecall("bash", { command: `sed -n '100,140p' ${path}` }, path), "scoped");
  assert.equal(classifyRecall("bash", { command: `tail -n 50 ${path}` }, path), "scoped");
  assert.equal(classifyRecall("powershell", { command: `Get-Content ${path}` }, path), "full");
  assert.equal(classifyRecall("powershell", { command: `Get-Content ${path} -Tail 50` }, path), "scoped");
  assert.equal(classifyRecall("ctx_execute_file", { path, code: "console.log(FILE_CONTENT.length)" }, path), "scoped");
});
