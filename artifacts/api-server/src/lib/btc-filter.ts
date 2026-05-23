import { logger } from "./logger";
import { fetchCandlesForTimeframe, type Timeframe } from "./yahoo-fetch";
import { computeLevelsStable, fetchSpotPrice } from "./signals";
import { SYMBOLS } from "./symbols";

export type MacroTrend = "UPTREND" | "DOWNTREND" | "RANGING";

const BTC_CACHE_TTL_MS = 5 * 60 * 1000;
const btcTrendCache = new Map<string, { trend: MacroTrend; fetchedAt: number }>();

/**
 * Returns BTC's trend on the given timeframe (default: 1d), cached for 5 minutes.
 * Uses EMA21/50 crossover + ADX — the same computation used by every other symbol.
 * Returns null if candle data cannot be fetched (fail-open: gate is skipped).
 */
export async function getBtcMacroTrend(timeframe: Timeframe = "1d"): Promise<MacroTrend | null> {
  const cached = btcTrendCache.get(timeframe);
  if (cached && Date.now() - cached.fetchedAt < BTC_CACHE_TTL_MS) {
    return cached.trend;
  }
  try {
    const [candles, spot] = await Promise.all([
      fetchCandlesForTimeframe("BTCUSD", timeframe),
      fetchSpotPrice("BTCUSD"),
    ]);
    if (candles.length < 2) return null;
    const result = computeLevelsStable(candles, spot, timeframe, "BTCUSD", SYMBOLS["BTCUSD"]);
    const trend = result.trend as MacroTrend;
    btcTrendCache.set(timeframe, { trend, fetchedAt: Date.now() });
    return trend;
  } catch (err) {
    logger.warn({ err, timeframe }, "getBtcMacroTrend: failed — gate skipped");
    return null;
  }
}

/**
 * Returns true if this symbol should have BUY signals gated on the BTC macro trend.
 * Applies to all crypto symbols except BTC itself.
 */
export function isBtcMacroGated(symbolKey: string, category: string): boolean {
  return category === "crypto" && symbolKey !== "BTCUSD";
}
