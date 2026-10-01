/**
 * The eval config: the price table the cost axis turns token counts into dollars
 * with. Pure data and two lookups; it shares no code with the guard, like the other
 * scorers.
 *
 * Prices are USD per million tokens (input, output, cacheRead, cacheWrite). The two
 * models the thesis run is registered for (eval/preregistration.md) are keyed by
 * their exact Pi specs. Pi's own dollar figures are never the source: Pi's catalog
 * carries only DeepSeek's peak prices, so a price here comes from the provider's
 * published page, named per entry.
 *
 *   A = `deepseek/deepseek-flash` (DeepSeek V4.1 Flash): billed per token, and
 *       DeepSeek prices by the hour of the call. Each model call is priced at the
 *       peak or the off-peak rate by its own timestamp (see `deepseekWindow`).
 *   B = `claude-bridge/claude-sonnet-5-5` (Claude Sonnet 5.5): runs on a plan with
 *       no per-token bill, so its dollars are Anthropic's published list prices as
 *       an equivalent for comparison, not billed spend. Quota use is judged from
 *       its token counts, which the cost axis reports alongside.
 *
 * The cost axis reads agent tokens from the run's session log and Jev tokens from
 * the run's own pi-typesafe usage ledger, so a per-run dollar figure is
 * reproducible offline from a report folder.
 */

/** Where each price table comes from; the pre-registration repeats these. */
export const PRICE_SOURCES = {
  deepseek: "DeepSeek API docs, Models & Pricing: https://api-docs.deepseek.com/quick_start/pricing (read 2026-10-01)",
  anthropic: "Anthropic Claude API docs, Pricing: https://docs.claude.com/en/docs/about-claude/pricing (read 2026-10-01)",
  holidays: "General Office of the State Council of China, notice on the 2026 public holiday arrangements (国办发明电〔2025〕7号, 2025-11-04): https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html",
};

/**
 * Chinese public holidays of 2026 (days off), from the State Council notice named in
 * PRICE_SOURCES.holidays. DeepSeek bills these days at the off-peak rate in full. The
 * notice's make-up working days (Jan 4, Feb 14, Feb 28, May 9, Sep 20, Oct 10) fall on
 * weekends, which DeepSeek's page also lists as off-peak, so they stay off-peak.
 */
export const CHINESE_HOLIDAYS = {
  2026: [
    ["2026-01-01", "2026-01-03"], // New Year
    ["2026-02-15", "2026-02-23"], // Spring Festival
    ["2026-04-04", "2026-04-06"], // Qingming
    ["2026-05-01", "2026-05-05"], // Labour Day
    ["2026-06-19", "2026-06-21"], // Dragon Boat
    ["2026-09-25", "2026-09-27"], // Mid-Autumn
    ["2026-10-01", "2026-10-07"], // National Day
  ],
};

/**
 * DeepSeek's peak hours, UTC: 01:00-04:00 and 06:00-10:00, Monday to Friday, except
 * Chinese public holidays; every other hour is off-peak. Both windows sit inside one
 * Beijing calendar day (09:00-12:00 and 14:00-18:00 there), so the UTC date and the
 * Beijing date agree on whether a peak-hour call is on a holiday.
 *
 * Returns "peak" or "off-peak" for a call time in epoch milliseconds, or null when
 * the table has no holiday calendar for that year (the price is then unknown).
 */
export function deepseekWindow(atMs) {
  const at = new Date(atMs);
  const year = at.getUTCFullYear();
  const holidays = CHINESE_HOLIDAYS[year];
  if (!holidays) return null;
  const day = at.toISOString().slice(0, 10);
  if (holidays.some(([from, to]) => day >= from && day <= to)) return "off-peak";
  const weekday = at.getUTCDay();
  if (weekday === 0 || weekday === 6) return "off-peak";
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? "peak" : "off-peak";
}

/** deepseek-flash, per 1M tokens, peak; off-peak is half (the page's table lists both). */
const DEEPSEEK_FLASH_PEAK = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
const half = (rates) => Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v / 2]));

/** Agent prices per 1M tokens: input, output, cacheRead, cacheWrite. */
export const PRICES = {
  "deepseek/deepseek-flash": {
    peak: DEEPSEEK_FLASH_PEAK,
    "off-peak": half(DEEPSEEK_FLASH_PEAK), // 0.15 / 0.60 / 0.003 as the page lists
    window: deepseekWindow,
    source: PRICE_SOURCES.deepseek,
    holidaySource: PRICE_SOURCES.holidays,
    billed: true,
  },
  "claude-bridge/claude-sonnet-5-5": {
    // Sonnet 5.5 list prices; cacheWrite is the 5-minute write (1.25x input), cacheRead 0.1x input.
    flat: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    source: PRICE_SOURCES.anthropic,
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

/**
 * The rates for one model call: `{ input, output, cacheRead, cacheWrite, window }`,
 * where `window` is "peak", "off-peak", or "flat" (a model with one price). Returns
 * null when the table has no entry for the model, or when the model prices by the
 * hour and the call has no usable timestamp or falls in a year without a calendar.
 */
export function priceFor(model, atMs) {
  const entry = PRICES[model];
  if (!entry) return null;
  if (entry.flat) return { ...entry.flat, window: "flat" };
  if (!Number.isFinite(atMs)) return null;
  const window = entry.window(atMs);
  return window ? { ...entry[window], window } : null;
}

/** True when a registered model's table has any entry at all. */
export const hasPrice = (model) => model in PRICES;
