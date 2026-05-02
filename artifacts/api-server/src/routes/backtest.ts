import { Router, type IRouter, type Request, type Response } from "express";
import { GetBacktestResponse } from "@workspace/api-zod";

const router: IRouter = Router();

interface CandleRaw {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestCache {
  data: unknown;
  timestamp: number;
}

let cache: BacktestCache | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// ─── Data fetch ──────────────────────────────────────────────────────────────

async function fetchCandles(): Promise<CandleRaw[]> {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=2y";
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; XAGUSD-Screener/1.0)" },
  });
  if (!response.ok) throw new Error(`Yahoo Finance fetch failed: ${response.status}`);
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
    throw new Error(`Yahoo Finance: ${json.chart.error?.description ?? "No data"}`);
  }
  const r = json.chart.result[0];
  const q = r.indicators.quote[0];
  const out: CandleRaw[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    out.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().split("T")[0],
      open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0,
    });
  }
  return out;
}

// ─── Math helpers (mirror /levels logic) ─────────────────────────────────────

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

// ─── Backtest engine ─────────────────────────────────────────────────────────

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

const MAX_HOLD_BARS = 10;

function runBacktest(candles: CandleRaw[]): Trade[] {
  const trades: Trade[] = [];
  // We need at least 1 prior bar to compute pivots, plus 14 for ATR
  let i = 15;

  while (i < candles.length) {
    const prev = candles[i - 1];
    const today = candles[i];

    // Pivots from prev day
    const { pivot, r1, s1 } = calcPivots(prev.high, prev.low, prev.close);
    const zoneGap = r1 - s1;
    if (zoneGap <= 0) { i++; continue; }
    const halfWidth = round2(zoneGap * 0.2);
    const buyZoneLow = round2(s1 - halfWidth);
    const buyZoneHigh = round2(s1 + halfWidth);
    const sellZoneLow = round2(r1 - halfWidth);
    const sellZoneHigh = round2(r1 + halfWidth);

    const atr = calcATR(candles, i - 1, 14);

    // Did today's range touch a zone?
    const touchesBuy = today.low <= buyZoneHigh && today.high >= buyZoneLow;
    const touchesSell = today.high >= sellZoneLow && today.low <= sellZoneHigh;

    // If both zones touched same day, prefer first hit chronologically.
    // Approximated: whichever zone is closer to the open price triggers first.
    let direction: "BUY" | "SELL" | null = null;
    if (touchesBuy && touchesSell) {
      direction = Math.abs(today.open - s1) < Math.abs(today.open - r1) ? "BUY" : "SELL";
    } else if (touchesBuy) {
      direction = "BUY";
    } else if (touchesSell) {
      direction = "SELL";
    }
    if (!direction) { i++; continue; }

    // Entry, SL, TPs (mirror /levels logic)
    let entry: number, stopLoss: number, tp1: number, tp2: number;
    if (direction === "BUY") {
      entry = s1; // pivot-line entry (mid of buy zone)
      stopLoss = round2(buyZoneLow - atr * 0.5);
      tp1 = pivot;
      tp2 = sellZoneLow;
    } else {
      entry = r1;
      stopLoss = round2(sellZoneHigh + atr * 0.5);
      tp1 = pivot;
      tp2 = sellZoneLow; // overridden below
      tp2 = buyZoneHigh;
    }
    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) { i++; continue; }

    // Walk forward to find exit
    let exitDate = today.date;
    let exitPrice = entry;
    let outcome: Trade["outcome"] = "EXPIRED";
    let barsHeld = 0;

    // Same-day execution: trade entered today; check if SL or TP hit today
    // assuming worst-case path (SL checked before TP if both could hit on same bar)
    for (let j = i; j < Math.min(candles.length, i + MAX_HOLD_BARS + 1); j++) {
      const bar = candles[j];
      barsHeld = j - i + 1;

      if (direction === "BUY") {
        const slHit = bar.low <= stopLoss;
        const tp1Hit = bar.high >= tp1;
        const tp2Hit = bar.high >= tp2;
        if (slHit && (tp1Hit || tp2Hit)) {
          // Both possible same day → conservative: SL hits first
          outcome = "SL";
          exitPrice = stopLoss;
          exitDate = bar.date;
          break;
        }
        if (slHit) { outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break; }
        if (tp2Hit) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
        if (tp1Hit) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
      } else {
        const slHit = bar.high >= stopLoss;
        const tp1Hit = bar.low <= tp1;
        const tp2Hit = bar.low <= tp2;
        if (slHit && (tp1Hit || tp2Hit)) {
          outcome = "SL";
          exitPrice = stopLoss;
          exitDate = bar.date;
          break;
        }
        if (slHit) { outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break; }
        if (tp2Hit) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
        if (tp1Hit) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
      }
    }

    if (outcome === "EXPIRED") {
      const lastBar = candles[Math.min(candles.length - 1, i + MAX_HOLD_BARS)];
      exitPrice = lastBar.close;
      exitDate = lastBar.date;
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

    // Cooldown: skip ahead past the trade's exit to avoid overlapping setups
    i = Math.max(i + 1, candles.indexOf(candles.find((c) => c.date === exitDate)!) + 1);
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

  // Drawdown
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
    trades: trades.slice(-50).reverse(), // most recent first, capped
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.get("/backtest", async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL_MS) {
      res.json(cache.data);
      return;
    }
    const candles = await fetchCandles();
    const trades = runBacktest(candles);
    const result = GetBacktestResponse.parse(aggregate(trades, candles));
    cache = { data: result, timestamp: now };
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Backtest failed");
    res.status(500).json({ error: "Backtest failed" });
  }
});

export default router;
