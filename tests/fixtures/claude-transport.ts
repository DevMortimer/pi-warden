import fs, { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const originalOpen = fs.openSync;
const originalNow = Date.now;
if (process.env.CLAUDE_TEST_CLOCK_OFFSET) Date.now = () => originalNow() + Number(process.env.CLAUDE_TEST_CLOCK_OFFSET);
const promises = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
const originalWrite = promises.writeFile;
const originalRead = promises.readFile;
const originalRename = promises.rename;
const originalAsyncOpen = promises.open;
promises.writeFile = (async (path, data, options) => {
  const name = String(path).replaceAll("\\", "/");
  if (process.env.CLAUDE_TEST_PARTIAL_TARGET === "1" && name.includes("/targets/")) return originalWrite(path, "{", options);
  await originalWrite(path, data, options);
  if (process.env.CLAUDE_TEST_SETTINGS_RACE === "1" && /\/\.claude\/settings\.json\.[^/]+\.tmp$/.test(name)) {
    const target = name.slice(0, name.indexOf("/.claude/settings.json") + "/.claude/settings.json".length);
    const prior = JSON.parse(await originalRead(target, "utf8"));
    await originalWrite(target, JSON.stringify({ ...prior, outsideEdit: true }));
  }
}) as typeof promises.writeFile;
promises.rename = async (from, to) => {
  const target = String(to).replaceAll("\\", "/");
  if (process.env.CLAUDE_TEST_SETTINGS_FAIL === "1" && target.endsWith("/.claude/settings.json")) throw Object.assign(new Error("Fixture settings failure."), { code: "EACCES" });
  if (process.env.CLAUDE_TEST_RECEIPT_FAIL === "1" && target.includes("/hosts/claude/")) {
    const next = JSON.parse(await originalRead(from, "utf8"));
    if (!next.pending && next.owned?.length) throw Object.assign(new Error("Fixture receipt failure."), { code: "EACCES" });
  }
  await originalRename(from, to);
};
promises.open = (async (...args) => {
  const handle = await originalAsyncOpen(...args);
  if (process.env.CLAUDE_TEST_GROW_RULES === "1" && String(args[0]).endsWith("/pi-warden.md")) {
    const stat = handle.stat.bind(handle);
    handle.stat = (async (...options) => {
      const result = await stat(...options);
      fs.appendFileSync(args[0], "x".repeat(1024 * 1024 + 1));
      return result;
    }) as typeof handle.stat;
  }
  return handle;
}) as typeof promises.open;
fs.openSync = ((path, flags, mode) => {
  if (/request-\d+\.claim$/.test(String(path))) {
    if (process.env.CLAUDE_TEST_DENY_CLAIM === "1") throw Object.assign(new Error("Fixture persistence failure."), { code: "EACCES" });
    const barrier = process.env.CLAUDE_TEST_BARRIER;
    if (barrier && String(path).endsWith("request-1.claim")) {
      fs.writeFileSync(join(barrier, String(process.pid)), "ready");
      const until = Date.now() + 3000;
      while (fs.readdirSync(barrier).length < 2) {
        if (Date.now() > until) throw new Error("Fixture barrier timed out.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
    const fd = originalOpen(path, flags, mode);
    if (process.env.CLAUDE_TEST_CRASH_CLAIM === "1") {
      if (process.env.CLAUDE_TEST_CRASHED) fs.writeFileSync(process.env.CLAUDE_TEST_CRASHED, "engine killed after claim\n");
      process.kill(process.pid, "SIGKILL");
    }
    return fd;
  }
  return originalOpen(path, flags, mode);
}) as typeof fs.openSync;
syncBuiltinESMExports();

globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://judge.example/")) throw new Error("Unexpected offline transport destination.");
  const body = JSON.parse(String(init?.body));
  if (process.env.CLAUDE_TEST_CAPTURE) appendFileSync(process.env.CLAUDE_TEST_CAPTURE, `${JSON.stringify(body)}\n`);
  if (process.env.CLAUDE_TEST_HANG === "ignore") return new Promise<Response>(() => { setInterval(() => undefined, 60_000); });
  if (process.env.CLAUDE_TEST_AUTH_FIFO === "1") {
    const path = join(process.env.PI_CODING_AGENT_DIR!, "pi-typesafe", "auth-state.json");
    fs.rmSync(path, { force: true });
    execFileSync("mkfifo", [path]);
    return new Response("fixture auth failure", { status: 503 });
  }
  if (process.env.CLAUDE_TEST_HANG === "body") {
    let timer: ReturnType<typeof setInterval>;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from("{")); timer = setInterval(() => undefined, 60_000); },
      cancel() { clearInterval(timer); if (process.env.CLAUDE_TEST_CANCELLED) appendFileSync(process.env.CLAUDE_TEST_CANCELLED, "cancelled\n"); },
    }), { headers: { "content-type": "application/json" } });
  }
  if (process.env.CLAUDE_TEST_HTTP_FAIL === "1") return new Response("upstream body must never be echoed", { status: 503 });
  const state = body.state as { content?: string; edits?: Array<{ before?: string; after?: string; newText: string }> };
  const answers: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(body.questions)) {
    const question = raw as { criteria: Record<string, unknown> };
    const breaks = (text: string): boolean => id.includes("documents") ? /export function/.test(text) && !/@returns/.test(text) : text.includes("BAD");
    const violation = state.content !== undefined ? breaks(state.content)
      : (state.edits ?? []).some(edit => breaks(edit.after ?? edit.newText) && !breaks(edit.before ?? ""));
    const pick = id === "which_edit" ? Object.keys(question.criteria)[0]! : violation ? "violation" : "compliant";
    const keys = Object.keys(question.criteria);
    answers[id] = { type: "choice", choice: pick, confidence: 0.95, probabilities: Object.fromEntries(keys.map(key => [key, key === pick ? 0.95 : 0.05 / Math.max(1, keys.length - 1)])) };
  }
  return Response.json({ model: "jev-test", usage: { input_tokens: 1, output_tokens: 0 }, answers });
};
