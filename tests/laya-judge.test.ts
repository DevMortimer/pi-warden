import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Judge } from "pi-typesafe";
import { LayaJudge } from "../src/laya-judge.js";

// A stand-in for the local Laya System One endpoint: records the request, replies with a scriptable status/body.
let server: Server;
let captured: { method: string; url: string; body: any } | undefined;
let reply: { status: number; body: unknown } = { status: 200, body: {} };

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured = { method: req.method ?? "", url: req.url ?? "", body: JSON.parse(raw) };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
const request = () => ({
  state: { ticket: { messages: [{ sender: "user", text: "payout failed" }] } },
  questions: { needs_followup: { type: "noul" as const, instructions: "Does the message need a follow-up?" } },
});
const okBody = () => ({
  model: "aac6fef/laya-mlx",
  answers: { needs_followup: { type: "noul", noul: 0.91 } },
  usage: { input_tokens: 42, output_tokens: 0, elapsed_ms: 31.5 },
});

test("evaluate: posts the SystemOneRequest as JSON and returns the normalized result", async () => {
  reply = { status: 200, body: okBody() };
  const judge: Judge = new LayaJudge(url());
  const result = await judge.evaluate(request());
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.url, "/v1/systemone");
  assert.deepEqual(captured?.body, request());
  assert.equal(result.model, "aac6fef/laya-mlx");
  assert.deepEqual(result.answers, { needs_followup: { type: "noul", noul: 0.91 } });
  assert.deepEqual(result.usage, { input_tokens: 42, output_tokens: 0, elapsed_ms: 31.5 });
  assert.equal(result.elapsedMs, 31.5);
});

test("evaluate: falls back to the laya-mlx model name when the response omits it", async () => {
  reply = { status: 200, body: { answers: okBody().answers, usage: okBody().usage } };
  const judge = new LayaJudge(url());
  const result = await judge.evaluate(request());
  assert.equal(result.model, "laya-mlx");
});

test("evaluate: throws on an HTTP error status", async () => {
  reply = { status: 500, body: { detail: "model exploded" } };
  const judge = new LayaJudge(url());
  await assert.rejects(() => judge.evaluate(request()), /HTTP 500/);
});

test("evaluate: throws when the response carries no answers", async () => {
  reply = { status: 200, body: { model: "aac6fef/laya-mlx", usage: {} } };
  const judge = new LayaJudge(url());
  await assert.rejects(() => judge.evaluate(request()), /no answers/);
});

test("evaluate: rejects when the signal is already aborted", async () => {
  reply = { status: 200, body: okBody() };
  const judge = new LayaJudge(url());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => judge.evaluate(request(), { signal: controller.signal }));
});

test("getUsage: counts evaluated requests", async () => {
  reply = { status: 200, body: okBody() };
  const judge = new LayaJudge(url());
  await judge.evaluate(request());
  await judge.evaluate(request());
  const usage = judge.getUsage();
  assert.equal(usage.requestsStarted, 2);
  assert.equal(usage.requestsSucceeded, 2);
  assert.equal(usage.requestsFailed, 0);
  assert.equal(usage.estimatedUsd, 0);
});
