import { SYMBOLS, makeRounder, type Symbol } from "./symbols";
import { type CandleRaw, type Timeframe } from "./yahoo-fetch";
import { fetchOkxPerpPrice } from "./crypto-perp-fetch";

// ─── Live spot price (per-symbol cache) ──────────────────────────────────────

interface SpotCacheEntry {
  price: number;
  timestamp: number;
}
const spotCache = new Map<Symbol, SpotCacheEntry>();
const SPOT_CACHE_TTL_MS = 30 * 1000;

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

async function fetchFromOkxPerp(symbol: Symbol): Promise<number | null> {
  const perp = SYMBOLS[symbol].okxPerp;
  if (!perp) return null;
  return fetchOkxPerpPrice(perp);
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
  // For crypto perps prefer OKX (matches the perp candles we chart),
  // then Coinbase spot, then TV scrape, then GoldAPI for metals.
  const price =
    (await fetchFromOkxPerp(symbol)) ??
    (await fetchFromCoinbase(symbol)) ??
    (await fetchFromTradingView(symbol)) ??
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

function findSwingHighLow(candles: CandleRaw[], lookback = 60) {
  const slice = candles.slice(-lookback);
  return {
    swingHigh: Math.max(...slice.map((c) => c.high)),
    swingLow: Math.min(...slice.map((c) => c.low)),
  };
}

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "1m": "1-minute",
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
  symbol: Symbol,
) {
  const meta = SYMBOLS[symbol];
  const round = makeRounder(meta.decimals);
  const fmt = (n: number) => `${meta.prefix}${round(n).toFixed(meta.decimals)}`;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const currentPrice = spotPrice ?? last.close;
  const priceChange = round(currentPrice - prev.close);
  const priceChangePct = Math.round((priceChange / prev.close) * 10000) / 100;

  const pivots = calcPivots(prev.high, prev.low, prev.close, round);
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

  let trend: "UPTREND" | "DOWNTREND" | "RANGING" = "RANGING";
  let trendStrength = 30;
  if (last21 > last50 && slopeUp) {
    trend = "UPTREND";
    trendStrength = Math.min(100, Math.round(((last21 - last50) / last50) * 1000 + 50));
  } else if (last21 < last50 && !slopeUp) {
    trend = "DOWNTREND";
    trendStrength = Math.min(100, Math.round(((last50 - last21) / last50) * 1000 + 50));
  }

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
  let signalReason = "";
  let entryPrice = currentPrice;
  let stopLoss = currentPrice;
  let takeProfit1 = currentPrice;
  let takeProfit2 = currentPrice;

  const tfLabel = TIMEFRAME_LABELS[timeframe];

  if (inBuyZone || (approachingBuy && trend !== "DOWNTREND")) {
    signal = "BUY";
    // Anchor entry to the planned limit price at S1 — the trader stages an
    // order there regardless of where price drifted within the zone, so the
    // R/R math is deterministic instead of jittering with the live print.
    entryPrice = round(pivots.s1);
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    signalReason = inBuyZone
      ? `[${tfLabel}] Price is at the buy zone around pivot S1 (${fmt(pivots.s1)}). ${trend === "UPTREND" ? "Uptrend intact — bounce setup." : "Look for a bullish reversal candle to confirm entry."}`
      : `[${tfLabel}] Price is within ${fmt(currentPrice - buyZoneHigh)} of the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}). Stage a limit order near S1 ${fmt(pivots.s1)}.`;
  } else if (inSellZone || (approachingSell && trend !== "UPTREND")) {
    signal = "SELL";
    entryPrice = round(pivots.r1);
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
    signalReason = inSellZone
      ? `[${tfLabel}] Price is at the sell zone around pivot R1 (${fmt(pivots.r1)}). ${trend === "DOWNTREND" ? "Downtrend in force — distribution zone." : "Look for a bearish rejection candle to confirm short entry."}`
      : `[${tfLabel}] Price is within ${fmt(sellZoneLow - currentPrice)} of the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}). Stage a limit sell order near R1 ${fmt(pivots.r1)}.`;
  } else {
    signal = "WAIT";
    const aboveSellZone = currentPrice > sellZoneHigh;
    const belowBuyZone = currentPrice < buyZoneLow;

    if (aboveSellZone) {
      const distAboveSell = round(currentPrice - sellZoneHigh);
      const distToR2 = round(pivots.r2 - currentPrice);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) has cleared the sell zone and is ${fmt(distAboveSell)} above resistance. ${distToR2 > 0 ? `Watch R2 at ${fmt(pivots.r2)} (${fmt(distToR2)} away) for the next sell opportunity.` : `Price is above R2 — momentum play, no clean entry zone yet.`} Wait for a pullback into a zone.`;
      entryPrice = round(pivots.r1);
      stopLoss = round(sellZoneHigh + atr * 0.5);
      takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
      takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
    } else if (belowBuyZone) {
      const distBelowBuy = round(buyZoneLow - currentPrice);
      const distToS2 = round(currentPrice - pivots.s2);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) has broken below the buy zone and is ${fmt(distBelowBuy)} below support. ${distToS2 > 0 ? `Watch S2 at ${fmt(pivots.s2)} (${fmt(distToS2)} away) for the next buy opportunity.` : `Price is below S2 — wait for stabilization before entering.`}`;
      entryPrice = round(pivots.s1);
      stopLoss = round(buyZoneLow - atr * 0.5);
      takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
      takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    } else {
      const distToBuy = round(currentPrice - buyZoneHigh);
      const distToSell = round(sellZoneLow - currentPrice);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) is in no-trade territory — ${fmt(distToBuy)} above the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}) and ${fmt(distToSell)} below the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}). Wait for price to reach a zone.`;
      const dir: "BUY" | "SELL" = trend === "UPTREND" ? "BUY" : "SELL";
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

  return {
    symbol,
    currentPrice: round(currentPrice),
    priceChange,
    priceChangePct,
    signal,
    signalReason,
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
    lastUpdated: new Date().toISOString(),
  };
}
