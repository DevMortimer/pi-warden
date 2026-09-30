/**
 * The eval config: the price table the cost axis turns token counts into dollars
 * with. Pure data and one lookup; it shares no code with the guard, like the other
 * scorers.
 *
 * Prices are USD per million tokens, taken from the provider model catalogs. The
 * cost axis reads agent tokens from the run's session log and Jev tokens from the
 * run's own pi-typesafe usage ledger, so a per-run dollar figure is reproducible
 * offline from a report folder.
 */

/** Agent prices per 1M tokens: input, output, cacheRead, cacheWrite. */
export const PRICES = {
  // The cheap cell of the planned batch. Both spellings price the same model.
  "deepseek/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  "deepseek/deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  // The model the earlier reports used, priced from its catalog entry.
  "z-ai/glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  // The stronger model the batch cost is estimated on.
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

/**
 * Jev request prices. TypeSafe bills input tokens only (output is free), which is
 * what pi-typesafe's own $/MTok default reflects; `perRequestUsd` stays 0 so the
 * cost axis prices a request count that is not separately billed. Override both
 * here when a rate changes.
 */
export const JEV_PRICE = { perRequestUsd: 0, inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 };

/** The price entry for a `provider/model` string, or null when the table has none. */
export function priceFor(model) {
  return PRICES[model] ?? null;
}
