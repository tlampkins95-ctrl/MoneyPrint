#!/usr/bin/env tsx
/**
 * Dagger Entry Strategy — Pre-Build Backtest
 *
 * Validates the 3-swing measured move (DAGGER) entry concept across all static
 * symbols × timeframes before integrating into production signals.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backtest:dagger
 *
 * Entry methodology
 * -----------------
 * Setup detection finds A (impulse base), B (impulse extreme), C (correction
 * extreme).  The entry trigger fires on the FIRST bar AFTER C is established
 * where bar.low (bull) or bar.high (bear) crosses within 0.5×ATR of C.
 * Entry price = trigger bar's extremum (bar.low for bull, bar.high for bear).
 * SL = C − 0.5×ATR (bull) | C + 0.5×ATR (bear).
 * TP2 = D = C + AB (bull) | C − AB (bear).
 *
 * Variants reported
 * -----------------
 *   Simple    — 3-swing: A → B → C, target D = C + AB
 *   Extended  — 5-swing: simple TP2 hit at D; then D → E (40–60% of CD
 *               as new impulse), target F = E + CD. True second-pass detection,
 *               not relabelling.
 *   Confluent — simple setup where a secondary 80-bar lookback also produces
 *               a valid setup with its D within 0.25×ATR of the primary D.
 *   All       — simple + extended combined.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface CandleRaw {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Timeframe = "15m" | "30m" | "1h" | "1d";
type Direction = "bull" | "bear";

interface SymbolCfg {
  label: string;
  yahoo?: string;
  okxPerp?: string;
  longOnly?: boolean;
}

interface DaggerSetup {
  direction: Direction;
  aPrice: number; aIdx: number;
  bPrice: number; bIdx: number;
  cPrice: number; cIdx: number;
  dTarget: number;
  abLeg: number;
}

/** Context left by a completed simple trade for extended-matrix detection. */
interface ExtendedSeed {
  direction: Direction;
  cPrice: number;   // original C (= A' of extended swing)
  dPrice: number;   // D that was reached (= B' of extended swing)
  dBar: number;     // bar index where D was first hit
  cdLeg: number;    // D − C (impulse leg for extended swing)
}

type Outcome = "TP2" | "SL" | "EXPIRED";

interface Trade {
  symbol: string;
  timeframe: Timeframe;
  entryBar: number;
  direction: Direction;
  entry: number;
  sl: number;
  tp2: number;
  rAtTp2: number;
  outcome: Outcome;
  r: number;
  barsHeld: number;
  isExtended: boolean;
  isConfluent: boolean;
  cIdx: number;
}

// ─── Symbol Configs ──────────────────────────────────────────────────────────

const SYMBOLS: Record<string, SymbolCfg> = {
  XAGUSD:    { label: "XAG/USD",   yahoo: "SI=F" },
  XAUUSD:    { label: "XAU/USD",   yahoo: "GC=F" },
  EURUSD:    { label: "EUR/USD",   yahoo: "EURUSD=X" },
  GBPUSD:    { label: "GBP/USD",   yahoo: "GBPUSD=X" },
  AUDUSD:    { label: "AUD/USD",   yahoo: "AUDUSD=X" },
  BTCUSD:    { label: "BTC/USDT",  okxPerp: "BTC-USDT-SWAP" },
  ETHUSD:    { label: "ETH/USDT",  okxPerp: "ETH-USDT-SWAP" },
  ZECUSD:    { label: "ZEC/USDT",  okxPerp: "ZEC-USDT-SWAP" },
};

const TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "1d"];

const YAHOO_CFG: Record<Timeframe, { interval: string; range: string }> = {
  "15m": { interval: "15m",  range: "60d"  },
  "30m": { interval: "30m",  range: "60d"  },
  "1h":  { interval: "60m",  range: "730d" },
  "1d":  { interval: "1d",   range: "2y"   },
};

const OKX_BAR: Record<Timeframe, string> = {
  "15m": "15m", "30m": "30m", "1h": "1H", "1d": "1D",
};

// ─── Indicator Helpers (ported verbatim from signals.ts) ─────────────────────

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  out[period - 1] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function calcATR(candles: CandleRaw[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  const s = trs.slice(-period);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0,  d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function calcMACDHist(closes: number[], fast = 12, slow = 26, sig = 9): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < slow + sig) return out;
  const fe = calcEMA(closes, fast);
  const se = calcEMA(closes, slow);
  const ml = closes.map((_, i) =>
    (isNaN(fe[i]) || isNaN(se[i])) ? NaN : fe[i] - se[i]);
  const vs = slow - 1;
  const sl = calcEMA(ml.slice(vs), sig);
  for (let i = 0; i < sl.length; i++) {
    const g = vs + i;
    if (!isNaN(ml[g]) && !isNaN(sl[i])) out[g] = ml[g] - sl[i];
  }
  return out;
}

// ─── Wave Detection ───────────────────────────────────────────────────────────

const MIN_IMPULSE_ATR    = 3.0;   // impulse must span ≥3×ATR
const MIN_SH_BARS_AGO    = 3;     // B must be established ≥3 bars before current
const MIN_RETRACE_PCTG   = 0.10;  // price must have pulled back ≥10% of AB from B
const DAGGER_LOW         = 0.40;  // min correction percentage (40%)
const DAGGER_HIGH        = 0.60;  // max correction percentage (60%)
const ENTRY_ATR_HALF     = 0.5;   // trigger: bar's low/high must reach within 0.5×ATR of C

/**
 * Finds the 3-swing bull structure (A→B→C) in candles[0..endIdx].
 * Does NOT embed the entry trigger — that is checked separately in the loop.
 * Returns null if no valid structure exists.
 */
function findBullStructure(
  candles: CandleRaw[],
  endIdx: number,
  atr: number,
  lookback = 120,
): DaggerSetup | null {
  if (endIdx < 20 || atr <= 0) return null;
  const start = Math.max(0, endIdx - lookback + 1);
  const slice = candles.slice(start, endIdx + 1);
  const n = slice.length;
  if (n < 10) return null;

  // B = highest high, must be settled ≥ MIN_SH_BARS_AGO bars before endIdx
  const bSearchEnd = n - MIN_SH_BARS_AGO;
  if (bSearchEnd <= 1) return null;
  let bLoc = 0;
  for (let i = 1; i < bSearchEnd; i++) {
    if (slice[i].high > slice[bLoc].high) bLoc = i;
  }
  const bPrice = slice[bLoc].high;

  // No new high after B (impulse is complete)
  for (let i = bLoc + 1; i < n; i++) {
    if (slice[i].high > bPrice) return null;
  }

  // A = lowest low before B (impulse base)
  if (bLoc === 0) return null;
  let aLoc = 0;
  for (let i = 1; i < bLoc; i++) {
    if (slice[i].low < slice[aLoc].low) aLoc = i;
  }
  const aPrice = slice[aLoc].low;
  if (bPrice <= aPrice) return null;

  const abLeg = bPrice - aPrice;
  if (abLeg < MIN_IMPULSE_ATR * atr) return null;

  // Price must have pulled back ≥10% of AB from B (trend is turning)
  const curClose = slice[n - 1].close;
  if (curClose > bPrice - abLeg * MIN_RETRACE_PCTG) return null;

  // C = lowest low after B (deepest point of correction)
  if (bLoc >= n - 1) return null;
  let cLoc = bLoc + 1;
  for (let i = bLoc + 2; i < n; i++) {
    if (slice[i].low < slice[cLoc].low) cLoc = i;
  }
  const cPrice = slice[cLoc].low;

  // Retracement (B→C) / AB must be 40–60%
  const rPct = (bPrice - cPrice) / abLeg;
  if (rPct < DAGGER_LOW || rPct > DAGGER_HIGH) return null;

  // C must not be too recent — need at least 1 bar after C for trigger detection
  if (cLoc >= n - 1) return null;

  const dTarget = cPrice + abLeg;

  return {
    direction: "bull",
    aPrice, aIdx: start + aLoc,
    bPrice, bIdx: start + bLoc,
    cPrice, cIdx: start + cLoc,
    dTarget, abLeg,
  };
}

/**
 * Mirror of findBullStructure for bear direction.
 * B = lowest low (impulse down), A = highest high before B,
 * C = highest high of correction after B, D = C − AB below.
 */
function findBearStructure(
  candles: CandleRaw[],
  endIdx: number,
  atr: number,
  lookback = 120,
): DaggerSetup | null {
  if (endIdx < 20 || atr <= 0) return null;
  const start = Math.max(0, endIdx - lookback + 1);
  const slice = candles.slice(start, endIdx + 1);
  const n = slice.length;
  if (n < 10) return null;

  const bSearchEnd = n - MIN_SH_BARS_AGO;
  if (bSearchEnd <= 1) return null;
  let bLoc = 0;
  for (let i = 1; i < bSearchEnd; i++) {
    if (slice[i].low < slice[bLoc].low) bLoc = i;
  }
  const bPrice = slice[bLoc].low;

  for (let i = bLoc + 1; i < n; i++) {
    if (slice[i].low < bPrice) return null;
  }

  if (bLoc === 0) return null;
  let aLoc = 0;
  for (let i = 1; i < bLoc; i++) {
    if (slice[i].high > slice[aLoc].high) aLoc = i;
  }
  const aPrice = slice[aLoc].high;
  if (aPrice <= bPrice) return null;

  const abLeg = aPrice - bPrice;
  if (abLeg < MIN_IMPULSE_ATR * atr) return null;

  const curClose = slice[n - 1].close;
  if (curClose < bPrice + abLeg * MIN_RETRACE_PCTG) return null;

  if (bLoc >= n - 1) return null;
  let cLoc = bLoc + 1;
  for (let i = bLoc + 2; i < n; i++) {
    if (slice[i].high > slice[cLoc].high) cLoc = i;
  }
  const cPrice = slice[cLoc].high;

  const rPct = (cPrice - bPrice) / abLeg;
  if (rPct < DAGGER_LOW || rPct > DAGGER_HIGH) return null;

  if (cLoc >= n - 1) return null;

  const dTarget = cPrice - abLeg;

  return {
    direction: "bear",
    aPrice, aIdx: start + aLoc,
    bPrice, bIdx: start + bLoc,
    cPrice, cIdx: start + cLoc,
    dTarget, abLeg,
  };
}

/**
 * True 5-swing extended detection.
 * Looks for a D→E pullback of 40–60% of CD after a simple TP2 was hit at D.
 * If found and current bar's low crosses within 0.5×ATR of E, returns the setup.
 * F target = E + CD.
 */
function findExtendedBullStructure(
  candles: CandleRaw[],
  endIdx: number,
  atr: number,
  seed: ExtendedSeed,
): DaggerSetup | null {
  const { dPrice, dBar, cdLeg, cPrice: seedC } = seed;
  // Need at least MIN_SH_BARS_AGO bars after D for E to be established
  if (endIdx < dBar + MIN_SH_BARS_AGO + 1) return null;

  // E = lowest low in (dBar, endIdx) — correction from D
  let eLoc = dBar + 1;
  for (let i = dBar + 2; i < endIdx; i++) {
    if (candles[i].low < candles[eLoc].low) eLoc = i;
  }
  const ePrice = candles[eLoc].low;

  // Retracement (D→E) / CD must be 40–60%
  const rPct = (dPrice - ePrice) / cdLeg;
  if (rPct < DAGGER_LOW || rPct > DAGGER_HIGH) return null;

  // No new low after E (correction settled)
  for (let i = eLoc + 1; i < endIdx; i++) {
    if (candles[i].low < ePrice) return null;
  }

  // E must be established at least 1 bar before current for trigger check
  if (eLoc >= endIdx - 1) return null;

  const fTarget = ePrice + cdLeg;

  return {
    direction: "bull",
    aPrice: seedC, aIdx: dBar - 1,   // A' ≈ original C (approximate index)
    bPrice: dPrice, bIdx: dBar,       // B' = D of simple
    cPrice: ePrice, cIdx: eLoc,       // C' = E
    dTarget: fTarget,
    abLeg: cdLeg,
  };
}

/** Mirror of findExtendedBullStructure for bear 5-swing. */
function findExtendedBearStructure(
  candles: CandleRaw[],
  endIdx: number,
  atr: number,
  seed: ExtendedSeed,
): DaggerSetup | null {
  const { dPrice, dBar, cdLeg, cPrice: seedC } = seed;
  if (endIdx < dBar + MIN_SH_BARS_AGO + 1) return null;

  // E = highest high in (dBar, endIdx) — correction bounce from D (a low)
  let eLoc = dBar + 1;
  for (let i = dBar + 2; i < endIdx; i++) {
    if (candles[i].high > candles[eLoc].high) eLoc = i;
  }
  const ePrice = candles[eLoc].high;

  const rPct = (ePrice - dPrice) / cdLeg;
  if (rPct < DAGGER_LOW || rPct > DAGGER_HIGH) return null;

  for (let i = eLoc + 1; i < endIdx; i++) {
    if (candles[i].high > ePrice) return null;
  }

  if (eLoc >= endIdx - 1) return null;

  const fTarget = ePrice - cdLeg;

  return {
    direction: "bear",
    aPrice: seedC, aIdx: dBar - 1,
    bPrice: dPrice, bIdx: dBar,
    cPrice: ePrice, cIdx: eLoc,
    dTarget: fTarget,
    abLeg: cdLeg,
  };
}

// ─── Trade Simulator ──────────────────────────────────────────────────────────

interface SimMeta {
  isExtended: boolean;
  isConfluent: boolean;
  symbol: string;
  timeframe: Timeframe;
}

/**
 * Simulates a trade entered on the trigger bar.
 * Entry = trigger bar's low (bull) or high (bear) — the actual price at the
 * first bar whose extremum crosses within 0.5×ATR of C/E.
 * SL = C − 0.5×ATR (bull) | C + 0.5×ATR (bear) — anchored to C, not entry.
 * Returns null only if the trigger bar already blew through SL (structurally
 * invalid fill). All other triggered setups are simulated regardless of R ratio.
 */
function simulateTrade(
  candles: CandleRaw[],
  entryBar: number,
  setup: DaggerSetup,
  atr: number,
  meta: SimMeta,
): Trade | null {
  const isBull = setup.direction === "bull";

  // Entry = extremum of trigger bar (low for bull, high for bear)
  const entry = isBull ? candles[entryBar].low : candles[entryBar].high;
  // SL anchored to C (the correction extreme), not to the trigger bar
  const sl    = isBull ? setup.cPrice - atr * ENTRY_ATR_HALF : setup.cPrice + atr * ENTRY_ATR_HALF;

  // If the trigger bar already blew through SL, skip (entry worse than SL)
  if (isBull && entry <= sl) return null;
  if (!isBull && entry >= sl) return null;
  const tp2   = setup.dTarget;

  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return null;

  const rAtTp2 = Math.abs(tp2 - entry) / slDist;

  // Sanity: D must be in the correct direction from entry
  if (isBull  && tp2 <= entry) return null;
  if (!isBull && tp2 >= entry) return null;

  // Scan all remaining bars until SL or TP2 is hit (no timeout).
  // If neither is hit by end of data, close at final bar (end-of-data exit).
  const lastBar = candles.length - 1;
  for (let j = entryBar + 1; j <= lastBar; j++) {
    const bar = candles[j];
    if (isBull) {
      if (bar.low  <= sl)  return mk("SL",  -1,     j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
      if (bar.high >= tp2) return mk("TP2", rAtTp2, j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
    } else {
      if (bar.high >= sl)  return mk("SL",  -1,     j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
      if (bar.low  <= tp2) return mk("TP2", rAtTp2, j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
    }
  }
  // End-of-data: neither SL nor TP2 was reached; close at final bar's close.
  const closeP = candles[lastBar].close;
  const expR   = isBull ? (closeP - entry) / slDist : (entry - closeP) / slDist;
  return mk("EXPIRED", expR, lastBar - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
}

function mk(
  outcome: Outcome, r: number, barsHeld: number,
  entry: number, sl: number, tp2: number, rAtTp2: number,
  setup: DaggerSetup, meta: SimMeta,
): Trade {
  return {
    symbol: meta.symbol, timeframe: meta.timeframe,
    entryBar: 0, direction: setup.direction,
    entry, sl, tp2, rAtTp2, outcome, r, barsHeld,
    isExtended: meta.isExtended, isConfluent: meta.isConfluent,
    cIdx: setup.cIdx,
  };
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

const WARMUP = 150; // bars reserved for indicator warm-up

function backtestSymbol(
  symbol: string,
  timeframe: Timeframe,
  candles: CandleRaw[],
  longOnly: boolean,
): Trade[] {
  const trades: Trade[] = [];
  if (candles.length < WARMUP + 5) return trades;

  const closes   = candles.map(c => c.close);
  const macdHist = calcMACDHist(closes);

  // De-dup keys: "bull:cIdx" | "bear:cIdx" | "ext-bull:cIdx" | "ext-bear:cIdx"
  // Consumed on first trigger crossing regardless of gate outcome (first-crossing semantics).
  // Direction-scoped to prevent a bull setup from blocking a bear setup at the same bar.
  const triggeredCIdx = new Set<string>();

  // Seeds from completed simple TP2 hits, for extended-matrix scanning
  const extSeeds: ExtendedSeed[] = [];

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const atr  = calcATR(candles.slice(0, i + 1));
    if (atr <= 0) continue;

    const rsiVal = calcRSI(closes.slice(0, i + 1));
    const hist1  = macdHist[i - 1];
    const hist2  = macdHist[i - 2];
    const macdWarm = !isNaN(hist1) && !isNaN(hist2);

    // ── Simple BULL ───────────────────────────────────────────────────────
    {
      const s = findBullStructure(candles, i, atr, 120);
      if (s && !triggeredCIdx.has(`bull:${s.cIdx}`)) {
        // Entry trigger: current bar's LOW must reach within 0.5×ATR of C.
        // Consume this cIdx on first trigger regardless of gate outcome —
        // ensures only the first qualifying crossing bar can enter a trade.
        const fired = candles[i].low <= s.cPrice + atr * ENTRY_ATR_HALF;
        if (fired) {
          triggeredCIdx.add(`bull:${s.cIdx}`);  // consume first crossing unconditionally
          const rsiOk  = isNaN(rsiVal) || rsiVal <= 35;
          const macdOk = !macdWarm || hist1 > hist2;
          if (rsiOk && macdOk) {
            // Confluence: secondary 80-bar structure with D within 0.25×ATR
            const s80  = findBullStructure(candles, i, atr, 80);
            const isConfluent = s80 != null &&
              Math.abs(s80.dTarget - s.dTarget) < atr * 0.25;

            const t = simulateTrade(candles, i, s, atr, {
              isExtended: false, isConfluent, symbol, timeframe,
            });
            if (t) {
              t.entryBar = i;
              trades.push(t);

              // If TP2 was hit, seed an extended watch for the CD leg
              if (t.outcome === "TP2") {
                const hitBar = i + t.barsHeld;
                extSeeds.push({
                  direction: "bull",
                  cPrice: s.cPrice,
                  dPrice: s.dTarget,
                  dBar: Math.min(hitBar, candles.length - 1),
                  cdLeg: s.dTarget - s.cPrice,  // CD = AB
                });
              }
            }
          }
        }
      }
    }

    // ── Simple BEAR ───────────────────────────────────────────────────────
    if (!longOnly) {
      const s = findBearStructure(candles, i, atr, 120);
      if (s && !triggeredCIdx.has(`bear:${s.cIdx}`)) {
        // Entry trigger: current bar's HIGH must reach within 0.5×ATR of C
        const fired = candles[i].high >= s.cPrice - atr * ENTRY_ATR_HALF;
        if (fired) {
          triggeredCIdx.add(`bear:${s.cIdx}`);  // consume first crossing unconditionally
          const rsiOk  = isNaN(rsiVal) || rsiVal >= 65;
          const macdOk = !macdWarm || hist1 < hist2;
          if (rsiOk && macdOk) {
            const s80  = findBearStructure(candles, i, atr, 80);
            const isConfluent = s80 != null &&
              Math.abs(s80.dTarget - s.dTarget) < atr * 0.25;

            const t = simulateTrade(candles, i, s, atr, {
              isExtended: false, isConfluent, symbol, timeframe,
            });
            if (t) {
              t.entryBar = i;
              trades.push(t);

              if (t.outcome === "TP2") {
                const hitBar = i + t.barsHeld;
                extSeeds.push({
                  direction: "bear",
                  cPrice: s.cPrice,
                  dPrice: s.dTarget,
                  dBar: Math.min(hitBar, candles.length - 1),
                  cdLeg: s.cPrice - s.dTarget,  // CD = AB (absolute)
                });
              }
            }
          }
        }
      }
    }

    // ── Extended BULL (5-swing) ────────────────────────────────────────────
    for (const seed of extSeeds) {
      if (seed.direction !== "bull") continue;
      const ext = findExtendedBullStructure(candles, i, atr, seed);
      if (!ext || triggeredCIdx.has(`ext-bull:${ext.cIdx}`)) continue;

      // Entry trigger: bar's LOW reaches within 0.5×ATR of E
      const fired = candles[i].low <= ext.cPrice + atr * ENTRY_ATR_HALF;
      if (!fired) continue;

      triggeredCIdx.add(`ext-bull:${ext.cIdx}`);  // consume first crossing unconditionally
      const rsiOk  = isNaN(rsiVal) || rsiVal <= 35;
      const macdOk = !macdWarm || hist1 > hist2;
      if (!rsiOk || !macdOk) continue; // gate failed — try next seed

      const t = simulateTrade(candles, i, ext, atr, {
        isExtended: true, isConfluent: false, symbol, timeframe,
      });
      if (t) {
        t.entryBar = i;
        trades.push(t);
        // Extended chain: seed another level if TP2 hit
        if (t.outcome === "TP2") {
          const hitBar = i + t.barsHeld;
          extSeeds.push({
            direction: "bull",
            cPrice: ext.cPrice,
            dPrice: ext.dTarget,
            dBar: Math.min(hitBar, candles.length - 1),
            cdLeg: ext.dTarget - ext.cPrice,
          });
        }
      }
      break; // one extended trade placed — stop evaluating further seeds this bar
    }

    // ── Extended BEAR (5-swing) ────────────────────────────────────────────
    if (!longOnly) {
      for (const seed of extSeeds) {
        if (seed.direction !== "bear") continue;
        const ext = findExtendedBearStructure(candles, i, atr, seed);
        if (!ext || triggeredCIdx.has(`ext-bear:${ext.cIdx}`)) continue;

        const fired = candles[i].high >= ext.cPrice - atr * ENTRY_ATR_HALF;
        if (!fired) continue;

        triggeredCIdx.add(`ext-bear:${ext.cIdx}`);  // consume first crossing unconditionally
        const rsiOk  = isNaN(rsiVal) || rsiVal >= 65;
        const macdOk = !macdWarm || hist1 < hist2;
        if (!rsiOk || !macdOk) continue; // gate failed — try next seed

        const t = simulateTrade(candles, i, ext, atr, {
          isExtended: true, isConfluent: false, symbol, timeframe,
        });
        if (t) {
          t.entryBar = i;
          trades.push(t);
          if (t.outcome === "TP2") {
            const hitBar = i + t.barsHeld;
            extSeeds.push({
              direction: "bear",
              cPrice: ext.cPrice,
              dPrice: ext.dTarget,
              dBar: Math.min(hitBar, candles.length - 1),
              cdLeg: ext.cPrice - ext.dTarget,
            });
          }
        }
        break; // one extended trade placed — stop evaluating further seeds this bar
      }
    }
  }

  return trades;
}

// ─── Stats Aggregation ────────────────────────────────────────────────────────

interface Stats {
  trades: number;
  wins: number;
  winRate: number;
  totalR: number;
  avgR: number;
  profitFactor: number;
  maxDD: number;
}

function computeStats(trades: Trade[]): Stats {
  if (!trades.length) {
    return { trades: 0, wins: 0, winRate: 0, totalR: 0, avgR: 0, profitFactor: 0, maxDD: 0 };
  }
  let wins = 0, grossWin = 0, grossLoss = 0, totalR = 0;
  let peak = 0, equity = 0, maxDD = 0;

  for (const t of trades) {
    const r = t.outcome === "EXPIRED" ? Math.max(-1, t.r) : t.r;
    totalR += r;
    equity += r;
    if (r > 0) { wins++; grossWin  += r; }
    else        { grossLoss += Math.abs(r); }
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades: trades.length, wins,
    winRate: wins / trades.length * 100,
    totalR, avgR: totalR / trades.length,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss,
    maxDD,
  };
}

// ─── Candle Fetchers ──────────────────────────────────────────────────────────

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchYahooCandles(ticker: string, tf: Timeframe): Promise<CandleRaw[]> {
  const { interval, range } = YAHOO_CFG[tf];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; DaggerBacktest/1.0)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo ${ticker} ${tf}: HTTP ${res.status}`);
  const json = await res.json() as {
    chart: {
      result: Array<{
        timestamp: number[];
        indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> };
      }> | null;
      error: { description: string } | null;
    };
  };
  if (!json.chart.result?.length) {
    throw new Error(`Yahoo ${ticker}: ${json.chart.error?.description ?? "no data"}`);
  }
  const r = json.chart.result[0];
  const q = r.indicators.quote[0];
  const intra = tf !== "1d";
  const candles: CandleRaw[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    const iso = new Date(r.timestamp[i] * 1000).toISOString();
    candles.push({ date: intra ? iso : iso.split("T")[0], open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
  }
  return candles;
}

async function okxGet(path: string): Promise<string[][]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://www.okx.com/api/v5${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DaggerBacktest/1.0)" },
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

async function fetchOkxCandles(instId: string, tf: Timeframe): Promise<CandleRaw[]> {
  const bar    = OKX_BAR[tf];
  const target = tf === "1d" ? 1500 : 2500;
  const intra  = tf !== "1d";
  const latest = await okxGet(`/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=300`);
  const all: string[][] = [...latest];
  let oldest = all.length ? Number(all[all.length - 1][0]) : Date.now();
  let safety = 30;
  while (all.length < target && safety-- > 0) {
    const page = await okxGet(
      `/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=100&after=${oldest}`);
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
    const iso = new Date(ts).toISOString();
    byTime.set(ts, { date: intra ? iso : iso.split("T")[0], open: o, high: h, low: l, close: c, volume: parseFloat(row[5]) || 0 });
  }
  return Array.from(byTime.entries()).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

async function fetchCandles(sym: string, cfg: SymbolCfg, tf: Timeframe): Promise<CandleRaw[]> {
  if (cfg.okxPerp) return fetchOkxCandles(cfg.okxPerp, tf);
  if (cfg.yahoo)   return fetchYahooCandles(cfg.yahoo, tf);
  throw new Error(`No data source configured for ${sym}`);
}

// ─── Table Printer ────────────────────────────────────────────────────────────

function pct(n: number)          { return isFinite(n) ? n.toFixed(1) + "%" : "—"; }
function fmt(n: number, d = 1)   { return isFinite(n) ? n.toFixed(d) : "—"; }

function printTable(
  header: string,
  rows: Array<{ sym: string; tf: string; stats: Stats }>,
) {
  console.log(`\n${"═".repeat(88)}`);
  console.log(`  ${header}`);
  console.log(`${"═".repeat(88)}`);
  console.log(
    "  " +
    "Symbol    ".padEnd(12) +
    "TF  ".padEnd(6) +
    "Trades".padEnd(8) +
    "WR%   ".padEnd(8) +
    "AvgR ".padEnd(8) +
    "TotalR ".padEnd(9) +
    "PF    ".padEnd(8) +
    "MaxDD"
  );
  console.log("  " + "─".repeat(84));
  let sumT = 0, sumW = 0, sumR = 0;
  for (const { sym, tf, stats: s } of rows) {
    // Print every symbol×TF row — including zero-trade cells — for full matrix visibility
    const tradeStr = String(s.trades);
    console.log(
      "  " +
      sym.padEnd(12) + tf.padEnd(6) +
      tradeStr.padEnd(8) +
      (s.trades > 0 ? pct(s.winRate) : "—").padEnd(8) +
      (s.trades > 0 ? fmt(s.avgR, 2) : "—").padEnd(8) +
      (s.trades > 0 ? fmt(s.totalR, 1) : "—").padEnd(9) +
      (s.trades > 0 ? fmt(s.profitFactor, 2) : "—").padEnd(8) +
      (s.trades > 0 ? fmt(s.maxDD, 1) + "R" : "—")
    );
    sumT += s.trades; sumW += s.wins; sumR += s.totalR;
  }
  if (sumT > 0) {
    console.log("  " + "─".repeat(84));
    console.log(
      "  " + "TOTAL".padEnd(12) + "".padEnd(6) +
      String(sumT).padEnd(8) +
      pct(sumW / sumT * 100).padEnd(8) +
      fmt(sumR / sumT, 2).padEnd(8) +
      fmt(sumR, 1).padEnd(9)
    );
  } else {
    console.log("  (no trades)");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const symKeys = Object.keys(SYMBOLS);
  const allTrades: Trade[] = [];

  console.log("\n  Dagger Entry Backtest — fetching candles ...\n");

  const varRows: Record<string, Array<{ sym: string; tf: string; stats: Stats }>> = {
    simple: [], extended: [], confluent: [], all: [],
  };

  for (const sym of symKeys) {
    const cfg = SYMBOLS[sym];
    for (const tf of TIMEFRAMES) {
      let candles: CandleRaw[];
      try {
        process.stdout.write(`  ${cfg.label.padEnd(12)} ${tf.padEnd(5)} — fetching ... `);
        candles = await fetchCandles(sym, cfg, tf);
        console.log(`${candles.length} bars`);
      } catch (err) {
        console.log(`SKIP (${(err as Error).message.slice(0, 60)})`);
        continue;
      }

      const trades   = backtestSymbol(sym, tf, candles, cfg.longOnly ?? false);
      allTrades.push(...trades);

      const simple    = trades.filter(t => !t.isExtended);
      const extended  = trades.filter(t => t.isExtended);
      const confluent = trades.filter(t => t.isConfluent);

      varRows.simple.push(   { sym: cfg.label, tf, stats: computeStats(simple)    });
      varRows.extended.push( { sym: cfg.label, tf, stats: computeStats(extended)  });
      varRows.confluent.push({ sym: cfg.label, tf, stats: computeStats(confluent) });
      varRows.all.push(      { sym: cfg.label, tf, stats: computeStats(trades)     });
    }
  }

  printTable("SIMPLE DAGGER  (3-swing A→B→C, target D = C + AB, entry at first bar touching C ± 0.5×ATR)", varRows.simple);
  printTable("EXTENDED DAGGER  (5-swing: true D→E pullback of CD, target F = E + CD)", varRows.extended);
  printTable("CONFLUENT DAGGER  (simple where secondary 80-bar D is within 0.25×ATR of primary D)", varRows.confluent);
  printTable("ALL DAGGER  (simple + extended combined)", varRows.all);

  const all  = computeStats(allTrades);
  const bull = computeStats(allTrades.filter(t => t.direction === "bull"));
  const bear = computeStats(allTrades.filter(t => t.direction === "bear"));

  console.log(`\n${"═".repeat(88)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(88)}`);
  console.log(`  Total trades  : ${all.trades}`);
  console.log(`  Win rate      : ${pct(all.winRate)}`);
  console.log(`  Avg R/trade   : ${fmt(all.avgR, 3)}`);
  console.log(`  Total R       : ${fmt(all.totalR, 1)}`);
  console.log(`  Profit factor : ${fmt(all.profitFactor, 2)}`);
  console.log(`  Max drawdown  : ${fmt(all.maxDD, 1)}R`);
  console.log(`  Bull  ${bull.trades} trades  WR ${pct(bull.winRate)}  AvgR ${fmt(bull.avgR, 2)}  PF ${fmt(bull.profitFactor, 2)}`);
  console.log(`  Bear  ${bear.trades} trades  WR ${pct(bear.winRate)}  AvgR ${fmt(bear.avgR, 2)}  PF ${fmt(bear.profitFactor, 2)}`);
  console.log(`${"═".repeat(88)}\n`);

  console.log("  PER-SYMBOL OVERVIEW (all timeframes combined)");
  console.log(`  ${"Symbol".padEnd(14)}${"Trades".padEnd(8)}${"WR%".padEnd(8)}${"AvgR".padEnd(8)}${"TotalR".padEnd(10)}PF`);
  console.log("  " + "─".repeat(62));
  for (const sym of symKeys) {
    const cfg  = SYMBOLS[sym];
    const ts   = allTrades.filter(t => t.symbol === sym);
    if (!ts.length) continue;
    const s    = computeStats(ts);
    console.log(
      "  " + cfg.label.padEnd(14) +
      String(s.trades).padEnd(8) +
      pct(s.winRate).padEnd(8) +
      fmt(s.avgR, 2).padEnd(8) +
      fmt(s.totalR, 1).padEnd(10) +
      fmt(s.profitFactor, 2)
    );
  }
  console.log();
}

main().catch(err => { console.error("Backtest failed:", err); process.exit(1); });
