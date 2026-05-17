import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { SYMBOLS, makeRounder, type Symbol, type SymbolMeta } from "./symbols";
import { type CandleRaw, type Timeframe } from "./yahoo-fetch";
import { fetchOkxPerpPrice, fetchPhemexPerpPrice } from "./crypto-perp-fetch";
import { fetchPythPrice } from "./pyth-fetch";
import { detectChartPattern, detectCandlestickSignal, type PatternResult } from "./patterns";

// ─── Live spot price (per-symbol cache) ──────────────────────────────────────

interface SpotCacheEntry {
  price: number;
  timestamp: number;
}
const spotCache = new Map<Symbol, SpotCacheEntry>();
const SPOT_CACHE_TTL_MS = 30 * 1000;

// Yahoo Finance chart API — returns regularMarketPrice (live tick) for forex.
// Used as the primary live-price source for forex pairs before falling back to
// the TradingView HTML scrape, which only returns the daily close (stale).
async function fetchFromYahooSpot(symbol: Symbol): Promise<number | null> {
  const yahooSymbol = SYMBOLS[symbol].yahoo;
  if (!yahooSymbol) return null;
  // Only use for forex — metals use Swissquote, crypto uses Phemex/Pyth/OKX.
  const isMetals = SYMBOLS[symbol].hasFuturesBasis === true;
  const isCrypto = Boolean(SYMBOLS[symbol].phemexPerp ?? SYMBOLS[symbol].coinbase);
  if (isMetals || isCrypto) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; XAGUSD-Screener/1.0)" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      chart: { result: Array<{ meta: { regularMarketPrice: number } }> | null };
    };
    const price = json.chart.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" && isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

async function fetchFromTradingView(symbol: Symbol): Promise<number | null> {
  try {
    const path = SYMBOLS[symbol].tvScrapePath;
    const response = await fetch(`https://www.tradingview.com${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(/"close":"([0-9.]+)"/);
    if (!match) return null;
    const price = parseFloat(match[1]);
    return isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

async function fetchFromGoldApi(symbol: Symbol): Promise<number | null> {
  const goldApi = SYMBOLS[symbol].goldApi;
  if (!goldApi) return null;
  try {
    const response = await fetch(`https://api.gold-api.com/price/${goldApi}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { price: number };
    return typeof json.price === "number" && isFinite(json.price) ? json.price : null;
  } catch {
    return null;
  }
}

// Swissquote free public BBO feed — returns the broker mid-price (bid+ask)/2
// for XAG/USD and XAU/USD. Matches MT5/OANDA spot pricing far better than
// gold-api.com which quotes the metals dealer ask price.
async function fetchFromSwissquote(symbol: Symbol): Promise<number | null> {
  if (!SYMBOLS[symbol].hasFuturesBasis) return null;
  const base = symbol === "XAGUSD" ? "XAG" : symbol === "XAUUSD" ? "XAU" : null;
  if (!base) return null;
  try {
    const response = await fetch(
      `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${base}/USD`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    // Swissquote returns a JSON array; the first element has spreadProfilePrices.
    const json = (await response.json()) as Array<{
      spreadProfilePrices?: Array<{ spreadProfile: string; bid: number; ask: number }>;
    }>;
    // Take the first available spread profile — Swissquote sometimes omits
    // the "standard" profile, but any profile's mid (bid+ask)/2 is accurate.
    const profile = json[0]?.spreadProfilePrices?.[0];
    if (!profile || !isFinite(profile.bid) || !isFinite(profile.ask)) return null;
    return (profile.bid + profile.ask) / 2;
  } catch {
    return null;
  }
}

async function fetchFromOkxPerp(symbol: Symbol): Promise<number | null> {
  const perp = SYMBOLS[symbol].okxPerp;
  if (!perp) return null;
  return fetchOkxPerpPrice(perp);
}

async function fetchFromPhemexPerp(symbol: Symbol): Promise<number | null> {
  const perp = SYMBOLS[symbol].phemexPerp;
  if (!perp) return null;
  return fetchPhemexPerpPrice(perp);
}

async function fetchFromPhemexSpot(symbol: Symbol): Promise<number | null> {
  const meta = SYMBOLS[symbol];
  const spotSym = meta.phemexSpot;
  const scale = meta.phemexSpotPriceScale;
  if (!spotSym || !scale) return null;
  try {
    const response = await fetch(
      `https://api.phemex.com/md/spot/ticker/24hr?symbol=${spotSym}`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { result?: { lastEp?: number } };
    const ep = json.result?.lastEp;
    if (typeof ep !== "number" || !isFinite(ep) || ep <= 0) return null;
    const price = ep / Math.pow(10, scale);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchFromPyth(symbol: Symbol): Promise<number | null> {
  const feedId = SYMBOLS[symbol].pythFeedId;
  if (!feedId) return null;
  return fetchPythPrice(feedId);
}

async function fetchFromCoinbase(symbol: Symbol): Promise<number | null> {
  const pair = SYMBOLS[symbol].coinbase;
  if (!pair) return null;
  try {
    const response = await fetch(
      `https://api.coinbase.com/v2/prices/${pair}/spot`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: { amount?: string } };
    const raw = json.data?.amount;
    if (typeof raw !== "string") return null;
    const price = parseFloat(raw);
    return isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function fetchSpotPrice(symbol: Symbol): Promise<number | null> {
  const now = Date.now();
  const cached = spotCache.get(symbol);
  if (cached && now - cached.timestamp < SPOT_CACHE_TTL_MS) {
    return cached.price;
  }
  // Price cascade (most authoritative first):
  //  • Swissquote   — first for metals (XAG/XAU): live interbank BBO mid, matches
  //                   MT5/OANDA spot. Must come before TradingView which serves
  //                   stale CDN-cached prices for metals.
  //  • Phemex spot  — primary for spot tokens (e.g. SKYAI), matches Phemex spot chart
  //  • OKX perp     — primary for crypto perps (BTC/ETH/ZEC); matches OKX:BTCUSDT.P
  //                   chart and is the same source as the OKX candle data, so the
  //                   "now price" line is consistent with all pivot/ATR calculations.
  //  • Phemex perp  — fallback perp (near-identical price; kept for resilience)
  //  • Pyth oracle  → Coinbase spot (further crypto fallbacks)
  //  • TradingView  — scrape fallback for forex pairs (NOT used for metals)
  //  • GoldAPI      — final metals fallback
  const isMetals = SYMBOLS[symbol].hasFuturesBasis === true;
  const price =
    (await fetchFromSwissquote(symbol)) ??
    (await fetchFromPhemexSpot(symbol)) ??
    (await fetchFromOkxPerp(symbol)) ??
    (await fetchFromPhemexPerp(symbol)) ??
    (await fetchFromPyth(symbol)) ??
    (await fetchFromCoinbase(symbol)) ??
    (isMetals ? null : await fetchFromYahooSpot(symbol)) ??
    (isMetals ? null : await fetchFromTradingView(symbol)) ??
    (await fetchFromGoldApi(symbol));
  if (price !== null) {
    spotCache.set(symbol, { price, timestamp: now });
    return price;
  }
  return cached?.price ?? null;
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function calcPivots(high: number, low: number, close: number, round: (n: number) => number) {
  const pivot = (high + low + close) / 3;
  return {
    pivot: round(pivot),
    r1: round(2 * pivot - low),
    r2: round(pivot + (high - low)),
    r3: round(high + 2 * (pivot - low)),
    s1: round(2 * pivot - high),
    s2: round(pivot - (high - low)),
    s3: round(low - 2 * (high - pivot)),
  };
}

function calcFibLevels(swingHigh: number, swingLow: number, round: (n: number) => number) {
  const range = swingHigh - swingLow;
  return {
    fib236: round(swingHigh - range * 0.236),
    fib382: round(swingHigh - range * 0.382),
    fib500: round(swingHigh - range * 0.5),
    fib618: round(swingHigh - range * 0.618),
    fib786: round(swingHigh - range * 0.786),
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
  };
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return result;
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcATR(candles: CandleRaw[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  const slice = trs.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Wilder-smoothed RSI (standard 14-period). Returns NaN when insufficient data.
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function findSwingHighLow(candles: CandleRaw[], lookback = 60) {
  const slice = candles.slice(-lookback);
  return {
    swingHigh: Math.max(...slice.map((c) => c.high)),
    swingLow: Math.min(...slice.map((c) => c.low)),
  };
}

// Find the most recent structural impulse swing for Fibonacci drawing.
//
// Requirements for a valid impulse:
//   1. The swing high is the highest high in the lookback window.
//   2. The swing low is the lowest low BEFORE that peak (base of the impulse).
//   3. The move from low→high must be at least MIN_IMPULSE_ATR × ATR (genuine
//      breakout, not chop). Checked by the caller against the current ATR.
//   4. The swing high must be at least MIN_SH_BARS_AGO bars in the past —
//      the impulse must be complete, not still forming.
//   5. Price must NOT have exceeded the swing high since the swing high bar
//      (the fib is stale once a new high is set — draw fresh fibs instead).
//   6. Price must have retraced at least MIN_RETRACE_PCT of the impulse range
//      below the swing high (confirming a genuine pullback has started).
//
// Returns null when no valid impulse is found.
const MIN_SH_BARS_AGO = 3;       // swing high must be at least this many bars old
const MIN_RETRACE_PCT = 0.10;    // price must have retraced ≥10% of the impulse below SH
const MIN_IMPULSE_ATR = 3.0;     // impulse (SH − SL) must be ≥ 3×ATR

function findImpulseSwing(
  candles: CandleRaw[],
  lookback = 100,
): { swingHigh: number; swingLow: number; swingHighIdx: number; swingLowIdx: number } | null {
  const n = candles.length;
  const start = Math.max(0, n - lookback);
  const slice = candles.slice(start);
  if (slice.length < 10) return null;

  const atr = calcATR(candles, 14);
  if (atr <= 0) return null;

  const lastBar = candles[n - 1];
  const currentClose = lastBar.close;

  // Find the highest high in the lookback window, but it must be at least
  // MIN_SH_BARS_AGO bars before the current bar so the impulse is settled.
  const shSearchEnd = slice.length - MIN_SH_BARS_AGO;
  if (shSearchEnd <= 0) return null;
  let shIdx = 0;
  for (let i = 1; i < shSearchEnd; i++) {
    if (slice[i].high > slice[shIdx].high) shIdx = i;
  }
  const swingHigh = slice[shIdx].high;

  // Gate 5: price must not have made a new high after the swing high bar
  // (the fib would be stale). Scan bars after shIdx up to current.
  for (let i = shIdx + 1; i < slice.length; i++) {
    if (slice[i].high > swingHigh) return null; // new high → stale impulse
  }

  // Gate 6: price must have retraced at least MIN_RETRACE_PCT below the swing high.
  // (If price is still within 10% of the top, the pullback hasn't started yet.)

  // Find the lowest low BEFORE the swing high (base of the impulse).
  if (shIdx === 0) return null;
  let slIdx = 0;
  for (let i = 1; i < shIdx; i++) {
    if (slice[i].low < slice[slIdx].low) slIdx = i;
  }
  const swingLow = slice[slIdx].low;
  if (swingHigh <= swingLow) return null;

  const impulseRange = swingHigh - swingLow;

  // Gate 3: impulse must be at least MIN_IMPULSE_ATR × ATR.
  if (impulseRange < MIN_IMPULSE_ATR * atr) return null;

  // Gate 6: at least MIN_RETRACE_PCT of the range must have been retraced.
  const minRetrace = impulseRange * MIN_RETRACE_PCT;
  if (currentClose > swingHigh - minRetrace) return null;

  return {
    swingHigh,
    swingLow,
    swingHighIdx: start + shIdx,
    swingLowIdx:  start + slIdx,
  };
}

// Golden pocket = 61.8%–65% Fibonacci retracement zone.
// This is the most reliable mean-reversion entry in an uptrend: institutions
// buy heavily in this band because it aligns the classic 61.8% golden ratio
// with the 65% level used by algorithmic strategies. Price pulling back into
// this band during an uptrend has a significantly higher probability of
// bouncing than a mechanical S1 pivot touch.
function calcGoldenPocket(
  swingHigh: number,
  swingLow: number,
  round: (n: number) => number,
): { low: number; high: number; fib618: number; fib65: number } {
  const range = swingHigh - swingLow;
  const fib618 = round(swingHigh - range * 0.618);
  const fib65  = round(swingHigh - range * 0.65);
  return { low: Math.min(fib618, fib65), high: Math.max(fib618, fib65), fib618, fib65 };
}

// Standard pivot points use the PREVIOUS DAY's high, low, and close — not the
// previous intraday bar. Using a single 30m bar's range (1-3 pips) produces
// zones so tight that price is always caught between them, causing permanent WAIT.
// This function groups intraday candles by UTC date, finds the last completed day
// (not today's in-progress session), and returns that day's aggregated H/L/C.
function getDailyPivotCandle(
  candles: CandleRaw[],
): { high: number; low: number; close: number } | null {
  const byDate = new Map<string, CandleRaw[]>();
  for (const c of candles) {
    // c.date is ISO "2026-05-04T14:30:00.000Z" for intraday — take the date part.
    const date = c.date.slice(0, 10);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(c);
    else byDate.set(date, [c]);
  }
  const dates = Array.from(byDate.keys()).sort();
  // Need at least 2 days: one completed (prev) + one in progress (today).
  if (dates.length < 2) return null;
  const prevDate = dates[dates.length - 2];
  const bars = byDate.get(prevDate)!;
  return {
    high:  Math.max(...bars.map((c) => c.high)),
    low:   Math.min(...bars.map((c) => c.low)),
    close: bars[bars.length - 1].close,
  };
}

// Wilder's Average Directional Index (ADX-14).
// Returns current ADX value (0–100). NaN when fewer than 2×period+1 bars available.
// ADX < 25 = ranging / no directional energy.
// ADX 25–50 = clear trend in force.
// ADX > 50 = very strong trend.
function calcADX(candles: CandleRaw[], period = 14): number {
  if (candles.length < period * 2 + 1) return NaN;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close),
    );
    const upMove   = cur.high - prev.high;
    const downMove = prev.low  - cur.low;
    const plusDM  = upMove > downMove && upMove   > 0 ? upMove   : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  // Wilder's initial sums (first `period` raw bars)
  let smoothTR      = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM  = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  // First pass: build DX series using Wilder smoothing
  const dxValues: number[] = [];
  for (let i = period; i < trs.length; i++) {
    smoothTR      = smoothTR      - smoothTR      / period + trs[i];
    smoothPlusDM  = smoothPlusDM  - smoothPlusDM  / period + plusDMs[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i];
    const plusDI  = smoothTR > 0 ? (100 * smoothPlusDM)  / smoothTR : 0;
    const minusDI = smoothTR > 0 ? (100 * smoothMinusDM) / smoothTR : 0;
    const diSum   = plusDI + minusDI;
    dxValues.push(diSum > 0 ? (100 * Math.abs(plusDI - minusDI)) / diSum : 0);
  }

  if (dxValues.length < period) return NaN;

  // Second pass: Wilder MA of DX → ADX
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return Math.round(adx * 10) / 10;
}

// Choppiness Index (CI-14) — measures how much a market ranges vs trends.
// Formula: 100 × log10(Σ ATR(1) over N bars / (N-bar highest high − lowest low)) / log10(N)
// Scale: >61.8 = choppy/thick (market oscillates, mean-reversion favoured)
//         <38.2 = directional/thin (trend in force, breakout/continuation favoured)
//        38.2–61.8 = transitional
// Thresholds are Fibonacci levels — not arbitrary.
function calcChoppiness(candles: CandleRaw[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  const slice = candles.slice(-(period + 1));
  let sumTR = 0;
  for (let i = 1; i < slice.length; i++) {
    sumTR += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low  - slice[i - 1].close),
    );
  }
  const hh = Math.max(...slice.map((c) => c.high));
  const ll = Math.min(...slice.map((c) => c.low));
  const totalRange = hh - ll;
  if (totalRange <= 0 || sumTR <= 0) return NaN;
  const ci = (100 * Math.log10(sumTR / totalRange)) / Math.log10(period);
  return Math.round(Math.min(100, Math.max(0, ci)) * 10) / 10;
}

// Swing Rhythm — measures the cadence (price × time) of market oscillations.
// Locates pivot highs and lows (1-bar confirmation on each side) over the
// lookback window, then computes:
//   avgBarsPerSwing — average bars between consecutive pivot highs/lows (time rhythm)
//   avgPricePerSwing — average price move per swing, expressed as ATR multiples (amplitude)
// A consistent rhythm (low variance) signals a market in a predictable oscillation.
// Returns null when fewer than 3 pivots are found (not enough data to average).
function calcSwingRhythm(
  candles: CandleRaw[],
  atr: number,
  lookback = 60,
): { avgBarsPerSwing: number; avgPricePerSwing: number } | null {
  if (atr <= 0) return null;
  const slice = candles.slice(-lookback);
  if (slice.length < 10) return null;

  // 1-bar pivot confirmation: high[i] is higher than both neighbours → pivot high.
  const pivots: { idx: number; price: number }[] = [];
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) {
      pivots.push({ idx: i, price: slice[i].high });
    } else if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) {
      pivots.push({ idx: i, price: slice[i].low });
    }
  }

  if (pivots.length < 3) return null;

  const barGaps: number[] = [];
  const priceMoves: number[] = [];
  for (let i = 1; i < pivots.length; i++) {
    barGaps.push(pivots[i].idx - pivots[i - 1].idx);
    priceMoves.push(Math.abs(pivots[i].price - pivots[i - 1].price));
  }

  const avgBars  = barGaps.reduce((a, b) => a + b, 0)   / barGaps.length;
  const avgPrice = priceMoves.reduce((a, b) => a + b, 0) / priceMoves.length;

  return {
    avgBarsPerSwing:  Math.round(avgBars  * 10) / 10,
    avgPricePerSwing: Math.round((avgPrice / atr) * 10) / 10,
  };
}

// MACD(12,26,9) histogram. Returns array aligned with `closes` (NaN until warm).
// Used as momentum-turn confirmation: only fade S1 when histogram is ticking UP
// (selling pressure cooling), only fade R1 when ticking DOWN (buying pressure
// cooling). Falls open (NaN) when not enough bars are available.
function calcMACDHist(closes: number[], fast = 12, slow = 26, sig = 9): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < slow + sig) return out;
  const fastEma = calcEMA(closes, fast);
  const slowEma = calcEMA(closes, slow);
  // MACD line: valid from slow-1 onwards (where slowEma becomes defined)
  const macdLine: number[] = closes.map((_, i) => {
    if (isNaN(fastEma[i]) || isNaN(slowEma[i])) return NaN;
    return fastEma[i] - slowEma[i];
  });
  // Signal line = EMA(macdLine, sig). Slice out the valid (non-NaN) portion,
  // compute EMA on that, then map back to global indices.
  const validStart = slow - 1;
  const macdValid = macdLine.slice(validStart);
  const sigLine = calcEMA(macdValid, sig);
  for (let i = 0; i < sigLine.length; i++) {
    const g = validStart + i;
    if (!isNaN(macdLine[g]) && !isNaN(sigLine[i])) {
      out[g] = macdLine[g] - sigLine[i];
    }
  }
  return out;
}

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "15m": "15-minute",
  "30m": "30-minute",
  "1h": "1-hour",
  "1d": "daily",
};

// ─── Dagger Setup Detection (50% Pullback on Wave 1) ─────────────────────────
// Book Fig 11.2 ordinal technique.
//   A = impulse base (lowest low before B)
//   B = wave 1 peak (swing high that defines the impulse)
//   C = wave 2 low  (deepest pullback, must land in 40–65% of A→B)
//   Entry = current bar ticking back above the prior bar's high (wave 3 start)
//   SL    = C − 0.5×ATR (below the wave 2 low)
//   TP    = B (wave 1 high — wave 3 targets prior top)
// Bear mirrors the above with inverted direction.

const DAGGER_MIN_TREND_ATR    = 2.0;  // A→B wave 1 must be ≥ 2×ATR
const DAGGER_MIN_REACTION_ATR = 0.5;  // B→C pullback must be ≥ 0.5×ATR
const DAGGER_MAX_REACTION_BARS = 50;  // wave 2 can't drag on indefinitely
const DAGGER_TREND_LOOKBACK   = 80;   // bars to scan for B
const DAGGER_SL_BUFFER        = 1.0;  // SL = C ± SL_BUFFER × ATR (1 ATR gives room past wick)
const DAGGER_FIB_LOW          = 0.40; // retracement lower bound (40%)
const DAGGER_FIB_HIGH         = 0.65; // retracement upper bound (65%)
const DAGGER_WARMUP           = 50;   // minimum bars before scanning

interface DaggerSetup {
  direction: "bull" | "bear";
  aPrice: number;
  bPrice: number;
  cPrice: number;
  bIdx: number;
  cIdx: number;
  tp: number;
  sl: number;
  retracePct: number;
}

function findDaggerBullSetup(
  candles: CandleRaw[],
  i: number,
  atr: number,
): DaggerSetup | null {
  if (i < DAGGER_WARMUP + 4 || atr <= 0) return null;

  // B = highest high in lookback, settled ≥ 3 bars before i
  const bEnd   = i - 3;
  const bStart = Math.max(0, i - DAGGER_TREND_LOOKBACK);
  if (bEnd <= bStart) return null;

  let bIdx = bStart, bPrice = candles[bStart].high;
  for (let j = bStart + 1; j <= bEnd; j++) {
    if (candles[j].high > bPrice) { bPrice = candles[j].high; bIdx = j; }
  }

  // No new high after B through bar i-1 (wave 1 complete, wave 2 in progress)
  for (let j = bIdx + 1; j < i; j++) {
    if (candles[j].high >= bPrice) return null;
  }

  // A = lowest low before B (wave 1 base)
  const aStart = Math.max(0, bIdx - DAGGER_TREND_LOOKBACK);
  if (aStart >= bIdx) return null;
  let aPrice = candles[aStart].low;
  for (let j = aStart + 1; j < bIdx; j++) {
    if (candles[j].low < aPrice) aPrice = candles[j].low;
  }

  // Wave 1 (A→B) must be a significant move
  if (bPrice - aPrice < DAGGER_MIN_TREND_ATR * atr) return null;

  // Wave 2 can't drag on forever
  if (i - bIdx > DAGGER_MAX_REACTION_BARS) return null;

  // C = deepest low between B and bar i-1 (wave 2 low)
  if (bIdx + 1 > i - 1) return null;
  let cIdx = bIdx + 1, cPrice = candles[bIdx + 1].low;
  for (let j = bIdx + 2; j <= i - 1; j++) {
    if (candles[j].low < cPrice) { cPrice = candles[j].low; cIdx = j; }
  }

  // Wave 2 pullback must be meaningful
  if (bPrice - cPrice < DAGGER_MIN_REACTION_ATR * atr) return null;

  // Fib 40–65% filter — the 50% pocket
  const retracePct = (bPrice - cPrice) / (bPrice - aPrice);
  if (retracePct < DAGGER_FIB_LOW || retracePct > DAGGER_FIB_HIGH) return null;

  return {
    direction:  "bull",
    aPrice, bPrice, cPrice,
    bIdx, cIdx,
    tp: bPrice,
    sl: cPrice - DAGGER_SL_BUFFER * atr,
    retracePct,
  };
}

function findDaggerBearSetup(
  candles: CandleRaw[],
  i: number,
  atr: number,
): DaggerSetup | null {
  if (i < DAGGER_WARMUP + 4 || atr <= 0) return null;

  const bEnd   = i - 3;
  const bStart = Math.max(0, i - DAGGER_TREND_LOOKBACK);
  if (bEnd <= bStart) return null;

  let bIdx = bStart, bPrice = candles[bStart].low;
  for (let j = bStart + 1; j <= bEnd; j++) {
    if (candles[j].low < bPrice) { bPrice = candles[j].low; bIdx = j; }
  }

  for (let j = bIdx + 1; j < i; j++) {
    if (candles[j].low <= bPrice) return null;
  }

  const aStart = Math.max(0, bIdx - DAGGER_TREND_LOOKBACK);
  if (aStart >= bIdx) return null;
  let aPrice = candles[aStart].high;
  for (let j = aStart + 1; j < bIdx; j++) {
    if (candles[j].high > aPrice) aPrice = candles[j].high;
  }

  if (aPrice - bPrice < DAGGER_MIN_TREND_ATR * atr) return null;
  if (i - bIdx > DAGGER_MAX_REACTION_BARS) return null;

  if (bIdx + 1 > i - 1) return null;
  let cIdx = bIdx + 1, cPrice = candles[bIdx + 1].high;
  for (let j = bIdx + 2; j <= i - 1; j++) {
    if (candles[j].high > cPrice) { cPrice = candles[j].high; cIdx = j; }
  }

  if (cPrice - bPrice < DAGGER_MIN_REACTION_ATR * atr) return null;

  const retracePct = (cPrice - bPrice) / (aPrice - bPrice);
  if (retracePct < DAGGER_FIB_LOW || retracePct > DAGGER_FIB_HIGH) return null;

  return {
    direction:  "bear",
    aPrice, bPrice, cPrice,
    bIdx, cIdx,
    tp: bPrice,
    sl: cPrice + DAGGER_SL_BUFFER * atr,
    retracePct,
  };
}

// Minimum R-multiple targets. The structural target (pivot, opposite zone) is
// kept when it is further from entry than these floors; otherwise the target
// is pushed out so a winning trade always pays at least this many R.
export const MIN_RR_TP1 = 1.5;
export const MIN_RR_TP2 = 2.5;

// ─── Position sizing ─────────────────────────────────────────────────────────
// Defaults assume a $500 starting account, 1% risk per trade, Phemex USDT
// perps envelope ($1 min collateral floor, 100× leverage cap), and MT5 micro
// lots (0.01).
export const DEFAULT_ACCOUNT_SIZE = 500;
export const DEFAULT_RISK_PCT = 0.01;
// Phemex USDT-perps have no fixed minimum collateral and allow up to 100×.
// Pick a $1 floor so the "achievable" block stays sane for tiny trades but
// effectively never triggers OVER-SIZED on Phemex (was $10 on Jupiter).
export const DEFAULT_MIN_COLLATERAL = 1;
export const DEFAULT_MAX_LEVERAGE = 100;
export const DEFAULT_MT5_LOTS = 0.01;

// ─── MT5 lot sizing helpers ──────────────────────────────────────────────────
// Standard MT5 contract sizes per symbol class:
//   * Forex: 1 lot = 100,000 base units
//   * XAUUSD (gold): 1 lot = 100 oz
//   * XAGUSD (silver): 1 lot = 5,000 oz
// All supported forex pairs (GBPUSD, AUDUSD) are X/USD — quote is already USD,
// so USD P&L per 1.0 price-unit per 1.0 lot = contractSize directly.

function mt5ContractSize(symbol: Symbol): { size: number; unit: string } {
  if (symbol === "XAUUSD") return { size: 100, unit: "oz" };
  if (symbol === "XAGUSD") return { size: 5000, unit: "oz" };
  return { size: 100_000, unit: symbol.slice(0, 3) }; // EUR/GBP/AUD/USD
}

function mt5UsdPerPriceUnitPerLot(symbol: Symbol): number {
  const { size } = mt5ContractSize(symbol);
  return size; // GBPUSD, AUDUSD, XAUUSD, XAGUSD — quote is USD, no conversion needed
}

interface MT5Sizing {
  lots: number;
  contractSize: number;
  positionSize: number;
  positionSizeUnit: string;
  notional: number;
  pnlAtSL: number;
  pnlAtTP1: number;
  pnlAtTP2: number;
  riskPctOfAccount: number;
  recommendedLots: number;
  recommendedTargetRiskPct: number;
}

// Lots that risk approximately `targetRiskPct` of `accountSize` on SL hit.
// Floored to a 0.01 increment so the user can place exactly that size on
// MT5 (which rounds at micro-lot granularity), and clamped to [0.01, 100].
function computeRecommendedLots(
  lossUsdPerLot: number,
  accountSize: number,
  targetRiskPct: number,
): number {
  if (lossUsdPerLot <= 0 || accountSize <= 0 || targetRiskPct <= 0) return 0.01;
  const targetRiskUsd = (targetRiskPct / 100) * accountSize;
  const ideal = targetRiskUsd / lossUsdPerLot;
  const floored = Math.floor(ideal * 100) / 100;
  return Math.min(100, Math.max(0.01, floored));
}

function computeMT5Sizing(
  symbolKey: string,
  lots: number,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  accountSize: number,
  riskPct: number,
): MT5Sizing {
  const { size, unit } = mt5ContractSize(symbolKey as Symbol);
  const usdPerUnit = mt5UsdPerPriceUnitPerLot(symbolKey as Symbol);
  const slDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfit1 - entry);
  const tp2Dist = Math.abs(takeProfit2 - entry);
  const positionSize = lots * size;
  // USD notional = contractSize × entry × lots (quote is always USD for supported pairs).
  const notional = usdPerUnit * entry * lots;
  const lossUsdPerLot = slDist * usdPerUnit;
  const lossUsd = lossUsdPerLot * lots;
  const targetRiskPct = riskPct * 100; // riskPct comes in as 0.01 = 1%
  const recommendedLots = computeRecommendedLots(
    lossUsdPerLot,
    accountSize,
    targetRiskPct,
  );
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    lots: r(lots, 2),
    contractSize: size,
    positionSize: r(positionSize, 2),
    positionSizeUnit: unit,
    notional: r(notional),
    pnlAtSL: r(-lossUsd),
    pnlAtTP1: r(tp1Dist * usdPerUnit * lots),
    pnlAtTP2: r(tp2Dist * usdPerUnit * lots),
    riskPctOfAccount: r((lossUsd / accountSize) * 100, 2),
    recommendedLots: r(recommendedLots, 2),
    recommendedTargetRiskPct: r(targetRiskPct, 2),
  };
}

interface AchievablePosition {
  positionSize: number;
  notional: number;
  collateral: number;
  leverage: number;
  actualRiskAmount: number;
  actualRiskPct: number;
  pnlAtSL: number;
  pnlAtTP1: number;
  pnlAtTP2: number;
  belowMinimum: boolean;
  warning?: string;
}

interface SpotTokenSizing {
  tokenCount: number;
  tokenSymbol: string;
  notional: number;
  riskAmount: number;
  riskPct: number;
  pnlAtSL: number;
  pnlAtTP1: number;
  pnlAtTP2: number;
}

interface PositionSizing {
  venue: "PHEMEX" | "MT5" | "PHEMEX_SPOT";
  accountSize: number;
  riskAmount: number;
  riskPct: number;
  positionSize: number;
  positionSizeUnit: string;
  notional: number;
  leverage?: number;
  leverageNote?: string;
  lots?: { standard: number; mini: number; micro: number };
  achievable?: AchievablePosition;
  mt5?: MT5Sizing;
  spotToken?: SpotTokenSizing;
}

// Compute the "achievable" position given exchange constraints.
//
// Two flavors of exchange floor:
//   • Phemex (minQty/qtyStep): contract-based — BTCUSDT trades in 0.001 BTC
//     increments, ETHUSDT in 0.01. The binding minimum is `minQty × entry`
//     dollars of notional, NOT a fixed collateral. We round qty DOWN to the
//     step (a small under-allocation), and if it lands below minQty we force
//     it up to minQty (the OVER-SIZED case). Forced trades take maxLev so
//     collateral stays tiny — Phemex doesn't require $X locked, only ≥1
//     contract worth of notional.
//   • Legacy ($ minCollateral floor, e.g. Jupiter): notional must clear a
//     fixed dollar amount. Forced over-sized trades use 1× at the floor.
//
// In both flavors the scale-factor approach lets us scale risk & dollar P&L
// proportionally without per-asset math, since ideal P&L = riskAmount × R.
function computeAchievable(
  ideal: { positionSize: number; notional: number; positionSizeUnit: string },
  riskAmount: number,
  accountSize: number,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  minCollateral: number,
  maxLeverage: number,
  minQty?: number,
  qtyStep?: number,
): AchievablePosition {
  const slDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfit1 - entry);
  const tp2Dist = Math.abs(takeProfit2 - entry);
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const usePhemexFloor = minQty != null && qtyStep != null && minQty > 0 && qtyStep > 0;
  // Defensive: maxLeverage=0 would divide by zero downstream. Routes clamp
  // ≥1 today, but belt-and-braces here so the helper is safe in isolation.
  const safeMaxLev = Math.max(1, maxLeverage);

  // ─── Step 1: determine actual position size (qty-stepped or scaled) ──
  let actualPosition: number;
  let scaleFactor = 1;
  let belowMinimum = false;

  if (ideal.notional <= 0 || ideal.positionSize <= 0) {
    // Degenerate ideal — zero out everything so risk/PnL outputs match the
    // (zero) position. Without scaleFactor=0 the function would still report
    // a non-zero actualRiskAmount = riskAmount × 1.
    actualPosition = 0;
    scaleFactor = 0;
  } else if (usePhemexFloor) {
    // Snap to step with a small epsilon so an exact multiple like
    // 0.05 / 0.001 doesn't dip to 0.049 due to IEEE-754 precision (qtyStep
    // is typically 0.001 or 0.01 — both representable, but their quotients
    // aren't always). Epsilon = 1e-9 of the step is well below any real
    // exchange granularity.
    const eps = qtyStep! * 1e-9;
    const stepped = Math.floor(ideal.positionSize / qtyStep! + eps) * qtyStep!;
    if (stepped < minQty!) {
      // Below 1 contract → forced to minQty (OVER-SIZED, scaleFactor > 1).
      actualPosition = minQty!;
      belowMinimum = true;
    } else {
      // Round-down to step (slight under-risk, scaleFactor ≤ 1).
      actualPosition = stepped;
    }
    scaleFactor = actualPosition / ideal.positionSize;
  } else {
    // Legacy $-floor path
    belowMinimum = ideal.notional < minCollateral;
    if (belowMinimum) {
      scaleFactor = minCollateral / ideal.notional;
      actualPosition = ideal.positionSize * scaleFactor;
    } else {
      actualPosition = ideal.positionSize;
    }
  }

  const actualNotional = actualPosition * entry;
  const actualRiskAmount = riskAmount * scaleFactor;

  // ─── Step 2: determine collateral / leverage from actual notional ────
  let collateral: number;
  let leverage: number;
  let warning: string | undefined;

  if (ideal.notional <= 0) {
    collateral = minCollateral;
    leverage = 1;
    warning = `Cannot compute achievable position — ideal notional is zero.`;
  } else if (belowMinimum && usePhemexFloor) {
    // Phemex over-sized: forced to 1 contract, and Phemex's exchange
    // collateral floor is `entry × minQty` (the full notional of one min
    // contract — ~$78 for BTC, ~$30 for ETH). At that floor leverage is 1×.
    collateral = entry * minQty!;
    leverage = 1;
    const overPct = Math.round((scaleFactor - 1) * 100);
    warning =
      `Ideal position smaller than Phemex contract minimum ` +
      `(${minQty} ${ideal.positionSizeUnit} ≈ $${actualNotional.toFixed(2)}) — ` +
      `forced ${overPct}% over-sized.`;
  } else if (belowMinimum) {
    // Legacy $-floor: forced to minCollateral at 1×.
    collateral = minCollateral;
    leverage = 1;
    const overPct = Math.round((scaleFactor - 1) * 100);
    const parts = [`Ideal position too small for $${minCollateral} min collateral — forced ${overPct}% over-sized.`];
    if (collateral > accountSize) {
      parts.push(`Min collateral $${minCollateral} exceeds account $${accountSize}.`);
    }
    warning = parts.join(" ");
  } else if (usePhemexFloor) {
    // CASE A/B (Phemex): Phemex's exchange-enforced collateral floor is
    // `entry × minQty` — the notional of one minimum contract (~$78 for
    // BTC at $78k, ~$30 for ETH at $3k). Use maxLev unless that would
    // dip below the floor, in which case pin collateral to the floor and
    // back-solve leverage. This matches what Phemex actually requires
    // when you place the order.
    const phemexMinCol = entry * minQty!;
    const requiredCollateralAtMaxLev = actualNotional / safeMaxLev;
    if (requiredCollateralAtMaxLev >= phemexMinCol) {
      collateral = requiredCollateralAtMaxLev;
      leverage = safeMaxLev;
    } else {
      collateral = phemexMinCol;
      leverage = actualNotional / phemexMinCol;
    }
    if (collateral > accountSize) {
      warning = `Required collateral $${collateral.toFixed(2)} exceeds account $${accountSize}.`;
    }
  } else {
    // CASE A/B (legacy $-floor venues): respect minCollateral as a floor.
    const requiredCollateralAtMaxLev = actualNotional / safeMaxLev;
    if (requiredCollateralAtMaxLev >= minCollateral) {
      collateral = requiredCollateralAtMaxLev;
      leverage = safeMaxLev;
    } else {
      collateral = minCollateral;
      leverage = actualNotional / minCollateral;
    }
    if (collateral > accountSize) {
      warning = `Required collateral $${collateral.toFixed(2)} exceeds account $${accountSize}.`;
    }
  }

  // ─── Step 3: P&L direct from actual position × distance ──────────────
  // Equivalent to the legacy `(riskAmount / slDist) × dist × scaleFactor`
  // since actualPosition × slDist = actualRiskAmount, but expressed
  // directly so qty-stepped Phemex sizes round-trip cleanly.
  return {
    positionSize: r(actualPosition, 6),
    notional: r(actualNotional),
    collateral: r(collateral, 2),
    leverage: r(leverage, 1),
    actualRiskAmount: r(actualRiskAmount),
    actualRiskPct: r((actualRiskAmount / accountSize) * 100, 2),
    pnlAtSL: r(-actualRiskAmount),
    pnlAtTP1: r(actualPosition * tp1Dist),
    pnlAtTP2: r(actualPosition * tp2Dist),
    belowMinimum,
    warning,
  };
}

function computePositionSizing(
  symbolKey: string,
  meta: SymbolMeta,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  accountSize: number = DEFAULT_ACCOUNT_SIZE,
  riskPct: number = DEFAULT_RISK_PCT,
  minCollateral: number = DEFAULT_MIN_COLLATERAL,
  maxLeverage: number = DEFAULT_MAX_LEVERAGE,
  mt5Lots: number = DEFAULT_MT5_LOTS,
): PositionSizing | undefined {
  const slDist = Math.abs(entry - stopLoss);
  if (!isFinite(slDist) || slDist <= 0 || !isFinite(entry) || entry <= 0) return undefined;

  const riskAmount = accountSize * riskPct;
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

  // ─── Crypto perps (BTC, ETH) — venue: PHEMEX (USDT-margined linear perps) ───
  if (meta.okxPerp) {
    const positionSize = riskAmount / slDist; // coin units
    const notional = positionSize * entry;
    const leverage = Math.max(1, Math.ceil(notional / accountSize));
    let leverageNote: string | undefined;
    // Phemex USDT-perps cap at 100× — bands tuned for that envelope.
    if (leverage > 50) leverageNote = "Required leverage > 50x — high liquidation risk on volatile prints. Consider a larger account.";
    else if (leverage > 25) leverageNote = "High leverage — keep meaningful free margin to absorb wicks.";
    else if (leverage > 10) leverageNote = "Moderate-high leverage — keep extra margin in reserve.";
    const unit = symbolKey.replace(/USDT?$/, "");
    return {
      venue: "PHEMEX",
      accountSize: r(accountSize),
      riskAmount: r(riskAmount),
      riskPct: r(riskPct * 100, 2),
      positionSize: r(positionSize, 6),
      positionSizeUnit: unit,
      notional: r(notional),
      leverage,
      leverageNote,
      achievable: computeAchievable(
        { positionSize, notional, positionSizeUnit: unit },
        riskAmount,
        accountSize,
        entry,
        stopLoss,
        takeProfit1,
        takeProfit2,
        minCollateral,
        maxLeverage,
        meta.phemexMinQty,
        meta.phemexQtyStep,
      ),
    };
  }

  // ─── Metals — venue: Phemex perp (when configured) or MT5 fallback ───
  // XAG: Phemex XAGUSDT perp trades in 1 oz increments (vs MT5's 5,000 oz
  // standard lot). On a $500 account, Phemex allows proper 1-2% sizing;
  // MT5 forces a 20%+ blowout on minimum lot. Route to Phemex when the symbol
  // has `phemexPerp` — otherwise fall through to MT5 for XAU and others.
  if (meta.goldApi) {
    if (meta.phemexPerp) {
      const positionSize = riskAmount / slDist; // oz
      const notional = positionSize * entry;
      const leverage = Math.max(1, Math.ceil(notional / accountSize));
      let leverageNote: string | undefined;
      if (leverage > 50) leverageNote = "Required leverage > 50x — high liquidation risk. Consider a larger account.";
      else if (leverage > 25) leverageNote = "High leverage — keep meaningful free margin to absorb wicks.";
      else if (leverage > 10) leverageNote = "Moderate-high leverage — keep extra margin in reserve.";
      return {
        venue: "PHEMEX",
        accountSize: r(accountSize),
        riskAmount: r(riskAmount),
        riskPct: r(riskPct * 100, 2),
        positionSize: r(positionSize, 2),
        positionSizeUnit: "oz",
        notional: r(notional),
        leverage,
        leverageNote,
        achievable: computeAchievable(
          { positionSize, notional, positionSizeUnit: "oz" },
          riskAmount,
          accountSize,
          entry,
          stopLoss,
          takeProfit1,
          takeProfit2,
          minCollateral,
          maxLeverage,
          meta.phemexMinQty,
          meta.phemexQtyStep,
        ),
      };
    }
    // MT5 fallback (XAU and any metal without a Phemex perp).
    // OANDA std lot conventions: XAG = 5,000 oz, XAU = 100 oz.
    const ozPerStd = symbolKey === "XAGUSD" ? 5000 : 100;
    const positionSize = riskAmount / slDist; // oz
    const notional = positionSize * entry;
    const std = positionSize / ozPerStd;
    return {
      venue: "MT5",
      accountSize: r(accountSize),
      riskAmount: r(riskAmount),
      riskPct: r(riskPct * 100, 2),
      positionSize: r(positionSize, 3),
      positionSizeUnit: "oz",
      notional: r(notional),
      lots: {
        standard: r(std, 4),
        mini: r(std * 10, 3),
        micro: r(std * 100, 2),
      },
      mt5: computeMT5Sizing(symbolKey, mt5Lots, entry, stopLoss, takeProfit1, takeProfit2, accountSize, riskPct),
    };
  }

  // ─── Spot tokens (Phemex spot — no leverage, whole-token sizing) ───
  // `meta.coinbase` is the canonical marker for a spot-priced symbol whose
  // chart data comes from Coinbase. The user trades on Phemex spot. The
  // negative guards ensure a future symbol that also has a perp/gold feed
  // still routes to its primary venue. Any symbol with `meta.coinbase` and
  // none of those overriding markers is sized as a no-leverage spot buy.
  if (meta.coinbase && !meta.phemexPerp && !meta.goldApi) {
    const spotToken = computeSpotTokenSizing(
      symbolKey, entry, stopLoss, takeProfit1, takeProfit2, accountSize, riskPct,
    );
    return {
      venue: "PHEMEX_SPOT",
      accountSize: r(accountSize),
      riskAmount: r(riskAmount),
      riskPct: r(riskPct * 100, 2),
      positionSize: spotToken.tokenCount,
      positionSizeUnit: spotToken.tokenSymbol,
      notional: spotToken.notional,
      spotToken,
    };
  }

  // ─── Forex — venue: MT5 ───
  // All supported pairs (GBPUSD, AUDUSD) are X/USD — quote is already USD.
  // Loss in USD on SL hit = N × slDist → N = riskUSD / slDist.
  const positionSize = riskAmount / slDist; // base units (GBP, AUD)
  const notional = positionSize * entry;    // base × USD/base = USD
  const std = positionSize / 100_000;
  const unit = symbolKey.slice(0, 3); // EUR, GBP, AUD, USD
  return {
    venue: "MT5",
    accountSize: r(accountSize),
    riskAmount: r(riskAmount),
    riskPct: r(riskPct * 100, 2),
    positionSize: r(positionSize),
    positionSizeUnit: unit,
    notional: r(notional),
    lots: {
      standard: r(std, 4),
      mini: r(std * 10, 3),
      micro: r(std * 100, 2),
    },
    mt5: computeMT5Sizing(symbolKey, mt5Lots, entry, stopLoss, takeProfit1, takeProfit2, accountSize, riskPct),
  };
}

// ─── Spot token sizing (Coinbase spot — no leverage) ─────────────────────────
// Fires for any symbol that has no okxPerp, phemexPerp, goldApi, or forex
// characteristics. Position size = floor(riskAmount / |entry − stopLoss|)
// expressed in whole tokens.
function computeSpotTokenSizing(
  symbolKey: string,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  accountSize: number,
  riskPct: number,
): SpotTokenSizing {
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const slDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfit1 - entry);
  const tp2Dist = Math.abs(takeProfit2 - entry);
  const riskAmount = accountSize * riskPct;
  // Floor to whole tokens — spot has no fractional contract concept.
  // If riskAmount/slDist < 1 the result is 0 (position too small to take).
  const tokenCount = Math.floor(riskAmount / slDist);
  const notional = tokenCount * entry;
  const actualRisk = tokenCount * slDist;
  // Derive ticker label: strip trailing "USDT" or "USD" from the symbol key.
  const tokenSymbol = symbolKey.replace(/USDT$|USD$/, "");
  return {
    tokenCount,
    tokenSymbol,
    notional: r(notional),
    riskAmount: r(actualRisk),
    riskPct: r((actualRisk / accountSize) * 100, 2),
    pnlAtSL: r(-actualRisk),
    pnlAtTP1: r(tokenCount * tp1Dist),
    pnlAtTP2: r(tokenCount * tp2Dist),
  };
}

export function floorTarget(
  entry: number,
  stop: number,
  structural: number,
  minRR: number,
  dir: "BUY" | "SELL",
): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return structural;
  const floor = dir === "BUY" ? entry + risk * minRR : entry - risk * minRR;
  return dir === "BUY" ? Math.max(structural, floor) : Math.min(structural, floor);
}

// ─── Core signal logic ───────────────────────────────────────────────────────

export function computeLevels(
  candles: CandleRaw[],
  spotPrice: number | null,
  timeframe: Timeframe,
  symbolKey: string,
  meta: SymbolMeta,
  accountSize: number = DEFAULT_ACCOUNT_SIZE,
  riskPct: number = DEFAULT_RISK_PCT,
  minCollateral: number = DEFAULT_MIN_COLLATERAL,
  maxLeverage: number = DEFAULT_MAX_LEVERAGE,
  mt5Lots: number = DEFAULT_MT5_LOTS,
) {
  const round = makeRounder(meta.decimals);
  const fmt = (n: number) => `${meta.prefix}${round(n).toFixed(meta.decimals)}`;
  // Spot-only symbols (e.g. SKYAIUSDT on Phemex) cannot be shorted.
  // Suppress all SELL signal branches so only BUY setups are shown.
  const isLongOnly = !!meta.longOnly;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const currentPrice = spotPrice ?? last.close;
  const priceChange = round(currentPrice - prev.close);
  const priceChangePct = Math.round((priceChange / prev.close) * 10000) / 100;

  // For intraday timeframes, pivot points must be anchored to the previous
  // DAILY session's H/L/C — not the previous intraday bar. A single 30m bar
  // has a range of 1-5 pips, producing zones so tight they are permanently
  // straddled and nothing ever fires. Fall back to prev bar only if we don't
  // have at least two distinct calendar days in the candle history.
  const dailyPivotSrc = timeframe !== "1d" ? getDailyPivotCandle(candles) : null;
  const pivotSrc = dailyPivotSrc ?? { high: prev.high, low: prev.low, close: prev.close };
  const pivots = calcPivots(pivotSrc.high, pivotSrc.low, pivotSrc.close, round);
  const { swingHigh, swingLow } = findSwingHighLow(candles, 60);
  const fibs = calcFibLevels(swingHigh, swingLow, round);
  const atr = calcATR(candles, 14);

  const closes = candles.map((c) => c.close);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const last21 = ema21[ema21.length - 1];
  const last50 = ema50[ema50.length - 1];
  // Use prev bar (last completed candle) for EMA200 and MACD checks — the
  // current bar may be an incomplete live tick and would contaminate the signal.
  const prevEma200 = ema200[ema200.length - 2];
  const ema200Warm = closes.length >= 210 && !isNaN(prevEma200) && prevEma200 > 0;
  const ema21Recent = ema21.slice(-5).filter((v) => !isNaN(v));
  const slopeUp = ema21Recent[ema21Recent.length - 1] > ema21Recent[0];

  // RSI-14 confirmation. Used to require momentum exhaustion at the zone:
  //   BUY zone → RSI must be ≤ 40 (oversold, selling pressure exhausting)
  //   SELL zone → RSI must be ≥ 60 (overbought, buying pressure exhausting)
  // Without RSI confirmation, a BUY fires whenever price touches S1 even in
  // a waterfall sell-off, and a SELL fires at R1 even during a strong rally.
  const rsi = calcRSI(closes);
  const RSI_OVERSOLD  = 50; // below this → momentum confirms BUY zone bounce
  const RSI_OVERBOUGHT = 55; // above this → momentum confirms SELL zone rejection

  // MACD(12,26,9) histogram momentum gate. Only fade S1 when the histogram
  // has ticked UP over the prior completed bar (selling pressure cooling).
  // Only fade R1 when histogram has ticked DOWN (buying pressure cooling).
  // This eliminates fades into continuation moves where momentum is still
  // running in the wrong direction — the single biggest category of losing
  // pivot-fade trades. Falls open when the indicator isn't warm yet.
  const macdHist = calcMACDHist(closes);
  const histPrev1 = macdHist[closes.length - 2]; // last completed bar
  const histPrev2 = macdHist[closes.length - 3]; // bar before that
  const macdWarm = Number.isFinite(histPrev1) && Number.isFinite(histPrev2);
  const macdBuyOk  = !macdWarm || histPrev1 > histPrev2; // histogram ticking up
  const macdSellOk = !macdWarm || histPrev1 < histPrev2; // histogram ticking down

  const choppiness = calcChoppiness(candles, 14);
  const swingRhythm = calcSwingRhythm(candles, atr);
  const adx = calcADX(candles, 14);
  const adxWarm = Number.isFinite(adx);

  // Primary regime gate: ADX ≥ 25 = directional energy confirmed.
  // Direction is then determined by EMA21 vs EMA50.
  // ADX < 25 (or not yet warm) = RANGING regardless of EMA crossover.
  // This prevents PIVOT_BOUNCE from firing during early-trend or trend-tail
  // phases where EMAs are close but price is still being pushed directionally.
  let trend: "UPTREND" | "DOWNTREND" | "RANGING" = "RANGING";
  let trendStrength = adxWarm ? Math.round(adx) : 30;
  if (!adxWarm) {
    // Fallback when ADX hasn't warmed yet: EMA crossover + slope
    if (last21 > last50 && slopeUp) trend = "UPTREND";
    else if (last21 < last50 && !slopeUp) trend = "DOWNTREND";
  } else if (adx >= 25) {
    if (last21 > last50) trend = "UPTREND";
    else if (last21 < last50) trend = "DOWNTREND";
    // else: EMAs are neutral despite high ADX — keep RANGING
  }

  // EMA200 regime gate (institutional trend bias). When the 200-EMA is warm
  // enough to be reliable, price above EMA200 = bull regime (buy fades only),
  // price below EMA200 = bear regime (sell fades only). Skip on daily — the
  // available daily history is often only ~500 bars so EMA200 warms up but
  // chews through most of the usable period, leaving few tradeable bars.
  // Use prev bar's close so the gate is based on a completed candle.
  const useEma200Gate = ema200Warm && timeframe !== "1d";
  const ema200BuyOk  = !useEma200Gate || prev.close >= prevEma200;
  const ema200SellOk = !useEma200Gate || prev.close <= prevEma200;

  // Breakout / breakdown gates — synced with runBreakoutBacktest so live
  // behaviour and backtest results describe the same signal.
  //
  // Entry filters (all must pass):
  //   1. Magnitude: price ≥0.25×ATR past R2/S2. Marginal scratches above the
  //      level fail at a much higher rate and aren't genuine breakouts.
  //   2. RSI 55–78 for BUY / 22–45 for SELL. Ceiling lowered from 88→78 to
  //      filter over-extended, near-exhaustion moves. Floor at 55/ceiling at 45
  //      ensures momentum is established but not parabolic.
  //   3. EMA21 > EMA50 trend alignment for BUY (EMA21 < EMA50 for SELL).
  //      Falls open when EMA50 not yet warm (<50 bars). Matches backtest
  //      trendBullish/trendBearish gate.
  //   4. currentPrice > EMA21 (immediate momentum confirmation for BUY;
  //      currentPrice < EMA21 for SELL).
  //   5. MACD histogram positive AND rising for BUY (negative AND falling for
  //      SELL), using last two completed bars. Matches backtest macdBuyOk gate.
  //   6. EMA200 regime gate (bypassed on 1d — same as pivot-bounce path).
  //
  // These only fire inside the WAIT else-branch so pivot-bounce setups always
  // take priority.
  const ema5050WarmBreakout = closes.length >= 50 && !isNaN(last21) && !isNaN(last50);
  const trendBullishBreakout = !ema5050WarmBreakout || last21 > last50;
  const trendBearishBreakout = !ema5050WarmBreakout || last21 < last50;
  const macdBreakoutBuyOk  = !macdWarm || (histPrev1 > 0 && histPrev1 > histPrev2);
  const macdBreakoutSellOk = !macdWarm || (histPrev1 < 0 && histPrev1 < histPrev2);

  // Extension filter: suppress breakout entries when price has already run
  // more than 5×ATR away from EMA50. A breakout that fires after a large
  // multi-day move is typically buying the tail, not the body, of the trend.
  // Falls open when EMA50 isn't warm yet (same ema5050WarmBreakout guard).
  // Synced with runBreakoutBacktest notOverExtendedBuy/Sell.
  const notOverExtendedBuy  = !ema5050WarmBreakout || (last.close - last50) < 5 * atr;
  const notOverExtendedSell = !ema5050WarmBreakout || (last50 - last.close) < 5 * atr;

  // Candle-close quality gate — mirrors the backtest's strong-close check.
  // All breakout quality checks are evaluated on `last` (candles[length - 1]),
  // the fully-settled completed bar, matching backtest semantics where
  // `today` is the signal bar whose close is checked. Using `last.close`
  // (instead of live tick `currentPrice`) ensures the signal only fires
  // after a bar has confirmed the breakout via its close — the same condition
  // the backtest evaluates. Entry price is still `currentPrice` (market entry
  // at the live tick once the bar confirms).
  //
  //   BUY: last.close > R2 + 0.25×ATR  → magnitude confirmed by bar close
  //        last.close > low + 0.6×range  → body in top 40% (raised from 50% midpoint)
  //        last.close > EMA21            → fast-MA confirmation on closed bar
  //        (last.close − EMA50) < 5×ATR → extension filter (not over-extended)
  //   SELL: symmetric (close in bottom 40% of bar range)
  //
  // Raising from 50% (midpoint) to 60% filters wick-heavy bars where the close
  // rolled back from the high — the empirical separator between winning and losing
  // breakout entries (winner avg body 72%, loser avg 59% across ETHUSD 1h sample).
  const breakoutBarBuyFloor  = last.low  + 0.6 * (last.high - last.low); // top 40%
  const breakoutBarSellCeil  = last.high - 0.6 * (last.high - last.low); // bottom 40%

  const breakoutBuyOk =
    last.close > pivots.r2 + 0.25 * atr &&
    !isNaN(rsi) && rsi >= 55 && rsi <= 78 &&
    trendBullishBreakout &&
    last.close > last21 &&
    macdBreakoutBuyOk &&
    last.close > breakoutBarBuyFloor &&
    notOverExtendedBuy &&
    (!useEma200Gate || last.close > prevEma200);

  const breakdownSellOk =
    last.close < pivots.s2 - 0.25 * atr &&
    !isNaN(rsi) && rsi >= 22 && rsi <= 45 &&
    trendBearishBreakout &&
    last.close < last21 &&
    macdBreakoutSellOk &&
    last.close < breakoutBarSellCeil &&
    notOverExtendedSell &&
    (!useEma200Gate || last.close < prevEma200) &&
    !isLongOnly;

  const zoneGap = pivots.r1 - pivots.s1;
  const halfWidth = round(zoneGap * 0.2);
  const buyZoneLow = round(pivots.s1 - halfWidth);
  const buyZoneHigh = round(pivots.s1 + halfWidth);
  const sellZoneLow = round(pivots.r1 - halfWidth);
  const sellZoneHigh = round(pivots.r1 + halfWidth);

  const inBuyZone = currentPrice >= buyZoneLow && currentPrice <= buyZoneHigh;
  const inSellZone = currentPrice >= sellZoneLow && currentPrice <= sellZoneHigh;
  const approachingBuy = !inBuyZone && currentPrice > buyZoneHigh && (currentPrice - buyZoneHigh) < atr * 0.5;
  const approachingSell = !inSellZone && currentPrice < sellZoneLow && (sellZoneLow - currentPrice) < atr * 0.5;

  // Strategy selection uses three independent regime filters before PIVOT_BOUNCE fires:
  //
  //   1. ADX < 25 (trend === "RANGING"): no meaningful directional energy in the market.
  //      Computed from EMA21 vs EMA50 as fallback when ADX hasn't warmed yet.
  //
  //   2. Choppiness Index > 55: price is spending more time oscillating than trending.
  //      CI 38.2 = strongly directional, CI 61.8 = strongly choppy (Fibonacci thresholds).
  //      55 is the permissive midpoint — avoids blocking valid setups while the market
  //      is still transitioning. Falls open when CI hasn't warmed (< period+1 bars).
  //
  //   Both filters must agree before a pivot fade is taken. A market can look "ranging"
  //   by EMA alone while CI reveals it's still eating through a one-sided directional
  //   move — those are exactly the stop-out setups we want to eliminate.
  //
  // Production failure post-mortem (320 trades, -101.67R): PIVOT_BOUNCE fired in trending
  // markets. ADX gate fixed the primary issue; CI adds a second independent layer.
  // BREAKOUT (-74.79R, 4% WR) and FIB_BOUNCE (-9.98R, 4% WR) remain off permanently.
  const choppinessOk = !Number.isFinite(choppiness) || choppiness > 55;
  const pivotBounceEnabled = trend === "RANGING" && choppinessOk;

  // ─── Chart-pattern recognition gate ─────────────────────────────────────────
  // Two independent detections run in parallel:
  //   chartPattern  — multi-bar patterns (H&S, triangles, wedges, flags, pennants).
  //                   Used for the UI `detectedPattern` field and the reversal veto gate.
  //   candlestickResult — final-bar candlestick patterns (engulfing, hammer, etc.).
  //                   Always evaluated independently; never silently skipped.
  //                   Appended to signalReason as a confirmation/mismatch note.
  //
  // Only CONFIRMED REVERSAL chart patterns (H&S, Double Top/Bottom) veto signal entries.
  // Continuation and candlestick patterns reinforce direction — add conviction, never block.
  const chartPattern: PatternResult | null = detectChartPattern(candles);
  const candlestickResult: PatternResult | null = detectCandlestickSignal(candles);
  // `patternResult` drives UI display (chart pattern takes priority; falls back to
  // candlestick only when no chart pattern is detected).
  const patternResult: PatternResult | null = chartPattern ?? candlestickResult;
  // Veto gate: only confirmed REVERSAL chart patterns suppress entries.
  const patternBearish =
    chartPattern?.confirmed === true &&
    chartPattern.direction  === "bearish" &&
    chartPattern.category   === "reversal";
  const patternBullish =
    chartPattern?.confirmed === true &&
    chartPattern.direction  === "bullish" &&
    chartPattern.category   === "reversal";
  const PATTERN_LABELS: Record<string, string> = {
    HEAD_AND_SHOULDERS:          "Head & Shoulders",
    INVERSE_HEAD_AND_SHOULDERS:  "Inv. Head & Shoulders",
    DOUBLE_TOP:                  "Double Top",
    DOUBLE_BOTTOM:               "Double Bottom",
    ASCENDING_TRIANGLE:          "Ascending Triangle",
    DESCENDING_TRIANGLE:         "Descending Triangle",
    SYMMETRICAL_TRIANGLE:        "Symmetrical Triangle",
    RISING_WEDGE:                "Rising Wedge",
    FALLING_WEDGE:               "Falling Wedge",
    BULL_FLAG:                   "Bull Flag",
    BEAR_FLAG:                   "Bear Flag",
    BULL_PENNANT:                "Bull Pennant",
    BEAR_PENNANT:                "Bear Pennant",
    BULLISH_ENGULFING:           "Bullish Engulfing",
    BEARISH_ENGULFING:           "Bearish Engulfing",
    HAMMER:                      "Hammer",
    SHOOTING_STAR:               "Shooting Star",
  };
  const breakoutEnabled    = false; // -74.79R production — no edge at any timeframe
  const fibBounceAllowed   = false; // -9.98R production  — no edge at any timeframe

  let signal: "BUY" | "SELL" | "WAIT" = "WAIT";
  let signalType: "PIVOT_BOUNCE" | "BREAKOUT" | "FIB_BOUNCE" | "DAGGER" | "PATTERN_BREAKOUT" = "PIVOT_BOUNCE";
  let signalReason = "";
  let entryPrice = currentPrice;
  let stopLoss = currentPrice;
  let takeProfit1 = currentPrice;
  let takeProfit2 = currentPrice;

  const tfLabel = TIMEFRAME_LABELS[timeframe];

  // Entry gates for PIVOT_BOUNCE direction.
  //
  // BUY zone: RSI ≤ 50 (selling exhausting) + MACD ticking up + EMA200 bull
  // regime. These are appropriate because a bounce from support needs
  // momentum to be visibly cooling before fading into the move.
  //
  // SELL zone: RSI ≥ 55 (buying exhausting) only. MACD and EMA200 are
  // intentionally excluded here:
  //   • EMA200: when price pumps into the sell zone the close is almost
  //     always above EMA200 (the pump IS why EMA21 > EMA200). Gating on
  //     close ≤ EMA200 would suppress every mean-reversion short at the top
  //     of an upswing — the exact setup we want. The correct read is the
  //     opposite: price extended above EMA200 AND in sell zone = prime fade.
  //   • MACD: at a genuine top the histogram is still rising when price
  //     enters the sell zone. Waiting for a tick-down adds 1–2 bars of lag
  //     and moves entry past the best price. RSI exhaustion alone is the
  //     right gate for a zone-fade short.
  // Breakdown SELLs (BREAKOUT path) keep their own independent gates
  // including MACD and EMA200 — those are appropriate for momentum breaks.
  // Intrinsic buy/sell readiness — pattern gate NOT included here.
  // Pattern veto is applied inline at each signal branch so causality is trackable:
  // `patternVetoed` is only set when the pattern is specifically the blocking factor
  // (all other conditions met). Without tracking, the annotation would fire even
  // when the WAIT is caused by price being out of zone entirely.
  const buyAllowed  = (isNaN(rsi) || rsi <= RSI_OVERSOLD)
    && macdBuyOk
    && ema200BuyOk;
  // SELL gate: RSI overbought + trend is NOT an established uptrend.
  // Selling into a strong uptrend = fighting momentum. Mean-reversion shorts
  // only have edge in ranging or downtrending markets. Production data: SELL
  // signals in UPTREND regime → 0% WR, -12R. The trend filter stops that.
  const sellAllowed = (isNaN(rsi) || rsi >= RSI_OVERBOUGHT)
    && !isLongOnly
    && trend !== "UPTREND";

  // ─── Golden-pocket inputs (computed here; FIB_BOUNCE fires last — see below) ──
  // FIB_BOUNCE is lowest priority: PIVOT_BOUNCE and BREAKOUT always get first
  // pick. FIB only fires when both leave signal = WAIT.
  const impulse = findImpulseSwing(candles, 100);
  const goldenPocket = impulse ? calcGoldenPocket(impulse.swingHigh, impulse.swingLow, round) : null;
  const gpValid = goldenPocket !== null && impulse !== null &&
    (goldenPocket.high - goldenPocket.low) >= atr * 0.1 &&
    impulse.swingHigh > currentPrice;
  const inGoldenPocket = gpValid && currentPrice >= goldenPocket!.low && currentPrice <= goldenPocket!.high;
  const approachingGoldenPocket = gpValid && !inGoldenPocket &&
    currentPrice > goldenPocket!.high && (currentPrice - goldenPocket!.high) < atr * 0.5;
  const fibBounceEnabled = fibBounceAllowed && pivotBounceEnabled && gpValid;

  // ─── DAGGER: highest priority — 50% pullback on wave 1 ──────────────────────
  // Fires when: valid A→B→C structure (wave 1 impulse, wave 2 retrace 40–65%),
  // the current bar's high/low has ticked back in trend direction (wave 3 launch),
  // and MACD histogram is confirming momentum. Bull and bear both implemented;
  // longOnly symbols suppress the bear side. Checked first — overrides all others.
  //
  // `patternVetoed` is true only when the DAGGER setup WAS found but the confirmed
  // pattern gate specifically suppressed it. Used for annotation causality.
  let patternVetoed = false;
  {
    const n   = candles.length;
    const bullTrigger = last.high > prev.high;
    const bearTrigger = last.low  < prev.low;

    // Trend-alignment gate: only trade DAGGER WITH the regime.
    // A bull DAGGER in a confirmed downtrend is a counter-trend fade — blocked.
    // A bear DAGGER in a confirmed uptrend is the same — blocked.
    // When ranging (ADX < 25) both sides are allowed; wave structure is its own filter.
    if (bullTrigger && macdBreakoutBuyOk && trend !== "DOWNTREND") {
      const ds = findDaggerBullSetup(candles, n - 1, atr);
      // Entry bar must not have violated the wave 2 low (C still intact)
      if (ds && last.low > ds.cPrice) {
        if (patternBearish) {
          patternVetoed = true; // pattern blocked an otherwise-valid DAGGER BUY
        } else {
          signal     = "BUY";
          signalType = "DAGGER";
          entryPrice  = round(currentPrice);
          stopLoss    = round(ds.sl);
          takeProfit1 = round(floorTarget(entryPrice, stopLoss, ds.tp,              MIN_RR_TP1, "BUY"));
          takeProfit2 = round(floorTarget(entryPrice, stopLoss, ds.tp + atr * 0.5,  MIN_RR_TP2, "BUY"));
          const fibPct = Math.round(ds.retracePct * 100);
          signalReason = `[${tfLabel}] DAGGER BUY: Wave 1 peaked at ${fmt(ds.bPrice)}, wave 2 retraced ${fibPct}% to ${fmt(ds.cPrice)} (50% pocket). Trend: ${trend}. First bar ticking up — wave 3 launch. Entry ${fmt(entryPrice)}, SL ${fmt(stopLoss)} (1 ATR below wave 2 low), TP1 ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)} (wave 1 peak).`;
        }
      }
    }

    if (signal === "WAIT" && !patternVetoed && bearTrigger && macdBreakoutSellOk && !isLongOnly && trend !== "UPTREND") {
      const ds = findDaggerBearSetup(candles, n - 1, atr);
      if (ds && last.high < ds.cPrice) {
        if (patternBullish) {
          patternVetoed = true; // pattern blocked an otherwise-valid DAGGER SELL
        } else {
          signal     = "SELL";
          signalType = "DAGGER";
          entryPrice  = round(currentPrice);
          stopLoss    = round(ds.sl);
          takeProfit1 = round(floorTarget(entryPrice, stopLoss, ds.tp,             MIN_RR_TP1, "SELL"));
          takeProfit2 = round(floorTarget(entryPrice, stopLoss, ds.tp - atr * 0.5, MIN_RR_TP2, "SELL"));
          const fibPct = Math.round(ds.retracePct * 100);
          signalReason = `[${tfLabel}] DAGGER SELL: Wave 1 dropped to ${fmt(ds.bPrice)}, wave 2 bounced ${fibPct}% to ${fmt(ds.cPrice)} (50% pocket). Trend: ${trend}. First bar ticking down — wave 3 drop. Entry ${fmt(entryPrice)}, SL ${fmt(stopLoss)} (1 ATR above wave 2 high), TP1 ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)} (wave 1 low).`;
        }
      }
    }
  }

  // ─── PATTERN_BREAKOUT ────────────────────────────────────────────────────────
  // Fires when a confirmed continuation chart pattern (triangle, wedge, flag, pennant)
  // exists and price has closed through the pattern boundary in the expected direction.
  // This is the "pattern-confirmed breakout" mode — distinct from the old pivot-based
  // BREAKOUT (which stays off permanently due to -74.79R production result).
  //
  // Priority: fires after DAGGER, before PIVOT_BOUNCE.
  // Gate conditions:
  //   • confirmed continuation chartPattern (category === "continuation")
  //   • direction matches a basic momentum gate (MACD + EMA21 alignment)
  //   • reversal patterns do NOT fire here — they remain in the veto gate only
  //
  // SL = pattern lower rail (necklinePrice for BUY) / upper rail (upperBound for SELL)
  // TP = pattern width (upperBound - necklinePrice) projected from breakout close
  if (signal === "WAIT" && chartPattern?.confirmed && chartPattern.category === "continuation") {
    const cp = chartPattern;
    const patWidth = cp.upperBound != null ? cp.upperBound - cp.necklinePrice : atr * 2;
    const patLabel = PATTERN_LABELS[cp.pattern] ?? cp.pattern;

    if (cp.direction === "bullish" && macdBreakoutBuyOk && last.close > last21) {
      const slPrice   = round(cp.necklinePrice - atr * 0.25); // just below pattern support
      const tp1Price  = round(floorTarget(currentPrice, slPrice, currentPrice + patWidth * 0.6,  MIN_RR_TP1, "BUY"));
      const tp2Price  = round(floorTarget(currentPrice, slPrice, currentPrice + patWidth,         MIN_RR_TP2, "BUY"));
      signal     = "BUY";
      signalType = "PATTERN_BREAKOUT";
      entryPrice  = round(currentPrice);
      stopLoss    = slPrice;
      takeProfit1 = tp1Price;
      takeProfit2 = tp2Price;
      signalReason = `[${tfLabel}] PATTERN BREAKOUT BUY: ${patLabel} confirmed — price closed through the upper boundary. SL ${fmt(stopLoss)} (below pattern support at ${fmt(cp.necklinePrice)}), TP1 ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)} (${(patWidth / (currentPrice - slPrice)).toFixed(1)}R pattern projection).`;
    } else if (cp.direction === "bearish" && macdBreakoutSellOk && last.close < last21 && !isLongOnly) {
      const upperRail = cp.upperBound ?? (cp.necklinePrice + patWidth);
      const slPrice   = round(upperRail + atr * 0.25); // just above pattern resistance
      const tp1Price  = round(floorTarget(currentPrice, slPrice, currentPrice - patWidth * 0.6,  MIN_RR_TP1, "SELL"));
      const tp2Price  = round(floorTarget(currentPrice, slPrice, currentPrice - patWidth,         MIN_RR_TP2, "SELL"));
      signal     = "SELL";
      signalType = "PATTERN_BREAKOUT";
      entryPrice  = round(currentPrice);
      stopLoss    = slPrice;
      takeProfit1 = tp1Price;
      takeProfit2 = tp2Price;
      signalReason = `[${tfLabel}] PATTERN BREAKOUT SELL: ${patLabel} confirmed — price closed through the lower boundary. SL ${fmt(stopLoss)} (above pattern resistance at ${fmt(upperRail)}), TP1 ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)} (${(patWidth / (slPrice - currentPrice)).toFixed(1)}R pattern projection).`;
    }
  }

  // ─── PIVOT_BOUNCE + BREAKOUT ─────────────────────────────────────────────────
  // Only runs when DAGGER and PATTERN_BREAKOUT didn't fire. PIVOT_BOUNCE checks
  // S1/R1 zone touches; BREAKOUT checks R2/S2 momentum breaks. FIB_BOUNCE follows.
  if (signal === "WAIT") {
  if (pivotBounceEnabled && inBuyZone && buyAllowed && !patternBearish) {
    // Only fire when price is ACTUALLY IN the buy zone — not approaching from above.
    // "Approaching" signals generated 46 MISSED trades in production (price went
    // to TP without filling the limit at S1, or filled into a falling knife).
    // Market entry at currentPrice when inside the zone eliminates phantom pending.
    signal = "BUY";
    entryPrice = round(currentPrice);
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    const pivotRegimeTag = `ADX ${adxWarm ? adx.toFixed(1) : "—"} · CI ${Number.isFinite(choppiness) ? choppiness.toFixed(1) : "—"}`;
    signalReason = `[${tfLabel}] PIVOT BUY (RANGING): Price (${fmt(currentPrice)}) at S1 support zone ${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}. Market is ranging — mean-reversion setup (${pivotRegimeTag}). Watch for bullish reversal candle. Entry ${fmt(entryPrice)}, SL ${fmt(stopLoss)}, TP1 ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)}.`;
  } else if (pivotBounceEnabled && inBuyZone && buyAllowed && patternBearish) {
    // All zone + indicator conditions are met but a confirmed bearish chart pattern
    // specifically blocks this BUY. Mark `patternVetoed` so the annotation correctly
    // attributes the suppression to the pattern rather than zone/indicator conditions.
    patternVetoed = true;
    signal = "WAIT";
    entryPrice = round(pivots.s1);
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    signalReason = `[${tfLabel}] Price is in the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}) and all conditions are met, but entry is blocked by a confirmed bearish chart pattern.`;
  } else if (pivotBounceEnabled && inSellZone && sellAllowed && !patternBullish) {
    // Same logic as buy: only fire when price is ACTUALLY IN the sell zone.
    // Market entry at currentPrice — no phantom limit orders.
    signal = "SELL";
    entryPrice = round(currentPrice);
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
    const pivotRegimeTagSell = `ADX ${adxWarm ? adx.toFixed(1) : "—"} · CI ${Number.isFinite(choppiness) ? choppiness.toFixed(1) : "—"}`;
    signalReason = `[${tfLabel}] PIVOT SELL (RANGING): Price (${fmt(currentPrice)}) at R1 resistance zone ${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}. Market is ranging — mean-reversion setup (${pivotRegimeTagSell}). Watch for bearish rejection candle. Entry ${fmt(entryPrice)}, SL ${fmt(stopLoss)}, TP1 ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)}.`;
  } else if (pivotBounceEnabled && inSellZone && sellAllowed && patternBullish) {
    // All zone + indicator conditions are met but a confirmed bullish chart pattern
    // specifically blocks this SELL.
    patternVetoed = true;
    signal = "WAIT";
    entryPrice = round(pivots.r1);
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
    signalReason = `[${tfLabel}] Price is in the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}) and all conditions are met, but entry is blocked by a confirmed bullish chart pattern.`;
  } else if (inBuyZone && !buyAllowed) {
    signal = "WAIT";
    const blockNote =
      useEma200Gate && !ema200BuyOk
        ? ` Price below EMA200 (${fmt(prevEma200)}) — institutional bear bias, fade suppressed.`
        : !isNaN(rsi) && rsi > RSI_OVERSOLD
        ? ` RSI ${rsi.toFixed(0)} not yet oversold (need ≤${RSI_OVERSOLD}) — wait for exhaustion.`
        : macdWarm && !macdBuyOk
        ? ` MACD histogram still falling — selling momentum not yet cooling. Wait for the turn.`
        : ` Conditions not yet met.`;
    signalReason = `[${tfLabel}] Price is in the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}) but conditions not met.${blockNote}`;
    // Entry stays inside the buy zone — show a pending BUY at S1, not a SELL.
    // Swapping to a SELL entry (old code used R1) was a direction inversion bug:
    // price is at support, so the pending setup is a BUY if conditions improve.
    entryPrice = round(pivots.s1);
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
  } else if (inSellZone && !sellAllowed) {
    signal = "WAIT";
    const blockNote =
      useEma200Gate && !ema200SellOk
        ? ` Price above EMA200 (${fmt(prevEma200)}) — institutional bull bias, fade suppressed.`
        : !isNaN(rsi) && rsi < RSI_OVERBOUGHT
        ? ` RSI ${rsi.toFixed(0)} not yet overbought (need ≥${RSI_OVERBOUGHT}) — wait for exhaustion.`
        : macdWarm && !macdSellOk
        ? ` MACD histogram still rising — buying momentum not yet cooling. Wait for the turn.`
        : ` Conditions not yet met.`;
    signalReason = `[${tfLabel}] Price is in the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}) but conditions not met.${blockNote}`;
    // Entry stays inside the sell zone — show a pending SELL at R1, not a BUY.
    // The old code showed a BUY at S1 while price was at resistance — direction inversion.
    entryPrice = round(pivots.r1);
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
  } else {
    signal = "WAIT";
    const aboveSellZone = currentPrice > sellZoneHigh;
    const belowBuyZone = currentPrice < buyZoneLow;

    if (aboveSellZone) {
      const distAboveSell = round(currentPrice - sellZoneHigh);
      const distToR2 = round(pivots.r2 - currentPrice);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) has cleared the sell zone and is ${fmt(distAboveSell)} above resistance. ${distToR2 > 0 ? `Watch R2 at ${fmt(pivots.r2)} (${fmt(distToR2)} away) for the next sell opportunity.` : `Price is above R2 — momentum play, no clean entry zone yet.`} Wait for a pullback into a zone.`;
      if (distToR2 > 0) {
        // R2 is above current — pending SELL at R2 keeps entry above price ✓
        entryPrice = round(pivots.r2);
        stopLoss = round(pivots.r2 + atr * 0.5);
        takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
        takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
      } else if (breakoutEnabled && breakoutBuyOk) {
        // Momentum breakout: price cleared R2 with RSI + EMA trend aligned.
        // Market-entry BUY; SL is 1×ATR below entry so risk scales with fill price,
        // not with how far price has run from R2.
        signal = "BUY";
        signalType = "BREAKOUT";
        entryPrice = round(currentPrice);
        stopLoss = round(entryPrice - atr);
        // TP must always be above entry — if price has already blown past R3, fall
        // back to ATR multiples above entry so TP1/TP2 are never below entry.
        takeProfit1 = round(Math.max(pivots.r3, entryPrice + atr));
        takeProfit2 = round(Math.max(pivots.r3 + atr, entryPrice + atr * 2));
        signalReason = `[${tfLabel}] BREAKOUT BUY: Price (${fmt(currentPrice)}) cleared R2 ${fmt(pivots.r2)} by ≥0.25×ATR with strong-close confirmation (RSI ${rsi.toFixed(0)}, EMA21>50, MACD+rising). Market entry, SL ${fmt(stopLoss)} (1×ATR below entry), TP1 = ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)}.`;
      } else {
        // Price is above R2, no breakout confirmation — show pending BUY at S1 on a pullback.
        entryPrice = round(pivots.s1);
        stopLoss = round(buyZoneLow - atr * 0.5);
        takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
        takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
      }
    } else if (belowBuyZone) {
      const distBelowBuy = round(buyZoneLow - currentPrice);
      const distToS2 = round(currentPrice - pivots.s2);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) has broken below the buy zone and is ${fmt(distBelowBuy)} below support. ${distToS2 > 0 ? `Watch S2 at ${fmt(pivots.s2)} (${fmt(distToS2)} away) for the next buy opportunity.` : `Price is below S2 — wait for stabilization before entering.`}`;
      if (distToS2 > 0) {
        // S2 is below current — pending BUY at S2 keeps entry below price ✓
        entryPrice = round(pivots.s2);
        stopLoss = round(pivots.s2 - atr * 0.5);
        takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
        takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
      } else if (breakoutEnabled && breakdownSellOk) {
        // Momentum breakdown: price broke S2 with RSI + EMA trend aligned.
        // Market-entry SELL; SL is 1×ATR above entry so risk scales with fill price,
        // not with how far price has fallen from S2.
        signal = "SELL";
        signalType = "BREAKOUT";
        entryPrice = round(currentPrice);
        stopLoss = round(entryPrice + atr);
        // TP must always be below entry — if price has already blown past S3, fall
        // back to ATR multiples below entry so TP1/TP2 are never above entry.
        takeProfit1 = round(Math.min(pivots.s3, entryPrice - atr));
        takeProfit2 = round(Math.min(pivots.s3 - atr, entryPrice - atr * 2));
        signalReason = `[${tfLabel}] BREAKDOWN SELL: Price (${fmt(currentPrice)}) broke S2 ${fmt(pivots.s2)} by ≥0.25×ATR with strong-close confirmation (RSI ${rsi.toFixed(0)}, EMA21<50, MACD-falling). Market entry, SL ${fmt(stopLoss)} (1×ATR above entry), TP1 = ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)}.`;
      } else {
        // Price is below S2, no breakdown confirmation — show pending SELL at R1 on a bounce.
        entryPrice = round(pivots.r1);
        stopLoss = round(sellZoneHigh + atr * 0.5);
        takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
        takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
      }
    } else {
      const distToBuy = round(currentPrice - buyZoneHigh);
      const distToSell = round(sellZoneLow - currentPrice);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) is in no-trade territory — ${fmt(distToBuy)} above the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}) and ${fmt(distToSell)} below the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}). Wait for price to reach a zone.`;
      // Use buyAllowed (trend + RSI) rather than just trend to pick direction:
      // in RANGING with oversold RSI a BUY will fire once price reaches the
      // buy zone, so the pending setup should point there, not to the sell zone.
      const dir: "BUY" | "SELL" = (trend === "UPTREND" || buyAllowed) ? "BUY" : "SELL";
      entryPrice = round(dir === "BUY" ? pivots.s1 : pivots.r1);
      stopLoss = round(dir === "BUY" ? buyZoneLow - atr * 0.5 : sellZoneHigh + atr * 0.5);
      const structural1 = pivots.pivot;
      const structural2 = dir === "BUY" ? sellZoneLow : buyZoneHigh;
      takeProfit1 = round(floorTarget(entryPrice, stopLoss, structural1, MIN_RR_TP1, dir));
      takeProfit2 = round(floorTarget(entryPrice, stopLoss, structural2, MIN_RR_TP2, dir));
    }
  }
  } // end if (signal === "WAIT") — PIVOT_BOUNCE + BREAKOUT

  // ─── FIB_BOUNCE: lowest priority — only fires when PIVOT and BREAKOUT both ──
  // leave signal = WAIT. FIB_BOUNCE only fires on BUY (long bias — pocket
  // entries are defined against upward impulse swings). Sell-side fib entries
  // are not implemented; the pivot SELL zone handles shorts.
  if (signal === "WAIT" && fibBounceEnabled && (inGoldenPocket || approachingGoldenPocket) && buyAllowed) {
    signal = "BUY";
    signalType = "FIB_BOUNCE";
    // Entry: fib 61.8% level (deepest structural support in the pocket). Clamp
    // to currentPrice so the entry never sits above the live print.
    entryPrice = round(Math.min(goldenPocket!.fib618, currentPrice));
    // SL: just below the 65% level + 0.5×ATR buffer. A close below 65% invalidates
    // the golden pocket — the impulse has retraced too deeply to be a bounce.
    stopLoss = round(goldenPocket!.low - atr * 0.5);
    // TP1: swing high (100% recovery of the impulse) — the natural target of a
    // golden pocket bounce trade. Floored at 1.5R.
    // TP2: swing high + 0.5×ATR extension. Floored at 2.5R.
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, impulse!.swingHigh,             MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, impulse!.swingHigh + atr * 0.5, MIN_RR_TP2, "BUY"));
    signalReason = inGoldenPocket
      ? `[${tfLabel}] FIB GOLDEN POCKET BUY: Price (${fmt(currentPrice)}) is retracing into the 61.8–65% golden pocket (${fmt(goldenPocket!.low)}–${fmt(goldenPocket!.high)}) of the ${fmt(impulse!.swingLow)}→${fmt(impulse!.swingHigh)} impulse. High-probability bounce zone — limit entry near ${fmt(entryPrice)}, SL ${fmt(stopLoss)}, TP1 ${fmt(takeProfit1)}, TP2 ${fmt(takeProfit2)}.`
      : `[${tfLabel}] FIB GOLDEN POCKET approaching: Price (${fmt(currentPrice)}) is within ${fmt(currentPrice - goldenPocket!.high)} of the golden pocket (${fmt(goldenPocket!.low)}–${fmt(goldenPocket!.high)}). Stage a limit order at ${fmt(goldenPocket!.fib618)} (61.8% of ${fmt(impulse!.swingLow)}→${fmt(impulse!.swingHigh)}).`;
  }

  // ─── Pattern annotation (append to signalReason) ─────────────────────────────
  // Adds a brief suffix so the trader can see pattern context in the reason text.
  // Veto note: when a confirmed pattern blocked an entry the signal is WAIT;
  //   append which pattern caused the gate so it is visible in the UI.
  // Reinforce note: when the signal direction agrees with the pattern append a
  //   confirmation marker — useful for trade conviction.
  // ── Chart-pattern annotation ──────────────────────────────────────────────
  // Appends veto or reinforcement notes from the multi-bar chart pattern.
  if (chartPattern && signalReason) {
    const label        = PATTERN_LABELS[chartPattern.pattern] ?? chartPattern.pattern;
    const confirmedStr = chartPattern.confirmed ? "confirmed" : "forming";

    if (patternVetoed) {
      // Only append veto text when the reversal pattern was the specific blocking factor.
      const blocked = patternBearish ? "BUY" : "SELL";
      signalReason += ` [${label} (${confirmedStr}) — ${blocked} entry suppressed by reversal pattern gate.]`;
    } else if (signal !== "WAIT") {
      const signalDir = signal === "BUY" ? "bullish" : "bearish";
      if (signalDir === chartPattern.direction) {
        signalReason += ` [Aligned with ${label} (${confirmedStr}).]`;
      } else if (chartPattern.confirmed && chartPattern.category !== "reversal") {
        signalReason += ` [Note: ${label} (confirmed) suggests opposite direction — monitor.]`;
      }
    }
  }

  // ── Candlestick annotation — always applied independently ─────────────────
  // Candlestick patterns are a final-bar confirmation layer. They are evaluated
  // regardless of whether a multi-bar chart pattern was also found.
  // They never veto — they only add alignment or mismatch notes.
  if (candlestickResult && signalReason) {
    const csLabel  = PATTERN_LABELS[candlestickResult.pattern] ?? candlestickResult.pattern;
    const csDir    = candlestickResult.direction;
    const signalDir = signal === "BUY" ? "bullish" : signal === "SELL" ? "bearish" : null;
    if (signalDir && signalDir === csDir) {
      signalReason += ` [${csLabel} — aligned ${csDir} candlestick signal on the last bar.]`;
    } else if (signalDir && signalDir !== csDir) {
      signalReason += ` [${csLabel} — ${csDir} candlestick signal on last bar (counter-signal, monitor).]`;
    } else {
      // signal === "WAIT"
      signalReason += ` [${csLabel} — ${csDir} candlestick signal on the last closed bar.]`;
    }
  }

  const riskDist = Math.abs(entryPrice - stopLoss);
  const rewardDist = Math.abs(takeProfit1 - entryPrice);
  const riskRewardRatio = riskDist > 0 ? Math.round((rewardDist / riskDist) * 100) / 100 : 0;

  const positionSizing = computePositionSizing(
    symbolKey,
    meta,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    accountSize,
    riskPct,
    minCollateral,
    maxLeverage,
    mt5Lots,
  );

  type LevelType = "resistance" | "support" | "pivot";
  const levels: { label: string; price: number; type: LevelType }[] = [
    { label: "R3",         price: pivots.r3,      type: "resistance" as LevelType },
    { label: "R2",         price: pivots.r2,      type: "resistance" as LevelType },
    { label: "R1",         price: pivots.r1,      type: "resistance" as LevelType },
    { label: "Pivot",      price: pivots.pivot,   type: "pivot"      as LevelType },
    { label: "S1",         price: pivots.s1,      type: "support"    as LevelType },
    { label: "S2",         price: pivots.s2,      type: "support"    as LevelType },
    { label: "S3",         price: pivots.s3,      type: "support"    as LevelType },
    { label: "Fib 23.6%",  price: fibs.fib236,    type: "resistance" as LevelType },
    { label: "Fib 38.2%",  price: fibs.fib382,    type: "resistance" as LevelType },
    { label: "Fib 50.0%",  price: fibs.fib500,    type: "pivot"      as LevelType },
    { label: "Fib 61.8%",  price: fibs.fib618,    type: "support"    as LevelType },
    { label: "Fib 78.6%",  price: fibs.fib786,    type: "support"    as LevelType },
    { label: "Swing High", price: fibs.swingHigh, type: "resistance" as LevelType },
    { label: "Swing Low",  price: fibs.swingLow,  type: "support"    as LevelType },
  ]
    .filter((l) => l.price > 0)
    .sort((a, b) => b.price - a.price);

  // Default tradeState for a fresh (no active snapshot) result. WAIT signals
  // are WAIT; new BUY/SELL is PENDING by default — computeLevelsStable upgrades
  // this to a triggered state if the snapshot fired with price already at/past
  // entry. Cast widens the literal so the inferred Levels.tradeState is the
  // full TradeState union (otherwise TS narrows it to "WAIT" | "PENDING" and
  // rejects FILLED_* assignments downstream).
  const tradeState = (signal === "WAIT" ? "WAIT" : "PENDING") as TradeState;

  return {
    symbol: symbolKey,
    currentPrice: round(currentPrice),
    priceChange,
    priceChangePct,
    signal,
    signalType,
    signalReason,
    tradeState,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskRewardRatio,
    buyZone:  { low: buyZoneLow,  high: buyZoneHigh,  label: "Buy Zone"  },
    sellZone: { low: sellZoneLow, high: sellZoneHigh, label: "Sell Zone" },
    levels,
    pivot: pivots.pivot,
    trend,
    trendStrength,
    adx: adxWarm ? adx : undefined,
    choppiness: Number.isFinite(choppiness) ? choppiness : undefined,
    swingRhythm: swingRhythm ?? undefined,
    rsi: isNaN(rsi) ? undefined : rsi,
    detectedPattern: patternResult?.pattern,
    patternDirection: patternResult?.direction,
    patternConfirmed: patternResult?.confirmed,
    patternNeckline: patternResult?.necklinePrice,
    patternUpperBound: patternResult?.upperBound,
    patternNecklineStart: patternResult?.necklineStartPrice,
    patternUpperBoundStart: patternResult?.upperBoundStartPrice,
    patternStartDate: patternResult?.patternStartDate,
    patternEndDate: patternResult?.patternEndDate,
    lastUpdated: new Date().toISOString(),
    positionSizing,
  };
}

// ─── Stable signal wrapper ───────────────────────────────────────────────────
// Once a BUY/SELL signal fires, freeze entry/SL/TP1/TP2/zones until the trade
// is invalidated. Without this the entry shifts every time a new bar closes
// (because pivots are recomputed from prev.high/low/close), which is bad UX
// for a live trader trying to enter the order book.
//
// Trade is invalidated when:
//   - Stop loss is hit (price closes through SL)
//   - TP2 is hit (full target reached)
//   - Server restarts (in-memory only)
//
// Position sizing always recomputes against the caller's account/risk because
// those are user inputs and must respond live.

type Levels = ReturnType<typeof computeLevels>;

interface ActiveTrade {
  signal: "BUY" | "SELL";
  signalType?: "PIVOT_BOUNCE" | "BREAKOUT" | "FIB_BOUNCE" | "DAGGER" | "PATTERN_BREAKOUT";
  signalReason: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardRatio: number;
  buyZone: Levels["buyZone"];
  sellZone: Levels["sellZone"];
  pivot: number;
  levelsArr: Levels["levels"];
  trend: Levels["trend"];
  trendStrength: number;
  openedAt: number;
  tp1Hit: boolean;
  // Whether the limit order at `entryPrice` has actually been tagged by price
  // since the snapshot was taken. Critical for honesty: a signal that fires
  // when price is "approaching" the zone may never see a real fill if price
  // bounces away before tagging entry. Without this flag the dashboard would
  // claim "+1R in profit" when no trade actually occurred.
  triggered: boolean;
  // Price at the moment the snapshot was first created. Used only for context
  // in the description; not used for trade math.
  openedPrice: number;
  // Start timestamp + low + high of the candle that contained `openedAt`.
  // Used to detect post-snapshot wicks in that same candle WITHOUT
  // false-positiving on a pre-snapshot wick. A real fill requires the
  // candle's low (BUY) or high (SELL) to extend PAST this baseline AND
  // reach entry — proving the wick happened after the limit was placed.
  openedCandleStartTs: number;
  openedCandleLow: number;
  openedCandleHigh: number;
}

const activeTrades = new Map<string, ActiveTrade>();

// ─── Disk persistence for active trades ──────────────────────────────────────
// The freeze-on-signal logic keeps entry/SL/TP stable from the moment a BUY
// or SELL fires until SL or TP2 hits. Without disk persistence, every server
// restart wiped the in-memory Map, which let the next request re-snapshot
// fresh (drifted) levels. Persist to a JSON file so restarts preserve open
// trades.

const ACTIVE_TRADES_FILE =
  process.env.ACTIVE_TRADES_FILE ??
  join(process.cwd(), ".runtime", "active-trades.json");

// ─── PostgreSQL pool (lazy) ───────────────────────────────────────────────────
// Used as the durable persistence layer so active trades survive across
// production deployments (the local JSON file is wiped on each redeploy).
// Falls back silently to file-only if DATABASE_URL is absent.
let _pgPool: Pool | null = null;
function getPool(): Pool | null {
  if (!process.env["DATABASE_URL"]) return null;
  if (!_pgPool) _pgPool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  return _pgPool;
}

// ─── Closed trade history ─────────────────────────────────────────────────────
// Every time a trade closes (SL, TP2, BE trail, direction flip, or missed) we
// insert a row here so the UI can display a running P&L journal.

async function initClosedTradesTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS closed_trades (
        id           SERIAL PRIMARY KEY,
        key          TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        timeframe    TEXT NOT NULL,
        signal       TEXT NOT NULL,
        signal_type  TEXT NOT NULL,
        entry_price  DOUBLE PRECISION NOT NULL,
        stop_loss    DOUBLE PRECISION NOT NULL,
        take_profit1 DOUBLE PRECISION NOT NULL,
        take_profit2 DOUBLE PRECISION NOT NULL,
        risk_reward_ratio DOUBLE PRECISION NOT NULL,
        exit_price   DOUBLE PRECISION NOT NULL,
        outcome      TEXT NOT NULL,
        r_multiple   DOUBLE PRECISION NOT NULL,
        tp1_hit      BOOLEAN NOT NULL DEFAULT false,
        opened_at    BIGINT,
        closed_at    BIGINT NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch {
    // best-effort — table already exists or DB unavailable
  }
}

// "TP1" is a milestone outcome (trade stays open, stop is trailed to BE).
// It is used exclusively to notify the notifier so the SL streak can reset
// on a partial win — the trade is NOT closed and activeTrades is NOT modified.
export type ClosedOutcome = "SL" | "BE_TRAIL" | "TP2" | "TP1" | "REVERSED" | "MISSED";

// Call before activeTrades.delete() to record the outcome in the DB.
// forceOutcome is used for REVERSED and MISSED paths; the isInvalidated path
// auto-derives the outcome from the trade's state.
// Callback registered by the notifier so logClosedTrade can reset the alert
// cooldown when a real trade close happens, enabling immediate re-alerting on
// the next genuine setup. Kept as a loose callback to avoid a circular import
// (notifier imports signals; signals must not import notifier).
let onTradeClosedCallback: ((symbolKey: string, timeframe: Timeframe, outcome: ClosedOutcome, signal: "BUY" | "SELL") => void) | null = null;

export function registerOnTradeClosedCallback(
  cb: (symbolKey: string, timeframe: Timeframe, outcome: ClosedOutcome, signal: "BUY" | "SELL") => void,
): void {
  onTradeClosedCallback = cb;
}

function logClosedTrade(
  trade: ActiveTrade,
  symbolKey: string,
  timeframe: Timeframe,
  exitPrice: number,
  forceOutcome?: ClosedOutcome,
): void {
  const pool = getPool();
  if (!pool) return;

  const isBuy = trade.signal === "BUY";

  let outcome: ClosedOutcome;
  if (forceOutcome) {
    outcome = forceOutcome;
  } else {
    // isInvalidated path — determine SL vs TP2 vs BE_TRAIL
    const hitTp2 = isBuy ? exitPrice >= trade.takeProfit2 : exitPrice <= trade.takeProfit2;
    if (hitTp2) {
      outcome = "TP2";
    } else if (trade.tp1Hit && trade.stopLoss === trade.entryPrice) {
      outcome = "BE_TRAIL";
    } else {
      outcome = "SL";
    }
  }

  // Compute R-multiple using the same original-risk logic as describeFrozenTrade
  const trailedToBE = trade.tp1Hit && trade.stopLoss === trade.entryPrice;
  const originalRisk =
    trailedToBE && trade.riskRewardRatio > 0
      ? Math.abs(trade.takeProfit1 - trade.entryPrice) / trade.riskRewardRatio
      : Math.abs(trade.entryPrice - trade.stopLoss);
  const rawPnl = isBuy ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
  const rMultiple = outcome === "MISSED" ? 0 : originalRisk > 0 ? rawPnl / originalRisk : 0;

  const k = tradeKey(symbolKey, timeframe);

  void pool
    .query(
      `INSERT INTO closed_trades
         (key, symbol, timeframe, signal, signal_type,
          entry_price, stop_loss, take_profit1, take_profit2,
          risk_reward_ratio, exit_price, outcome, r_multiple,
          tp1_hit, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        k,
        symbolKey,
        timeframe,
        trade.signal,
        trade.signalType ?? "PIVOT_BOUNCE",
        trade.entryPrice,
        trade.stopLoss,
        trade.takeProfit1,
        trade.takeProfit2,
        trade.riskRewardRatio,
        exitPrice,
        outcome,
        rMultiple,
        trade.tp1Hit,
        trade.openedAt ?? null,
        Date.now(),
      ],
    )
    .catch(() => {
      // best-effort
    });

  // Notify the notifier so it can update the consecutive-SL circuit-breaker
  // streak and manage cooldowns. TP1 is handled separately (not a close event —
  // the callback is fired at both TP1 detection sites in computeLevelsStable).
  //   SL       → increment same-direction streak; stamp lastAlertAt = now
  //   BE_TRAIL → reset streak; clear cooldown (barely survived — fresh entry ok)
  //   TP2      → reset streak; clear cooldown (full winner)
  //   REVERSED / MISSED → excluded (not real outcome closes)
  if (outcome === "SL" || outcome === "BE_TRAIL" || outcome === "TP2") {
    onTradeClosedCallback?.(symbolKey, timeframe, outcome, trade.signal as "BUY" | "SELL");
  }
}

// On startup: load any trades from the DB that are missing from the local file.
// This recovers from fresh deployments where the JSON file starts empty.
async function syncFromDb(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await initClosedTradesTable();
  try {
    const res = await pool.query<{ key: string; data: Record<string, unknown> }>(
      "SELECT key, data FROM active_trades",
    );
    let merged = 0;
    for (const row of res.rows) {
      if (activeTrades.has(row.key)) continue; // local file wins for existing keys
      const v = row.data as Partial<ActiveTrade>;
      activeTrades.set(row.key, {
        ...(v as ActiveTrade),
        signalType:
          v.signalType === "PIVOT_BOUNCE" || v.signalType === "BREAKOUT" || v.signalType === "DAGGER" || v.signalType === "PATTERN_BREAKOUT"
            ? v.signalType
            : "PIVOT_BOUNCE",
        triggered: typeof v.triggered === "boolean" ? v.triggered : false,
        openedPrice: typeof v.openedPrice === "number" ? v.openedPrice : (v.entryPrice ?? 0),
        openedCandleStartTs:
          typeof v.openedCandleStartTs === "number" ? v.openedCandleStartTs : (v.openedAt ?? 0),
        openedCandleLow: typeof v.openedCandleLow === "number" ? v.openedCandleLow : 0,
        openedCandleHigh: typeof v.openedCandleHigh === "number" ? v.openedCandleHigh : 0,
      });
      merged++;
    }
    if (merged > 0) persistActiveTrades(); // flush merged DB state to local file

    // ── One-time purge: drop BREAKOUT trades whose stored R:R < 1.0 ──────────
    // These were recorded before the ATR-based SL formula was introduced.
    // The riskRewardRatio field reflects TP1/risk at snapshot time; anything
    // below 1.0 is a structurally bad entry that will re-register cleanly on
    // the next signal cycle with the corrected formula.
    let purged = 0;
    for (const [k, trade] of activeTrades) {
      const zeroRisk = trade.entryPrice === trade.stopLoss || trade.stopLoss === 0;
      if ((trade.signalType === "BREAKOUT" && trade.riskRewardRatio < 1.0) || zeroRisk) {
        activeTrades.delete(k);
        purged++;
      }
    }
    if (purged > 0) {
      persistActiveTrades(); // writes the cleaned set back to disk AND DB
      // eslint-disable-next-line no-console
      console.warn(`[signals] Purged ${purged} stale low-RR BREAKOUT trade(s) on startup`);
    }
  } catch {
    // DB unreachable — proceed with file-only state.
  }
}

function loadActiveTradesFromDisk(): void {
  try {
    const raw = readFileSync(ACTIVE_TRADES_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, Partial<ActiveTrade>>;
    let didMigrate = false;
    for (const [k, v] of Object.entries(obj)) {
      // Backward-compat for snapshots persisted before fill-tracking existed.
      // Default triggered=false; the next tick's candle scan since openedAt
      // will retroactively flip it to true if price actually did tag entry.
      // openedPrice falls back to entryPrice for missing-field cases.
      const needsMigration =
        typeof v.triggered !== "boolean" ||
        typeof v.openedPrice !== "number" ||
        typeof v.openedCandleStartTs !== "number" ||
        typeof v.openedCandleLow !== "number" ||
        typeof v.openedCandleHigh !== "number";
      if (needsMigration) didMigrate = true;
      const migrated: ActiveTrade = {
        ...(v as ActiveTrade),
        signalType:
          v.signalType === "PIVOT_BOUNCE" || v.signalType === "BREAKOUT" || v.signalType === "DAGGER" || v.signalType === "PATTERN_BREAKOUT"
            ? v.signalType
            : "PIVOT_BOUNCE",
        triggered: typeof v.triggered === "boolean" ? v.triggered : false,
        openedPrice:
          typeof v.openedPrice === "number" ? v.openedPrice : (v.entryPrice ?? 0),
        // Migrated trades have no baseline. Default the start-ts to openedAt
        // so the containing-candle branch in wasEntryTagged won't fire (a
        // candle's start ts won't equal an arbitrary openedAt). Migrated
        // trades only check fully-post-snapshot candles + live spot — slightly
        // conservative, avoids false-positives on pre-existing wicks.
        openedCandleStartTs:
          typeof v.openedCandleStartTs === "number"
            ? v.openedCandleStartTs
            : (v.openedAt ?? 0),
        // Sentinels of 0 are safe: the containing-candle branch in
        // wasEntryTagged only fires when ts === openedCandleStartTs, which
        // for migrated trades equals openedAt and won't match any real
        // candle's start ts. So the baseline values are unreachable for
        // migrated trades — they're populated solely to satisfy the schema
        // and survive JSON roundtripping (Infinity serializes to null).
        openedCandleLow:
          typeof v.openedCandleLow === "number" ? v.openedCandleLow : 0,
        openedCandleHigh:
          typeof v.openedCandleHigh === "number" ? v.openedCandleHigh : 0,
      };
      activeTrades.set(k, migrated);
    }
    // Flush migrated state to disk so the file matches in-memory shape and
    // diagnostic dumps don't show stale `undefined` for the new fields.
    if (didMigrate) persistActiveTrades();
  } catch {
    // No file yet, or unreadable — start fresh.
  }
}

function persistActiveTrades(): void {
  // ── Sync write to local JSON (fast, survives restarts) ───────────────────
  try {
    mkdirSync(dirname(ACTIVE_TRADES_FILE), { recursive: true });
    const obj: Record<string, ActiveTrade> = {};
    for (const [k, v] of activeTrades) obj[k] = v;
    writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(obj));
  } catch {
    // best-effort
  }

  // ── Async write to PostgreSQL (survives deployments) ─────────────────────
  const pool = getPool();
  if (!pool) return;
  const snapshot = [...activeTrades.entries()];
  void (async () => {
    try {
      for (const [key, data] of snapshot) {
        await pool.query(
          `INSERT INTO active_trades (key, data, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
          [key, JSON.stringify(data)],
        );
      }
      // Remove rows for trades that were cleared from the Map.
      if (snapshot.length === 0) {
        await pool.query("DELETE FROM active_trades");
      } else {
        await pool.query(
          "DELETE FROM active_trades WHERE key <> ALL($1::text[])",
          [snapshot.map(([k]) => k)],
        );
      }
    } catch {
      // best-effort
    }
  })();
}

// Eager load on module init: JSON file first (fast), then DB in background
// to recover any trades that are missing from the file (e.g. fresh deployment).
loadActiveTradesFromDisk();
void syncFromDb();

function tradeKey(symbolKey: string, timeframe: Timeframe): string {
  return `${symbolKey}::${timeframe}`;
}

function isInvalidated(trade: ActiveTrade, currentPrice: number): boolean {
  if (trade.signal === "BUY") {
    return currentPrice <= trade.stopLoss || currentPrice >= trade.takeProfit2;
  }
  return currentPrice >= trade.stopLoss || currentPrice <= trade.takeProfit2;
}

// Scan all candles since the trade snapshot to determine whether the limit
// at `entryPrice` was actually tagged. Three candle classes:
//
//   ts > openedCandleStartTs (fully post-snapshot)
//     → simple check: candle wick reaches entry → fill confirmed.
//
//   ts === openedCandleStartTs (the containing candle — was in-progress at
//   snapshot, may have since closed)
//     → baseline check: count only if the wick EXTENDED past the snapshot's
//       opening low/high AND reached entry. Without this we'd false-positive
//       on a pre-snapshot wick (a wick that happened earlier in the same
//       candle, before the limit was even staged) — re-introducing the
//       lying-about-fills bug this whole fix exists to eliminate.
//
//   ts < openedCandleStartTs (closed before snapshot)
//     → skip entirely; the limit didn't exist yet.
function wasEntryTagged(trade: ActiveTrade, candles: CandleRaw[]): boolean {
  for (const c of candles) {
    const ts = Date.parse(c.date);
    if (Number.isNaN(ts)) continue;
    if (ts > trade.openedCandleStartTs) {
      if (trade.signal === "BUY" && c.low <= trade.entryPrice) return true;
      if (trade.signal === "SELL" && c.high >= trade.entryPrice) return true;
    } else if (ts === trade.openedCandleStartTs) {
      if (
        trade.signal === "BUY" &&
        c.low < trade.openedCandleLow &&
        c.low <= trade.entryPrice
      ) {
        return true;
      }
      if (
        trade.signal === "SELL" &&
        c.high > trade.openedCandleHigh &&
        c.high >= trade.entryPrice
      ) {
        return true;
      }
    }
  }
  return false;
}

// Scan all candles since the trade was triggered to detect whether price wicked
// through SL, TP1, or TP2 on a closed candle and has since recovered. This
// catches poll-gap misses that the live-spot isInvalidated check can't see.
//
// Candle classes (identical baseline logic to wasEntryTagged):
//   ts > openedCandleStartTs  — fully post-snapshot: check wick directly.
//   ts === openedCandleStartTs — containing candle: only count wick extensions
//     past the snapshot baseline (same anti-false-positive guard as entry).
//   ts < openedCandleStartTs  — skip (trade didn't exist yet).
//
// Ambiguous candle (wicks both SL and TP2 simultaneously): treat as SL hit
// first — the more conservative / safer outcome for the trader.
function scanExitWicks(
  trade: ActiveTrade,
  candles: CandleRaw[],
): { hitTp1: boolean; hitTp2: boolean; hitSl: boolean } {
  const isBuy = trade.signal === "BUY";
  let hitTp1 = false;
  let hitTp2 = false;
  let hitSl = false;

  for (const c of candles) {
    const ts = Date.parse(c.date);
    if (Number.isNaN(ts) || ts < trade.openedCandleStartTs) continue;

    if (ts > trade.openedCandleStartTs) {
      // Fully post-snapshot candle: check wicks directly.
      if (isBuy) {
        if (c.high >= trade.takeProfit2) hitTp2 = true;
        if (c.high >= trade.takeProfit1) hitTp1 = true;
        if (c.low <= trade.stopLoss) hitSl = true;
      } else {
        if (c.low <= trade.takeProfit2) hitTp2 = true;
        if (c.low <= trade.takeProfit1) hitTp1 = true;
        if (c.high >= trade.stopLoss) hitSl = true;
      }
    } else {
      // Containing candle (ts === openedCandleStartTs): only count wick
      // extensions past the snapshot baseline so pre-snapshot wicks are ignored.
      if (isBuy) {
        // Upward extensions (TP1/TP2 are above entry for BUY)
        if (c.high > trade.openedCandleHigh) {
          if (c.high >= trade.takeProfit2) hitTp2 = true;
          if (c.high >= trade.takeProfit1) hitTp1 = true;
        }
        // Downward extensions (SL is below entry for BUY)
        if (c.low < trade.openedCandleLow && c.low <= trade.stopLoss) hitSl = true;
      } else {
        // Downward extensions (TP1/TP2 are below entry for SELL)
        if (c.low < trade.openedCandleLow) {
          if (c.low <= trade.takeProfit2) hitTp2 = true;
          if (c.low <= trade.takeProfit1) hitTp1 = true;
        }
        // Upward extensions (SL is above entry for SELL)
        if (c.high > trade.openedCandleHigh && c.high >= trade.stopLoss) hitSl = true;
      }
    }
  }

  return { hitTp1, hitTp2, hitSl };
}

// Build a context-aware description of an active (frozen) trade based on
// where the live price sits relative to the frozen entry / SL / TPs. The
// snapshot's original signalReason text goes stale fast — once price walks
// away from the zone, "Price is within $0.02 of the buy zone" becomes a lie.
// This recomputes the human-readable explanation every tick so the dashboard
// honestly reflects the trade's current state.
// Typed trade state for UIs and downstream consumers. Avoids the fragile
// pattern of regex-parsing describeFrozenTrade's prose to know whether a
// trade is pending vs filled vs in profit. Keep this in sync with the
// `tradeState` enum in lib/api-spec/openapi.yaml (LevelsData.tradeState).
export type TradeState =
  | "WAIT"
  | "PENDING"
  | "FILLED_PROFIT"
  | "FILLED_DRAWDOWN"
  | "FILLED_TP1"
  | "FILLED_TP2"
  | "FILLED_SL";

// Pure classifier — no text, just the typed state. describeFrozenTrade
// continues to own the human-readable explanation; this helper owns the
// machine-readable label.
export function classifyTradeState(trade: ActiveTrade, currentPrice: number): TradeState {
  if (!trade.triggered) return "PENDING";
  const isBuy = trade.signal === "BUY";
  const beyondTp2 = isBuy ? currentPrice >= trade.takeProfit2 : currentPrice <= trade.takeProfit2;
  const beyondTp1 = isBuy ? currentPrice >= trade.takeProfit1 : currentPrice <= trade.takeProfit1;
  const beyondSl = isBuy ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss;
  const inProfit = isBuy ? currentPrice > trade.entryPrice : currentPrice < trade.entryPrice;
  if (beyondTp2) return "FILLED_TP2";
  // Use the persisted tp1Hit flag so that once TP1 is reached the state stays
  // FILLED_TP1 even if price subsequently retraces back below TP1.
  if (trade.tp1Hit || beyondTp1) return "FILLED_TP1";
  if (beyondSl) return "FILLED_SL";
  if (inProfit) return "FILLED_PROFIT";
  return "FILLED_DRAWDOWN";
}

function describeFrozenTrade(
  trade: ActiveTrade,
  currentPrice: number,
  timeframe: Timeframe,
  symbolKey: string,
  meta: SymbolMeta,
): string {
  const round = makeRounder(meta.decimals);
  const fmt = (n: number) => `${meta.prefix}${round(n).toFixed(meta.decimals)}`;
  const tfLabel = TIMEFRAME_LABELS[timeframe];
  const isBuy = trade.signal === "BUY";
  const dirWord = isBuy ? "BUY" : "SELL";
  const triggered = trade.triggered;

  // Detect break-even trail early — needed for correct R-math below.
  // After TP1 hits, stopLoss is moved to entryPrice (risk = 0). Using the
  // live SL would make rMult always 0 for the runner. Derive the original
  // risk from the frozen TP1 distance ÷ stored R:R so R readings stay honest.
  const trailedToBE = trade.tp1Hit && trade.stopLoss === trade.entryPrice;
  const originalRisk = trailedToBE && trade.riskRewardRatio > 0
    ? Math.abs(trade.takeProfit1 - trade.entryPrice) / trade.riskRewardRatio
    : Math.abs(trade.entryPrice - trade.stopLoss);
  const rawPnl = isBuy ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
  const rMult = originalRisk > 0 ? rawPnl / originalRisk : 0;
  const rStr = `${rMult >= 0 ? "+" : ""}${rMult.toFixed(2)}R`;

  const distToTp1 = Math.abs(trade.takeProfit1 - currentPrice);
  const distToTp2 = Math.abs(trade.takeProfit2 - currentPrice);
  const distToSl = trailedToBE
    ? Math.abs(currentPrice - trade.entryPrice)   // BE stop: distance to entry
    : Math.abs(currentPrice - trade.stopLoss);
  const distToEntry = Math.abs(currentPrice - trade.entryPrice);

  const beyondTp2 = isBuy ? currentPrice >= trade.takeProfit2 : currentPrice <= trade.takeProfit2;
  const beyondTp1 = isBuy ? currentPrice >= trade.takeProfit1 : currentPrice <= trade.takeProfit1;
  const inProfit = isBuy ? currentPrice > trade.entryPrice : currentPrice < trade.entryPrice;
  const beyondSl = isBuy ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss;

  // ─── NOT TRIGGERED: limit at entry was never tagged by price ────────────
  // The trade is a pending limit order, not an actual position. R-multiple
  // and "in profit" language do NOT apply — no fill happened.
  //
  // Note: !triggered + beyondTp1/Tp2/SL never reaches this function in
  // practice. computeLevelsStable's isInvalidated (SL/TP2) and auto-MISSED
  // (TP1) checks delete the trade before describe runs. So we only need
  // to handle inProfit and pending-side states.
  if (!triggered) {
    if (inProfit) {
      // Price moved in the trade's favor without the limit being tagged.
      // For BUY: price went up past S1 (above) without coming down to S1.
      // For SELL: price went down past R1 (below) without coming up to R1.
      const dirToEntry = isBuy ? "above" : "below";
      return `[${tfLabel}] ${dirWord} setup PENDING — price ${fmt(currentPrice)} moved ${fmt(distToEntry)} ${dirToEntry} entry ${fmt(trade.entryPrice)} without tagging it. Limit order still staged; needs a pullback to ${fmt(trade.entryPrice)} to fill. Auto-expires if price reaches TP1 ${fmt(trade.takeProfit1)} unfilled.`;
    }
    // Price on the SL side of entry. For BUY this would mean spot crossed
    // entry going down — but the spot-cross trigger would have flipped
    // triggered=true first. So in practice this path is taken only at the
    // exact tick where price equals entry, or in defensive edge cases.
    const dirFromEntry = isBuy ? "below" : "above";
    return `[${tfLabel}] ${dirWord} PENDING — limit at ${fmt(trade.entryPrice)}, price ${fmt(currentPrice)} (${fmt(distToEntry)} ${dirFromEntry} entry, ${fmt(distToSl)} from SL ${fmt(trade.stopLoss)}). Order will fill if price tags ${fmt(trade.entryPrice)}.`;
  }

  // ─── TRIGGERED: position is real ────────────────────────────────────────
  if (beyondTp2) {
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)} reached TP2 ${fmt(trade.takeProfit2)} (${rStr}). Full target hit — trade closing.`;
  }
  if (beyondTp1) {
    const trailNote = trailedToBE
      ? ` Stop trailed to break-even (${fmt(trade.entryPrice)}) — risk-free runner.`
      : "";
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)}: TP1 ${fmt(trade.takeProfit1)} reached (${rStr}).${trailNote} ${fmt(distToTp2)} from TP2 ${fmt(trade.takeProfit2)} — let it run or take partials.`;
  }
  if (inProfit) {
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)}, in profit: price ${fmt(currentPrice)} (${rStr}, ${fmt(distToTp1)} from TP1 ${fmt(trade.takeProfit1)}).`;
  }
  if (beyondSl) {
    if (trailedToBE) {
      return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)} retraced to break-even after TP1 hit — trade closing flat (0R). Stop was trailed up to entry once TP1 tagged.`;
    }
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)} hit stop loss ${fmt(trade.stopLoss)} (${rStr}). Trade invalidated.`;
  }
  // Price on SL side after fill — drawdown.
  return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)}, in drawdown: price ${fmt(currentPrice)} (${rStr}, ${fmt(distToSl)} from SL ${fmt(trade.stopLoss)}).`;
}

export function computeLevelsStable(
  candles: CandleRaw[],
  spotPrice: number | null,
  timeframe: Timeframe,
  symbolKey: string,
  meta: SymbolMeta,
  accountSize: number = DEFAULT_ACCOUNT_SIZE,
  riskPct: number = DEFAULT_RISK_PCT,
  minCollateral: number = DEFAULT_MIN_COLLATERAL,
  maxLeverage: number = DEFAULT_MAX_LEVERAGE,
  mt5Lots: number = DEFAULT_MT5_LOTS,
): Levels {
  const fresh = computeLevels(candles, spotPrice, timeframe, symbolKey, meta, accountSize, riskPct, minCollateral, maxLeverage, mt5Lots);
  const k = tradeKey(symbolKey, timeframe);
  const existing = activeTrades.get(k);

  // Invalidate if SL or TP2 hit.
  // Use the level price as exit (not the live spot), because the live tick may
  // have gapped past the stop/target — e.g. a BE trail whose stop is at entry
  // but the current quote is 0.3% below it. Using currentPrice there would
  // record a negative R on a trade whose outcome is "BE_TRAIL".
  if (existing && isInvalidated(existing, fresh.currentPrice)) {
    const isBuyTrade = existing.signal === "BUY";
    const tp2Hit = isBuyTrade
      ? fresh.currentPrice >= existing.takeProfit2
      : fresh.currentPrice <= existing.takeProfit2;
    const exitAtLevel = tp2Hit ? existing.takeProfit2 : existing.stopLoss;
    logClosedTrade(existing, symbolKey, timeframe, exitAtLevel);
    activeTrades.delete(k);
    persistActiveTrades();
  }

  // Invalidate when the live signal flips to the opposite direction. The
  // trend has reversed enough that the original thesis is dead — keep the
  // dashboard in sync with the new signal instead of leaving stale levels up.
  // WAIT does NOT invalidate (the active trade is still mathematically open).
  const stillActiveBeforeFlip = activeTrades.get(k);
  if (
    stillActiveBeforeFlip &&
    (fresh.signal === "BUY" || fresh.signal === "SELL") &&
    fresh.signal !== stillActiveBeforeFlip.signal
  ) {
    logClosedTrade(stillActiveBeforeFlip, symbolKey, timeframe, fresh.currentPrice, "REVERSED");
    activeTrades.delete(k);
    persistActiveTrades();
  }

  // Candle-wick exit detection for triggered trades.
  // Complements the live-spot isInvalidated check above: if price wicked
  // through SL, TP1, or TP2 on a closed candle and has since recovered, the
  // live price won't trigger isInvalidated — so we scan the candle history.
  // Only run for triggered (filled) trades; pending limits have their own
  // MISSED path below. Re-read from the map because the flip check may have
  // already removed it.
  const wickScanTrade = activeTrades.get(k);
  if (wickScanTrade && wickScanTrade.triggered) {
    const { hitTp1, hitTp2, hitSl } = scanExitWicks(wickScanTrade, candles);
    if (hitTp2) {
      // Full target reached via candle wick — log TP2 close and delete.
      logClosedTrade(wickScanTrade, symbolKey, timeframe, wickScanTrade.takeProfit2);
      activeTrades.delete(k);
      persistActiveTrades();
    } else if (hitSl) {
      // SL (or BE trail after TP1) reached via candle wick — log and delete.
      // logClosedTrade auto-derives BE_TRAIL vs SL from trade.tp1Hit + stopLoss.
      logClosedTrade(wickScanTrade, symbolKey, timeframe, wickScanTrade.stopLoss);
      activeTrades.delete(k);
      persistActiveTrades();
    } else if (hitTp1 && !wickScanTrade.tp1Hit) {
      // TP1 tagged via wick but price has since retreated — trail stop to BE
      // so the trade stays alive as a risk-free runner.
      wickScanTrade.tp1Hit = true;
      wickScanTrade.stopLoss = wickScanTrade.entryPrice;
      persistActiveTrades();
      // TP1 milestone: reset the consecutive-SL streak. The trade is NOT
      // closed here — the callback is a streak-reset signal only.
      onTradeClosedCallback?.(symbolKey, timeframe, "TP1", wickScanTrade.signal as "BUY" | "SELL");
    }
  }

  // Detect fill via two complementary signals:
  //   1. Live spot crossed the limit (catches taps before candle aggregation
  //      catches up — yahoo's hourly low can lag the live tick by minutes).
  //   2. Any candle since openedAt wicked through entry (catches intra-candle
  //      taps between polls when spot has since recovered past entry).
  //
  // ⚠️ Daily timeframe: do NOT use live spot as the trigger signal.
  // Daily bars already aggregate the full intraday range. A single Swissquote
  // quote spike (even a few seconds long) can flip `triggered=true` while the
  // Yahoo daily candle high never reaches entry — giving the user a "SELL filled
  // at $77.517" message when the chart clearly shows price never got there.
  // For daily, rely only on candle wicks (wasEntryTagged). This is conservative
  // but honest: if the daily candle doesn't confirm the fill, we don't claim one.
  const preTriggerCheck = activeTrades.get(k);
  if (preTriggerCheck && !preTriggerCheck.triggered) {
    // Market entries (DAGGER, PATTERN_BREAKOUT) should always be treated as
    // immediately filled. If an old snapshot slipped through with triggered=false
    // (created before this fix), force it triggered now rather than waiting for
    // a candle wick that may never arrive or arriving in the wrong direction.
    const isMarketEntryTrade =
      preTriggerCheck.signalType === "DAGGER" ||
      preTriggerCheck.signalType === "PATTERN_BREAKOUT";
    if (isMarketEntryTrade) {
      preTriggerCheck.triggered = true;
      persistActiveTrades();
    } else {
      // Limit orders: use live-spot tap + candle-wick scan.
      // Skip live-spot on daily bars (single spike can false-trigger).
      const useLiveSpot = timeframe !== "1d";
      const spotTagged = useLiveSpot && (
        preTriggerCheck.signal === "BUY"
          ? fresh.currentPrice < preTriggerCheck.entryPrice
          : fresh.currentPrice > preTriggerCheck.entryPrice
      );
      if (spotTagged || wasEntryTagged(preTriggerCheck, candles)) {
        preTriggerCheck.triggered = true;
        persistActiveTrades();
      }
    }
  }

  // Auto-invalidate as MISSED: a still-pending limit order whose price has
  // already reached TP1 in the trade's favorable direction is dead — no
  // pullback to entry is going to happen at this point. Drop it so the next
  // genuine setup can take over instead of leaving a phantom "pending" trade
  // on the dashboard forever.
  const missedCheck = activeTrades.get(k);
  if (missedCheck && !missedCheck.triggered) {
    const reachedTp1 =
      missedCheck.signal === "BUY"
        ? fresh.currentPrice >= missedCheck.takeProfit1
        : fresh.currentPrice <= missedCheck.takeProfit1;
    if (reachedTp1) {
      logClosedTrade(missedCheck, symbolKey, timeframe, fresh.currentPrice, "MISSED");
      activeTrades.delete(k);
      persistActiveTrades();
    }
  }

  // Keep frozen view if the trade is still active. Note we re-read `existing`
  // because the delete above may have cleared it.
  const stillActive = activeTrades.get(k);
  if (stillActive) {
    // When TP1 is reached on a FILLED trade, trail the stop to break-even
    // (entry). This is standard trader practice: a trade that has already
    // moved +1.5R in your favor should not be allowed to round-trip into a
    // full -1R loss. After this trail, a retrace back to entry trips the
    // existing isInvalidated check on the next tick, closing the trade flat
    // — no more "phantom BUY" hanging on the dashboard after price has
    // already pumped and retraced. PENDING (un-triggered) limit orders are
    // handled separately by the auto-MISSED path above; we only trail real
    // fills.
    if (!stillActive.tp1Hit && stillActive.triggered) {
      const tp1Reached =
        stillActive.signal === "BUY"
          ? fresh.currentPrice >= stillActive.takeProfit1
          : fresh.currentPrice <= stillActive.takeProfit1;
      if (tp1Reached) {
        stillActive.tp1Hit = true;
        stillActive.stopLoss = stillActive.entryPrice;
        persistActiveTrades();
        // TP1 milestone: reset the consecutive-SL streak. The trade is NOT
        // closed here — the callback is a streak-reset signal only.
        onTradeClosedCallback?.(symbolKey, timeframe, "TP1", stillActive.signal as "BUY" | "SELL");
      }
    }
    return {
      ...fresh,
      signal: stillActive.signal,
      signalType: stillActive.signalType ?? "PIVOT_BOUNCE",
      // Recompute the explanation against current price — the frozen text is
      // a lie the moment price walks away from the original zone.
      signalReason: describeFrozenTrade(stillActive, fresh.currentPrice, timeframe, symbolKey, meta),
      // Typed mirror of the same classification — consumers should branch on
      // this, not parse the prose above.
      tradeState: classifyTradeState(stillActive, fresh.currentPrice),
      entryPrice: stillActive.entryPrice,
      stopLoss: stillActive.stopLoss,
      takeProfit1: stillActive.takeProfit1,
      takeProfit2: stillActive.takeProfit2,
      riskRewardRatio: stillActive.riskRewardRatio,
      buyZone: stillActive.buyZone,
      sellZone: stillActive.sellZone,
      pivot: stillActive.pivot,
      levels: stillActive.levelsArr,
      // Recompute sizing fresh against the (possibly updated) account/risk
      // inputs but using the FROZEN entry, stop loss and TP levels.
      positionSizing: computePositionSizing(
        symbolKey,
        meta,
        stillActive.entryPrice,
        stillActive.stopLoss,
        stillActive.takeProfit1,
        stillActive.takeProfit2,
        accountSize,
        riskPct,
        minCollateral,
        maxLeverage,
        mt5Lots,
      ),
    };
  }

  // No active trade. If fresh is BUY/SELL, snapshot it as the new active trade.
  if (fresh.signal === "BUY" || fresh.signal === "SELL") {
    // Market entries (DAGGER, PATTERN_BREAKOUT) fill immediately — no limit
    // to wait for. Set triggered=true on creation so the dashboard shows
    // the correct FILLED state from the first tick and `spotTagged` / candle
    // wick checks are never incorrectly applied to these trades.
    //
    // Limit entries (PIVOT_BOUNCE, FIB_BOUNCE, BREAKOUT) use strict inequality:
    // triggered = price has moved strictly past the staged level. Equality is
    // excluded so that when entryPrice is clamped to currentPrice (e.g.
    // max(R1, price)), price must actually move through the level to fill.
    const isMarketEntry =
      fresh.signalType === "DAGGER" || fresh.signalType === "PATTERN_BREAKOUT";
    const triggered = isMarketEntry
      ? true
      : fresh.signal === "BUY"
        ? fresh.currentPrice < fresh.entryPrice
        : fresh.currentPrice > fresh.entryPrice;
    // Capture the in-progress candle's range as a baseline, so subsequent
    // wick extensions (and only those) can prove a real post-snapshot fill.
    const lastCandle = candles[candles.length - 1];
    const openedCandleStartTs = lastCandle ? Date.parse(lastCandle.date) : Date.now();
    const openedCandleLow = lastCandle ? lastCandle.low : Infinity;
    const openedCandleHigh = lastCandle ? lastCandle.high : -Infinity;
    const newTrade: ActiveTrade = {
      signal: fresh.signal,
      signalType: fresh.signalType,
      signalReason: fresh.signalReason,
      entryPrice: fresh.entryPrice,
      stopLoss: fresh.stopLoss,
      takeProfit1: fresh.takeProfit1,
      takeProfit2: fresh.takeProfit2,
      riskRewardRatio: fresh.riskRewardRatio,
      buyZone: fresh.buyZone,
      sellZone: fresh.sellZone,
      pivot: fresh.pivot,
      levelsArr: fresh.levels,
      trend: fresh.trend,
      trendStrength: fresh.trendStrength,
      openedAt: Date.now(),
      tp1Hit: false,
      triggered,
      openedPrice: fresh.currentPrice,
      openedCandleStartTs: Number.isNaN(openedCandleStartTs) ? Date.now() : openedCandleStartTs,
      openedCandleLow,
      openedCandleHigh,
    };
    activeTrades.set(k, newTrade);
    persistActiveTrades();
    // Upgrade tradeState if the snapshot fired pre-triggered (price already
    // at/past entry). The default "PENDING" set by computeLevels would lie
    // about a brand-new filled trade for one tick otherwise.
    if (triggered) {
      return { ...fresh, tradeState: classifyTradeState(newTrade, fresh.currentPrice) };
    }
  }

  return fresh;
}

// Shifts all candle OHLCV values by a constant basis so that futures-sourced
// candle data (SI=F for silver, GC=F for gold) aligns with broker spot prices
// (MT5 / OANDA). The basis is computed as spotPrice − lastCandleClose; it is
// applied additively (not as a ratio) because futures contango is a fixed
// dollar amount, not a percentage of price. The last candle's close is
// replaced exactly with the live spot price.
export function applyFuturesBasis(
  candles: CandleRaw[],
  spotPrice: number,
  round: (n: number) => number,
): CandleRaw[] {
  if (candles.length === 0) return candles;
  const basis = spotPrice - candles[candles.length - 1].close;
  return candles.map((c, i) => {
    if (i === candles.length - 1) {
      return {
        date: c.date,
        open: round(c.open + basis),
        high: round(Math.max(c.high + basis, spotPrice)),
        low: round(Math.min(c.low + basis, spotPrice)),
        close: round(spotPrice),
        volume: c.volume,
      };
    }
    return {
      date: c.date,
      open: round(c.open + basis),
      high: round(c.high + basis),
      low: round(c.low + basis),
      close: round(c.close + basis),
      volume: c.volume,
    };
  });
}

// Exposed for diagnostics / testing.
export function getActiveTrade(symbolKey: string, timeframe: Timeframe): ActiveTrade | undefined {
  return activeTrades.get(tradeKey(symbolKey, timeframe));
}

export function clearActiveTrade(symbolKey: string, timeframe: Timeframe): void {
  activeTrades.delete(tradeKey(symbolKey, timeframe));
  persistActiveTrades();
}

// Used by the admin seed endpoint to inject trades into the in-memory Map
// and persist them to both disk and DB. Runs the same migration/validation
// as loadActiveTradesFromDisk so stale fields are backfilled safely.
export function seedActiveTrades(raw: Record<string, unknown>): number {
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const p = v as Partial<ActiveTrade>;
    activeTrades.set(k, {
      ...(p as ActiveTrade),
      signalType:
        p.signalType === "PIVOT_BOUNCE" || p.signalType === "BREAKOUT" || p.signalType === "DAGGER" || p.signalType === "PATTERN_BREAKOUT"
          ? p.signalType
          : "PIVOT_BOUNCE",
      triggered: typeof p.triggered === "boolean" ? p.triggered : false,
      openedPrice: typeof p.openedPrice === "number" ? p.openedPrice : (p.entryPrice ?? 0),
      openedCandleStartTs: typeof p.openedCandleStartTs === "number" ? p.openedCandleStartTs : (p.openedAt ?? 0),
      openedCandleLow: typeof p.openedCandleLow === "number" ? p.openedCandleLow : 0,
      openedCandleHigh: typeof p.openedCandleHigh === "number" ? p.openedCandleHigh : 0,
    });
    count++;
  }
  if (count > 0) persistActiveTrades();
  return count;
}
