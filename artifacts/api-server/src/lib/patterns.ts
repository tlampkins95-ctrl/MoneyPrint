// Chart pattern recognition — reversal pattern detection.
//
// Detects four classical reversal patterns on a candle array:
//   Head & Shoulders (bearish), Inverse H&S (bullish),
//   Double Top (bearish), Double Bottom (bullish).
//
// Design principles:
//   • Pure function — no side effects, no state.
//   • Only looks at the most recent N bars so patterns stay relevant.
//   • `confirmed` = neckline/valley break on a CLOSED bar (not a wick).
//     Only confirmed patterns are used as signal veto gates.
//   • Returns the most relevant confirmed pattern first, then unconfirmed.

import type { CandleRaw } from "./yahoo-fetch";

export type PatternType =
  | "HEAD_AND_SHOULDERS"
  | "INVERSE_HEAD_AND_SHOULDERS"
  | "DOUBLE_TOP"
  | "DOUBLE_BOTTOM";

export interface PatternResult {
  pattern: PatternType;
  direction: "bearish" | "bullish";
  confirmed: boolean;
  necklinePrice: number;
}

interface SwingPoint {
  idx: number;
  price: number;
}

// A candle at index `i` is a swing high when its high strictly exceeds
// all highs within `strength` bars on either side. Returns results in
// chronological order (oldest first).
function findSwingHighs(
  candles: CandleRaw[],
  strength = 3,
  lookback = 80,
): SwingPoint[] {
  const n = candles.length;
  const start = Math.max(strength, n - lookback);
  const end = n - strength - 1; // last bar that has `strength` future bars
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const high = candles[i].high;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].high >= high) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: high });
  }
  return pts;
}

function findSwingLows(
  candles: CandleRaw[],
  strength = 3,
  lookback = 80,
): SwingPoint[] {
  const n = candles.length;
  const start = Math.max(strength, n - lookback);
  const end = n - strength - 1;
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const low = candles[i].low;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].low <= low) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: low });
  }
  return pts;
}

// ─── Head & Shoulders ────────────────────────────────────────────────────────
// Three swing highs: left shoulder (H1), head (H2, tallest), right shoulder (H3).
// Guards:
//   • Head ≥ 2% above the lower shoulder.
//   • Shoulders within 8% of each other.
//   • Distinct troughs between shoulders (valley on each side of the head).
//   • Right shoulder within the last 20 bars (pattern is still current).
// Neckline = average of the two troughs (simplified linear approximation).
// Confirmed when the last COMPLETED bar closes below the neckline.
function detectHS(candles: CandleRaw[]): PatternResult | null {
  const highs = findSwingHighs(candles, 3, 80);
  const lows  = findSwingLows(candles,  3, 80);
  if (highs.length < 3) return null;

  for (let i = highs.length - 1; i >= 2; i--) {
    const H3 = highs[i];
    const H2 = highs[i - 1];
    const H1 = highs[i - 2];

    if (H2.price <= H1.price || H2.price <= H3.price) continue;
    const lowerShoulder = Math.min(H1.price, H3.price);
    if ((H2.price - lowerShoulder) / lowerShoulder < 0.02) continue;
    const shoulderDiff = Math.abs(H1.price - H3.price) / Math.max(H1.price, H3.price);
    if (shoulderDiff > 0.08) continue;

    const leftTroughs = lows.filter(l => l.idx > H1.idx && l.idx < H2.idx);
    if (leftTroughs.length === 0) continue;
    const leftTrough = leftTroughs.reduce((a, b) => b.price < a.price ? b : a);

    const rightTroughs = lows.filter(l => l.idx > H2.idx && l.idx < H3.idx);
    if (rightTroughs.length === 0) continue;
    const rightTrough = rightTroughs.reduce((a, b) => b.price < a.price ? b : a);

    if (H3.idx < candles.length - 20) continue;

    const neckline = (leftTrough.price + rightTrough.price) / 2;
    const lastClose = candles[candles.length - 2].close;
    return {
      pattern: "HEAD_AND_SHOULDERS",
      direction: "bearish",
      confirmed: lastClose < neckline,
      necklinePrice: neckline,
    };
  }
  return null;
}

// ─── Inverse Head & Shoulders ────────────────────────────────────────────────
function detectIHS(candles: CandleRaw[]): PatternResult | null {
  const lows  = findSwingLows(candles,  3, 80);
  const highs = findSwingHighs(candles, 3, 80);
  if (lows.length < 3) return null;

  for (let i = lows.length - 1; i >= 2; i--) {
    const L3 = lows[i];
    const L2 = lows[i - 1];
    const L1 = lows[i - 2];

    if (L2.price >= L1.price || L2.price >= L3.price) continue;
    const higherShoulder = Math.max(L1.price, L3.price);
    if ((higherShoulder - L2.price) / higherShoulder < 0.02) continue;
    const shoulderDiff = Math.abs(L1.price - L3.price) / Math.max(L1.price, L3.price);
    if (shoulderDiff > 0.08) continue;

    const leftPeaks = highs.filter(h => h.idx > L1.idx && h.idx < L2.idx);
    if (leftPeaks.length === 0) continue;
    const leftPeak = leftPeaks.reduce((a, b) => b.price > a.price ? b : a);

    const rightPeaks = highs.filter(h => h.idx > L2.idx && h.idx < L3.idx);
    if (rightPeaks.length === 0) continue;
    const rightPeak = rightPeaks.reduce((a, b) => b.price > a.price ? b : a);

    if (L3.idx < candles.length - 20) continue;

    const neckline = (leftPeak.price + rightPeak.price) / 2;
    const lastClose = candles[candles.length - 2].close;
    return {
      pattern: "INVERSE_HEAD_AND_SHOULDERS",
      direction: "bullish",
      confirmed: lastClose > neckline,
      necklinePrice: neckline,
    };
  }
  return null;
}

// ─── Double Top ──────────────────────────────────────────────────────────────
// Two swing highs within 2.5% of each other, valley between them ≥2% below
// the average top. Confirmed when price closes below the valley.
function detectDoubleTop(candles: CandleRaw[]): PatternResult | null {
  const highs = findSwingHighs(candles, 3, 60);
  const lows  = findSwingLows(candles,  3, 60);
  if (highs.length < 2) return null;

  for (let i = highs.length - 1; i >= 1; i--) {
    const H2 = highs[i];
    const H1 = highs[i - 1];

    const diff = Math.abs(H1.price - H2.price) / Math.max(H1.price, H2.price);
    if (diff > 0.025) continue;
    if (H2.idx - H1.idx < 5) continue;

    const valleys = lows.filter(l => l.idx > H1.idx && l.idx < H2.idx);
    if (valleys.length === 0) continue;
    const valley = valleys.reduce((a, b) => b.price < a.price ? b : a);

    const avgTop = (H1.price + H2.price) / 2;
    if ((avgTop - valley.price) / avgTop < 0.02) continue;

    if (H2.idx < candles.length - 20) continue;

    const lastClose = candles[candles.length - 2].close;
    return {
      pattern: "DOUBLE_TOP",
      direction: "bearish",
      confirmed: lastClose < valley.price,
      necklinePrice: valley.price,
    };
  }
  return null;
}

// ─── Double Bottom ───────────────────────────────────────────────────────────
function detectDoubleBottom(candles: CandleRaw[]): PatternResult | null {
  const lows  = findSwingLows(candles,  3, 60);
  const highs = findSwingHighs(candles, 3, 60);
  if (lows.length < 2) return null;

  for (let i = lows.length - 1; i >= 1; i--) {
    const L2 = lows[i];
    const L1 = lows[i - 1];

    const diff = Math.abs(L1.price - L2.price) / Math.max(L1.price, L2.price);
    if (diff > 0.025) continue;
    if (L2.idx - L1.idx < 5) continue;

    const peaks = highs.filter(h => h.idx > L1.idx && h.idx < L2.idx);
    if (peaks.length === 0) continue;
    const peak = peaks.reduce((a, b) => b.price > a.price ? b : a);

    const avgBottom = (L1.price + L2.price) / 2;
    if ((peak.price - avgBottom) / avgBottom < 0.02) continue;

    if (L2.idx < candles.length - 20) continue;

    const lastClose = candles[candles.length - 2].close;
    return {
      pattern: "DOUBLE_BOTTOM",
      direction: "bullish",
      confirmed: lastClose > peak.price,
      necklinePrice: peak.price,
    };
  }
  return null;
}

// ─── Main entry point ────────────────────────────────────────────────────────
// Runs all four detectors and returns the most relevant result.
// Priority: confirmed patterns first (H&S > Double Top for bearish;
// Inv H&S > Double Bottom for bullish). If only unconfirmed, returns first found.
export function detectReversalPattern(candles: CandleRaw[]): PatternResult | null {
  if (candles.length < 20) return null;

  const candidates: PatternResult[] = [];

  const hs = detectHS(candles);
  if (hs) candidates.push(hs);

  const ihs = detectIHS(candles);
  if (ihs) candidates.push(ihs);

  const dt = detectDoubleTop(candles);
  if (dt) candidates.push(dt);

  const db = detectDoubleBottom(candles);
  if (db) candidates.push(db);

  if (candidates.length === 0) return null;

  const confirmed = candidates.filter(c => c.confirmed);
  return confirmed.length > 0 ? confirmed[0] : candidates[0];
}
