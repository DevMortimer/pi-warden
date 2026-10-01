/**
 * The cost axis for the A/B eval: dollars per run, agent plus Jev. Pure functions
 * over two files the run leaves behind — the session log (agent tokens) and the
 * run's own pi-typesafe usage ledger (Jev requests and input tokens) — priced by
 * the table in eval/config.mjs. Shares no code with the guard, like the other
 * scorers: no judgment can influence a cost.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JEV_PRICE, hasPrice, priceFor } from "./config.mjs";

/**
 * One entry per assistant turn that carries `usage`: the call's start time (the
 * message's own epoch-millisecond timestamp, which a time-priced model is billed by)
 * and its four token counts. Turns without usage are skipped.
 */
export function sessionCalls(events) {
  const calls = [];
  for (const event of events) {
    const usage = event.message?.usage;
    if (event.message?.role !== "assistant" || typeof usage?.totalTokens !== "number") continue;
    calls.push({
      at: Number(event.message.timestamp),
      input: usage.input ?? 0, output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens,
    });
  }
  return calls;
}

/**
 * Agent tokens per run, summed over every assistant turn's `usage`: input, output,
 * cacheRead, cacheWrite (the four the price table has rates for) and totalTokens.
 * Returns zeros when the log carries no usage.
 */
export function sessionTokens(events) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, turns: 0 };
  for (const call of sessionCalls(events)) {
    tokens.input += call.input;
    tokens.output += call.output;
    tokens.cacheRead += call.cacheRead;
    tokens.cacheWrite += call.cacheWrite;
    tokens.totalTokens += call.totalTokens;
    tokens.turns++;
  }
  return tokens;
}

/**
 * Jev requests and tokens the run made, from pi-typesafe's usage ledger in the run's
 * own agent dir. The ledger is per run (each run gets a fresh agent dir), so the sum
 * over its days is exactly this run's Jev spend.
 */
export function jevUsage(agentDir) {
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const path = join(agentDir, "pi-typesafe", "usage.json");
  if (!existsSync(path)) return usage;
  let days;
  try {
    days = JSON.parse(readFileSync(path, "utf8")).days ?? {};
  } catch {
    return usage;
  }
  for (const day of Object.values(days)) {
    usage.requests += Number(day?.requestsStarted) || 0;
    usage.inputTokens += Number(day?.inputTokens) || 0;
    usage.outputTokens += Number(day?.outputTokens) || 0;
  }
  return usage;
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Each model call priced by its own timestamp: `{ at, atIso, window, usd, ...tokens }`
 * with `window` "peak", "off-peak", or "flat" and `usd` null (window null) when the
 * model has no price for that call. The calls of one run sum to the run's agent dollars.
 */
export function callCosts(events, model) {
  return sessionCalls(events).map((call) => {
    const rates = priceFor(model, call.at);
    const atIso = Number.isFinite(call.at) ? new Date(call.at).toISOString() : null;
    if (!rates) return { ...call, atIso, window: null, usd: null };
    const usd = (call.input * rates.input + call.output * rates.output + call.cacheRead * rates.cacheRead + call.cacheWrite * rates.cacheWrite) / 1e6;
    return { ...call, atIso, window: rates.window, usd };
  });
}

/**
 * Dollars for one run: agent tokens at the model's prices, each call at the price of
 * its own timestamp, plus Jev requests and input tokens at the Jev prices. `usd` is
 * null when the price table cannot price some call; the token counts are still
 * reported. `windows` splits the agent dollars by price window.
 */
export function runCost({ events, agentDir, model }) {
  const tokens = sessionTokens(events);
  const jev = jevUsage(agentDir);
  const jevUsd = round6(
    jev.requests * JEV_PRICE.perRequestUsd +
    (jev.inputTokens * JEV_PRICE.inputUsdPerMTok + jev.outputTokens * JEV_PRICE.outputUsdPerMTok) / 1e6,
  );
  const calls = callCosts(events, model);
  const unpriced = calls.find((call) => call.usd === null);
  if (!hasPrice(model) || unpriced) {
    const reason = !hasPrice(model) ? `no price for ${model} in eval/config.mjs` : `no price for ${model} at ${unpriced.atIso ?? "a call without a timestamp"} in eval/config.mjs`;
    return { model, tokens, jev, agentUsd: null, jevUsd, usd: null, reason };
  }
  const windows = {};
  for (const call of calls) {
    const w = (windows[call.window] ??= { calls: 0, usd: 0 });
    w.calls++;
    w.usd += call.usd;
  }
  for (const w of Object.values(windows)) w.usd = round6(w.usd);
  const agentUsd = round6(calls.reduce((s, call) => s + call.usd, 0));
  return { model, tokens, jev, agentUsd, jevUsd, usd: round6(agentUsd + jevUsd), windows };
}
