/** Types for eval/config.mjs. */

export type PriceWindow = "peak" | "off-peak" | "flat";

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PriceEntry {
  peak?: Rates;
  "off-peak"?: Rates;
  flat?: Rates;
  window?: (atMs: number) => "peak" | "off-peak" | null;
  source: string;
  holidaySource?: string;
  billed: boolean;
}

export const PRICE_SOURCES: { deepseek: string; anthropic: string; holidays: string };
export const CHINESE_HOLIDAYS: Record<number, [string, string][]>;
export const PRICES: Record<string, PriceEntry>;
export const JEV_PRICE: { perRequestUsd: number; inputUsdPerMTok: number; outputUsdPerMTok: number };
export function deepseekWindow(atMs: number): "peak" | "off-peak" | null;
export function priceFor(model: string, atMs?: number): (Rates & { window: PriceWindow }) | null;
export function hasPrice(model: string): boolean;
