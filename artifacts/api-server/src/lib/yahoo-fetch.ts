import { SYMBOLS, type Symbol } from "./symbols";
import { fetchOkxPerpCandles } from "./crypto-perp-fetch";

export type Timeframe = "15m" | "1h" | "4h" | "1d" | "1w";

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
  "15m": { interval: "15m", range: "60d"  }, // Yahoo caps 15m history at ~60 days
  "1h": { interval: "60m", range: "730d" },
  "4h": { interval: "60m", range: "730d" }, // placeholder — 4h uses Twelve Data, not Yahoo
  "1d": { interval: "1d",  range: "2y"   },
  "1w": { interval: "1wk", range: "10y"  },
};

interface CacheEntry {
  candles: CandleRaw[];
  timestamp: number;
}

const CACHE_TTL_MS: Record<Timeframe, number> = {
  "15m": 2 * 60 * 1000,
  "1h": 5 * 60 * 1000,
  "4h": 15 * 60 * 1000,
  "1d": 5 * 60 * 1000,
  "1w": 30 * 60 * 1000,
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
  "1h":  "1h",
  "4h":  "4h",
  "1d":  "1d",
  "1w":  "7d",
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
  const isIntraday = timeframe !== "1d" && timeframe !== "1w";
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

// ─── Twelve Data ─────────────────────────────────────────────────────────────
// Native 4h candles for forex and metals. Yahoo Finance only offers up to 1h
// natively; Twelve Data fills the gap with clean server-side 4h bars.
// Free tier: 800 credits/day — one request per credit. Our polling cadence
// (one 4h fetch per symbol per 15 min) stays well under that limit.
async function fetchTwelveDataCandles(twelveDataSymbol: string): Promise<CandleRaw[]> {
  const apiKey = process.env["TWELVE_DATA_API_KEY"];
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY not set");
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${twelveDataSymbol}` +
    `&interval=4h&outputsize=500&order=ASC&apikey=${apiKey}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Twelve Data fetch failed: ${response.status}`);
  const json = (await response.json()) as {
    status?: string;
    message?: string;
    values?: Array<{
      datetime: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume?: string;
    }>;
  };
  if (json.status === "error") throw new Error(`Twelve Data: ${json.message}`);
  if (!json.values?.length) throw new Error("Twelve Data: no data returned");
  // Twelve Data datetime is UTC: "2026-05-29 03:00:00" — convert to ISO.
  return json.values.map((v) => ({
    date: new Date(v.datetime.replace(" ", "T") + "Z").toISOString(),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseFloat(v.volume ?? "0") || 0,
  }));
}

// ─── 1h → 4h aggregation ─────────────────────────────────────────────────────
// Groups 1h Yahoo candles into 4-hour UTC blocks (00:00, 04:00, 08:00, …).
// Used as a fallback for metals (XAG/USD, XAU/USD) where Twelve Data requires
// a paid plan but Yahoo Finance's 1h feed is freely available.
function aggregate1hTo4h(candles: CandleRaw[]): CandleRaw[] {
  const BLOCK_MS = 4 * 60 * 60 * 1000;
  const groups = new Map<number, CandleRaw[]>();
  for (const c of candles) {
    const block = Math.floor(new Date(c.date).getTime() / BLOCK_MS) * BLOCK_MS;
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block)!.push(c);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([blockMs, bars]) => ({
      date: new Date(blockMs).toISOString(),
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    }));
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

  // 4h → Twelve Data if configured, otherwise aggregate Yahoo 1h into 4h blocks.
  // Metals (XAG/USD, XAU/USD) require a paid Twelve Data plan; they fall back to
  // the Yahoo 1h feed which is free and covers SI=F / GC=F without restriction.
  if (timeframe === "4h") {
    const tdSymbol = SYMBOLS[symbol].twelveData;
    if (tdSymbol) {
      const candles = await fetchTwelveDataCandles(tdSymbol);
      cache.set(key, { candles, timestamp: now });
      return candles;
    }
    // Fallback: fetch Yahoo 1h then collapse into 4h UTC blocks.
    const candles1h = await fetchCandlesForTimeframe(symbol, "1h");
    const candles = aggregate1hTo4h(candles1h);
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
  const isIntraday = timeframe !== "1d" && timeframe !== "1w";
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
