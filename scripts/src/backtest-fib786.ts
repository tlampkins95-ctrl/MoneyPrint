#!/usr/bin/env tsx
/**
 * FIB786 Revision — Backtest
 *
 * A revision of the old FIB50_SWING strategy (retired earlier in this repo's
 * history for being unprofitable), now at the 0.786 retracement level with
 * volume/reversal confirmation and scaled exit management. Simpler than the
 * Gartley XABCD detector this replaces as the live-trading target: only
 * X (prior swing low) and A (the new high that reverses the downtrend into
 * X) are required — no B/C sub-structure, no AB=CD confirmation (there's no
 * C to measure a CD leg from).
 *
 * Setup (long only):
 *   - X = swing low, confirmed to be a genuine reversal point (X must be a
 *     lower low than the prior swing low — reversesIntoX)
 *   - A = swing high after X, with the XA leg volume-CONFIRMED (rising
 *     participation, not a low-conviction drift — volumeIncreasingOverLeg)
 *   - D = 0.786 retracement of XA measured from A (±3% tolerance), with the
 *     AD leg (A through the D-zone touch) volume-DECLINING (a genuine
 *     low-conviction pullback, not fresh trend participation)
 *   - Entry: price tags the D zone + a confirming bullish candle close
 *   - SL: below X, ATR-buffered (Dagger-style)
 *
 * Exit management (3% total risk, same as the Gartley build):
 *   - 33% closes at TP1 = entry + 0.5R
 *   - 33% closes at TP2 = entry + 1.0R (stop -> breakeven once TP1 fills)
 *   - 34% runner trails via a 3-bar (non-inside-bar) low once TP2 fills,
 *     using whichever timeframe is one level above the detection timeframe.
 *
 * This script tests BOTH timeframe combinations side by side, since it's an
 * open question which one performs better:
 *   Variant A: 1h detection, 15m entry trigger, 4h trailing stop
 *   Variant B: 4h detection, 1h entry trigger, daily (1d) trailing stop
 *
 * Standalone by design (no cross-package imports) — mirrors
 * backtest-dagger.ts/backtest-harmonic.ts's isolation choice.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backtest:fib786
 */

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

type Timeframe = "15m" | "1h" | "4h" | "1d";
type XADStatus = "FORMING" | "AT_D_ZONE" | "VIOLATED";
type Outcome = "FULL_SL" | "BE_AFTER_TP1" | "TRAIL_STOP" | "EXPIRED";

interface SwingPoint { idx: number; price: number; }
interface XADPoint { idx: number; price: number; date: string; }

interface XADPattern {
  X: XADPoint;
  A: XADPoint;
  dZoneLow: number;
  dZoneHigh: number;
  status: XADStatus;
}

interface Trade {
  symbol: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  outcome: Outcome;
  r1: number;
  r2: number;
  r3: number;
  r: number;
  barsHeld: number;
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

// ─── XAD detector ─────────────────────────────────────────────────────────────

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

function findXAD(candles: CandleRaw[], strength: number, lookback: number): XADPattern | null {
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

const SL_BUFFER_ATR = 1.0; // SL = X - buffer×ATR (Dagger-style)

// ─── 3-bar trailing stop (excluding inside bars) ─────────────────────────────

function computeInsideBarFlags(candles: CandleRaw[]): boolean[] {
  const flags = new Array(candles.length).fill(false);
  for (let i = 1; i < candles.length; i++) {
    flags[i] = candles[i].high <= candles[i - 1].high && candles[i].low >= candles[i - 1].low;
  }
  return flags;
}

const BAR_MS: Record<Timeframe, number> = {
  "15m": 15 * 60 * 1000, "1h": 60 * 60 * 1000, "4h": 4 * 60 * 60 * 1000, "1d": 24 * 60 * 60 * 1000,
};

function trailingStopAt(
  trailCandles: CandleRaw[], insideFlags: boolean[], trailBarMs: number, cutoffMs: number,
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

// ─── Backtest engine ──────────────────────────────────────────────────────────

const WARMUP = 200;
const ENTRY_LOOKAHEAD_BARS = 24; // in entry-timeframe bars (e.g. 24×15m=6h, 24×1h=1day)
const TP1_R = 0.5;
const TP2_R = 1.0;
const TRANCHE_WEIGHTS = { t1: 0.33, t2: 0.33, t3: 0.34 };

function backtestSymbol(
  symbol: string,
  candlesDetect: CandleRaw[],
  candlesEntry: CandleRaw[],
  entryBarMs: number,
  candlesTrail: CandleRaw[],
  trailBarMs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (candlesDetect.length < WARMUP + 10 || candlesEntry.length === 0 || candlesTrail.length < 3) return trades;

  const insideFlagsTrail = computeInsideBarFlags(candlesTrail);
  const triggeredA = new Set<number>();

  const earliestEntryMs = new Date(candlesEntry[0].date).getTime();
  const earliestTrailMs = new Date(candlesTrail[0].date).getTime();
  const earliestMs = Math.max(earliestEntryMs, earliestTrailMs);
  const firstCoveredIdx = candlesDetect.findIndex((c) => new Date(c.date).getTime() >= earliestMs);
  const startIdx = Math.max(WARMUP, firstCoveredIdx === -1 ? candlesDetect.length : firstCoveredIdx);

  for (let i = startIdx; i < candlesDetect.length; i++) {
    const window = candlesDetect.slice(0, i + 1);
    const pattern = findXAD(window, DEFAULT_SWING_STRENGTH, DEFAULT_SWING_LOOKBACK);
    if (!pattern || pattern.status !== "AT_D_ZONE") continue;
    if (triggeredA.has(pattern.A.idx)) continue;
    triggeredA.add(pattern.A.idx);

    const barDate = new Date(candlesDetect[i].date).getTime();
    const windowEndMs = barDate + ENTRY_LOOKAHEAD_BARS * entryBarMs;
    const idxEntryStart = candlesEntry.findIndex((c) => new Date(c.date).getTime() >= barDate);
    if (idxEntryStart === -1) continue;

    let entryIdx = -1;
    for (let j = idxEntryStart; j < candlesEntry.length; j++) {
      const ce = candlesEntry[j];
      if (new Date(ce.date).getTime() > windowEndMs) break;
      if (ce.low <= pattern.dZoneHigh && ce.close > ce.open) { entryIdx = j; break; }
    }
    if (entryIdx === -1) continue;

    const entry = candlesEntry[entryIdx].close;
    const atr = calcATR(window);
    if (atr <= 0) continue;
    const initialSl = pattern.X.price - SL_BUFFER_ATR * atr;
    if (entry <= initialSl) continue;
    const riskDist = entry - initialSl;
    if (riskDist <= 0) continue;

    const tp1 = entry + TP1_R * riskDist;
    const tp2 = entry + TP2_R * riskDist;

    let stopLevel = initialSl;
    let tp1Filled = false, tp2Filled = false;
    let r1: number | null = null, r2: number | null = null, r3: number | null = null;
    let outcome: Outcome = "EXPIRED";
    let barsHeld = 0;

    for (let j = entryIdx + 1; j < candlesEntry.length; j++) {
      const c = candlesEntry[j];
      const tMs = new Date(c.date).getTime();
      barsHeld = j - entryIdx;

      if (tp2Filled) {
        const candidate = trailingStopAt(candlesTrail, insideFlagsTrail, trailBarMs, tMs);
        if (candidate !== null) stopLevel = Math.max(stopLevel, candidate);
      }

      if (c.low <= stopLevel) {
        const stopR = (stopLevel - entry) / riskDist;
        if (!tp1Filled) { r1 = stopR; r2 = stopR; r3 = stopR; outcome = "FULL_SL"; }
        else if (!tp2Filled) { r2 = stopR; r3 = stopR; outcome = "BE_AFTER_TP1"; }
        else { r3 = stopR; outcome = "TRAIL_STOP"; }
        break;
      }

      if (!tp1Filled) {
        if (c.high >= tp1) { r1 = TP1_R; tp1Filled = true; stopLevel = entry; }
      } else if (!tp2Filled) {
        if (c.high >= tp2) { r2 = TP2_R; tp2Filled = true; }
      }
    }

    if (r1 === null || r2 === null || r3 === null) {
      const lastClose = candlesEntry[candlesEntry.length - 1].close;
      const markR = (lastClose - entry) / riskDist;
      if (r1 === null) r1 = markR;
      if (r2 === null) r2 = markR;
      if (r3 === null) r3 = markR;
    }

    const r = TRANCHE_WEIGHTS.t1 * r1 + TRANCHE_WEIGHTS.t2 * r2 + TRANCHE_WEIGHTS.t3 * r3;
    trades.push({ symbol, entry, sl: initialSl, tp1, tp2, outcome, r1, r2, r3, r, barsHeld });
  }

  return trades;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

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

// ─── Candle fetching (OKX) ────────────────────────────────────────────────────

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function okxGet(path: string): Promise<string[][]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://www.okx.com/api/v5${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Fib786Backtest/1.0)" },
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

const OKX_BAR: Record<Timeframe, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };

async function fetchOkxCandles(instId: string, tf: Timeframe, target: number): Promise<CandleRaw[]> {
  const bar = OKX_BAR[tf];
  const latest = await okxGet(`/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=300`);
  const all: string[][] = [...latest];
  let oldest = all.length ? Number(all[all.length - 1][0]) : Date.now();
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
  console.log("\n  FIB786 Revision Backtest — fetching candles ...\n");
  console.log(`  NOTE: scope is the static TradingView watchlist only (${TRADINGVIEW_WATCHLIST.length} perps).`);
  console.log(`  Long only. Exit rule: TP1 33% @ 0.5R, TP2 33% @ 1.0R (stop -> breakeven),\n  runner 34% trails via 3-bar (non-inside) low on the next-up timeframe once TP2 fills.\n`);
  console.log(`  Testing two variants:\n  A) 1h detection / 15m entry / 4h trail\n  B) 4h detection / 1h entry / 1d trail\n`);

  const c1hA: Record<string, CandleRaw[]> = {}; // variant A's own 1h detection series (~125d)
  const c15m: Record<string, CandleRaw[]> = {};
  const c4h: Record<string, CandleRaw[]> = {};  // shared: variant A's trail + variant B's detection (~250d)
  const c1hB: Record<string, CandleRaw[]> = {}; // variant B's entry series, matched to c4h's span
  const c1d: Record<string, CandleRaw[]> = {};

  for (const ticker of TRADINGVIEW_WATCHLIST) {
    const instId = toOkxInstId(ticker);

    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — 1h(A) ... `);
      c1hA[ticker] = await fetchOkxCandles(instId, "1h", 3000);
      console.log(`${c1hA[ticker].length} bars`);
    } catch (err) { console.log(`SKIP (${(err as Error).message.slice(0, 50)})`); c1hA[ticker] = []; }

    let span1hA = 0;
    if (c1hA[ticker].length >= 2) {
      span1hA = new Date(c1hA[ticker][c1hA[ticker].length - 1].date).getTime() - new Date(c1hA[ticker][0].date).getTime();
    }
    const target15m = span1hA > 0 ? Math.min(20000, Math.ceil(span1hA / BAR_MS["15m"]) + 200) : 3000;
    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — 15m (target ${target15m}) ... `);
      c15m[ticker] = await fetchOkxCandles(instId, "15m", target15m);
      console.log(`${c15m[ticker].length} bars`);
    } catch (err) { console.log(`SKIP (${(err as Error).message.slice(0, 50)})`); c15m[ticker] = []; }

    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — 4h (target 1500) ... `);
      c4h[ticker] = await fetchOkxCandles(instId, "4h", 1500);
      console.log(`${c4h[ticker].length} bars`);
    } catch (err) { console.log(`SKIP (${(err as Error).message.slice(0, 50)})`); c4h[ticker] = []; }

    let span4h = 0;
    if (c4h[ticker].length >= 2) {
      span4h = new Date(c4h[ticker][c4h[ticker].length - 1].date).getTime() - new Date(c4h[ticker][0].date).getTime();
    }
    const target1hB = span4h > 0 ? Math.min(20000, Math.ceil(span4h / BAR_MS["1h"]) + 200) : 3000;
    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — 1h(B) (target ${target1hB}) ... `);
      c1hB[ticker] = await fetchOkxCandles(instId, "1h", target1hB);
      console.log(`${c1hB[ticker].length} bars`);
    } catch (err) { console.log(`SKIP (${(err as Error).message.slice(0, 50)})`); c1hB[ticker] = []; }

    const target1d = span4h > 0 ? Math.min(2000, Math.ceil(span4h / BAR_MS["1d"]) + 20) : 300;
    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — 1d (target ${target1d}) ... `);
      c1d[ticker] = await fetchOkxCandles(instId, "1d", target1d);
      console.log(`${c1d[ticker].length} bars`);
    } catch (err) { console.log(`SKIP (${(err as Error).message.slice(0, 50)})`); c1d[ticker] = []; }
  }

  const tradesA: Trade[] = [];
  const tradesB: Trade[] = [];

  for (const ticker of TRADINGVIEW_WATCHLIST) {
    if (c1hA[ticker]?.length && c15m[ticker]?.length && c4h[ticker]?.length) {
      tradesA.push(...backtestSymbol(ticker, c1hA[ticker], c15m[ticker], BAR_MS["15m"], c4h[ticker], BAR_MS["4h"]));
    }
    if (c4h[ticker]?.length && c1hB[ticker]?.length && c1d[ticker]?.length) {
      tradesB.push(...backtestSymbol(ticker, c4h[ticker], c1hB[ticker], BAR_MS["1h"], c1d[ticker], BAR_MS["1d"]));
    }
  }

  printSummary("VARIANT A — 1h detect / 15m entry / 4h trail", tradesA);
  printPerSymbol(tradesA);

  printSummary("VARIANT B — 4h detect / 1h entry / 1d trail", tradesB);
  printPerSymbol(tradesB);
}

main().catch((err) => { console.error(err); process.exit(1); });
