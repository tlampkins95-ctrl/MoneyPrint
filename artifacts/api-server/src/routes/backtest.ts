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

function cacheKey(symbol: Symbol, timeframe: Timeframe, signalType: string): string {
  return `${symbol}::${timeframe}::${signalType}`;
}

// ─── Math ────────────────────────────────────────────────────────────────────

function calcPivots(high: number, low: number, close: number, round: (n: number) => number) {
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const s1 = 2 * pivot - high;
  const r2 = pivot + (high - low);
  const s2 = pivot - (high - low);
  const r3 = high + 2 * (pivot - low);
  const s3 = low - 2 * (high - pivot);
  return {
    pivot: round(pivot),
    r1: round(r1),
    s1: round(s1),
    r2: round(r2),
    s2: round(s2),
    r3: round(r3),
    s3: round(s3),
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
  "4h": 10,
  "1d": 10,
};

// FIB_BOUNCE targets the swing high — a multi-bar swing trade, not a scalp.
// 3× the pivot hold window gives price enough time to retrace back to the top.
const FIB_MAX_HOLD_BARS: Record<Timeframe, number> = {
  "15m": 72,   // 18 hours
  "30m": 48,   // 24 hours
  "1h":  36,   // 36 hours
  "4h":  24,   // 4 days
  "1d":  20,   // 20 days
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

function runBreakoutBacktest(candles: CandleRaw[], timeframe: Timeframe, symbol: Symbol): Trade[] {
  const meta = SYMBOLS[symbol];
  const longOnly = !!meta.longOnly;
  const round = makeRounder(meta.decimals);
  const trades: Trade[] = [];
  const maxHold = MAX_HOLD_BARS[timeframe];

  const closes = candles.map((c) => c.close);
  const ema200 = calcEMASeries(closes, 200);
  const ema21  = calcEMASeries(closes, 21);
  const ema50  = calcEMASeries(closes, 50);
  const rsi14  = calcRSISeries(closes, 14);
  const macdHist = calcMACDHist(closes, 12, 26, 9);

  // Synced with live BREAKOUT signal thresholds.
  const RSI_BUY_MIN = 55;
  const RSI_BUY_MAX = 78;
  const RSI_SELL_MIN = 22;
  const RSI_SELL_MAX = 45;

  let i = 50;

  while (i < candles.length) {
    const prev = candles[i - 1];
    const today = candles[i];

    const { r2, r3, s2, s3 } = calcPivots(prev.high, prev.low, prev.close, round);
    const atr = calcATR(candles, i - 1, 14);
    if (atr <= 0) { i++; continue; }

    const e200 = ema200[i - 1];
    const e21  = ema21[i - 1];
    const e50  = ema50[i - 1];
    const ema200Warm = i - 1 >= 200 && Number.isFinite(e200) && e200 > 0;
    const ema5050Warm = i - 1 >= 50 && Number.isFinite(e21) && Number.isFinite(e50);
    const useEma200 = ema200Warm && timeframe !== "1d";

    // Trend direction gates (EMA21 vs EMA50) — required for BREAKOUT mode.
    const trendBullish = !ema5050Warm || e21 > e50;
    const trendBearish = !ema5050Warm || e21 < e50;

    // EMA200 regime: above = bull bias (buys allowed), below = bear bias.
    const buyAllowed  = !useEma200 || prev.close > e200;
    const sellAllowed = !useEma200 || prev.close < e200;

    const rsiVal  = rsi14[i - 1];
    const rsiWarm = Number.isFinite(rsiVal);
    const rsiBuyOk  = !rsiWarm || (rsiVal >= RSI_BUY_MIN && rsiVal <= RSI_BUY_MAX);
    const rsiSellOk = !rsiWarm || (rsiVal >= RSI_SELL_MIN && rsiVal <= RSI_SELL_MAX);

    const hNow  = macdHist[i - 1];
    const hPrev1 = macdHist[i - 2];
    const hPrev2 = macdHist[i - 3];
    const macdWarm = Number.isFinite(hNow) && Number.isFinite(hPrev1) && Number.isFinite(hPrev2);
    // BUY: histogram positive and rising (momentum accelerating up).
    const macdBuyOk  = !macdWarm || (hNow > 0 && hNow > hPrev1);
    // SELL: histogram negative and falling.
    const macdSellOk = !macdWarm || (hNow < 0 && hNow < hPrev1);

    // Breakout trigger: today's bar must CLOSE above R2, AND the close must
    // meet two additional quality requirements:
    //
    //  1. Candle-close quality: close in top 40% of bar range (raised from 50%).
    //     A bar that wicks above R2 then closes below 60% of its range is a
    //     rejection candle, not a breakout. Requiring the close in the top 40%
    //     (not just above the midpoint) filters wick-heavy entries that fail
    //     at a higher rate — empirically, winning breakouts avg 72% body vs
    //     59% for losers across the ETHUSD 1h sample.
    //     Mirrors live signal breakoutBarBuyFloor / breakoutBarSellCeil.
    //
    //  2. Minimum magnitude: close > r2 + 0.25×ATR.
    //     A close that barely scratches R2 by a tick offers no room before
    //     SL is threatened. Requiring 0.25×ATR of clearance filters the
    //     lowest-quality marginal entries that fail at a much higher rate.
    //
    // Entry: today's close (market-on-close). Exit loop starts on the NEXT bar.
    const breakoutCloseStrong  = today.close > today.low  + 0.6 * (today.high - today.low);
    const breakdownCloseStrong = today.close < today.high - 0.6 * (today.high - today.low);
    const breakoutTriggered  = today.close > r2 + 0.25 * atr && breakoutCloseStrong;
    const breakoutEntry      = today.close;
    // Breakdown trigger: today's bar must CLOSE below S2 with the same
    // quality gates (strong close in lower half, ≥0.25×ATR below S2).
    const breakdownTriggered = today.close < s2 - 0.25 * atr && breakdownCloseStrong;
    const breakdownEntry     = today.close;

    // Price vs EMA21 — mirrors live signal's `last.close > last21` gate.
    // Falls open when EMA21 isn't yet warm (same ema5050Warm guard as trendBullish).
    const priceAboveEma21 = !ema5050Warm || today.close > e21;
    const priceBelowEma21 = !ema5050Warm || today.close < e21;

    // Extension filter: suppress entries when price is already >5×ATR from EMA50.
    // Mirrors live signal notOverExtendedBuy/Sell. Falls open when EMA50 not warm.
    const notOverExtendedBuy  = !ema5050Warm || (today.close - e50) < 5 * atr;
    const notOverExtendedSell = !ema5050Warm || (e50 - today.close) < 5 * atr;

    const canBuy  = breakoutTriggered  && buyAllowed  && trendBullish && priceAboveEma21 && rsiBuyOk  && macdBuyOk  && notOverExtendedBuy;
    const canSell = !longOnly && breakdownTriggered && sellAllowed && trendBearish && priceBelowEma21 && rsiSellOk && macdSellOk && notOverExtendedSell;

    let direction: "BUY" | "SELL" | null = null;
    if (canBuy && !canSell) direction = "BUY";
    else if (canSell && !canBuy) direction = "SELL";
    if (!direction) { i++; continue; }

    // Entry is the close of the signal bar. Skip if next bar unavailable.
    if (i + 1 >= candles.length) { i++; continue; }
    const entry = direction === "BUY" ? breakoutEntry : breakdownEntry;

    // SL: one full ATR from entry (matches live signal sizing).
    // TP1: the structural next level (R3 for buys, S3 for sells).
    let stopLoss: number, tp1: number, tp2: number;
    if (direction === "BUY") {
      stopLoss = round(entry - atr);
      tp1 = r3;
      tp2 = round(r3 + atr);
    } else {
      stopLoss = round(entry + atr);
      tp1 = s3;
      tp2 = round(s3 - atr);
    }
    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) { i++; continue; }

    let exitDate = today.date;
    let exitPrice = entry;
    let outcome: Trade["outcome"] = "EXPIRED";
    let barsHeld = 0;
    let exitIdx = i;

    // Start exit loop on the next bar — we entered at today's close.
    for (let j = i + 1; j < Math.min(candles.length, i + maxHold + 1); j++) {
      const bar = candles[j];
      barsHeld = j - i + 1;
      exitIdx = j;
      if (direction === "BUY") {
        const slHit  = bar.low  <= stopLoss;
        const tp1Hit = bar.high >= tp1;
        const tp2Hit = bar.high >= tp2;
        if (slHit && (tp1Hit || tp2Hit)) { outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break; }
        if (slHit)  { outcome = "SL";  exitPrice = stopLoss; exitDate = bar.date; break; }
        if (tp2Hit) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
        if (tp1Hit) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
      } else {
        const slHit  = bar.high >= stopLoss;
        const tp1Hit = bar.low  <= tp1;
        const tp2Hit = bar.low  <= tp2;
        if (slHit && (tp1Hit || tp2Hit)) { outcome = "SL"; exitPrice = stopLoss; exitDate = bar.date; break; }
        if (slHit)  { outcome = "SL";  exitPrice = stopLoss; exitDate = bar.date; break; }
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

// ─── Fib impulse swing detection (mirrors signals.ts) ────────────────────────
// Finds the most recent valid structural impulse for golden-pocket fib drawing.
// Mirrors the five-gate logic in signals.ts findImpulseSwing exactly.
const FIB_MIN_SH_BARS_AGO = 3;    // swing high must be ≥ this many bars old
const FIB_MIN_RETRACE_PCT = 0.10; // price must have retraced ≥10% of impulse below SH
const FIB_MIN_IMPULSE_ATR = 3.0;  // impulse range must be ≥ 3×ATR

function findImpulseSwing(
  candles: CandleRaw[],
  endIdx: number,
  lookback = 100,
): { swingHigh: number; swingLow: number } | null {
  const start = Math.max(0, endIdx - lookback + 1);
  const slice = candles.slice(start, endIdx + 1);
  if (slice.length < 10) return null;

  const atr = calcATR(candles, endIdx, 14);
  if (atr <= 0) return null;

  const currentClose = candles[endIdx].close;

  // Swing high must be at least FIB_MIN_SH_BARS_AGO from endIdx.
  const shSearchEnd = slice.length - FIB_MIN_SH_BARS_AGO;
  if (shSearchEnd <= 0) return null;
  let shIdx = 0;
  for (let i = 1; i < shSearchEnd; i++) {
    if (slice[i].high > slice[shIdx].high) shIdx = i;
  }
  const swingHigh = slice[shIdx].high;

  // Gate: no new high set after the swing high bar.
  for (let i = shIdx + 1; i < slice.length; i++) {
    if (slice[i].high > swingHigh) return null;
  }

  // Find the lowest low BEFORE the swing high.
  if (shIdx === 0) return null;
  let slIdx = 0;
  for (let i = 1; i < shIdx; i++) {
    if (slice[i].low < slice[slIdx].low) slIdx = i;
  }
  const swingLow = slice[slIdx].low;
  if (swingHigh <= swingLow) return null;

  const impulseRange = swingHigh - swingLow;

  // Gate: impulse must be genuinely impulsive (≥ FIB_MIN_IMPULSE_ATR × ATR).
  if (impulseRange < FIB_MIN_IMPULSE_ATR * atr) return null;

  // Gate: price must have retraced ≥ FIB_MIN_RETRACE_PCT below swing high.
  if (currentClose > swingHigh - impulseRange * FIB_MIN_RETRACE_PCT) return null;

  return { swingHigh, swingLow };
}

function runFibBacktest(candles: CandleRaw[], timeframe: Timeframe, symbol: Symbol): Trade[] {
  const meta = SYMBOLS[symbol];
  const round = makeRounder(meta.decimals);
  const trades: Trade[] = [];
  const maxHold = FIB_MAX_HOLD_BARS[timeframe];

  const closes = candles.map((c) => c.close);
  const ema200 = calcEMASeries(closes, 200);
  const rsi14  = calcRSISeries(closes, 14);
  const macdHist = calcMACDHist(closes, 12, 26, 9);

  const RSI_BUY_MAX = 50;
  // After any FIB_BOUNCE exit (SL or EXPIRED), wait this many bars before
  // re-entering. Prevents whipsawing back into the same static pocket.
  const FIB_COOLDOWN_BARS = Math.ceil(maxHold / 2);
  let cooldownUntil = 0;

  let i = 50;

  while (i < candles.length) {
    if (i < cooldownUntil) { i++; continue; }
    const prev = candles[i - 1];
    const today = candles[i];
    const atr = calcATR(candles, i - 1, 14);
    if (atr <= 0) { i++; continue; }

    // Find the structural impulse swing anchored to history up to prev bar.
    const impulse = findImpulseSwing(candles, i - 1, 100);
    if (!impulse) { i++; continue; }

    const { swingHigh, swingLow } = impulse;
    // Golden pocket: 61.8%–65% retracement of the impulse.
    const range = swingHigh - swingLow;
    const fib618 = round(swingHigh - range * 0.618);
    const fib65  = round(swingHigh - range * 0.65);
    const gpLow  = Math.min(fib618, fib65);
    const gpHigh = Math.max(fib618, fib65);

    // Zone must be meaningful AND swing high must be above current price
    // (we're in a retracement, not still at/above the top).
    if ((gpHigh - gpLow) < atr * 0.1) { i++; continue; }
    if (swingHigh <= today.close) { i++; continue; }

    // EMA200 regime gate — bull regime only for fib buys.
    const e200 = ema200[i - 1];
    const ema200Warm = i - 1 >= 200 && Number.isFinite(e200) && e200 > 0;
    const useEma200 = ema200Warm && timeframe !== "1d";
    const buyAllowed = !useEma200 || prev.close >= e200;
    if (!buyAllowed) { i++; continue; }

    // RSI gate.
    const rsiVal = rsi14[i - 1];
    const rsiBuyOk = !Number.isFinite(rsiVal) || rsiVal <= RSI_BUY_MAX;
    if (!rsiBuyOk) { i++; continue; }

    // MACD histogram ticking up (bear momentum cooling).
    const hNow  = macdHist[i - 1];
    const hPrev = macdHist[i - 2];
    const macdWarm = Number.isFinite(hNow) && Number.isFinite(hPrev);
    const macdBuyOk = !macdWarm || hNow > hPrev;
    if (!macdBuyOk) { i++; continue; }

    // Fill check: today's bar must touch into the golden pocket and open above gpLow
    // (no gap-through fills — mirrors backtest realism logic in runBacktest).
    const buyFills = today.low <= gpHigh && today.low >= gpLow * 0.98 && today.open >= gpLow;
    if (!buyFills) { i++; continue; }

    // Entry at fib 61.8 (deepest support in the pocket).
    const entry = fib618;
    const sl = round(gpLow - atr * 0.5);
    const risk = Math.abs(entry - sl);
    if (risk <= 0) { i++; continue; }

    // TP1: swing high (100% recovery of the impulse) — the natural target of a
    // golden pocket bounce trade. Floored at 1.5R.
    // TP2: swing high + 0.5×ATR extension. Floored at 2.5R.
    const tp1 = round(floorTarget(entry, sl, swingHigh,           MIN_RR_TP1, "BUY"));
    const tp2 = round(floorTarget(entry, sl, swingHigh + atr * 0.5, MIN_RR_TP2, "BUY"));

    let exitDate = today.date;
    let exitPrice = entry;
    let outcome: Trade["outcome"] = "EXPIRED";
    let barsHeld = 0;
    let exitIdx = i;

    for (let j = i; j < Math.min(candles.length, i + maxHold + 1); j++) {
      const bar = candles[j];
      barsHeld = j - i + 1;
      exitIdx = j;
      const slHit  = bar.low  <= sl;
      const tp1Hit = bar.high >= tp1;
      const tp2Hit = bar.high >= tp2;
      if (slHit && (tp1Hit || tp2Hit)) { outcome = "SL"; exitPrice = sl; exitDate = bar.date; break; }
      if (slHit)  { outcome = "SL";  exitPrice = sl;  exitDate = bar.date; break; }
      if (tp2Hit) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
      if (tp1Hit) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
    }

    if (outcome === "EXPIRED") {
      const lastBar = candles[Math.min(candles.length - 1, i + maxHold)];
      exitPrice = lastBar.close;
      exitDate  = lastBar.date;
      exitIdx   = Math.min(candles.length - 1, i + maxHold);
    }

    const pnl = exitPrice - entry;
    const rMultiple = Math.round((pnl / risk) * 100) / 100;

    trades.push({
      entryDate: today.date,
      direction: "BUY",
      entry: round(entry),
      stopLoss: round(sl),
      takeProfit1: round(tp1),
      takeProfit2: round(tp2),
      exitDate,
      exitPrice: round(exitPrice),
      outcome,
      rMultiple,
      barsHeld,
    });

    // Apply cooldown after any non-TP2 exit to prevent re-entering the same
    // static golden pocket immediately. TP2 exits are clean — no cooldown needed.
    if (outcome !== "TP2") {
      cooldownUntil = exitIdx + 1 + FIB_COOLDOWN_BARS;
    }

    i = exitIdx + 1;
  }

  return trades;
}

// ─── FIB50_SWING helpers ─────────────────────────────────────────────────────

/**
 * Wilder's ADX as a bar-aligned series. out[i] = ADX value AT candle i.
 * NaN until 2*period bars are available.
 */
function calcADXSeries(candles: CandleRaw[], period = 14): number[] {
  const n = candles.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n < period * 2 + 2) return out;

  const trs: number[] = [], pDMs: number[] = [], nDMs: number[] = [];
  for (let j = 1; j < n; j++) {
    const c = candles[j], p = candles[j - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, dn = p.low - c.low;
    pDMs.push(up > dn && up > 0 ? up : 0);
    nDMs.push(dn > up && dn > 0 ? dn : 0);
  }

  let sTR = 0, sPDM = 0, sNDM = 0;
  for (let j = 0; j < period; j++) { sTR += trs[j]; sPDM += pDMs[j]; sNDM += nDMs[j]; }

  const dxArr: number[] = [];
  for (let j = period; j < trs.length; j++) {
    sTR  = sTR  - sTR  / period + trs[j];
    sPDM = sPDM - sPDM / period + pDMs[j];
    sNDM = sNDM - sNDM / period + nDMs[j];
    const pdi = sTR > 0 ? 100 * sPDM / sTR : 0;
    const ndi = sTR > 0 ? 100 * sNDM / sTR : 0;
    const s = pdi + ndi;
    dxArr.push(s > 0 ? 100 * Math.abs(pdi - ndi) / s : 0);
    // dxArr[k] where k = j-period → candle[period + k + 1]
  }

  if (dxArr.length < period) return out;
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[2 * period] = adx;
  for (let k = period; k < dxArr.length; k++) {
    adx = (adx * (period - 1) + dxArr[k]) / period;
    out[period + k + 1] = adx;
  }
  return out;
}

/**
 * For each daily candle index i, returns the weekly trend (UP/DOWN/NEUTRAL)
 * derived from SMA-30 of all fully-completed weekly closes up to that bar.
 * Mirrors synthesizeWeeklyCandles + computeWeeklySMA30 in the live signal.
 */
function computeWeeklyTrendSeries(candles: CandleRaw[]): ("UP" | "DOWN" | "NEUTRAL")[] {
  const n = candles.length;
  const result: ("UP" | "DOWN" | "NEUTRAL")[] = new Array(n).fill("NEUTRAL");

  const completedWeeklyCloses: number[] = [];
  let currentWeekKey = "";
  let currentWeekLastClose = NaN;

  for (let i = 0; i < n; i++) {
    const d = new Date(candles[i].date);
    const dayOfWeek = (d.getUTCDay() + 6) % 7; // Mon=0
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - dayOfWeek);
    const wk = monday.toISOString().slice(0, 10);

    if (wk !== currentWeekKey) {
      if (currentWeekKey !== "" && !isNaN(currentWeekLastClose)) {
        completedWeeklyCloses.push(currentWeekLastClose);
      }
      currentWeekKey = wk;
    }
    currentWeekLastClose = candles[i].close;

    if (completedWeeklyCloses.length >= 30) {
      const slice = completedWeeklyCloses.slice(-30);
      const sma30 = slice.reduce((a, b) => a + b, 0) / 30;
      const last = completedWeeklyCloses[completedWeeklyCloses.length - 1];
      result[i] = last > sma30 ? "UP" : last < sma30 ? "DOWN" : "NEUTRAL";
    }
  }

  return result;
}

/**
 * FIB50_SWING backtest — mirrors the live signal logic exactly:
 *   1. Weekly SMA-30 trend gate (UP = BUY side, DOWN = SELL side, NEUTRAL = no trade)
 *   2. Local market structure: EMA21/50 cross + ADX ≥ 25 (RANGING blocks all)
 *   3. BB(30, 2σ) midline filter (entry price must sit on correct side of midline)
 *   4. 50% fib of dominant A→B swing within SWING_LOOKBACK bars
 *
 * For 1D timeframe: dailyCandles === candles.
 * For 1H timeframe: dailyCandles is a separate 1D fetch used for weekly synthesis.
 */
function runFib50SwingBacktest(
  candles: CandleRaw[],
  dailyCandles: CandleRaw[],
  timeframe: Timeframe,
  symbol: Symbol,
): Trade[] {
  const meta = SYMBOLS[symbol];
  const round = makeRounder(meta.decimals);
  const trades: Trade[] = [];
  const maxHold = FIB_MAX_HOLD_BARS[timeframe];
  const SWING_LOOKBACK = timeframe === "1h" ? 120 : 60;
  const ATR_TOL = 0.5;
  const SL_BUF  = 0.5;
  const MIN_SWING_ATR = 2.5;

  const closes   = candles.map((c) => c.close);
  const ema21Ser = calcEMASeries(closes, 21);
  const ema50Ser = calcEMASeries(closes, 50);
  const adxSer   = calcADXSeries(candles, 14);

  // BB(30) middle band — SMA of last 30 closes.
  const bbMid: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 29; i < candles.length; i++) {
    bbMid[i] = closes.slice(i - 29, i + 1).reduce((a, b) => a + b, 0) / 30;
  }

  // Weekly trend, computed from the daily candles array.
  const weeklyTrendArr = computeWeeklyTrendSeries(dailyCandles);

  // For 1H: binary-search the daily candles to find the weekly trend at each 1H bar.
  function getWeeklyTrend(i: number): "UP" | "DOWN" | "NEUTRAL" {
    if (timeframe === "1d") return weeklyTrendArr[i];
    const barDate = candles[i].date.slice(0, 10);
    let lo = 0, hi = dailyCandles.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dailyCandles[mid].date <= barDate) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return weeklyTrendArr[best];
  }

  let cooldownUntil = 0;
  const startI = Math.max(50, SWING_LOOKBACK);

  for (let i = startI; i < candles.length; i++) {
    if (i < cooldownUntil) continue;

    const atr = calcATR(candles, i - 1, 14);
    if (atr <= 0) continue;

    // Gate 1: weekly trend
    const wTrend = getWeeklyTrend(i - 1);

    // Gate 2: local market structure (EMA21/50 + ADX)
    const e21 = ema21Ser[i - 1];
    const e50 = ema50Ser[i - 1];
    const adv = adxSer[i - 1];
    const ema50Warm = i - 1 >= 50 && Number.isFinite(e21) && Number.isFinite(e50);
    const adxWarm   = Number.isFinite(adv);

    let localTrend: "UPTREND" | "DOWNTREND" | "RANGING" = "RANGING";
    if (ema50Warm) {
      if (!adxWarm) {
        const e21prev = ema21Ser[i - 2];
        const slopeUp = Number.isFinite(e21prev) && e21 > e21prev;
        if (e21 > e50 && slopeUp)        localTrend = "UPTREND";
        else if (e21 < e50 && !slopeUp)  localTrend = "DOWNTREND";
      } else if (adv >= 25) {
        if (e21 > e50)      localTrend = "UPTREND";
        else if (e21 < e50) localTrend = "DOWNTREND";
      }
    }

    const allowBuy  = wTrend === "UP"   && localTrend === "UPTREND";
    const allowSell = wTrend === "DOWN" && localTrend === "DOWNTREND" && !meta.longOnly;
    if (!allowBuy && !allowSell) continue;

    // Gate 3: BB(30) midline
    const midBand = bbMid[i - 1];

    // Swing detection window: last SWING_LOOKBACK completed bars
    const lookStart = Math.max(0, i - SWING_LOOKBACK);
    const win = candles.slice(lookStart, i); // [lookStart..i-1]
    const prevClose = candles[i - 1].close;
    const today = candles[i];

    if (allowBuy) {
      // Find A (lowest low) then B (highest high after A)
      let aIdx = 0;
      for (let k = 1; k < win.length; k++) {
        if (win[k].low < win[aIdx].low) aIdx = k;
      }
      let bIdx = -1;
      for (let k = aIdx + 1; k < win.length; k++) {
        if (bIdx === -1 || win[k].high > win[bIdx].high) bIdx = k;
      }
      if (bIdx > aIdx) {
        const swingA = win[aIdx].low;
        const swingB = win[bIdx].high;
        const range  = swingB - swingA;
        if (range >= MIN_SWING_ATR * atr && prevClose < swingB) {
          const fib50 = swingA + 0.5 * range;
          const bbOk  = !midBand || fib50 <= midBand;
          if (bbOk && Math.abs(prevClose - fib50) <= ATR_TOL * atr) {
            const ep   = round(fib50);
            const sl   = round(swingA - SL_BUF * atr);
            const risk = Math.abs(ep - sl);
            if (risk > 0 && today.low <= ep && today.high >= ep) {
              const tp1 = round(floorTarget(ep, sl, swingB,        MIN_RR_TP1, "BUY"));
              const tp2 = round(floorTarget(ep, sl, swingB + range, MIN_RR_TP2, "BUY"));

              let exitDate = today.date, exitPrice = ep;
              let outcome: Trade["outcome"] = "EXPIRED";
              let barsHeld = 0, exitIdx = i;

              for (let j = i; j < Math.min(candles.length, i + maxHold + 1); j++) {
                const bar = candles[j]; barsHeld = j - i + 1; exitIdx = j;
                if (bar.low  <= sl)  { outcome = "SL";  exitPrice = sl;  exitDate = bar.date; break; }
                if (bar.high >= tp2) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
                if (bar.high >= tp1) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
              }
              if (outcome === "EXPIRED") {
                const last = candles[Math.min(candles.length - 1, i + maxHold)];
                exitPrice = last.close; exitDate = last.date;
                exitIdx = Math.min(candles.length - 1, i + maxHold);
              }

              const pnl = exitPrice - ep;
              trades.push({ entryDate: today.date, direction: "BUY", entry: ep, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2, exitDate, exitPrice: round(exitPrice), outcome, rMultiple: Math.round((pnl / risk) * 100) / 100, barsHeld });
              if (outcome !== "TP2") cooldownUntil = exitIdx + 1 + Math.ceil(maxHold / 2);
              i = exitIdx;
              continue;
            }
          }
        }
      }
    }

    if (allowSell) {
      // Find A (highest high) then B (lowest low after A)
      let aIdx = 0;
      for (let k = 1; k < win.length; k++) {
        if (win[k].high > win[aIdx].high) aIdx = k;
      }
      let bIdx = -1;
      for (let k = aIdx + 1; k < win.length; k++) {
        if (bIdx === -1 || win[k].low < win[bIdx].low) bIdx = k;
      }
      if (bIdx > aIdx) {
        const swingA = win[aIdx].high;
        const swingB = win[bIdx].low;
        const range  = swingA - swingB;
        if (range >= MIN_SWING_ATR * atr && prevClose > swingB) {
          const fib50 = swingA - 0.5 * range;
          const bbOk  = !midBand || fib50 >= midBand;
          if (bbOk && Math.abs(prevClose - fib50) <= ATR_TOL * atr) {
            const ep   = round(fib50);
            const sl   = round(swingA + SL_BUF * atr);
            const risk = Math.abs(sl - ep);
            if (risk > 0 && today.high >= ep && today.low <= ep) {
              const tp1 = round(floorTarget(ep, sl, swingB,        MIN_RR_TP1, "SELL"));
              const tp2 = round(floorTarget(ep, sl, swingB - range, MIN_RR_TP2, "SELL"));

              let exitDate = today.date, exitPrice = ep;
              let outcome: Trade["outcome"] = "EXPIRED";
              let barsHeld = 0, exitIdx = i;

              for (let j = i; j < Math.min(candles.length, i + maxHold + 1); j++) {
                const bar = candles[j]; barsHeld = j - i + 1; exitIdx = j;
                if (bar.high >= sl)  { outcome = "SL";  exitPrice = sl;  exitDate = bar.date; break; }
                if (bar.low  <= tp2) { outcome = "TP2"; exitPrice = tp2; exitDate = bar.date; break; }
                if (bar.low  <= tp1) { outcome = "TP1"; exitPrice = tp1; exitDate = bar.date; break; }
              }
              if (outcome === "EXPIRED") {
                const last = candles[Math.min(candles.length - 1, i + maxHold)];
                exitPrice = last.close; exitDate = last.date;
                exitIdx = Math.min(candles.length - 1, i + maxHold);
              }

              const pnl = ep - exitPrice;
              trades.push({ entryDate: today.date, direction: "SELL", entry: ep, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2, exitDate, exitPrice: round(exitPrice), outcome, rMultiple: Math.round((pnl / risk) * 100) / 100, barsHeld });
              if (outcome !== "TP2") cooldownUntil = exitIdx + 1 + Math.ceil(maxHold / 2);
              i = exitIdx;
            }
          }
        }
      }
    }
  }

  return trades;
}

function runBacktest(candles: CandleRaw[], timeframe: Timeframe, symbol: Symbol): Trade[] {
  const meta = SYMBOLS[symbol];
  const longOnly = !!meta.longOnly;
  const round = makeRounder(meta.decimals);
  const trades: Trade[] = [];
  const maxHold = MAX_HOLD_BARS[timeframe];

  // Mirrors live signal gates: EMA200 regime + RSI exhaustion + MACD turn.
  // EMA21/50 trend direction is NOT a gate — same reasoning as live signals:
  // EMA21 > EMA50 during a pump is caused by the pump itself, which would
  // suppress the exact sell-zone reversal setups we want to capture.
  const closes = candles.map((c) => c.close);
  const ema200 = calcEMASeries(closes, 200);
  const rsi14 = calcRSISeries(closes, 14);
  const macdHist = calcMACDHist(closes, 12, 26, 9);
  // Synced with live signal thresholds.
  const RSI_BUY_MAX = 50;
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

    // EMA200 regime gate — mirrors live signal logic.
    // When warm, price ≥ EMA200 = bull regime (buys allowed),
    // price ≤ EMA200 = bear regime (sells allowed).
    // When not warm (early bars or daily TF), allow both directions —
    // EMA21/50 is NOT used as a fallback because EMA21 > EMA50 during
    // a pump is caused by the pump itself, suppressing sell-zone setups.
    const e200 = ema200[i - 1];
    const ema200Warm = i - 1 >= 200 && Number.isFinite(e200) && e200 > 0;
    const useEma200 = ema200Warm && timeframe !== "1d";
    const buyAllowed  = !useEma200 || prev.close >= e200;
    const sellAllowed = !useEma200 || prev.close <= e200;

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

    const canBuy  = buyFills  && buyAllowed  && buyLevelValid  && rsiBuyOk  && macdBuyOk;
    const canSell = !longOnly && sellFills && sellAllowed && sellLevelValid && rsiSellOk && macdSellOk;

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

// Quality heuristics applied to the aggregate. Surfaced as plain-English
// warnings on the API response so the UI can flag results that look like
// noise (tiny sample, no edge, regime mismatch) rather than the user
// inferring it from raw numbers. Order matters here — the most material
// caveats come first so they show up at the top of the panel.
function buildQualityWarnings(args: {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalReturnR: number;
  maxDrawdownR: number;
  totalBars: number;
}): string[] {
  const { totalTrades, winRate, profitFactor, totalReturnR, maxDrawdownR, totalBars } = args;
  const warnings: string[] = [];
  if (totalTrades === 0) {
    warnings.push(
      "No qualifying trades over this period — gates didn't align on any bar. Often a sample-size issue on short daily series, not a signal that the strategy is broken.",
    );
    return warnings;
  }
  if (totalTrades < 20) {
    warnings.push(
      `Small sample (${totalTrades} trades). Stats are noisy — wait for a larger sample before drawing conclusions.`,
    );
  } else if (totalTrades < 50) {
    warnings.push(
      `Moderate sample (${totalTrades} trades). Treat the win rate as indicative rather than reliable.`,
    );
  }
  if (totalReturnR < 0) {
    warnings.push(
      `Negative cumulative return (${totalReturnR}R) — the strategy lost money on this slice.`,
    );
  }
  if (profitFactor < 1) {
    warnings.push(
      `Profit factor below 1 (${profitFactor}) — gross losses exceeded gross wins.`,
    );
  } else if (profitFactor < 1.2) {
    warnings.push(
      `Thin profit factor (${profitFactor}) — the edge barely covers the losers. Live slippage and commissions may eat it.`,
    );
  }
  if (winRate < 45 && totalTrades >= 15) {
    warnings.push(
      `⚠ Poor win rate (${winRate}%) — this setup has a negative historical edge. Avoid trading it live.`,
    );
  } else if (winRate < 55 && totalTrades >= 20) {
    warnings.push(
      `Win rate (${winRate}%) is on the low side. Treat results as marginal rather than a reliable edge.`,
    );
  }
  if (totalReturnR > 0 && maxDrawdownR > totalReturnR) {
    warnings.push(
      `Max drawdown (${maxDrawdownR}R) exceeds total return (${totalReturnR}R) — the strategy is profitable but volatile.`,
    );
  }
  if (totalBars < 100) {
    warnings.push(
      `Short historical window (${totalBars} bars). Not enough data to characterise regime variety.`,
    );
  }
  return warnings;
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

  const totalTrades = trades.length;
  const winRate = totalTrades ? round2((wins.length / totalTrades) * 100) : 0;
  const totalReturnR = round2(totalR);
  const profitFactor = grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? 999 : 0;
  const maxDrawdownR = round2(maxDD);
  const totalBars = candles.length;

  return {
    symbol,
    startDate: candles[0]?.date ?? "",
    endDate: candles[candles.length - 1]?.date ?? "",
    totalBars,
    totalTrades,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate,
    totalReturnR,
    avgReturnR: totalTrades ? round2(totalR / totalTrades) : 0,
    profitFactor,
    maxDrawdownR,
    avgBarsHeld: totalTrades
      ? round2(trades.reduce((s, t) => s + t.barsHeld, 0) / totalTrades)
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
    qualityWarnings: buildQualityWarnings({
      totalTrades,
      winRate,
      profitFactor,
      totalReturnR,
      maxDrawdownR,
      totalBars,
    }),
    lastUpdated: new Date().toISOString(),
  };
}

router.get("/backtest", async (req: Request, res: Response) => {
  try {
    const queryParsed = GetBacktestQueryParams.safeParse(req.query);
    // Use raw query strings as fallback so dynamic/trending symbols don't crash.
    const rawSymbol = (req.query["symbol"] as string | undefined) ?? "XAGUSD";
    const rawTimeframe = (req.query["timeframe"] as string | undefined) ?? "1d";
    const rawSignalType = (req.query["signalType"] as string | undefined) ?? "FIB50_SWING";
    const query = queryParsed.success ? queryParsed.data : null;
    const symbol = (query?.symbol ?? rawSymbol) as Symbol;
    const timeframe = (query?.timeframe ?? rawTimeframe) as Timeframe;
    const signalType: "PIVOT_BOUNCE" | "BREAKOUT" | "FIB_BOUNCE" | "FIB50_SWING" = (query?.signalType ?? rawSignalType) as "PIVOT_BOUNCE" | "BREAKOUT" | "FIB_BOUNCE" | "FIB50_SWING";

    // Dynamic/trending symbols are not supported by the backtest engine — return empty.
    const KNOWN_SYMBOLS = new Set<string>(["XAGUSD","XAUUSD","EURUSD","GBPUSD","AUDUSD","USDCHF","BTCUSD","ETHUSD","SKYAIUSDT","ZECUSD"]);
    if (!KNOWN_SYMBOLS.has(symbol)) {
      res.json(aggregate([], [], symbol));
      return;
    }
    const now = Date.now();
    const key = cacheKey(symbol, timeframe, signalType);
    const cached = cache.get(key);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      res.json(cached.data);
      return;
    }
    // Disabled combinations — return an empty-result object and cache it.
    // PIVOT_BOUNCE on 1d: daily metals pivots produce negative edge (see sweep).
    // BREAKOUT on 30m: misfires too often; 1h breakout is the only live setup.
    // FIB_BOUNCE: disabled for symbols/TFs where sweep showed consistent losses.
    const isDisabled =
      (signalType === "PIVOT_BOUNCE" && timeframe === "1d") ||
      (signalType === "BREAKOUT"     && timeframe === "30m") ||
      (signalType === "BREAKOUT"     && timeframe === "1h" && symbol === "XAGUSD") || // -1.37R, no edge
      (signalType === "BREAKOUT"     && timeframe === "1h" && symbol === "ETHUSD") || // -1.40R, no edge
      (signalType === "FIB_BOUNCE"   && symbol === "XAGUSD") ||                       // PIVOT far superior; fib pf 0.49–0.96
      (signalType === "FIB_BOUNCE"   && symbol === "AUDUSD") ||                       // fib -6 to -12R across all TFs
      (signalType === "FIB_BOUNCE"   && symbol === "XAUUSD" && timeframe !== "1h");   // XAUUSD fib only viable on 1h
    if (isDisabled) {
      const emptyPayload = aggregate([], [], symbol);
      const emptyParsed = GetBacktestResponse.safeParse(emptyPayload);
      const empty = emptyParsed.success ? emptyParsed.data : emptyPayload;
      cache.set(key, { data: empty, timestamp: now });
      res.json(empty);
      return;
    }

    const candles = await fetchCandlesForTimeframe(symbol, timeframe);
    if (candles.length < 20) {
      res.status(503).json({ error: "Insufficient data for backtest" });
      return;
    }

    let trades: Trade[];
    if (signalType === "FIB50_SWING") {
      // For 1H we need daily candles to synthesise the weekly trend gate.
      // For 1D the candles themselves serve as the daily source.
      const dailyCandles =
        timeframe === "1h"
          ? await fetchCandlesForTimeframe(symbol, "1d")
          : candles;
      trades = runFib50SwingBacktest(candles, dailyCandles, timeframe, symbol);
    } else if (signalType === "BREAKOUT") {
      trades = runBreakoutBacktest(candles, timeframe, symbol);
    } else if (signalType === "FIB_BOUNCE") {
      trades = runFibBacktest(candles, timeframe, symbol);
    } else {
      trades = runBacktest(candles, timeframe, symbol);
    }
    const resultPayload = aggregate(trades, candles, symbol);
    const resultParsed = GetBacktestResponse.safeParse(resultPayload);
    const result = resultParsed.success ? resultParsed.data : resultPayload;
    cache.set(key, { data: result, timestamp: now });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Backtest failed");
    res.status(500).json({ error: "Backtest failed" });
  }
});

export default router;
