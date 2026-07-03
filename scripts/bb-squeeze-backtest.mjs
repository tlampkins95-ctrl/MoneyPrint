/**
 * BB_SQUEEZE 1D backtest — setup on daily, entry at next-day open
 * Run: node scripts/bb-squeeze-backtest.mjs
 */

const COINS = [
  "BTC-USDT-SWAP",
  "ETH-USDT-SWAP",
  "SOL-USDT-SWAP",
  "DOGE-USDT-SWAP",
  "BNB-USDT-SWAP",
  "HYPE-USDT-SWAP",
  "XRP-USDT-SWAP",
  "LINK-USDT-SWAP",
  "AVAX-USDT-SWAP",
  "ADA-USDT-SWAP",
  "DOT-USDT-SWAP",
  "NEAR-USDT-SWAP",
  "BCH-USDT-SWAP",
  "LTC-USDT-SWAP",
];

const BB_PERIOD        = 30;
const BB_MULT          = 2;
const BBW_HIST_BARS    = 200;
const BBW_PCT_GATE     = 0.25;
const MIN_SQUEEZE_DAYS = 10;
const MAX_SQUEEZE_DAYS = 120;
const VOL_MULT         = 1.3;
const VOL_AVG_BARS     = 10;
const MIN_RR           = 1.5;
// SL = entry ± SL_SQUEEZE_MULT × squeezeRange
// If price retraces >50% back into the squeeze body the breakout was a head-fake.
const SL_SQUEEZE_MULT  = 0.5;
const MAX_HOLD_DAYS    = 60;
const TARGET_BARS      = 900;
const DEBUG            = true; // print gate-by-gate kill counts

// ─── OKX fetch ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function okxGet(path, retries = 3) {
  const url = `https://www.okx.com/api/v5${path}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (BacktestScript/1.0)" },
        signal: AbortSignal.timeout(12000),
      });
      if (r.status === 429) { await sleep(3000); continue; }
      if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
      const j = await r.json();
      if (j.code !== "0") throw new Error(`OKX API ${j.code}: ${j.msg}`);
      return j.data ?? [];
    } catch(e) {
      if (attempt === retries - 1) throw e;
    }
  }
}

async function fetchDailyCandles(instId) {
  const latest = await okxGet(
    `/market/candles?instId=${encodeURIComponent(instId)}&bar=1D&limit=300`
  );
  const collected = [...latest];
  let oldestTs = collected.length > 0 ? Number(collected[collected.length - 1][0]) : Date.now();

  let safety = 8;
  while (collected.length < TARGET_BARS && safety-- > 0) {
    await sleep(600); // generous delay to avoid 429
    const remaining = TARGET_BARS - collected.length;
    const limit = Math.min(100, remaining);
    const page = await okxGet(
      `/market/history-candles?instId=${encodeURIComponent(instId)}&bar=1D&limit=${limit}&after=${oldestTs}`
    );
    if (!page || page.length === 0) break;
    collected.push(...page);
    oldestTs = Number(page[page.length - 1][0]);
    if (page.length < limit) break;
  }

  const byTime = new Map();
  for (const row of collected) {
    const ts = Number(row[0]);
    const [o,h,l,c,v] = [1,2,3,4,5].map(n => parseFloat(row[n]));
    if (!isFinite(ts) || ![o,h,l,c].every(n => isFinite(n))) continue;
    byTime.set(ts, { ts, open: o, high: h, low: l, close: c, volume: isFinite(v) ? v : 0 });
  }
  return [...byTime.entries()].sort((a,b) => a[0]-b[0]).map(([,c]) => c);
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  out[period - 1] = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i-1] * (1-k);
  return out;
}

function calcMACDHist(closes, fast=12, slow=26, sig=9) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < slow + sig) return out;
  const fe = calcEMA(closes, fast), se = calcEMA(closes, slow);
  const ml = closes.map((_,i) => isNaN(fe[i])||isNaN(se[i]) ? NaN : fe[i]-se[i]);
  const sl = calcEMA(ml.slice(slow-1), sig);
  for (let i = 0; i < sl.length; i++) {
    const g = (slow-1)+i;
    if (!isNaN(ml[g]) && !isNaN(sl[i])) out[g] = ml[g]-sl[i];
  }
  return out;
}

function calcBBAt(closes, i, period=BB_PERIOD, mult=BB_MULT) {
  if (i < period - 1) return null;
  const slice = closes.slice(i - period + 1, i + 1);
  const mean = slice.reduce((a,b) => a+b, 0) / period;
  const sd = Math.sqrt(slice.reduce((s,v) => s+(v-mean)**2, 0) / period);
  if (sd === 0) return null;
  return { upper: mean + mult*sd, middle: mean, lower: mean - mult*sd };
}

function calcATR(candles, i, period=ATR_PERIOD) {
  if (i < 1) return NaN;
  let sum = 0, count = 0;
  for (let j = Math.max(1, i - period + 1); j <= i; j++) {
    sum += Math.max(
      candles[j].high - candles[j].low,
      Math.abs(candles[j].high - candles[j-1].close),
      Math.abs(candles[j].low  - candles[j-1].close),
    );
    count++;
  }
  return count > 0 ? sum / count : NaN;
}

function percentile(arr, pct) {
  const sorted = [...arr].filter(v => isFinite(v)).sort((a,b) => a-b);
  if (!sorted.length) return NaN;
  return sorted[Math.floor(pct * sorted.length)];
}

// ─── Signal detection (with debug counters) ───────────────────────────────────
function detectSignals(candles, label) {
  const closes   = candles.map(c => c.close);
  const macdHist = calcMACDHist(closes);
  const bbwArr   = candles.map((_, i) => {
    const bb = calcBBAt(closes, i);
    return bb ? (bb.upper - bb.lower) / bb.middle : NaN;
  });

  const kills = { squeeze: 0, breakout: 0, bbwExpand: 0, macd: 0, vol: 0, rr: 0 };
  let maxSqueeze = 0;
  const signals = [];
  const startBar = BBW_HIST_BARS + BB_PERIOD + 2;

  for (let i = startBar; i < candles.length - 1; i++) {
    const bb = calcBBAt(closes, i);
    if (!bb) continue;
    const bbw = bbwArr[i];
    if (!isFinite(bbw)) continue;

    const hist = bbwArr.slice(i - BBW_HIST_BARS, i).filter(v => isFinite(v));
    if (hist.length < 80) continue;
    const thresh = percentile(hist, BBW_PCT_GATE);

    let squeezeDays = 0;
    for (let j = i - 1; j >= Math.max(0, i - MAX_SQUEEZE_DAYS); j--) {
      if (isFinite(bbwArr[j]) && bbwArr[j] <= thresh) squeezeDays++;
      else break;
    }
    if (squeezeDays > maxSqueeze) maxSqueeze = squeezeDays;
    if (squeezeDays < MIN_SQUEEZE_DAYS) { kills.squeeze++; continue; }

    const closedAbove = candles[i].close > bb.upper;
    const closedBelow = candles[i].close < bb.lower;
    if (!closedAbove && !closedBelow) { kills.breakout++; continue; }
    const dir = closedAbove ? "BUY" : "SELL";

    const bbwPrev = bbwArr[i - 1];
    if (!isFinite(bbwPrev) || bbw <= bbwPrev) { kills.bbwExpand++; continue; }

    const mh = macdHist[i];
    if (!isFinite(mh)) { kills.macd++; continue; }
    if (dir === "BUY" && mh <= 0)  { kills.macd++; continue; }
    if (dir === "SELL" && mh >= 0) { kills.macd++; continue; }

    const prior = candles.slice(Math.max(0, i - VOL_AVG_BARS), i).map(c => c.volume);
    const avgVol = prior.reduce((a,b) => a+b, 0) / (prior.length || 1);
    if (avgVol <= 0 || candles[i].volume < avgVol * VOL_MULT) { kills.vol++; continue; }

    let tightestBBW = Infinity, squeezeRange = bb.upper - bb.lower;
    for (let j = i - squeezeDays; j < i; j++) {
      if (isFinite(bbwArr[j]) && bbwArr[j] < tightestBBW) {
        tightestBBW = bbwArr[j];
        const bbJ = calcBBAt(closes, j);
        if (bbJ) squeezeRange = bbJ.upper - bbJ.lower;
      }
    }

    const entryBar = i + 1;
    if (entryBar >= candles.length) continue;
    const entry = candles[entryBar].open;
    const sl  = dir === "BUY"  ? entry - SL_SQUEEZE_MULT * squeezeRange
                              : entry + SL_SQUEEZE_MULT * squeezeRange;
    const tp1 = dir === "BUY"  ? entry + squeezeRange           : entry - squeezeRange;
    const reward = Math.abs(tp1 - entry), risk = Math.abs(entry - sl);
    if (risk <= 0 || reward / risk < MIN_RR) { kills.rr++; continue; }

    signals.push({
      bar: i, ts: candles[i].ts, dir, entry, tp1, sl,
      rr: reward / risk, squeezeRange, squeezeDays, entryBar,
      pctMoveTP: Math.abs(tp1 - entry) / entry * 100,
    });
  }

  if (DEBUG && signals.length === 0) {
    console.log(`  [debug] maxSqueeze=${maxSqueeze}d  kills: squeeze=${kills.squeeze} breakout=${kills.breakout} bbwExpand=${kills.bbwExpand} macd=${kills.macd} vol=${kills.vol} rr=${kills.rr}`);
  }

  return signals;
}

// ─── Simulate outcomes ────────────────────────────────────────────────────────
function simulate(candles, signals) {
  return signals.map(sig => {
    let outcome = "OPEN", exitPx = null, exitDays = null;
    for (let j = sig.entryBar + 1; j < Math.min(candles.length, sig.entryBar + MAX_HOLD_DAYS + 1); j++) {
      const bar = candles[j];
      if (sig.dir === "BUY") {
        if (bar.low  <= sig.sl)  { outcome = "SL"; exitPx = sig.sl;  exitDays = j - sig.entryBar; break; }
        if (bar.high >= sig.tp1) { outcome = "TP"; exitPx = sig.tp1; exitDays = j - sig.entryBar; break; }
      } else {
        if (bar.high >= sig.sl)  { outcome = "SL"; exitPx = sig.sl;  exitDays = j - sig.entryBar; break; }
        if (bar.low  <= sig.tp1) { outcome = "TP"; exitPx = sig.tp1; exitDays = j - sig.entryBar; break; }
      }
    }
    const pnlPct = exitPx != null && sig.entry > 0
      ? (sig.dir === "BUY" ? exitPx - sig.entry : sig.entry - exitPx) / sig.entry * 100
      : null;
    return { ...sig, outcome, exitPx, pnlPct, exitDays, date: new Date(sig.ts).toISOString().slice(0, 10) };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`BB_SQUEEZE 1D Backtest  —  BB(${BB_PERIOD},${BB_MULT})  ~${TARGET_BARS/365|0}yr history`);
  console.log("=".repeat(72));
  console.log(`Squeeze: ≥${MIN_SQUEEZE_DAYS}d ≤p${(BBW_PCT_GATE*100)|0} of prior ${BBW_HIST_BARS}-day BBW`);
  console.log(`Breakout + BBW↑ + MACD confirms + vol≥${VOL_MULT}×${VOL_AVG_BARS}d  SL=entry±${SL_SQUEEZE_MULT}×sqRange  maxHold=${MAX_HOLD_DAYS}d`);
  console.log("=".repeat(72));

  const allResults = [];

  for (const coin of COINS) {
    process.stdout.write(`${coin.padEnd(22)} `);
    let candles;
    try {
      candles = await fetchDailyCandles(coin);
      await sleep(1000); // 1s between coins
    } catch(e) {
      console.log(`FAILED: ${e.message}`);
      continue;
    }

    if (candles.length < BBW_HIST_BARS + BB_PERIOD + 20) {
      console.log(`SKIP (${candles.length} bars)`);
      continue;
    }

    const signals = detectSignals(candles, coin);
    const results = simulate(candles, signals);
    const tp = results.filter(r => r.outcome === "TP").length;
    const sl = results.filter(r => r.outcome === "SL").length;
    const open = results.filter(r => r.outcome === "OPEN").length;
    const settled = tp + sl;
    const pnl = results.reduce((s, r) => s + (r.pnlPct ?? 0), 0);

    if (!results.length) {
      console.log(`${candles.length} bars  (no signals)`);
    } else {
      const wr = settled > 0 ? `WR ${(tp/settled*100)|0}%` : "WR —";
      console.log(`${candles.length} bars  ${results.length} sigs  TP=${tp} SL=${sl} OPEN=${open}  ${wr}  P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`);
      for (const r of results) {
        const p = r.pnlPct != null ? ` (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%)` : "";
        const days = r.exitDays != null ? ` ${r.exitDays}d` : "";
        console.log(`  ${r.date} ${r.dir} rr=${r.rr.toFixed(1)} sq=${r.squeezeDays}d tp%=${r.pctMoveTP.toFixed(1)} → ${r.outcome}${p}${days}`);
      }
    }
    allResults.push(...results);
  }

  const tp  = allResults.filter(r => r.outcome === "TP").length;
  const sl  = allResults.filter(r => r.outcome === "SL").length;
  const open = allResults.filter(r => r.outcome === "OPEN").length;
  const settled = tp + sl;
  const pnl = allResults.reduce((s, r) => s + (r.pnlPct ?? 0), 0);
  const buys  = allResults.filter(r => r.dir === "BUY");
  const sells = allResults.filter(r => r.dir === "SELL");
  const bWR = buys.filter(r=>r.outcome==="TP").length / Math.max(1, buys.filter(r=>r.outcome!=="OPEN").length) * 100;
  const sWR = sells.filter(r=>r.outcome==="TP").length / Math.max(1, sells.filter(r=>r.outcome!=="OPEN").length) * 100;

  console.log("\n" + "=".repeat(72));
  console.log("OVERALL SUMMARY");
  console.log("=".repeat(72));
  console.log(`Total signals : ${allResults.length}  (BUY=${buys.length}  SELL=${sells.length})`);
  console.log(`TP / SL / OPEN: ${tp} / ${sl} / ${open}`);
  console.log(`Win rate      : ${settled > 0 ? (tp/settled*100).toFixed(1) : "—"}%   BUY ${bWR.toFixed(0)}%  SELL ${sWR.toFixed(0)}%`);
  console.log(`Total P&L     : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`);
  console.log(`Avg P&L/trade : ${allResults.length ? (pnl/allResults.length >= 0 ? "+" : "") + (pnl/allResults.length).toFixed(1) : "—"}%`);
  if (allResults.length) {
    const settled2 = allResults.filter(r => r.outcome !== "OPEN");
    const avgDays = settled2.length ? (settled2.reduce((s,r) => s+(r.exitDays??0),0)/settled2.length).toFixed(1) : "—";
    console.log(`Avg R:R       : ${(allResults.reduce((s,r) => s+r.rr,0)/allResults.length).toFixed(2)}:1`);
    console.log(`Avg hold time : ${avgDays} days`);
    console.log(`Avg TP target : ${(allResults.reduce((s,r) => s+r.pctMoveTP,0)/allResults.length).toFixed(1)}% move`);
    console.log(`Avg sq days   : ${(allResults.reduce((s,r) => s+r.squeezeDays,0)/allResults.length).toFixed(1)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
