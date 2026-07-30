// FIB786 revision — a revision of the old FIB50_SWING strategy (retired
// earlier in this repo's history for being unprofitable), now at the 0.786
// retracement level with volume/reversal confirmation. Validated by backtest
// against real OKX history (scripts/src/backtest-fib786.ts) — Variant B
// (4h detection / 1h entry / daily trailing stop) is the one that shipped:
// 190 trades, 69.5% win rate, avg R +0.127, PF 1.42, max drawdown 6.9R.
//
// Setup (long only):
//   - X = swing low, confirmed to be a genuine reversal point (X must be a
//     lower low than the prior swing low — reversesIntoX)
//   - A = swing high after X, with the XA leg volume-CONFIRMED (rising
//     participation, not a low-conviction drift — volumeIncreasingOverLeg)
//   - D = 0.786 retracement of XA measured from A (±3% tolerance), with the
//     AD leg (A through the D-zone touch) volume-DECLINING (a genuine
//     low-conviction pullback, not fresh trend participation)
//   - Entry: price tags the D zone + a confirming bullish candle close
//   - SL: below X, ATR-buffered (Dagger-style)
//
// Pure, stateless — no side effects, no imports from signals.ts/notifier.ts.
// Structural pivots reuse the existing findSwingHighs/findSwingLows helpers
// from patterns.ts (close-based pivot confirmation, wick-based price level).

import type { CandleRaw } from "./yahoo-fetch";
import { findSwingHighs, findSwingLows } from "./patterns";

export type XADStatus = "FORMING" | "AT_D_ZONE" | "VIOLATED";

export interface XADPoint {
  idx: number;
  price: number;
  date: string;
}

export interface XADPattern {
  X: XADPoint;
  A: XADPoint;
  dZoneLow: number;
  dZoneHigh: number;
  status: XADStatus;
}

interface SwingPoint { idx: number; price: number; }

const DEFAULT_SWING_STRENGTH = 3;
const DEFAULT_SWING_LOOKBACK = 150;
const D_RATIO = 0.786;
const D_TOLERANCE_PCT = 0.03;

function toPoint(candles: CandleRaw[], p: SwingPoint): XADPoint {
  return { idx: p.idx, price: p.price, date: candles[p.idx].date };
}

// Reversal-only filter: X must make a new low versus the prior structural
// swing low, confirming a genuine downtrend into X rather than XA being a
// shallow bounce inside an already-established uptrend (continuation, not
// reversal). Rejects when there's no prior swing to compare against.
function reversesIntoX(swingLows: SwingPoint[], xIdx: number, xPrice: number): boolean {
  const before = swingLows.filter((s) => s.idx < xIdx);
  if (before.length === 0) return false;
  return xPrice < before[before.length - 1].price;
}

// Volume should trend UP across the XA leg — a genuine impulsive move is
// backed by rising participation, not a low-conviction drift.
function volumeIncreasingOverLeg(candles: CandleRaw[], startIdx: number, endIdx: number): boolean {
  const leg = candles.slice(startIdx, endIdx + 1);
  if (leg.length < 2) return true;
  const mid = Math.floor(leg.length / 2);
  const firstHalf = leg.slice(0, mid);
  const secondHalf = leg.slice(mid);
  if (firstHalf.length === 0 || secondHalf.length === 0) return true;
  const avg = (arr: CandleRaw[]) => arr.reduce((s, c) => s + c.volume, 0) / arr.length;
  return avg(secondHalf) > avg(firstHalf);
}

// Mirror: the AD leg (A through the D-zone touch) should show DECLINING
// volume — a genuine low-conviction pullback, not fresh trend participation
// that would undermine the reversal thesis at D.
function volumeDecreasingOverLeg(candles: CandleRaw[], startIdx: number, endIdx: number): boolean {
  const leg = candles.slice(startIdx, endIdx + 1);
  if (leg.length < 2) return true;
  const mid = Math.floor(leg.length / 2);
  const firstHalf = leg.slice(0, mid);
  const secondHalf = leg.slice(mid);
  if (firstHalf.length === 0 || secondHalf.length === 0) return true;
  const avg = (arr: CandleRaw[]) => arr.reduce((s, c) => s + c.volume, 0) / arr.length;
  return avg(secondHalf) < avg(firstHalf);
}

export function findXAD(
  candles: CandleRaw[],
  strength = DEFAULT_SWING_STRENGTH,
  lookback = DEFAULT_SWING_LOOKBACK,
): XADPattern | null {
  const swingLows = findSwingLows(candles, strength, lookback);
  const swingHighs = findSwingHighs(candles, strength, lookback);
  if (swingLows.length === 0 || swingHighs.length === 0) return null;

  for (let ai = swingHighs.length - 1; ai >= 0; ai--) {
    const A = swingHighs[ai];
    const xCandidates = swingLows.filter((l) => l.idx < A.idx);
    if (xCandidates.length === 0) continue;
    const X = xCandidates[xCandidates.length - 1];
    if (X.price >= A.price) continue; // XA must be a genuine up leg
    if (!volumeIncreasingOverLeg(candles, X.idx, A.idx)) continue;
    if (!reversesIntoX(swingLows, X.idx, X.price)) continue;

    const xaRange = A.price - X.price;
    const dZoneHigh = A.price - D_RATIO * (1 - D_TOLERANCE_PCT) * xaRange;
    const dZoneLow = A.price - D_RATIO * (1 + D_TOLERANCE_PCT) * xaRange;

    // Violation guard: if any candle after A has already closed below the
    // deepest acceptable D level, this setup is stale — a later revisit
    // isn't a fresh bounce, it's a structure break.
    const since = candles.slice(A.idx + 1);
    const violated = since.some((c) => c.close < dZoneLow);
    const lowestSinceA = since.length > 0 ? Math.min(...since.map((c) => c.low)) : Infinity;
    let atDZone = !violated && lowestSinceA <= dZoneHigh;

    if (atDZone) {
      let touchIdx = A.idx;
      for (let k = 0; k < since.length; k++) {
        if (since[k].low <= dZoneHigh) { touchIdx = A.idx + 1 + k; break; }
      }
      if (!volumeDecreasingOverLeg(candles, A.idx, touchIdx)) atDZone = false;
    }

    return {
      X: toPoint(candles, X), A: toPoint(candles, A),
      dZoneLow, dZoneHigh,
      status: violated ? "VIOLATED" : atDZone ? "AT_D_ZONE" : "FORMING",
    };
  }
  return null;
}

// Duplicated locally rather than imported — calcATR in signals.ts isn't
// exported, and this module is deliberately kept dependency-free from it.
export function calcATR(candles: CandleRaw[], period = 14): number {
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

// SL = X - buffer×ATR — same convention as the Dagger setup's DAGGER_SL_BUFFER.
export const FIB786_SL_BUFFER_ATR = 1.0;

export function computeFib786StopLoss(xPrice: number, atr: number): number {
  return xPrice - FIB786_SL_BUFFER_ATR * atr;
}

// ─── 3-bar trailing stop (excluding inside bars) ─────────────────────────────

// An "inside bar" sits entirely within the prior bar's range and doesn't
// establish a new swing extreme, so it doesn't count toward the 3 bars used
// for the trailing stop.
export function computeInsideBarFlags(candles: CandleRaw[]): boolean[] {
  const flags = new Array(candles.length).fill(false);
  for (let i = 1; i < candles.length; i++) {
    flags[i] = candles[i].high <= candles[i - 1].high && candles[i].low >= candles[i - 1].low;
  }
  return flags;
}

// Only considers trail-timeframe bars that have fully CLOSED by cutoffMs (no lookahead).
export function trailingStopAt(
  trailCandles: CandleRaw[],
  insideFlags: boolean[],
  trailBarMs: number,
  cutoffMs: number,
): number | null {
  const qualifying: number[] = [];
  for (let i = trailCandles.length - 1; i >= 0; i--) {
    const closeMs = new Date(trailCandles[i].date).getTime() + trailBarMs;
    if (closeMs > cutoffMs) continue;
    if (insideFlags[i]) continue;
    qualifying.push(i);
    if (qualifying.length === 3) break;
  }
  if (qualifying.length < 3) return null;
  return Math.min(...qualifying.map((i) => trailCandles[i].low));
}
