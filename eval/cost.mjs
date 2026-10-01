/**
 * The cost axis for the A/B eval: dollars per run, agent plus Jev. Pure functions
 * over two files the run leaves behind — the session log (agent tokens) and the
 * run's own pi-typesafe usage ledger (Jev requests and input tokens) — priced by
 * the table in eval/config.mjs. Shares no code with the guard, like the other
 * scorers: no judgment can influence a cost.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JEV_PRICE, priceFor } from "./config.mjs";

/**
 * Agent tokens per run, summed over every assistant turn's `usage`: input, output,
 * cacheRead, cacheWrite (the four the price table has rates for) and totalTokens.
 * Returns zeros when the log carries no usage.
 */
export function sessionTokens(events) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, turns: 0 };
  for (const event of events) {
    const usage = event.message?.usage;
    if (event.message?.role !== "assistant" || typeof usage?.totalTokens !== "number") continue;
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
    tokens.cacheWrite += usage.cacheWrite ?? 0;
    tokens.totalTokens += usage.totalTokens;
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
 * Dollars for one run: agent tokens at the model's prices plus Jev requests and
 * input tokens at the Jev prices. `usd` is null when the price table has no entry
 * for the model; the token counts are still reported.
 */
export function runCost({ events, agentDir, model }) {
  const tokens = sessionTokens(events);
  const jev = jevUsage(agentDir);
  const prices = priceFor(model);
  const jevUsd = round6(
    jev.requests * JEV_PRICE.perRequestUsd +
    (jev.inputTokens * JEV_PRICE.inputUsdPerMTok + jev.outputTokens * JEV_PRICE.outputUsdPerMTok) / 1e6,
  );
  if (!prices) {
    return { model, tokens, jev, agentUsd: null, jevUsd, usd: null, reason: `no price for ${model} in eval/config.mjs` };
  }
  const agentUsd = round6(
    (tokens.input * prices.input + tokens.output * prices.output +
      tokens.cacheRead * prices.cacheRead + tokens.cacheWrite * prices.cacheWrite) / 1e6,
  );
  return { model, tokens, jev, agentUsd, jevUsd, usd: round6(agentUsd + jevUsd) };
}
