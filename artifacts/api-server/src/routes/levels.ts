import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLevelsResponse,
  GetPriceHistoryResponse,
  GetPriceHistoryQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CandleRaw {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

let cachedCandles: CandleRaw[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchPriceData(): Promise<CandleRaw[]> {
  const now = Date.now();
  if (cachedCandles && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCandles;
  }

  const url = "https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=2y";
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; XAGUSD-Screener/1.0)" },
  });

  if (!response.ok) throw new Error(`Yahoo Finance fetch failed: ${response.status}`);

  const json = await response.json() as {
    chart: {
      result: Array<{
        timestamp: number[];
        indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> };
      }> | null;
      error: { code: string; description: string } | null;
    };
  };

  if (!json.chart.result?.length) {
    throw new Error(`Yahoo Finance: ${json.chart.error?.description ?? "No data"}`);
  }

  const result = json.chart.result[0];
  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];

  const candles: CandleRaw[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open[i], h = quote.high[i], l = quote.low[i], c = quote.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
    candles.push({
      date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
      open: o, high: h, low: l, close: c, volume: quote.volume[i] ?? 0,
    });
  }

  cachedCandles = candles;
  cacheTimestamp = now;
  return candles;
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function round2(n: number) { return Math.round(n * 100) / 100; }

/** Classic pivot points from the previous session (last completed bar) */
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

/** Camarilla pivots — tighter intraday levels, widely used in forex */
function calcCamarilla(high: number, low: number, close: number) {
  const range = high - low;
  return {
    r1: round2(close + range * 1.1 / 12),
    r2: round2(close + range * 1.1 / 6),
    r3: round2(close + range * 1.1 / 4),
    s1: round2(close - range * 1.1 / 12),
    s2: round2(close - range * 1.1 / 6),
    s3: round2(close - range * 1.1 / 4),
  };
}

/** Fibonacci retracement from recent swing high/low */
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

/** Simple EMA for trend detection */
function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/** ATR for stop-loss sizing */
function calcATR(candles: CandleRaw[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i].close),
      Math.abs(candles[i].low - candles[i].close),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/** Find swing highs/lows over the last N bars */
function findSwingHighLow(candles: CandleRaw[], lookback = 60) {
  const slice = candles.slice(-lookback);
  const swingHigh = Math.max(...slice.map((c) => c.high));
  const swingLow = Math.min(...slice.map((c) => c.low));
  return { swingHigh, swingLow };
}

// ─── Core signal logic ───────────────────────────────────────────────────────

function computeLevels(candles: CandleRaw[]) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2]; // previous session for pivots
  const prevPrev = candles[candles.length - 3];

  const currentPrice = last.close;
  const priceChange = round2(currentPrice - prev.close);
  const priceChangePct = round2((priceChange / prev.close) * 100);

  // Pivot points from previous session
  const pivots = calcPivots(prev.high, prev.low, prev.close);
  const cam = calcCamarilla(prev.high, prev.low, prev.close);

  // Fibonacci from recent swing
  const { swingHigh, swingLow } = findSwingHighLow(candles, 60);
  const fibs = calcFibLevels(swingHigh, swingLow);

  // ATR for stop sizing
  const atr = calcATR(candles, 14);

  // Trend detection via EMA 21/50
  const closes = candles.map((c) => c.close);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const last21 = ema21[ema21.length - 1];
  const last50 = ema50[ema50.length - 1];

  // Trend slope (recent direction of EMA21)
  const ema21Recent = ema21.slice(-5).filter((v) => !isNaN(v));
  const slopeUp = ema21Recent[ema21Recent.length - 1] > ema21Recent[0];

  let trend: "UPTREND" | "DOWNTREND" | "RANGING" = "RANGING";
  let trendStrength = 50;
  if (last21 > last50 && slopeUp) {
    trend = "UPTREND";
    trendStrength = Math.min(100, Math.round(((last21 - last50) / last50) * 1000 + 50));
  } else if (last21 < last50 && !slopeUp) {
    trend = "DOWNTREND";
    trendStrength = Math.min(100, Math.round(((last50 - last21) / last50) * 1000 + 50));
  } else {
    trendStrength = 30;
  }

  // ─── BUY ZONE: around S1/S2 and Fib 61.8%
  const buyZoneLow = round2(Math.min(pivots.s2, fibs.fib618, cam.s2));
  const buyZoneHigh = round2(Math.max(pivots.s1, fibs.fib500, cam.s1));

  // ─── SELL ZONE: around R1/R2 and Fib 23.6%
  const sellZoneLow = round2(Math.min(pivots.r1, fibs.fib236, cam.r1));
  const sellZoneHigh = round2(Math.max(pivots.r2, fibs.fib236 + atr, cam.r2));

  // ─── Signal generation ─────────────────────────────────────────────────────
  // Core rule: price in or approaching buy zone → BUY; sell zone → SELL; else WAIT
  // Trend bias adjusts the threshold

  const distanceToBuyZoneTop = currentPrice - buyZoneHigh;
  const distanceToBuyZoneLow = currentPrice - buyZoneLow;
  const distanceToSellZoneLow = sellZoneLow - currentPrice;
  const distanceToSellZoneHigh = sellZoneHigh - currentPrice;

  const inBuyZone = currentPrice <= buyZoneHigh && currentPrice >= buyZoneLow;
  const approachingBuyZone = distanceToBuyZoneTop > 0 && distanceToBuyZoneTop < atr * 1.5;
  const inSellZone = currentPrice >= sellZoneLow && currentPrice <= sellZoneHigh;
  const approachingSellZone = distanceToSellZoneLow > 0 && distanceToSellZoneLow < atr * 1.5;

  let signal: "BUY" | "SELL" | "WAIT" = "WAIT";
  let signalReason = "";
  let entryPrice = currentPrice;
  let stopLoss = currentPrice;
  let takeProfit1 = currentPrice;
  let takeProfit2 = currentPrice;

  if (inBuyZone || (approachingBuyZone && trend !== "DOWNTREND")) {
    signal = "BUY";
    entryPrice = round2(currentPrice);
    stopLoss = round2(buyZoneLow - atr * 0.5);
    takeProfit1 = round2(pivots.pivot);
    takeProfit2 = round2(sellZoneLow);
    signalReason = inBuyZone
      ? `Price is inside the buy zone ($${buyZoneLow}–$${buyZoneHigh}). Key support at $${pivots.s1} (pivot S1) and $${fibs.fib618} (Fib 61.8%). ${trend === "UPTREND" ? "Uptrend intact — bounce expected." : "Watch for reversal confirmation before entering."}`
      : `Price is approaching the buy zone ($${buyZoneLow}–$${buyZoneHigh}) within 1.5× ATR. Confluence of pivot S1 ($${pivots.s1}) and Fibonacci support. Set alerts near $${buyZoneHigh}.`;
  } else if (inSellZone || (approachingSellZone && trend !== "UPTREND")) {
    signal = "SELL";
    entryPrice = round2(currentPrice);
    stopLoss = round2(sellZoneHigh + atr * 0.5);
    takeProfit1 = round2(pivots.pivot);
    takeProfit2 = round2(buyZoneHigh);
    signalReason = inSellZone
      ? `Price is inside the sell zone ($${sellZoneLow}–$${sellZoneHigh}). Key resistance at $${pivots.r1} (pivot R1) and $${fibs.fib236} (Fib 23.6%). ${trend === "DOWNTREND" ? "Downtrend in force — distribution likely." : "Watch for rejection candle before entering short."}`
      : `Price is approaching the sell zone ($${sellZoneLow}–$${sellZoneHigh}) within 1.5× ATR. Resistance cluster near $${sellZoneLow}. Set alerts near $${sellZoneLow}.`;
  } else {
    signal = "WAIT";
    const midPoint = round2((buyZoneHigh + sellZoneLow) / 2);
    const distToBuy = round2(currentPrice - buyZoneHigh);
    const distToSell = round2(sellZoneLow - currentPrice);
    signalReason = `Price ($${currentPrice}) is in no-trade territory between the buy zone ($${buyZoneLow}–$${buyZoneHigh}) and sell zone ($${sellZoneLow}–$${sellZoneHigh}). Wait for price to reach a zone — $${round2(distToBuy)} above buy zone, $${round2(distToSell)} below sell zone.`;
    // Provide guidance for where to enter if they want to plan ahead
    entryPrice = trend === "UPTREND" ? buyZoneHigh : sellZoneLow;
    stopLoss = trend === "UPTREND" ? round2(buyZoneLow - atr * 0.5) : round2(sellZoneHigh + atr * 0.5);
    takeProfit1 = trend === "UPTREND" ? round2(pivots.pivot) : round2(pivots.pivot);
    takeProfit2 = trend === "UPTREND" ? sellZoneLow : buyZoneHigh;
  }

  const riskDistance = Math.abs(entryPrice - stopLoss);
  const rewardDistance1 = Math.abs(takeProfit1 - entryPrice);
  const riskRewardRatio = riskDistance > 0 ? round2(rewardDistance1 / riskDistance) : 0;

  // ─── All key levels list ───────────────────────────────────────────────────
  type LevelType = "resistance" | "support" | "pivot";
  const levels: { label: string; price: number; type: LevelType }[] = [
    { label: "R3", price: pivots.r3, type: "resistance" },
    { label: "R2", price: pivots.r2, type: "resistance" },
    { label: "R1", price: pivots.r1, type: "resistance" },
    { label: "Pivot", price: pivots.pivot, type: "pivot" },
    { label: "S1", price: pivots.s1, type: "support" },
    { label: "S2", price: pivots.s2, type: "support" },
    { label: "S3", price: pivots.s3, type: "support" },
    { label: "Fib 23.6%", price: fibs.fib236, type: "resistance" },
    { label: "Fib 38.2%", price: fibs.fib382, type: "resistance" },
    { label: "Fib 50.0%", price: fibs.fib500, type: "pivot" },
    { label: "Fib 61.8%", price: fibs.fib618, type: "support" },
    { label: "Fib 78.6%", price: fibs.fib786, type: "support" },
    { label: "Swing High", price: fibs.swingHigh, type: "resistance" },
    { label: "Swing Low", price: fibs.swingLow, type: "support" },
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
    buyZone: { low: buyZoneLow, high: buyZoneHigh, label: "Buy Zone" },
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
    const candles = await fetchPriceData();
    const data = GetLevelsResponse.parse(computeLevels(candles));
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
    const candles = await fetchPriceData();
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
