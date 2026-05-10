#!/usr/bin/env tsx
/**
 * Dagger Entry Strategy — Backtest (per Figure 11.2, "Making a Trade")
 *
 * Book definition (ordinal technique — no specific price measurements):
 *   Wave 1: Major trend defined        (A → B, impulse leg)
 *   Wave 2: Reaction to the trend      (B → C, pullback of any depth)
 *   Wave 3: Entry on first significant (C → entry trigger bar)
 *            price movement back in the direction of the major trend
 *   SL: below the beginning point of the secondary reaction wave = below C
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backtest:dagger
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
type GateMode  = "none" | "macd" | "macd+rsi";
type Outcome   = "TP" | "SL" | "EXPIRED";

interface SymbolCfg {
  label: string;
  yahoo?: string;
  okxPerp?: string;
}

interface DaggerSetup {
  direction: Direction;
  aIdx: number; aPrice: number;
  bIdx: number; bPrice: number;
  cIdx: number; cPrice: number;
  tp: number;   // TP = B (the swing that started the reaction — trend resumes)
  sl: number;   // SL = C ± SL_BUFFER * atr (just beyond the reaction extreme)
}

interface Trade {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  entry: number;
  sl: number;
  tp: number;
  outcome: Outcome;
  r: number;
  barsHeld: number;
  cIdx: number;
}

// ─── Symbol Configs ──────────────────────────────────────────────────────────

const SYMBOLS: Record<string, SymbolCfg> = {
  XAGUSD: { label: "XAG/USD",  yahoo: "SI=F"        },
  XAUUSD: { label: "XAU/USD",  yahoo: "GC=F"        },
  EURUSD: { label: "EUR/USD",  yahoo: "EURUSD=X"    },
  GBPUSD: { label: "GBP/USD",  yahoo: "GBPUSD=X"    },
  AUDUSD: { label: "AUD/USD",  yahoo: "AUDUSD=X"    },
  BTCUSD: { label: "BTC/USDT", okxPerp: "BTC-USDT-SWAP" },
  ETHUSD: { label: "ETH/USDT", okxPerp: "ETH-USDT-SWAP" },
  ZECUSD: { label: "ZEC/USDT", okxPerp: "ZEC-USDT-SWAP" },
};

const TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "1d"];

const YAHOO_CFG: Record<Timeframe, { interval: string; range: string }> = {
  "15m": { interval: "15m", range: "60d"  },
  "30m": { interval: "30m", range: "60d"  },
  "1h":  { interval: "60m", range: "730d" },
  "1d":  { interval: "1d",  range: "2y"   },
};

const OKX_BAR: Record<Timeframe, string> = {
  "15m": "15m", "30m": "30m", "1h": "1H", "1d": "1D",
};

// ─── Strategy Parameters ──────────────────────────────────────────────────────

const MIN_TREND_ATR    = 2.0;  // A→B impulse must be ≥ 2×ATR to be "major"
const MIN_REACTION_ATR = 0.5;  // B→C reaction must be ≥ 0.5×ATR (noise filter)
const MAX_REACTION_BARS = 50;  // reaction must complete within 50 bars of B
const TREND_LOOKBACK   = 80;   // bars to look back for A and B
const SL_BUFFER        = 0.5;  // SL placed C ± 0.5×ATR beyond the reaction extreme
const WARMUP           = 150;  // bars reserved for indicator warm-up

// Fibonacci retracement zone (optional filter)
// When requireFib=true, the B→C pullback must be 40–65% of the A→B impulse.
// This targets the classic "50% fib" pocket seen in the ZEC screenshot.
const FIB_LOW  = 0.40;
const FIB_HIGH = 0.65;

// ─── Indicators ──────────────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  const k   = 2 / (period + 1);
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

// ─── Setup Detection ──────────────────────────────────────────────────────────

/**
 * Finds a bull Dagger setup at bar `i`.
 *
 * Structure (book Fig 11.2):
 *   A = impulse base (lowest low before B)
 *   B = swing high   (defines the major trend)
 *   C = reaction low (deepest point of the pullback from B)
 *
 * Entry condition (checked by caller):
 *   bar[i].high > bar[i-1].high  — first upward tick after the reaction
 *   bar[i].low  > C              — entry bar has not breached the reaction low
 *
 * Returns null if no valid structure exists.
 */
function findBullSetup(
  candles: CandleRaw[],
  i: number,
  atr: number,
  requireFib = false,
): DaggerSetup | null {
  if (i < WARMUP + 4 || atr <= 0) return null;

  // B = highest high in lookback window, must be settled ≥ 3 bars before i
  const bEnd   = i - 3;
  const bStart = Math.max(0, i - TREND_LOOKBACK);
  if (bEnd <= bStart) return null;

  let bIdx = bStart, bPrice = candles[bStart].high;
  for (let j = bStart + 1; j <= bEnd; j++) {
    if (candles[j].high > bPrice) { bPrice = candles[j].high; bIdx = j; }
  }

  // No new high after B through bar i-1 (impulse is complete, reaction in progress)
  for (let j = bIdx + 1; j < i; j++) {
    if (candles[j].high >= bPrice) return null;
  }

  // A = lowest low before B (impulse base)
  const aStart = Math.max(0, bIdx - TREND_LOOKBACK);
  if (aStart >= bIdx) return null;
  let aIdx = aStart, aPrice = candles[aStart].low;
  for (let j = aStart + 1; j < bIdx; j++) {
    if (candles[j].low < aPrice) { aPrice = candles[j].low; aIdx = j; }
  }

  // Trend leg A→B must be significant ("major trend")
  if (bPrice - aPrice < MIN_TREND_ATR * atr) return null;

  // Reaction must not have taken too long
  if (i - bIdx > MAX_REACTION_BARS) return null;

  // C = deepest reaction low between B and bar i-1
  if (bIdx + 1 > i - 1) return null;
  let cIdx = bIdx + 1, cPrice = candles[bIdx + 1].low;
  for (let j = bIdx + 2; j <= i - 1; j++) {
    if (candles[j].low < cPrice) { cPrice = candles[j].low; cIdx = j; }
  }

  // Reaction B→C must be significant (not just noise)
  if (bPrice - cPrice < MIN_REACTION_ATR * atr) return null;

  // Optional Fibonacci filter: B→C retracement must land in the 40–65% pocket
  if (requireFib) {
    const retracePct = (bPrice - cPrice) / (bPrice - aPrice);
    if (retracePct < FIB_LOW || retracePct > FIB_HIGH) return null;
  }

  const sl = cPrice - SL_BUFFER * atr;  // below the reaction low
  const tp = bPrice;                    // TP = B (trend resumes to prior swing high)

  return { direction: "bull", aIdx, aPrice, bIdx, bPrice, cIdx, cPrice, tp, sl };
}

/**
 * Mirror of findBullSetup for bear direction.
 *   A = highest high before B (impulse top)
 *   B = swing low (major downtrend defined)
 *   C = reaction high (bounce from B)
 * Entry: bar[i].low < bar[i-1].low (first downward tick after reaction)
 */
function findBearSetup(
  candles: CandleRaw[],
  i: number,
  atr: number,
  requireFib = false,
): DaggerSetup | null {
  if (i < WARMUP + 4 || atr <= 0) return null;

  const bEnd   = i - 3;
  const bStart = Math.max(0, i - TREND_LOOKBACK);
  if (bEnd <= bStart) return null;

  let bIdx = bStart, bPrice = candles[bStart].low;
  for (let j = bStart + 1; j <= bEnd; j++) {
    if (candles[j].low < bPrice) { bPrice = candles[j].low; bIdx = j; }
  }

  for (let j = bIdx + 1; j < i; j++) {
    if (candles[j].low <= bPrice) return null;
  }

  const aStart = Math.max(0, bIdx - TREND_LOOKBACK);
  if (aStart >= bIdx) return null;
  let aIdx = aStart, aPrice = candles[aStart].high;
  for (let j = aStart + 1; j < bIdx; j++) {
    if (candles[j].high > aPrice) { aPrice = candles[j].high; aIdx = j; }
  }

  if (aPrice - bPrice < MIN_TREND_ATR * atr) return null;
  if (i - bIdx > MAX_REACTION_BARS) return null;

  if (bIdx + 1 > i - 1) return null;
  let cIdx = bIdx + 1, cPrice = candles[bIdx + 1].high;
  for (let j = bIdx + 2; j <= i - 1; j++) {
    if (candles[j].high > cPrice) { cPrice = candles[j].high; cIdx = j; }
  }

  if (cPrice - bPrice < MIN_REACTION_ATR * atr) return null;

  // Optional Fibonacci filter: B→C retracement must land in the 40–65% pocket
  if (requireFib) {
    const retracePct = (cPrice - bPrice) / (aPrice - bPrice);
    if (retracePct < FIB_LOW || retracePct > FIB_HIGH) return null;
  }

  const sl = cPrice + SL_BUFFER * atr;
  const tp = bPrice;

  return { direction: "bear", aIdx, aPrice, bIdx, bPrice, cIdx, cPrice, tp, sl };
}

// ─── Trade Simulator ──────────────────────────────────────────────────────────

/**
 * Simulates a trade from the entry bar to exit.
 *   Bull: entry = bar[entryBar].high, SL below C, TP = B
 *   Bear: entry = bar[entryBar].low,  SL above C, TP = B
 * Returns null if entry is already beyond SL (invalid fill).
 */
function simulateTrade(
  candles: CandleRaw[],
  entryBar: number,
  setup: DaggerSetup,
): Trade | null {
  const isBull = setup.direction === "bull";
  const entry  = isBull ? candles[entryBar].high : candles[entryBar].low;
  const sl     = setup.sl;
  const tp     = setup.tp;

  // Reject if entry is already on wrong side of SL
  if (isBull && entry <= sl) return null;
  if (!isBull && entry >= sl) return null;
  // Reject if entry has already blown past TP (shouldn't happen but guard it)
  if (isBull && entry >= tp) return null;
  if (!isBull && entry <= tp) return null;

  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return null;

  const lastBar = candles.length - 1;
  for (let j = entryBar + 1; j <= lastBar; j++) {
    const bar = candles[j];
    if (isBull) {
      if (bar.low  <= sl) return mk("SL",  -1,                               j - entryBar, entry, sl, tp, setup);
      if (bar.high >= tp) return mk("TP",  (tp - entry) / slDist,            j - entryBar, entry, sl, tp, setup);
    } else {
      if (bar.high >= sl) return mk("SL",  -1,                               j - entryBar, entry, sl, tp, setup);
      if (bar.low  <= tp) return mk("TP",  (entry - tp) / slDist,            j - entryBar, entry, sl, tp, setup);
    }
  }
  const closeP = candles[lastBar].close;
  const expR   = isBull ? (closeP - entry) / slDist : (entry - closeP) / slDist;
  return mk("EXPIRED", expR, lastBar - entryBar, entry, sl, tp, setup);
}

function mk(
  outcome: Outcome, r: number, barsHeld: number,
  entry: number, sl: number, tp: number, setup: DaggerSetup,
): Trade {
  return {
    symbol: "", timeframe: "1h", direction: setup.direction,
    entry, sl, tp, outcome, r, barsHeld, cIdx: setup.cIdx,
  };
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

function backtestSymbol(
  symbol: string,
  timeframe: Timeframe,
  candles: CandleRaw[],
  gates: GateMode,
  bullOnly: boolean,
  requireFib = false,
): Trade[] {
  const trades: Trade[] = [];
  if (candles.length < WARMUP + 10) return trades;

  const closes   = candles.map(c => c.close);
  const macdHist = calcMACDHist(closes);

  // Direction-scoped de-dup: once a cIdx fires its entry trigger it is consumed.
  // This prevents the same reaction low re-triggering on later bars if the first
  // trigger bar failed the gate (gate failure = setup is dead, no re-entry).
  const triggeredCIdx = new Set<string>();

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const atr = calcATR(candles.slice(0, i + 1));
    if (atr <= 0) continue;

    const hist1    = macdHist[i - 1];
    const hist2    = macdHist[i - 2];
    const macdWarm = !isNaN(hist1) && !isNaN(hist2);

    // ── Bull ──────────────────────────────────────────────────────────────
    {
      // Entry trigger (book Fig 11.2): first bar ticking back up after the reaction
      const triggered = candles[i].high > candles[i - 1].high;
      if (triggered) {
        const s = findBullSetup(candles, i, atr, requireFib);
        if (s && !triggeredCIdx.has(`bull:${s.cIdx}`)) {
          triggeredCIdx.add(`bull:${s.cIdx}`);  // consume on first trigger

          // Entry bar must not breach the reaction low (setup still valid)
          const entryValid = candles[i].low > s.cPrice;

          if (entryValid && passesGates(gates, "bull", macdWarm, hist1, hist2,
              calcRSI(closes.slice(0, i + 1)))) {
            const t = simulateTrade(candles, i, s);
            if (t) {
              t.symbol = symbol; t.timeframe = timeframe;
              trades.push(t);
            }
          }
        }
      }
    }

    // ── Bear ──────────────────────────────────────────────────────────────
    if (!bullOnly) {
      const triggered = candles[i].low < candles[i - 1].low;
      if (triggered) {
        const s = findBearSetup(candles, i, atr, requireFib);
        if (s && !triggeredCIdx.has(`bear:${s.cIdx}`)) {
          triggeredCIdx.add(`bear:${s.cIdx}`);

          const entryValid = candles[i].high < s.cPrice;

          if (entryValid && passesGates(gates, "bear", macdWarm, hist1, hist2,
              calcRSI(closes.slice(0, i + 1)))) {
            const t = simulateTrade(candles, i, s);
            if (t) {
              t.symbol = symbol; t.timeframe = timeframe;
              trades.push(t);
            }
          }
        }
      }
    }
  }

  return trades;
}

function passesGates(
  mode: GateMode,
  dir: Direction,
  macdWarm: boolean,
  hist1: number,
  hist2: number,
  rsiVal: number,
): boolean {
  if (mode === "none") return true;

  // MACD gate: histogram must be ticking in the trade direction
  if (mode === "macd" || mode === "macd+rsi") {
    if (macdWarm) {
      if (dir === "bull" && hist1 <= hist2) return false;
      if (dir === "bear" && hist1 >= hist2) return false;
    }
  }

  // RSI gate: show exhaustion at the reaction extreme
  if (mode === "macd+rsi") {
    if (!isNaN(rsiVal)) {
      if (dir === "bull" && rsiVal > 45) return false;
      if (dir === "bear" && rsiVal < 55) return false;
    }
  }

  return true;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

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
    totalR  += r;
    equity  += r;
    if (r > 0) { wins++; grossWin  += r; } else { grossLoss += Math.abs(r); }
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
  throw new Error(`No data source for ${sym}`);
}

// ─── Table Printer ────────────────────────────────────────────────────────────

function pct(n: number) { return isFinite(n) ? n.toFixed(1) + "%" : "—"; }
function fmt(n: number, d = 1) { return isFinite(n) ? n.toFixed(d) : "—"; }

function printTable(
  header: string,
  rows: Array<{ sym: string; tf: string; stats: Stats }>,
) {
  console.log(`\n${"═".repeat(90)}`);
  console.log(`  ${header}`);
  console.log(`${"═".repeat(90)}`);
  console.log(
    "  " +
    "Symbol    ".padEnd(12) + "TF  ".padEnd(6) +
    "Trades".padEnd(8) + "WR%   ".padEnd(8) +
    "AvgR ".padEnd(8) + "TotalR ".padEnd(9) +
    "PF    ".padEnd(8) + "MaxDD"
  );
  console.log("  " + "─".repeat(86));
  let sumT = 0, sumW = 0, sumR = 0;
  for (const { sym, tf, stats: s } of rows) {
    console.log(
      "  " + sym.padEnd(12) + tf.padEnd(6) +
      String(s.trades).padEnd(8) +
      (s.trades > 0 ? pct(s.winRate)           : "—").padEnd(8) +
      (s.trades > 0 ? fmt(s.avgR, 2)           : "—").padEnd(8) +
      (s.trades > 0 ? fmt(s.totalR, 1)         : "—").padEnd(9) +
      (s.trades > 0 ? fmt(s.profitFactor, 2)   : "—").padEnd(8) +
      (s.trades > 0 ? fmt(s.maxDD, 1) + "R"   : "—")
    );
    sumT += s.trades; sumW += s.wins; sumR += s.totalR;
  }
  if (sumT > 0) {
    console.log("  " + "─".repeat(86));
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
  const symKeys  = Object.keys(SYMBOLS);
  const variants: GateMode[] = ["none", "macd", "macd+rsi"];
  const varLabels: Record<GateMode, string> = {
    "none":     "RAW DAGGER  — no filters, bull + bear  (book definition, pure price action)",
    "macd":     "MACD-GATED  — MACD histogram ticking in trade direction",
    "macd+rsi": "MACD + RSI  — MACD ticking + RSI ≤45 (bull) / ≥55 (bear)",
  };

  // candleCache[sym][tf]
  const candleCache: Record<string, Record<string, CandleRaw[]>> = {};

  console.log("\n  Dagger Entry Backtest (book Fig 11.2) — fetching candles ...\n");

  for (const sym of symKeys) {
    candleCache[sym] = {};
    const cfg = SYMBOLS[sym];
    for (const tf of TIMEFRAMES) {
      try {
        process.stdout.write(`  ${cfg.label.padEnd(12)} ${tf.padEnd(5)} — fetching ... `);
        const candles = await fetchCandles(sym, cfg, tf);
        candleCache[sym][tf] = candles;
        console.log(`${candles.length} bars`);
      } catch (err) {
        console.log(`SKIP (${(err as Error).message.slice(0, 60)})`);
        candleCache[sym][tf] = [];
      }
    }
  }

  type RunCfg = { label: string; gates: GateMode; bullOnly: boolean; requireFib: boolean };

  const runs: RunCfg[] = [
    // ── Ordinal Dagger (no fib constraint) ───────────────────────────────
    { label: "RAW DAGGER  — no filters, bull+bear (book Fig 11.2, pure price action)",  gates: "none",     bullOnly: false, requireFib: false },
    { label: "RAW DAGGER  — bull only",                                                  gates: "none",     bullOnly: true,  requireFib: false },
    { label: "MACD-GATED  — MACD histogram ticking in trade direction",                  gates: "macd",     bullOnly: false, requireFib: false },
    { label: "MACD + RSI  — MACD ticking + RSI ≤45 (bull) / ≥55 (bear)",               gates: "macd+rsi", bullOnly: false, requireFib: false },

    // ── Fib 40–65% filter (the 50% pocket setup from ZEC screenshot) ─────
    { label: "FIB 40–65%  — no gate, bull+bear (50% pullback pocket)",                  gates: "none",     bullOnly: false, requireFib: true  },
    { label: "FIB 40–65%  — bull only",                                                  gates: "none",     bullOnly: true,  requireFib: true  },
    { label: "FIB + MACD  — 50% pocket + MACD ticking in trade direction",               gates: "macd",     bullOnly: false, requireFib: true  },
    { label: "FIB + MACD + RSI  — 50% pocket + MACD + RSI exhaustion",                  gates: "macd+rsi", bullOnly: false, requireFib: true  },
  ];

  for (const run of runs) {
    const rows: Array<{ sym: string; tf: string; stats: Stats }> = [];
    const allTrades: Trade[] = [];

    for (const sym of symKeys) {
      const cfg = SYMBOLS[sym];
      for (const tf of TIMEFRAMES) {
        const candles = candleCache[sym][tf] ?? [];
        const trades  = candles.length
          ? backtestSymbol(sym, tf, candles, run.gates, run.bullOnly, run.requireFib)
          : [];
        allTrades.push(...trades);
        rows.push({ sym: cfg.label, tf, stats: computeStats(trades) });
      }
    }

    printTable(run.label, rows);

    if (allTrades.length > 0) {
      const all  = computeStats(allTrades);
      const bull = computeStats(allTrades.filter(t => t.direction === "bull"));
      const bear = computeStats(allTrades.filter(t => t.direction === "bear"));

      console.log(`\n${"═".repeat(90)}`);
      console.log("  SUMMARY");
      console.log(`${"═".repeat(90)}`);
      console.log(`  Total trades  : ${all.trades}`);
      console.log(`  Win rate      : ${pct(all.winRate)}`);
      console.log(`  Avg R/trade   : ${fmt(all.avgR, 3)}`);
      console.log(`  Total R       : ${fmt(all.totalR, 1)}`);
      console.log(`  Profit factor : ${fmt(all.profitFactor, 2)}`);
      console.log(`  Max drawdown  : ${fmt(all.maxDD, 1)}R`);
      if (!run.bullOnly) {
        console.log(`  Bull  ${String(bull.trades).padEnd(4)} trades  WR ${pct(bull.winRate)}  AvgR ${fmt(bull.avgR, 2)}  PF ${fmt(bull.profitFactor, 2)}`);
        console.log(`  Bear  ${String(bear.trades).padEnd(4)} trades  WR ${pct(bear.winRate)}  AvgR ${fmt(bear.avgR, 2)}  PF ${fmt(bear.profitFactor, 2)}`);
      }

      console.log(`\n  PER-SYMBOL (all TFs combined)`);
      console.log("  " + "─".repeat(72));
      console.log("  " + "Symbol      ".padEnd(14) + "Trades".padEnd(8) + "WR%   ".padEnd(8) + "AvgR  ".padEnd(8) + "TotalR  ".padEnd(10) + "PF");
      console.log("  " + "─".repeat(72));
      for (const sym of symKeys) {
        const cfg   = SYMBOLS[sym];
        const symTs = allTrades.filter(t => t.symbol === sym);
        if (!symTs.length) continue;
        const s = computeStats(symTs);
        console.log(
          "  " + cfg.label.padEnd(14) +
          String(s.trades).padEnd(8) + pct(s.winRate).padEnd(8) +
          fmt(s.avgR, 2).padEnd(8)  + fmt(s.totalR, 1).padEnd(10) +
          fmt(s.profitFactor, 2)
        );
      }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
