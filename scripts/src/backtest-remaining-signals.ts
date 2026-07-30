#!/usr/bin/env tsx
/**
 * Backtest for the three signal types still allowed to auto-trade real money
 * after FIB50_SWING's removal: BB_REJECTION, DOUBLE_BOTTOM, DOUBLE_TOP.
 *
 * Unlike the harmonic/FIB786 backtests, this one imports `computeLevels`
 * DIRECTLY from the real artifacts/api-server/src/lib/signals.ts rather than
 * re-deriving the logic — these three signals depend on a large web of
 * shared state (MACD gates, higher-timeframe daily/weekly confirmation,
 * Bollinger squeeze detection, floorTarget) that would be easy to get subtly
 * wrong by hand. Testing the actual production function is both faster and
 * far more trustworthy. Confirmed safe: computeLevels has no DB/file side
 * effects when DATABASE_URL is unset (verified via smoke test).
 *
 * Walks forward on 1h and 4h real OKX candle history for the TradingView
 * watchlist, feeding real daily candles as dailyCandlesForWeekly (required
 * for higherTfAllowsBuy/Sell to evaluate at all — without it those gates
 * default to blocking). Reports win rate, avg R, and sample size per type,
 * plus which candidates got detected but blocked (to explain frequency).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backtest:remaining-signals
 */

export {};

import { computeLevels } from "../../artifacts/api-server/src/lib/signals";
import type { SymbolMeta } from "../../artifacts/api-server/src/lib/symbols";

type Timeframe = "15m" | "1h" | "4h" | "1d" | "1w";
type TargetType = "BB_REJECTION" | "DOUBLE_BOTTOM" | "DOUBLE_TOP";

interface CandleRaw {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  symbol: string;
  timeframe: Timeframe;
  signalType: TargetType;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  outcome: "SL" | "TP1" | "TP2" | "MISSED" | "EXPIRED";
  r: number;
  barsHeld: number;
}

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

function buildMeta(ticker: string, okxPerp: string): SymbolMeta {
  return {
    yahoo: "", tvSymbol: `OKX:${okxPerp}`, tvScrapePath: "",
    label: `${ticker.replace(/USDT$/, "")} / USDT`, decimals: 5, prefix: "$",
    category: "crypto", okxPerp,
  };
}

const TARGET_TYPES: TargetType[] = ["BB_REJECTION", "DOUBLE_BOTTOM", "DOUBLE_TOP"];

// ─── Candle fetching (OKX) ────────────────────────────────────────────────────

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function okxGet(path: string): Promise<string[][]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://www.okx.com/api/v5${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalBacktest/1.0)" },
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

const OKX_BAR: Record<Timeframe, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };

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

// ─── Backtest engine ──────────────────────────────────────────────────────────

const WARMUP = 210; // computeLevels needs 200-bar swing lookback + MACD warmup
const ENTRY_TIMEOUT_BARS = 40; // give a limit order this many bars to fill or go stale

function backtestSymbolTf(
  symbol: string,
  timeframe: Timeframe,
  candles: CandleRaw[],
  dailyCandles: CandleRaw[],
  meta: SymbolMeta,
): { trades: Trade[]; detectedNotTaken: number } {
  const trades: Trade[] = [];
  const triggered = new Set<string>();
  let detectedNotTaken = 0;
  if (candles.length < WARMUP + 10) return { trades, detectedNotTaken };

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const window = candles.slice(0, i + 1);
    const cutoffMs = new Date(window[window.length - 1].date).getTime();
    // Only daily bars that have already closed by this point — no lookahead.
    const dailyWindow = dailyCandles.filter((c) => new Date(c.date).getTime() <= cutoffMs);

    let result;
    try {
      result = computeLevels(
        window, window[window.length - 1].close, timeframe, symbol, meta,
        500, 0.01, 1, 100, 0.01, dailyWindow, undefined, undefined, undefined,
      );
    } catch {
      continue; // defensive — a malformed window shouldn't kill the whole run
    }

    if (result.signal === "WAIT") continue;
    if (!TARGET_TYPES.includes(result.signalType as TargetType)) continue;

    const signalType = result.signalType as TargetType;
    const direction = result.signal as "BUY" | "SELL";
    const entry = result.entryPrice;
    const sl = result.stopLoss;
    const tp1 = result.takeProfit1;
    const tp2 = result.takeProfit2;
    if (!isFinite(entry) || !isFinite(sl) || Math.abs(entry - sl) <= 0) continue;

    const dedupeKey = `${signalType}:${direction}:${entry.toFixed(6)}:${sl.toFixed(6)}`;
    if (triggered.has(dedupeKey)) continue;
    triggered.add(dedupeKey);
    detectedNotTaken++; // counted as "detected"; decremented below if actually taken

    const riskDist = Math.abs(entry - sl);

    // Simulate the limit order: scan forward for fill vs. invalidation.
    let entryIdx = -1;
    let invalidated = false;
    for (let j = i + 1; j < Math.min(i + 1 + ENTRY_TIMEOUT_BARS, candles.length); j++) {
      const c = candles[j];
      if (direction === "BUY") {
        if (c.low <= sl) { invalidated = true; break; } // stopped out before ever filling
        if (c.low <= entry) { entryIdx = j; break; }
      } else {
        if (c.high >= sl) { invalidated = true; break; }
        if (c.high >= entry) { entryIdx = j; break; }
      }
    }

    if (invalidated || entryIdx === -1) {
      trades.push({ symbol, timeframe, signalType, direction, entry, sl, tp1, tp2, outcome: "MISSED", r: 0, barsHeld: 0 });
      continue;
    }
    detectedNotTaken--; // this one was actually taken

    let outcome: Trade["outcome"] = "EXPIRED";
    let r = 0;
    let barsHeld = 0;
    for (let j = entryIdx + 1; j < candles.length; j++) {
      const c = candles[j];
      barsHeld = j - entryIdx;
      if (direction === "BUY") {
        if (c.low <= sl) { outcome = "SL"; r = -1; break; }
        if (c.high >= tp2) { outcome = "TP2"; r = (tp2 - entry) / riskDist; break; }
        if (c.high >= tp1) { outcome = "TP1"; r = (tp1 - entry) / riskDist; break; }
      } else {
        if (c.high >= sl) { outcome = "SL"; r = -1; break; }
        if (c.low <= tp2) { outcome = "TP2"; r = (entry - tp2) / riskDist; break; }
        if (c.low <= tp1) { outcome = "TP1"; r = (entry - tp1) / riskDist; break; }
      }
    }
    if (outcome === "EXPIRED") {
      const lastClose = candles[candles.length - 1].close;
      r = direction === "BUY" ? (lastClose - entry) / riskDist : (entry - lastClose) / riskDist;
    }

    trades.push({ symbol, timeframe, signalType, direction, entry, sl, tp1, tp2, outcome, r, barsHeld });
  }

  return { trades, detectedNotTaken };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

interface Stats {
  trades: number; wins: number; winRate: number;
  totalR: number; avgR: number; profitFactor: number;
}

function computeStats(trades: Trade[]): Stats {
  const real = trades.filter((t) => t.outcome !== "MISSED");
  if (!real.length) return { trades: 0, wins: 0, winRate: 0, totalR: 0, avgR: 0, profitFactor: 0 };
  let wins = 0, grossWin = 0, grossLoss = 0, totalR = 0;
  for (const t of real) {
    const r = t.outcome === "EXPIRED" ? Math.max(-1, t.r) : t.r;
    totalR += r;
    if (r > 0) { wins++; grossWin += r; } else { grossLoss += Math.abs(r); }
  }
  return {
    trades: real.length, wins, winRate: wins / real.length * 100,
    totalR, avgR: totalR / real.length,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss,
  };
}

function pct(n: number) { return isFinite(n) ? n.toFixed(1) + "%" : "—"; }
function fmt(n: number, d = 1) { return isFinite(n) ? n.toFixed(d) : "—"; }

function printSummary(label: string, trades: Trade[], missedCount: number) {
  const s = computeStats(trades);
  console.log(`\n${"═".repeat(90)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(90)}`);
  console.log(`  Detected (signal fired) : ${trades.filter((t) => t.outcome !== "MISSED").length + missedCount}`);
  console.log(`  Never filled (MISSED)   : ${missedCount}`);
  if (s.trades === 0) { console.log("  (no filled trades)"); return; }
  console.log(`  Filled trades : ${s.trades}`);
  console.log(`  Win rate      : ${pct(s.winRate)}`);
  console.log(`  Avg R/trade   : ${fmt(s.avgR, 3)}`);
  console.log(`  Total R       : ${fmt(s.totalR, 1)}`);
  console.log(`  Profit factor : ${fmt(s.profitFactor, 2)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  Remaining Real-Allowlist Signals Backtest (BB_REJECTION / DOUBLE_BOTTOM / DOUBLE_TOP)\n");
  console.log("  Importing computeLevels directly from artifacts/api-server/src/lib/signals.ts");
  console.log(`  Scope: static TradingView watchlist (${TRADINGVIEW_WATCHLIST.length} perps), 1h and 4h timeframes.\n`);

  const allTrades: Trade[] = [];
  let allMissed = 0;
  const perTypeMissed: Record<TargetType, number> = { BB_REJECTION: 0, DOUBLE_BOTTOM: 0, DOUBLE_TOP: 0 };

  for (const ticker of TRADINGVIEW_WATCHLIST) {
    const instId = toOkxInstId(ticker);
    const meta = buildMeta(ticker, instId);

    let candles1h: CandleRaw[] = [];
    let candles4h: CandleRaw[] = [];
    let candlesDaily: CandleRaw[] = [];
    try {
      process.stdout.write(`  ${ticker.padEnd(14)} — fetching 1h/4h/1d ... `);
      candles1h = await fetchOkxCandles(instId, "1h", 3000);
      candles4h = await fetchOkxCandles(instId, "4h", 1500);
      candlesDaily = await fetchOkxCandles(instId, "1d", 400);
      console.log(`1h=${candles1h.length} 4h=${candles4h.length} 1d=${candlesDaily.length}`);
    } catch (err) {
      console.log(`SKIP (${(err as Error).message.slice(0, 50)})`);
      continue;
    }

    if (candles1h.length >= WARMUP + 10 && candlesDaily.length >= 35) {
      const { trades, detectedNotTaken } = backtestSymbolTf(ticker, "1h", candles1h, candlesDaily, meta);
      allTrades.push(...trades);
      for (const t of trades) if (t.outcome === "MISSED") { allMissed++; perTypeMissed[t.signalType]++; }
    }
    if (candles4h.length >= WARMUP + 10 && candlesDaily.length >= 35) {
      const { trades, detectedNotTaken } = backtestSymbolTf(ticker, "4h", candles4h, candlesDaily, meta);
      allTrades.push(...trades);
      for (const t of trades) if (t.outcome === "MISSED") { allMissed++; perTypeMissed[t.signalType]++; }
    }
  }

  for (const type of TARGET_TYPES) {
    const typeTrades = allTrades.filter((t) => t.signalType === type);
    const missed = perTypeMissed[type];
    printSummary(type, typeTrades, missed);
  }

  console.log(`\n${"═".repeat(90)}`);
  console.log("  COMBINED");
  console.log(`${"═".repeat(90)}`);
  printSummary("ALL THREE TYPES", allTrades, allMissed);
}

main().catch((err) => { console.error(err); process.exit(1); });
