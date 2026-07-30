#!/usr/bin/env tsx
/**
 * Gartley Harmonic XABCD — Backtest
 *
 * Mandatory validation gate before any live alert wiring (per
 * gartley-bat-strategy-spec-final.md, since revised with the user): runs the
 * XABCD detector over real OKX 1h/15m candle history for the static
 * TradingView watchlist and reports win rate, avg R-multiple, and sample size.
 * Bat was dropped after the first backtest round (74 trades, avg R -0.077,
 * PF 0.83, dragged down almost entirely by bearish Bat) — Gartley-only going
 * forward. Bearish Gartley was then also dropped (round 2: 54 trades, avg R
 * -0.062, PF 0.79, runner tranche averaging -0.156R) — long-only going forward.
 *
 * Standalone by design (no cross-package imports) — mirrors backtest-dagger.ts's
 * isolation choice, so this script has zero dependency on the live server's
 * module graph. The detector logic here must be kept in sync with
 * artifacts/api-server/src/lib/harmonic-xabcd.ts if that file changes.
 *
 * Exit management (confirmed with the user): scaled exits, not a single
 * TP/SL —
 *   - 33% of the position closes at TP1 = entry + 0.5R
 *   - 33% closes at TP2 = entry + 1.0R (stop moves to breakeven once TP1 fills)
 *   - the final 34% ("runner") trails once TP2 fills, using a 3-bar trailing
 *     stop on the 1h timeframe (switched from 4h in round 2 to test whether a
 *     tighter trail holds gains better): stop = lowest low of the last 3
 *     CLOSED 1h bars that are not inside bars (a bar whose entire high/low
 *     range sits inside the prior bar's range doesn't count toward the 3),
 *     only ever tightening, never loosening.
 * A trade's overall R-multiple is the weighted sum across the three tranches
 * (0.33/0.33/0.34). Position sizing itself (3% of account risked per trade)
 * doesn't change these R-multiples — R is already risk-normalized — it only
 * determines the live dollar size via the existing computePositionSizing
 * infra once this reaches live wiring.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backtest:harmonic
 */

// Forces module scope so this file's top-level declarations (Timeframe,
// Trade, calcATR, etc.) don't collide with backtest-dagger.ts's identically-
// named globals — both files live in the same tsc program (scripts/tsconfig.json
// includes all of src/) and neither has any other import/export, which would
// otherwise make TS treat them as global scripts.
export {};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CandleRaw {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Timeframe = "15m" | "1h" | "4h";
type HarmonicPatternName = "GARTLEY";
type HarmonicDirection = "bullish" | "bearish";
type Outcome = "FULL_SL" | "BE_AFTER_TP1" | "TRAIL_STOP" | "EXPIRED";

interface RatioBand { min: number; max: number; ideal: number; }

interface XABCDRatioConfig {
  name: HarmonicPatternName;
  ab_xa: RatioBand;
  bc_ab: RatioBand;
  d_xa_primary: RatioBand;
  cd_bc_secondary: RatioBand;
}

interface SwingPoint { idx: number; price: number; }
interface XABCDPoint { idx: number; price: number; date: string; }
type XABCDStatus = "FORMING" | "AT_D_ZONE" | "VIOLATED";

interface XABCDPattern {
  pattern: HarmonicPatternName;
  direction: HarmonicDirection;
  X: XABCDPoint; A: XABCDPoint; B: XABCDPoint; C: XABCDPoint;
  dZoneLow: number; dZoneHigh: number;
  abRetrace: number; bcRetrace: number; cdProjection: number | null;
  status: XABCDStatus;
}

interface Trade {
  symbol: string;
  direction: HarmonicDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  outcome: Outcome;
  r1: number; // tranche 1 (33%) realized R
  r2: number; // tranche 2 (33%) realized R
  r3: number; // tranche 3 / runner (34%) realized R
  r: number;  // weighted overall R
  barsHeld: number; // in 15m bars
}

// ─── Symbol universe — mirrors artifacts/api-server/src/lib/tradingViewWatchlist.ts ──

const TRADINGVIEW_WATCHLIST: string[] = [
  "VVVUSDT", "LITUSDT", "LDOUSDT", "HYPEUSDT", "DASHUSDT", "SOLUSDT",
  "ETHUSDT", "XLMUSDT", "DYDXUSDT", "SYRUPUSDT", "SUIUSDT", "BTCUSDT",
  "WLDUSDT", "TAOUSDT", "ARBUSDT", "GRASSUSDT", "METUSDT", "ONDOUSDT",
  "NEARUSDT", "ZROUSDT", "AAVEUSDT", "CHIPUSDT", "XPLUSDT", "VIRTUALUSDT",
  "REUSDT", "ZECUSDT", "PYTHUSDT", "UNIUSDT", "ALLOUSDT",
];

function toOkxInstId(ticker: string): string {
  const base = ticker.endsWith("USDT") ? ticker.slice(0, -4) : ticker;
  return `${base}-USDT-SWAP`;
}

// ─── Ratio config (duplicated from harmonic-xabcd.ts — keep in sync) ────────

function pointBand(ideal: number, tolerancePct: number): RatioBand {
  return { min: ideal * (1 - tolerancePct), max: ideal * (1 + tolerancePct), ideal };
}
function rangeBand(low: number, high: number, tolerancePct: number): RatioBand {
  return { min: low * (1 - tolerancePct), max: high * (1 + tolerancePct), ideal: (low + high) / 2 };
}

const HARMONIC_TOLERANCE_PCT = 0.03;

const GARTLEY_CONFIG: XABCDRatioConfig = {
  name: "GARTLEY",
  ab_xa: pointBand(0.618, HARMONIC_TOLERANCE_PCT),
  bc_ab: rangeBand(0.382, 0.886, HARMONIC_TOLERANCE_PCT),
  d_xa_primary: pointBand(0.786, HARMONIC_TOLERANCE_PCT),
  cd_bc_secondary: rangeBand(1.27, 1.618, HARMONIC_TOLERANCE_PCT),
};

// ─── Swing finders (duplicated from patterns.ts — keep in sync) ─────────────

function findSwingHighs(candles: CandleRaw[], strength = 3, lookback = 80): SwingPoint[] {
  const n = candles.length;
  const start = Math.max(strength, n - lookback);
  const end = n - strength - 1;
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const c = candles[i].close;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].close >= c) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: candles[i].high });
  }
  return pts;
}

function findSwingLows(candles: CandleRaw[], strength = 3, lookback = 80): SwingPoint[] {
  const n = candles.length;
  const start = Math.max(strength, n - lookback);
  const end = n - strength - 1;
  if (end < start) return [];
  const pts: SwingPoint[] = [];
  for (let i = start; i <= end; i++) {
    const c = candles[i].close;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].close <= c) { ok = false; break; }
    }
    if (ok) pts.push({ idx: i, price: candles[i].low });
  }
  return pts;
}

// ─── XABCD detector (duplicated from harmonic-xabcd.ts — keep in sync) ──────

const DEFAULT_SWING_STRENGTH = 3;
const DEFAULT_SWING_LOOKBACK = 150;

function inBand(value: number, band: RatioBand): boolean {
  return value >= band.min && value <= band.max;
}

function toPoint(candles: CandleRaw[], p: SwingPoint): XABCDPoint {
  return { idx: p.idx, price: p.price, date: candles[p.idx].date };
}

function checkDZoneViolation(
  candles: CandleRaw[], afterIdx: number, dZoneLow: number, dZoneHigh: number, direction: HarmonicDirection,
): boolean {
  const after = candles.slice(afterIdx + 1);
  if (direction === "bullish") return after.some((c) => c.close < dZoneLow);
  return after.some((c) => c.close > dZoneHigh);
}

// Volume should trend UP across the XA leg — a genuine impulsive move is
// backed by rising participation, not a low-conviction drift. Compares
// average volume in the second half of the leg to the first half.
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

// Reversal-only filter: X must make a NEW extreme versus the prior
// structural swing, confirming a genuine prior trend into X rather than XA
// just being a shallow dip/bounce inside an already-established trend in
// the same direction (a continuation, not a reversal). Rejects when there's
// no prior swing to compare against.
function reversesIntoX(
  priorSwings: SwingPoint[], xIdx: number, xPrice: number, direction: HarmonicDirection,
): boolean {
  const before = priorSwings.filter((s) => s.idx < xIdx);
  if (before.length === 0) return false;
  const prior = before[before.length - 1];
  return direction === "bullish" ? xPrice < prior.price : xPrice > prior.price;
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

function findBullXABCD(candles: CandleRaw[], config: XABCDRatioConfig, strength: number, lookback: number): XABCDPattern | null {
  const swingLows = findSwingLows(candles, strength, lookback);
  const swingHighs = findSwingHighs(candles, strength, lookback);
  if (swingLows.length === 0 || swingHighs.length === 0) return null;

  // X = swing low (start), A = swing high after X (XA up), B = swing low
  // after A (AB down), C = swing high after B (BC up). D completes back
  // down — a retracement of XA measured from A, staying above X — and the
  // long entry buys that dip expecting a bounce back up.
  for (let ai = swingHighs.length - 1; ai >= 0; ai--) {
    const A = swingHighs[ai];
    const xCandidates = swingLows.filter((l) => l.idx < A.idx);
    if (xCandidates.length === 0) continue;
    const X = xCandidates[xCandidates.length - 1];
    if (X.price >= A.price) continue;
    if (!volumeIncreasingOverLeg(candles, X.idx, A.idx)) continue;
    if (!reversesIntoX(swingLows, X.idx, X.price, "bullish")) continue;

    const bCandidates = swingLows.filter((l) => l.idx > A.idx);
    if (bCandidates.length === 0) continue;
    const B = bCandidates.reduce((best, l) => (l.price < best.price ? l : best), bCandidates[0]);
    if (B.price >= A.price || B.price <= X.price) continue;

    const cCandidates = swingHighs.filter((h) => h.idx > B.idx);
    if (cCandidates.length === 0) continue;
    const C = cCandidates[cCandidates.length - 1];
    if (C.price >= A.price || C.price <= B.price) continue;

    const xaRange = A.price - X.price;
    const abRange = A.price - B.price;
    const bcRange = C.price - B.price;
    const abRetrace = abRange / xaRange;
    const bcRetrace = bcRange / abRange;
    if (!inBand(abRetrace, config.ab_xa)) continue;
    if (!inBand(bcRetrace, config.bc_ab)) continue;

    const dZoneHigh = A.price - config.d_xa_primary.min * xaRange;
    const dZoneLow = A.price - config.d_xa_primary.max * xaRange;
    if (dZoneHigh >= C.price) continue;

    const abcdProjectedD = C.price - abRange;
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

    const cdProjection = atDZone && bcRange > 0 ? (C.price - Math.max(lowestSinceC, dZoneLow)) / bcRange : null;

    return {
      pattern: config.name, direction: "bullish",
      X: toPoint(candles, X), A: toPoint(candles, A), B: toPoint(candles, B), C: toPoint(candles, C),
      dZoneLow, dZoneHigh, abRetrace, bcRetrace, cdProjection,
      status: violated ? "VIOLATED" : atDZone ? "AT_D_ZONE" : "FORMING",
    };
  }
  return null;
}

function findBearXABCD(candles: CandleRaw[], config: XABCDRatioConfig, strength: number, lookback: number): XABCDPattern | null {
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
    if (X.price <= A.price) continue;
    if (!volumeIncreasingOverLeg(candles, X.idx, A.idx)) continue;
    if (!reversesIntoX(swingHighs, X.idx, X.price, "bearish")) continue;

    const bCandidates = swingHighs.filter((h) => h.idx > A.idx);
    if (bCandidates.length === 0) continue;
    const B = bCandidates.reduce((best, h) => (h.price > best.price ? h : best), bCandidates[0]);
    if (B.price <= A.price || B.price >= X.price) continue;

    const cCandidates = swingLows.filter((l) => l.idx > B.idx);
    if (cCandidates.length === 0) continue;
    const C = cCandidates[cCandidates.length - 1];
    if (C.price <= A.price || C.price >= B.price) continue;

    const xaRange = X.price - A.price;
    const abRange = B.price - A.price;
    const bcRange = B.price - C.price;
    const abRetrace = abRange / xaRange;
    const bcRetrace = bcRange / abRange;
    if (!inBand(abRetrace, config.ab_xa)) continue;
    if (!inBand(bcRetrace, config.bc_ab)) continue;

    const dZoneLow = A.price + config.d_xa_primary.min * xaRange;
    const dZoneHigh = A.price + config.d_xa_primary.max * xaRange;
    if (dZoneLow <= C.price) continue;

    const abcdProjectedD = C.price + abRange;
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

    const cdProjection = atDZone && bcRange > 0 ? (Math.min(highestSinceC, dZoneHigh) - C.price) / bcRange : null;

    return {
      pattern: config.name, direction: "bearish",
      X: toPoint(candles, X), A: toPoint(candles, A), B: toPoint(candles, B), C: toPoint(candles, C),
      dZoneLow, dZoneHigh, abRetrace, bcRetrace, cdProjection,
      status: violated ? "VIOLATED" : atDZone ? "AT_D_ZONE" : "FORMING",
    };
  }
  return null;
}

function detectXABCD(
  candles: CandleRaw[], config: XABCDRatioConfig, direction: HarmonicDirection,
  strength = DEFAULT_SWING_STRENGTH, lookback = DEFAULT_SWING_LOOKBACK,
): XABCDPattern | null {
  return direction === "bullish"
    ? findBullXABCD(candles, config, strength, lookback)
    : findBearXABCD(candles, config, strength, lookback);
}

function calcATR(candles: CandleRaw[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  const slice = trs.slice(-period);
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
}

const HARMONIC_SL_BUFFER_ATR = 1.0; // SL = X ∓ buffer×ATR (Dagger-style)

function computeHarmonicStopLoss(xPrice: number, direction: HarmonicDirection, atr: number): number {
  return direction === "bullish" ? xPrice - HARMONIC_SL_BUFFER_ATR * atr : xPrice + HARMONIC_SL_BUFFER_ATR * atr;
}

// ─── 3-bar trailing stop (1h, excluding inside bars) ─────────────────────────
// Switched from 4h to 1h per user request, to test whether a tighter trail
// holds runner gains better (4h's runner tranche was averaging negative R,
// especially on the bearish side — since dropped, see below).

// An "inside bar" sits entirely within the prior bar's range and doesn't
// establish a new swing extreme, so it doesn't count toward the 3 bars used
// for the trailing stop.
function computeInsideBarFlags(candles: CandleRaw[]): boolean[] {
  const flags = new Array(candles.length).fill(false);
  for (let i = 1; i < candles.length; i++) {
    flags[i] = candles[i].high <= candles[i - 1].high && candles[i].low >= candles[i - 1].low;
  }
  return flags;
}

const BAR_MS: Record<Timeframe, number> = { "15m": 15 * 60 * 1000, "1h": 60 * 60 * 1000, "4h": 4 * 60 * 60 * 1000 };
const TRAIL_TIMEFRAME: Timeframe = "1h";

// Only considers trail-timeframe bars that have fully CLOSED by cutoffMs (no lookahead).
function trailingStopAt(
  trailCandles: CandleRaw[], insideFlags: boolean[], cutoffMs: number, direction: HarmonicDirection,
): number | null {
  const qualifying: number[] = [];
  for (let i = trailCandles.length - 1; i >= 0; i--) {
    const closeMs = new Date(trailCandles[i].date).getTime() + BAR_MS[TRAIL_TIMEFRAME];
    if (closeMs > cutoffMs) continue;
    if (insideFlags[i]) continue;
    qualifying.push(i);
    if (qualifying.length === 3) break;
  }
  if (qualifying.length < 3) return null;
  const bars = qualifying.map((i) => trailCandles[i]);
  return direction === "bullish" ? Math.min(...bars.map((b) => b.low)) : Math.max(...bars.map((b) => b.high));
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

const WARMUP_1H = 200;              // bars reserved so detectXABCD's swing lookback has runway
const ENTRY_LOOKAHEAD_MS = 6 * 60 * 60 * 1000; // 6h window on 15m data to find the entry confirmation
const TP1_R = 0.5;
const TP2_R = 1.0;
const TRANCHE_WEIGHTS = { t1: 0.33, t2: 0.33, t3: 0.34 };

function backtestSymbol(
  symbol: string,
  candles1h: CandleRaw[],
  candles15m: CandleRaw[],
  config: XABCDRatioConfig,
  direction: HarmonicDirection,
): Trade[] {
  const trades: Trade[] = [];
  if (candles1h.length < WARMUP_1H + 10 || candles15m.length === 0) return trades;

  // Trailing stop now reuses the same 1h series already fetched for pattern
  // detection — no separate 4h fetch needed.
  const insideFlags1h = computeInsideBarFlags(candles1h);

  // De-dup by C's index: once a C point's D-zone approach has been evaluated
  // once, later 1h bars re-detecting the same C shouldn't re-trigger a second
  // entry search — mirrors backtest-dagger.ts's triggeredCIdx set.
  const triggeredC = new Set<number>();

  // Only evaluate 1h bars that fall within the 15m data's covered range —
  // a 1h candidate older than the earliest 15m candle can never get an
  // entry confirmation, so including it would just misreport it as "no
  // signal" rather than "no data to confirm against."
  const earliest15mMs = new Date(candles15m[0].date).getTime();
  const firstCoveredIdx = candles1h.findIndex((c) => new Date(c.date).getTime() >= earliest15mMs);
  const startIdx = Math.max(WARMUP_1H, firstCoveredIdx === -1 ? candles1h.length : firstCoveredIdx);

  for (let i = startIdx; i < candles1h.length; i++) {
    const window = candles1h.slice(0, i + 1);
    const pattern = detectXABCD(window, config, direction);
    if (!pattern || pattern.status !== "AT_D_ZONE") continue;
    if (triggeredC.has(pattern.C.idx)) continue;
    triggeredC.add(pattern.C.idx);

    const barDate = new Date(candles1h[i].date).getTime();
    const windowEndMs = barDate + ENTRY_LOOKAHEAD_MS;
    const idx15Start = candles15m.findIndex((c) => new Date(c.date).getTime() >= barDate);
    if (idx15Start === -1) continue;

    let entryIdx15 = -1;
    for (let j = idx15Start; j < candles15m.length; j++) {
      const c15 = candles15m[j];
      if (new Date(c15.date).getTime() > windowEndMs) break;
      // Entry trigger: price still within the D zone + a confirming candle
      // close in the reversal direction — same body-direction check as the
      // existing closedBarBullish/closedBarBearish gate in signals.ts.
      if (direction === "bullish") {
        if (c15.low <= pattern.dZoneHigh && c15.close > c15.open) { entryIdx15 = j; break; }
      } else {
        if (c15.high >= pattern.dZoneLow && c15.close < c15.open) { entryIdx15 = j; break; }
      }
    }
    if (entryIdx15 === -1) continue; // no confirmation within the window — not scored (MISSED, not a loss)

    const entry = candles15m[entryIdx15].close;
    const atr1h = calcATR(window);
    if (atr1h <= 0) continue;
    const initialSl = computeHarmonicStopLoss(pattern.X.price, direction, atr1h);
    if (direction === "bullish" && entry <= initialSl) continue;
    if (direction === "bearish" && entry >= initialSl) continue;
    const riskDist = Math.abs(entry - initialSl);
    if (riskDist <= 0) continue;

    const tp1 = direction === "bullish" ? entry + TP1_R * riskDist : entry - TP1_R * riskDist;
    const tp2 = direction === "bullish" ? entry + TP2_R * riskDist : entry - TP2_R * riskDist;

    let stopLevel = initialSl;
    let tp1Filled = false;
    let tp2Filled = false;
    let r1: number | null = null, r2: number | null = null, r3: number | null = null;
    let outcome: Outcome = "EXPIRED";
    let barsHeld = 0;

    for (let j = entryIdx15 + 1; j < candles15m.length; j++) {
      const c = candles15m[j];
      const tMs = new Date(c.date).getTime();
      barsHeld = j - entryIdx15;

      // Ratchet the runner's stop from the 1h trail once TP2 has filled —
      // only ever tightens (max for longs, min for shorts), never loosens.
      if (tp2Filled) {
        const candidate = trailingStopAt(candles1h, insideFlags1h, tMs, direction);
        if (candidate !== null) {
          stopLevel = direction === "bullish" ? Math.max(stopLevel, candidate) : Math.min(stopLevel, candidate);
        }
      }

      const stopHit = direction === "bullish" ? c.low <= stopLevel : c.high >= stopLevel;
      if (stopHit) {
        const stopR = direction === "bullish" ? (stopLevel - entry) / riskDist : (entry - stopLevel) / riskDist;
        if (!tp1Filled) { r1 = stopR; r2 = stopR; r3 = stopR; outcome = "FULL_SL"; }
        else if (!tp2Filled) { r2 = stopR; r3 = stopR; outcome = "BE_AFTER_TP1"; }
        else { r3 = stopR; outcome = "TRAIL_STOP"; }
        break;
      }

      if (!tp1Filled) {
        const hitTp1 = direction === "bullish" ? c.high >= tp1 : c.low <= tp1;
        if (hitTp1) {
          r1 = TP1_R;
          tp1Filled = true;
          stopLevel = entry; // move to breakeven for the remaining tranches
        }
      } else if (!tp2Filled) {
        const hitTp2 = direction === "bullish" ? c.high >= tp2 : c.low <= tp2;
        if (hitTp2) {
          r2 = TP2_R;
          tp2Filled = true; // runner's stop starts trailing from the next bar
        }
      }
    }

    // Data ran out before full resolution — mark whatever's still open at
    // the last available close (mark-to-market), same convention as
    // backtest-dagger.ts's EXPIRED handling.
    if (r1 === null || r2 === null || r3 === null) {
      const lastClose = candles15m[candles15m.length - 1].close;
      const markR = direction === "bullish" ? (lastClose - entry) / riskDist : (entry - lastClose) / riskDist;
      if (r1 === null) r1 = markR;
      if (r2 === null) r2 = markR;
      if (r3 === null) r3 = markR;
    }

    const r = TRANCHE_WEIGHTS.t1 * r1 + TRANCHE_WEIGHTS.t2 * r2 + TRANCHE_WEIGHTS.t3 * r3;
    trades.push({ symbol, direction, entry, sl: initialSl, tp1, tp2, outcome, r1, r2, r3, r, barsHeld });
  }

  return trades;
}

// ─── Stats (same shape/convention as backtest-dagger.ts) ─────────────────────

interface Stats {
  trades: number; wins: number; winRate: number;
  totalR: number; avgR: number; profitFactor: number; maxDD: number;
}

function computeStats(trades: Trade[]): Stats {
  if (!trades.length) return { trades: 0, wins: 0, winRate: 0, totalR: 0, avgR: 0, profitFactor: 0, maxDD: 0 };
  let wins = 0, grossWin = 0, grossLoss = 0, totalR = 0;
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    const r = t.outcome === "EXPIRED" ? Math.max(-1, t.r) : t.r;
    totalR += r; equity += r;
    if (r > 0) { wins++; grossWin += r; } else { grossLoss += Math.abs(r); }
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    trades: trades.length, wins, winRate: wins / trades.length * 100,
    totalR, avgR: totalR / trades.length,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss,
    maxDD,
  };
}

// ─── Candle fetching (OKX, duplicated pagination approach from backtest-dagger.ts) ──

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function okxGet(path: string): Promise<string[][]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://www.okx.com/api/v5${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HarmonicBacktest/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(600 * 2 ** (attempt - 1)); continue; }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
    const json = await res.json() as { code: string; msg: string; data: string[][] };
    if (json.code !== "0") throw new Error(`OKX error ${json.code}: ${json.msg}`);
    return json.data;
  }
  throw new Error("OKX request failed after retries");
}

const OKX_BAR: Record<Timeframe, string> = { "15m": "15m", "1h": "1H", "4h": "4H" };
const DEFAULT_TARGET_BARS: Record<Timeframe, number> = { "15m": 3000, "1h": 3000, "4h": 3000 };

async function fetchOkxCandles(instId: string, tf: Timeframe, target = DEFAULT_TARGET_BARS[tf]): Promise<CandleRaw[]> {
  const bar = OKX_BAR[tf];
  const latest = await okxGet(`/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=300`);
  const all: string[][] = [...latest];
  let oldest = all.length ? Number(all[all.length - 1][0]) : Date.now();
  // Safety cap scales with target — a fixed cap silently truncates whenever
  // the caller asks for more bars than 40 pages can reach (this is exactly
  // what caused the 15m fetch to cover only ~1/4 of the 1h backtest window
  // before this fix, since both timeframes used the same fixed page budget).
  let safety = Math.ceil(target / 100) + 5;
  while (all.length < target && safety-- > 0) {
    const page = await okxGet(`/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=100&after=${oldest}`);
    if (!page.length) break;
    all.push(...page);
    oldest = Number(page[page.length - 1][0]);
    if (page.length < 100) break;
    await sleep(120);
  }
  const byTime = new Map<number, CandleRaw>();
  for (const row of all) {
    const ts = Number(row[0]);
    const o = parseFloat(row[1]), h = parseFloat(row[2]), l = parseFloat(row[3]), c = parseFloat(row[4]);
    if (!isFinite(ts) || ![o, h, l, c].every(isFinite)) continue;
    byTime.set(ts, { date: new Date(ts).toISOString(), open: o, high: h, low: l, close: c, volume: parseFloat(row[5]) || 0 });
  }
  return Array.from(byTime.entries()).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

// ─── Report printer ───────────────────────────────────────────────────────────

function pct(n: number) { return isFinite(n) ? n.toFixed(1) + "%" : "—"; }
function fmt(n: number, d = 1) { return isFinite(n) ? n.toFixed(d) : "—"; }

function printSummary(label: string, trades: Trade[]) {
  const s = computeStats(trades);
  console.log(`\n${"═".repeat(90)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(90)}`);
  if (s.trades === 0) { console.log("  (no trades)"); return; }
  console.log(`  Trades        : ${s.trades}`);
  console.log(`  Win rate      : ${pct(s.winRate)}`);
  console.log(`  Avg R/trade   : ${fmt(s.avgR, 3)}`);
  console.log(`  Total R       : ${fmt(s.totalR, 1)}`);
  console.log(`  Profit factor : ${fmt(s.profitFactor, 2)}`);
  console.log(`  Max drawdown  : ${fmt(s.maxDD, 1)}R`);
  const outcomes: Outcome[] = ["FULL_SL", "BE_AFTER_TP1", "TRAIL_STOP", "EXPIRED"];
  const counts = outcomes.map((o) => `${o}=${trades.filter((t) => t.outcome === o).length}`).join("  ");
  console.log(`  Outcomes      : ${counts}`);
  const avgR1 = trades.reduce((s2, t) => s2 + t.r1, 0) / trades.length;
  const avgR2 = trades.reduce((s2, t) => s2 + t.r2, 0) / trades.length;
  const avgR3 = trades.reduce((s2, t) => s2 + t.r3, 0) / trades.length;
  console.log(`  Avg tranche R : TP1(33%)=${fmt(avgR1, 3)}  TP2(33%)=${fmt(avgR2, 3)}  Runner(34%)=${fmt(avgR3, 3)}`);
}

function printPerSymbol(trades: Trade[]) {
  const symbols = Array.from(new Set(trades.map((t) => t.symbol))).sort();
  if (symbols.length === 0) return;
  console.log(`\n  PER-SYMBOL`);
  console.log("  " + "─".repeat(72));
  console.log("  " + "Symbol      ".padEnd(14) + "Trades".padEnd(8) + "WR%   ".padEnd(8) + "AvgR  ".padEnd(8) + "TotalR".padEnd(10));
  console.log("  " + "─".repeat(72));
  for (const sym of symbols) {
    const s = computeStats(trades.filter((t) => t.symbol === sym));
    if (!s.trades) continue;
    console.log("  " + sym.padEnd(14) + String(s.trades).padEnd(8) + pct(s.winRate).padEnd(8) + fmt(s.avgR, 2).padEnd(8) + fmt(s.totalR, 1).padEnd(10));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  Gartley Harmonic XABCD Backtest — fetching candles ...\n");
  console.log(`  NOTE: backtest scope is the static TradingView watchlist only (${TRADINGVIEW_WATCHLIST.length} perps).`);
  console.log(`  The CMC-discovered symbol universe is a live-forward addition with no\n  meaningful matching history and is intentionally excluded here.\n`);
  console.log(`  Long only. Exit rule: TP1 33% @ 0.5R, TP2 33% @ 1.0R (stop -> breakeven),\n  runner 34% trails via 3-bar (non-inside) 1h low once TP2 fills.\n`);

  const candles1h: Record<string, CandleRaw[]> = {};
  const candles15m: Record<string, CandleRaw[]> = {};

  for (const ticker of TRADINGVIEW_WATCHLIST) {
    const instId = toOkxInstId(ticker);
    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — fetching 1h ... `);
      candles1h[ticker] = await fetchOkxCandles(instId, "1h");
      console.log(`${candles1h[ticker].length} bars`);
    } catch (err) {
      console.log(`SKIP (${(err as Error).message.slice(0, 60)})`);
      candles1h[ticker] = [];
    }

    // Size the 15m fetch to cover the SAME calendar span as the 1h data just
    // fetched, not a matching bar COUNT — otherwise 15m coverage is a
    // fraction of the 1h calendar range and most 1h-detected patterns have
    // no data to confirm an entry against (silently under-reported as "no
    // trades"). No separate 4h fetch needed anymore — trailing now reuses
    // the 1h series directly.
    const c1h = candles1h[ticker];
    let spanMs = 0;
    if (c1h.length >= 2) {
      spanMs = new Date(c1h[c1h.length - 1].date).getTime() - new Date(c1h[0].date).getTime();
    }
    const target15m = spanMs > 0 ? Math.min(20000, Math.ceil(spanMs / BAR_MS["15m"]) + 200) : DEFAULT_TARGET_BARS["15m"];

    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — fetching 15m (target ${target15m}) ... `);
      candles15m[ticker] = await fetchOkxCandles(instId, "15m", target15m);
      console.log(`${candles15m[ticker].length} bars`);
    } catch (err) {
      console.log(`SKIP (${(err as Error).message.slice(0, 60)})`);
      candles15m[ticker] = [];
    }
  }

  const allTrades: Trade[] = [];

  for (const ticker of TRADINGVIEW_WATCHLIST) {
    const c1h = candles1h[ticker] ?? [];
    const c15 = candles15m[ticker] ?? [];
    if (!c1h.length || !c15.length) continue;
    allTrades.push(...backtestSymbol(ticker, c1h, c15, GARTLEY_CONFIG, "bullish"));
  }

  printSummary("GARTLEY — LONG ONLY", allTrades);
  printPerSymbol(allTrades);
}

main().catch((err) => { console.error(err); process.exit(1); });
