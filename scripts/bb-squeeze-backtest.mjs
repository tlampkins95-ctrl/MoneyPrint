/**
 * BB_SQUEEZE backtest validation script
 * Fetches 1h OKX perp candles (paginated to ~700 bars ≈ 4 weeks) and replays
 * the proposed signal detection logic to measure win rate and P&L.
 *
 * Run: node scripts/bb-squeeze-backtest.mjs
 */

const COINS = [
  "HYPE-USDT-SWAP",
  "NEAR-USDT-SWAP",
  "ADA-USDT-SWAP",
  "AERO-USDT-SWAP",
  "PENGU-USDT-SWAP",
  "DOGE-USDT-SWAP",
  "XRP-USDT-SWAP",
  "SOL-USDT-SWAP",
  "WLD-USDT-SWAP",
  "BNB-USDT-SWAP",
  "GRASS-USDT-SWAP",
  "BCH-USDT-SWAP",
  "BTC-USDT-SWAP",
  "ETH-USDT-SWAP",
  "LINK-USDT-SWAP",
  "AVAX-USDT-SWAP",
];

// ─── Signal config ─────────────────────────────────────────────────────────────
const BB_PERIOD        = 20;
const BB_MULT          = 2;
const BBW_HIST_BARS    = 100;
const BBW_PCT_GATE     = 0.35;   // bottom 35th percentile = squeeze
const MIN_SQUEEZE_BARS = 4;
const VOL_MULT         = 1.2;
const MIN_RR           = 1.5;
const ATR_PERIOD       = 14;
const SL_ATR_MULT      = 0.2;
const MAX_HOLD_BARS    = 72;
const TARGET_BARS      = 700;

// ─── OKX fetch (matches production pagination pattern) ────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function okxGet(path) {
  const url = `https://www.okx.com/api/v5${path}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (BacktestScript/1.0)" },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`OKX HTTP ${r.status} for ${path}`);
  const j = await r.json();
  if (j.code !== "0") throw new Error(`OKX API error ${j.code}: ${j.msg}`);
  return j.data ?? [];
}

async function fetchCandles(instId) {
  // Step 1: most recent 300 bars (newest-first from OKX)
  const latest = await okxGet(
    `/market/candles?instId=${encodeURIComponent(instId)}&bar=1H&limit=300`
  );

  const collected = [...latest];
  let oldestTs = collected.length > 0 ? Number(collected[collected.length - 1][0]) : Date.now();

  // Step 2: paginate backwards with history-candles
  let safety = 6;
  while (collected.length < TARGET_BARS && safety-- > 0) {
    await sleep(150);
    const remaining = TARGET_BARS - collected.length;
    const limit = Math.min(100, remaining); // history-candles max=100
    const page = await okxGet(
      `/market/history-candles?instId=${encodeURIComponent(instId)}&bar=1H&limit=${limit}&after=${oldestTs}`
    );
    if (page.length === 0) break;
    collected.push(...page);
    oldestTs = Number(page[page.length - 1][0]);
    if (page.length < limit) break;
  }

  // Parse + dedup + sort ascending
  const byTime = new Map();
  for (const row of collected) {
    const ts = Number(row[0]);
    const o = parseFloat(row[1]), h = parseFloat(row[2]);
    const l = parseFloat(row[3]), c = parseFloat(row[4]);
    const v = parseFloat(row[5]);
    if (!isFinite(ts) || ![o, h, l, c].every(n => isFinite(n))) continue;
    byTime.set(ts, { ts, open: o, high: h, low: l, close: c, volume: isFinite(v) ? v : 0 });
  }

  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  out[period - 1] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcMACDHist(closes, fast = 12, slow = 26, sig = 9) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < slow + sig) return out;
  const fe = calcEMA(closes, fast), se = calcEMA(closes, slow);
  const ml = closes.map((_, i) => isNaN(fe[i]) || isNaN(se[i]) ? NaN : fe[i] - se[i]);
  const sl = calcEMA(ml.slice(slow - 1), sig);
  for (let i = 0; i < sl.length; i++) {
    const g = (slow - 1) + i;
    if (!isNaN(ml[g]) && !isNaN(sl[i])) out[g] = ml[g] - sl[i];
  }
  return out;
}

function calcBBAt(closes, i, period = BB_PERIOD, mult = BB_MULT) {
  if (i < period - 1) return null;
  const slice = closes.slice(i - period + 1, i + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  if (sd === 0) return null;
  return { upper: mean + mult * sd, middle: mean, lower: mean - mult * sd };
}

function calcATR(candles, i, period = ATR_PERIOD) {
  if (i < period) return NaN;
  let sum = 0, count = 0;
  for (let j = Math.max(1, i - period + 1); j <= i; j++) {
    sum += Math.max(
      candles[j].high - candles[j].low,
      Math.abs(candles[j].high - candles[j - 1].close),
      Math.abs(candles[j].low  - candles[j - 1].close),
    );
    count++;
  }
  return count > 0 ? sum / count : NaN;
}

function percentile(arr, pct) {
  const sorted = [...arr].filter(v => isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.floor(pct * sorted.length)];
}

// ─── Signal detection ─────────────────────────────────────────────────────────
function detectSignals(candles) {
  const closes   = candles.map(c => c.close);
  const macdHist = calcMACDHist(closes);
  const bbwArr   = candles.map((_, i) => {
    const bb = calcBBAt(closes, i);
    return bb ? (bb.upper - bb.lower) / bb.middle : NaN;
  });

  const signals = [];
  const startBar = BBW_HIST_BARS + BB_PERIOD + 2;

  for (let i = startBar; i < candles.length - 1; i++) {
    const bb = calcBBAt(closes, i);
    if (!bb) continue;
    const bbw = bbwArr[i];
    if (!isFinite(bbw)) continue;

    // 1. Compute squeeze threshold from history before this bar
    const hist = bbwArr.slice(i - BBW_HIST_BARS, i).filter(v => isFinite(v));
    if (hist.length < 40) continue;
    const thresh = percentile(hist, BBW_PCT_GATE);

    // 2. Count consecutive squeeze bars ending at i-1
    let squeezeBars = 0;
    for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
      if (isFinite(bbwArr[j]) && bbwArr[j] <= thresh) squeezeBars++;
      else break;
    }
    if (squeezeBars < MIN_SQUEEZE_BARS) continue;

    // 3. Breakout: bar i closed beyond a band
    const closedAbove = candles[i].close > bb.upper;
    const closedBelow = candles[i].close < bb.lower;
    if (!closedAbove && !closedBelow) continue;
    const dir = closedAbove ? "BUY" : "SELL";

    // 4. BBW expanding vs prior bar (bands just starting to open)
    const bbwPrev = bbwArr[i - 1];
    if (!isFinite(bbwPrev) || bbw <= bbwPrev) continue;

    // 5. MACD confirms direction
    const hist_m = macdHist[i];
    if (!isFinite(hist_m)) continue;
    if (dir === "BUY"  && hist_m <= 0) continue;
    if (dir === "SELL" && hist_m >= 0) continue;

    // 6. Volume surge
    const prior5 = candles.slice(Math.max(0, i - 5), i).map(c => c.volume);
    const avgVol = prior5.reduce((a, b) => a + b, 0) / (prior5.length || 1);
    if (avgVol <= 0 || candles[i].volume < avgVol * VOL_MULT) continue;

    // 7. Levels
    let tightestBBW = Infinity, squeezeRange = bb.upper - bb.lower;
    for (let j = i - squeezeBars; j < i; j++) {
      if (isFinite(bbwArr[j]) && bbwArr[j] < tightestBBW) {
        tightestBBW = bbwArr[j];
        const bbJ = calcBBAt(closes, j);
        if (bbJ) squeezeRange = bbJ.upper - bbJ.lower;
      }
    }

    const entryBar = i + 1;
    if (entryBar >= candles.length) continue;
    const entry = candles[entryBar].open;
    const atr = calcATR(candles, i);
    const sl  = dir === "BUY" ? bb.middle - SL_ATR_MULT * atr : bb.middle + SL_ATR_MULT * atr;
    const tp1 = dir === "BUY" ? entry + squeezeRange : entry - squeezeRange;
    const reward = Math.abs(tp1 - entry), risk = Math.abs(entry - sl);
    if (risk <= 0 || reward / risk < MIN_RR) continue;

    signals.push({ bar: i, ts: candles[i].ts, dir, entry, tp1, sl, rr: reward / risk, squeezeRange, squeezeBars, entryBar });
  }
  return signals;
}

// ─── Simulate outcomes ────────────────────────────────────────────────────────
function simulate(candles, signals) {
  return signals.map(sig => {
    let outcome = "OPEN", exitPx = null;
    for (let j = sig.entryBar + 1; j < Math.min(candles.length, sig.entryBar + MAX_HOLD_BARS + 1); j++) {
      const bar = candles[j];
      if (sig.dir === "BUY") {
        if (bar.low  <= sig.sl)  { outcome = "SL"; exitPx = sig.sl;  break; }
        if (bar.high >= sig.tp1) { outcome = "TP"; exitPx = sig.tp1; break; }
      } else {
        if (bar.high >= sig.sl)  { outcome = "SL"; exitPx = sig.sl;  break; }
        if (bar.low  <= sig.tp1) { outcome = "TP"; exitPx = sig.tp1; break; }
      }
    }
    const pnlPct = exitPx != null && sig.entry > 0
      ? (sig.dir === "BUY" ? exitPx - sig.entry : sig.entry - exitPx) / sig.entry * 100
      : null;
    return { ...sig, outcome, exitPx, pnlPct, date: new Date(sig.ts).toISOString().slice(0, 16) };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`BB_SQUEEZE Backtest — 1h OKX perp, target ${TARGET_BARS} bars (~${Math.round(TARGET_BARS/24)}d)`);
  console.log("=".repeat(72));
  console.log(`BB(${BB_PERIOD},${BB_MULT})  squeeze ≥${MIN_SQUEEZE_BARS} bars ≤p${(BBW_PCT_GATE*100)|0}  BBW↑ at breakout  MACD confirms`);
  console.log(`vol ≥${VOL_MULT}×avg5  minRR=${MIN_RR}  SL=midline±${SL_ATR_MULT}ATR  maxHold=${MAX_HOLD_BARS}h`);
  console.log("=".repeat(72));

  const allResults = [];

  for (const coin of COINS) {
    process.stdout.write(`${coin.padEnd(22)} `);
    let candles;
    try {
      candles = await fetchCandles(coin);
      await sleep(300);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      continue;
    }

    if (candles.length < BBW_HIST_BARS + BB_PERIOD + 20) {
      console.log(`SKIP (${candles.length} bars)`);
      continue;
    }

    const signals = detectSignals(candles);
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
      const pStr = `P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
      console.log(`${candles.length} bars  ${results.length} sigs  TP=${tp} SL=${sl} OPEN=${open}  ${wr}  ${pStr}`);
      for (const r of results) {
        const p = r.pnlPct != null ? ` (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%)` : "";
        console.log(`  ${r.date} ${r.dir} entry=${r.entry.toPrecision(5)} tp=${r.tp1.toPrecision(5)} sl=${r.sl.toPrecision(5)} rr=${r.rr.toFixed(1)} sq=${r.squeezeBars}→ ${r.outcome}${p}`);
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
  const bWR = buys.filter(r => r.outcome==="TP").length / Math.max(1, buys.filter(r=>r.outcome!=="OPEN").length) * 100;
  const sWR = sells.filter(r => r.outcome==="TP").length / Math.max(1, sells.filter(r=>r.outcome!=="OPEN").length) * 100;

  console.log("\n" + "=".repeat(72));
  console.log("OVERALL SUMMARY");
  console.log("=".repeat(72));
  console.log(`Total signals : ${allResults.length}  (BUY=${buys.length}  SELL=${sells.length})`);
  console.log(`TP / SL / OPEN: ${tp} / ${sl} / ${open}`);
  console.log(`Win rate      : ${settled > 0 ? (tp/settled*100).toFixed(1) : "—"}%   BUY ${bWR.toFixed(0)}%  SELL ${sWR.toFixed(0)}%`);
  console.log(`Total P&L     : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`);
  console.log(`Avg P&L/trade : ${allResults.length ? (pnl >= 0 ? "+" : "") + (pnl/allResults.length).toFixed(2) : "—"}%`);
  if (allResults.length) {
    console.log(`Avg R:R       : ${(allResults.reduce((s,r) => s+r.rr, 0)/allResults.length).toFixed(2)}:1`);
    console.log(`Avg sq bars   : ${(allResults.reduce((s,r) => s+r.squeezeBars, 0)/allResults.length).toFixed(1)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
