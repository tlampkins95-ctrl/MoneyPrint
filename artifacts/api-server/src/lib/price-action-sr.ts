// Price-action / Support-Resistance strategy — Stage 1.
//
// Pure, side-effect-free detection functions for the new PRICE_ACTION_SR
// signal type. This module is intentionally isolated from signals.ts so it
// can be developed and tested independently before being wired into the
// live trading cascade (real money is on the line — see replit.md).
//
// Tiers (per user spec):
//   4H  — directional bias via market structure (HH/HL vs LH/LL)
//   1H  — S/R zone detection (3+ touches within 0.5x ATR, volume bump)
//   15m — trigger: liquidity sweep (wick or close-based) OR EMA20/200 cross
//         OR price crossing EMA20, preferring momentum + volume confirmation
//
// Entry: limit at the S/R level.
// Stop: beyond the last local low/high (long/short) with a small ATR buffer.
// Exit: trailing stop only (no fixed TP) — trails behind each new confirmed
//       swing low (long) / swing high (short). Trailing logic is Stage 3;
//       this module only exposes the swing points needed to drive it later.

import type { CandleRaw } from "./yahoo-fetch";

// ─── Shared math helpers (kept local — do not import from signals.ts to keep
// this module independently testable and free of the live-cascade's state) ──

export function calcEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

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

function avgVolume(candles: CandleRaw[], period = 20): number {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

// ─── Swing points (fractal: strength bars on each side) ──────────────────────

export interface SwingPoint {
  idx: number;
  price: number;
  date: string;
}

export function findSwingHighs(candles: CandleRaw[], strength = 2, lookback = 100): SwingPoint[] {
  const n = candles.length;
  const start = Math.max(strength, n - lookback);
  const end = n - strength - 1;
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const h = candles[i].high;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].high >= h) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: h, date: candles[i].date });
  }
  return pts;
}

export function findSwingLows(candles: CandleRaw[], strength = 2, lookback = 100): SwingPoint[] {
  const n = candles.length;
  const start = Math.max(strength, n - lookback);
  const end = n - strength - 1;
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const l = candles[i].low;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].low <= l) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: l, date: candles[i].date });
  }
  return pts;
}

// ─── 1. Market structure (4H bias) ────────────────────────────────────────────
// Uptrend = most recent confirmed swing structure shows higher-highs AND
// higher-lows vs the prior swing of the same type. Downtrend = the mirror.
// Returns null when there isn't enough swing history to judge structure
// (ranging / insufficient data) — callers must treat null as "no trade".

export type MarketStructure = "up" | "down" | null;

export function detectMarketStructure(candles: CandleRaw[]): MarketStructure {
  const highs = findSwingHighs(candles, 2, 120);
  const lows = findSwingLows(candles, 2, 120);
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];

  const higherHigh = lastHigh.price > prevHigh.price;
  const higherLow = lastLow.price > prevLow.price;
  const lowerHigh = lastHigh.price < prevHigh.price;
  const lowerLow = lastLow.price < prevLow.price;

  if (higherHigh && higherLow) return "up";
  if (lowerHigh && lowerLow) return "down";
  return null; // mixed structure — no clear bias, sit out
}

// ─── 2. Support/Resistance zones (1H setup) ───────────────────────────────────
// A zone is a price band (0.5x ATR wide) that price has touched 3+ times,
// counting both wicks and closes, with wicks weighted 2x since the user's
// focus is rejection behavior. At least one touch must carry a volume bump
// (>= 1.5x the 20-period average volume on that candle).

export interface SRZone {
  price: number; // zone center (average of touch prices)
  type: "support" | "resistance";
  touches: number; // weighted touch count (wick touches count double)
  hasVolumeBump: boolean;
  bandWidth: number; // 0.5 * ATR used to build this zone
}

const ZONE_BAND_ATR_MULT = 0.5;
const VOLUME_BUMP_MULT = 1.5;
const MIN_WEIGHTED_TOUCHES = 3;

export function detectSRZones(candles: CandleRaw[], lookback = 150): SRZone[] {
  if (candles.length < 30) return [];
  const atr = calcATR(candles, 14);
  if (atr <= 0) return [];
  const band = atr * ZONE_BAND_ATR_MULT;
  const avgVol = avgVolume(candles, 20);
  const slice = candles.slice(-lookback);

  const swingHighs = findSwingHighs(slice, 2, lookback);
  const swingLows = findSwingLows(slice, 2, lookback);

  function buildZones(points: SwingPoint[], type: "support" | "resistance"): SRZone[] {
    const used = new Array(points.length).fill(false);
    const zones: SRZone[] = [];
    for (let i = 0; i < points.length; i++) {
      if (used[i]) continue;
      const cluster: SwingPoint[] = [points[i]];
      used[i] = true;
      for (let j = i + 1; j < points.length; j++) {
        if (used[j]) continue;
        if (Math.abs(points[j].price - points[i].price) <= band) {
          cluster.push(points[j]);
          used[j] = true;
        }
      }
      // Weighted touches: every swing point here is a wick extreme, so each
      // counts double per the "wicks weighted more" rule.
      const weightedTouches = cluster.length * 2;
      if (weightedTouches < MIN_WEIGHTED_TOUCHES) continue;
      const hasVolumeBump = cluster.some((p) => {
        const candle = candles.find((c) => c.date === p.date);
        return candle ? candle.volume >= avgVol * VOLUME_BUMP_MULT : false;
      });
      if (!hasVolumeBump) continue;
      const price = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
      zones.push({ price, type, touches: weightedTouches, hasVolumeBump, bandWidth: band });
    }
    return zones;
  }

  return [...buildZones(swingHighs, "resistance"), ...buildZones(swingLows, "support")];
}

// ─── 3a. Liquidity sweep detection (15m trigger) ──────────────────────────────
// Sweep (a): a single candle's wick pierces the zone by a "significant" amount
//   (>= 1x ATR beyond the level, OR the piercing portion is >= 50% of that
//   candle's total range) and the candle closes back inside the zone side.
// Sweep (b): a candle closes beyond the zone, then price closes back inside
//   within the next 4 candles.

export interface SweepResult {
  variant: "wick" | "close-return";
  direction: "bullish" | "bearish"; // bullish = swept support (reversal up), bearish = swept resistance (down)
  candleIdx: number;
}

export function detectSweep(candles: CandleRaw[], zone: SRZone, atr: number): SweepResult | null {
  const n = candles.length;
  if (n < 5 || atr <= 0) return null;

  // Sweep (a): check the most recently closed candle for a significant wick.
  const last = candles[n - 1];
  const range = last.high - last.low;
  if (range > 0) {
    if (zone.type === "support") {
      const pierce = zone.price - last.low; // how far below the zone the wick went
      const significant = pierce >= atr * 1.0 || pierce / range >= 0.5;
      const closedBackInside = last.close >= zone.price - zone.bandWidth;
      if (pierce > 0 && significant && closedBackInside) {
        return { variant: "wick", direction: "bullish", candleIdx: n - 1 };
      }
    } else {
      const pierce = last.high - zone.price;
      const significant = pierce >= atr * 1.0 || pierce / range >= 0.5;
      const closedBackInside = last.close <= zone.price + zone.bandWidth;
      if (pierce > 0 && significant && closedBackInside) {
        return { variant: "wick", direction: "bearish", candleIdx: n - 1 };
      }
    }
  }

  // Sweep (b): find a candle in the last 5 bars that CLOSED beyond the zone,
  // then check if a later candle (within 4 bars of it) closed back inside.
  const window = candles.slice(-5);
  const offset = n - window.length;
  for (let i = 0; i < window.length - 1; i++) {
    const c = window[i];
    const breachedBeyond =
      zone.type === "support" ? c.close < zone.price - zone.bandWidth
      : c.close > zone.price + zone.bandWidth;
    if (!breachedBeyond) continue;
    for (let j = i + 1; j <= Math.min(i + 4, window.length - 1); j++) {
      const back = window[j];
      const returnedInside =
        zone.type === "support" ? back.close >= zone.price - zone.bandWidth
        : back.close <= zone.price + zone.bandWidth;
      if (returnedInside) {
        return {
          variant: "close-return",
          direction: zone.type === "support" ? "bullish" : "bearish",
          candleIdx: offset + j,
        };
      }
    }
  }

  return null;
}

// ─── 3b. EMA20/200 cross + price-crosses-EMA20 (15m trigger) ─────────────────

export type EmaTrigger =
  | { kind: "golden-cross"; direction: "bullish" }
  | { kind: "death-cross"; direction: "bearish" }
  | { kind: "price-cross-ema20"; direction: "bullish" | "bearish" }
  | null;

export function detectEmaTrigger(candles: CandleRaw[]): EmaTrigger {
  if (candles.length < 205) return null;
  const closes = candles.map((c) => c.close);
  const ema20 = calcEMA(closes, 20);
  const ema200 = calcEMA(closes, 200);
  const n = closes.length;

  const prevDiff = ema20[n - 2] - ema200[n - 2];
  const currDiff = ema20[n - 1] - ema200[n - 1];
  if (prevDiff <= 0 && currDiff > 0) return { kind: "golden-cross", direction: "bullish" };
  if (prevDiff >= 0 && currDiff < 0) return { kind: "death-cross", direction: "bearish" };

  const prevClose = closes[n - 2];
  const currClose = closes[n - 1];
  const prevRelation = prevClose - ema20[n - 2];
  const currRelation = currClose - ema20[n - 1];
  if (prevRelation <= 0 && currRelation > 0) return { kind: "price-cross-ema20", direction: "bullish" };
  if (prevRelation >= 0 && currRelation < 0) return { kind: "price-cross-ema20", direction: "bearish" };

  return null;
}

// ─── 4. Momentum / volume confirmation ────────────────────────────────────────
// A candle is "strong momentum" when its body is >= 60% of its total range.
// The trigger is preferred (not required) when the last 2 candles are strong
// and closing in the trade direction, alongside a volume bump.

const MOMENTUM_BODY_RATIO = 0.6;

export function isStrongMomentumCandle(candle: CandleRaw, direction: "bullish" | "bearish"): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  if (body / range < MOMENTUM_BODY_RATIO) return false;
  return direction === "bullish" ? candle.close > candle.open : candle.close < candle.open;
}

export function hasMomentumConfirmation(candles: CandleRaw[], direction: "bullish" | "bearish"): boolean {
  const n = candles.length;
  if (n < 2) return false;
  const last2 = candles.slice(-2);
  return last2.every((c) => isStrongMomentumCandle(c, direction));
}

export function hasVolumeConfirmation(candles: CandleRaw[]): boolean {
  const n = candles.length;
  if (n < 21) return false;
  const avgVol = avgVolume(candles.slice(0, n - 1), 20);
  return candles[n - 1].volume >= avgVol * VOLUME_BUMP_MULT;
}

// ─── 5. Stop / entry helpers ───────────────────────────────────────────────────
// Stop sits just beyond the last local low (long) / high (short), buffered by
// 0.5x ATR so a wick doesn't tag it exactly.

const STOP_BUFFER_ATR_MULT = 0.5;

export function computeStopLoss(
  candles: CandleRaw[],
  direction: "bullish" | "bearish",
  atr: number,
): number | null {
  if (direction === "bullish") {
    const lows = findSwingLows(candles, 2, 30);
    if (lows.length === 0) return null;
    const lastLow = lows[lows.length - 1].price;
    return lastLow - atr * STOP_BUFFER_ATR_MULT;
  }
  const highs = findSwingHighs(candles, 2, 30);
  if (highs.length === 0) return null;
  const lastHigh = highs[highs.length - 1].price;
  return lastHigh + atr * STOP_BUFFER_ATR_MULT;
}

// Target = next opposing S/R zone beyond the entry, in the trade's direction.
export function computeTarget(
  zones: SRZone[],
  entryPrice: number,
  direction: "bullish" | "bearish",
): number | null {
  if (direction === "bullish") {
    const above = zones
      .filter((z) => z.type === "resistance" && z.price > entryPrice)
      .sort((a, b) => a.price - b.price);
    return above[0]?.price ?? null;
  }
  const below = zones
    .filter((z) => z.type === "support" && z.price < entryPrice)
    .sort((a, b) => b.price - a.price);
  return below[0]?.price ?? null;
}
