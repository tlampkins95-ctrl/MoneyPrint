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
 * Variants reported:
 *   Simple   — 3-swing matrix at primary 120-bar lookback
 *   Extended — 5-swing matrix (second dagger on the CD leg as new impulse)
 *   Confluent — simple setups where a secondary 80-bar lookback projects D
 *               within 0.25×ATR of the primary D (double-intersection)
 *   All      — combined simple + extended for a total picture
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

// Yahoo Finance range params per timeframe
const YAHOO_CFG: Record<Timeframe, { interval: string; range: string }> = {
  "15m": { interval: "15m",  range: "60d"  },
  "30m": { interval: "30m",  range: "60d"  },
  "1h":  { interval: "60m",  range: "730d" },
  "1d":  { interval: "1d",   range: "2y"   },
};

const OKX_BAR: Record<Timeframe, string> = {
  "15m": "15m", "30m": "30m", "1h": "1H", "1d": "1D",
};

// ─── Indicator Helpers ────────────────────────────────────────────────────────

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
  const ml = closes.map((_, i) => (isNaN(fe[i]) || isNaN(se[i])) ? NaN : fe[i] - se[i]);
  const vs = slow - 1;
  const sl_ = calcEMA(ml.slice(vs), sig);
  for (let i = 0; i < sl_.length; i++) {
    const g = vs + i;
    if (!isNaN(ml[g]) && !isNaN(sl_[i])) out[g] = ml[g] - sl_[i];
  }
  return out;
}

// ─── Wave Detection ───────────────────────────────────────────────────────────

const MIN_IMPULSE_ATR  = 3.0;
const MIN_SH_BARS_AGO  = 3;
const MIN_RETRACE_FROM_PEAK = 0.10;  // price must have retraced ≥10% from B
const DAGGER_LOW       = 0.38;       // slightly wider than 40 to allow real structure
const DAGGER_HIGH      = 0.62;
const ENTRY_ATR_BAND   = 0.75;       // price must be within N×ATR of C

function findBullDagger(
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
  const cur = slice[n - 1].close;

  // B = highest high, must be ≥ MIN_SH_BARS_AGO before current
  const bSearchEnd = n - MIN_SH_BARS_AGO;
  if (bSearchEnd <= 1) return null;
  let bLoc = 0;
  for (let i = 1; i < bSearchEnd; i++) {
    if (slice[i].high > slice[bLoc].high) bLoc = i;
  }
  const bPrice = slice[bLoc].high;

  // No new high after B (impulse settled)
  for (let i = bLoc + 1; i < n; i++) {
    if (slice[i].high > bPrice) return null;
  }

  // A = lowest low before B
  if (bLoc === 0) return null;
  let aLoc = 0;
  for (let i = 1; i < bLoc; i++) {
    if (slice[i].low < slice[aLoc].low) aLoc = i;
  }
  const aPrice = slice[aLoc].low;
  if (bPrice <= aPrice) return null;

  const abLeg = bPrice - aPrice;
  if (abLeg < MIN_IMPULSE_ATR * atr) return null;

  // Price must have retraced ≥10% from B
  if (cur > bPrice - abLeg * MIN_RETRACE_FROM_PEAK) return null;

  // C = lowest low after B
  if (bLoc >= n - 1) return null;
  let cLoc = bLoc + 1;
  for (let i = bLoc + 2; i < n; i++) {
    if (slice[i].low < slice[cLoc].low) cLoc = i;
  }
  const cPrice = slice[cLoc].low;

  // Retracement B→C must be 38–62% of AB
  const rPct = (bPrice - cPrice) / abLeg;
  if (rPct < DAGGER_LOW || rPct > DAGGER_HIGH) return null;

  // Current price must be within ENTRY_ATR_BAND×ATR above C (at the pullback level)
  if (cur < cPrice - atr * 0.5) return null;       // too far below (already blew through)
  if (cur > cPrice + atr * ENTRY_ATR_BAND) return null; // too far above C (missed the dip)

  const dTarget = cPrice + abLeg;

  return {
    direction: "bull",
    aPrice, aIdx: start + aLoc,
    bPrice, bIdx: start + bLoc,
    cPrice, cIdx: start + cLoc,
    dTarget, abLeg,
  };
}

function findBearDagger(
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
  const cur = slice[n - 1].close;

  // B = lowest low (impulse down peak), must be ≥ MIN_SH_BARS_AGO before current
  const bSearchEnd = n - MIN_SH_BARS_AGO;
  if (bSearchEnd <= 1) return null;
  let bLoc = 0;
  for (let i = 1; i < bSearchEnd; i++) {
    if (slice[i].low < slice[bLoc].low) bLoc = i;
  }
  const bPrice = slice[bLoc].low;

  // No new low after B
  for (let i = bLoc + 1; i < n; i++) {
    if (slice[i].low < bPrice) return null;
  }

  // A = highest high before B
  if (bLoc === 0) return null;
  let aLoc = 0;
  for (let i = 1; i < bLoc; i++) {
    if (slice[i].high > slice[aLoc].high) aLoc = i;
  }
  const aPrice = slice[aLoc].high;
  if (aPrice <= bPrice) return null;

  const abLeg = aPrice - bPrice;
  if (abLeg < MIN_IMPULSE_ATR * atr) return null;

  // Price must have bounced ≥10% from B
  if (cur < bPrice + abLeg * MIN_RETRACE_FROM_PEAK) return null;

  // C = highest high after B (correction bounce)
  if (bLoc >= n - 1) return null;
  let cLoc = bLoc + 1;
  for (let i = bLoc + 2; i < n; i++) {
    if (slice[i].high > slice[cLoc].high) cLoc = i;
  }
  const cPrice = slice[cLoc].high;

  // Correction (C−B)/(A−B) must be 38–62%
  const rPct = (cPrice - bPrice) / abLeg;
  if (rPct < DAGGER_LOW || rPct > DAGGER_HIGH) return null;

  // Current price must be within ENTRY_ATR_BAND×ATR below C
  if (cur > cPrice + atr * 0.5) return null;
  if (cur < cPrice - atr * ENTRY_ATR_BAND) return null;

  const dTarget = cPrice - abLeg;

  return {
    direction: "bear",
    aPrice, aIdx: start + aLoc,
    bPrice, bIdx: start + bLoc,
    cPrice, cIdx: start + cLoc,
    dTarget, abLeg,
  };
}

// ─── Trade Simulator ──────────────────────────────────────────────────────────

const MIN_R_AT_TP2  = 1.5;  // reject setups where TP2 is < 1.5R
const MAX_BARS_OPEN = 100;  // expire open trades after this many bars

function simulateTrade(
  candles: CandleRaw[],
  entryBar: number,
  setup: DaggerSetup,
  atr: number,
  meta: { isExtended: boolean; isConfluent: boolean; symbol: string; timeframe: Timeframe },
): Trade | null {
  const isBull = setup.direction === "bull";
  const entry = isBull
    ? Math.min(setup.cPrice, candles[entryBar].close)
    : Math.max(setup.cPrice, candles[entryBar].close);

  const sl  = isBull ? setup.cPrice - atr * 0.5 : setup.cPrice + atr * 0.5;
  const tp2 = setup.dTarget;

  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return null;

  const rAtTp2 = Math.abs(tp2 - entry) / slDist;
  if (rAtTp2 < MIN_R_AT_TP2) return null;

  // Validate direction: D must be beyond entry (not on wrong side)
  if (isBull && tp2 <= entry) return null;
  if (!isBull && tp2 >= entry) return null;

  const maxBar = Math.min(entryBar + MAX_BARS_OPEN, candles.length - 1);
  for (let j = entryBar + 1; j <= maxBar; j++) {
    const bar = candles[j];
    if (isBull) {
      if (bar.low  <= sl)  return mkTrade("SL",  -1,       j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
      if (bar.high >= tp2) return mkTrade("TP2", rAtTp2,   j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
    } else {
      if (bar.high >= sl)  return mkTrade("SL",  -1,       j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
      if (bar.low  <= tp2) return mkTrade("TP2", rAtTp2,   j - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
    }
  }
  const closeP = candles[maxBar].close;
  const expiredR = isBull ? (closeP - entry) / slDist : (entry - closeP) / slDist;
  return mkTrade("EXPIRED", expiredR, maxBar - entryBar, entry, sl, tp2, rAtTp2, setup, meta);
}

function mkTrade(
  outcome: Outcome, r: number, barsHeld: number,
  entry: number, sl: number, tp2: number, rAtTp2: number,
  setup: DaggerSetup,
  meta: { isExtended: boolean; isConfluent: boolean; symbol: string; timeframe: Timeframe },
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

function backtestSymbol(
  symbol: string,
  timeframe: Timeframe,
  candles: CandleRaw[],
  longOnly: boolean,
): Trade[] {
  const trades: Trade[] = [];
  if (candles.length < 150) return trades;

  const closes = candles.map(c => c.close);
  const macdHist = calcMACDHist(closes);

  // Track which correction indices have already generated a trade (dedup)
  const usedCIdx = new Set<number>();
  // Track D targets that have been reached (to identify extended setups)
  const reachedD = new Set<number>(); // keyed by Math.round(dTarget / atrUnit)

  const WARMUP = 150;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const atr = calcATR(candles.slice(0, i + 1));
    if (atr <= 0) continue;

    const rsiVal = calcRSI(closes.slice(0, i + 1));
    const hist1  = macdHist[i - 1];   // last completed bar
    const hist2  = macdHist[i - 2];   // bar before that
    const macdWarm = !isNaN(hist1) && !isNaN(hist2);

    // ── Bull setup ────────────────────────────────────────────────────
    if (!longOnly || true) {  // always try bull
      const bull120 = findBullDagger(candles, i, atr, 120);
      if (bull120 && !usedCIdx.has(bull120.cIdx)) {
        const rsiOk  = isNaN(rsiVal) || rsiVal <= 35;
        const macdOk = !macdWarm || hist1 > hist2;
        if (rsiOk && macdOk) {
          // Check confluence with 80-bar lookback
          const bull80 = findBullDagger(candles, i, atr, 80);
          const isConfluent = bull80 != null &&
            Math.abs(bull80.dTarget - bull120.dTarget) < atr * 0.25;

          // Check if this is an extended setup (bIdx matches a prior D)
          const bKey = Math.round(bull120.bPrice / (atr * 0.25));
          const isExtended = reachedD.has(bKey);

          const t = simulateTrade(candles, i, bull120, atr, {
            isExtended, isConfluent, symbol, timeframe,
          });
          if (t) {
            t.entryBar = i;
            trades.push(t);
            usedCIdx.add(bull120.cIdx);

            // Mark this D as reached if TP2 was hit
            if (t.outcome === "TP2") {
              const dKey = Math.round(bull120.dTarget / (atr * 0.25));
              reachedD.add(dKey);
            }
          }
        }
      }
    }

    // ── Bear setup ────────────────────────────────────────────────────
    if (!longOnly) {
      const bear120 = findBearDagger(candles, i, atr, 120);
      if (bear120 && !usedCIdx.has(bear120.cIdx)) {
        const rsiOk  = isNaN(rsiVal) || rsiVal >= 65;
        const macdOk = !macdWarm || hist1 < hist2;
        if (rsiOk && macdOk) {
          const bear80 = findBearDagger(candles, i, atr, 80);
          const isConfluent = bear80 != null &&
            Math.abs(bear80.dTarget - bear120.dTarget) < atr * 0.25;

          const bKey = Math.round(bear120.bPrice / (atr * 0.25));
          const isExtended = reachedD.has(bKey);

          const t = simulateTrade(candles, i, bear120, atr, {
            isExtended, isConfluent, symbol, timeframe,
          });
          if (t) {
            t.entryBar = i;
            trades.push(t);
            usedCIdx.add(bear120.cIdx);

            if (t.outcome === "TP2") {
              const dKey = Math.round(bear120.dTarget / (atr * 0.25));
              reachedD.add(dKey);
            }
          }
        }
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
  maxDD: number;   // max drawdown in R units (running)
}

function computeStats(trades: Trade[]): Stats {
  if (trades.length === 0) {
    return { trades: 0, wins: 0, winRate: 0, totalR: 0, avgR: 0, profitFactor: 0, maxDD: 0 };
  }
  let wins = 0, grossWin = 0, grossLoss = 0, totalR = 0;
  let peak = 0, drawdown = 0, maxDD = 0, equity = 0;

  for (const t of trades) {
    const r = t.outcome === "EXPIRED" ? Math.max(-1, t.r) : t.r;
    totalR += r;
    equity += r;
    if (r > 0) { wins++; grossWin += r; }
    else        { grossLoss += Math.abs(r); }
    if (equity > peak) peak = equity;
    drawdown = peak - equity;
    if (drawdown > maxDD) maxDD = drawdown;
  }

  return {
    trades: trades.length,
    wins,
    winRate: wins / trades.length * 100,
    totalR,
    avgR: totalR / trades.length,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss,
    maxDD,
  };
}

// ─── Candle Fetchers ──────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

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
  const isIntraday = tf !== "1d";
  const candles: CandleRaw[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    const iso = new Date(r.timestamp[i] * 1000).toISOString();
    candles.push({ date: isIntraday ? iso : iso.split("T")[0], open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
  }
  return candles;
}

async function okxGet(path: string): Promise<string[][]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://www.okx.com/api/v5${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DaggerBacktest/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(600 * Math.pow(2, attempt - 1));
      continue;
    }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
    const json = await res.json() as { code: string; msg: string; data: string[][] };
    if (json.code !== "0") throw new Error(`OKX error ${json.code}: ${json.msg}`);
    return json.data;
  }
  throw new Error("OKX request failed after retries");
}

async function fetchOkxCandles(instId: string, tf: Timeframe): Promise<CandleRaw[]> {
  const bar = OKX_BAR[tf];
  const target = tf === "1d" ? 1500 : tf === "1h" ? 2500 : 1500;
  const isIntraday = tf !== "1d";

  const latest = await okxGet(`/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=300`);
  const collected: string[][] = [...latest];
  let oldest = collected.length ? Number(collected[collected.length - 1][0]) : Date.now();

  let safety = 30;
  while (collected.length < target && safety-- > 0) {
    const rem = Math.min(100, target - collected.length);
    const page = await okxGet(`/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${rem}&after=${oldest}`);
    if (!page.length) break;
    collected.push(...page);
    oldest = Number(page[page.length - 1][0]);
    if (page.length < rem) break;
    await sleep(120);
  }

  const byTime = new Map<number, CandleRaw>();
  for (const row of collected) {
    const ts = Number(row[0]);
    const o = parseFloat(row[1]), h = parseFloat(row[2]), l = parseFloat(row[3]), c = parseFloat(row[4]);
    if (!isFinite(ts) || ![o, h, l, c].every(isFinite)) continue;
    const iso = new Date(ts).toISOString();
    byTime.set(ts, {
      date: isIntraday ? iso : iso.split("T")[0],
      open: o, high: h, low: l, close: c,
      volume: isFinite(parseFloat(row[5])) ? parseFloat(row[5]) : 0,
    });
  }
  return Array.from(byTime.entries()).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

async function fetchCandles(sym: string, cfg: SymbolCfg, tf: Timeframe): Promise<CandleRaw[]> {
  if (cfg.okxPerp) return fetchOkxCandles(cfg.okxPerp, tf);
  if (cfg.yahoo)   return fetchYahooCandles(cfg.yahoo, tf);
  throw new Error(`No data source for ${sym}`);
}

// ─── Table Printer ────────────────────────────────────────────────────────────

function fmt(n: number, d = 1): string {
  return isFinite(n) ? n.toFixed(d) : "—";
}

function pct(n: number): string {
  return isFinite(n) ? n.toFixed(1) + "%" : "—";
}

function printVariantTable(
  header: string,
  rows: Array<{ sym: string; tf: string; stats: Stats }>,
) {
  const totals = computeStats(rows.flatMap(r => [] as Trade[]));
  console.log(`\n${"═".repeat(86)}`);
  console.log(`  ${header}`);
  console.log(`${"═".repeat(86)}`);
  console.log(
    "  " +
    "Symbol   ".padEnd(10) +
    "TF  ".padEnd(6) +
    "Trades".padEnd(8) +
    "WR%   ".padEnd(8) +
    "AvgR ".padEnd(8) +
    "TotalR ".padEnd(9) +
    "PF   ".padEnd(7) +
    "MaxDD"
  );
  console.log("  " + "─".repeat(82));
  let sumTrades = 0, sumWins = 0, sumTotalR = 0, sumGrossWin = 0, sumGrossLoss = 0;
  for (const row of rows) {
    const s = row.stats;
    if (s.trades === 0) continue;
    console.log(
      "  " +
      row.sym.padEnd(10) +
      row.tf.padEnd(6) +
      String(s.trades).padEnd(8) +
      pct(s.winRate).padEnd(8) +
      fmt(s.avgR, 2).padEnd(8) +
      fmt(s.totalR, 1).padEnd(9) +
      fmt(s.profitFactor, 2).padEnd(7) +
      fmt(s.maxDD, 1) + "R"
    );
    sumTrades += s.trades;
    sumWins   += s.wins;
    sumTotalR += s.totalR;
  }
  if (sumTrades > 0) {
    console.log("  " + "─".repeat(82));
    console.log(
      "  " +
      "TOTAL".padEnd(10) +
      "".padEnd(6) +
      String(sumTrades).padEnd(8) +
      pct(sumWins / sumTrades * 100).padEnd(8) +
      fmt(sumTotalR / sumTrades, 2).padEnd(8) +
      fmt(sumTotalR, 1).padEnd(9)
    );
  } else {
    console.log("  (no trades found)");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const symKeys   = Object.keys(SYMBOLS);
  const allTrades: Trade[] = [];

  console.log("\n  Dagger Entry Backtest — fetching candles ...\n");

  const byVariant: Record<string, { sym: string; tf: string; stats: Stats }[]> = {
    simple:    [],
    extended:  [],
    confluent: [],
    all:       [],
  };

  for (const sym of symKeys) {
    const cfg = SYMBOLS[sym];
    for (const tf of TIMEFRAMES) {
      let candles: CandleRaw[];
      try {
        process.stdout.write(`  ${cfg.label} ${tf.padEnd(4)} — fetching ... `);
        candles = await fetchCandles(sym, cfg, tf);
        console.log(`${candles.length} bars`);
      } catch (err) {
        console.log(`SKIP (${(err as Error).message.slice(0, 60)})`);
        continue;
      }

      const trades = backtestSymbol(sym, tf, candles, cfg.longOnly ?? false);
      allTrades.push(...trades);

      const simple    = trades.filter(t => !t.isExtended);
      const extended  = trades.filter(t => t.isExtended);
      const confluent = trades.filter(t => t.isConfluent);

      byVariant.simple.push(   { sym: cfg.label, tf, stats: computeStats(simple)    });
      byVariant.extended.push( { sym: cfg.label, tf, stats: computeStats(extended)  });
      byVariant.confluent.push({ sym: cfg.label, tf, stats: computeStats(confluent) });
      byVariant.all.push(      { sym: cfg.label, tf, stats: computeStats(trades)     });
    }
  }

  // ── Direction breakdown ───────────────────────────────────────────────────
  const bulls = allTrades.filter(t => t.direction === "bull");
  const bears = allTrades.filter(t => t.direction === "bear");
  const bs = computeStats(bulls);
  const brs = computeStats(bears);

  printVariantTable("SIMPLE DAGGER  (3-swing, primary 120-bar lookback)", byVariant.simple);
  printVariantTable("EXTENDED DAGGER  (5-swing: second dagger on the CD leg)", byVariant.extended);
  printVariantTable("CONFLUENT DAGGER  (double intersection: 80-bar D ≈ 120-bar D ± 0.25×ATR)", byVariant.confluent);
  printVariantTable("ALL DAGGER  (simple + extended combined)", byVariant.all);

  const all = computeStats(allTrades);
  console.log(`\n${"═".repeat(86)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(86)}`);
  console.log(`  Total trades  : ${allTrades.length}`);
  console.log(`  Overall WR    : ${pct(all.winRate)}`);
  console.log(`  Overall AvgR  : ${fmt(all.avgR, 3)}`);
  console.log(`  Overall TotalR: ${fmt(all.totalR, 1)}`);
  console.log(`  Profit Factor : ${fmt(all.profitFactor, 2)}`);
  console.log(`  Max Drawdown  : ${fmt(all.maxDD, 1)}R`);
  console.log(`  Bull  ${bs.trades} trades  WR ${pct(bs.winRate)}  AvgR ${fmt(bs.avgR, 2)}  PF ${fmt(bs.profitFactor, 2)}`);
  console.log(`  Bear  ${brs.trades} trades  WR ${pct(brs.winRate)}  AvgR ${fmt(brs.avgR, 2)}  PF ${fmt(brs.profitFactor, 2)}`);
  console.log(`${"═".repeat(86)}\n`);

  // ── Per-symbol summary ────────────────────────────────────────────────────
  console.log("  PER-SYMBOL OVERVIEW (all timeframes combined)");
  console.log(`  ${"Symbol".padEnd(12)}${"Trades".padEnd(8)}${"WR%".padEnd(8)}${"AvgR".padEnd(8)}${"TotalR".padEnd(10)}PF`);
  console.log("  " + "─".repeat(62));
  for (const sym of symKeys) {
    const cfg = SYMBOLS[sym];
    const symTrades = allTrades.filter(t => t.symbol === sym);
    if (!symTrades.length) continue;
    const s = computeStats(symTrades);
    console.log(
      "  " +
      cfg.label.padEnd(12) +
      String(s.trades).padEnd(8) +
      pct(s.winRate).padEnd(8) +
      fmt(s.avgR, 2).padEnd(8) +
      fmt(s.totalR, 1).padEnd(10) +
      fmt(s.profitFactor, 2)
    );
  }
  console.log();
}

main().catch(err => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
