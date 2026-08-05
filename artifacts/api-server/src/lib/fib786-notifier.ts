// Orchestration for the FIB786 alert-only engine (Variant B: 4h detection,
// 1h entry trigger, daily trailing stop — the configuration validated by
// backtest: 190 trades, 69.5% win rate, avg R +0.127, PF 1.42, max
// drawdown 6.9R over ~4 months of real OKX history).
//
// Alert-only per the user's decision: no Phemex order calls anywhere in this
// file. Alerts carry entry/SL/TP1/TP2 and position-sizing so the user can
// execute manually; TP1/TP2/stop/trailing events are tracked here purely to
// notify the user of position-management milestones, not to act on them.
//
// A symbol can only have one active alert at a time (enforced by
// getActiveAlert/setActiveAlert being keyed on symbolKey) — this is also how
// "first trigger wins" dedup works if this engine is ever run alongside
// another variant/strategy on the same symbol universe.

import { computePositionSizing, DEFAULT_ACCOUNT_SIZE } from "./signals";
import { fetchCandlesForDynamic, fetchSpotForDynamic } from "./trending-discovery";
import { getCmcUniverse } from "./cmc-discovery";
import { TRADINGVIEW_WATCHLIST, watchlistToOkxInstId } from "./tradingViewWatchlist";
import { hasPhemexPerp } from "./phemex-trader";
import { findXAD, calcATR, computeFib786StopLoss, computeInsideBarFlags, trailingStopAt } from "./fib786-detector";
import {
  getActiveAlert, setActiveAlert, clearActiveAlert, getAllActiveAlerts,
  logFib786Outcome, type Fib786AlertState, type Fib786Outcome,
} from "./fib786-alerts";
import { sendTelegramMessage, isTelegramEnabled } from "./telegram-notifier";
import { broadcastWebPush, isWebPushEnabled, type PushPayload } from "./web-push-notifier";
import type { SymbolMeta } from "./symbols";
import { logger } from "./logger";

interface TrackedSymbol {
  symbolKey: string;
  label: string;
  okxPerp: string;
  decimals: number;
  prefix: string;
}

function buildTrackedSymbols(): TrackedSymbol[] {
  const fromWatchlist: TrackedSymbol[] = TRADINGVIEW_WATCHLIST
    .filter((ticker) => hasPhemexPerp(ticker))
    .map((ticker) => ({
      symbolKey: ticker,
      label: `${ticker.replace(/USDT$/, "")} / USDT`,
      okxPerp: watchlistToOkxInstId(ticker),
      decimals: 4,
      prefix: "$",
    }));
  const seen = new Set(fromWatchlist.map((s) => s.symbolKey));
  const fromCmc: TrackedSymbol[] = getCmcUniverse()
    .filter((m) => !seen.has(m.symbolKey) && m.okxPerp && hasPhemexPerp(m.symbolKey))
    .map((m) => ({
      symbolKey: m.symbolKey,
      label: m.label,
      okxPerp: m.okxPerp!,
      decimals: m.decimals,
      prefix: m.prefix,
    }));
  return [...fromWatchlist, ...fromCmc];
}

function buildMeta(tracked: TrackedSymbol): SymbolMeta {
  return {
    yahoo: "", tvSymbol: `OKX:${tracked.okxPerp}`, tvScrapePath: "",
    label: tracked.label, decimals: tracked.decimals, prefix: tracked.prefix,
    category: "crypto", okxPerp: tracked.okxPerp,
  };
}

const RISK_PCT = 0.03;
const TP1_R = 0.5;
const TP2_R = 1.0;
const TRANCHE_WEIGHTS = { t1: 0.33, t2: 0.33, t3: 0.34 };
const DETECT_LOOKBACK = 150;
const DETECT_STRENGTH = 3;
const TRAIL_BAR_MS = 24 * 60 * 60 * 1000; // daily

async function dispatchFib786Alert(title: string, body: string): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (isTelegramEnabled()) tasks.push(sendTelegramMessage(`<b>${title}</b>\n${body}`));
  if (isWebPushEnabled()) {
    const payload: PushPayload = { title, body, tag: "fib786", requireInteraction: true };
    tasks.push(broadcastWebPush(payload));
  }
  if (tasks.length > 0) await Promise.allSettled(tasks);
}

function fmtPrice(n: number, decimals: number, prefix: string): string {
  return `${prefix}${n.toFixed(decimals)}`;
}

async function scanForNewSignal(tracked: TrackedSymbol): Promise<void> {
  if (getActiveAlert(tracked.symbolKey)) return; // one active alert per symbol at a time

  const candles4h = await fetchCandlesForDynamic(tracked.okxPerp, "4h");
  if (candles4h.length < 210) return;

  const pattern = findXAD(candles4h, DETECT_STRENGTH, DETECT_LOOKBACK);
  if (!pattern || pattern.status !== "AT_D_ZONE") return;

  const candles1h = await fetchCandlesForDynamic(tracked.okxPerp, "1h");
  if (candles1h.length < 2) return;

  // Entry trigger: the most recently CLOSED 1h candle tags the D zone and
  // confirms with a bullish body close — same body-direction check as the
  // existing closedBarBullish gate in signals.ts.
  const lastClosed = candles1h[candles1h.length - 2];
  if (!lastClosed) return;
  const confirmed = lastClosed.low <= pattern.dZoneHigh && lastClosed.close > lastClosed.open;
  if (!confirmed) return;

  const entry = lastClosed.close;
  const atr = calcATR(candles4h);
  if (atr <= 0) return;
  const initialSl = computeFib786StopLoss(pattern.X.price, atr);
  if (entry <= initialSl) return;
  const riskDist = entry - initialSl;
  if (riskDist <= 0) return;

  const tp1 = entry + TP1_R * riskDist;
  const tp2 = entry + TP2_R * riskDist;

  const state: Fib786AlertState = {
    symbolKey: tracked.symbolKey,
    entryPrice: entry,
    stopLoss: initialSl,
    initialSl,
    tp1, tp2,
    tp1Filled: false,
    tp2Filled: false,
    firedAt: Date.now(),
    lastUpdateAt: Date.now(),
  };
  setActiveAlert(state);

  const meta = buildMeta(tracked);
  const sizing = computePositionSizing(tracked.symbolKey, meta, entry, initialSl, tp1, tp2, DEFAULT_ACCOUNT_SIZE, RISK_PCT);
  const sizingLine = sizing
    ? `Size: ${sizing.positionSize} ${sizing.positionSizeUnit} (${sizing.leverage ?? "?"}x, risking $${sizing.riskAmount})`
    : "Size: (unable to compute — check account settings)";

  await dispatchFib786Alert(
    `FIB786 LONG — ${tracked.label}`,
    `Entry: ${fmtPrice(entry, tracked.decimals, tracked.prefix)}\n` +
    `Stop: ${fmtPrice(initialSl, tracked.decimals, tracked.prefix)}\n` +
    `TP1 (33% @ 0.5R): ${fmtPrice(tp1, tracked.decimals, tracked.prefix)}\n` +
    `TP2 (33% @ 1.0R): ${fmtPrice(tp2, tracked.decimals, tracked.prefix)}\n` +
    `Runner (34%): trails via 3-bar daily low once TP2 fills\n` +
    `${sizingLine}\n` +
    `Risk: ${(RISK_PCT * 100).toFixed(0)}% of account`,
  );
  logger.info({ symbol: tracked.symbolKey, entry, initialSl, tp1, tp2 }, "FIB786 alert fired");
}

function weightedR(state: Fib786AlertState, exitPrice: number): number {
  const riskDist = state.entryPrice - state.initialSl;
  const exitR = (exitPrice - state.entryPrice) / riskDist;
  const r1 = state.tp1Filled ? TP1_R : exitR;
  const r2 = !state.tp1Filled ? exitR : state.tp2Filled ? TP2_R : exitR;
  const r3 = !state.tp2Filled ? r2 : exitR;
  return TRANCHE_WEIGHTS.t1 * r1 + TRANCHE_WEIGHTS.t2 * r2 + TRANCHE_WEIGHTS.t3 * r3;
}

async function checkActiveAlert(tracked: TrackedSymbol, state: Fib786AlertState): Promise<void> {
  const price = await fetchSpotForDynamic(tracked.okxPerp);
  if (price === null) return;

  // Ratchet the runner's stop from the daily 3-bar (non-inside) trail once
  // TP2 has filled — only ever tightens, never loosens.
  if (state.tp2Filled) {
    const candlesDaily = await fetchCandlesForDynamic(tracked.okxPerp, "1d");
    if (candlesDaily.length >= 3) {
      const insideFlags = computeInsideBarFlags(candlesDaily);
      const candidate = trailingStopAt(candlesDaily, insideFlags, TRAIL_BAR_MS, Date.now());
      if (candidate !== null && candidate > state.stopLoss) {
        state.stopLoss = candidate;
        state.lastUpdateAt = Date.now();
        setActiveAlert(state);
      }
    }
  }

  if (price <= state.stopLoss) {
    const outcome: Fib786Outcome = !state.tp1Filled ? "FULL_SL" : !state.tp2Filled ? "BE_AFTER_TP1" : "TRAIL_STOP";
    const r = weightedR(state, state.stopLoss);
    clearActiveAlert(tracked.symbolKey);
    await logFib786Outcome(state, state.stopLoss, outcome, r);
    await dispatchFib786Alert(
      `FIB786 CLOSED — ${tracked.label}`,
      `Stopped out at ${fmtPrice(state.stopLoss, tracked.decimals, tracked.prefix)}\n` +
      `Outcome: ${outcome}\nRealized: ${r.toFixed(2)}R`,
    );
    return;
  }

  if (!state.tp1Filled && price >= state.tp1) {
    state.tp1Filled = true;
    state.stopLoss = state.entryPrice; // move to breakeven for the remaining tranches
    state.lastUpdateAt = Date.now();
    setActiveAlert(state);
    await dispatchFib786Alert(
      `FIB786 TP1 hit — ${tracked.label}`,
      `Close 33% here. Stop moved to breakeven (${fmtPrice(state.entryPrice, tracked.decimals, tracked.prefix)}) for the rest.`,
    );
    return;
  }

  if (state.tp1Filled && !state.tp2Filled && price >= state.tp2) {
    state.tp2Filled = true;
    state.lastUpdateAt = Date.now();
    setActiveAlert(state);
    await dispatchFib786Alert(
      `FIB786 TP2 hit — ${tracked.label}`,
      "Close another 33% here. Final 34% now trails via the 3-bar daily low.",
    );
  }
}

// Was 15 min — user reported an ALLO alert arriving ~1h after price tagged
// the .786 zone, well past a usable entry. Most of that lag was the 1h
// entry-confirmation candle needing to fully close (unchanged here), but the
// poll cadence added up to 15 more minutes on top of that. Dropped to 1 min
// — fetchCandlesForDynamic/fetchSpotForDynamic already cache internally (1h:
// 5min TTL, spot: 30s TTL), so this doesn't multiply OKX API load anywhere
// near 15x; most ticks just hit the cache.
const POLL_INTERVAL_MS = 60 * 1000;

async function pollCycle(): Promise<void> {
  const tracked = buildTrackedSymbols();
  for (const t of tracked) {
    try {
      const active = getActiveAlert(t.symbolKey);
      if (active) await checkActiveAlert(t, active);
      else await scanForNewSignal(t);
    } catch (err) {
      logger.warn({ err, symbol: t.symbolKey }, "FIB786 poll cycle error");
    }
  }
}

let started = false;
let cycleInFlight = false;

// Self-scheduling (setTimeout after completion) rather than setInterval —
// pollCycle loops sequentially over the full tracked-symbol universe with a
// network await per symbol, so a single cycle can take longer than
// POLL_INTERVAL_MS. setInterval doesn't wait for the previous callback to
// finish, so overlapping cycles could both see "no active alert yet" for the
// same symbol (the lock from setActiveAlert hadn't been written yet by the
// still-running cycle) and both fire — this is what produced 10 duplicate
// RENDERUSDT alerts sharing one firedAt in production. The cycleInFlight
// guard is a second line of defense in case anything ever calls pollCycle
// from elsewhere.
async function scheduleNextCycle(): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    await pollCycle();
  } catch (err) {
    logger.warn({ err }, "FIB786 pollCycle failed");
  } finally {
    cycleInFlight = false;
  }
  setTimeout(() => { void scheduleNextCycle(); }, POLL_INTERVAL_MS);
}

export function startFib786Notifier(): void {
  if (started) return;
  started = true;

  if (!process.env["DATABASE_URL"]) {
    logger.info("No DATABASE_URL — FIB786 notifier will run without outcome logging");
  }

  void scheduleNextCycle();
}

export function getFib786Status(): { activeAlerts: Fib786AlertState[] } {
  return { activeAlerts: getAllActiveAlerts() };
}
