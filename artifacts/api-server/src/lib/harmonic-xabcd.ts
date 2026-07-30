// XABCD harmonic-pattern detector (see gartley-bat-strategy-spec-final.md).
// Gartley-only per the backtest review — Bat's bearish leg was net-negative
// over the tested window (74 trades, avg R -0.077, PF 0.83), so it was
// dropped rather than carried forward as dead weight. The core is still fed
// a config rather than hardcoding Gartley's ratios, so re-adding a second
// pattern later is a one-config-object change, not a rewrite.
// Pure, stateless — no side effects, no imports from signals.ts/notifier.ts.
// Structural pivots reuse the existing findSwingHighs/findSwingLows helpers
// from patterns.ts (close-based pivot confirmation, wick-based price level)
// rather than a fresh implementation.

import type { CandleRaw } from "./yahoo-fetch";
import { findSwingHighs, findSwingLows } from "./patterns";

export type HarmonicPatternName = "GARTLEY";
export type HarmonicDirection = "bullish" | "bearish";

export interface RatioBand {
  min: number;
  max: number;
  ideal: number;
}

export interface XABCDRatioConfig {
  name: HarmonicPatternName;
  ab_xa: RatioBand;           // AB retracement of XA
  bc_ab: RatioBand;           // BC retracement of AB
  d_xa_primary: RatioBand;    // D retracement of XA (primary completion target)
  cd_bc_secondary: RatioBand; // CD extension of BC (secondary confirmation, informational)
}

export function pointBand(ideal: number, tolerancePct: number): RatioBand {
  return { min: ideal * (1 - tolerancePct), max: ideal * (1 + tolerancePct), ideal };
}

export function rangeBand(low: number, high: number, tolerancePct: number): RatioBand {
  return { min: low * (1 - tolerancePct), max: high * (1 + tolerancePct), ideal: (low + high) / 2 };
}

export const HARMONIC_TOLERANCE_PCT = 0.03; // ±3% to start; tune per-pattern from backtest results

export const GARTLEY_CONFIG: XABCDRatioConfig = {
  name: "GARTLEY",
  ab_xa: pointBand(0.618, HARMONIC_TOLERANCE_PCT),
  bc_ab: rangeBand(0.382, 0.886, HARMONIC_TOLERANCE_PCT),
  d_xa_primary: pointBand(0.786, HARMONIC_TOLERANCE_PCT),
  cd_bc_secondary: rangeBand(1.27, 1.618, HARMONIC_TOLERANCE_PCT),
};

export interface XABCDPoint {
  idx: number;
  price: number;
  date: string;
}

export type XABCDStatus = "FORMING" | "AT_D_ZONE" | "VIOLATED";

export interface XABCDPattern {
  pattern: HarmonicPatternName;
  direction: HarmonicDirection;
  X: XABCDPoint;
  A: XABCDPoint;
  B: XABCDPoint;
  C: XABCDPoint;
  dZoneLow: number;
  dZoneHigh: number;
  abRetrace: number;           // measured AB/XA ratio, for logging/tuning
  bcRetrace: number;           // measured BC/AB ratio
  cdProjection: number | null; // measured CD/BC ratio once price has reached the D zone, else null
  abcdProjectedD: number;      // AB=CD price projection for D (CD leg sized like AB), for logging/tuning
  status: XABCDStatus;
}

const DEFAULT_SWING_STRENGTH = 3;
const DEFAULT_SWING_LOOKBACK = 150;

function inBand(value: number, band: RatioBand): boolean {
  return value >= band.min && value <= band.max;
}

function toPoint(candles: CandleRaw[], p: { idx: number; price: number }): XABCDPoint {
  return { idx: p.idx, price: p.price, date: candles[p.idx].date };
}

// Volume should trend UP across the XA leg — a genuine impulsive move is
// backed by rising participation, not a low-conviction drift. Compares
// average volume in the second half of the leg to the first half.
function volumeIncreasingOverLeg(candles: CandleRaw[], startIdx: number, endIdx: number): boolean {
  const leg = candles.slice(startIdx, endIdx + 1);
  if (leg.length < 2) return true; // not enough bars to judge — don't block
  const mid = Math.floor(leg.length / 2);
  const firstHalf = leg.slice(0, mid);
  const secondHalf = leg.slice(mid);
  if (firstHalf.length === 0 || secondHalf.length === 0) return true;
  const avg = (arr: CandleRaw[]) => arr.reduce((s, c) => s + c.volume, 0) / arr.length;
  return avg(secondHalf) > avg(firstHalf);
}

// AB=CD confirmation: the CD leg should be roughly the same size as AB,
// giving an independent price estimate of where D lands. Requires this
// AB=CD-projected D to overlap the existing fib-based D zone (within
// tolerance) — when the two measurement techniques diverge, it's a weaker
// setup and gets rejected rather than traded on the fib zone alone.
function abcdConverges(
  abcdProjectedD: number, dZoneLow: number, dZoneHigh: number, tolerancePct: number,
): boolean {
  const lo = abcdProjectedD * (1 - tolerancePct);
  const hi = abcdProjectedD * (1 + tolerancePct);
  return lo <= dZoneHigh && hi >= dZoneLow;
}

// Mirror of volumeIncreasingOverLeg: the AD retracement leg (A through the
// point price first touches the D zone) should show DECLINING volume — a
// genuine low-conviction pullback, not fresh trend participation that would
// undermine the reversal thesis at D.
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

// Reversal-only filter: X must make a NEW extreme versus the prior
// structural swing, confirming a genuine prior trend into X rather than XA
// just being a shallow dip/bounce inside an already-established trend in
// the same direction (a continuation, not a reversal). Bullish: X must be a
// lower low than the most recent swing low before it. Bearish (mirror): X
// must be a higher high than the most recent swing high before it. Rejects
// when there's no prior swing to compare against — insufficient evidence of
// a genuine reversal, not assumed true by default.
function reversesIntoX(
  priorSwings: { idx: number; price: number }[],
  xIdx: number,
  xPrice: number,
  direction: HarmonicDirection,
): boolean {
  const before = priorSwings.filter((s) => s.idx < xIdx);
  if (before.length === 0) return false;
  const prior = before[before.length - 1];
  return direction === "bullish" ? xPrice < prior.price : xPrice > prior.price;
}

// Mirrors the fib-violation guard in signals.ts (~1702-1709): a setup is
// invalid once price has already CLOSED through the far side of the D zone
// — a later revisit isn't a fresh reversal opportunity, it's a structure
// break, so the pattern must be rejected rather than re-signaled.
export function checkDZoneViolation(
  candles: CandleRaw[],
  afterIdx: number,
  dZoneLow: number,
  dZoneHigh: number,
  direction: HarmonicDirection,
): boolean {
  const after = candles.slice(afterIdx + 1);
  if (direction === "bullish") return after.some((c) => c.close < dZoneLow);
  return after.some((c) => c.close > dZoneHigh);
}

function findBullXABCD(
  candles: CandleRaw[],
  config: XABCDRatioConfig,
  strength: number,
  lookback: number,
): XABCDPattern | null {
  const swingLows = findSwingLows(candles, strength, lookback);
  const swingHighs = findSwingHighs(candles, strength, lookback);
  if (swingLows.length === 0 || swingHighs.length === 0) return null;

  // X = swing low (start), A = swing high after X (XA up), B = swing low
  // after A (AB down, partial retrace), C = swing high after B (BC up,
  // partial retrace). D completes back down — a retracement of XA measured
  // from A, staying above X — and is where price is expected to bounce back
  // up; the long entry buys that dip. Walk candidate A points (swing highs)
  // from most recent to oldest and return the first fully-formed sequence
  // whose ratios satisfy the config — same "most recent structural swing"
  // bias as the existing Dagger setup finder (signals.ts findDaggerBullSetup)
  // rather than an exhaustive search over every historical combination.
  for (let ai = swingHighs.length - 1; ai >= 0; ai--) {
    const A = swingHighs[ai];

    const xCandidates = swingLows.filter((l) => l.idx < A.idx);
    if (xCandidates.length === 0) continue;
    const X = xCandidates[xCandidates.length - 1];
    if (X.price >= A.price) continue; // XA must be a genuine up leg
    if (!volumeIncreasingOverLeg(candles, X.idx, A.idx)) continue; // XA must be volume-confirmed
    if (!reversesIntoX(swingLows, X.idx, X.price, "bullish")) continue; // X must reverse a prior downtrend

    const bCandidates = swingLows.filter((l) => l.idx > A.idx);
    if (bCandidates.length === 0) continue;
    // B = the lowest swing low after A (the extent of the AB pullback)
    const B = bCandidates.reduce((best, l) => (l.price < best.price ? l : best), bCandidates[0]);
    if (B.price >= A.price || B.price <= X.price) continue; // AB must retrace but not undercut X

    const cCandidates = swingHighs.filter((h) => h.idx > B.idx);
    if (cCandidates.length === 0) continue;
    // C = the most recent swing high after B (the in-progress BC bounce)
    const C = cCandidates[cCandidates.length - 1];
    if (C.price >= A.price || C.price <= B.price) continue; // BC must retrace but not overrun A

    const xaRange = A.price - X.price;
    const abRange = A.price - B.price;
    const bcRange = C.price - B.price;

    const abRetrace = abRange / xaRange;
    const bcRetrace = bcRange / abRange;
    if (!inBand(abRetrace, config.ab_xa)) continue;
    if (!inBand(bcRetrace, config.bc_ab)) continue;

    // D zone is a fib retracement of XA measured from A (deeper completion
    // ratio ⇒ lower price, but always staying above X); the whole zone must
    // sit below C or the CD leg wouldn't be a further move down.
    const dZoneHigh = A.price - config.d_xa_primary.min * xaRange;
    const dZoneLow = A.price - config.d_xa_primary.max * xaRange;
    if (dZoneHigh >= C.price) continue;

    const abcdProjectedD = C.price - abRange; // CD leg (down from C) sized like AB
    if (!abcdConverges(abcdProjectedD, dZoneLow, dZoneHigh, HARMONIC_TOLERANCE_PCT)) continue;

    const violated = checkDZoneViolation(candles, C.idx, dZoneLow, dZoneHigh, "bullish");
    const since = candles.slice(C.idx + 1);
    const lowestSinceC = since.length > 0 ? Math.min(...since.map((c) => c.low)) : Infinity;
    let atDZone = !violated && lowestSinceC <= dZoneHigh;

    if (atDZone) {
      let touchIdx = C.idx;
      for (let k = 0; k < since.length; k++) {
        if (since[k].low <= dZoneHigh) { touchIdx = C.idx + 1 + k; break; }
      }
      if (!volumeDecreasingOverLeg(candles, A.idx, touchIdx)) atDZone = false;
    }

    const cdProjection = atDZone && bcRange > 0
      ? (C.price - Math.max(lowestSinceC, dZoneLow)) / bcRange
      : null;

    return {
      pattern: config.name,
      direction: "bullish",
      X: toPoint(candles, X), A: toPoint(candles, A), B: toPoint(candles, B), C: toPoint(candles, C),
      dZoneLow, dZoneHigh, abRetrace, bcRetrace, cdProjection, abcdProjectedD,
      status: violated ? "VIOLATED" : atDZone ? "AT_D_ZONE" : "FORMING",
    };
  }

  return null;
}

function findBearXABCD(
  candles: CandleRaw[],
  config: XABCDRatioConfig,
  strength: number,
  lookback: number,
): XABCDPattern | null {
  const swingLows = findSwingLows(candles, strength, lookback);
  const swingHighs = findSwingHighs(candles, strength, lookback);
  if (swingLows.length === 0 || swingHighs.length === 0) return null;

  // Mirror of findBullXABCD: X = swing high (start), A = swing low after X
  // (XA down), B = swing high after A (AB up), C = swing low after B (BC
  // down). D completes back up, staying below X, and the short entry sells
  // that rally expecting a bounce back down.
  for (let ai = swingLows.length - 1; ai >= 0; ai--) {
    const A = swingLows[ai];

    const xCandidates = swingHighs.filter((h) => h.idx < A.idx);
    if (xCandidates.length === 0) continue;
    const X = xCandidates[xCandidates.length - 1];
    if (X.price <= A.price) continue; // XA must be a genuine down leg
    if (!volumeIncreasingOverLeg(candles, X.idx, A.idx)) continue; // XA must be volume-confirmed
    if (!reversesIntoX(swingHighs, X.idx, X.price, "bearish")) continue; // X must reverse a prior uptrend

    const bCandidates = swingHighs.filter((h) => h.idx > A.idx);
    if (bCandidates.length === 0) continue;
    // B = the highest swing high after A (the extent of the AB bounce)
    const B = bCandidates.reduce((best, h) => (h.price > best.price ? h : best), bCandidates[0]);
    if (B.price <= A.price || B.price >= X.price) continue; // AB must retrace but not overrun X

    const cCandidates = swingLows.filter((l) => l.idx > B.idx);
    if (cCandidates.length === 0) continue;
    // C = the most recent swing low after B (the in-progress BC pullback)
    const C = cCandidates[cCandidates.length - 1];
    if (C.price <= A.price || C.price >= B.price) continue; // BC must retrace but not undercut A

    const xaRange = X.price - A.price;
    const abRange = B.price - A.price;
    const bcRange = B.price - C.price;

    const abRetrace = abRange / xaRange;
    const bcRetrace = bcRange / abRange;
    if (!inBand(abRetrace, config.ab_xa)) continue;
    if (!inBand(bcRetrace, config.bc_ab)) continue;

    // D zone is a fib retracement of XA measured from A, staying below X;
    // the whole zone must sit above C or the CD leg wouldn't be a further
    // move up.
    const dZoneLow = A.price + config.d_xa_primary.min * xaRange;
    const dZoneHigh = A.price + config.d_xa_primary.max * xaRange;
    if (dZoneLow <= C.price) continue;

    const abcdProjectedD = C.price + abRange; // CD leg (up from C) sized like AB
    if (!abcdConverges(abcdProjectedD, dZoneLow, dZoneHigh, HARMONIC_TOLERANCE_PCT)) continue;

    const violated = checkDZoneViolation(candles, C.idx, dZoneLow, dZoneHigh, "bearish");
    const since = candles.slice(C.idx + 1);
    const highestSinceC = since.length > 0 ? Math.max(...since.map((c) => c.high)) : -Infinity;
    let atDZone = !violated && highestSinceC >= dZoneLow;

    if (atDZone) {
      let touchIdx = C.idx;
      for (let k = 0; k < since.length; k++) {
        if (since[k].high >= dZoneLow) { touchIdx = C.idx + 1 + k; break; }
      }
      if (!volumeDecreasingOverLeg(candles, A.idx, touchIdx)) atDZone = false;
    }

    const cdProjection = atDZone && bcRange > 0
      ? (Math.min(highestSinceC, dZoneHigh) - C.price) / bcRange
      : null;

    return {
      pattern: config.name,
      direction: "bearish",
      X: toPoint(candles, X), A: toPoint(candles, A), B: toPoint(candles, B), C: toPoint(candles, C),
      dZoneLow, dZoneHigh, abRetrace, bcRetrace, cdProjection, abcdProjectedD,
      status: violated ? "VIOLATED" : atDZone ? "AT_D_ZONE" : "FORMING",
    };
  }

  return null;
}

export function detectXABCD(
  candles: CandleRaw[],
  config: XABCDRatioConfig,
  opts: { swingStrength?: number; swingLookback?: number } = {},
): { bull: XABCDPattern | null; bear: XABCDPattern | null } {
  const strength = opts.swingStrength ?? DEFAULT_SWING_STRENGTH;
  const lookback = opts.swingLookback ?? DEFAULT_SWING_LOOKBACK;
  return {
    bull: findBullXABCD(candles, config, strength, lookback),
    bear: findBearXABCD(candles, config, strength, lookback),
  };
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

// SL = X ∓ buffer×ATR — same convention as the Dagger setup's DAGGER_SL_BUFFER,
// not the dead SWING_SL_BUFFER_ATR constant in signals.ts.
export const HARMONIC_SL_BUFFER_ATR = 1.0;

export function computeHarmonicStopLoss(
  xPrice: number,
  direction: HarmonicDirection,
  atr: number,
): number {
  return direction === "bullish" ? xPrice - HARMONIC_SL_BUFFER_ATR * atr : xPrice + HARMONIC_SL_BUFFER_ATR * atr;
}
