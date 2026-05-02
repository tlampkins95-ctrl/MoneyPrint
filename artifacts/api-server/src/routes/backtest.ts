import { Router, type IRouter, type Request, type Response } from "express";
import { GetBacktestResponse, GetBacktestQueryParams } from "@workspace/api-zod";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
  type CandleRaw,
} from "../lib/yahoo-fetch";
import { SYMBOLS, makeRounder, type Symbol } from "../lib/symbols";
import { floorTarget, MIN_RR_TP1, MIN_RR_TP2 } from "../lib/signals";

const router: IRouter = Router();

interface BacktestCacheEntry {
  data: unknown;
  timestamp: number;
}
const cache = new Map<string, BacktestCacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(symbol: Symbol, timeframe: Timeframe): string {
  return `${symbol}::${timeframe}`;
}

// ─── Math ────────────────────────────────────────────────────────────────────

function calcPivots(high: number, low: number, close: number, round: (n: number) => number) {
  const pivot = (high + low + close) / 3;
  return {
    pivot: round(pivot),
    r1: round(2 * pivot - low),
    s1: round(2 * pivot - high),
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

const MAX_HOLD_BARS: Record<Timeframe, number> = {
  "15m": 24,
  "30m": 16,
  "1h": 12,
  "1d": 10,
};

// Standard EMA via the recursive (close - prev) * alpha + prev formula. Uses
// SMA seed for the first `period` bars to avoid a cold-start bias toward zero.
function calcEMASeries(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = new Array(closes.length);
  // Seed with SMA of first `period` bars (or all bars if shorter).
  const seedLen = Math.min(period, closes.length);
  let sum = 0;
  for (let i = 0; i < seedLen; i++) {
    sum += closes[i];
    out[i] = sum / (i + 1);
  }
  for (let i = seedLen; i < closes.length; i++) {
    out[i] = (closes[i] - out[i - 1]) * k + out[i - 1];
  }
  return out;
}

function runBacktest(candles: CandleRaw[], timeframe: Timeframe, symbol: Symbol): Trade[] {
  const meta = SYMBOLS[symbol];
  const round = makeRounder(meta.decimals);
  const trades: Trade[] = [];
  const maxHold = MAX_HOLD_BARS[timeframe];

  // Precompute EMA21/EMA50 series for the trend filter. Mirrors the live
  // signal logic: only allow BUY when EMA21 ≥ EMA50 (uptrend / ranging),
  // only allow SELL when EMA21 ≤ EMA50 (downtrend / ranging). Counter-trend
  // pivot bounces have the worst expectancy historically.
  const closes = candles.map((c) => c.close);
  const ema21 = calcEMASeries(closes, 21);
  const ema50 = calcEMASeries(closes, 50);
  const TREND_THRESHOLD = 0.001; // 0.1% gap counts as a real trend, smaller is "ranging"

  let i = 15;

  while (i < candles.length) {
    const prev = candles[i - 1];
    const today = candles[i];

    const { pivot, r1, s1 } = calcPivots(prev.high, prev.low, prev.close, round);
    const zoneGap = r1 - s1;
    if (zoneGap <= 0) { i++; continue; }
    const halfWidth = round(zoneGap * 0.2);
    const buyZoneLow = round(s1 - halfWidth);
    const buyZoneHigh = round(s1 + halfWidth);
    const sellZoneLow = round(r1 - halfWidth);
    const sellZoneHigh = round(r1 + halfWidth);
    const atr = calcATR(candles, i - 1, 14);

    // Trend bias from EMAs at i-1 (no lookahead). RANGING = both directions
    // allowed; UPTREND = longs only; DOWNTREND = shorts only.
    const e21 = ema21[i - 1] ?? 0;
    const e50 = ema50[i - 1] ?? 0;
    const gap = e50 > 0 ? (e21 - e50) / e50 : 0;
    const buyAllowed = gap >= -TREND_THRESHOLD;
    const sellAllowed = gap <= TREND_THRESHOLD;

    const touchesBuy = today.low <= buyZoneHigh && today.high >= buyZoneLow;
    const touchesSell = today.high >= sellZoneLow && today.low <= sellZoneHigh;

    let direction: "BUY" | "SELL" | null = null;
    if (touchesBuy && buyAllowed && touchesSell && sellAllowed) {
      direction = Math.abs(today.open - s1) < Math.abs(today.open - r1) ? "BUY" : "SELL";
    } else if (touchesBuy && buyAllowed) {
      direction = "BUY";
    } else if (touchesSell && sellAllowed) {
      direction = "SELL";
    }
    if (!direction) { i++; continue; }

    let entry: number, stopLoss: number, tp1: number, tp2: number;
    if (direction === "BUY") {
      entry = s1;
      stopLoss = round(buyZoneLow - atr * 0.5);
      tp1 = round(floorTarget(entry, stopLoss, pivot, MIN_RR_TP1, "BUY"));
      tp2 = round(floorTarget(entry, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    } else {
      entry = r1;
      stopLoss = round(sellZoneHigh + atr * 0.5);
      tp1 = round(floorTarget(entry, stopLoss, pivot, MIN_RR_TP1, "SELL"));
      tp2 = round(floorTarget(entry, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
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
    const rMultiple = Math.round((pnl / risk) * 100) / 100;

    trades.push({
      entryDate: today.date,
      direction,
      entry: round(entry),
      stopLoss: round(stopLoss),
      takeProfit1: round(tp1),
      takeProfit2: round(tp2),
      exitDate,
      exitPrice: round(exitPrice),
      outcome,
      rMultiple,
      barsHeld,
    });

    i = exitIdx + 1;
  }

  return trades;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function aggregate(trades: Trade[], candles: CandleRaw[], symbol: Symbol) {
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
    symbol,
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
    const symbol = (query.symbol ?? "XAGUSD") as Symbol;
    const timeframe = (query.timeframe ?? "1d") as Timeframe;
    const now = Date.now();
    const key = cacheKey(symbol, timeframe);
    const cached = cache.get(key);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      res.json(cached.data);
      return;
    }
    const candles = await fetchCandlesForTimeframe(symbol, timeframe);
    if (candles.length < 20) {
      res.status(503).json({ error: "Insufficient data for backtest" });
      return;
    }
    const trades = runBacktest(candles, timeframe, symbol);
    const result = GetBacktestResponse.parse(aggregate(trades, candles, symbol));
    cache.set(key, { data: result, timestamp: now });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Backtest failed");
    res.status(500).json({ error: "Backtest failed" });
  }
});

export default router;
