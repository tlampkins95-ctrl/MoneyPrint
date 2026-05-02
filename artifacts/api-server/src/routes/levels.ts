import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLevelsResponse,
  GetLevelsQueryParams,
  GetPriceHistoryResponse,
  GetPriceHistoryQueryParams,
} from "@workspace/api-zod";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
  type CandleRaw,
} from "../lib/yahoo-fetch";
import { SYMBOLS, makeRounder, type Symbol } from "../lib/symbols";

const router: IRouter = Router();

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

async function fetchSpotPrice(symbol: Symbol): Promise<number | null> {
  const now = Date.now();
  const cached = spotCache.get(symbol);
  if (cached && now - cached.timestamp < SPOT_CACHE_TTL_MS) {
    return cached.price;
  }
  const price =
    (await fetchFromTradingView(symbol)) ?? (await fetchFromGoldApi(symbol));
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

// ─── Core signal logic ───────────────────────────────────────────────────────

function computeLevels(
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
    // If we're inside the zone, fill at market; if approaching, the trade is a limit order at the zone.
    entryPrice = inBuyZone ? round(currentPrice) : round(pivots.s1);
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(pivots.pivot);
    takeProfit2 = round(sellZoneLow);
    signalReason = inBuyZone
      ? `[${tfLabel}] Price is at the buy zone around pivot S1 (${fmt(pivots.s1)}). ${trend === "UPTREND" ? "Uptrend intact — bounce setup." : "Look for a bullish reversal candle to confirm entry."}`
      : `[${tfLabel}] Price is within ${fmt(currentPrice - buyZoneHigh)} of the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}). Stage a limit order near S1 ${fmt(pivots.s1)}.`;
  } else if (inSellZone || (approachingSell && trend !== "UPTREND")) {
    signal = "SELL";
    // If we're inside the zone, fill at market; if approaching, the trade is a limit order at the zone.
    entryPrice = inSellZone ? round(currentPrice) : round(pivots.r1);
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(pivots.pivot);
    takeProfit2 = round(buyZoneHigh);
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
      entryPrice = sellZoneLow;
      stopLoss = round(sellZoneHigh + atr * 0.5);
      takeProfit1 = round(pivots.pivot);
      takeProfit2 = buyZoneHigh;
    } else if (belowBuyZone) {
      const distBelowBuy = round(buyZoneLow - currentPrice);
      const distToS2 = round(currentPrice - pivots.s2);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) has broken below the buy zone and is ${fmt(distBelowBuy)} below support. ${distToS2 > 0 ? `Watch S2 at ${fmt(pivots.s2)} (${fmt(distToS2)} away) for the next buy opportunity.` : `Price is below S2 — wait for stabilization before entering.`}`;
      entryPrice = buyZoneHigh;
      stopLoss = round(buyZoneLow - atr * 0.5);
      takeProfit1 = round(pivots.pivot);
      takeProfit2 = sellZoneLow;
    } else {
      const distToBuy = round(currentPrice - buyZoneHigh);
      const distToSell = round(sellZoneLow - currentPrice);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) is in no-trade territory — ${fmt(distToBuy)} above the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}) and ${fmt(distToSell)} below the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}). Wait for price to reach a zone.`;
      entryPrice = trend === "UPTREND" ? buyZoneHigh : sellZoneLow;
      stopLoss = trend === "UPTREND" ? round(buyZoneLow - atr * 0.5) : round(sellZoneHigh + atr * 0.5);
      takeProfit1 = round(pivots.pivot);
      takeProfit2 = trend === "UPTREND" ? sellZoneLow : buyZoneHigh;
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

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/levels", async (req: Request, res: Response) => {
  try {
    const query = GetLevelsQueryParams.parse(req.query);
    const symbol = (query.symbol ?? "XAGUSD") as Symbol;
    const timeframe = (query.timeframe ?? "1d") as Timeframe;
    const [candles, spotPrice] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
    ]);
    if (candles.length < 2) {
      res.status(503).json({ error: "Insufficient candle data for timeframe" });
      return;
    }
    const data = GetLevelsResponse.parse(
      computeLevels(candles, spotPrice, timeframe, symbol),
    );
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to compute levels");
    res.status(500).json({ error: "Failed to compute price levels" });
  }
});

router.get("/price-history", async (req: Request, res: Response) => {
  try {
    const query = GetPriceHistoryQueryParams.parse(req.query);
    const symbol = (query.symbol ?? "XAGUSD") as Symbol;
    const timeframe = (query.timeframe ?? "1d") as Timeframe;
    const requestedBars = query.bars ?? 200;
    const bars = Math.max(1, Math.min(2000, Math.floor(requestedBars)));

    const [allCandles, spotPrice] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
    ]);
    if (allCandles.length === 0) {
      res.status(503).json({ error: "No candle data available" });
      return;
    }

    const round = makeRounder(SYMBOLS[symbol].decimals);
    const sliced = allCandles.slice(-bars);
    if (sliced.length === 0) {
      res.status(503).json({ error: "No candle data in requested window" });
      return;
    }
    const last = sliced[sliced.length - 1];
    const effectiveSpot = spotPrice ?? last.close;
    // Align Yahoo candles to OANDA spot via ratio scaling so the latest
    // close equals the OANDA price exactly and earlier bars are scaled
    // proportionally — keeps shape but matches OANDA price levels.
    const factor = last.close > 0 ? effectiveSpot / last.close : 1;
    const aligned = sliced.map((c, i) => {
      if (i === sliced.length - 1) {
        return {
          date: c.date,
          open: round(c.open * factor),
          high: round(Math.max(c.high * factor, effectiveSpot)),
          low: round(Math.min(c.low * factor, effectiveSpot)),
          close: round(effectiveSpot),
          volume: c.volume,
        };
      }
      return {
        date: c.date,
        open: round(c.open * factor),
        high: round(c.high * factor),
        low: round(c.low * factor),
        close: round(c.close * factor),
        volume: c.volume,
      };
    });

    const data = GetPriceHistoryResponse.parse({
      symbol,
      candles: aligned,
      currentPrice: round(effectiveSpot),
      lastUpdated: new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch price history");
    res.status(500).json({ error: "Failed to fetch price history" });
  }
});

export default router;
