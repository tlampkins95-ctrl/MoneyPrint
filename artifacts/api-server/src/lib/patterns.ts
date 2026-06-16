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
  necklinePrice: number;   // key break level / lower rail at the last completed bar (n-2)
  upperBound?:   number;   // upper rail at the last completed bar (n-2) for two-rail patterns
  category:      PatternCategory;
  // Diagonal trendline coordinates (triangles, wedges, flags, pennants).
  // Absent for single-rail patterns (H&S, double top/bottom) and candlestick patterns.
  necklineStartPrice?:   number; // lower rail price at patternStartDate (left anchor)
  upperBoundStartPrice?: number; // upper rail price at patternStartDate (left anchor)
  patternStartDate?:     string; // ISO date of the earliest swing point (left anchor)
  patternEndDate?:       string; // ISO date of the last completed bar (n-2) (right anchor)
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
    // Head must stick out at least 5% above shoulders (was 2% — too loose)
    if ((H2.price - lowerShoulder) / lowerShoulder < 0.05) continue;
    // Shoulders must be within 8% of each other in price
    if (Math.abs(H1.price - H3.price) / Math.max(H1.price, H3.price) > 0.08) continue;
    // Pattern must span at least 15 bars so it's a real formation not noise
    if (H3.idx - H1.idx < 15) continue;
    const lt = lows.filter(l => l.idx > H1.idx && l.idx < H2.idx)
                   .reduce((a, b) => b.price < a.price ? b : a, { idx: -1, price: Infinity });
    const rt = lows.filter(l => l.idx > H2.idx && l.idx < H3.idx)
                   .reduce((a, b) => b.price < a.price ? b : a, { idx: -1, price: Infinity });
    if (lt.idx === -1 || rt.idx === -1) continue;
    // Neckline valleys must be at similar depths (within 5%) — prevents lopsided patterns
    if (Math.abs(lt.price - rt.price) / Math.max(lt.price, rt.price) > 0.05) continue;
    // Right shoulder must be recent (within 15 bars)
    if (H3.idx < candles.length - 15) continue;
    const neckline = (lt.price + rt.price) / 2;
    // Confirmation requires closing BELOW the lower of the two neckline valleys
    // (not just the average). Prevents a borderline bar near the valley mid-point
    // from triggering a false confirmation.
    const necklineBreakLevel = Math.min(lt.price, rt.price);
    // upperBound = head price (the highest point, above neckline).
    // Chart shows it as "H&S Head". Measured-move target = 2*neckline - head.
    return {
      pattern: "HEAD_AND_SHOULDERS", direction: "bearish", category: "reversal",
      confirmed: candles[candles.length - 2].close < necklineBreakLevel,
      necklinePrice: +neckline.toFixed(10),
      upperBound:    +H2.price.toFixed(10),
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
    // Head must dip at least 5% below shoulders (was 2% — too loose)
    if ((higherShoulder - L2.price) / higherShoulder < 0.05) continue;
    // Shoulders must be within 8% of each other in price
    if (Math.abs(L1.price - L3.price) / Math.max(L1.price, L3.price) > 0.08) continue;
    // Pattern must span at least 15 bars so it's a real formation not noise
    if (L3.idx - L1.idx < 15) continue;
    const lp = highs.filter(h => h.idx > L1.idx && h.idx < L2.idx)
                    .reduce((a, b) => b.price > a.price ? b : a, { idx: -1, price: -Infinity });
    const rp = highs.filter(h => h.idx > L2.idx && h.idx < L3.idx)
                    .reduce((a, b) => b.price > a.price ? b : a, { idx: -1, price: -Infinity });
    if (lp.idx === -1 || rp.idx === -1) continue;
    // Neckline peaks must be at similar heights (within 5%) — key structural rule.
    // Without this a double-top's two peaks become a "neckline" and the lows below
    // get falsely read as an IHS shoulder-head-shoulder structure.
    if (Math.abs(lp.price - rp.price) / Math.max(lp.price, rp.price) > 0.05) continue;
    // Right shoulder must be recent (within 15 bars)
    if (L3.idx < candles.length - 15) continue;
    const neckline = (lp.price + rp.price) / 2;
    // Confirmation requires closing ABOVE the higher of the two neckline peaks
    // (not just the average). In a double-top scenario price sits at the second
    // peak (~= max(lp, rp)), so requiring close > max ensures it has genuinely
    // cleared both anchors — not just slightly above the midpoint.
    const necklineBreakLevel = Math.max(lp.price, rp.price);
    // upperBound = classic measured-move target: neckline + (neckline - head).
    // Chart shows it as "IHS Target". SL for pattern entry = below neckline.
    const measuredTarget = neckline + (neckline - L2.price);
    return {
      pattern: "INVERSE_HEAD_AND_SHOULDERS", direction: "bullish", category: "reversal",
      confirmed: candles[candles.length - 2].close > necklineBreakLevel,
      necklinePrice: +neckline.toFixed(10),
      upperBound:    +measuredTarget.toFixed(10),
    };
  }
  return null;
}

// ── Volume confirmation helpers ───────────────────────────────────────────────
// Returns the 20-bar SMA of volume ending at `idx` (or fewer bars if near start).
function vol20MA(candles: CandleRaw[], idx: number): number {
  const start = Math.max(0, idx - 19);
  const slice = candles.slice(start, idx + 1);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

// Average volume in a ±2 bar window centred on `idx` — smooths single-bar spikes.
function volAtPeak(candles: CandleRaw[], idx: number): number {
  const start = Math.max(0, idx - 2);
  const end   = Math.min(candles.length - 1, idx + 2);
  const slice = candles.slice(start, end + 1);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

function detectDoubleTop(candles: CandleRaw[]): PatternResult | null {
  const highs = findSwingHighs(candles, 3, 60);
  const lows  = findSwingLows(candles,  3, 60);
  if (highs.length < 2) return null;

  for (let i = highs.length - 1; i >= 1; i--) {
    const H2 = highs[i], H1 = highs[i - 1];
    // Two peaks within 1.5% of each other (tighter than 2.5% to avoid noise)
    if (Math.abs(H1.price - H2.price) / Math.max(H1.price, H2.price) > 0.015) continue;
    // Must be at least 20 bars apart so the two peaks are visually distinct
    if (H2.idx - H1.idx < 20) continue;
    const valleys = lows.filter(l => l.idx > H1.idx && l.idx < H2.idx);
    if (!valleys.length) continue;
    const valley = valleys.reduce((a, b) => b.price < a.price ? b : a);
    const avgTop = (H1.price + H2.price) / 2;
    // Valley must be at least 4% below the tops — shallow dips are just noise
    if ((avgTop - valley.price) / avgTop < 0.04) continue;
    if (H2.idx < candles.length - 20) continue;
    // Volume confirmation: left peak must have a higher vol/20MA ratio than right peak.
    // Fail-open when volume data is absent (e.g. forex with no volume).
    const ma1 = vol20MA(candles, H1.idx), ma2 = vol20MA(candles, H2.idx);
    if (ma1 > 0 && ma2 > 0) {
      const r1 = volAtPeak(candles, H1.idx) / ma1;
      const r2 = volAtPeak(candles, H2.idx) / ma2;
      if (r1 <= r2) continue; // left peak must be relatively MORE active
    }
    return {
      pattern: "DOUBLE_TOP", direction: "bearish", category: "reversal",
      confirmed: candles[candles.length - 2].close < valley.price,
      necklinePrice:   +valley.price.toFixed(10),
      upperBound:      +avgTop.toFixed(10),
      patternStartDate: candles[H1.idx]?.date,
      patternEndDate:   candles[H2.idx]?.date,
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
    // Two troughs within 1.5% of each other
    if (Math.abs(L1.price - L2.price) / Math.max(L1.price, L2.price) > 0.015) continue;
    // Must be at least 20 bars apart so the two troughs are visually distinct
    if (L2.idx - L1.idx < 20) continue;
    const peaks = highs.filter(h => h.idx > L1.idx && h.idx < L2.idx);
    if (!peaks.length) continue;
    const peak = peaks.reduce((a, b) => b.price > a.price ? b : a);
    const avgBot = (L1.price + L2.price) / 2;
    // Peak between them must be at least 4% above the troughs
    if ((peak.price - avgBot) / avgBot < 0.04) continue;
    if (L2.idx < candles.length - 20) continue;
    // Volume confirmation: left trough must have a higher vol/20MA ratio than right trough.
    // Fail-open when volume data is absent (e.g. forex with no volume).
    const ma1 = vol20MA(candles, L1.idx), ma2 = vol20MA(candles, L2.idx);
    if (ma1 > 0 && ma2 > 0) {
      const r1 = volAtPeak(candles, L1.idx) / ma1;
      const r2 = volAtPeak(candles, L2.idx) / ma2;
      if (r1 <= r2) continue; // left trough must be relatively MORE active (capitulation)
    }
    return {
      pattern: "DOUBLE_BOTTOM", direction: "bullish", category: "reversal",
      confirmed: candles[candles.length - 2].close > peak.price,
      necklinePrice:    +peak.price.toFixed(10),
      upperBound:       +avgBot.toFixed(10),
      patternStartDate:  candles[L1.idx]?.date,
      patternEndDate:    candles[L2.idx]?.date,
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
  const SYM_T    = 0.00010 * avgPrice; // lenient threshold for symmetrical pattern

  const highs = findSwingHighs(candles, 2, LOOKBACK);
  const lows  = findSwingLows(candles,  2, LOOKBACK);
  if (highs.length < 2 || lows.length < 2) return null;

  if (Math.min(n - 1 - highs[highs.length - 1].idx, n - 1 - lows[lows.length - 1].idx) > 15) return null;

  // ── Upper rail selection ────────────────────────────────────────────────────
  // Use the LAST DECLINING consecutive pair of swing highs for the upper rail.
  // This correctly ignores any final "breakout spike" highs (where the most recent
  // high is above the prior high and therefore above the pattern's upper rail).
  // Walk backwards through highs to find the most recent pair where h[i] > h[i+1].
  let topH1 = highs[0];
  let topH2 = highs[Math.min(1, highs.length - 1)];
  {
    let found = false;
    for (let i = highs.length - 2; i >= 0; i--) {
      if (highs[i].price > highs[i + 1].price) { // declining pair ✓
        topH1 = highs[i];
        topH2 = highs[i + 1];
        found = true;
        break;
      }
    }
    // No declining pair → all highs are rising; use first & last for ascending check
    if (!found) {
      topH1 = highs[0];
      topH2 = highs[highs.length - 1];
    }
  }

  // ── Lower rail: lowest swing low → last swing low ───────────────────────────
  // Using lows[0] (the first in the lookback window) can give a high-priced
  // preliminary dip that sits ABOVE later lows (e.g. a March 9 bounce before the
  // big March 23 crash), producing a negative botSlope and corrupting the
  // triangle shape.  The MINIMUM-price swing low is always the real trough.
  const botL1 = lows.reduce((mn, p) => p.price < mn.price ? p : mn, lows[0]);
  const botL2 = lows[lows.length - 1];
  // If the minimum low is NOT before the last low, the formation is still falling
  // — no converging lower rail can be established.
  if (botL1.idx >= botL2.idx) return null;
  if (topH2.idx === topH1.idx || botL2.idx === botL1.idx) return null;

  const topSlope = (topH2.price - topH1.price) / (topH2.idx - topH1.idx);
  const botSlope = (botL2.price - botL1.price) / (botL2.idx - botL1.idx);
  const evalTop  = (idx: number) => topH1.price + topSlope * (idx - topH1.idx);
  const evalBot  = (idx: number) => botL1.price + botSlope * (idx - botL1.idx);

  // Rails must converge (bot slope > top slope → they'll meet in the future).
  if (botSlope <= topSlope) return null;

  // ── Apex: compute where the two rails cross ─────────────────────────────────
  // evalTop(apex) = evalBot(apex)  →  solve for apex bar index.
  const apexBar = (botL1.price - topH1.price + topSlope * topH1.idx - botSlope * botL1.idx)
                / (topSlope - botSlope);
  // Apex must come after all anchor points (rails can't cross before the pattern ends).
  const lastAnchorBar = Math.max(topH1.idx, topH2.idx, botL1.idx, botL2.idx);
  if (apexBar < lastAnchorBar) return null;
  // Pattern is stale if the apex was more than 20 bars ago.
  if ((n - 1) - apexBar > 20) return null;

  // ── Display endpoints ───────────────────────────────────────────────────────
  // Right end: whichever comes first — the apex bar or n-2 (last completed bar).
  // Drawing the lines up to the apex makes the triangle shape visually correct.
  const displayEnd       = Math.min(Math.floor(apexBar), n - 2);
  const startIdx         = Math.min(topH1.idx, botL1.idx);
  const topStart         = evalTop(startIdx);
  const bottomStart      = evalBot(startIdx);
  const topNow           = evalTop(displayEnd);
  const bottomNow        = evalBot(displayEnd);
  const patternStartDate = candles[startIdx]?.date;
  const patternEndDate   = candles[displayEnd]?.date;

  // ── Breakout check: scan candles from last anchor to n-2 ──────────────────
  // Track the FIRST bar where price crossed the rail so we can expire stale
  // confirmed patterns. A triangle that broke out 10+ days ago is no longer
  // an actionable setup — clear it so it doesn't clutter the chart.
  const cur = n - 2;
  const NO_BREAK = cur + 1; // sentinel: no breakout found
  let breakBullBar = NO_BREAK;
  let breakBearBar = NO_BREAK;
  for (let bi = lastAnchorBar; bi <= cur; bi++) {
    if (candles[bi].close > evalTop(bi) && breakBullBar === NO_BREAK) breakBullBar = bi;
    if (candles[bi].close < evalBot(bi) && breakBearBar === NO_BREAK) breakBearBar = bi;
  }
  const breakBull = breakBullBar <= cur;
  const breakBear = breakBearBar <= cur;

  // Expire the pattern 2 bars after the breakout bar.
  // Pattern stays visible for the breakout bar + 2 more for context, then clears.
  // (2 bars = 2 days on 1D, 2 hours on 1H, 1 hour on 30m.)
  const BREAKOUT_STALE_BARS = 2;
  if (breakBull || breakBear) {
    const firstBreakBar = Math.min(breakBullBar, breakBearBar);
    if (cur - firstBreakBar > BREAKOUT_STALE_BARS) return null;
  }
  const breakDir: "bullish" | "bearish" = breakBull ? "bullish" : "bearish";

  const base = {
    category:             "continuation" as PatternCategory,
    necklinePrice:        +bottomNow.toFixed(10),
    upperBound:           +topNow.toFixed(10),
    necklineStartPrice:   +bottomStart.toFixed(10),
    upperBoundStartPrice: +topStart.toFixed(10),
    patternStartDate,
    patternEndDate,
  };

  // Ascending: flat top + rising bottom → bullish
  if (Math.abs(topSlope) < FLAT_T && botSlope > TREND_T) {
    return { ...base, pattern: "ASCENDING_TRIANGLE",  direction: "bullish",  confirmed: breakBull };
  }

  // Descending: falling top + flat bottom → bearish
  if (topSlope < -FLAT_T && Math.abs(botSlope) < FLAT_T) {
    return { ...base, pattern: "DESCENDING_TRIANGLE", direction: "bearish",  confirmed: breakBear };
  }

  // Symmetrical: top falling + bottom rising (lenient SYM_T threshold).
  // Confirmed when price has broken through either rail after the last anchor.
  if (topSlope < -SYM_T && botSlope > SYM_T) {
    return {
      ...base,
      pattern:   "SYMMETRICAL_TRIANGLE",
      direction: (breakBull || breakBear) ? breakDir : "bullish",
      confirmed: breakBull || breakBear,
    };
  }

  return null;
}

// ── Wedge patterns ────────────────────────────────────────────────────────────
// Rising wedge (bearish):  both rails slope up, lower rail steeper → they converge.
// Falling wedge (bullish): both rails slope down, upper rail steeper → they converge.
// Requires strength=3 swings (stricter than triangles) to avoid noise.
//
// Anchor selection: finds the MOST RECENT valid pair of swing points such that
// the trendline between them does NOT pierce any intermediate candle.
// "lower" rail validity: no candle.low between anchors falls below the line.
// "upper" rail validity: no candle.high between anchors rises above the line.
// This prevents the classic "line drawn through price" visual bug.
//
// Staleness: same BREAKOUT_STALE_BARS expiry as triangles — confirmed wedge
// clears after N bars so stale breakouts don't linger on the chart.

function detectWedges(candles: CandleRaw[]): PatternResult | null {
  const LOOKBACK            = 100;
  const BREAKOUT_STALE_BARS = 3;
  const MIN_SPAN_BARS       = 10; // anchors must be at least 10 bars apart
  const n = candles.length;
  if (n < 20) return null;

  const slice    = candles.slice(-LOOKBACK);
  const avgPrice = slice.reduce((s, c) => s + c.close, 0) / slice.length;
  const MIN_S    = 0.00025 * avgPrice;
  // Absolute wick tolerance: candles may poke the rail by up to 0.15% of avg price.
  const TOL      = 0.0015 * avgPrice;

  const highs = findSwingHighs(candles, 3, LOOKBACK);
  const lows  = findSwingLows(candles,  3, LOOKBACK);
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHighIdx = highs[highs.length - 1].idx;
  const lastLowIdx  = lows[lows.length - 1].idx;
  if (Math.min(n - 1 - lastHighIdx, n - 1 - lastLowIdx) > 15) return null;

  const cur = n - 2;

  // Returns true when no candle between a1 and a2 (exclusive) pierces the
  // trendline connecting them.
  // "lower": candle.low must stay >= line - TOL  (lower rail = support)
  // "upper": candle.high must stay <= line + TOL (upper rail = resistance)
  const isClean = (
    a1: SwingPoint, a2: SwingPoint, side: "lower" | "upper",
  ): boolean => {
    const span  = a2.idx - a1.idx;
    if (span <= 0) return false;
    const slope = (a2.price - a1.price) / span;
    for (let k = a1.idx + 1; k < a2.idx; k++) {
      const line = a1.price + slope * (k - a1.idx);
      if (side === "lower" && candles[k].low  < line - TOL) return false;
      if (side === "upper" && candles[k].high > line + TOL) return false;
    }
    return true;
  };

  // Scans pts from most-recent backward to find the first pair (P1, P2) where:
  //   • P1.idx < P2.idx, span ≥ MIN_SPAN_BARS
  //   • direction matches (rising = P2 > P1, declining = P2 < P1)
  //   • trendline from P1→P2 doesn't pierce any intermediate candle on `side`
  // Returns the most recent valid pair, or null if none found.
  const bestPair = (
    pts: SwingPoint[],
    dir: "rising" | "declining",
    side: "lower" | "upper",
  ): [SwingPoint, SwingPoint] | null => {
    for (let j = pts.length - 1; j >= 1; j--) {
      const P2 = pts[j];
      for (let i = j - 1; i >= 0; i--) {
        const P1 = pts[i];
        if (dir === "rising"    && P2.price <= P1.price) continue;
        if (dir === "declining" && P2.price >= P1.price) continue;
        if (P2.idx - P1.idx < MIN_SPAN_BARS) continue;
        if (isClean(P1, P2, side)) return [P1, P2];
      }
    }
    return null;
  };

  // ── Falling wedge (bullish) ─────────────────────────────────────────────────
  // Upper rail: most recent valid declining pair of swing highs.
  // Lower rail: most recent valid declining pair of swing lows, slower decline.
  {
    const topPair = bestPair(highs, "declining", "upper");
    if (topPair) {
      const [tH1, tH2] = topPair;
      const tSlope = (tH2.price - tH1.price) / (tH2.idx - tH1.idx);
      const evalT  = (i: number) => tH1.price + tSlope * (i - tH1.idx);

      const postLows = lows.filter(l => l.idx >= tH1.idx);
      const botPair  = bestPair(postLows, "declining", "lower");
      if (botPair) {
        const [bL1, bL2] = botPair;
        const bSlope = (bL2.price - bL1.price) / (bL2.idx - bL1.idx);
        const evalB  = (i: number) => bL1.price + bSlope * (i - bL1.idx);
        const topNow = evalT(cur);
        const botNow = evalB(cur);

        // Both slope down; upper steeper than lower → they converge.
        if (topNow > botNow && tSlope < -MIN_S && bSlope < -MIN_S && tSlope < bSlope * 1.15) {
          const startIdx = Math.min(tH1.idx, bL1.idx);
          // Breakout: close above upper rail; scan from the last anchor bar forward.
          const scanFrom = Math.max(tH2.idx, bL2.idx);
          let brkBar = cur + 1;
          for (let bi = scanFrom; bi <= cur; bi++) {
            if (candles[bi].close > evalT(bi)) { brkBar = bi; break; }
          }
          const broke = brkBar <= cur;
          if (broke && cur - brkBar > BREAKOUT_STALE_BARS) return null;
          // Invalidate if live bar (n-1) closed BELOW the lower rail — the pattern
          // broke in the wrong direction (bearish, not bullish continuation).
          if (candles[n - 1].close < evalB(n - 1)) return null;
          return {
            pattern: "FALLING_WEDGE", direction: "bullish", category: "continuation",
            confirmed: broke,
            necklinePrice:        +botNow.toFixed(10),
            upperBound:           +topNow.toFixed(10),
            necklineStartPrice:   +evalB(startIdx).toFixed(10),
            upperBoundStartPrice: +evalT(startIdx).toFixed(10),
            patternStartDate: candles[startIdx]?.date,
            patternEndDate:   candles[cur]?.date,
          };
        }
      }
    }
  }

  // ── Rising wedge (bearish) ──────────────────────────────────────────────────
  // Lower rail: most recent valid rising pair of swing lows (steeper slope).
  // Upper rail: most recent valid rising pair of swing highs (shallower slope).
  {
    const botPair = bestPair(lows, "rising", "lower");
    if (botPair) {
      const [bL1, bL2] = botPair;
      const bSlope = (bL2.price - bL1.price) / (bL2.idx - bL1.idx);
      const evalB  = (i: number) => bL1.price + bSlope * (i - bL1.idx);

      const postHighs = highs.filter(h => h.idx >= bL1.idx);
      const topPair   = bestPair(postHighs, "rising", "upper");
      if (topPair) {
        const [tH1, tH2] = topPair;
        const tSlope = (tH2.price - tH1.price) / (tH2.idx - tH1.idx);
        const evalT  = (i: number) => tH1.price + tSlope * (i - tH1.idx);
        const topNow = evalT(cur);
        const botNow = evalB(cur);

        // Both slope up; lower steeper than upper → they converge.
        if (topNow > botNow && bSlope > MIN_S && tSlope > MIN_S && bSlope > tSlope * 1.15) {
          const startIdx = Math.min(bL1.idx, tH1.idx);
          // Breakout: close below lower rail; scan from the last anchor bar forward.
          const scanFrom = Math.max(bL2.idx, tH2.idx);
          let brkBar = cur + 1;
          for (let bi = scanFrom; bi <= cur; bi++) {
            if (candles[bi].close < evalB(bi)) { brkBar = bi; break; }
          }
          const broke = brkBar <= cur;
          if (broke && cur - brkBar > BREAKOUT_STALE_BARS) return null;
          // Invalidate if live bar (n-1) closed ABOVE the upper rail — the pattern
          // broke in the wrong direction (bullish, not bearish continuation).
          if (candles[n - 1].close > evalT(n - 1)) return null;
          return {
            pattern: "RISING_WEDGE", direction: "bearish", category: "continuation",
            confirmed: broke,
            necklinePrice:        +botNow.toFixed(10),
            upperBound:           +topNow.toFixed(10),
            necklineStartPrice:   +evalB(startIdx).toFixed(10),
            upperBoundStartPrice: +evalT(startIdx).toFixed(10),
            patternStartDate: candles[startIdx]?.date,
            patternEndDate:   candles[cur]?.date,
          };
        }
      }
    }
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

      // Determine flag vs pennant via regression on the consolidation highs/lows.
      // Regression endpoints become the diagonal rail anchors for the chart:
      //   Upper rail: topReg value at index 0 (start) → topReg value at last index (end).
      //   Lower rail: botReg value at index 0 (start) → botReg value at last index (end).
      // The breakout confirmation still uses the raw maxH/minL extremes so that
      // `lastClose > maxH` is a strict, geometrically achievable threshold.
      const topReg = linReg(consolSlice.map((c, i) => ({ x: i, y: c.high })));
      const botReg = linReg(consolSlice.map((c, i) => ({ x: i, y: c.low  })));
      const isPennant = topReg.slope < -0.00001 && botReg.slope > 0.00001;
      const lastIdx   = consolSlice.length - 1;
      const topStart  = topReg.intercept;
      const topEnd    = topReg.intercept + topReg.slope * lastIdx;
      const botStart  = botReg.intercept;
      const botEnd    = botReg.intercept + botReg.slope * lastIdx;

      // consolSlice covers indices 0…(consolLen-1). Bar n-2 sits at regression
      // index consolLen; bar n-1 (live, potentially incomplete) at consolLen+1.
      const liveClose     = candles[n - 1].close;
      const topAtLive     = topReg.intercept + topReg.slope * (consolLen + 1);
      const botAtLive     = botReg.intercept + botReg.slope * (consolLen + 1);

      if (isBullPole) {
        // Invalidate if last completed bar already broke BELOW the channel —
        // the pullback became a reversal, not a bull continuation.
        if (lastClose < minL) continue;
        // Invalidate if the live bar is below the extrapolated lower rail.
        if (liveClose < botAtLive) continue;
        return {
          pattern: isPennant ? "BULL_PENNANT" : "BULL_FLAG",
          direction: "bullish", category: "continuation",
          confirmed: lastClose > maxH,
          necklinePrice:        +botEnd.toFixed(10),
          upperBound:           +topEnd.toFixed(10),
          necklineStartPrice:   +botStart.toFixed(10),
          upperBoundStartPrice: +topStart.toFixed(10),
          patternStartDate:     consolSlice[0].date,
          patternEndDate:       consolSlice[lastIdx].date,
        };
      } else {
        // Invalidate if last completed bar already broke ABOVE the channel —
        // price escaped upward; this is no longer a bear flag/pennant.
        if (lastClose > maxH) continue;
        // Invalidate if the live bar is above the extrapolated upper rail.
        if (liveClose > topAtLive) continue;
        return {
          pattern: isPennant ? "BEAR_PENNANT" : "BEAR_FLAG",
          direction: "bearish", category: "continuation",
          confirmed: lastClose < minL,
          necklinePrice:        +botEnd.toFixed(10),
          upperBound:           +topEnd.toFixed(10),
          necklineStartPrice:   +botStart.toFixed(10),
          upperBoundStartPrice: +topStart.toFixed(10),
          patternStartDate:     consolSlice[0].date,
          patternEndDate:       consolSlice[lastIdx].date,
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
// Priority: double top/bottom → H&S/IHS → continuation patterns.
export function detectChartPattern(candles: CandleRaw[]): PatternResult | null {
  if (candles.length < 20) return null;

  // Priority order (highest first):
  //   1. Double top / bottom — runs BEFORE H&S/IHS.
  //      A double top's two similar-height peaks are structurally identical to
  //      IHS neckline anchors. Running IHS first caused it to win over clear
  //      double tops and fire a BUY when the correct call was SELL.
  //      Double patterns are more specific to recent price action and win.
  //   2. H&S / IHS          — fires only when no double pattern is present
  //   3. Triangles          — 50-bar window (most current market context)
  //   4. Wedges             — 100-bar window (longer-span formation)
  //   5. Flags / pennants
  return (
    detectDoubleTop(candles)    ??
    detectDoubleBottom(candles) ??
    detectHS(candles)           ??
    detectIHS(candles)          ??
    detectTriangles(candles)    ??
    detectWedges(candles)       ??
    detectFlagsPennants(candles) ??
    null
  );
}
