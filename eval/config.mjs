/**
 * The eval config: the price table the cost axis turns token counts into dollars
 * with. Pure data and one lookup; it shares no code with the guard, like the other
 * scorers.
 *
 * Prices are USD per million tokens (input, output, cacheRead, cacheWrite) and come
 * from Pi's model catalog: the `cost` field of each model's catalog entry. The two
 * models the thesis run is registered for (eval/preregistration.md) are keyed by
 * their exact Pi specs:
 *
 *   A = `deepseek/deepseek-flash` (DeepSeek V4.1 Flash), catalog entry
 *       `deepseek` / `deepseek-flash`: billed per token at those rates.
 *   B = `claude-bridge/claude-opus-4-8`, catalog entry `claude-opus-4-8` (list
 *       prices): B runs on a plan with no per-token bill, so its dollars are
 *       list-price equivalents for comparison, not billed spend. Quota use is
 *       judged from its token counts, which the cost axis reports alongside.
 *
 * The cost axis reads agent tokens from the run's session log and Jev tokens from
 * the run's own pi-typesafe usage ledger, so a per-run dollar figure is
 * reproducible offline from a report folder.
 */

/** Agent prices per 1M tokens: input, output, cacheRead, cacheWrite. */
export const PRICES = {
  "deepseek/deepseek-flash": {
    input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0,
    source: "Pi model catalog, deepseek/deepseek-flash",
    billed: true,
  },
  "claude-bridge/claude-opus-4-8": {
    input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25,
    source: "Pi model catalog, claude-opus-4-8 list prices",
    billed: false,
  },
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
