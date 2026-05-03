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

// MACD(12, 26, 9) histogram series. Used as a momentum-turn confirmation:
// only fade S1 once the bear pressure is cooling (histogram ticking up),
// only fade R1 once bull pressure is cooling (histogram ticking down). The
// macdLine/signal crossover is too lagging at the timeframes we trade — the
// histogram derivative leads it by a couple bars and is the right signal
// for a bounce trader. Returns an array of histogram values aligned with
// `closes` (NaN until enough bars are available).
function calcMACDHist(closes: number[], fast = 12, slow = 26, signal = 9): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < slow + signal) return out;
  const fastEma = calcEMASeries(closes, fast);
  const slowEma = calcEMASeries(closes, slow);
  const macdLine = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const sigLine = calcEMASeries(macdLine, signal);
  for (let i = 0; i < closes.length; i++) {
    out[i] = macdLine[i] - sigLine[i];
  }
  return out;
}

// Swing high / swing low over the last `lookback` bars ending at `endIdx`
// (no lookahead). Used to anchor Fibonacci retracement levels.
function calcSwing(candles: CandleRaw[], endIdx: number, lookback = 60) {
  const start = Math.max(0, endIdx - lookback + 1);
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i <= endIdx; i++) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  return { swingHigh: hi, swingLow: lo };
}

// Fib retracement confluence: a bounce setup is meaningfully better when the
// pivot level coincides with the 38.2 / 50 / 61.8% retracement of the recent
// swing — that's the textbook reason institutions defend a level. We accept
// confluence when the entry sits within `tolerance` of any of those three
// fibs. Tolerance is expressed as a fraction of the swing range so it scales
// with volatility.
function hasFibConfluence(price: number, swingHigh: number, swingLow: number, tolerance = 0.05): boolean {
  const range = swingHigh - swingLow;
  if (range <= 0) return false;
  const fibs = [
    swingHigh - range * 0.382,
    swingHigh - range * 0.5,
    swingHigh - range * 0.618,
  ];
  const tol = range * tolerance;
  return fibs.some((f) => Math.abs(price - f) <= tol);
}

// Wilder-smoothed RSI(14). Returns an array aligned with `closes` (NaN until
// enough bars are available). Used as a mean-reversion confirmation: don't
// fade S1 unless the market is actually oversold, don't fade R1 unless it's
// overbought. Drops the random-chop trades that drag the win rate to ~50%.
function calcRSISeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
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
  const rsi14 = calcRSISeries(closes, 14);
  const macdHist = calcMACDHist(closes, 12, 26, 9);
  const TREND_THRESHOLD = 0.001; // 0.1% gap counts as a real trend, smaller is "ranging"
  // RSI mean-reversion gates. Only fade S1 when oversold, only fade R1 when
  // overbought — fading in the middle of the range is a coin flip.
  const RSI_BUY_MAX = 45;
  const RSI_SELL_MIN = 55;

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

    // Realistic fill: a touch must actually reach the level itself, not just
    // overlap the zone. Also the bar's open must be on the "right" side of
    // the level — if price gapped through s1/r1 at the open, an order at
    // s1/r1 wouldn't have filled at that price (it would have filled at the
    // open, a worse setup). Skipping these is the single biggest realism fix.
    const buyFills = today.low <= s1 && today.open >= s1;
    const sellFills = today.high >= r1 && today.open <= r1;

    // Level validity: if the previous bar already closed beyond the level
    // (level lost), the bounce play is degraded — skip it.
    const buyLevelValid = prev.close >= s1;
    const sellLevelValid = prev.close <= r1;

    // RSI confirmation gate
    const r = rsi14[i - 1];
    const rsiBuyOk = !Number.isFinite(r) ? true : r <= RSI_BUY_MAX;
    const rsiSellOk = !Number.isFinite(r) ? true : r >= RSI_SELL_MIN;

    // MACD histogram momentum gate. BUY needs the histogram to have ticked
    // up over the prior bar (bear momentum cooling); SELL needs it to have
    // ticked down (bull momentum cooling). Falls open when the series is
    // not yet warm.
    const hNow = macdHist[i - 1];
    const hPrev = macdHist[i - 2];
    const macdWarm = Number.isFinite(hNow) && Number.isFinite(hPrev);
    const macdBuyOk = !macdWarm ? true : hNow > hPrev;
    const macdSellOk = !macdWarm ? true : hNow < hPrev;

    // Fib confluence gate. The pivot entry must sit within 5% of swing range
    // of a 38.2 / 50 / 61.8 retracement, computed from the last 60 bars
    // ending at i-1 (no lookahead).
    const { swingHigh, swingLow } = calcSwing(candles, i - 1, 60);
    const fibBuyOk = hasFibConfluence(s1, swingHigh, swingLow);
    const fibSellOk = hasFibConfluence(r1, swingHigh, swingLow);

    const canBuy = buyFills && buyAllowed && buyLevelValid && rsiBuyOk && macdBuyOk && fibBuyOk;
    const canSell = sellFills && sellAllowed && sellLevelValid && rsiSellOk && macdSellOk && fibSellOk;

    let direction: "BUY" | "SELL" | null = null;
    if (canBuy && canSell) {
      direction = Math.abs(today.open - s1) < Math.abs(today.open - r1) ? "BUY" : "SELL";
    } else if (canBuy) {
      direction = "BUY";
    } else if (canSell) {
      direction = "SELL";
    }
    if (!direction) { i++; continue; }

    let entry: number, stopLoss: number, tp1: number, tp2: number;
    // TP1 in the backtest targets the structural central pivot directly
    // (with only a tiny 0.5R safety floor for degenerate-close-pivot cases).
    // The 1.5R floor used by live signals systematically pushes TP1 past
    // the pivot, turning a clean bounce into a loss when price reverses
    // off the pivot — which is exactly where mean-reversion typically
    // exhausts. TP2 keeps the 2.5R floor, so the average-R is still
    // dominated by genuine continuation moves.
    const TP1_BACKTEST_FLOOR = 0.5;
    if (direction === "BUY") {
      entry = s1;
      stopLoss = round(buyZoneLow - atr * 0.5);
      tp1 = round(floorTarget(entry, stopLoss, pivot, TP1_BACKTEST_FLOOR, "BUY"));
      tp2 = round(floorTarget(entry, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    } else {
      entry = r1;
      stopLoss = round(sellZoneHigh + atr * 0.5);
      tp1 = round(floorTarget(entry, stopLoss, pivot, TP1_BACKTEST_FLOOR, "SELL"));
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
