// Chart pattern recognition — expanded multi-strategy detection.
//
// Exports:
//   detectChartPattern(candles)      — multi-bar patterns (H&S, triangles, wedges, flags)
//   detectCandlestickSignal(candles) — single/two-bar candlestick patterns
//
// Design principles:
//   • Pure functions — no side effects, no state.
//   • Only the most recent N bars are examined so patterns stay relevant.
//   • `confirmed` = key level broken on a CLOSED bar (wicks excluded).
//   • REVERSAL patterns (H&S, Double Top/Bottom): can veto signal entries when confirmed.
//   • CONTINUATION patterns (triangle, wedge, flag, pennant): reinforce direction only.
//   • CANDLESTICK patterns: final-bar confirmation notes only, never veto.
//   • Returns the single highest-priority result per call.

import type { CandleRaw } from "./yahoo-fetch";

export type PatternType =
  // Reversal patterns (veto-eligible when confirmed)
  | "HEAD_AND_SHOULDERS"
  | "INVERSE_HEAD_AND_SHOULDERS"
  | "DOUBLE_TOP"
  | "DOUBLE_BOTTOM"
  // Continuation / chart structure patterns (reinforce only)
  | "ASCENDING_TRIANGLE"
  | "DESCENDING_TRIANGLE"
  | "SYMMETRICAL_TRIANGLE"
  | "RISING_WEDGE"
  | "FALLING_WEDGE"
  | "BULL_FLAG"
  | "BEAR_FLAG"
  | "BULL_PENNANT"
  | "BEAR_PENNANT"
  // Candlestick patterns (final-bar confirmation)
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "HAMMER"
  | "SHOOTING_STAR";

export type PatternCategory = "reversal" | "continuation" | "candlestick";

export interface PatternResult {
  pattern:       PatternType;
  direction:     "bearish" | "bullish";
  confirmed:     boolean;
  necklinePrice: number;   // key break level / lower rail at the current bar
  upperBound?:   number;   // upper rail at the current bar (triangles, wedges, flags)
  category:      PatternCategory;
  // Start-of-pattern coordinates for drawing diagonal trendlines (triangles/wedges only).
  // Absent for single-rail patterns (H&S, double top/bottom) and candlestick patterns.
  necklineStartPrice?:   number; // lower rail price at patternStartDate
  upperBoundStartPrice?: number; // upper rail price at patternStartDate
  patternStartDate?:     string; // ISO date string of the earliest swing point
}

interface SwingPoint { idx: number; price: number; }

// ── Swing point finders ───────────────────────────────────────────────────────

function findSwingHighs(
  candles: CandleRaw[],
  strength = 3,
  lookback = 80,
): SwingPoint[] {
  const n = candles.length;
  const start = Math.max(strength, n - lookback);
  const end   = n - strength - 1;
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const h = candles[i].high;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].high >= h) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: h });
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
  const end   = n - strength - 1;
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const l = candles[i].low;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].low <= l) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: l });
  }
  return pts;
}

// ── Linear regression helpers ─────────────────────────────────────────────────

function linReg(pts: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = pts.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: pts[0].y };
  const meanX = pts.reduce((s, p) => s + p.x, 0) / n;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return { slope: den === 0 ? 0 : num / den, intercept: meanY - (den === 0 ? 0 : num / den) * meanX };
}

function evalAt(reg: { slope: number; intercept: number }, x: number): number {
  return reg.slope * x + reg.intercept;
}

// ── Reversal patterns (H&S family) ───────────────────────────────────────────

function detectHS(candles: CandleRaw[]): PatternResult | null {
  const highs = findSwingHighs(candles, 3, 80);
  const lows  = findSwingLows(candles,  3, 80);
  if (highs.length < 3) return null;

  for (let i = highs.length - 1; i >= 2; i--) {
    const H3 = highs[i], H2 = highs[i - 1], H1 = highs[i - 2];
    if (H2.price <= H1.price || H2.price <= H3.price) continue;
    const lowerShoulder = Math.min(H1.price, H3.price);
    if ((H2.price - lowerShoulder) / lowerShoulder < 0.02) continue;
    if (Math.abs(H1.price - H3.price) / Math.max(H1.price, H3.price) > 0.08) continue;
    const lt = lows.filter(l => l.idx > H1.idx && l.idx < H2.idx)
                   .reduce((a, b) => b.price < a.price ? b : a, { idx: -1, price: Infinity });
    const rt = lows.filter(l => l.idx > H2.idx && l.idx < H3.idx)
                   .reduce((a, b) => b.price < a.price ? b : a, { idx: -1, price: Infinity });
    if (lt.idx === -1 || rt.idx === -1) continue;
    if (H3.idx < candles.length - 20) continue;
    const neckline = (lt.price + rt.price) / 2;
    return {
      pattern: "HEAD_AND_SHOULDERS", direction: "bearish", category: "reversal",
      confirmed: candles[candles.length - 2].close < neckline,
      necklinePrice: neckline,
    };
  }
  return null;
}

function detectIHS(candles: CandleRaw[]): PatternResult | null {
  const lows  = findSwingLows(candles,  3, 80);
  const highs = findSwingHighs(candles, 3, 80);
  if (lows.length < 3) return null;

  for (let i = lows.length - 1; i >= 2; i--) {
    const L3 = lows[i], L2 = lows[i - 1], L1 = lows[i - 2];
    if (L2.price >= L1.price || L2.price >= L3.price) continue;
    const higherShoulder = Math.max(L1.price, L3.price);
    if ((higherShoulder - L2.price) / higherShoulder < 0.02) continue;
    if (Math.abs(L1.price - L3.price) / Math.max(L1.price, L3.price) > 0.08) continue;
    const lp = highs.filter(h => h.idx > L1.idx && h.idx < L2.idx)
                    .reduce((a, b) => b.price > a.price ? b : a, { idx: -1, price: -Infinity });
    const rp = highs.filter(h => h.idx > L2.idx && h.idx < L3.idx)
                    .reduce((a, b) => b.price > a.price ? b : a, { idx: -1, price: -Infinity });
    if (lp.idx === -1 || rp.idx === -1) continue;
    if (L3.idx < candles.length - 20) continue;
    const neckline = (lp.price + rp.price) / 2;
    return {
      pattern: "INVERSE_HEAD_AND_SHOULDERS", direction: "bullish", category: "reversal",
      confirmed: candles[candles.length - 2].close > neckline,
      necklinePrice: neckline,
    };
  }
  return null;
}

function detectDoubleTop(candles: CandleRaw[]): PatternResult | null {
  const highs = findSwingHighs(candles, 3, 60);
  const lows  = findSwingLows(candles,  3, 60);
  if (highs.length < 2) return null;

  for (let i = highs.length - 1; i >= 1; i--) {
    const H2 = highs[i], H1 = highs[i - 1];
    if (Math.abs(H1.price - H2.price) / Math.max(H1.price, H2.price) > 0.025) continue;
    if (H2.idx - H1.idx < 5) continue;
    const valleys = lows.filter(l => l.idx > H1.idx && l.idx < H2.idx);
    if (!valleys.length) continue;
    const valley = valleys.reduce((a, b) => b.price < a.price ? b : a);
    const avgTop = (H1.price + H2.price) / 2;
    if ((avgTop - valley.price) / avgTop < 0.02) continue;
    if (H2.idx < candles.length - 20) continue;
    return {
      pattern: "DOUBLE_TOP", direction: "bearish", category: "reversal",
      confirmed: candles[candles.length - 2].close < valley.price,
      necklinePrice: valley.price,
    };
  }
  return null;
}

function detectDoubleBottom(candles: CandleRaw[]): PatternResult | null {
  const lows  = findSwingLows(candles,  3, 60);
  const highs = findSwingHighs(candles, 3, 60);
  if (lows.length < 2) return null;

  for (let i = lows.length - 1; i >= 1; i--) {
    const L2 = lows[i], L1 = lows[i - 1];
    if (Math.abs(L1.price - L2.price) / Math.max(L1.price, L2.price) > 0.025) continue;
    if (L2.idx - L1.idx < 5) continue;
    const peaks = highs.filter(h => h.idx > L1.idx && h.idx < L2.idx);
    if (!peaks.length) continue;
    const peak = peaks.reduce((a, b) => b.price > a.price ? b : a);
    const avgBot = (L1.price + L2.price) / 2;
    if ((peak.price - avgBot) / avgBot < 0.02) continue;
    if (L2.idx < candles.length - 20) continue;
    return {
      pattern: "DOUBLE_BOTTOM", direction: "bullish", category: "reversal",
      confirmed: candles[candles.length - 2].close > peak.price,
      necklinePrice: peak.price,
    };
  }
  return null;
}

// ── Triangle patterns ─────────────────────────────────────────────────────────
// Uses strength=2 swing detection within a 50-bar window for more recent patterns.
// Slope thresholds normalised by avgPrice — scale-invariant across forex and crypto.
// "Flat"     = |slope| / avgPrice < 0.00020 per bar
// "Trending" = |slope| / avgPrice > 0.00035 per bar

function detectTriangles(candles: CandleRaw[]): PatternResult | null {
  const LOOKBACK = 50;
  const n = candles.length;
  if (n < 20) return null;

  const slice    = candles.slice(-LOOKBACK);
  const avgPrice = slice.reduce((s, c) => s + c.close, 0) / slice.length;
  const FLAT_T   = 0.00020 * avgPrice;
  const TREND_T  = 0.00035 * avgPrice;

  const highs = findSwingHighs(candles, 2, LOOKBACK);
  const lows  = findSwingLows(candles,  2, LOOKBACK);
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHigh = highs[highs.length - 1].idx;
  const lastLow  = lows[lows.length - 1].idx;
  if (Math.min(n - 1 - lastHigh, n - 1 - lastLow) > 15) return null;

  const topReg = linReg(highs.map(p => ({ x: p.idx, y: p.price })));
  const botReg = linReg(lows.map( p => ({ x: p.idx, y: p.price })));

  const cur       = n - 1;
  const topNow    = evalAt(topReg, cur);
  const bottomNow = evalAt(botReg, cur);
  if (topNow <= bottomNow) return null;

  // Trendlines must converge (apex in the future, not already crossed)
  if (botReg.slope <= topReg.slope) return null;

  const lastClose = candles[n - 2].close;

  // Start coordinates for diagonal trendline rendering on the frontend.
  // Use the earliest swing point as the left anchor of both rails.
  const startIdx        = Math.min(highs[0].idx, lows[0].idx);
  const topStart        = evalAt(topReg, startIdx);
  const bottomStart     = evalAt(botReg, startIdx);
  const patternStartDate = candles[startIdx]?.date;

  // Ascending: flat top + rising bottom → bullish
  if (Math.abs(topReg.slope) < FLAT_T && botReg.slope > TREND_T) {
    return {
      pattern: "ASCENDING_TRIANGLE", direction: "bullish", category: "continuation",
      confirmed: lastClose > topNow,
      necklinePrice: +bottomNow.toFixed(10),
      upperBound:    +topNow.toFixed(10),
      necklineStartPrice:   +bottomStart.toFixed(10),
      upperBoundStartPrice: +topStart.toFixed(10),
      patternStartDate,
    };
  }

  // Descending: falling top + flat bottom → bearish
  if (topReg.slope < -FLAT_T && Math.abs(botReg.slope) < FLAT_T) {
    return {
      pattern: "DESCENDING_TRIANGLE", direction: "bearish", category: "continuation",
      confirmed: lastClose < bottomNow,
      necklinePrice: +bottomNow.toFixed(10),
      upperBound:    +topNow.toFixed(10),
      necklineStartPrice:   +bottomStart.toFixed(10),
      upperBoundStartPrice: +topStart.toFixed(10),
      patternStartDate,
    };
  }

  // Symmetrical: top falling + bottom rising, both meaningful slopes.
  // Direction is strictly neutral until a closed-bar breakout confirms direction.
  // No result is emitted for the forming state — an unconfirmed symmetrical triangle
  // carries zero directional bias and must not reinforce either BUY or SELL signals.
  if (topReg.slope < -TREND_T && botReg.slope > TREND_T) {
    const breakBull = lastClose > topNow;
    const breakBear = lastClose < bottomNow;
    if (!breakBull && !breakBear) return null; // neutral until breakout — emit nothing
    return {
      pattern: "SYMMETRICAL_TRIANGLE",
      direction: breakBull ? "bullish" : "bearish",
      category: "continuation",
      confirmed: true, // only reachable after a confirmed break
      necklinePrice: +bottomNow.toFixed(10),
      upperBound:    +topNow.toFixed(10),
      necklineStartPrice:   +bottomStart.toFixed(10),
      upperBoundStartPrice: +topStart.toFixed(10),
      patternStartDate,
    };
  }

  return null;
}

// ── Wedge patterns ────────────────────────────────────────────────────────────
// Rising wedge (bearish):  both rails slope up, lower rail steeper → they converge.
// Falling wedge (bullish): both rails slope down, upper rail steeper → they converge.
// Requires strength=3 swings (stricter than triangles) to avoid noise.

function detectWedges(candles: CandleRaw[]): PatternResult | null {
  const LOOKBACK = 50;
  const n = candles.length;
  if (n < 20) return null;

  const slice    = candles.slice(-LOOKBACK);
  const avgPrice = slice.reduce((s, c) => s + c.close, 0) / slice.length;
  const MIN_S    = 0.00025 * avgPrice; // minimum meaningful slope

  const highs = findSwingHighs(candles, 3, LOOKBACK);
  const lows  = findSwingLows(candles,  3, LOOKBACK);
  if (highs.length < 3 || lows.length < 3) return null;

  const lastHigh = highs[highs.length - 1].idx;
  const lastLow  = lows[lows.length - 1].idx;
  if (Math.min(n - 1 - lastHigh, n - 1 - lastLow) > 15) return null;

  const topReg = linReg(highs.map(p => ({ x: p.idx, y: p.price })));
  const botReg = linReg(lows.map( p => ({ x: p.idx, y: p.price })));

  const cur       = n - 1;
  const topNow    = evalAt(topReg, cur);
  const bottomNow = evalAt(botReg, cur);
  if (topNow <= bottomNow) return null;

  const lastClose = candles[n - 2].close;

  // Start coordinates for diagonal trendline rendering on the frontend.
  const startIdx        = Math.min(highs[0].idx, lows[0].idx);
  const topStart        = evalAt(topReg, startIdx);
  const bottomStart     = evalAt(botReg, startIdx);
  const patternStartDate = candles[startIdx]?.date;

  // Rising wedge: both slopes positive, bottom slope exceeds top slope
  if (topReg.slope > MIN_S && botReg.slope > MIN_S && botReg.slope > topReg.slope * 1.15) {
    return {
      pattern: "RISING_WEDGE", direction: "bearish", category: "continuation",
      confirmed: lastClose < bottomNow,
      necklinePrice: +bottomNow.toFixed(10),
      upperBound:    +topNow.toFixed(10),
      necklineStartPrice:   +bottomStart.toFixed(10),
      upperBoundStartPrice: +topStart.toFixed(10),
      patternStartDate,
    };
  }

  // Falling wedge: both slopes negative, top slope more negative than bottom
  if (topReg.slope < -MIN_S && botReg.slope < -MIN_S && topReg.slope < botReg.slope * 1.15) {
    return {
      pattern: "FALLING_WEDGE", direction: "bullish", category: "continuation",
      confirmed: lastClose > topNow,
      necklinePrice: +bottomNow.toFixed(10),
      upperBound:    +topNow.toFixed(10),
      necklineStartPrice:   +bottomStart.toFixed(10),
      upperBoundStartPrice: +topStart.toFixed(10),
      patternStartDate,
    };
  }

  return null;
}

// ── Flag and Pennant patterns ─────────────────────────────────────────────────
// Pole:  ≥3% directional move over 3–10 bars.
// Consolidation: 5–20 bars of tight range (≤50% of pole) directly after the pole.
// Pennant: consolidation highs falling + lows rising (converging).
// Flag:    otherwise (roughly parallel or slight counter-trend channel).
// Confirmed when the last completed bar closes beyond the consolidation boundary.

function detectFlagsPennants(candles: CandleRaw[]): PatternResult | null {
  const n = candles.length;
  if (n < 18) return null;

  const LOOKBACK     = 40;
  const MIN_POLE_PCT = 0.03;
  const MAX_POLE_LEN = 10;
  const MIN_CONSOL   = 5;
  const MAX_CONSOL   = 20;

  const windowStart = Math.max(0, n - LOOKBACK);

  for (
    let poleEnd = n - MIN_CONSOL - 2;
    poleEnd >= windowStart + 3;
    poleEnd--
  ) {
    for (
      let poleStart = Math.max(windowStart, poleEnd - MAX_POLE_LEN);
      poleStart < poleEnd - 2;
      poleStart++
    ) {
      const poleOpen  = candles[poleStart].open;
      const poleClose = candles[poleEnd].close;
      const poleMagnitude = (poleClose - poleOpen) / poleOpen;

      const isBullPole = poleMagnitude >  MIN_POLE_PCT;
      const isBearPole = poleMagnitude < -MIN_POLE_PCT;
      if (!isBullPole && !isBearPole) continue;

      // Consolidation: bars immediately after the pole, up to (but NOT including) the
      // breakout bar (n-2). This is critical for confirmation geometry: maxH/minL must
      // be computed from pre-breakout bars only, so that `lastClose > maxH` (bull) or
      // `lastClose < minL` (bear) is geometrically achievable (close ≤ high on the same
      // bar, so including the breakout bar in the bounds makes confirmation impossible).
      const consolStart = poleEnd + 1;
      const consolEnd   = n - 3; // stop BEFORE the breakout bar (n-2)
      const consolLen   = consolEnd - consolStart + 1;
      if (consolLen < MIN_CONSOL || consolLen > MAX_CONSOL) continue;

      const consolSlice = candles.slice(consolStart, consolEnd + 1); // excludes bar n-2
      const maxH = consolSlice.reduce((m, c) => Math.max(m, c.high),  -Infinity);
      const minL = consolSlice.reduce((m, c) => Math.min(m, c.low),    Infinity);
      const poleMax = candles.slice(poleStart, poleEnd + 1)
                              .reduce((m, c) => Math.max(m, c.high), -Infinity);
      const poleMin = candles.slice(poleStart, poleEnd + 1)
                              .reduce((m, c) => Math.min(m, c.low),   Infinity);
      const poleRange   = poleMax - poleMin;
      const consolRange = maxH - minL;

      // Consolidation must be tight relative to the pole
      if (poleRange <= 0 || consolRange > poleRange * 0.55) continue;

      // Consolidation must retrace counter to the pole (pullback into the pole)
      if (isBullPole && consolSlice[consolSlice.length - 1].close >= poleMax) continue;
      if (isBearPole && consolSlice[consolSlice.length - 1].close <= poleMin) continue;

      // Bar n-2 is the candidate breakout bar — its close is compared against pre-breakout channel
      const lastClose = candles[n - 2].close;

      // Determine flag vs pennant via regression on the consolidation highs/lows
      const topReg = linReg(consolSlice.map((c, i) => ({ x: i, y: c.high })));
      const botReg = linReg(consolSlice.map((c, i) => ({ x: i, y: c.low  })));
      const isPennant = topReg.slope < -0.00001 && botReg.slope > 0.00001;

      if (isBullPole) {
        return {
          pattern: isPennant ? "BULL_PENNANT" : "BULL_FLAG",
          direction: "bullish", category: "continuation",
          confirmed: lastClose > maxH,
          necklinePrice: +minL.toFixed(10),
          upperBound:    +maxH.toFixed(10),
        };
      } else {
        return {
          pattern: isPennant ? "BEAR_PENNANT" : "BEAR_FLAG",
          direction: "bearish", category: "continuation",
          confirmed: lastClose < minL,
          necklinePrice: +minL.toFixed(10),
          upperBound:    +maxH.toFixed(10),
        };
      }
    }
  }
  return null;
}

// ── Candlestick patterns ──────────────────────────────────────────────────────
// Examines only the most recent 2 completed bars.
// Candlestick patterns are always `confirmed: true` (they are past-close signals).

export function detectCandlestickSignal(candles: CandleRaw[]): PatternResult | null {
  const n = candles.length;
  if (n < 3) return null;

  const cur  = candles[n - 2]; // most recent completed bar
  const prev = candles[n - 3];

  const curBody  = Math.abs(cur.close  - cur.open);
  const prevBody = Math.abs(prev.close - prev.open);
  const curRange = cur.high - cur.low;
  if (curBody === 0 || curRange === 0) return null;

  const curBull  = cur.close  > cur.open;
  const prevBull = prev.close > prev.open;

  // Bullish engulfing: current bullish bar body fully contains previous bearish bar body
  if (curBull && !prevBull && prevBody > 0 &&
      cur.open < prev.close && cur.close > prev.open) {
    return {
      pattern: "BULLISH_ENGULFING", direction: "bullish", category: "candlestick",
      confirmed: true, necklinePrice: cur.low,
    };
  }

  // Bearish engulfing: current bearish bar body fully contains previous bullish bar body
  if (!curBull && prevBull && prevBody > 0 &&
      cur.open > prev.close && cur.close < prev.open) {
    return {
      pattern: "BEARISH_ENGULFING", direction: "bearish", category: "candlestick",
      confirmed: true, necklinePrice: cur.high,
    };
  }

  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);

  // Hammer: small body at top of range, long lower wick (≥55% of range),
  // tiny upper wick (≤15% of range), preceded by a downtrend.
  if (
    curBody / curRange < 0.35 &&
    lowerWick / curRange >= 0.55 &&
    upperWick / curRange <= 0.15
  ) {
    const contextBar = candles[Math.max(0, n - 7)];
    if (contextBar.close > cur.close) {
      return {
        pattern: "HAMMER", direction: "bullish", category: "candlestick",
        confirmed: true, necklinePrice: cur.low,
      };
    }
  }

  // Shooting star: small body at bottom of range, long upper wick (≥55% of range),
  // tiny lower wick (≤15% of range), preceded by an uptrend.
  if (
    curBody / curRange < 0.35 &&
    upperWick / curRange >= 0.55 &&
    lowerWick / curRange <= 0.15
  ) {
    const contextBar = candles[Math.max(0, n - 7)];
    if (contextBar.close < cur.close) {
      return {
        pattern: "SHOOTING_STAR", direction: "bearish", category: "candlestick",
        confirmed: true, necklinePrice: cur.high,
      };
    }
  }

  return null;
}

// ── Main entry points ─────────────────────────────────────────────────────────

// Returns the single highest-priority multi-bar chart pattern.
// Priority: confirmed > forming; reversal > continuation (by sort order).
// Within the same tier: H&S > Double > Triangle > Wedge > Flag/Pennant.
export function detectChartPattern(candles: CandleRaw[]): PatternResult | null {
  if (candles.length < 20) return null;

  const candidates: PatternResult[] = [];

  const hs  = detectHS(candles);              if (hs)  candidates.push(hs);
  const ihs = detectIHS(candles);             if (ihs) candidates.push(ihs);
  const dt  = detectDoubleTop(candles);       if (dt)  candidates.push(dt);
  const db  = detectDoubleBottom(candles);    if (db)  candidates.push(db);
  const tri = detectTriangles(candles);       if (tri) candidates.push(tri);
  const wdg = detectWedges(candles);          if (wdg) candidates.push(wdg);
  const flg = detectFlagsPennants(candles);   if (flg) candidates.push(flg);

  if (candidates.length === 0) return null;

  const catOrder: Record<PatternCategory, number> = { reversal: 0, continuation: 1, candlestick: 2 };
  candidates.sort((a, b) => {
    if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
    return catOrder[a.category] - catOrder[b.category];
  });

  return candidates[0];
}
