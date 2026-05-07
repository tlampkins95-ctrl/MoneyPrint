import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { SYMBOLS, makeRounder, type Symbol, type SymbolMeta } from "./symbols";
import { type CandleRaw, type Timeframe } from "./yahoo-fetch";
import { fetchOkxPerpPrice, fetchPhemexPerpPrice } from "./crypto-perp-fetch";
import { fetchPythPrice } from "./pyth-fetch";

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
  //  • Phemex spot  — primary for spot tokens (e.g. SKYAI), matches chart exactly
  //  • Phemex perp  — primary for USDT perps (BTC/ETH), matches PHEMEX:BTCUSDT chart
  //  • Pyth oracle  → OKX perp → Coinbase spot (crypto fallbacks)
  //  • TradingView  — scrape fallback for forex pairs (NOT used for metals)
  //  • GoldAPI      — final metals fallback
  const isMetals = SYMBOLS[symbol].hasFuturesBasis === true;
  const price =
    (await fetchFromSwissquote(symbol)) ??
    (await fetchFromPhemexSpot(symbol)) ??
    (await fetchFromPhemexPerp(symbol)) ??
    (await fetchFromPyth(symbol)) ??
    (await fetchFromOkxPerp(symbol)) ??
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
// USD P&L per 1.0 price-unit move per 1.0 lot depends on the quote currency:
//   * X/USD pairs (EUR/GBP/AUD/XAU/XAG): contractSize directly (USD = base × USD/base)
//   * USD/X pairs (USDJPY): contractSize / entry (convert JPY back to USD using live entry)
//   * Cross JPY pairs (GBPJPY): contractSize / liveUsdJpy (read from spotCache;
//       fallback to 150 only on cold start before USDJPY has been fetched once.
//       USDJPY is one of the 9 tracked symbols so this cache is normally warm.)
const USDJPY_FALLBACK = 150;

function getUsdJpyRate(): { rate: number; live: boolean } {
  const cached = spotCache.get("USDJPY");
  if (cached && Number.isFinite(cached.price) && cached.price > 0) {
    return { rate: cached.price, live: true };
  }
  return { rate: USDJPY_FALLBACK, live: false };
}

function mt5ContractSize(symbol: Symbol): { size: number; unit: string } {
  if (symbol === "XAUUSD") return { size: 100, unit: "oz" };
  if (symbol === "XAGUSD") return { size: 5000, unit: "oz" };
  return { size: 100_000, unit: symbol.slice(0, 3) }; // EUR/GBP/AUD/USD
}

function mt5UsdPerPriceUnitPerLot(symbol: Symbol, entry: number): number {
  const { size } = mt5ContractSize(symbol);
  if (symbol === "USDJPY") return entry > 0 ? size / entry : 0;
  if (symbol === "GBPJPY") return size / getUsdJpyRate().rate;
  return size; // EURUSD, GBPUSD, AUDUSD, XAUUSD, XAGUSD
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
  const usdPerUnit = mt5UsdPerPriceUnitPerLot(symbolKey as Symbol, entry);
  const slDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfit1 - entry);
  const tp2Dist = Math.abs(takeProfit2 - entry);
  const positionSize = lots * size;
  // USD notional = USD-per-price-unit × entry × lots, which works for every
  // class above (X/USD, USD/X, JPY-cross, metals) because usdPerUnit already
  // bakes in the quote-currency conversion.
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

  // ─── Metals (XAG, XAU) — venue: MT5 ───
  // OANDA std lot conventions: XAG = 5,000 oz, XAU = 100 oz. SL distance is
  // already in $/oz so risk_$ = ozHeld × slDist exactly. We still emit the
  // risk-budget-derived sizing for context, but the AUTHORITATIVE block for
  // MT5 venue is `mt5` (lots × contractSize → exact $ P&L).
  if (meta.goldApi) {
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
  // For BASE/QUOTE pairs, position size is N units of BASE.
  // Loss in QUOTE on SL hit = N × slDist. Convert to USD:
  //   USD-quote pair (EURUSD, GBPUSD, AUDUSD): USD loss = N × slDist
  //     → N = riskUSD / slDist
  //   USD-base pair (USDJPY): JPY loss = N × slDist; USD ≈ JPY / entry
  //     → N = riskUSD × entry / slDist
  //   Cross JPY pair (GBPJPY): use live USDJPY from spotCache (fallback 150)
  //     → N = riskUSD × usdJpy / slDist
  const isUsdBase = symbolKey === "USDJPY";
  const isJpyCross = symbolKey === "GBPJPY";
  let positionSize: number;
  let notional: number;
  if (isUsdBase) {
    positionSize = (riskAmount * entry) / slDist; // USD units
    notional = positionSize; // already USD
  } else if (isJpyCross) {
    const usdJpy = getUsdJpyRate().rate;
    positionSize = (riskAmount * usdJpy) / slDist; // GBP units
    notional = (positionSize * entry) / usdJpy; // GBP × JPY/GBP / (JPY/USD) = USD
  } else {
    positionSize = riskAmount / slDist; // base units (EUR, GBP, AUD)
    notional = positionSize * entry; // base × USD/base = USD
  }
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
  const RSI_OVERSOLD  = 45; // below this → momentum confirms BUY zone bounce
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

  let trend: "UPTREND" | "DOWNTREND" | "RANGING" = "RANGING";
  let trendStrength = 30;
  if (last21 > last50 && slopeUp) {
    trend = "UPTREND";
    trendStrength = Math.min(100, Math.round(((last21 - last50) / last50) * 1000 + 50));
  } else if (last21 < last50 && !slopeUp) {
    trend = "DOWNTREND";
    trendStrength = Math.min(100, Math.round(((last50 - last21) / last50) * 1000 + 50));
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
  //        last.close > bar midpoint     → strong-close (not a wick rejection)
  //        last.close > EMA21            → fast-MA confirmation on closed bar
  //   SELL: symmetric
  const breakoutBarMidpoint = (last.high + last.low) / 2;

  const breakoutBuyOk =
    last.close > pivots.r2 + 0.25 * atr &&
    !isNaN(rsi) && rsi >= 55 && rsi <= 78 &&
    trendBullishBreakout &&
    last.close > last21 &&
    macdBreakoutBuyOk &&
    last.close > breakoutBarMidpoint &&
    (!useEma200Gate || last.close > prevEma200);

  const breakdownSellOk =
    last.close < pivots.s2 - 0.25 * atr &&
    !isNaN(rsi) && rsi >= 22 && rsi <= 45 &&
    trendBearishBreakout &&
    last.close < last21 &&
    macdBreakoutSellOk &&
    last.close < breakoutBarMidpoint &&
    (!useEma200Gate || last.close < prevEma200);

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

  let signal: "BUY" | "SELL" | "WAIT" = "WAIT";
  let signalType: "PIVOT_BOUNCE" | "BREAKOUT" = "PIVOT_BOUNCE";
  let signalReason = "";
  let entryPrice = currentPrice;
  let stopLoss = currentPrice;
  let takeProfit1 = currentPrice;
  let takeProfit2 = currentPrice;

  const tfLabel = TIMEFRAME_LABELS[timeframe];

  // Entry gates: RSI exhaustion + MACD momentum turn + EMA200 regime.
  // EMA21/50 trend direction is intentionally NOT a gate — when price pumps
  // into the sell zone, EMA21 > EMA50 as a direct result of the pump itself,
  // which suppresses the exact reversal setup we want. MACD and EMA200 are
  // kept as gates: MACD confirms momentum is turning at the zone; EMA200
  // confirms the broader institutional regime. Neither moves in lockstep
  // with a short-term pump the way EMA21/50 does.
  const buyAllowed  = (isNaN(rsi) || rsi <= RSI_OVERSOLD)
    && macdBuyOk
    && ema200BuyOk;
  const sellAllowed = (isNaN(rsi) || rsi >= RSI_OVERBOUGHT)
    && macdSellOk
    && ema200SellOk;

  if ((inBuyZone || approachingBuy) && buyAllowed) {
    signal = "BUY";
    // Anchor entry to the planned limit price at S1, but never above the live
    // print — if price has already dipped at/below S1 the limit would sit
    // ABOVE market and only fill on a bounce, immediately putting the trade
    // in drawdown if it reverses (the original "BUY entry above price" bug).
    // Clamping to currentPrice turns those cases into a market-style entry at
    // the better fill, while pullback approaches from above still stage at S1.
    entryPrice = round(Math.min(pivots.s1, currentPrice));
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    signalReason = inBuyZone
      ? `[${tfLabel}] Price is at the buy zone around pivot S1 (${fmt(pivots.s1)}). ${trend === "UPTREND" ? "Uptrend intact — bounce setup." : "EMA trend neutral — look for a bullish reversal candle to confirm entry."}`
      : `[${tfLabel}] Price is within ${fmt(currentPrice - buyZoneHigh)} of the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}). Stage a limit order near S1 ${fmt(pivots.s1)}.`;
  } else if ((inSellZone || approachingSell) && sellAllowed) {
    signal = "SELL";
    // Mirror of BUY clamp: never set the SELL entry below the live print, or
    // the limit would sit at a worse price than market and only fill on a
    // pullback up. Clamp to currentPrice on rallies-into-zone, keep R1 on
    // approaches from below.
    entryPrice = round(Math.max(pivots.r1, currentPrice));
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
    signalReason = inSellZone
      ? `[${tfLabel}] Price is at the sell zone around pivot R1 (${fmt(pivots.r1)}). ${trend === "DOWNTREND" ? "Downtrend in force — distribution zone." : "EMA trend neutral — look for a bearish rejection candle to confirm short entry."}`
      : `[${tfLabel}] Price is within ${fmt(sellZoneLow - currentPrice)} of the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}). Stage a limit sell order near R1 ${fmt(pivots.r1)}.`;
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
      } else if (breakoutBuyOk) {
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
      } else if (breakdownSellOk) {
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
    rsi: isNaN(rsi) ? undefined : rsi,
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
  signalType?: "PIVOT_BOUNCE" | "BREAKOUT";
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

export type ClosedOutcome = "SL" | "BE_TRAIL" | "TP2" | "REVERSED" | "MISSED";

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

  // Notify the notifier of every real trade close so it can update the
  // consecutive-SL circuit-breaker streak and manage cooldowns:
  //   SL       → increment streak, enforce candle-period floor before next alert
  //   BE_TRAIL → reset streak, clear cooldown (trade barely survived; fresh entry ok)
  //   TP2      → reset streak, clear cooldown (full winner; REVERSED/MISSED excluded)
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
          v.signalType === "PIVOT_BOUNCE" || v.signalType === "BREAKOUT"
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
          v.signalType === "PIVOT_BOUNCE" || v.signalType === "BREAKOUT"
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
    // If price is already strictly past the limit at fire time, the order
    // fills immediately. Use strict inequality so that when entryPrice is
    // clamped to currentPrice (max(R1, price) for SELL / min(S1, price) for
    // BUY), equality does NOT auto-trigger — price must actually move through
    // the level after the signal appears.
    const triggered =
      fresh.signal === "BUY"
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
        p.signalType === "PIVOT_BOUNCE" || p.signalType === "BREAKOUT"
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
