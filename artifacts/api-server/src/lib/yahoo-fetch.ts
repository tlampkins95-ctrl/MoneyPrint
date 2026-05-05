import { SYMBOLS, type Symbol } from "./symbols";
import { fetchOkxPerpCandles } from "./crypto-perp-fetch";

export type Timeframe = "15m" | "30m" | "1h" | "1d";

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
  "15m": 60 * 1000,
  "30m": 2 * 60 * 1000,
  "1h": 5 * 60 * 1000,
  "1d": 5 * 60 * 1000,
};

const cache = new Map<string, CacheEntry>();
// Single-flight: when several callers ask for the same (symbol, timeframe)
// while a fetch is already in progress, they all await the same promise so
// the upstream API only sees one request burst.
const inFlight = new Map<string, Promise<CandleRaw[]>>();

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

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = doFetch(symbol, timeframe).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

// Gate.io v4 spot candlesticks. Used for tokens not on OKX perps or Yahoo Finance
// (e.g. SKYAIUSDT). Returns ascending-sorted candles, max 1000 per request.
// Row format: [timestamp_s, vol_quote, open, high, low, close, vol_base, is_closed]
const GATEIO_BASE = "https://api.gateio.ws/api/v4";
const GATEIO_INTERVAL: Record<Timeframe, string> = {
  "15m": "15m",
  "30m": "30m",
  "1h":  "1h",
  "1d":  "1d",
};
// Gate.io caps at 1000 per request; for small-cap tokens that's usually enough
// for all indicators (EMA200 needs 200+ bars, RSI/MACD need ~35).
const GATEIO_LIMIT = 1000;

async function fetchGateioCandles(
  currencyPair: string,
  timeframe: Timeframe,
): Promise<CandleRaw[]> {
  const interval = GATEIO_INTERVAL[timeframe];
  const url = `${GATEIO_BASE}/spot/candlesticks?currency_pair=${encodeURIComponent(currencyPair)}&interval=${interval}&limit=${GATEIO_LIMIT}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Gate.io fetch failed: ${response.status}`);
  const json = (await response.json()) as string[][];
  const isIntraday = timeframe !== "1d";
  const candles: CandleRaw[] = [];
  for (const row of json) {
    const ts  = Number(row[0]) * 1000; // Gate.io returns seconds
    const o   = parseFloat(row[2]);
    const h   = parseFloat(row[3]);
    const l   = parseFloat(row[4]);
    const c   = parseFloat(row[5]);
    const v   = parseFloat(row[6]);
    if (!isFinite(ts) || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    const iso = new Date(ts).toISOString();
    candles.push({
      date:   isIntraday ? iso : iso.split("T")[0],
      open:   o,
      high:   h,
      low:    l,
      close:  c,
      volume: isFinite(v) ? v : 0,
    });
  }
  // Gate.io returns oldest-first (ascending) — already correct order.
  return candles;
}

async function doFetch(
  symbol: Symbol,
  timeframe: Timeframe,
): Promise<CandleRaw[]> {
  const now = Date.now();
  const key = cacheKey(symbol, timeframe);

  // Crypto perps → OKX USDT-M swaps (true crypto price discovery; Binance &
  // Bybit are geo-blocked from US-based servers, OKX is not).
  const perpSymbol = SYMBOLS[symbol].okxPerp;
  if (perpSymbol) {
    const candles = await fetchOkxPerpCandles(perpSymbol, timeframe);
    cache.set(key, { candles, timestamp: now });
    return candles;
  }

  // Gate.io spot candles — for tokens not on OKX or Yahoo (e.g. SKYAIUSDT).
  const gateioSymbol = SYMBOLS[symbol].gateioSpot;
  if (gateioSymbol) {
    const candles = await fetchGateioCandles(gateioSymbol, timeframe);
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
