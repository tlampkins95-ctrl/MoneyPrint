import { SYMBOLS, type Symbol } from "./symbols";
import { fetchOkxPerpCandles } from "./crypto-perp-fetch";

export type Timeframe = "1m" | "15m" | "30m" | "1h" | "1d";

export interface CandleRaw {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface YahooConfig {
  interval: string;
  range: string;
}

const TIMEFRAME_MAP: Record<Timeframe, YahooConfig> = {
  "1m": { interval: "1m", range: "5d" },
  "15m": { interval: "15m", range: "60d" },
  "30m": { interval: "30m", range: "60d" },
  "1h": { interval: "60m", range: "730d" },
  "1d": { interval: "1d", range: "2y" },
};

interface CacheEntry {
  candles: CandleRaw[];
  timestamp: number;
}

const CACHE_TTL_MS: Record<Timeframe, number> = {
  "1m": 30 * 1000,
  "15m": 60 * 1000,
  "30m": 2 * 60 * 1000,
  "1h": 5 * 60 * 1000,
  "1d": 5 * 60 * 1000,
};

const cache = new Map<string, CacheEntry>();

function cacheKey(symbol: Symbol, timeframe: Timeframe): string {
  return `${symbol}::${timeframe}`;
}

export async function fetchCandlesForTimeframe(
  symbol: Symbol,
  timeframe: Timeframe,
): Promise<CandleRaw[]> {
  const now = Date.now();
  const key = cacheKey(symbol, timeframe);
  const existing = cache.get(key);
  if (existing && now - existing.timestamp < CACHE_TTL_MS[timeframe]) {
    return existing.candles;
  }

  // Crypto perps → OKX USDT-M swaps (true crypto price discovery; Binance &
  // Bybit are geo-blocked from US-based servers, OKX is not).
  const perpSymbol = SYMBOLS[symbol].okxPerp;
  if (perpSymbol) {
    const candles = await fetchOkxPerpCandles(perpSymbol, timeframe);
    cache.set(key, { candles, timestamp: now });
    return candles;
  }

  const cfg = TIMEFRAME_MAP[timeframe];
  const yahooSymbol = SYMBOLS[symbol].yahoo;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol,
  )}?interval=${cfg.interval}&range=${cfg.range}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; XAGUSD-Screener/1.0)" },
  });
  if (!response.ok) throw new Error(`Yahoo fetch failed: ${response.status}`);

  const json = (await response.json()) as {
    chart: {
      result: Array<{
        timestamp: number[];
        indicators: {
          quote: Array<{
            open: number[];
            high: number[];
            low: number[];
            close: number[];
            volume: number[];
          }>;
        };
      }> | null;
      error: { code: string; description: string } | null;
    };
  };
  if (!json.chart.result?.length) {
    throw new Error(`Yahoo: ${json.chart.error?.description ?? "No data"}`);
  }
  const r = json.chart.result[0];
  const q = r.indicators.quote[0];
  const isIntraday = timeframe !== "1d";
  const candles: CandleRaw[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    const iso = new Date(r.timestamp[i] * 1000).toISOString();
    candles.push({
      date: isIntraday ? iso : iso.split("T")[0],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: q.volume[i] ?? 0,
    });
  }
  cache.set(key, { candles, timestamp: now });
  return candles;
}
