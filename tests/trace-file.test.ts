import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Trace } from "../src/trace.js";
import type { TraceEntry } from "../src/trace.js";
import { TraceFile, judgmentsState, traceDir, traceFilePath } from "../src/trace-file.js";

let temporary: string;
before(async () => { temporary = await mkdtemp(join(tmpdir(), "pi-warden-trace-file-")); });
after(async () => { await rm(temporary, { recursive: true, force: true }); });

const entry = (line: string, details: string[] = []): TraceEntry => ({ at: Date.parse("2026-01-02T03:04:05.000Z"), guard: "action", line, details, tokens: { level: "allow" } });
const lines = async (path: string) => (await readFile(path, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

test("traceDir is on only for a non-empty absolute path and never resolves a relative one", () => {
  assert.equal(traceDir({}), undefined);
  assert.equal(traceDir({ PI_WARDEN_TRACE_DIR: "" }), undefined);
  assert.equal(traceDir({ PI_WARDEN_TRACE_DIR: "traces" }), undefined);
  assert.equal(traceDir({ PI_WARDEN_TRACE_DIR: "./traces" }), undefined);
  assert.equal(traceDir({ PI_WARDEN_TRACE_DIR: "/var/tmp/traces" }), "/var/tmp/traces");
  assert.equal(traceFilePath("/t", "0199-abc"), join("/t", "0199-abc.jsonl"));
  assert.equal(traceFilePath("/t", "../../etc/x"), join("/t", "etcx.jsonl"), "the session id cannot leave the directory");
});

test("the file is owner-only in an owner-only directory and holds the session, entries, and amends in trace order", async () => {
  const dir = join(temporary, "new", "traces");
  const path = traceFilePath(dir, "session-1");
  const failures: string[] = [];
  const trace = new Trace(2);
  const file = new TraceFile(path, dir, { sessionId: "session-1", cwd: "/work/project", mode: "steer", judgments: "on" }, text => failures.push(text));
  trace.subscribe(file.listener);
  const first = entry("first", ["ran: npm test"]);
  trace.push(first);
  trace.push(entry("second"));
  assert.equal(trace.amend(first, "outcome: approved"), true);
  trace.push(entry("third"));
  assert.equal(trace.amend(first, "evicted"), false, "the memory limit dropped the first entry");
  trace.clear();
  await file.flush();

  assert.deepEqual(failures, []);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const records = await lines(path);
  assert.deepEqual(records.map(record => [record.kind, record.id]), [["session", undefined], ["entry", 1], ["entry", 2], ["amend", 1], ["entry", 3]]);
  assert.ok(records.every(record => record.v === 1));
  const [session, entryOne, , amend] = records;
  assert.equal(session!.sessionId, "session-1");
  assert.equal(session!.cwd, "/work/project");
  assert.equal(session!.mode, "steer");
  assert.equal(session!.judgments, "on");
  assert.match(String(session!.wardenVersion), /^\d+\.\d+\.\d+/);
  assert.ok(!Number.isNaN(Date.parse(String(session!.at))));
  assert.deepEqual(entryOne, { v: 1, kind: "entry", id: 1, at: "2026-01-02T03:04:05.000Z", guard: "action", line: "first", details: ["ran: npm test"], tokens: { level: "allow" } }, "the entry line is the entry as pushed, not as amended later");
  assert.equal(amend!.line, "outcome: approved");
  assert.ok(!Number.isNaN(Date.parse(String(amend!.at))));
});

test("the session line carries the judgment state and a change adds one judgments line", async () => {
  const dir = join(temporary, "judgments");
  const path = traceFilePath(dir, "j");
  const trace = new Trace();
  const file = new TraceFile(path, dir, { sessionId: "j", cwd: "/w", mode: "steer", judgments: judgmentsState("key_rejected") }, () => assert.fail("no failure"));
  trace.subscribe(file.listener);
  file.judgments(judgmentsState("key_rejected"));
  trace.push(entry("first"));
  file.judgments(judgmentsState(undefined));
  file.judgments(judgmentsState(undefined));
  file.judgments(judgmentsState("budget"));
  await file.flush();
  const records = await lines(path);
  assert.deepEqual(records.map(record => [record.kind, record.judgments]), [["session", "off:key_rejected"], ["entry", undefined], ["judgments", "on"], ["judgments", "off:budget"]]);
  assert.ok(!Number.isNaN(Date.parse(String(records[2]!.at))));
});

test("a second session on the same file continues the entry ids", async () => {
  const dir = join(temporary, "reload");
  const path = traceFilePath(dir, "same");
  for (let round = 0; round < 2; round++) {
    const trace = new Trace();
    const file = new TraceFile(path, dir, { sessionId: "same", cwd: "/w", mode: "steer", judgments: "on" }, () => assert.fail("no failure"));
    trace.subscribe(file.listener);
    trace.push(entry(`round ${round} a`));
    trace.push(entry(`round ${round} b`));
    await file.flush();
  }
  const records = await lines(path);
  assert.deepEqual(records.map(record => record.kind === "entry" ? record.id : record.kind), ["session", 1, 2, "session", 3, 4]);
});

test("a write failure never throws, is reported once, and stops the file for the session", async () => {
  const blocker = join(temporary, "not-a-directory");
  await writeFile(blocker, "x");
  const dir = join(blocker, "traces");
  const failures: string[] = [];
  const trace = new Trace();
  const file = new TraceFile(traceFilePath(dir, "s"), dir, { sessionId: "s", cwd: "/w", mode: "steer", judgments: "on" }, text => failures.push(text));
  trace.subscribe(file.listener);
  assert.doesNotThrow(() => { trace.push(entry("a")); trace.push(entry("b")); });
  await file.flush();
  trace.push(entry("c"));
  await file.flush();
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /trace file .* could not be written/);
});

test("a failure after the file opened is also reported once", async () => {
  const dir = join(temporary, "readonly");
  const path = traceFilePath(dir, "s");
  const failures: string[] = [];
  const trace = new Trace();
  const file = new TraceFile(path, dir, { sessionId: "s", cwd: "/w", mode: "steer", judgments: "on" }, text => { failures.push(text); throw new Error("the reporter itself fails"); });
  trace.subscribe(file.listener);
  await file.flush();
  await chmod(path, 0o400);
  trace.push(entry("a"));
  trace.push(entry("b"));
  await file.flush();
  assert.equal(failures.length, 1);
  assert.deepEqual((await lines(path)).map(record => record.kind), ["session"]);
});
