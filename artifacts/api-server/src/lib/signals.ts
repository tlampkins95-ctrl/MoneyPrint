import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { SYMBOLS, makeRounder, type Symbol, type SymbolMeta } from "./symbols";
import { type CandleRaw, type Timeframe } from "./yahoo-fetch";
import { fetchOkxPerpPrice, fetchPhemexPerpPrice } from "./crypto-perp-fetch";
import { fetchPythPrice } from "./pyth-fetch";
import { detectChartPattern, detectCandlestickSignal, detectFastDoubleTop, detectDoubleTop, detectDoubleBottom, findSwingHighs, findSwingLows, type PatternResult } from "./patterns";

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
export function calcMACDHist(closes: number[], fast = 12, slow = 26, sig = 9): number[] {
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

function calcBollingerBands(
  closes: number[],
  period = 20,
  multiplier = 2,
): { upper: number; middle: number; lower: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  return { upper: mean + multiplier * stdDev, middle: mean, lower: mean - multiplier * stdDev };
}

/**
 * Aggregate daily candles into weekly bars (Monday-anchored ISO week grouping).
 * Includes the current (still-forming) week using whatever daily bars have closed.
 */
function synthesizeWeeklyCandles(dailyCandles: CandleRaw[]): CandleRaw[] {
  const weeks = new Map<string, CandleRaw[]>();
  for (const c of dailyCandles) {
    const d = new Date(c.date);
    const dayOfWeek = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - dayOfWeek);
    const wk = `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(monday.getUTCDate()).padStart(2, "0")}`;
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk)!.push(c);
  }
  const result: CandleRaw[] = [];
  for (const [wkDate, bars] of [...weeks.entries()].sort()) {
    result.push({
      date: wkDate,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

/**
 * Determine macro weekly trend via SMA-30 of weekly closes.
 * Returns "UP" when latest weekly close > SMA-30, "DOWN" when below,
 * or "NEUTRAL" when fewer than 30 weekly bars are available (fail-open).
 */
function getWeeklyTrend(weeklyCandles: CandleRaw[]): "UP" | "DOWN" | "NEUTRAL" {
  if (weeklyCandles.length < 30) return "NEUTRAL";
  const closes = weeklyCandles.map((c) => c.close);
  const slice = closes.slice(-30);
  const sma30 = slice.reduce((a, b) => a + b, 0) / 30;
  const latest = closes[closes.length - 1];
  if (latest > sma30) return "UP";
  if (latest < sma30) return "DOWN";
  return "NEUTRAL";
}

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "1h": "1-hour",
  "4h": "4-hour",
  "1d": "daily",
  "1w": "weekly",
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

const DAGGER_MIN_TREND_ATR     = 2.0;  // A→B wave 1 must be ≥ 2×ATR
const DAGGER_MIN_REACTION_ATR  = 0.5;  // B→C pullback must be ≥ 0.5×ATR
const DAGGER_MAX_REACTION_BARS = 50;   // wave 2 can't drag on indefinitely
const DAGGER_TREND_LOOKBACK    = 80;   // bars to scan for B
const DAGGER_SL_BUFFER         = 1.0;  // SL = C ± SL_BUFFER × ATR (1 ATR gives room past wick)
const DAGGER_FIB_LOW           = 0.40; // retracement lower bound (40%)
const DAGGER_FIB_HIGH          = 0.65; // retracement upper bound (65%)
const DAGGER_WARMUP            = 50;   // minimum bars before scanning
// Entry must fire close to the wave 2 turning point (C).
// Without these gates, bullTrigger can fire 20+ bars after C while price has
// already run back to resistance — producing an entry at the top instead of
// near the pullback. Both checks must pass:
//   MAX_ENTRY_DRIFT_ATR — current price must be within 1.5 ATR of cPrice
//   ENTRY_WINDOW_BARS   — trigger must fire within 8 bars of C being set
const DAGGER_MAX_ENTRY_DRIFT_ATR = 1.5;
const DAGGER_ENTRY_WINDOW_BARS   = 8;

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
export const MIN_RR_TP2 = 2.2;

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

export function computePositionSizing(
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
  dailyCandlesForWeekly?: CandleRaw[], // daily candles used to synthesize weekly macro trend (required for 1h signals)
  weeklyCandlesForDaily?: CandleRaw[], // actual weekly candles used to gate 1d signals by weekly EMA trend
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
  const last21 = ema21[ema21.length - 1];
  const last50 = ema50[ema50.length - 1];
  const ema21Recent = ema21.slice(-5).filter((v) => !isNaN(v));
  const slopeUp = ema21Recent[ema21Recent.length - 1] > ema21Recent[0];

  // RSI-14 confirmation. Used to require momentum exhaustion at the zone:
  //   BUY zone → RSI must be ≤ 40 (oversold, selling pressure exhausting)
  //   SELL zone → RSI must be ≥ 60 (overbought, buying pressure exhausting)
  // Without RSI confirmation, a BUY fires whenever price touches S1 even in
  // a waterfall sell-off, and a SELL fires at R1 even during a strong rally.
  const rsi = calcRSI(closes);
  const RSI_OVERSOLD  = 40; // below this → momentum confirms BUY zone bounce (symmetric: 10 pts below midpoint)
  const RSI_OVERBOUGHT = 60; // above this → momentum confirms SELL zone rejection (symmetric: 10 pts above midpoint)

  // MACD(12,26,9) histogram momentum gate. Only fade S1 when the histogram
  // has ticked UP over the prior completed bar (selling pressure cooling).
  // Only fade R1 when histogram has ticked DOWN (buying pressure cooling).
  // This eliminates fades into continuation moves where momentum is still
  // running in the wrong direction — the single biggest category of losing
  // pivot-fade trades. Falls open when the indicator isn't warm yet.
  const macdHist = calcMACDHist(closes);
  const histPrev1 = macdHist[closes.length - 2]; // last completed bar
  const histPrev2 = macdHist[closes.length - 3]; // bar before that
  const histPrev3 = macdHist[closes.length - 4]; // two bars before last (for 2-bar fade check)
  const macdWarm = Number.isFinite(histPrev1) && Number.isFinite(histPrev2);
  // Fail-CLOSED: if MACD is not warm (insufficient history), the gate rejects.
  // The old fail-open (!macdWarm || ...) silently let all signals through on symbols
  // without enough candle history — no momentum confirmation whatsoever.
  const macdBuyOk  = macdWarm && histPrev1 > histPrev2; // histogram ticking up
  const macdSellOk = macdWarm && histPrev1 < 0 && histPrev1 < histPrev2; // histogram negative AND ticking down

  // ─── Bollinger Bands (20, 2) ──────────────────────────────────────────────
  // Used as two gates:
  //   bbBuyOk  — block BUY when price is near/above the upper band (overbought)
  //   bbSellOk — block SELL when price is near/below the lower band (oversold)
  // The threshold is 20% inside the band from each extreme. Falls open when
  // the indicator isn't warm yet (fewer than 20 bars).
  // Also surfaces bb.middle for use as a TP target when price is at an extreme
  // (price tends to mean-revert to the middle band after touching the bands).
  const bb = calcBollingerBands(closes, 20, 2);
  const bbBandWidth = bb ? bb.upper - bb.lower : 0;
  const bbBuyOk  = !bb || currentPrice < bb.upper - bbBandWidth * 0.2; // not near upper band
  const bbSellOk = !bb || currentPrice > bb.lower + bbBandWidth * 0.2; // not near lower band
  const bbAtLower = bb != null && currentPrice <= bb.lower + bbBandWidth * 0.25; // touching lower band
  const bbAtUpper = bb != null && currentPrice >= bb.upper - bbBandWidth * 0.25; // touching upper band

  // Closed-bar reversal confirmation for PIVOT_BOUNCE entries.
  // Require the last COMPLETED bar (prev = candles[n-2]) to show a directional
  // body aligned with the signal direction before firing.
  //
  // Without this gate the BUY fires the instant price touches S1 and the MACD
  // ticks up even once — including while price is still in free-fall.
  // The signal reason used to say "Watch for bullish reversal candle" but didn't
  // actually enforce it. This makes the system wait for that candle before entry.
  //
  // A doji (close == open) is treated as no-confirmation (conservative but correct —
  // a doji resolves ambiguity, not direction).
  const closedBarBullish = prev.close > prev.open; // bullish reversal bar confirmed
  const closedBarBearish = prev.close < prev.open; // bearish reversal bar confirmed

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

  // ── Higher-TF MACD direction gates ────────────────────────────────────────
  // Strategy: BB + MACD only. No EMAs.
  //
  // SELL gate: daily MACD histogram must be FALLING (curling down) for 1h signals.
  //            weekly MACD histogram must be FALLING for 1d signals.
  //            "Falling" = last completed bar's histogram < previous completed bar's.
  //
  // BUY gate:  daily MACD histogram must be RISING (curling up) for 1h signals.
  //            weekly MACD histogram must be RISING for 1d signals.
  //            "Rising" = last completed bar's histogram > previous completed bar's.
  //
  // Falls back to allow (true) when history is too short for MACD to warm.
  let higherTfAllowsSell = true;
  if (timeframe === "1h" && dailyCandlesForWeekly && dailyCandlesForWeekly.length >= 35) {
    const dCloses   = dailyCandlesForWeekly.map((c) => c.close);
    const dHist     = calcMACDHist(dCloses);
    const dLastHist = dHist[dHist.length - 2]; // last completed daily bar
    const dPrevHist = dHist[dHist.length - 3]; // bar before that
    if (Number.isFinite(dLastHist) && Number.isFinite(dPrevHist) && dLastHist >= dPrevHist) {
      higherTfAllowsSell = false; // daily MACD not curling down — no 1h shorts
    }
  } else if (timeframe === "1d" && weeklyCandlesForDaily && weeklyCandlesForDaily.length >= 35) {
    const wCloses   = weeklyCandlesForDaily.map((c) => c.close);
    const wHist     = calcMACDHist(wCloses);
    const wLastHist = wHist[wHist.length - 2];
    const wPrevHist = wHist[wHist.length - 3];
    if (Number.isFinite(wLastHist) && Number.isFinite(wPrevHist) && wLastHist >= wPrevHist) {
      higherTfAllowsSell = false; // weekly MACD not curling down — no 1d shorts
    }
  }

  let higherTfAllowsBuy = true;
  if (timeframe === "1h" && dailyCandlesForWeekly && dailyCandlesForWeekly.length >= 35) {
    const dCloses   = dailyCandlesForWeekly.map((c) => c.close);
    const dHist     = calcMACDHist(dCloses);
    const dLastHist = dHist[dHist.length - 2]; // last completed daily bar
    const dPrevHist = dHist[dHist.length - 3]; // bar before that
    if (Number.isFinite(dLastHist) && Number.isFinite(dPrevHist) && dLastHist <= dPrevHist) {
      higherTfAllowsBuy = false; // daily MACD not curling up — no 1h longs
    }
  } else if (timeframe === "1d" && weeklyCandlesForDaily && weeklyCandlesForDaily.length >= 35) {
    const wCloses   = weeklyCandlesForDaily.map((c) => c.close);
    const wHist     = calcMACDHist(wCloses);
    const wLastHist = wHist[wHist.length - 2];
    const wPrevHist = wHist[wHist.length - 3];
    if (Number.isFinite(wLastHist) && Number.isFinite(wPrevHist) && wLastHist <= wPrevHist) {
      higherTfAllowsBuy = false; // weekly MACD not curling up — no 1d longs
    }
  }

  // ─── FIB50_SWING signal detection ──────────────────────────────────────────
  // Swing fibonacci retracement entry on 1D and 1H timeframes.
  //   UPTREND  (BUY):  find swing low A → price makes new high B → enter at 50% fib of A→B
  //   DOWNTREND (SELL): find swing high A → price makes new low B → enter at 50% fib of A→B
  //
  // Entry:  50% fib of the A→B swing
  // SL:     full swing invalidation (below A for BUY, above A for SELL) + ATR buffer
  // TP1:    B — structural swing extreme (swing high for BUY, swing low for SELL), no R-floor override
  // TP2:    B projected by one full swing range (measured move) — floored at 2.5R
  //
  // Confirmation filters applied to both timeframes:
  //   • Weekly macro trend (SMA-30 of weekly closes): BUY only if UP, SELL only if DOWN (NEUTRAL = no trade)
  //   • Bollinger Bands (SMA-30 close, 2σ): BUY entry ≤ BB mid, SELL entry ≥ BB mid
  // ────────────────────────────────────────────────────────────────────────────
  // Lookback: 1D uses 60 completed bars; 1H uses 120 bars (≈ 5 trading days).
  const SWING_LOOKBACK_BY_TF: Partial<Record<Timeframe, number>> = {
    "1h": 60,   // ~2.5 days  — recent hourly swing structure
    "4h": 40,   // ~1 week    — recent 4h swing structure
    "1d": 30,   // ~1 month   — recent daily swing structure
    "1w": 16,   // ~4 months  — recent weekly swing structure
  };
  const SWING_LOOKBACK = SWING_LOOKBACK_BY_TF[timeframe] ?? 40;
  const MIN_SWING_ATR       = 2.5;  // swing height must be ≥ 2.5 × ATR to be meaningful
  const FIB50_TOLERANCE_ATR = 0.5;  // price must be within ±0.5 × ATR of the 50% fib
  const FIB50_SL_DISTANCE   = 10;   // fixed $10 stop distance from entry
  const SWING_SL_BUFFER_ATR = 0.5;  // extra buffer below/above swing extreme for SL

  let signal: "BUY" | "SELL" | "WAIT" = "WAIT";
  let signalType: "FIB50_SWING" | "DOUBLE_TOP" | "DOUBLE_BOTTOM" | "BB_REJECTION" | "BB_WALK" | "BB_BREAKOUT" | "PATTERN_BREAKOUT" = "FIB50_SWING";
  let signalReason = "";
  let patternResult: PatternResult | null = null;
  let entryPrice = currentPrice;
  let stopLoss = currentPrice;
  let takeProfit1 = currentPrice;
  let takeProfit2 = currentPrice;
  let dca1: number | undefined = undefined;

  const tfLabel = TIMEFRAME_LABELS[timeframe];

  // Swing display values — populated by detection, used in the levels array.
  let displaySwingHigh = fibs.swingHigh;
  let displaySwingLow  = fibs.swingLow;
  let displayFib50     = 0;
  // Nearest valid fib50 for each direction even when price is outside tolerance —
  // used to show distinct LONG/SHORT zone watch values in WAIT state.
  let candidateBuyFib50  = 0;
  let candidateSellFib50 = 0;

  // Fire on 1D, 1H, and 1W.
  if (timeframe === "1d" || timeframe === "1h" || timeframe === "1w") {
    // Use only completed bars (exclude the still-forming current bar).
    const completed = candles.slice(0, candles.length - 1);

    // ATR on completed bars only — mirrors the backtest which uses calcATR(candles, i-1).
    // The global `atr` computed above includes the live bar; we recompute here to avoid
    // the live bar inflating/deflating the tolerance zone and swing-size gate.
    const completedAtr = calcATR(completed, 14);
    const swingAtr = completedAtr > 0 ? completedAtr : atr; // fall back to global if < 14 bars

    // ── Weekly macro context (display only) ──────────────────────────────────
    // Direction is gated by the MACD curl checks in higherTfAllowsBuy/Sell above.
    // Weekly SMA-30 trend is kept for the signalReason label only — not a gate.
    const weeklyCandles =
      timeframe === "1w" ? completed :
      timeframe === "1d" ? synthesizeWeeklyCandles(completed) :
      (dailyCandlesForWeekly ? synthesizeWeeklyCandles(dailyCandlesForWeekly) : []);
    const weeklyTrend = getWeeklyTrend(weeklyCandles);

    // ── Bollinger Bands (SMA-30 close, 2σ) filter ────────────────────────────
    // BUY: entry must be ≤ BB middle band (price in lower half of channel).
    // SELL: entry must be ≥ BB middle band (price in upper half of channel).
    // Fail-open when fewer than 30 bars are available.
    const bb30 = calcBollingerBands(completed.map((c) => c.close), 30, 2);
    // %B = (price − lower) / (upper − lower). >1 = above upper band; <0 = below lower band.
    // Fails open (0.5) when BB isn't warm.
    const pctB30 = bb30
      ? (currentPrice - bb30.lower) / (bb30.upper - bb30.lower)
      : 0.5;

    // ── BUY Setup: swing low A → new high B → retrace to 50% fib ────────────
    // Iterates structural swing lows from most-recent to oldest so the first
    // qualifying fib that matches current price wins — prevents an older,
    // deeper extreme from masking a more relevant recent setup.
    // BB midline gate: only buy from the LOWER half of the range.
    // Price above the midline = already in "sell zone" — a BUY here is
    // buying the top half. Fails open when BB isn't warm yet.
    // pctB30 < 0 guard: price is BELOW the lower band — a momentum breakdown,
    // not a mean-reversion bounce. Block the fib BUY; BB_BREAKOUT SELL handles it.
    const fibBuyBbOk = !bb || (currentPrice < bb.middle && pctB30 >= 0);
    if (higherTfAllowsBuy && macdBuyOk && fibBuyBbOk) {
      const swingLows        = findSwingLows(completed, 3, SWING_LOOKBACK);
      const swingHighsForBuy = findSwingHighs(completed, 3, SWING_LOOKBACK);
      buySearch: for (let j = swingLows.length - 1; j >= 0; j--) {
        const { price: swingALow, idx: swingALowIdx } = swingLows[j];
        // Most-recent confirmed structural swing HIGH after swingA — swingB for BUY
        const validBuyBs = swingHighsForBuy.filter(s => s.idx > swingALowIdx && s.idx <= completed.length - 4);
        if (validBuyBs.length === 0) continue;
        const { price: swingBHigh, idx: swingBHighIdx } = validBuyBs[validBuyBs.length - 1];
        const buySwingRange = swingBHigh - swingALow;
        if (
          buySwingRange >= MIN_SWING_ATR * swingAtr &&
          currentPrice < swingBHigh
        ) {
          const fib50Buy = swingALow + 0.5 * buySwingRange;
          // Fib-violation guard: if any candle after swingB closed BELOW the
          // 50% fib, price already blew through the level. The setup is
          // invalid — a re-visit after a violation is not a fresh bounce.
          const fibViolatedBuy = completed
            .slice(swingBHighIdx + 1)
            .some((c) => c.close < fib50Buy);
          if (fibViolatedBuy) continue;
          // Resistance-exhaustion guard: if swingBHigh has been wicked ≥ 2 times
          // without a close above it, the ceiling is proven overhead resistance and
          // the fib-bounce setup is exhausted. A "touch" is any candle whose HIGH
          // reached within 0.5 ATR of swingBHigh but whose CLOSE stayed below it.
          const candlesAfterB = completed.slice(swingBHighIdx + 1);
          const resistanceTouches = candlesAfterB.filter(
            (c) => c.high >= swingBHigh - 0.5 * swingAtr && c.close < swingBHigh,
          ).length;
          if (resistanceTouches >= 2) continue;
          // Trend structure guard (higher-high requirement): swingBHigh must be a
          // NEW high relative to the swing highs that existed BEFORE swingALow.
          // If swingBHigh is at or below the prior ceiling, price is ranging —
          // no directional impulse, no valid FIB50_SWING entry.
          // Tolerance: 0.25 ATR to handle measurement noise without letting clear
          // range-tops through.
          const priorHighsBeforeA = swingHighsForBuy
            .filter(s => s.idx < swingALowIdx)
            .map(s => s.price);
          if (priorHighsBeforeA.length > 0) {
            const prevHighCeiling = Math.max(...priorHighsBeforeA);
            if (swingBHigh <= prevHighCeiling + 0.25 * swingAtr) continue;
          }
          // Capture nearest valid BUY fib50 even when outside tolerance (for zone display).
          if (candidateBuyFib50 === 0) candidateBuyFib50 = fib50Buy;
          if (Math.abs(currentPrice - fib50Buy) <= FIB50_TOLERANCE_ATR * swingAtr) {
            const ep  = round(fib50Buy);
            const tp1 = round(swingALow + 0.786 * buySwingRange);  // 78.6% fib — TP1
            // 1d candles regularly span ≥1 ATR; enforce 1.5 ATR minimum on 1d. Other TFs: 2:1 R:R.
            const slFormula = ep - 0.5 * (tp1 - ep);
            const sl  = round(timeframe === "1d"
              ? Math.min(slFormula, ep - 1.5 * swingAtr)
              : slFormula);
            const tp2 = round(floorTarget(ep, sl, swingBHigh, MIN_RR_TP2, "BUY")); // swing high
            signal       = "BUY";
            entryPrice   = ep;
            stopLoss     = sl;
            takeProfit1  = tp1;
            dca1         = round(swingBHigh - 0.618 * buySwingRange);  // 38.2% fib (add on deeper dip)
            takeProfit2  = tp2;
            displaySwingHigh = swingBHigh;
            displaySwingLow  = swingALow;
            displayFib50     = ep;
            const bbTag     = bb30 ? ` BB-mid ${fmt(bb30.middle)}` : "";
            const weeklyTag = ` | Weekly ${weeklyTrend}`;
            signalReason = `[${tfLabel}] FIB50 SWING BUY: Swing low ${fmt(swingALow)} → new high ${fmt(swingBHigh)} (range ${fmt(buySwingRange)}). Entry at 50% fib ${fmt(ep)}, TP1 ${fmt(tp1)} (78.6% fib), SL ${fmt(sl)} (2:1 R:R), TP2 ${fmt(tp2)} (swing high).${bbTag}${weeklyTag}`;
            break buySearch;
          }
        }
      }
    }

    // ── SELL Setup: swing high A → new low B → bounce to 50% fib ────────────
    // Iterates structural swing highs from most-recent to oldest so the first
    // qualifying fib that matches current price wins — prevents an older,
    // higher extreme from masking a more relevant recent setup.
    // BB midline gate: only short from the UPPER half of the range.
    // Price below the midline = already in "buy zone" — a SELL here is
    // shorting the bottom (the TAO/ZEC weekend problem). Fails open when
    // BB isn't warm yet.
    // pctB30 > 1 guard: price is ABOVE the upper band — a momentum breakout, not
    // a mean-reversion fade. Block the fib SELL; BB_BREAKOUT BUY handles it.
    const fibSellBbOk = !bb || (currentPrice > bb.middle && pctB30 <= 1.0);
    if (signal === "WAIT" && !isLongOnly && higherTfAllowsSell && (histPrev1 < histPrev2) && fibSellBbOk) {
      const swingHighs        = findSwingHighs(completed, 3, SWING_LOOKBACK);
      const swingLowsForSell  = findSwingLows(completed, 3, SWING_LOOKBACK);
      sellSearch: for (let j = swingHighs.length - 1; j >= 0; j--) {
        const { price: swingAHigh, idx: swingAHighIdx } = swingHighs[j];
        // Most-recent confirmed structural swing LOW after swingA — swingB for SELL
        const validSellBs = swingLowsForSell.filter(s => s.idx > swingAHighIdx && s.idx <= completed.length - 4);
        if (validSellBs.length === 0) continue;
        const { price: swingBLow, idx: swingBLowIdx } = validSellBs[validSellBs.length - 1];
        const sellSwingRange = swingAHigh - swingBLow;
        if (
          sellSwingRange >= MIN_SWING_ATR * swingAtr &&
          currentPrice > swingBLow
        ) {
          const fib50Sell = swingAHigh - 0.5 * sellSwingRange;
          // Fib-violation guard: if any candle after swingB closed ABOVE the
          // 50% fib, price already blew through the level. The setup is
          // invalid — a re-visit after a violation is not a fresh rejection.
          const fibViolatedSell = completed
            .slice(swingBLowIdx + 1)
            .some((c) => c.close > fib50Sell);
          if (fibViolatedSell) continue;
          // Support-exhaustion guard: if swingBLow has been wicked ≥ 2 times
          // without a close below it, the floor is proven support and the
          // fib-rejection setup is exhausted. A "touch" is any candle whose LOW
          // reached within 0.5 ATR of swingBLow but whose CLOSE stayed above it.
          const candlesAfterBSell = completed.slice(swingBLowIdx + 1);
          const supportTouches = candlesAfterBSell.filter(
            (c) => c.low <= swingBLow + 0.5 * swingAtr && c.close > swingBLow,
          ).length;
          if (supportTouches >= 2) continue;
          // Trend structure guard (lower-low requirement): swingBLow must be a
          // NEW low relative to the swing lows that existed BEFORE swingAHigh.
          // If swingBLow is at or above the prior floor, price is ranging —
          // no directional impulse, no valid FIB50_SWING SELL entry.
          const priorLowsBeforeA = swingLowsForSell
            .filter(s => s.idx < swingAHighIdx)
            .map(s => s.price);
          if (priorLowsBeforeA.length > 0) {
            const prevLowFloor = Math.min(...priorLowsBeforeA);
            if (swingBLow >= prevLowFloor - 0.25 * swingAtr) continue;
          }
          // Capture nearest valid SELL fib50 even when outside tolerance (for zone display).
          if (candidateSellFib50 === 0) candidateSellFib50 = fib50Sell;
          if (Math.abs(currentPrice - fib50Sell) <= FIB50_TOLERANCE_ATR * swingAtr) {
            const ep  = round(fib50Sell);
            const tp1 = round(swingAHigh - 0.786 * sellSwingRange);  // 78.6% fib — TP1
            // 1d candles regularly span ≥1 ATR; the formula-derived SL (0.143×swingRange ≈ 1 ATR)
            // gets clipped by normal daily candle noise. Enforce a 1.5 ATR minimum on 1d so
            // the trade has room to breathe. Other TFs keep the strict 2:1 R:R.
            const slFormula = ep + 0.5 * (ep - tp1);
            const sl  = round(timeframe === "1d"
              ? Math.max(slFormula, ep + 1.5 * swingAtr)
              : slFormula);
            const tp2 = round(floorTarget(ep, sl, swingBLow, MIN_RR_TP2, "SELL")); // swing low
            signal       = "SELL";
            entryPrice   = ep;
            stopLoss     = sl;
            takeProfit1  = tp1;
            dca1         = round(swingBLow + 0.618 * sellSwingRange);  // 61.8% fib (add on higher bounce)
            takeProfit2  = tp2;
            displaySwingHigh = swingAHigh;
            displaySwingLow  = swingBLow;
            displayFib50     = ep;
            const bbTag     = bb30 ? ` BB-mid ${fmt(bb30.middle)}` : "";
            const weeklyTag = ` | Weekly ${weeklyTrend}`;
            signalReason = `[${tfLabel}] FIB50 SWING SELL: Swing high ${fmt(swingAHigh)} → new low ${fmt(swingBLow)} (range ${fmt(sellSwingRange)}). Entry at 50% fib ${fmt(ep)}, TP1 ${fmt(tp1)} (78.6% fib), SL ${fmt(sl)} (2:1 R:R), TP2 ${fmt(tp2)} (swing low).${bbTag}${weeklyTag}`;
            break sellSearch;
          }
        }
      }
    }
  }

  // ── Structural zone display fallback ────────────────────────────────────────
  // When the FIB50_SWING search (gated by MACD/BB) finds no candidates, both
  // zone watch panels show identical currentPrice ± tolerance. As a fallback,
  // use the nearest structural swing LOW (LONG zone center) and swing HIGH
  // (SHORT zone center) so the two panels always show distinct, meaningful
  // support/resistance watch levels in WAIT state.
  if ((candidateBuyFib50 === 0 || candidateSellFib50 === 0) &&
      (timeframe === "1d" || timeframe === "1h" || timeframe === "1w")) {
    const dispCompleted = candles.slice(0, candles.length - 1);

    if (candidateBuyFib50 === 0) {
      const dispSwingLows = findSwingLows(dispCompleted, 3, SWING_LOOKBACK);
      const nearestLow = [...dispSwingLows].reverse().find(s => s.price < currentPrice);
      if (nearestLow) candidateBuyFib50 = nearestLow.price;
    }

    if (candidateSellFib50 === 0) {
      const dispSwingHighs = findSwingHighs(dispCompleted, 3, SWING_LOOKBACK);
      const nearestHigh = [...dispSwingHighs].reverse().find(s => s.price > currentPrice);
      if (nearestHigh) candidateSellFib50 = nearestHigh.price;
    }
  }

  // ── DOUBLE_TOP detection (pump-and-dump short) ─────────────────────────────
  // Fires when FIB50_SWING is still WAIT and price is near a double-top
  // resistance level. Fast detector (5-bar min separation) is tried first to
  // catch same-day CMC trending pumps; standard detector (20-bar min) catches
  // slower reversal setups on any symbol.
  //
  // Gates:
  //   • Confirmation required — neckline must be broken (dtResult.confirmed).
  //     "Forming" double tops are theoretical patterns, not actionable shorts.
  //   • No higher-TF trend gate — double top IS a reversal signal; it forms
  //     specifically at the top of an uptrend. Gating on weekly/daily MACD
  //     being bearish would block every valid distribution pattern (the trend
  //     hasn't turned yet when the top is forming).
  //   • isLongOnly guard prevents shorts on spot-only instruments.
  //
  //   Entry:  avgTop (average of the two peaks = resistance)
  //   SL:     avgTop + 0.5 × ATR (just above resistance)
  //   TP1:    neckline (valley between the two peaks)
  //   TP2:    neckline − (avgTop − neckline)  [measured move]
  if (signal === "WAIT" && !isLongOnly) {
    const dtBars = candles.slice(0, candles.length - 1); // exclude live bar, same as FIB50_SWING
    const dtResult = detectFastDoubleTop(dtBars) ?? detectDoubleTop(dtBars);
    // Volume gate: right peak must carry at least as much relative volume as the left peak.
    // Rising right-side volume confirms distribution is accelerating at resistance.
    // Fails open when volume data is unavailable (leftVolume/rightVolume undefined).
    const dtVolOk = dtResult?.leftVolume == null || dtResult?.rightVolume == null ||
                    dtResult.rightVolume >= dtResult.leftVolume;
    if (dtResult?.upperBound != null && dtResult.necklinePrice != null && dtResult.confirmed && dtVolOk) {
      const resistance = dtResult.upperBound;
      if (Math.abs(currentPrice - resistance) <= FIB50_TOLERANCE_ATR * atr) {
        const ep  = round(resistance);
        const sl  = round(resistance + atr * 0.5);
        const tp1 = round(dtResult.necklinePrice);
        const rawMeasured = dtResult.necklinePrice - (resistance - dtResult.necklinePrice);
        const tp2 = round(floorTarget(ep, sl, rawMeasured, MIN_RR_TP2, "SELL"));
        signal       = "SELL";
        signalType   = "DOUBLE_TOP";
        entryPrice   = ep;
        stopLoss     = sl;
        takeProfit1  = tp1;
        takeProfit2  = tp2;
        dca1         = undefined;
        patternResult = dtResult;
        const stateTag = dtResult.confirmed ? " (neckline broken)" : " (forming)";
        signalReason = `[${tfLabel}] DOUBLE TOP SELL${stateTag}: Resistance ${fmt(resistance)}, Neckline ${fmt(dtResult.necklinePrice)}. Entry ${fmt(ep)}, SL ${fmt(sl)} (above peaks), TP1 ${fmt(tp1)} (neckline), TP2 ${fmt(tp2)} (measured move).`;
      }
    }
  }

  // ── DOUBLE_BOTTOM detection (crash-and-bounce long) ──────────────────────────
  // Fires when FIB50_SWING is still WAIT and a double-bottom pattern is detected.
  // No higher-TF trend gate — the double bottom IS the reversal signal; by
  // definition it forms when the weekly/daily trend is still bearish.
  //
  // Two modes depending on confirmation state:
  //
  //   Forming (neckline not yet broken):
  //     Price near the second trough (support). Entry at support, TP1 at
  //     neckline, TP2 at measured move, SL just below support.
  //
  //   Confirmed (last completed bar closed above neckline):
  //     Price has already broken out but is still within 2 ATR of the neckline
  //     (recent breakout, not extended). Entry at neckline, TP1 at measured
  //     move, SL just below support.
  if (signal === "WAIT" && macdBuyOk) {
    const dbBars = candles.slice(0, candles.length - 1);
    const dbResult = detectDoubleBottom(dbBars);
    // Volume gate: right trough must carry at least as much relative volume as the left trough.
    // Rising right-side volume confirms accumulation is increasing at support.
    // Fails open when volume data is unavailable.
    const dbVolOk = dbResult?.leftVolume == null || dbResult?.rightVolume == null ||
                    dbResult.rightVolume >= dbResult.leftVolume;
    if (dbResult?.upperBound != null && dbResult.necklinePrice != null && dbVolOk) {
      const support  = dbResult.upperBound;
      const neckline = dbResult.necklinePrice;
      const sl       = round(support - atr * 0.5);

      if (!dbResult.confirmed) {
        // Forming: price must still be near the trough support
        if (Math.abs(currentPrice - support) <= FIB50_TOLERANCE_ATR * atr) {
          const ep          = round(support);
          const tp1         = round(neckline);
          const rawMeasured = neckline + (neckline - support);
          const tp2         = round(floorTarget(ep, sl, rawMeasured, MIN_RR_TP2, "BUY"));
          signal        = "BUY";
          signalType    = "DOUBLE_BOTTOM";
          entryPrice    = ep;
          stopLoss      = sl;
          takeProfit1   = tp1;
          takeProfit2   = tp2;
          dca1          = undefined;
          patternResult = dbResult;
          signalReason  = `[${tfLabel}] DOUBLE BOTTOM BUY (forming): Support ${fmt(support)}, Neckline ${fmt(neckline)}. Entry ${fmt(ep)}, SL ${fmt(sl)} (below troughs), TP1 ${fmt(tp1)} (neckline), TP2 ${fmt(tp2)} (measured move).`;
        }
      } else {
        // Confirmed: neckline already broken — enter near neckline, TP = measured move
        if (Math.abs(currentPrice - neckline) <= 2 * FIB50_TOLERANCE_ATR * atr) {
          const ep          = round(neckline);
          const rawMeasured = neckline + (neckline - support);
          const tp1         = round(floorTarget(ep, sl, rawMeasured, MIN_RR_TP2, "BUY"));
          const tp2         = tp1; // measured move is already TP in confirmed mode
          signal        = "BUY";
          signalType    = "DOUBLE_BOTTOM";
          entryPrice    = ep;
          stopLoss      = sl;
          takeProfit1   = tp1;
          takeProfit2   = tp2;
          dca1          = undefined;
          patternResult = dbResult;
          signalReason  = `[${tfLabel}] DOUBLE BOTTOM BUY (neckline broken): Support ${fmt(support)}, Neckline ${fmt(neckline)}. Entry ${fmt(ep)}, SL ${fmt(sl)} (below troughs), TP1 ${fmt(tp1)} (measured move).`;
        }
      }
    }
  }

  // ── BB_REJECTION detection (Bollinger Band exhaustion reversal) ─────────────
  // Fires when FIB50_SWING, DOUBLE_TOP, and DOUBLE_BOTTOM are all WAIT.
  // Catches: price pumps to upper BB → MACD fades from green → volume dries up → short.
  // Mirror for buys at the lower band (selling exhaustion).
  //
  // SELL:  price ≤ 0.5 ATR from upper BB(30,2σ)
  //        + MACD histogram was positive last bar but now declining
  //        + last bar volume < prior bar volume
  // BUY:   price ≤ 0.5 ATR from lower BB(30,2σ)
  //        + MACD histogram was negative last bar but now recovering
  //        + last bar volume < prior bar volume
  //
  //   Entry:  BB upper (SELL) / BB lower (BUY)
  //   TP1:    50% fib midpoint of the most-recent structural swing
  //   SL:     2:1 R:R  →  entry ± 0.5 × (entry − TP1)
  //   TP2:    measured move (floored at MIN_RR_TP2)
  if (signal === "WAIT" && macdWarm) {
    const bbrCompleted = candles.slice(0, candles.length - 1);
    const bb30r = calcBollingerBands(bbrCompleted.map((c) => c.close), 30, 2);

    if (bb30r) {
      const BBR_LOOKBACK = SWING_LOOKBACK_BY_TF[timeframe] ?? 40;
      const BBR_TOL_ATR  = 0.5;

      // Volume fading: last completed bar volume < the bar before it
      const volLast  = bbrCompleted[bbrCompleted.length - 1]?.volume ?? 0;
      const volPrior = bbrCompleted[bbrCompleted.length - 2]?.volume ?? 0;
      const volFading = volLast < volPrior;

      const bbrSwingHighs = findSwingHighs(bbrCompleted, 3, BBR_LOOKBACK);
      const bbrSwingLows  = findSwingLows(bbrCompleted,  3, BBR_LOOKBACK);

      // ── SELL: upper band rejection ──────────────────────────────────────
      // MACD: 2 consecutive completed bars of decline while histogram is still green.
      // histPrev3 > histPrev2 > histPrev1 with histPrev2 > 0 ensures the fade
      // is established (not just a single-bar blip) and still in positive territory.
      const bbrSellMacd =
        Number.isFinite(histPrev3) &&
        histPrev3 > 0 &&
        histPrev2 > 0 &&
        histPrev2 < histPrev3 &&   // bar 2 already declining from bar 3
        histPrev1 < histPrev2;     // bar 1 still declining from bar 2

      // Weekly macro gate: if the weekly MACD histogram is positive (bull market),
      // BB_REJECTION SELL will BB-walk into repeated SL hits. Require weekly ≤ 0.
      let weeklyAllowsBbrSell = true;
      {
        const bbrWeeklyCandles =
          timeframe === "1d" ? synthesizeWeeklyCandles(bbrCompleted) :
          timeframe === "1w" ? bbrCompleted :
          (dailyCandlesForWeekly ? synthesizeWeeklyCandles(dailyCandlesForWeekly) : []);
        if (bbrWeeklyCandles.length >= 35) {
          const wHist = calcMACDHist(bbrWeeklyCandles.map((c: { close: number }) => c.close));
          const wLastHist = wHist[wHist.length - 2]; // last *completed* weekly bar
          if (Number.isFinite(wLastHist) && wLastHist > 0) {
            weeklyAllowsBbrSell = false;
          }
        }
      }

      if (
        !isLongOnly &&
        higherTfAllowsSell &&
        weeklyAllowsBbrSell &&
        bbrSellMacd &&
        volFading &&
        Math.abs(currentPrice - bb30r.upper) <= BBR_TOL_ATR * atr
      ) {
        // Find most-recent structural swing HIGH (pump top) + swing LOW before it (pump base)
        const sellHighs = [...bbrSwingHighs].reverse();
        const sellLows  = [...bbrSwingLows].reverse();
        let swingTop: number | null  = null;
        let swingBase: number | null = null;
        for (const sh of sellHighs) {
          const base = sellLows.find((sl) => sl.idx < sh.idx);
          if (!base) continue;
          if (sh.price - base.price < MIN_SWING_ATR * atr) continue;
          swingTop  = sh.price;
          swingBase = base.price;
          break;
        }
        if (swingTop !== null && swingBase !== null) {
          const tp1Raw = (swingTop + swingBase) / 2; // 50% retracement midpoint
          if (tp1Raw < currentPrice) {
            const ep  = round(bb30r.upper);
            const tp1 = round(tp1Raw);
            const sl  = round(ep + 0.5 * (ep - tp1));   // 2:1 R:R
            const tp2 = round(floorTarget(ep, sl, tp1 - (ep - tp1), MIN_RR_TP2, "SELL"));
            signal      = "SELL";
            signalType  = "BB_REJECTION";
            entryPrice  = ep;
            stopLoss    = sl;
            takeProfit1 = tp1;
            takeProfit2 = tp2;
            dca1        = undefined;
            patternResult = null;
            signalReason = `[${tfLabel}] BB REJECTION SELL: Price at upper BB30 ${fmt(bb30r.upper)}, MACD fading 2 bars (${histPrev3.toFixed(4)}→${histPrev2.toFixed(4)}→${histPrev1.toFixed(4)}), volume declining. Swing ${fmt(swingBase)}–${fmt(swingTop)}. Entry ${fmt(ep)}, TP1 ${fmt(tp1)} (50% fib), SL ${fmt(sl)} (2:1 R:R), TP2 ${fmt(tp2)}.`;
          }
        }
      }

      // ── BUY: lower band rejection ───────────────────────────────────────
      // MACD: 2 consecutive completed bars of recovery while histogram is still red.
      // histPrev3 < histPrev2 < histPrev1 with histPrev2 < 0 ensures the recovery
      // is established and still in negative territory (mirror of the SELL condition).
      //
      // Metals (XAG, XAU) require histPrev1 > 0 — the histogram must actually be
      // green before firing. Silver/gold have repeatedly reversed through every BB
      // lower-band touch while MACD was still red; early-turn entries do not work
      // for metals. Crypto keeps the original red-but-recovering behaviour.
      const bbrBuyMacd =
        Number.isFinite(histPrev3) &&
        histPrev3 < 0 &&
        histPrev2 < 0 &&
        histPrev2 > histPrev3 &&   // bar 2 already recovering from bar 3
        histPrev1 > histPrev2 &&   // bar 1 still recovering from bar 2
        (!meta.goldApi || histPrev1 > 0);  // metals: must be green; crypto: red-ok
      if (
        signal === "WAIT" &&
        higherTfAllowsBuy &&
        bbrBuyMacd &&
        volFading &&
        Math.abs(currentPrice - bb30r.lower) <= BBR_TOL_ATR * atr
      ) {
        // Find most-recent structural swing LOW (dump bottom) + swing HIGH before it (dump origin)
        const buyLows  = [...bbrSwingLows].reverse();
        const buyHighs = [...bbrSwingHighs].reverse();
        let swingBottom: number | null = null;
        let swingCeiling: number | null = null;
        for (const sl of buyLows) {
          const top = buyHighs.find((sh) => sh.idx < sl.idx);
          if (!top) continue;
          if (top.price - sl.price < MIN_SWING_ATR * atr) continue;
          swingBottom  = sl.price;
          swingCeiling = top.price;
          break;
        }
        if (swingBottom !== null && swingCeiling !== null) {
          const tp1Raw = (swingCeiling + swingBottom) / 2; // 50% fib midpoint
          if (tp1Raw > currentPrice) {
            const ep  = round(bb30r.lower);
            const tp1 = round(tp1Raw);
            const sl  = round(ep - 0.5 * (tp1 - ep));   // 2:1 R:R
            const tp2 = round(floorTarget(ep, sl, tp1 + (tp1 - ep), MIN_RR_TP2, "BUY"));
            signal      = "BUY";
            signalType  = "BB_REJECTION";
            entryPrice  = ep;
            stopLoss    = sl;
            takeProfit1 = tp1;
            takeProfit2 = tp2;
            dca1        = undefined;
            patternResult = null;
            signalReason = `[${tfLabel}] BB REJECTION BUY: Price at lower BB30 ${fmt(bb30r.lower)}, MACD recovering 2 bars (${histPrev3.toFixed(4)}→${histPrev2.toFixed(4)}→${histPrev1.toFixed(4)}), volume declining. Swing ${fmt(swingBottom)}–${fmt(swingCeiling)}. Entry ${fmt(ep)}, TP1 ${fmt(tp1)} (50% fib), SL ${fmt(sl)} (2:1 R:R), TP2 ${fmt(tp2)}.`;
          }
        }
      }
    }
  }

  // ── BB_WALK BUY: upper-band trend continuation in a confirmed bull market ─────
  // Fires when price is riding (pressing) the upper Bollinger Band while both
  // weekly AND daily MACD histograms are green. Unlike BB_REJECTION (which needs
  // MACD fading = mean-reversion entry), BB_WALK treats upper-band walking as
  // STRENGTH — price hugging the upper band is trend continuation in a macro
  // uptrend, not exhaustion. Captures trending coins (DOGE, NEAR, HYPE, AERO
  // etc.) that pump without pulling back to fib/lower-band levels.
  //
  // BUY only — no SELL equivalent. Crypto perps only (okxPerp/phemexPerp).
  //
  // Conditions (all required):
  //   1. Weekly MACD histogram > 0 (macro bull market — same gate as BB_REJECTION SELL block)
  //   2. higherTfAllowsBuy (daily MACD hist > 0, already computed above)
  //   3. Price at or pressing upper BB30 (within 0.3×ATR below band)
  //   4. Price > BB midline (structural strength — holding in upper half)
  //   5. Last completed bar volume ≥ avg of prior 5 bars (expanding, not fading)
  //
  // Entry:  currentPrice (market-order momentum entry)
  // TP1:    BB upper + 1.0×ATR (extension target above band)
  // SL:     BB midline − 0.3×ATR (below mid = trend structure broken)
  // TP2:    measured move (TP1 + reward distance), floored at MIN_RR_TP2
  // Min R:R: 1.5 (tighter than other signals; momentum entries have less room)
  // BB_WALK is scoped to 1h only: the spec conditions reference "last completed 1h candle"
  // and the signal targets trending coins on the 1h cycle. Daily/weekly runs are higher-TF
  // trend checks already served by higherTfAllowsBuy; no value in a daily BB_WALK entry.
  if (signal === "WAIT" && timeframe === "1h" && higherTfAllowsBuy && macdWarm) {
    // Explicit crypto-only gate: metals (hasFuturesBasis) walk the upper band as exhaustion,
    // not trend continuation. okxPerp/phemexPerp guards also screen out forex pairs.
    const isCryptoPerpNonMetal = !meta.hasFuturesBasis && Boolean(meta.okxPerp ?? meta.phemexPerp);
    if (isCryptoPerpNonMetal) {
      const bbwCompleted = candles.slice(0, candles.length - 1);
      const bb30w = calcBollingerBands(bbwCompleted.map((c) => c.close), 30, 2);
      if (bb30w) {
        // Gate 1: weekly MACD must be green (macro bull market confirmed).
        // For 1h timeframe: synthesize weekly candles from dailyCandlesForWeekly.
        let weeklyMacdBull = false;
        {
          const bbwWeeklyCandles =
            dailyCandlesForWeekly ? synthesizeWeeklyCandles(dailyCandlesForWeekly) : [];
          if (bbwWeeklyCandles.length >= 35) {
            const wHist = calcMACDHist(bbwWeeklyCandles.map((c: { close: number }) => c.close));
            const wLastHist = wHist[wHist.length - 2]; // last *completed* weekly bar
            if (Number.isFinite(wLastHist) && wLastHist > 0) weeklyMacdBull = true;
          }
        }
        if (weeklyMacdBull) {
          // Gate 3: price at or pressing the upper band (within 0.3×ATR below).
          const atUpperBand = currentPrice >= bb30w.upper - 0.3 * atr;
          // Gate 4: last COMPLETED 1h candle closed above the BB midline.
          // Using the completed candle close (not live currentPrice) prevents
          // intrabar spikes from triggering the signal prematurely.
          const lastCompletedClose = bbwCompleted[bbwCompleted.length - 1].close;
          const aboveMid = lastCompletedClose > bb30w.middle;
          // Gate 5: volume expanding — last completed bar ≥ avg volume of prior 5 bars.
          const volPrior5   = bbwCompleted.slice(-6, -1);
          const avgVol5     = volPrior5.length > 0
            ? volPrior5.reduce((s, c) => s + c.volume, 0) / volPrior5.length
            : 0;
          const volExpanding = avgVol5 > 0 &&
            bbwCompleted[bbwCompleted.length - 1].volume >= avgVol5;
          if (atUpperBand && aboveMid && volExpanding) {
            const ep  = round(currentPrice);
            const tp1 = round(bb30w.upper + 1.0 * atr);
            const sl  = round(bb30w.middle - 0.3 * atr);
            if (tp1 > ep && ep > sl) {
              const reward = tp1 - ep;
              const risk   = ep - sl;
              const rr     = reward / risk;
              if (rr >= 1.5) {
                const tp2 = round(floorTarget(ep, sl, tp1 + (tp1 - ep), MIN_RR_TP2, "BUY"));
                signal      = "BUY";
                signalType  = "BB_WALK";
                entryPrice  = ep;
                stopLoss    = sl;
                takeProfit1 = tp1;
                takeProfit2 = tp2;
                dca1        = undefined;
                patternResult = null;
                signalReason = `[${tfLabel}] BB WALK BUY: Price ${fmt(ep)} riding upper BB30 ${fmt(bb30w.upper)}, weekly MACD green, volume expanding. TP1 ${fmt(tp1)} (BB upper + 1×ATR), SL ${fmt(sl)} (BB mid − 0.3×ATR), TP2 ${fmt(tp2)} (${rr.toFixed(1)}:1 R:R).`;
              }
            }
          }
        }
      }
    }
  }

  // ── BB_OVEREXTENSION SELL: last completed candle closed above upper BB ────────
  // A coin that closes outside the Bollinger Band on elevated volume has almost
  // certainly overextended and will snap back toward the midline. Unlike the
  // BB_REJECTION block above (which requires MACD to already be declining while
  // price is touching the band), this fires AFTER the overextension closes.
  // Common scenario: altcoin pumps on no fundamental news, exits the band,
  // then dumps immediately as retail buyers run out.
  //
  // Entry:  limit at pre-pump upper BB (so we short into any dead-cat bounce)
  // TP1:    BB midline (mean reversion target)
  // SL:     above spike high + 0.5×ATR buffer (enforces minimum 2:1 R:R)
  // macdWarm ensures MACD values are reliable (needs 26+9 bars of history).
  if (signal === "WAIT" && !isLongOnly && macdWarm && higherTfAllowsSell) {
    const overextCompleted = candles.slice(0, candles.length - 1);
    if (overextCompleted.length >= 32) { // need at least 30 for BB + 1 prior candle
      const lastCandle  = overextCompleted[overextCompleted.length - 1];
      // Pre-pump BB: calculated on all candles EXCEPT the last completed one,
      // so the band width isn't inflated by the spike itself.
      const prePumpCloses = overextCompleted.slice(0, -1).map((c) => c.close);
      const prePumpBB = calcBollingerBands(prePumpCloses, 30, 2);

      if (prePumpBB) {
        const closeAboveBand = lastCandle.close > prePumpBB.upper;
        // Require a meaningful overextension: at least 1% above the pre-pump band.
        // Hairline closes above the band are noise; genuine pump-exits are obvious.
        const overextPct = (lastCandle.close - prePumpBB.upper) / prePumpBB.upper;
        const meaningfulBreak = overextPct >= 0.01;

        // Volume spike: last candle volume > 1.5× the 20-bar average before it.
        const preVol = overextCompleted.slice(-21, -1);
        const avgVol20 = preVol.length > 0 ? preVol.reduce((s, c) => s + c.volume, 0) / preVol.length : 0;
        const volumeSpike = avgVol20 > 0 && lastCandle.volume > avgVol20 * 1.5;

        // RSI overbought on completed candles: RSI > 70 at the time of the pump
        // close confirms the move is genuinely extreme, not just a normal candle.
        const overextRSI = calcRSI(overextCompleted.map((c) => c.close));
        const rsiOverbought = overextRSI > 70;

        // MACD was positive before the last bar (histPrev2 > 0): confirms the pump
        // had real upward momentum rather than being a dead-cat in a downtrend.
        // We do NOT require MACD to already be declining — the pump candle itself
        // often has a still-rising histogram; the reversal signal comes from the
        // overextension + RSI, not from MACD timing.
        const macdHadMomentum = histPrev2 > 0;

        // Entry confirmation: the forming candle must be trading BELOW the pump
        // candle's close — i.e. the current candle is going red relative to the
        // pump. This avoids placing a limit at the upper band where a retest wick
        // could stop us out before the real reversal begins.
        const formingRed = currentPrice < lastCandle.close;
        // Don't enter if the move to midline is already mostly done.
        const notOverdone = currentPrice > prePumpBB.middle;

        if (closeAboveBand && meaningfulBreak && volumeSpike && rsiOverbought && macdHadMomentum && formingRed && notOverdone) {
          // Entry at current price (first red candle confirmation — buyer exhaustion).
          const ep  = round(currentPrice);
          const tp1 = round(prePumpBB.middle);
          if (tp1 < ep) { // sanity: TP must be below entry for a SELL
            // SL above the spike high of the last 5 candles + 0.5×ATR buffer.
            const recentHigh = Math.max(...overextCompleted.slice(-5).map((c) => c.high));
            const slFromSpike = round(recentHigh + 0.5 * atr);
            // Also enforce a minimum 2:1 R:R from entry.
            const minSl = round(ep + 0.5 * (ep - tp1));
            const sl  = Math.max(slFromSpike, minSl);
            const tp2 = round(floorTarget(ep, sl, tp1 - (ep - tp1), MIN_RR_TP2, "SELL"));
            signal       = "SELL";
            signalType   = "BB_REJECTION";
            entryPrice   = ep;
            stopLoss     = sl;
            takeProfit1  = tp1;
            takeProfit2  = tp2;
            dca1         = undefined;
            patternResult = null;
            signalReason = `[${tfLabel}] BB OVEREXTENSION SELL: Last close ${fmt(lastCandle.close)} above pre-pump upper BB ${fmt(prePumpBB.upper)} (+${(overextPct * 100).toFixed(1)}%), volume spike ${(lastCandle.volume / avgVol20).toFixed(1)}×, RSI ${overextRSI.toFixed(0)}. Entry ${fmt(ep)} (first red candle close), TP1 ${fmt(tp1)} (midline), SL ${fmt(sl)} (above spike high ${fmt(recentHigh)}).`;
          }
        }
      }
    }
  }

  // ── BB_BREAKOUT: outside-band momentum continuation ("money print") ──────────
  // When price is ABOVE the upper BB30 on the current timeframe AND the same-TF
  // MACD histogram is rising, the move is a genuine breakout — not an
  // overextension ripe for reversal. The upper band becomes support; ride the
  // continuation long. Conversely, price BELOW the lower band with MACD falling
  // = short the momentum breakdown.
  //
  // This signal is the redirect target for FIB50_SWING trades that get blocked
  // by the pctB30 > 1.0 / pctB30 < 0 guards — instead of doing nothing, the
  // system pivots to the direction the market is actually moving.
  //
  // Entry:  currentPrice (momentum market order)
  // BUY SL: BB upper − 0.3×ATR (band becomes support; close below = failed breakout)
  // SELL SL: BB lower + 0.3×ATR (band becomes resistance)
  // TP1:    entry ± 1.5×risk
  // TP2:    entry ± 2.5×risk
  //
  // Gates: same-TF macdBuyOk/macdSellOk + daily curl gate (higherTfAllows*)
  if (signal === "WAIT" && macdWarm) {
    const bbkCompleted = candles.slice(0, candles.length - 1);
    if (bbkCompleted.length >= 30) {
      const bbkBands = calcBollingerBands(bbkCompleted.map((c) => c.close), 30, 2);
      if (bbkBands) {
        const pctBk = (currentPrice - bbkBands.lower) / (bbkBands.upper - bbkBands.lower);

        // Band-walk confirmation: the previous completed bar must also have closed
        // outside the band. A single-bar spike above/below and then revert is the
        // most common false positive; requiring 2 consecutive bars outside filters it.
        const prevClose = bbkCompleted[bbkCompleted.length - 2]?.close ?? currentPrice;

        // BUY: price above upper band + MACD histogram positive AND rising + prev bar also outside
        const bbkBuyMacd = macdWarm && histPrev1 > 0 && histPrev1 > histPrev2;
        if (pctBk > 1.0 && bbkBuyMacd && higherTfAllowsBuy && prevClose > bbkBands.upper) {
          const ep   = round(currentPrice);
          const sl   = round(bbkBands.upper - 0.3 * atr);
          const risk = ep - sl;
          if (risk > 0) {
            const tp1 = round(ep + 1.5 * risk);
            const tp2 = round(ep + 2.5 * risk);
            signal       = "BUY";
            signalType   = "BB_BREAKOUT";
            entryPrice   = ep;
            stopLoss     = sl;
            takeProfit1  = tp1;
            takeProfit2  = tp2;
            dca1         = undefined;
            patternResult = null;
            signalReason = `[${tfLabel}] BB BREAKOUT BUY: Price ${fmt(ep)} above upper BB30 ${fmt(bbkBands.upper)} (%B ${pctBk.toFixed(2)}), MACD positive+rising — 2-bar band walk confirmed. SL ${fmt(sl)} (below band), TP1 ${fmt(tp1)}, TP2 ${fmt(tp2)}.`;
          }
        }

        // SELL: price below lower band + MACD histogram negative AND falling + prev bar also outside
        const bbkSellMacd = macdWarm && histPrev1 < 0 && histPrev1 < histPrev2;
        if (signal === "WAIT" && pctBk < 0 && bbkSellMacd && higherTfAllowsSell && !isLongOnly && prevClose < bbkBands.lower) {
          const ep   = round(currentPrice);
          const sl   = round(bbkBands.lower + 0.3 * atr);
          const risk = sl - ep;
          if (risk > 0) {
            const tp1 = round(ep - 1.5 * risk);
            const tp2 = round(ep - 2.5 * risk);
            signal       = "SELL";
            signalType   = "BB_BREAKOUT";
            entryPrice   = ep;
            stopLoss     = sl;
            takeProfit1  = tp1;
            takeProfit2  = tp2;
            dca1         = undefined;
            patternResult = null;
            signalReason = `[${tfLabel}] BB BREAKOUT SELL: Price ${fmt(ep)} below lower BB30 ${fmt(bbkBands.lower)} (%B ${pctBk.toFixed(2)}), MACD negative+falling — 2-bar band walk confirmed. SL ${fmt(sl)} (above band), TP1 ${fmt(tp1)}, TP2 ${fmt(tp2)}.`;
          }
        }
      }
    }
  }

  // ── PATTERN_BREAKOUT detection (confirmed chart pattern breakout) ────────────
  // Last in the cascade — fires only when all other signal types are WAIT.
  // Detects confirmed breakouts from triangles, wedges, flags, pennants, H&S/IHS.
  // Skips DOUBLE_TOP / DOUBLE_BOTTOM (already handled as their own signal types).
  // Only two-rail patterns (necklinePrice + upperBound both defined) are used so
  // the SL can be anchored to the pattern structure.
  //
  // Entry:  market order at current price (breakout confirmed on bar n-2 close)
  // SL:     below lower rail (BUY) / above upper rail (SELL) + 0.3×ATR buffer
  // TP1:    entry ± 2×risk  (2:1 R:R enforced)
  // TP2:    entry ± pattern height (measured move), floored at MIN_RR_TP2
  //
  // Not auto-traded via Phemex — notifier.ts gates auto-trading to FIB50_SWING,
  // DOUBLE_TOP, DOUBLE_BOTTOM, and BB_REJECTION only.
  if (signal === "WAIT") {
    const pbCompleted = candles.slice(0, candles.length - 1);
    const pbPattern   = detectChartPattern(pbCompleted);
    if (
      pbPattern?.confirmed &&
      pbPattern.necklinePrice != null &&
      pbPattern.upperBound   != null &&
      pbPattern.pattern !== "DOUBLE_TOP" &&
      pbPattern.pattern !== "DOUBLE_BOTTOM"
    ) {
      const patternHeight = pbPattern.upperBound - pbPattern.necklinePrice;
      if (pbPattern.direction === "bullish" && macdBuyOk && higherTfAllowsBuy) {
        const ep   = round(currentPrice);
        const sl   = round(pbPattern.necklinePrice - 0.3 * atr);
        const risk = ep - sl;
        if (risk > 0) {
          const tp1 = round(ep + 2 * risk);
          const tp2 = round(floorTarget(ep, sl, ep + patternHeight, MIN_RR_TP2, "BUY"));
          signal       = "BUY";
          signalType   = "PATTERN_BREAKOUT";
          entryPrice   = ep;
          stopLoss     = sl;
          takeProfit1  = tp1;
          takeProfit2  = tp2;
          dca1         = undefined;
          patternResult = pbPattern;
          signalReason  = `[${tfLabel}] PATTERN BREAKOUT BUY: ${pbPattern.pattern} confirmed. Entry ${fmt(ep)}, SL ${fmt(sl)} (below ${fmt(pbPattern.necklinePrice)} rail − 0.3×ATR), TP1 ${fmt(tp1)} (2:1 R:R), TP2 ${fmt(tp2)} (measured move).`;
        }
      } else if (!isLongOnly && macdSellOk && higherTfAllowsSell) {
        const ep   = round(currentPrice);
        const sl   = round(pbPattern.upperBound + 0.3 * atr);
        const risk = sl - ep;
        if (risk > 0) {
          const tp1 = round(ep - 2 * risk);
          const tp2 = round(floorTarget(ep, sl, ep - patternHeight, MIN_RR_TP2, "SELL"));
          signal       = "SELL";
          signalType   = "PATTERN_BREAKOUT";
          entryPrice   = ep;
          stopLoss     = sl;
          takeProfit1  = tp1;
          takeProfit2  = tp2;
          dca1         = undefined;
          patternResult = pbPattern;
          signalReason  = `[${tfLabel}] PATTERN BREAKOUT SELL: ${pbPattern.pattern} confirmed breakdown. Entry ${fmt(ep)}, SL ${fmt(sl)} (above ${fmt(pbPattern.upperBound)} rail + 0.3×ATR), TP1 ${fmt(tp1)} (2:1 R:R), TP2 ${fmt(tp2)} (measured move).`;
        }
      }
    }

    // Candlestick reversal signals (BEARISH_ENGULFING, BULLISH_ENGULFING, etc.)
    // Only runs if no chart pattern already set the signal above.
    if (signal === "WAIT") {
      const csPattern = detectCandlestickSignal(pbCompleted);
      if (csPattern?.confirmed && csPattern.necklinePrice != null) {
        if (csPattern.direction === "bearish" && !isLongOnly && macdSellOk && higherTfAllowsSell) {
          const ep       = round(currentPrice);
          const sl       = round(csPattern.necklinePrice + 0.3 * atr);
          const risk     = sl - ep;
          const engulfH  = pbCompleted[pbCompleted.length - 2]?.high ?? ep;
          const engulfL  = pbCompleted[pbCompleted.length - 2]?.low  ?? ep;
          const measured = engulfH - engulfL;
          if (risk > 0) {
            const tp1 = round(ep - 2 * risk);
            const tp2 = round(floorTarget(ep, sl, ep - measured, MIN_RR_TP2, "SELL"));
            signal       = "SELL";
            signalType   = "PATTERN_BREAKOUT";
            entryPrice   = ep;
            stopLoss     = sl;
            takeProfit1  = tp1;
            takeProfit2  = tp2;
            dca1         = undefined;
            patternResult = csPattern;
            signalReason  = `[${tfLabel}] ${csPattern.pattern}: bearish reversal confirmed. Entry ${fmt(ep)}, SL ${fmt(sl)} (above engulf high ${fmt(csPattern.necklinePrice)} + 0.3×ATR), TP1 ${fmt(tp1)} (2:1 R:R), TP2 ${fmt(tp2)} (measured move).`;
          }
        } else if (csPattern.direction === "bullish" && macdBuyOk && higherTfAllowsBuy) {
          const ep       = round(currentPrice);
          const sl       = round(csPattern.necklinePrice - 0.3 * atr);
          const risk     = ep - sl;
          const engulfH  = pbCompleted[pbCompleted.length - 2]?.high ?? ep;
          const engulfL  = pbCompleted[pbCompleted.length - 2]?.low  ?? ep;
          const measured = engulfH - engulfL;
          if (risk > 0) {
            const tp1 = round(ep + 2 * risk);
            const tp2 = round(floorTarget(ep, sl, ep + measured, MIN_RR_TP2, "BUY"));
            signal       = "BUY";
            signalType   = "PATTERN_BREAKOUT";
            entryPrice   = ep;
            stopLoss     = sl;
            takeProfit1  = tp1;
            takeProfit2  = tp2;
            dca1         = undefined;
            patternResult = csPattern;
            signalReason  = `[${tfLabel}] ${csPattern.pattern}: bullish reversal confirmed. Entry ${fmt(ep)}, SL ${fmt(sl)} (below engulf low ${fmt(csPattern.necklinePrice)} − 0.3×ATR), TP1 ${fmt(tp1)} (2:1 R:R), TP2 ${fmt(tp2)} (measured move).`;
          }
        }
      }
    }
  }

  // Entry zone for chart display: ±FIB50_TOLERANCE_ATR around the entry price.
  const entryZoneLow  = round(entryPrice - FIB50_TOLERANCE_ATR * atr);
  const entryZoneHigh = round(entryPrice + FIB50_TOLERANCE_ATR * atr);
  // In WAIT state, use the nearest valid fib50 for each direction so the
  // LONG and SHORT zone watch panels show distinct, meaningful values instead
  // of the same currentPrice ± tolerance fallback.
  const buyCenter  = signal === "BUY"  ? entryPrice : (candidateBuyFib50  > 0 ? candidateBuyFib50  : currentPrice);
  const sellCenter = signal === "SELL" ? entryPrice : (candidateSellFib50 > 0 ? candidateSellFib50 : currentPrice);
  const buyZoneLow    = signal === "BUY"  ? entryZoneLow  : round(buyCenter  - FIB50_TOLERANCE_ATR * atr);
  const buyZoneHigh   = signal === "BUY"  ? entryZoneHigh : round(buyCenter  + FIB50_TOLERANCE_ATR * atr);
  const sellZoneLow   = signal === "SELL" ? entryZoneLow  : round(sellCenter - FIB50_TOLERANCE_ATR * atr);
  const sellZoneHigh  = signal === "SELL" ? entryZoneHigh : round(sellCenter + FIB50_TOLERANCE_ATR * atr);

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
    { label: "Swing High", price: displaySwingHigh, type: "resistance" as LevelType },
    { label: "50% Fib",    price: displayFib50,     type: "pivot"      as LevelType },
    { label: "Swing Low",  price: displaySwingLow,  type: "support"    as LevelType },
  ]
    .filter((l) => l.price > 0)
    .sort((a, b) => b.price - a.price);

  // Ranging market filter: ADX < 25 means no directional energy — suppress any
  // fresh signal. Active trades (handled by computeLevelsStable above this call)
  // are unaffected; this only blocks new entries in choppy, low-momentum markets.
  if (adxWarm && adx < 25 && (signal === "BUY" || signal === "SELL")) {
    signal = "WAIT";
    signalReason = `[${timeframe}] RANGING — ADX ${adx.toFixed(1)} below 25. No directional energy.`;
  }

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
    dca1,
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
  signalType?: "FIB50_SWING" | "DOUBLE_TOP" | "DOUBLE_BOTTOM" | "BB_REJECTION" | "BB_WALK" | "BB_BREAKOUT" | "PATTERN_BREAKOUT";
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

// Tracks the bar-open timestamp (ms) of the candle on which a 1D/1W trade
// last closed. Used to suppress immediate re-staging on the same live bar —
// a trade that stops out on a forming daily candle should not be re-entered
// until the next bar opens.
const lastClosedBarTs = new Map<string, number>();

function getBarOpenTs(candles: CandleRaw[]): number {
  const last = candles[candles.length - 1];
  return last ? Date.parse(last.date) : 0;
}

// ─── Disk persistence for active trades ──────────────────────────────────────
// The freeze-on-signal logic keeps entry/SL/TP stable from the moment a BUY
// or SELL fires until SL or TP2 hits. Without disk persistence, every server
// restart wiped the in-memory Map, which let the next request re-snapshot
// fresh (drifted) levels. Persist to a JSON file so restarts preserve open
// trades.

const ACTIVE_TRADES_FILE =
  process.env.ACTIVE_TRADES_FILE ??
  join(process.cwd(), ".runtime", "active-trades.json");

// Namespace that scopes all DB reads/writes so development and production
// never read or overwrite each other's active-trade rows.
// Production sets NODE_ENV=production via artifact.toml; dev leaves it unset.
const DB_NAMESPACE = process.env["NODE_ENV"] === "production" ? "production" : "dev";

// ─── PostgreSQL pool (lazy) ───────────────────────────────────────────────────
// Used as the durable persistence layer so active trades survive across
// production deployments (the local JSON file is wiped on each redeploy).
// Falls back silently to file-only if DATABASE_URL is absent.
let _pgPool: Pool | null = null;
function getPool(): Pool | null {
  if (!process.env["DATABASE_URL"]) return null;
  if (!_pgPool) _pgPool = new Pool({ connectionString: process.env["DATABASE_URL"], ssl: { rejectUnauthorized: false } });
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

async function initSignalLogTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signal_log (
        id               SERIAL PRIMARY KEY,
        key              TEXT NOT NULL,
        symbol           TEXT NOT NULL,
        timeframe        TEXT NOT NULL,
        signal           TEXT NOT NULL,
        signal_type      TEXT NOT NULL,
        entry_price      DOUBLE PRECISION NOT NULL,
        stop_loss        DOUBLE PRECISION NOT NULL,
        take_profit1     DOUBLE PRECISION NOT NULL,
        take_profit2     DOUBLE PRECISION NOT NULL,
        risk_reward_ratio DOUBLE PRECISION NOT NULL,
        signal_reason    TEXT NOT NULL DEFAULT '',
        fired_at         BIGINT NOT NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch {
    // best-effort — table already exists or DB unavailable
  }
}

function insertSignalLog(trade: ActiveTrade, symbolKey: string, timeframe: Timeframe): void {
  const pool = getPool();
  if (!pool) return;
  void pool
    .query(
      `INSERT INTO signal_log
         (key, symbol, timeframe, signal, signal_type,
          entry_price, stop_loss, take_profit1, take_profit2,
          risk_reward_ratio, signal_reason, fired_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        tradeKey(symbolKey, timeframe),
        symbolKey,
        timeframe,
        trade.signal,
        trade.signalType ?? "FIB50_SWING",
        trade.entryPrice,
        trade.stopLoss,
        trade.takeProfit1,
        trade.takeProfit2,
        trade.riskRewardRatio,
        trade.signalReason,
        trade.openedAt ?? Date.now(),
      ],
    )
    .catch(() => {
      // best-effort
    });
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
  // BE_TRAIL: half the position was closed at TP1 (locking in profit), the other
  // half came back and closed at breakeven (entry). Net R = TP1_gain × 0.5 / originalRisk.
  // exitPrice for BE_TRAIL equals entryPrice, so rawPnl is always 0 — we must
  // use the stored TP1 distance instead of exitPrice to get the true R.
  let rMultiple: number;
  if (outcome === "MISSED") {
    rMultiple = 0;
  } else if (outcome === "BE_TRAIL" && trade.tp1Hit && originalRisk > 0) {
    const tp1Dist = Math.abs(trade.takeProfit1 - trade.entryPrice);
    rMultiple = (tp1Dist * 0.5) / originalRisk;
  } else {
    rMultiple = originalRisk > 0 ? rawPnl / originalRisk : 0;
  }

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
        trade.signalType ?? "FIB50_SWING",
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
  await initSignalLogTable();
  try {
    const res = await pool.query<{ key: string; data: Record<string, unknown> }>(
      "SELECT key, data FROM active_trades WHERE key LIKE $1",
      [`${DB_NAMESPACE}::%`],
    );
    let merged = 0;
    for (const row of res.rows) {
      if (activeTrades.has(row.key)) continue; // local file wins for existing keys
      const v = row.data as Partial<ActiveTrade>;
      // Skip trades from previous strategies — they have wrong levels.
      if (v.signalType !== "FIB50_SWING" && v.signalType !== "DOUBLE_TOP" && v.signalType !== "DOUBLE_BOTTOM" && v.signalType !== "BB_REJECTION" && v.signalType !== "BB_WALK" && v.signalType !== "BB_BREAKOUT" && v.signalType !== "PATTERN_BREAKOUT") continue;
      activeTrades.set(row.key, {
        ...(v as ActiveTrade),
        signalType: v.signalType,
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

    // ── Purge zero-risk (corrupted) entries ──────────────────────────────────
    let purged = 0;
    for (const [k, trade] of activeTrades) {
      const zeroRisk = trade.entryPrice === trade.stopLoss || trade.stopLoss === 0;
      if (zeroRisk) {
        activeTrades.delete(k);
        purged++;
      }
    }
    if (purged > 0) {
      persistActiveTrades();
      // eslint-disable-next-line no-console
      console.warn(`[signals] Purged ${purged} zero-risk trade(s) on startup`);
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
      // Skip trades from previous strategies — they have wrong levels.
      if (v.signalType !== "FIB50_SWING" && v.signalType !== "DOUBLE_TOP" && v.signalType !== "DOUBLE_BOTTOM" && v.signalType !== "BB_REJECTION" && v.signalType !== "BB_WALK" && v.signalType !== "BB_BREAKOUT" && v.signalType !== "PATTERN_BREAKOUT") { didMigrate = true; continue; }
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
        signalType: "FIB50_SWING",
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
      // Scope deletes to this namespace so dev can never wipe production rows.
      if (snapshot.length === 0) {
        await pool.query(
          "DELETE FROM active_trades WHERE key LIKE $1",
          [`${DB_NAMESPACE}::%`],
        );
      } else {
        await pool.query(
          "DELETE FROM active_trades WHERE key LIKE $1 AND key <> ALL($2::text[])",
          [`${DB_NAMESPACE}::%`, snapshot.map(([k]) => k)],
        );
      }
    } catch {
      // best-effort
    }
  })();
}

// Eager load on module init: JSON file first (fast), then DB sync is exported
// so index.ts can await it before starting the notifier — prevents a race where
// the notifier seeds new trades and the cleanup DELETE wipes production rows.
loadActiveTradesFromDisk();
export { syncFromDb };

function tradeKey(symbolKey: string, timeframe: Timeframe): string {
  return `${DB_NAMESPACE}::${symbolKey}::${timeframe}`;
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
  dailyCandlesForWeekly?: CandleRaw[],
  weeklyCandlesForDaily?: CandleRaw[],
): Levels & { openedAt?: number } {
  const fresh = computeLevels(candles, spotPrice, timeframe, symbolKey, meta, accountSize, riskPct, minCollateral, maxLeverage, mt5Lots, dailyCandlesForWeekly, weeklyCandlesForDaily);
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
    lastClosedBarTs.set(k, getBarOpenTs(candles));
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
    lastClosedBarTs.set(k, getBarOpenTs(candles));
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
      lastClosedBarTs.set(k, getBarOpenTs(candles));
    } else if (hitSl) {
      // SL (or BE trail after TP1) reached via candle wick — log and delete.
      // logClosedTrade auto-derives BE_TRAIL vs SL from trade.tp1Hit + stopLoss.
      logClosedTrade(wickScanTrade, symbolKey, timeframe, wickScanTrade.stopLoss);
      activeTrades.delete(k);
      persistActiveTrades();
      lastClosedBarTs.set(k, getBarOpenTs(candles));
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
    // FIB50_SWING is always a limit entry — price must reach the 50% fib level.
    const isMarketEntryTrade = false;
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
      signalType: stillActive.signalType ?? "FIB50_SWING",
      // Recompute the explanation against current price — the frozen text is
      // a lie the moment price walks away from the original zone.
      signalReason: describeFrozenTrade(stillActive, fresh.currentPrice, timeframe, symbolKey, meta),
      // Typed mirror of the same classification — consumers should branch on
      // this, not parse the prose above.
      tradeState: classifyTradeState(stillActive, fresh.currentPrice),
      openedAt: stillActive.openedAt,
      entryPrice: stillActive.entryPrice,
      stopLoss: stillActive.stopLoss,
      takeProfit1: stillActive.takeProfit1,
      takeProfit2: stillActive.takeProfit2,
      riskRewardRatio: stillActive.riskRewardRatio,
      buyZone: stillActive.buyZone,
      sellZone: stillActive.sellZone,
      pivot: stillActive.pivot,
      levels: stillActive.levelsArr,
      // DCA from ...fresh is relative to the fresh signal's entry, NOT the
      // frozen trade's entry. Showing it against the frozen entry causes
      // directionally wrong displays (e.g. DCA below entry on a SELL).
      // Suppress it for all active trades — the DCA was only meaningful at
      // the moment the original signal fired.
      dca1: undefined,
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
    // Never re-stage a new trade on the same bar that just closed one.
    // Each bar is a discrete period — re-entering on the same candle that
    // just stopped you out is mechanically wrong regardless of timeframe.
    // This was producing 68 SL hits inside a single 1h bar (and 400+ on 1D).
    // Wait for the next completed bar before treating a fresh signal as actionable.
    {
      const currentBarTs = getBarOpenTs(candles);
      const closedBarTs  = lastClosedBarTs.get(k);
      if (closedBarTs !== undefined && closedBarTs >= currentBarTs) {
        return fresh; // signal visible but not staged — wait for next bar
      }
    }

    // PATTERN_BREAKOUT is display-only — the signal fires but is never staged
    // into activeTrades. No P&L tracking, no Phemex order, no position entry.
    // Remove this guard when PATTERN_BREAKOUT is cleared for live trading.
    if (fresh.signalType === "PATTERN_BREAKOUT") {
      return fresh;
    }

    // Market entries (DAGGER, PATTERN_BREAKOUT) fill immediately — no limit
    // to wait for. Set triggered=true on creation so the dashboard shows
    // the correct FILLED state from the first tick and `spotTagged` / candle
    // wick checks are never incorrectly applied to these trades.
    //
    // FIB50_SWING always uses limit entry — triggered when price reaches the 50% fib.
    const isMarketEntry = false;
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
    insertSignalLog(newTrade, symbolKey, timeframe);
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
      signalType: p.signalType ?? "FIB50_SWING",
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
