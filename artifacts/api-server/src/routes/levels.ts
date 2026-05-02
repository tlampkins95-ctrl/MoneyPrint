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

const router: IRouter = Router();

// ─── Live spot price (separate cache — refreshed often for real-time display) ─

let cachedSpotPrice: number | null = null;
let spotCacheTimestamp = 0;
const SPOT_CACHE_TTL_MS = 30 * 1000;

async function fetchFromTradingView(): Promise<number | null> {
  try {
    const response = await fetch(
      "https://www.tradingview.com/symbols/XAGUSD/?exchange=OANDA",
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; XAGUSD-Screener/1.0)" },
        signal: AbortSignal.timeout(4000),
      },
    );
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

async function fetchFromGoldApi(): Promise<number | null> {
  try {
    const response = await fetch("https://api.gold-api.com/price/XAG", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; XAGUSD-Screener/1.0)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { price: number };
    return typeof json.price === "number" && isFinite(json.price) ? json.price : null;
  } catch {
    return null;
  }
}

async function fetchSpotPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedSpotPrice !== null && now - spotCacheTimestamp < SPOT_CACHE_TTL_MS) {
    return cachedSpotPrice;
  }
  const price = (await fetchFromTradingView()) ?? (await fetchFromGoldApi());
  if (price !== null) {
    cachedSpotPrice = price;
    spotCacheTimestamp = now;
    return price;
  }
  return cachedSpotPrice;
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function round2(n: number) { return Math.round(n * 100) / 100; }

function calcPivots(high: number, low: number, close: number) {
  const pivot = (high + low + close) / 3;
  return {
    pivot: round2(pivot),
    r1: round2(2 * pivot - low),
    r2: round2(pivot + (high - low)),
    r3: round2(high + 2 * (pivot - low)),
    s1: round2(2 * pivot - high),
    s2: round2(pivot - (high - low)),
    s3: round2(low - 2 * (high - pivot)),
  };
}

function calcFibLevels(swingHigh: number, swingLow: number) {
  const range = swingHigh - swingLow;
  return {
    fib236: round2(swingHigh - range * 0.236),
    fib382: round2(swingHigh - range * 0.382),
    fib500: round2(swingHigh - range * 0.5),
    fib618: round2(swingHigh - range * 0.618),
    fib786: round2(swingHigh - range * 0.786),
    swingHigh: round2(swingHigh),
    swingLow: round2(swingLow),
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
  "30m": "30-minute",
  "1h": "1-hour",
  "1d": "daily",
};

// ─── Core signal logic ───────────────────────────────────────────────────────

function computeLevels(
  candles: CandleRaw[],
  spotPrice: number | null,
  timeframe: Timeframe,
) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const currentPrice = spotPrice ?? last.close;
  const priceChange = round2(currentPrice - prev.close);
  const priceChangePct = round2((priceChange / prev.close) * 100);

  const pivots = calcPivots(prev.high, prev.low, prev.close);
  const { swingHigh, swingLow } = findSwingHighLow(candles, 60);
  const fibs = calcFibLevels(swingHigh, swingLow);
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
  const halfWidth = round2(zoneGap * 0.2);
  const buyZoneLow = round2(pivots.s1 - halfWidth);
  const buyZoneHigh = round2(pivots.s1 + halfWidth);
  const sellZoneLow = round2(pivots.r1 - halfWidth);
  const sellZoneHigh = round2(pivots.r1 + halfWidth);

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
    entryPrice = round2(currentPrice);
    stopLoss = round2(buyZoneLow - atr * 0.5);
    takeProfit1 = round2(pivots.pivot);
    takeProfit2 = round2(sellZoneLow);
    signalReason = inBuyZone
      ? `[${tfLabel}] Price is at the buy zone around pivot S1 ($${pivots.s1}). ${trend === "UPTREND" ? "Uptrend intact — bounce setup." : "Look for a bullish reversal candle to confirm entry."}`
      : `[${tfLabel}] Price is within $${round2(currentPrice - buyZoneHigh)} of the buy zone ($${buyZoneLow}–$${buyZoneHigh}). Stage a limit order near S1 $${pivots.s1}.`;
  } else if (inSellZone || (approachingSell && trend !== "UPTREND")) {
    signal = "SELL";
    entryPrice = round2(currentPrice);
    stopLoss = round2(sellZoneHigh + atr * 0.5);
    takeProfit1 = round2(pivots.pivot);
    takeProfit2 = round2(buyZoneHigh);
    signalReason = inSellZone
      ? `[${tfLabel}] Price is at the sell zone around pivot R1 ($${pivots.r1}). ${trend === "DOWNTREND" ? "Downtrend in force — distribution zone." : "Look for a bearish rejection candle to confirm short entry."}`
      : `[${tfLabel}] Price is within $${round2(sellZoneLow - currentPrice)} of the sell zone ($${sellZoneLow}–$${sellZoneHigh}). Stage a limit sell order near R1 $${pivots.r1}.`;
  } else {
    signal = "WAIT";
    const aboveSellZone = currentPrice > sellZoneHigh;
    const belowBuyZone = currentPrice < buyZoneLow;

    if (aboveSellZone) {
      const distAboveSell = round2(currentPrice - sellZoneHigh);
      const distToR2 = round2(pivots.r2 - currentPrice);
      signalReason = `[${tfLabel}] Price ($${currentPrice}) has cleared the sell zone and is $${distAboveSell} above resistance. ${distToR2 > 0 ? `Watch R2 at $${pivots.r2} ($${distToR2} away) for the next sell opportunity.` : `Price is above R2 — momentum play, no clean entry zone yet.`} Wait for a pullback into a zone.`;
      entryPrice = sellZoneLow;
      stopLoss = round2(sellZoneHigh + atr * 0.5);
      takeProfit1 = round2(pivots.pivot);
      takeProfit2 = buyZoneHigh;
    } else if (belowBuyZone) {
      const distBelowBuy = round2(buyZoneLow - currentPrice);
      const distToS2 = round2(currentPrice - pivots.s2);
      signalReason = `[${tfLabel}] Price ($${currentPrice}) has broken below the buy zone and is $${distBelowBuy} below support. ${distToS2 > 0 ? `Watch S2 at $${pivots.s2} ($${distToS2} away) for the next buy opportunity.` : `Price is below S2 — wait for stabilization before entering.`}`;
      entryPrice = buyZoneHigh;
      stopLoss = round2(buyZoneLow - atr * 0.5);
      takeProfit1 = round2(pivots.pivot);
      takeProfit2 = sellZoneLow;
    } else {
      const distToBuy = round2(currentPrice - buyZoneHigh);
      const distToSell = round2(sellZoneLow - currentPrice);
      signalReason = `[${tfLabel}] Price ($${currentPrice}) is in no-trade territory — $${distToBuy} above the buy zone ($${buyZoneLow}–$${buyZoneHigh}) and $${distToSell} below the sell zone ($${sellZoneLow}–$${sellZoneHigh}). Wait for price to reach a zone.`;
      entryPrice = trend === "UPTREND" ? buyZoneHigh : sellZoneLow;
      stopLoss = trend === "UPTREND" ? round2(buyZoneLow - atr * 0.5) : round2(sellZoneHigh + atr * 0.5);
      takeProfit1 = round2(pivots.pivot);
      takeProfit2 = trend === "UPTREND" ? sellZoneLow : buyZoneHigh;
    }
  }

  const riskDist = Math.abs(entryPrice - stopLoss);
  const rewardDist = Math.abs(takeProfit1 - entryPrice);
  const riskRewardRatio = riskDist > 0 ? round2(rewardDist / riskDist) : 0;

  type LevelType = "resistance" | "support" | "pivot";
  const levels: { label: string; price: number; type: LevelType }[] = [
    { label: "R3",         price: pivots.r3,      type: "resistance" },
    { label: "R2",         price: pivots.r2,      type: "resistance" },
    { label: "R1",         price: pivots.r1,      type: "resistance" },
    { label: "Pivot",      price: pivots.pivot,   type: "pivot"      },
    { label: "S1",         price: pivots.s1,      type: "support"    },
    { label: "S2",         price: pivots.s2,      type: "support"    },
    { label: "S3",         price: pivots.s3,      type: "support"    },
    { label: "Fib 23.6%",  price: fibs.fib236,    type: "resistance" },
    { label: "Fib 38.2%",  price: fibs.fib382,    type: "resistance" },
    { label: "Fib 50.0%",  price: fibs.fib500,    type: "pivot"      },
    { label: "Fib 61.8%",  price: fibs.fib618,    type: "support"    },
    { label: "Fib 78.6%",  price: fibs.fib786,    type: "support"    },
    { label: "Swing High", price: fibs.swingHigh, type: "resistance" },
    { label: "Swing Low",  price: fibs.swingLow,  type: "support"    },
  ]
    .filter((l) => l.price > 0)
    .sort((a, b) => b.price - a.price);

  return {
    symbol: "XAGUSD",
    currentPrice: round2(currentPrice),
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
    const timeframe = (query.timeframe ?? "1d") as Timeframe;
    const [candles, spotPrice] = await Promise.all([
      fetchCandlesForTimeframe(timeframe),
      fetchSpotPrice(),
    ]);
    if (candles.length < 2) {
      res.status(503).json({ error: "Insufficient candle data for timeframe" });
      return;
    }
    const data = GetLevelsResponse.parse(computeLevels(candles, spotPrice, timeframe));
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to compute levels");
    res.status(500).json({ error: "Failed to compute price levels" });
  }
});

router.get("/price-history", async (req: Request, res: Response) => {
  try {
    const query = GetPriceHistoryQueryParams.parse(req.query);
    const bars = query.bars ?? 60;
    const candles = await fetchCandlesForTimeframe("1d");
    const data = GetPriceHistoryResponse.parse({
      symbol: "XAGUSD",
      candles: candles.slice(-bars),
      lastUpdated: new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch price history");
    res.status(500).json({ error: "Failed to fetch price history" });
  }
});

export default router;
