import { Router, type IRouter, type Request, type Response } from "express";
import { GetBacktestResponse, GetBacktestQueryParams } from "@workspace/api-zod";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
  type CandleRaw,
} from "../lib/yahoo-fetch";

const router: IRouter = Router();

interface BacktestCacheEntry {
  data: unknown;
  timestamp: number;
}
const cache = new Map<Timeframe, BacktestCacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

// ─── Math ────────────────────────────────────────────────────────────────────

function round2(n: number) { return Math.round(n * 100) / 100; }

function calcPivots(high: number, low: number, close: number) {
  const pivot = (high + low + close) / 3;
  return {
    pivot: round2(pivot),
    r1: round2(2 * pivot - low),
    s1: round2(2 * pivot - high),
  };
}

function calcATR(candles: CandleRaw[], endIdx: number, period = 14): number {
  if (endIdx < period) return 0;
  const trs: number[] = [];
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    if (i <= 0) continue;
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

interface Trade {
  entryDate: string;
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  exitDate: string;
  exitPrice: number;
  outcome: "TP1" | "TP2" | "SL" | "EXPIRED";
  rMultiple: number;
  barsHeld: number;
}

// Allow longer hold for shorter timeframes (more bars per "day")
const MAX_HOLD_BARS: Record<Timeframe, number> = {
  "1m": 60,
  "30m": 16,
  "1h": 12,
  "1d": 10,
};

function runBacktest(candles: CandleRaw[], timeframe: Timeframe): Trade[] {
  const trades: Trade[] = [];
  const maxHold = MAX_HOLD_BARS[timeframe];
  let i = 15;

  while (i < candles.length) {
    const prev = candles[i - 1];
    const today = candles[i];

    const { pivot, r1, s1 } = calcPivots(prev.high, prev.low, prev.close);
    const zoneGap = r1 - s1;
    if (zoneGap <= 0) { i++; continue; }
    const halfWidth = round2(zoneGap * 0.2);
    const buyZoneLow = round2(s1 - halfWidth);
    const buyZoneHigh = round2(s1 + halfWidth);
    const sellZoneLow = round2(r1 - halfWidth);
    const sellZoneHigh = round2(r1 + halfWidth);
    const atr = calcATR(candles, i - 1, 14);

    const touchesBuy = today.low <= buyZoneHigh && today.high >= buyZoneLow;
    const touchesSell = today.high >= sellZoneLow && today.low <= sellZoneHigh;

    let direction: "BUY" | "SELL" | null = null;
    if (touchesBuy && touchesSell) {
      direction = Math.abs(today.open - s1) < Math.abs(today.open - r1) ? "BUY" : "SELL";
    } else if (touchesBuy) {
      direction = "BUY";
    } else if (touchesSell) {
      direction = "SELL";
    }
    if (!direction) { i++; continue; }

    let entry: number, stopLoss: number, tp1: number, tp2: number;
    if (direction === "BUY") {
      entry = s1;
      stopLoss = round2(buyZoneLow - atr * 0.5);
      tp1 = pivot;
      tp2 = sellZoneLow;
    } else {
      entry = r1;
      stopLoss = round2(sellZoneHigh + atr * 0.5);
      tp1 = pivot;
      tp2 = buyZoneHigh;
    }
    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) { i++; continue; }

    let exitDate = today.date;
    let exitPrice = entry;
    let outcome: Trade["outcome"] = "EXPIRED";
    let barsHeld = 0;
    let exitIdx = i;

    for (let j = i; j < Math.min(candles.length, i + maxHold + 1); j++) {
      const bar = candles[j];
      barsHeld = j - i + 1;
      exitIdx = j;
      if (direction === "BUY") {
        const slHit = bar.low <= stopLoss;
        const tp1Hit = bar.high >= tp1;
        const tp2Hit = bar.high >= tp2;
        if (slHit && (tp1Hit || tp2Hit)) {
          outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break;
        }
        if (slHit) { outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break; }
        if (tp2Hit) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
        if (tp1Hit) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
      } else {
        const slHit = bar.high >= stopLoss;
        const tp1Hit = bar.low <= tp1;
        const tp2Hit = bar.low <= tp2;
        if (slHit && (tp1Hit || tp2Hit)) {
          outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break;
        }
        if (slHit) { outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break; }
        if (tp2Hit) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
        if (tp1Hit) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
      }
    }

    if (outcome === "EXPIRED") {
      const lastBar = candles[Math.min(candles.length - 1, i + maxHold)];
      exitPrice = lastBar.close;
      exitDate = lastBar.date;
      exitIdx = Math.min(candles.length - 1, i + maxHold);
    }

    const pnl = direction === "BUY" ? exitPrice - entry : entry - exitPrice;
    const rMultiple = round2(pnl / risk);

    trades.push({
      entryDate: today.date,
      direction,
      entry: round2(entry),
      stopLoss: round2(stopLoss),
      takeProfit1: round2(tp1),
      takeProfit2: round2(tp2),
      exitDate,
      exitPrice: round2(exitPrice),
      outcome,
      rMultiple,
      barsHeld,
    });

    i = exitIdx + 1;
  }

  return trades;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregate(trades: Trade[], candles: CandleRaw[]) {
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0));
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);

  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.rMultiple;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const buys = trades.filter((t) => t.direction === "BUY");
  const sells = trades.filter((t) => t.direction === "SELL");

  return {
    symbol: "XAGUSD",
    startDate: candles[0]?.date ?? "",
    endDate: candles[candles.length - 1]?.date ?? "",
    totalBars: candles.length,
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: trades.length ? round2((wins.length / trades.length) * 100) : 0,
    totalReturnR: round2(totalR),
    avgReturnR: trades.length ? round2(totalR / trades.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? 999 : 0,
    maxDrawdownR: round2(maxDD),
    avgBarsHeld: trades.length
      ? round2(trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length)
      : 0,
    buyTrades: buys.length,
    sellTrades: sells.length,
    buyWinRate: buys.length
      ? round2((buys.filter((t) => t.rMultiple > 0).length / buys.length) * 100)
      : 0,
    sellWinRate: sells.length
      ? round2((sells.filter((t) => t.rMultiple > 0).length / sells.length) * 100)
      : 0,
    tp1Hits: trades.filter((t) => t.outcome === "TP1").length,
    tp2Hits: trades.filter((t) => t.outcome === "TP2").length,
    slHits: trades.filter((t) => t.outcome === "SL").length,
    expiredHits: trades.filter((t) => t.outcome === "EXPIRED").length,
    trades: trades.slice(-50).reverse(),
    lastUpdated: new Date().toISOString(),
  };
}

router.get("/backtest", async (req: Request, res: Response) => {
  try {
    const query = GetBacktestQueryParams.parse(req.query);
    const timeframe = (query.timeframe ?? "1d") as Timeframe;
    const now = Date.now();
    const cached = cache.get(timeframe);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      res.json(cached.data);
      return;
    }
    const candles = await fetchCandlesForTimeframe(timeframe);
    if (candles.length < 20) {
      res.status(503).json({ error: "Insufficient data for backtest" });
      return;
    }
    const trades = runBacktest(candles, timeframe);
    const result = GetBacktestResponse.parse(aggregate(trades, candles));
    cache.set(timeframe, { data: result, timestamp: now });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Backtest failed");
    res.status(500).json({ error: "Backtest failed" });
  }
});

export default router;
