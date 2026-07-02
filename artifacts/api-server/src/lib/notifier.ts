import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "./logger";
import { SYMBOLS, makeRounder, type Symbol, type SymbolMeta, ALL_SYMBOLS } from "./symbols";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
} from "./yahoo-fetch";
import { computeLevelsStable, fetchSpotPrice, getActiveTrade, applyFuturesBasis, registerOnTradeClosedCallback, calcMACDHist, computePositionSizing, DEFAULT_ACCOUNT_SIZE, DEFAULT_RISK_PCT, DEFAULT_MIN_COLLATERAL, DEFAULT_MAX_LEVERAGE, DEFAULT_MT5_LOTS, type ClosedOutcome } from "./signals";
import {
  buildAlertContext,
  sendTelegramAlert,
  sendTelegramMessage,
  isTelegramEnabled,
} from "./telegram-notifier";
import { broadcastWebPush } from "./web-push-notifier";
import {
  isPhemexTradingEnabled,
  getUSDTBalance,
  fetchContractSpecs,
  setSymbolLeverage,
  placeOrder,
  placeLimitClose,
  placeStopOrder,
  cancelExistingStopOrders,
  cancelExistingTpOrders,
  cancelOrder,
  cancelAllOrders,
  phemexRiskPct,
  phemexMaxLeverage,
  getMinPriceRp,
  checkExistingPosition,
  checkExistingOrder,
  getAllOpenPhemexPositions,
} from "./phemex-trader";

type SignalKind = "BUY" | "SELL" | "WAIT";

interface TrackedState {
  signal: SignalKind;
  lastAlertAt: number;

  // Direction of the last alert actually sent. Used to make the cooldown
  // direction-aware: a BUY→SELL flip bypasses the cooldown entirely because
  // it's a new setup in the opposite direction, not a repeat alert.
  lastAlertSignal?: SignalKind;
  // Gate tracking — set when a valid signal is present but 1h hasn't aligned yet
  gateBlockedSince?: number;
  gateBlockedSignal?: SignalKind;
  lastAlertChannels?: string[];
  // Consecutive-SL circuit breaker. Counts same-direction SLs in a row;
  // resets to 0 on TP2, BE_TRAIL, or a direction flip. Drives the cooldown
  // multiplier (1 SL → 1×, 2 SLs → 2×, 3+ SLs → 4×).
  consecutiveSls?: number;
  // Direction of the run of SLs being counted. If the next SL is in the
  // opposite direction, the streak resets to 1 rather than continuing.
  lastSlSignal?: SignalKind;
  // PATTERN_BREAKOUT dedup fingerprint: "<signal>|<entryPrice>" of the last
  // alerted pattern. Prevents the same confirmed pattern from re-firing every
  // poll cycle when a trade closes quickly (BE_TRAIL/TP) while the pattern
  // confirmation window (2 bars) is still active. Cleared when signal → WAIT.
  lastPatternKey?: string;
}

export interface NotifierSymbolStatus {
  symbol: Symbol;
  timeframe: Timeframe;
  trackedSignal: SignalKind;
  lastAlertAt: number | null;
  lastAlertAgo: string | null;
  lastAlertChannels: string[] | null;
  gateBlocked: boolean;
  gateBlockedSince: number | null;
  gateBlockedSignal: SignalKind | null;
  gateBlockedFor: string | null;
  consecutiveSls: number;
}

export interface NotifierStatus {
  enabled: boolean;
  telegramOn: boolean;
  webPushOn: boolean;
  pollIntervalMs: number;
  symbols: NotifierSymbolStatus[];
}

function fmtAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

export function getNotifierStatus(): NotifierStatus {
  const telegramOn = isTelegramEnabled();
  const webPushOn = isWebPushEnabled();
  const symbols: NotifierSymbolStatus[] = [];
  for (const symbol of ALL_SYMBOLS) {
    for (const tf of TRACKED_TIMEFRAMES) {
      const k = key(symbol, tf);
      const s = stateMap.get(k);
      symbols.push({
        symbol,
        timeframe: tf,
        trackedSignal: s?.signal ?? "WAIT",
        lastAlertAt: s?.lastAlertAt && s.lastAlertAt > 0 ? s.lastAlertAt : null,
        lastAlertAgo: s?.lastAlertAt && s.lastAlertAt > 0 ? fmtAgo(s.lastAlertAt) : null,
        lastAlertChannels: s?.lastAlertChannels ?? null,
        gateBlocked: Boolean(s?.gateBlockedSince),
        gateBlockedSince: s?.gateBlockedSince ?? null,
        gateBlockedSignal: s?.gateBlockedSignal ?? null,
        gateBlockedFor: s?.gateBlockedSince ? fmtAgo(s.gateBlockedSince) : null,
        consecutiveSls: s?.consecutiveSls ?? 0,
      });
    }
  }
  return {
    enabled: telegramOn || webPushOn,
    telegramOn,
    webPushOn,
    pollIntervalMs: POLL_INTERVAL_MS,
    symbols,
  };
}

// Instruments that receive Telegram/web-push alerts.
// Focus set to the two instruments actively being traded. Everything else
// remains visible in the UI and the API — just no notifications.
const ALERT_SYMBOLS: Symbol[] = ["XAGUSD", "EURUSD"];

// FIB50_SWING fires on 1H and 1D. 1H entries confirmed by weekly macro trend.
const TRACKED_TIMEFRAMES: Timeframe[] = ["1h", "1d"];
// Only seed-alert on 30m at startup/restart for trending/all symbols.
// ALERT_SYMBOLS (XAGUSD, EURUSD) also seed on 1h — there are only 2 symbols
// so the risk of a barrage is minimal, and missing a live 1h metal BUY on
// restart is a real operational gap.
const SEED_TIMEFRAMES = new Set<Timeframe>(["1h", "1d"]);
const ALERT_SEED_TIMEFRAMES = new Set<Timeframe>(["1h"]);
const POLL_INTERVAL_MS = 20_000;

const COOLDOWN_BY_TIMEFRAME: Record<Timeframe, number> = {
  "1h": 3 * 60 * 60_000,
  "4h": 8 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

// Minimum time that must pass before a direction flip (BUY→SELL or SELL→BUY)
// can alert, even though flips normally bypass the same-direction cooldown.
// Daily candles are incomplete intraday — without this guard, a $50 Gold move
// during US session hours produces a SELL → BUY flip within minutes on the 1d,
// which is noise from the live candle, not a genuine daily structure change.
const MIN_FLIP_COOLDOWN_MS: Record<Timeframe, number> = {
  "1h": 0,
  "4h": 60 * 60_000,        // 1h min between 4h flips
  "1d": 4 * 60 * 60_000,    // 4h min between daily flips
  "1w": 24 * 60 * 60_000,   // 24h min between weekly flips
};

// Minimum re-entry delay after an SL: one full candle period.
// This is the hard floor on effectiveCooldownMs — even with streak=0,
// a re-entry cannot happen in the same polling tick that closed the prior trade.
const CANDLE_PERIOD_MS: Record<Timeframe, number> = {
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "1h": "1-hour",
  "4h": "4-hour",
  "1d": "Daily",
  "1w": "Weekly",
};

const stateMap = new Map<string, TrackedState>();

// ─── Phemex auto-trader runtime toggle ────────────────────────────────────────
// Persisted to .runtime/auto-trader-state.json so the setting survives
// server restarts and deployments without requiring manual re-enable.
const AUTO_TRADER_STATE_FILE = join(
  process.env["ACTIVE_TRADES_FILE"]
    ? dirname(process.env["ACTIVE_TRADES_FILE"])
    : join(process.cwd(), ".runtime"),
  "auto-trader-state.json",
);

function loadAutoTraderState(): boolean {
  try {
    if (!existsSync(AUTO_TRADER_STATE_FILE)) {
      // No persisted state — default to ON whenever Phemex keys are present.
      // This ensures both dev and production start trading immediately without
      // a manual API call to enable the auto-trader.
      return isPhemexTradingEnabled();
    }
    const raw = readFileSync(AUTO_TRADER_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

function persistAutoTraderState(enabled: boolean): void {
  try {
    mkdirSync(dirname(AUTO_TRADER_STATE_FILE), { recursive: true });
    writeFileSync(AUTO_TRADER_STATE_FILE, JSON.stringify({ enabled }), "utf8");
  } catch (err) {
    logger.warn({ err }, "phemex-trader: failed to persist auto-trader state");
  }
}

let phemexAutoTraderEnabled = loadAutoTraderState();

export function setPhemexAutoTraderEnabled(enabled: boolean): void {
  phemexAutoTraderEnabled = enabled;
  persistAutoTraderState(enabled);
  logger.info({ enabled }, `phemex-trader: auto-trader ${enabled ? "ENABLED" : "DISABLED"}`);
}

export function getPhemexAutoTraderEnabled(): boolean {
  return phemexAutoTraderEnabled;
}

// ─── Phemex open-order tracking ───────────────────────────────────────────────
// Maps stateMap key → { orderId, phemexSymbol } for any pending limit order that
// has been placed but not yet confirmed filled. Cancelled / filled orders are
// removed from this map as soon as we learn of the transition.
interface OpenPhemexOrder {
  orderId:      string;
  phemexSymbol: string;
  posSide?:     "Long" | "Short";  // required in hedge mode
  // Split-TP tracking (set for every auto-traded order)
  fullQty?:     number;    // full position qty at entry
  entryPx?:     number;    // actual entry price (anchored for Market IOC)
  pxDecimals?:  number;
  qtyDecimals?: number;
  tp1OrderId?:  string;    // reduce-only limit at TP1 (half qty)
  tp2OrderId?:  string;    // reduce-only limit at TP2 (half qty)
  tp1Filled?:   boolean;   // true once TP1 fills and SL has been moved to BE
}
const openPhemexOrders = new Map<string, OpenPhemexOrder>();

// Guards against two concurrent executePhemexTrade calls racing for the same
// slot (can happen when checkSymbol and checkTrendingSymbol both fire in the
// same poll tick). The second call exits immediately.
const inFlightOrderSlots = new Set<string>();

// Tracks the last failed placeOrder attempt per slot (symbol+timeframe key).
// Catch-up retries are suppressed for 5 minutes after a failure so a persistent
// exchange rejection doesn't spam a new attempt every poll cycle.
const failedOrderAt = new Map<string, number>();
const FAILED_ORDER_RETRY_MS = 5 * 60_000;

/**
 * Compute sizing against the real Phemex balance and place a limit order with
 * an attached SL + TP1 bracket.  Stores the returned orderId in openPhemexOrders
 * so a subsequent WAIT/flip transition can cancel it.
 */
interface TrendingTradeMeta {
  decimals: number;
  phemexQtyStep?: number;
  phemexMinQty?: number;
}

function computeEma20(candles: Array<{ close: number }>): number | undefined {
  if (candles.length < 20) return undefined;
  const closes = candles.map(c => c.close);
  const k = 2 / 21;
  let ema = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

async function executePhemexTrade(
  symbol: string,
  timeframe: Timeframe,
  levels: ReturnType<typeof computeLevelsStable>,
  phemexSymbol: string,
  trendingMeta?: TrendingTradeMeta,
  candleRange?: { low: number; high: number; ema20?: number },
  isCatchUp = false,
): Promise<void> {
  logger.info({ symbol, timeframe, phemexSymbol, signal: levels.signal }, "phemex-trader: executePhemexTrade entered");
  const k = key(symbol, timeframe);

  // Prevent two concurrent calls racing for the same slot (e.g. checkSymbol
  // and checkTrendingSymbol both firing in the same poll tick).
  if (inFlightOrderSlots.has(k)) {
    logger.warn({ symbol, timeframe }, "phemex-trader: order already in-flight for slot — skipping duplicate");
    return;
  }
  inFlightOrderSlots.add(k);

  try {
  // Static symbols use the SYMBOLS table. Trending coins pass trendingMeta
  // directly — they are NOT in the SYMBOLS table so the lookup returns undefined.
  const staticMeta = SYMBOLS[symbol as Symbol];
  const meta: SymbolMeta | undefined = staticMeta ?? (trendingMeta ? {
    yahoo: "", tvSymbol: "", tvScrapePath: "", label: symbol,
    prefix: "$", category: "crypto",
    decimals: trendingMeta.decimals,
    phemexQtyStep: trendingMeta.phemexQtyStep,
    phemexMinQty: trendingMeta.phemexMinQty,
    // Non-empty okxPerp triggers the crypto sizing branch in computePositionSizing.
    okxPerp: phemexSymbol,
  } : undefined);
  if (!meta) return;

  // Compute precision and direction early — needed by both the quality gates
  // and the existing-position TP restoration path below.
  const side: "Buy" | "Sell" = levels.signal === "BUY" ? "Buy" : "Sell";
  const posSideForCheck: "Long" | "Short" = side === "Buy" ? "Long" : "Short";
  const qtyStep     = meta.phemexQtyStep ?? 0.001;
  const qtyDecimals = Math.max(0, -Math.floor(Math.log10(qtyStep)));
  const pxDecimals  = meta.decimals ?? 2;

  // Call getUSDTBalance() BEFORE any position or order operations.
  // This is critical: getUSDTBalance() sets the cached detectedHedgeMode as a
  // side-effect. If hedge mode hasn't been detected yet, resolveHedgeMode()
  // returns false and all subsequent cancelOrder / placeStopOrder / placeLimitClose
  // calls omit posSide — causing Phemex 39999 rejections in hedge-mode accounts.
  const realBalance = await getUSDTBalance();
  const accountSize = realBalance ?? DEFAULT_ACCOUNT_SIZE;

  // Check for an already-open position BEFORE entry-quality gates.
  // If a position already exists we are restoring TPs on an already-filled
  // trade — the reward/candle-range/EMA20 guards are for new-entry quality
  // only and must NOT block TP restoration (e.g. DYDX with <5% reward range).
  let existingPos: { size: number; stopLossRp: number } | null;
  try {
    existingPos = await checkExistingPosition(phemexSymbol, posSideForCheck);
  } catch {
    // API failure: safest default is to skip rather than risk doubling exposure.
    logger.warn({ symbol, timeframe, phemexSymbol }, "phemex-trader: checkExistingPosition threw — skipping order (safe default)");
    return;
  }
  if (existingPos !== null) {
    const { size: existingSize, stopLossRp: existingSlPrice } = existingPos;
    logger.info(
      { symbol, timeframe, phemexSymbol, side, existingSize, existingSlPrice },
      "phemex-trader: position already exists on Phemex — registering in tracker, skipping new order",
    );
    // If Phemex shows no SL on this position (stopLossRp === 0), the bracket
    // was silently dropped or the position predates bracket support. Place a
    // stop-market reduce-only order now to protect it.
    if (existingSlPrice === 0) {
      logger.warn(
        { symbol, timeframe, phemexSymbol, slPrice: levels.stopLoss },
        "phemex-trader: existing position has no SL — placing stop-market order",
      );
      // Cancel any stale SL stop orders from prior restarts before placing a
      // fresh one. Without this, every restart stacks another stop-market.
      await cancelExistingStopOrders(phemexSymbol, posSideForCheck);
      await placeStopOrder({
        phemexSymbol,
        posSide:    posSideForCheck,
        stopPx:     levels.stopLoss,
        qtyRq:      existingSize.toFixed(qtyDecimals),
        pxDecimals,
      });
    }
    // Re-place split-TP orders that were lost when openPhemexOrders was wiped
    // on server restart. Cancel any stale reduce-only Limit orders first to
    // prevent doubling up if TPs somehow survived the restart.
    // If TP1 already hit (persisted in active-trades), place only TP2 for the
    // full remaining size; otherwise place both at half size each.
    const entryTs = Date.now();
    const persistedTrade = getActiveTrade(symbol, timeframe);
    const tp1AlreadyHit = persistedTrade?.tp1Hit === true;
    await cancelExistingTpOrders(phemexSymbol, posSideForCheck);

    let tp1OrderId: string | null = null;
    let tp2OrderId: string | null = null;
    if (tp1AlreadyHit) {
      tp2OrderId = await placeLimitClose({
        phemexSymbol,
        posSide:  posSideForCheck,
        priceRp:  levels.takeProfit2.toFixed(pxDecimals),
        qtyRq:    existingSize.toFixed(qtyDecimals),
        clOrdID:  `phx-tp2-${symbol}-${timeframe}-${entryTs}`,
      });
    } else {
      const halfQtyRq = (existingSize / 2).toFixed(qtyDecimals);
      [tp1OrderId, tp2OrderId] = await Promise.all([
        placeLimitClose({
          phemexSymbol,
          posSide:  posSideForCheck,
          priceRp:  levels.takeProfit1.toFixed(pxDecimals),
          qtyRq:    halfQtyRq,
          clOrdID:  `phx-tp1-${symbol}-${timeframe}-${entryTs}`,
        }),
        placeLimitClose({
          phemexSymbol,
          posSide:  posSideForCheck,
          priceRp:  levels.takeProfit2.toFixed(pxDecimals),
          qtyRq:    halfQtyRq,
          clOrdID:  `phx-tp2-${symbol}-${timeframe}-${entryTs}`,
        }),
      ]);
    }
    openPhemexOrders.set(k, {
      orderId:    `pre-existing-${entryTs}`,
      phemexSymbol,
      posSide:    posSideForCheck,
      fullQty:    tp1AlreadyHit ? existingSize * 2 : existingSize,
      entryPx:    levels.entryPrice,
      pxDecimals,
      qtyDecimals,
      tp1OrderId: tp1OrderId ?? undefined,
      tp2OrderId: tp2OrderId ?? undefined,
      tp1Filled:  tp1AlreadyHit,
    });
    logger.info(
      { symbol, timeframe, phemexSymbol, existingSize, tp1AlreadyHit,
        tp1: levels.takeProfit1, tp2: levels.takeProfit2, tp1OrderId, tp2OrderId },
      "phemex-trader: existing position — split-TP orders restored",
    );
    return;
  }

  // No existing position — run entry-quality gates before placing a fresh order.

  // For trending coins: reject if the reward distance is too small relative to
  // entry price. A swing this tight means the coin is ranging — not trending —
  // and the signal is noise. Gate is trending-only; static symbols have their
  // own upstream MIN_IMPULSE_ATR guard in signals.ts.
  if (trendingMeta) {
    const rewardDist = Math.abs(levels.entryPrice - levels.takeProfit1);
    const rewardPct  = rewardDist / levels.entryPrice;
    const MIN_REWARD_PCT = 0.05; // 5% minimum reward distance from entry to TP1
    if (rewardPct < MIN_REWARD_PCT) {
      logger.warn(
        { symbol, timeframe, rewardPct: rewardPct.toFixed(4), entryPrice: levels.entryPrice, tp1: levels.takeProfit1 },
        "phemex-trader: trending coin reward distance too small (ranging market) — order skipped",
      );
      // Register a sentinel so the catch-up block stops retrying every poll.
      if (!openPhemexOrders.has(k)) {
        const skipPosSide = levels.signal === "BUY" ? "Long" : "Short";
        openPhemexOrders.set(k, { orderId: `ranging-skip-${Date.now()}`, phemexSymbol, posSide: skipPosSide });
      }
      return;
    }
  }

  // Reject if TP1 projects beyond the candle dataset's historical price range.
  // A SELL TP below the dataset floor, or a BUY TP above the ceiling, means
  // price has never been there — it's a measured-move fantasy, not a real target.
  if (candleRange) {
    if (levels.signal === "SELL" && levels.takeProfit1 < candleRange.low) {
      logger.warn(
        { symbol, timeframe, tp1: levels.takeProfit1, candleLow: candleRange.low },
        "phemex-trader: SELL TP1 below candle floor — unreachable target, skipping order",
      );
      if (!openPhemexOrders.has(k)) {
        openPhemexOrders.set(k, { orderId: `candle-floor-skip-${Date.now()}`, phemexSymbol, posSide: "Short" });
      }
      return;
    }
    if (levels.signal === "BUY" && levels.takeProfit1 > candleRange.high) {
      logger.warn(
        { symbol, timeframe, tp1: levels.takeProfit1, candleHigh: candleRange.high },
        "phemex-trader: BUY TP1 above candle ceiling — unreachable target, skipping order",
      );
      if (!openPhemexOrders.has(k)) {
        openPhemexOrders.set(k, { orderId: `candle-ceil-skip-${Date.now()}`, phemexSymbol, posSide: "Long" });
      }
      return;
    }
  }

  // If entry is >15% above EMA20 (BUY) or >15% below EMA20 (SELL), price is
  // overextended from the mean — we are chasing a move that is likely exhausted.
  // Applies to ALL signal types: PATTERN_BREAKOUT, FIB50_SWING, etc.
  // If ema20 could not be computed (too few candles), skip the guard rather than
  // silently passing — treat it as a rejection to avoid blindly entering extended moves.
  if (candleRange !== undefined) {
    if (candleRange.ema20 === undefined) {
      logger.warn(
        { symbol, timeframe, signal: levels.signal },
        "phemex-trader: EMA20 unavailable (too few candles) — skipping order to avoid unguarded extended entry",
      );
      return;
    }
    const ema20 = candleRange.ema20;
    const extensionPct = levels.signal === "BUY"
      ? (levels.entryPrice - ema20) / ema20
      : (ema20 - levels.entryPrice) / ema20;
    if (extensionPct > 0.15) {
      logger.warn(
        {
          symbol, timeframe, signal: levels.signal, signalType: levels.signalType,
          entryPrice: levels.entryPrice, ema20,
          extensionPct: (extensionPct * 100).toFixed(1) + "%",
        },
        "phemex-trader: entry >15% extended from EMA20 — over-extended, skipping order",
      );
      return;
    }
  }

  // Cancel any existing pending order for this slot before placing a new one.
  const existing = openPhemexOrders.get(k);
  if (existing) {
    await cancelOrder(existing.phemexSymbol, existing.orderId, existing.posSide);
    openPhemexOrders.delete(k);
  }

  const sizing = computePositionSizing(
    symbol,
    meta,
    levels.entryPrice,
    levels.stopLoss,
    levels.takeProfit1,
    levels.takeProfit2,
    accountSize,
    phemexRiskPct(),
    DEFAULT_MIN_COLLATERAL,
    phemexMaxLeverage(),
    DEFAULT_MT5_LOTS,
  );

  if (!sizing) {
    logger.warn({ symbol, timeframe }, "phemex-trader: sizing returned undefined — skipping order");
    return;
  }

  // Margin-based sizing: always post (riskPct × balance) as collateral.
  // This gives a consistent margin footprint per trade regardless of SL distance.
  //   margin   = accountSize × riskPct          (e.g. $900 × 2% = $18)
  //   notional = margin × maxLeverage            (e.g. $18 × 20 = $360)
  //   qty      = notional / entryPrice
  const targetMargin   = accountSize * phemexRiskPct();
  const targetNotional = targetMargin * phemexMaxLeverage();
  const rawQty         = targetNotional / levels.entryPrice;
  logger.info(
    { symbol, timeframe, accountSize, riskPct: phemexRiskPct(), leverage: phemexMaxLeverage(), targetMargin, targetNotional, rawQty },
    "phemex-trader: margin-based sizing",
  );
  if (!rawQty || rawQty <= 0) {
    logger.warn({ symbol, timeframe, sizing }, "phemex-trader: zero qty — skipping order");
    return;
  }

  // Non-FIB50_SWING catch-up guard: no position exists and the signal is
  // price-pinned (DOUBLE_TOP, DOUBLE_BOTTOM, BB_REJECTION, PATTERN_BREAKOUT).
  // Re-entering at current price with the original SL is dangerous — skip and
  // register a sentinel so the catch-up block stops retrying.
  // FIB50_SWING uses a zone-based entry that tolerates catch-up re-entry.
  if (isCatchUp && levels.signalType !== "FIB50_SWING") {
    logger.info(
      { symbol, timeframe, signalType: levels.signalType },
      "phemex-trader: catch-up skipped — no position to restore for non-FIB50_SWING signal",
    );
    if (!openPhemexOrders.has(k)) {
      openPhemexOrders.set(k, { orderId: `no-catchup-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
    }
    return;
  }

  // If this is a catch-up re-entry (not a fresh signal transition) and our
  // system has an active trade record but Phemex shows no position or order,
  // the trade was closed externally (manually by the user, or SL/TP hit without
  // a system event). Do NOT re-enter via catch-up — register a sentinel so the
  // catch-up block stops firing, and let the next genuine WAIT→BUY/SELL
  // transition handle re-entry if the setup re-forms.
  //
  // Fresh transitions (isCatchUp=false) are NOT blocked here: a stale DB record
  // from a previous deployment must not prevent a newly-formed signal from
  // firing. The alreadyInSameDirection guard in checkSymbol handles the case
  // where the signal hasn't changed direction.
  if (isCatchUp) {
    const existingActiveTrade = getActiveTrade(symbol, timeframe);
    if (existingActiveTrade) {
      logger.warn(
        { symbol, timeframe, phemexSymbol, signal: levels.signal },
        "phemex-trader: catch-up skipped — DB record exists but no Phemex position (externally closed or stale)",
      );
      if (!openPhemexOrders.has(k)) {
        openPhemexOrders.set(k, { orderId: `externally-closed-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
      }
      return;
    }
  }

  // Prevent self-hedging: if an opposite-side position already exists for this
  // symbol (opened by a conflicting timeframe signal), skip rather than creating
  // a simultaneous Long+Short on the same asset.
  const oppositeSideForCheck: "Long" | "Short" = posSideForCheck === "Long" ? "Short" : "Long";
  let oppositePos: { size: number; stopLossRp: number } | null;
  try {
    oppositePos = await checkExistingPosition(phemexSymbol, oppositeSideForCheck);
  } catch {
    logger.warn({ symbol, timeframe, phemexSymbol }, "phemex-trader: checkExistingPosition (opposite side) threw — skipping order (safe default)");
    return;
  }
  if (oppositePos !== null) {
    logger.warn(
      { symbol, timeframe, phemexSymbol, signal: levels.signal, oppositeSize: oppositePos.size, oppositeSide: oppositeSideForCheck },
      "phemex-trader: opposite-side position already open — skipping to avoid self-hedge",
    );
    // Register a sentinel so the catch-up block sees openPhemexOrders.has(k)
    // as true and stops retrying every poll. Without this the loop fires every
    // 20 seconds forever while the opposite position remains open.
    if (!openPhemexOrders.has(k)) {
      openPhemexOrders.set(k, { orderId: `opposite-blocked-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
    }
    return;
  }

  // Also check for an unfilled pending limit order that survived the restart.
  // checkExistingPosition only sees filled positions; a pending order wouldn't
  // show there yet but would be duplicated if we placed another one.
  let existingOrderId: string | null;
  try {
    existingOrderId = await checkExistingOrder(phemexSymbol, posSideForCheck);
  } catch {
    logger.warn({ symbol, timeframe, phemexSymbol }, "phemex-trader: checkExistingOrder threw — skipping order (safe default)");
    return;
  }
  if (existingOrderId !== null) {
    logger.info(
      { symbol, timeframe, phemexSymbol, side, existingOrderId },
      "phemex-trader: pending order already exists on Phemex — registering in tracker, skipping new order",
    );
    openPhemexOrders.set(k, { orderId: existingOrderId, phemexSymbol, posSide: posSideForCheck });
    return;
  }

  // For Market IOC SELL (entry < minPriceRp), the fill happens at current BID,
  // not at signal entry. Anchor SL/TP to currentPrice so the designed R:R
  // (2:1) is preserved at the actual fill price rather than signal entry.
  //   reward = entryPrice - tp1  (positive for SELL)
  //   risk   = sl - entryPrice   (positive for SELL)
  //   new_tp = currentPrice - reward
  //   new_sl = currentPrice + risk
  const minPx = getMinPriceRp(phemexSymbol);
  const isMarketIocSell = side === "Sell" && minPx > 0 && levels.entryPrice < minPx;
  let effectiveSL  = levels.stopLoss;
  let effectiveTP  = levels.takeProfit1;
  let effectiveTP2 = levels.takeProfit2;
  if (isMarketIocSell) {
    const reward  = levels.entryPrice - levels.takeProfit1;
    const reward2 = levels.entryPrice - levels.takeProfit2;
    const risk    = levels.stopLoss   - levels.entryPrice;
    const ref     = levels.currentPrice;
    effectiveTP   = ref - reward;
    effectiveTP2  = ref - reward2;
    effectiveSL   = ref + risk;
    logger.info(
      { symbol, phemexSymbol, signalEntry: levels.entryPrice, currentPrice: ref,
        origSL: levels.stopLoss, origTP: levels.takeProfit1,
        newSL: effectiveSL, newTP: effectiveTP, newTP2: effectiveTP2 },
      "phemex-trader: Market IOC SELL — SL/TP re-anchored to current price",
    );
  }

  // Set leverage on Phemex to match what the sizing math assumed.
  // Without this, Phemex uses whatever leverage is already on the account for
  // that symbol — which may be 1x (the default), causing the margin used to be
  // orders of magnitude larger than the intended 2% risk would suggest.
  await setSymbolLeverage(phemexSymbol, phemexMaxLeverage());

  const entryTs = Date.now();
  const orderId = await placeOrder({
    phemexSymbol,
    side,
    qtyRq:      rawQty.toFixed(qtyDecimals),
    priceRp:    levels.entryPrice.toFixed(pxDecimals),
    stopLossRp: effectiveSL.toFixed(pxDecimals),
    // No bracket TP — two reduce-only limit orders below handle TP1/TP2 separately.
    clOrdID:    `phx-${symbol}-${timeframe}-${entryTs}`,
  });

  if (orderId) {
    failedOrderAt.delete(k);
    const posSide = side === "Buy" ? "Long" : "Short";

    // Split-TP: 50% closes at TP1 (locks in profit), 50% rides to TP2.
    // After TP1 fills, the next poll cycle moves SL to breakeven so the runner is free.
    const halfQtyRq    = (rawQty / 2).toFixed(qtyDecimals);
    const actualEntryPx = isMarketIocSell ? levels.currentPrice : levels.entryPrice;
    const [tp1OrderId, tp2OrderId] = await Promise.all([
      placeLimitClose({
        phemexSymbol,
        posSide,
        priceRp: effectiveTP.toFixed(pxDecimals),
        qtyRq:   halfQtyRq,
        clOrdID: `phx-tp1-${symbol}-${timeframe}-${entryTs}`,
      }),
      placeLimitClose({
        phemexSymbol,
        posSide,
        priceRp: effectiveTP2.toFixed(pxDecimals),
        qtyRq:   halfQtyRq,
        clOrdID: `phx-tp2-${symbol}-${timeframe}-${entryTs}`,
      }),
    ]);

    openPhemexOrders.set(k, {
      orderId,
      phemexSymbol,
      posSide,
      fullQty:    rawQty,
      entryPx:    actualEntryPx,
      pxDecimals,
      qtyDecimals,
      tp1OrderId: tp1OrderId ?? undefined,
      tp2OrderId: tp2OrderId ?? undefined,
      tp1Filled:  false,
    });
    logger.info(
      { symbol, timeframe, side, qty: rawQty, halfQtyRq, entry: actualEntryPx,
        sl: effectiveSL, tp1: effectiveTP, tp2: effectiveTP2,
        orderId, tp1OrderId, tp2OrderId, accountSize },
      "phemex-trader: order + split-TP tracked",
    );
  } else {
    failedOrderAt.set(k, Date.now());
  }
  } finally {
    inFlightOrderSlots.delete(k);
  }
}

// ─── Alert State Persistence ──────────────────────────────────────────────────
// stateMap is in-memory only — a process restart wipes it and the seed logic
// re-fires an alert for every still-pending signal on the first post-restart poll.
// We persist lastAlertAt + lastAlertSignal to disk so the direction-aware cooldown
// survives restarts and eliminates "same signal, 3 alerts in 20 minutes" spam.

interface PersistedAlertEntry {
  signal: SignalKind;
  lastAlertAt: number;
  lastAlertSignal: SignalKind;
}

const NOTIFIER_STATE_FILE =
  process.env["NOTIFIER_STATE_FILE"] ??
  join(process.cwd(), ".runtime", "notifier-alert-state.json");

function loadPersistedAlertState(): void {
  try {
    if (!existsSync(NOTIFIER_STATE_FILE)) return;
    const raw = JSON.parse(
      readFileSync(NOTIFIER_STATE_FILE, "utf-8"),
    ) as Record<string, PersistedAlertEntry>;
    let loaded = 0;
    for (const [k, entry] of Object.entries(raw)) {
      if (!stateMap.has(k) && entry.lastAlertAt > 0) {
        stateMap.set(k, {
          signal: entry.signal,
          lastAlertAt: entry.lastAlertAt,
          lastAlertSignal: entry.lastAlertSignal,
        });
        loaded++;
      }
    }
    if (loaded > 0) logger.info({ loaded }, "Notifier alert state restored from disk");
  } catch (err) {
    logger.warn({ err }, "Failed to load notifier alert state from disk");
  }
}

function persistAlertEntry(k: string, signal: SignalKind, lastAlertAt: number): void {
  try {
    let existing: Record<string, PersistedAlertEntry> = {};
    if (existsSync(NOTIFIER_STATE_FILE)) {
      existing = JSON.parse(
        readFileSync(NOTIFIER_STATE_FILE, "utf-8"),
      ) as Record<string, PersistedAlertEntry>;
    }
    if (lastAlertAt === 0) {
      delete existing[k];
    } else {
      existing[k] = { signal, lastAlertAt, lastAlertSignal: signal };
    }
    mkdirSync(dirname(NOTIFIER_STATE_FILE), { recursive: true });
    writeFileSync(NOTIFIER_STATE_FILE, JSON.stringify(existing, null, 2));
  } catch (err) {
    logger.warn({ err, k }, "Failed to persist notifier alert entry");
  }
}

function key(symbolKey: string, timeframe: Timeframe): string {
  return `${symbolKey}::${timeframe}`;
}

function buildAppLink(symbolKey: string, timeframe: Timeframe): string | null {
  const prodDomains = process.env["REPLIT_DOMAINS"];
  const devDomain = process.env["REPLIT_DEV_DOMAIN"];
  const host = prodDomains?.split(",")[0]?.trim() || devDomain?.trim();
  if (!host) return null;
  return `https://${host}/?symbol=${symbolKey}&timeframe=${timeframe}`;
}

function isWebPushEnabled(): boolean {
  const flag = process.env["ENABLE_WEB_PUSH"];
  if (flag === "false" || flag === "0") return false;
  return Boolean(
    process.env["VAPID_PUBLIC_KEY"] && process.env["VAPID_PRIVATE_KEY"],
  );
}

// Map each tracked TF to the higher TF used as its alignment gate.
const HIGHER_TIMEFRAME: Partial<Record<Timeframe, Timeframe>> = {
  "1h": "1d",
  "4h": "1d",
  "1d": "1w",
};

async function checkSymbol(
  symbol: Symbol,
  timeframe: Timeframe,
): Promise<void> {
  try {
    const higherTf = HIGHER_TIMEFRAME[timeframe];
    // For 1H signals, also fetch daily candles so FIB50_SWING can synthesize
    // weekly bars for the macro trend gate (weekly SMA-30 confirmation).
    const needDailyForWeekly = timeframe === "1h";
    const [candles, spot, higherCandles, rawDailyForWeekly] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
      higherTf ? fetchCandlesForTimeframe(symbol, higherTf) : Promise.resolve([]),
      needDailyForWeekly ? fetchCandlesForTimeframe(symbol, "1d") : Promise.resolve([]),
    ]);
    if (candles.length < 2) return;

    // Apply basis shift for metals so alert prices (entry/SL/TP) match broker
    // spot pricing (MT5 / OANDA) rather than SI=F / GC=F futures levels.
    const adjustedCandles =
      spot != null && SYMBOLS[symbol].hasFuturesBasis
        ? applyFuturesBasis(candles, spot, makeRounder(SYMBOLS[symbol].decimals))
        : candles;

    const dailyForWeekly = rawDailyForWeekly.length > 0 ? rawDailyForWeekly : undefined;
    // For 1D: pass weekly candles (already fetched as higherCandles) so the
    // 1d signal is gated by the weekly EMA21/50 trend before alerting.
    const weeklyCandlesForDaily = timeframe === "1d" && higherCandles.length >= 2
      ? higherCandles
      : undefined;

    // Snapshot the active trade BEFORE calling computeLevelsStable.
    // computeLevelsStable writes a new ActiveTrade entry the moment a fresh
    // BUY/SELL fires, so reading after the call always finds a trade in the
    // new direction — causing alreadyInSameDirection to fire and silently
    // eat every non-seed alert. Reading before gives us the pre-computation
    // state: null on a genuine new signal, populated on an oscillation.
    const activeTradeBeforeCompute = getActiveTrade(symbol, timeframe);

    const levels = computeLevelsStable(
      adjustedCandles, spot, timeframe, symbol, SYMBOLS[symbol],
      DEFAULT_ACCOUNT_SIZE, DEFAULT_RISK_PCT, DEFAULT_MIN_COLLATERAL, DEFAULT_MAX_LEVERAGE, DEFAULT_MT5_LOTS,
      dailyForWeekly, weeklyCandlesForDaily,
    );
    const k = key(symbol, timeframe);
    const prev = stateMap.get(k);
    const now = Date.now();

    // Seed state on first observation. If a BUY/SELL is *already active*
    // at seed time (e.g. the server just started while a position was
    // already in its zone), treat it as a transition so the user gets a
    // one-time snapshot alert instead of silently missing the trade. WAIT
    // signals at seed time are still suppressed — there's nothing to
    // alert on.
    // Seeds fire for ALERT_SEED_TIMEFRAMES (30m + 1h) for these priority symbols.
    // 1d first-observations still record silently — daily signals rarely miss on restart.
    // Seed only for PENDING limit orders (not yet filled). Already-running
    // positions are recorded silently — re-alerting a filled trade after a
    // restart looks like a stale "new entry" to the user.
    const isSeedSnapshot = !prev && ALERT_SEED_TIMEFRAMES.has(timeframe) && (levels.signal === "BUY" || levels.signal === "SELL") && (levels.tradeState === "WAIT" || levels.tradeState === "PENDING");
    const transitioned =
      isSeedSnapshot ||
      (!!prev &&
        prev.signal !== levels.signal &&
        (levels.signal === "BUY" || levels.signal === "SELL"));

    if (!prev && !isSeedSnapshot) {
      // For already-filled trades, stamp lastAlertAt = now so the
      // tradeAlreadyAlerted guard fires correctly on subsequent oscillations
      // (SELL→WAIT→SELL). Without this, lastAlertAt=0 makes tradeAlreadyAlerted
      // false and the oscillation alert fires with a stale "filled/TP1" message.
      const isAlreadyFilled = levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
      stateMap.set(k, {
        signal: levels.signal,
        lastAlertAt: isAlreadyFilled ? Date.now() : 0,
        lastAlertSignal: isAlreadyFilled ? (levels.signal as SignalKind) : undefined,
      });
      return;
    }

    // Consecutive-SL circuit breaker: multiply the cooldown after repeated
    // SLs in the same direction to reduce whipsaw re-entries.
    //   0–1 SL  → 1× (base cooldown)
    //   2 SLs   → 2× base
    //   3+ SLs  → 4× base (hard cap)
    // A minimum of 1 full candle period is also enforced so a new alert
    // can never fire in the same polling tick that closed the prior trade.
    const slStreak = prev?.consecutiveSls ?? 0;
    const slMultiplier = slStreak >= 3 ? 4 : slStreak >= 2 ? 2 : 1;
    const effectiveCooldownMs = Math.max(
      COOLDOWN_BY_TIMEFRAME[timeframe] * slMultiplier,
      CANDLE_PERIOD_MS[timeframe],
    );
    // Cooldown is direction-aware: only applies when the new signal matches
    // the last alerted direction. A BUY→SELL (or SELL→BUY) flip bypasses the
    // cooldown entirely — it's a new setup in the opposite direction, not a
    // repeat alert. This prevents the cooldown from silently eating reversals
    // after a trade closes (e.g. KSM TP2 BUY → no SELL alert during reversal).
    const cooldownActive =
      !!prev &&
      now - prev.lastAlertAt < effectiveCooldownMs &&
      prev.lastAlertSignal === levels.signal;

    // De-dup against the active-trade store: if a trade was already open in
    // the same direction BEFORE this compute cycle, the user is already
    // positioned and a fresh BUY/SELL alert is just noise. The level-signal
    // classifier can oscillate BUY→WAIT→BUY when price briefly exits its
    // zone (e.g. the start of a pump), and without this guard the second
    // BUY transition would re-alert even though the original trade is still
    // mathematically open. WAIT does not invalidate the active trade by
    // design, so checking the store is the source of truth for "am I
    // already in this?".
    //
    // IMPORTANT: only suppress if we actually sent an alert for this trade.
    // If the active trade was opened AFTER the last alert (or no alert was
    // ever sent), the /api/levels page-load created the snapshot before the
    // notifier ran — suppressing here means the user NEVER gets the alert.
    const tradeAlreadyAlerted =
      prev != null &&
      prev.lastAlertAt > 0 &&
      (activeTradeBeforeCompute?.openedAt ?? 0) <= prev.lastAlertAt;
    const alreadyInSameDirection =
      !isSeedSnapshot &&
      activeTradeBeforeCompute?.signal === levels.signal &&
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      tradeAlreadyAlerted;

    if (transitioned && !cooldownActive && !alreadyInSameDirection) {
      // Filled-trade and direction-flip checks run FIRST — both exempt from
      // the type filter and the higher-TF gate below.
      const isFilledTrade =
        levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
      const isDirectionFlip =
        !!prev &&
        ((prev.signal === "BUY" && levels.signal === "SELL") ||
          (prev.signal === "SELL" && levels.signal === "BUY"));

      // Minimum flip cooldown: prevent intraday oscillations on longer TFs.
      // Daily candles are incomplete during the session — a $50 Gold move can
      // flip the 1d signal SELL→BUY within minutes, which is noise from the
      // live candle, not a structural change worth alerting. Filled trades are
      // always exempt: if you're filled, you need to know regardless.
      const minFlipMs = MIN_FLIP_COOLDOWN_MS[timeframe];
      const flipTooFast =
        isDirectionFlip &&
        !isFilledTrade &&
        minFlipMs > 0 &&
        !!prev &&
        prev.lastAlertAt > 0 &&
        now - prev.lastAlertAt < minFlipMs;
      if (flipTooFast) {
        logger.info(
          { symbol, timeframe, from: prev!.signal, to: levels.signal, remainingMs: minFlipMs - (now - prev!.lastAlertAt) },
          "Direction flip suppressed (min flip cooldown — incomplete candle noise)",
        );
        stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
        return;
      }

      // Hard type filter. Only FIB50_SWING, DOUBLE_TOP, DOUBLE_BOTTOM, and BB_REJECTION
      // signals trigger notifications and Phemex auto-trades. PATTERN_BREAKOUT is
      // excluded — entries are time-sensitive and degrade rapidly after the breakout bar.
      // Filled trades bypass this: a fill notification is always actionable
      // regardless of what signal type originally opened the position.
      if (!isFilledTrade) {
        const signalTypeAllowed = levels.signalType === "FIB50_SWING" || levels.signalType === "DOUBLE_TOP" || levels.signalType === "DOUBLE_BOTTOM" || levels.signalType === "BB_REJECTION";
        if (!signalTypeAllowed) {
          logger.info(
            { symbol, timeframe, signalType: levels.signalType },
            "Signal alert suppressed (signal type not allowed for notifications)",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // Gate: pending signals must be confirmed by the next higher TF before alerting.
      // 30m is gated by 1h; 1h is gated by 1d. Filled trades are exempt.
      // Direction flips (BUY→SELL or SELL→BUY) are also exempt: a lower-TF
      // reversal is valid even when the higher TF disagrees — e.g. a 30m BUY
      // rally within a 1h SELL trend is a real counter-move worth alerting.
      if (
        higherTf != null &&
        !isFilledTrade &&
        !isDirectionFlip &&
        (levels.signal === "BUY" || levels.signal === "SELL") &&
        higherCandles.length >= 2
      ) {
        const adjRound = makeRounder(SYMBOLS[symbol].decimals);
        const adjHigher =
          spot != null && SYMBOLS[symbol].hasFuturesBasis
            ? applyFuturesBasis(higherCandles, spot, adjRound)
            : higherCandles;
        const higherResult = computeLevelsStable(adjHigher, spot, higherTf, symbol, SYMBOLS[symbol]);
        // Gate: block only when higher TF is ACTIVELY OPPOSITE (BUY vs SELL, SELL vs BUY).
        // Old behaviour blocked when higher TF was WAIT, which killed DAGGER alerts during
        // wave 2 pullbacks — the 1h temporarily reads WAIT while price retraces, then DAGGER
        // fires the wave 3 entry. WAIT means "no clear signal", not "wrong direction".
        const higherTfOpposed =
          (higherResult.signal === "BUY" && levels.signal === "SELL") ||
          (higherResult.signal === "SELL" && levels.signal === "BUY");
        if (higherTfOpposed) {
          logger.info(
            { symbol, timeframe, signal: levels.signal, higherTf, higherSignal: higherResult.signal },
            "Signal alert suppressed (higher TF actively opposed)",
          );
          // Keep the PREVIOUS signal in stateMap — not the new one. If we
          // record levels.signal here (e.g. BUY), the next tick sees BUY→BUY
          // and never fires. By preserving prev's signal (e.g. WAIT), the
          // transition fires correctly the moment 1h aligns.
          stateMap.set(k, {
            ...(prev ?? {}),
            signal: prev?.signal ?? "WAIT",
            lastAlertAt: prev?.lastAlertAt ?? 0,
          });
          return;
        }
      }

      // Phemex auto-trade: place order on every fresh signal transition that
      // passes all gates above. Seed snapshots are excluded — they represent
      // catch-up state on restart, not live signals.
      if (!isSeedSnapshot && (levels.signal === "BUY" || levels.signal === "SELL")) {
        const phemexSymbol = SYMBOLS[symbol as Symbol]?.phemexPerp;
        const tradingEnabled = isPhemexTradingEnabled();
        const autoTraderOn   = phemexAutoTraderEnabled;
        logger.info(
          { symbol, timeframe, signal: levels.signal, tradingEnabled, autoTraderOn, hasPhemexSymbol: !!phemexSymbol },
          "phemex-trader: gate check",
        );
        if (tradingEnabled && autoTraderOn && phemexSymbol) {
          const candleRange = candles.length > 0
            ? {
                low:   Math.min(...candles.map(c => c.close)),
                high:  Math.max(...candles.map(c => c.close)),
                ema20: computeEma20(candles),
              }
            : undefined;
          void executePhemexTrade(symbol, timeframe, levels, phemexSymbol, undefined, candleRange);
        }
      }

      const tfLabel = TIMEFRAME_LABEL[timeframe];
      const link = buildAppLink(symbol, timeframe);
      const ctx = buildAlertContext(symbol, SYMBOLS[symbol], timeframe, tfLabel, levels, link);

      // Fan out to every channel that's enabled. Failures in one channel
      // never block the others — Promise.allSettled isolates them.
      const tasks: Promise<void>[] = [];
      if (isTelegramEnabled()) {
        tasks.push(sendTelegramAlert(ctx));
      }
      if (isWebPushEnabled()) {
        const sideEmoji = levels.signal === "BUY" ? "🟢" : "🔴";
        const sideWord = levels.signal === "BUY" ? "BUY" : "SELL";
        const typeTag = " ◈ FIB50";
        const m = SYMBOLS[symbol];
        const fmtN = (n: number) => `${m.prefix}${n.toFixed(m.decimals)}`;
        // Body keeps the most decision-relevant numbers within the
        // ~3-line lock-screen budget.
        const lines: string[] = [
          `${tfLabel} · ${fmtN(levels.currentPrice)}`,
          `Entry ${fmtN(levels.entryPrice)} · SL ${fmtN(levels.stopLoss)}`,
          `TP1 ${fmtN(levels.takeProfit1)} · TP2 ${fmtN(levels.takeProfit2)}`,
        ];
        const origin = link ? new URL(link).origin : null;
        tasks.push(
          broadcastWebPush({
            title: `${sideEmoji} ${sideWord}${typeTag} ${m.label}`,
            body: lines.join("\n"),
            url: link ?? "/",
            tag: `${symbol}-${timeframe}`,
            icon: origin ? `${origin}/notification-icon.png` : undefined,
            badge: origin ? `${origin}/notification-badge.png` : undefined,
            requireInteraction: timeframe === "1d",
          }),
        );
      }

      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
        logger.info(
          {
            symbol,
            timeframe,
            from: prev?.signal ?? "(seed)",
            to: levels.signal,
            channels: tasks.length,
            seedSnapshot: isSeedSnapshot,
          },
          "Signal alert dispatched",
        );
      }

      const newPatternKey = prev?.lastPatternKey;
      stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: now, lastAlertSignal: levels.signal, lastPatternKey: newPatternKey });
      persistAlertEntry(k, levels.signal as SignalKind, now);
      return;
    }

    if (transitioned && cooldownActive && prev) {
      logger.info(
        {
          symbol,
          timeframe,
          from: prev.signal,
          to: levels.signal,
          remainingMs: effectiveCooldownMs - (now - prev.lastAlertAt),
          slStreak,
          slMultiplier,
        },
        "Signal alert suppressed (cooldown)",
      );
    }

    if (transitioned && alreadyInSameDirection) {
      logger.info(
        {
          symbol,
          timeframe,
          from: prev?.signal ?? "(seed)",
          to: levels.signal,
          activeEntry: activeTradeBeforeCompute?.entryPrice,
          activeOpenedAt: activeTradeBeforeCompute?.openedAt,
        },
        "Signal alert suppressed (already in active trade same direction)",
      );
    }

    // Cancel any tracked Phemex pending order when signal returns to WAIT.
    // This fires for all non-alert transitions (cooldown, alreadyInSameDirection,
    // etc.) where the signal moves away from BUY/SELL — letting the bracket
    // orders that are already filled through Phemex's own SL/TP is safe, since
    // cancelOrder ignores "already filled" errors gracefully.
    // Always attempt cancel regardless of autoTraderEnabled — if orders were
    // placed before a disable, we still want to clean them up.
    if (
      levels.signal === "WAIT" &&
      prev?.signal !== "WAIT" &&
      isPhemexTradingEnabled()
    ) {
      const openOrder = openPhemexOrders.get(k);
      if (openOrder) {
        const cancelTasks: Promise<void>[] = [
          cancelOrder(openOrder.phemexSymbol, openOrder.orderId, openOrder.posSide),
        ];
        if (openOrder.tp1OrderId) cancelTasks.push(cancelOrder(openOrder.phemexSymbol, openOrder.tp1OrderId, openOrder.posSide));
        if (openOrder.tp2OrderId) cancelTasks.push(cancelOrder(openOrder.phemexSymbol, openOrder.tp2OrderId, openOrder.posSide));
        void Promise.allSettled(cancelTasks).then(() => {
          openPhemexOrders.delete(k);
        });
      }
    }

    // Track new signal but preserve lastAlertAt and streak so cooldown still ticks.
    // Clear lastPatternKey when signal returns to WAIT — the pattern is gone.
    stateMap.set(k, {
      ...(prev ?? {}),
      signal: levels.signal,
      lastAlertAt: prev?.lastAlertAt ?? 0,
      lastPatternKey: levels.signal === "WAIT" ? undefined : prev?.lastPatternKey,
    });

    // TP1 fill detection: if the tracked position has shrunk to ~50% of fullQty,
    // TP1 hit. Cancel the bracket SL and place a new stop at breakeven (entry price)
    // so the second half rides risk-free to TP2.
    const tp1CheckOrder = openPhemexOrders.get(k);
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      tp1CheckOrder?.fullQty !== undefined &&
      !tp1CheckOrder.tp1Filled
    ) {
      try {
        const pos = await checkExistingPosition(tp1CheckOrder.phemexSymbol, tp1CheckOrder.posSide!);
        if (pos && pos.size < tp1CheckOrder.fullQty * 0.75) {
          await cancelExistingStopOrders(tp1CheckOrder.phemexSymbol, tp1CheckOrder.posSide!);
          await placeStopOrder({
            phemexSymbol: tp1CheckOrder.phemexSymbol,
            posSide:      tp1CheckOrder.posSide!,
            stopPx:       tp1CheckOrder.entryPx!,
            qtyRq:        (tp1CheckOrder.fullQty / 2).toFixed(tp1CheckOrder.qtyDecimals ?? 0),
            pxDecimals:   tp1CheckOrder.pxDecimals ?? 2,
          });
          openPhemexOrders.set(k, { ...tp1CheckOrder, tp1Filled: true });
          logger.info(
            { symbol, timeframe, entryPx: tp1CheckOrder.entryPx, fullQty: tp1CheckOrder.fullQty, posSize: pos.size },
            "phemex-trader: TP1 filled — SL moved to breakeven",
          );
        }
      } catch (err) {
        logger.warn({ err, symbol, timeframe }, "phemex-trader: TP1 fill check failed — skipping BE move");
      }
    }

    // Catch-up auto-trade: if the auto-trader is on, signal is active, and no
    // Phemex order is currently tracked for this slot, place one now.
    // This handles the case where the trader was enabled (or the server restarted)
    // while a signal was already live — the transition block above was skipped
    // because there was no state change, but the order still needs to be placed.
    const lastFailed = failedOrderAt.get(k) ?? 0;
    const recentlyFailed = Date.now() - lastFailed < FAILED_ORDER_RETRY_MS;
    // TP retry: if we placed an entry order but TPs were never set (e.g. the
    // limit entry filled AFTER the initial placeLimitClose attempt), the tracker
    // holds the entry orderId but tp1OrderId is undefined. openPhemexOrders.has(k)
    // would suppress the catch-up block, so clear the stale tracker here and let
    // the catch-up below reinitialize the TPs on this same poll cycle.
    // Guard: tp1Filled===false (explicitly set on real orders) distinguishes
    // a real tracked order from sentinel objects (tp1Filled===undefined).
    {
      const t = openPhemexOrders.get(k);
      if (t && t.tp1Filled === false && !t.tp1OrderId && !t.tp2OrderId) {
        logger.info({ symbol, timeframe }, "phemex-trader: tracked order missing TPs — clearing stale tracker for TP retry");
        openPhemexOrders.delete(k);
      }
    }
    // All signal types reach executePhemexTrade for catch-up.
    // The re-entry type gate (FIB50_SWING only) lives inside executePhemexTrade:
    // if a position already exists it restores TPs for any signal type; if no
    // position exists it only re-enters for FIB50_SWING.
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      (levels.tradeState === "PENDING" || levels.tradeState === "FILLED_PROFIT") &&
      isPhemexTradingEnabled() &&
      phemexAutoTraderEnabled &&
      !openPhemexOrders.has(k) &&
      !recentlyFailed
    ) {
      const phemexSymbol = SYMBOLS[symbol as Symbol]?.phemexPerp;
      if (phemexSymbol) {
        // Reward-distance check: if TP1 is too close to entry the signal is
        // ranging or stale. Register a sentinel so the catch-up stops retrying.
        // Skip this check for FILLED_PROFIT — the position is already open and
        // we are restoring TP orders, not making an entry decision.
        const rewardDist = Math.abs(levels.entryPrice - levels.takeProfit1);
        const rewardPct  = rewardDist / levels.entryPrice;
        const MIN_REWARD_PCT = 0.03; // 3% minimum — tighter than trending (5%) since metals/forex can have smaller swings
        const skipRewardCheck = levels.tradeState === "FILLED_PROFIT";
        if (!skipRewardCheck && rewardPct < MIN_REWARD_PCT) {
          logger.warn(
            { symbol, timeframe, rewardPct: rewardPct.toFixed(4), entryPrice: levels.entryPrice, tp1: levels.takeProfit1 },
            "phemex-trader: catch-up reward distance too small (ranging/stale) — order skipped",
          );
          if (!openPhemexOrders.has(k)) {
            const skipPosSide = levels.signal === "BUY" ? "Long" : "Short";
            openPhemexOrders.set(k, { orderId: `ranging-skip-${Date.now()}`, phemexSymbol, posSide: skipPosSide });
          }
        } else {
          logger.info({ symbol, timeframe, signal: levels.signal, signalType: levels.signalType, tradeState: levels.tradeState }, "phemex-trader: catch-up order — no tracked order for active signal");
          void executePhemexTrade(symbol, timeframe, levels, phemexSymbol, undefined, undefined, true);
        }
      }
    }
  } catch (err) {
    logger.warn({ err, symbol, timeframe }, "Notifier check failed");
  }
}

async function checkTrendingSymbol(
  symbolKey: string,
  timeframe: Timeframe,
): Promise<void> {
  try {
    const { getTrendingSymbols, fetchCandlesForDynamic, fetchSpotForDynamic } = await import("./trending-discovery");
    const tMeta = getTrendingSymbols().find((t) => t.symbolKey === symbolKey);
    if (!tMeta) return; // expired or not in cache
    const higherTf = HIGHER_TIMEFRAME[timeframe];
    const needDailyForWeekly = timeframe === "1h";
    const [candles, spot, higherCandles, rawDailyForWeekly] = await Promise.all([
      fetchCandlesForDynamic(tMeta.okxPerp!, timeframe),
      fetchSpotForDynamic(tMeta.okxPerp!),
      higherTf ? fetchCandlesForDynamic(tMeta.okxPerp!, higherTf) : Promise.resolve([]),
      needDailyForWeekly ? fetchCandlesForDynamic(tMeta.okxPerp!, "1d") : Promise.resolve([]),
    ]);
    if (candles.length < 2) return;

    const dailyForWeekly = (rawDailyForWeekly as typeof candles).length > 0
      ? (rawDailyForWeekly as typeof candles)
      : undefined;
    // For 1D: pass weekly candles (already fetched as higherCandles) so the
    // 1d signal is gated by the weekly EMA21/50 trend.
    const weeklyCandlesForDailyT = timeframe === "1d" && (higherCandles as typeof candles).length >= 2
      ? (higherCandles as typeof candles)
      : undefined;

    const k = key(symbolKey, timeframe);
    const prev = stateMap.get(k);

    // Snapshot the active trade BEFORE calling computeLevelsStable.
    // Mirrors the same pattern as checkSymbol: computeLevelsStable writes a
    // new ActiveTrade the moment a fresh BUY/SELL fires, so reading after the
    // call always finds a trade in the new direction — causing
    // alreadyInSameDirection to fire and eat every non-seed alert.
    const activeTradeBeforeCompute = getActiveTrade(symbolKey, timeframe);

    const levels = computeLevelsStable(
      candles, spot, timeframe, symbolKey, tMeta,
      undefined, undefined, undefined, undefined, undefined,
      dailyForWeekly, weeklyCandlesForDailyT,
    );
    const now = Date.now();

    // Trending coins never auto-seed on server restart. They are lower-priority
    // instruments — the user doesn't need a "catch-up" alert every time the
    // process restarts. Seeding (isSeedSnapshot) is reserved for ALERT_SYMBOLS
    // (XAGUSD, EURUSD) in checkSymbol. Here we only alert on genuine live
    // signal transitions that happen while the server is running.
    const isSeedSnapshot = false;
    const transitioned =
      !!prev && prev.signal !== levels.signal && (levels.signal === "BUY" || levels.signal === "SELL");

    if (!prev && !isSeedSnapshot) {
      const isAlreadyFilled = levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
      stateMap.set(k, {
        signal: levels.signal,
        lastAlertAt: isAlreadyFilled ? Date.now() : 0,
        lastAlertSignal: isAlreadyFilled ? (levels.signal as SignalKind) : undefined,
      });
      return;
    }

    // Consecutive-SL circuit breaker (same logic as checkSymbol).
    const slStreakT = prev?.consecutiveSls ?? 0;
    const slMultiplierT = slStreakT >= 3 ? 4 : slStreakT >= 2 ? 2 : 1;
    const effectiveCooldownMsT = Math.max(
      COOLDOWN_BY_TIMEFRAME[timeframe] * slMultiplierT,
      CANDLE_PERIOD_MS[timeframe],
    );
    // Direction-aware: only suppress same-direction repeats. A flip in
    // direction (BUY→SELL or SELL→BUY) always bypasses the cooldown.
    const cooldownActive =
      !!prev &&
      now - prev.lastAlertAt < effectiveCooldownMsT &&
      prev.lastAlertSignal === levels.signal;

    // De-dup against the active-trade store (same logic as checkSymbol).
    // When a trending coin's signal oscillates BUY→WAIT→BUY while the original
    // trade is still open, suppress the second alert — the user is already
    // positioned. Only suppress when we actually sent an alert for this trade;
    // if the trade was opened via a page-load before the notifier ran, the
    // user has never received an alert and should get one.
    const tradeAlreadyAlertedT =
      prev != null &&
      prev.lastAlertAt > 0 &&
      (activeTradeBeforeCompute?.openedAt ?? 0) <= prev.lastAlertAt;
    const alreadyInSameDirection =
      !isSeedSnapshot &&
      activeTradeBeforeCompute?.signal === levels.signal &&
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      tradeAlreadyAlertedT;

    if (transitioned && !cooldownActive && !alreadyInSameDirection) {
      // Filled-trade and direction-flip checks run FIRST — both exempt from
      // the type filter and the higher-TF gate below.
      const isFilledTrade =
        levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
      const isDirectionFlip =
        !!prev &&
        ((prev.signal === "BUY" && levels.signal === "SELL") ||
          (prev.signal === "SELL" && levels.signal === "BUY"));

      // Same min-flip cooldown as checkSymbol — trending coins run 4h/1d too.
      const minFlipMsT = MIN_FLIP_COOLDOWN_MS[timeframe];
      const flipTooFastT =
        isDirectionFlip &&
        !isFilledTrade &&
        minFlipMsT > 0 &&
        !!prev &&
        prev.lastAlertAt > 0 &&
        now - prev.lastAlertAt < minFlipMsT;
      if (flipTooFastT) {
        logger.info(
          { symbolKey, timeframe, from: prev!.signal, to: levels.signal, remainingMs: minFlipMsT - (now - prev!.lastAlertAt) },
          "Trending direction flip suppressed (min flip cooldown — incomplete candle noise)",
        );
        stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
        return;
      }

      // Signal-type guard for trending coins. PIVOT_BOUNCE and BREAKOUT on
      // trending symbols showed 0% WR across every coin in production.
      // Filled trades bypass this: fills are always actionable regardless of
      // what signal type originally opened the position.
      if (!isFilledTrade) {
        const trendingTypeAllowed = levels.signalType === "FIB50_SWING" || levels.signalType === "DOUBLE_TOP" || levels.signalType === "DOUBLE_BOTTOM" || levels.signalType === "BB_REJECTION";
        if (!trendingTypeAllowed) {
          logger.info(
            { symbolKey, timeframe, signalType: levels.signalType },
            "Trending signal alert suppressed (only FIB50_SWING/DOUBLE_TOP/DOUBLE_BOTTOM/BB_REJECTION allowed on trending coins)",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // Gate: pending signals must be confirmed by the next higher TF before alerting.
      // 30m is gated by 1h; 1h is gated by 1d. Filled trades are exempt.
      if (
        higherTf != null &&
        !isFilledTrade &&
        !isDirectionFlip &&
        (levels.signal === "BUY" || levels.signal === "SELL") &&
        higherCandles.length >= 2
      ) {
        const higherResult = computeLevelsStable(higherCandles, spot, higherTf, symbolKey, tMeta);
        const higherTfOpposedT =
          (higherResult.signal === "BUY" && levels.signal === "SELL") ||
          (higherResult.signal === "SELL" && levels.signal === "BUY");
        if (higherTfOpposedT) {
          logger.info(
            { symbolKey, timeframe, signal: levels.signal, higherTf, higherSignal: higherResult.signal },
            "Trending signal alert suppressed (higher TF actively opposed)",
          );
          stateMap.set(k, {
            ...(prev ?? {}),
            signal: prev?.signal ?? "WAIT",
            lastAlertAt: prev?.lastAlertAt ?? 0,
          });
          return;
        }
      }

      // Reward-distance pre-check for trending coins: suppress both alert and
      // trade if TP1 is too close to entry. executePhemexTrade has the same
      // check internally, but it runs async (fire-and-forget) so the alert
      // fires before the check completes — user sees "SELL TAO" on Telegram
      // but no order on Phemex. Doing it here keeps them in sync.
      if (levels.signal === "BUY" || levels.signal === "SELL") {
        const preRewardDist = Math.abs(levels.entryPrice - levels.takeProfit1);
        const preRewardPct  = preRewardDist / levels.entryPrice;
        if (preRewardPct < 0.05) {
          logger.warn(
            { symbolKey, timeframe, rewardPct: preRewardPct.toFixed(4), signal: levels.signal },
            "Trending signal suppressed — reward distance too small (ranging market), skipping alert and trade",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // Phemex auto-trade for trending coins.
      // tMeta.phemexPerp is the exchange symbol (e.g. "ONDOUSDT").
      // We pass trendingMeta so executePhemexTrade doesn't bail on the SYMBOLS lookup.
      if (
        !isSeedSnapshot &&
        (levels.signal === "BUY" || levels.signal === "SELL") &&
        isPhemexTradingEnabled() &&
        phemexAutoTraderEnabled &&
        tMeta.phemexPerp
      ) {
        const candleRangeTrending = candles.length > 0
          ? {
              low:   Math.min(...candles.map(c => c.close)),
              high:  Math.max(...candles.map(c => c.close)),
              ema20: computeEma20(candles),
            }
          : undefined;
        void executePhemexTrade(symbolKey, timeframe, levels, tMeta.phemexPerp, {
          decimals: tMeta.decimals,
          phemexQtyStep: tMeta.phemexQtyStep,
          phemexMinQty: tMeta.phemexMinQty,
        }, candleRangeTrending);
      }

      const tfLabel = TIMEFRAME_LABEL[timeframe];
      const link = buildAppLink(symbolKey, timeframe);
      const ctx = buildAlertContext(symbolKey, tMeta, timeframe, tfLabel, levels, link);
      const tasks: Promise<void>[] = [];
      if (isTelegramEnabled()) tasks.push(sendTelegramAlert(ctx));
      if (isWebPushEnabled()) {
        const sideEmoji = levels.signal === "BUY" ? "🟢" : "🔴";
        const sideWord = levels.signal === "BUY" ? "BUY" : "SELL";
        const typeTagT = " ◈ FIB50";
        const fmtN = (n: number) => `$${n.toFixed(tMeta.decimals)}`;
        const lines = [
          `${tfLabel} · ${fmtN(levels.currentPrice)}`,
          `Entry ${fmtN(levels.entryPrice)} · SL ${fmtN(levels.stopLoss)}`,
          `TP1 ${fmtN(levels.takeProfit1)} · TP2 ${fmtN(levels.takeProfit2)}`,
        ];
        tasks.push(
          broadcastWebPush({
            title: `${sideEmoji} ${sideWord}${typeTagT} ${symbolKey} (TRENDING)`,
            body: lines.join("\n"),
            url: link ?? "/",
            tag: `${symbolKey}-${timeframe}`,
          }),
        );
      }
      if (tasks.length > 0) await Promise.allSettled(tasks);
      const newPatternKeyT = prev?.lastPatternKey;
      stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: now, lastAlertSignal: levels.signal, lastPatternKey: newPatternKeyT });
      persistAlertEntry(k, levels.signal as SignalKind, now);
      return;
    }

    if (transitioned && alreadyInSameDirection) {
      logger.info(
        {
          symbolKey,
          timeframe,
          from: prev?.signal ?? "(seed)",
          to: levels.signal,
          activeEntry: activeTradeBeforeCompute?.entryPrice,
          activeOpenedAt: activeTradeBeforeCompute?.openedAt,
        },
        "Trending signal alert suppressed (already in active trade same direction)",
      );
    }

    // Cancel any tracked TP orders when a trending coin's signal returns to WAIT.
    if (levels.signal === "WAIT" && prev?.signal !== "WAIT" && isPhemexTradingEnabled()) {
      const openOrder = openPhemexOrders.get(k);
      if (openOrder) {
        const cancelTasks: Promise<void>[] = [
          cancelOrder(openOrder.phemexSymbol, openOrder.orderId, openOrder.posSide),
        ];
        if (openOrder.tp1OrderId) cancelTasks.push(cancelOrder(openOrder.phemexSymbol, openOrder.tp1OrderId, openOrder.posSide));
        if (openOrder.tp2OrderId) cancelTasks.push(cancelOrder(openOrder.phemexSymbol, openOrder.tp2OrderId, openOrder.posSide));
        void Promise.allSettled(cancelTasks).then(() => {
          openPhemexOrders.delete(k);
        });
      }
    }

    stateMap.set(k, {
      ...(prev ?? {}),
      signal: levels.signal,
      lastAlertAt: prev?.lastAlertAt ?? 0,
      lastAlertSignal: prev?.lastAlertSignal,
      lastPatternKey: levels.signal === "WAIT" ? undefined : prev?.lastPatternKey,
    });

    // TP1 fill detection for trending coins — same logic as checkSymbol.
    const tp1CheckOrderT = openPhemexOrders.get(k);
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      tp1CheckOrderT?.fullQty !== undefined &&
      !tp1CheckOrderT.tp1Filled
    ) {
      try {
        const pos = await checkExistingPosition(tp1CheckOrderT.phemexSymbol, tp1CheckOrderT.posSide!);
        if (pos && pos.size < tp1CheckOrderT.fullQty * 0.75) {
          await cancelExistingStopOrders(tp1CheckOrderT.phemexSymbol, tp1CheckOrderT.posSide!);
          await placeStopOrder({
            phemexSymbol: tp1CheckOrderT.phemexSymbol,
            posSide:      tp1CheckOrderT.posSide!,
            stopPx:       tp1CheckOrderT.entryPx!,
            qtyRq:        (tp1CheckOrderT.fullQty / 2).toFixed(tp1CheckOrderT.qtyDecimals ?? 0),
            pxDecimals:   tp1CheckOrderT.pxDecimals ?? 2,
          });
          openPhemexOrders.set(k, { ...tp1CheckOrderT, tp1Filled: true });
          logger.info(
            { symbolKey, timeframe, entryPx: tp1CheckOrderT.entryPx, fullQty: tp1CheckOrderT.fullQty, posSize: pos.size },
            "phemex-trader: trending TP1 filled — SL moved to breakeven",
          );
        }
      } catch (err) {
        logger.warn({ err, symbolKey, timeframe }, "phemex-trader: trending TP1 fill check failed — skipping BE move");
      }
    }

    // Catch-up auto-trade for trending coins: if the auto-trader is on, the
    // signal is PENDING, and no order is tracked, place one now. Covers the
    // case where the trader was enabled (or the server restarted) while a
    // signal was already live — the transition block above was skipped because
    // there was no state change.
    const lastFailedT = failedOrderAt.get(k) ?? 0;
    const recentlyFailedT = Date.now() - lastFailedT < FAILED_ORDER_RETRY_MS;
    // TP retry: same as checkSymbol — if the tracker exists but TPs were never
    // placed (limit entry filled after initial TP attempt), clear the stale
    // tracker so the catch-up block below can reinitialize TPs this poll cycle.
    {
      const t = openPhemexOrders.get(k);
      if (t && t.tp1Filled === false && !t.tp1OrderId && !t.tp2OrderId) {
        logger.info({ symbolKey, timeframe }, "phemex-trader: trending tracked order missing TPs — clearing stale tracker for TP retry");
        openPhemexOrders.delete(k);
      }
    }
    // DOUBLE_TOP, DOUBLE_BOTTOM, and PATTERN_BREAKOUT are excluded from fresh
    // catch-up re-entry: their entries are pinned to a specific price level at
    // signal time. If price has already moved away (e.g. TAO shorted at the
    // bottom after falling from the pattern high), a catch-up re-enters at a
    // worse price with the same SL — near-zero reward or loss on entry.
    // EXCEPTION: FILLED_PROFIT means a position is already open. We only need
    // to restore TP orders — skip the type gate entirely in that case.
    const trendingCatchUpTypeAllowed =
      levels.signalType === "FIB50_SWING" || levels.tradeState === "FILLED_PROFIT";
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      (levels.tradeState === "PENDING" || levels.tradeState === "FILLED_PROFIT") &&
      trendingCatchUpTypeAllowed &&
      isPhemexTradingEnabled() &&
      phemexAutoTraderEnabled &&
      tMeta.phemexPerp &&
      !openPhemexOrders.has(k) &&
      !recentlyFailedT
    ) {
      logger.info({ symbolKey, timeframe, signal: levels.signal, signalType: levels.signalType, tradeState: levels.tradeState }, "phemex-trader: trending catch-up order — no tracked order for active signal");
      void executePhemexTrade(symbolKey, timeframe, levels, tMeta.phemexPerp, {
        decimals: tMeta.decimals,
        phemexQtyStep: tMeta.phemexQtyStep,
        phemexMinQty: tMeta.phemexMinQty,
      }, undefined, true);
    }
  } catch (err) {
    logger.warn({ err, symbolKey, timeframe }, "Trending notifier check failed");
  }
}

async function tick(): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const symbol of ALL_SYMBOLS) {
    for (const tf of TRACKED_TIMEFRAMES) {
      tasks.push(checkSymbol(symbol, tf));
    }
  }
  // Trending coins ARE checked — but only DAGGER signals on them will alert
  // (the guard inside checkTrendingSymbol enforces this). PIVOT_BOUNCE and
  // BREAKOUT on trending coins produced 0% WR in production; DAGGER is
  // signal-type agnostic and can fire on any instrument with the right structure.
  try {
    const { getTrendingSymbols } = await import("./trending-discovery");
    for (const t of getTrendingSymbols()) {
      for (const tf of TRACKED_TIMEFRAMES) {
        tasks.push(checkTrendingSymbol(t.symbolKey, tf));
      }
    }
  } catch {
    // trending-discovery not yet loaded — skip
  }
  await Promise.allSettled(tasks);
}

// Called by signals.ts (via the registered callback) when a trade closes.
// Manages both the alert cooldown and the consecutive-SL circuit-breaker streak.
//
//   SL outcome:
//     • Increments the same-direction SL streak (direction flip resets to 1).
//     • Stamps lastAlertAt = now so the candle-period floor is enforced before
//       the next same-direction alert — prevents 0ms re-entry on rapid whipsaws.
//     • Sets lastAlertSignal to the SL direction so the direction-aware cooldown
//       check (prev.lastAlertSignal === levels.signal) kicks in correctly.
//     • Direction flips still bypass the cooldown because lastAlertSignal ≠ new signal.
//
//   BE_TRAIL / TP2 outcome:
//     • Resets the SL streak to 0 — the system performed well.
//     • Clears lastAlertAt so the next setup fires immediately.
function onTradeClosed(
  symbolKey: string,
  timeframe: Timeframe,
  outcome: ClosedOutcome,
  signal: "BUY" | "SELL",
): void {
  const k = key(symbolKey, timeframe);
  const existing = stateMap.get(k);

  if (outcome === "SL") {
    const prevStreak = existing?.consecutiveSls ?? 0;
    const sameDirStreak = existing?.lastSlSignal === signal;
    const consecutiveSls = sameDirStreak ? prevStreak + 1 : 1;
    logger.info(
      { symbolKey, timeframe, signal, consecutiveSls, prevStreak },
      "Trade SL — circuit breaker streak updated",
    );
    stateMap.set(k, {
      ...(existing ?? { signal: "WAIT" as SignalKind }),
      lastAlertAt: Date.now(),
      lastAlertSignal: signal,
      consecutiveSls,
      lastSlSignal: signal,
    });
  } else if (outcome === "TP1") {
    // TP1 milestone: trade is still open (stop trailed to BE), but a partial
    // win has been secured. Reset the SL streak so a subsequent SL or BE_TRAIL
    // doesn't accumulate on top of pre-TP1 losses. Cooldown is intentionally
    // left untouched — the trade is still active and no alert needs to re-fire.
    const prevStreak = existing?.consecutiveSls ?? 0;
    if (prevStreak > 0) {
      logger.info(
        { symbolKey, timeframe, signal, prevStreak },
        "TP1 milestone — SL streak reset (trade still open)",
      );
    }
    stateMap.set(k, {
      ...(existing ?? { signal: "WAIT" as SignalKind, lastAlertAt: 0 }),
      consecutiveSls: 0,
      lastSlSignal: undefined,
      // lastAlertAt and lastAlertSignal are preserved via spread — trade still open.
    });
  } else {
    // TP2, BE_TRAIL — reset streak and clear cooldown (trade fully closed)
    const prevStreak = existing?.consecutiveSls ?? 0;
    if (prevStreak > 0) {
      logger.info(
        { symbolKey, timeframe, outcome, prevStreak },
        "Trade closed positively — SL streak reset",
      );
    }
    stateMap.set(k, {
      ...(existing ?? { signal: "WAIT" as SignalKind }),
      lastAlertAt: 0,
      lastAlertSignal: undefined,
      consecutiveSls: 0,
      lastSlSignal: undefined,
    });
    persistAlertEntry(k, "WAIT", 0);
  }
}

let started = false;

/**
 * Scans all open Phemex positions 30s after startup and alerts on any that
 * are not tracked by the auto-trader (not in openPhemexOrders, not a static
 * symbol, not currently in the trending cache).
 *
 * Why positions go orphaned:
 *  1. Trending TTL expires (8h) → DB row deleted → coin dropped from cache
 *  2. Server restart loads only non-expired rows → coin absent from poll loop
 *  3. The `if (!tMeta) return` guard in checkTrendingSymbol silently stops it
 *  4. Any active_trades record persists but is never polled → position unmanaged
 *
 * Static symbols and active trending coins are excluded — their own catch-up
 * blocks restore TPs on the first tick. This function only fires on true orphans.
 */
async function detectOrphanedPositions(): Promise<void> {
  if (!isPhemexTradingEnabled()) return;
  try {
    const { getTrendingSymbols } = await import("./trending-discovery");
    const positions = await getAllOpenPhemexPositions();
    if (!positions.length) return;

    const trendingCache = getTrendingSymbols();

    for (const { phemexSymbol, posSide, size, entryPrice } of positions) {
      // Already tracked — catch-up block handled it
      const alreadyTracked = [...openPhemexOrders.values()].some(
        o => o.phemexSymbol === phemexSymbol && o.posSide === posSide,
      );
      if (alreadyTracked) continue;

      // Static symbol — the static symbol catch-up block restores TPs
      const isStatic = Object.values(SYMBOLS).some(m => m.phemexPerp === phemexSymbol);
      if (isStatic) continue;

      // Currently-trending symbol — the trending catch-up block restores TPs
      const isTrending = trendingCache.some(t => t.phemexPerp === phemexSymbol);
      if (isTrending) continue;

      // True orphan — attempt auto-TP restoration from stored signal data.
      logger.warn(
        { phemexSymbol, posSide, size, entryPrice },
        "phemex-trader: ORPHANED POSITION — not tracked by auto-trader, attempting TP restoration",
      );

      // Search all tracked timeframes for a stored signal with valid TPs.
      // For trending coins symbolKey === phemexSymbol; this covers both.
      let restoredTf: Timeframe | null = null;
      let storedTp1 = 0;
      let storedTp2 = 0;
      let tp1WasHit = false;
      for (const tf of TRACKED_TIMEFRAMES) {
        const trade = getActiveTrade(phemexSymbol, tf);
        if (!trade) continue;
        const expectedSignal = posSide === "Short" ? "SELL" : "BUY";
        if (trade.signal !== expectedSignal) continue;
        if (trade.takeProfit1 > 0) {
          restoredTf = tf;
          storedTp1  = trade.takeProfit1;
          storedTp2  = trade.takeProfit2;
          tp1WasHit  = trade.tp1Hit;
          break;
        }
      }

      const posSideFmt = posSide === "Long" ? "LONG 📈" : "SHORT 📉";
      const entryStr   = entryPrice > 0 ? entryPrice.toFixed(4) : "unknown";

      if (restoredTf && storedTp1 > 0) {
        try {
          await cancelExistingTpOrders(phemexSymbol, posSide);

          const halfQty = (size / 2).toFixed(4);
          const now     = Date.now();
          const tp1Id   = tp1WasHit ? null : await placeLimitClose({
            phemexSymbol,
            posSide,
            priceRp: storedTp1.toFixed(6),
            qtyRq:   halfQty,
            clOrdID: `phx-tp1-orphan-${phemexSymbol}-${now}`,
          });
          const tp2Id = storedTp2 > 0 ? await placeLimitClose({
            phemexSymbol,
            posSide,
            priceRp: storedTp2.toFixed(6),
            qtyRq:   halfQty,
            clOrdID: `phx-tp2-orphan-${phemexSymbol}-${now}`,
          }) : null;

          // Register in tracker so subsequent polls see this as managed.
          const k = key(phemexSymbol, restoredTf);
          openPhemexOrders.set(k, {
            orderId:    tp1Id ?? tp2Id ?? `orphan-restored-${now}`,
            phemexSymbol,
            posSide,
            fullQty:    size,
            entryPx:    entryPrice,
            tp1OrderId: tp1Id ?? undefined,
            tp2OrderId: tp2Id ?? undefined,
            tp1Filled:  tp1WasHit,
          });

          const msg =
            `✅ <b>ORPHANED POSITION — TPs AUTO-RESTORED</b>\n\n` +
            `<b>${phemexSymbol} ${posSideFmt}</b>\n` +
            `Size: ${size}  |  Entry: ${entryStr}\n` +
            (tp1WasHit ? `` : `TP1: ${storedTp1.toFixed(6)}\n`) +
            (storedTp2 > 0 ? `TP2: ${storedTp2.toFixed(6)}\n` : ``) +
            `\n<i>Signal data recovered from ${restoredTf} timeframe. Position is now tracked.</i>`;

          logger.info(
            { phemexSymbol, posSide, size, storedTp1, storedTp2, restoredTf },
            "phemex-trader: orphaned position TPs auto-restored",
          );
          if (isTelegramEnabled()) void sendTelegramMessage(msg);
        } catch (placeErr) {
          logger.warn({ placeErr, phemexSymbol }, "phemex-trader: orphan TP placement failed");
          const msg =
            `⚠️ <b>ORPHANED POSITION — TP PLACEMENT FAILED</b>\n\n` +
            `<b>${phemexSymbol} ${posSideFmt}</b>\n` +
            `Size: ${size}  |  Entry: ${entryStr}\n\n` +
            `<i>Auto-TP placement failed. Set TPs manually on Phemex.</i>`;
          if (isTelegramEnabled()) void sendTelegramMessage(msg);
        }
      } else {
        // No stored signal data — nothing to compute TPs from.
        const msg =
          `⚠️ <b>ORPHANED POSITION — NO SIGNAL DATA</b>\n\n` +
          `<b>${phemexSymbol} ${posSideFmt}</b>\n` +
          `Size: ${size}  |  Entry: ${entryStr}\n\n` +
          `<i>Signal data fully expired — no TP levels available.\nSet TPs/SL manually on Phemex.</i>`;

        logger.warn(
          { phemexSymbol, posSide, size },
          "phemex-trader: orphaned position — no signal data, cannot auto-set TPs",
        );
        if (isTelegramEnabled()) void sendTelegramMessage(msg);
      }
    }
  } catch (err) {
    logger.warn({ err }, "phemex-trader: detectOrphanedPositions failed");
  }
}

export function startSignalNotifier(): void {
  if (started) return;
  const telegramOn = isTelegramEnabled();
  const webPushOn = isWebPushEnabled();
  if (!telegramOn && !webPushOn) {
    logger.info(
      { telegramOn, webPushOn },
      "Signal notifier disabled (no channels enabled)",
    );
    return;
  }
  started = true;

  // Pre-fetch Phemex contract specs (minPriceRp per symbol) so placeOrder can
  // clamp prices for symbols whose market price is below the exchange floor.
  if (isPhemexTradingEnabled()) {
    void fetchContractSpecs();
    // After the first tick has had time to populate openPhemexOrders (30s),
    // scan for any Phemex positions that no catch-up path handled — true orphans
    // whose tracking expired while the position was still open.
    setTimeout(() => void detectOrphanedPositions(), 30_000);
  }

  // Wire up the trade-close hook so signals.ts can notify us when a trade
  // closes without creating a circular import.
  registerOnTradeClosedCallback(onTradeClosed);

  // Pre-populate stateMap from disk so the direction-aware cooldown is intact
  // even on a fresh restart — prevents repeat seed alerts for still-pending signals.
  loadPersistedAlertState();

  const phemexOn = isPhemexTradingEnabled();
  logger.info(
    {
      symbols: ALL_SYMBOLS.length,
      timeframes: TRACKED_TIMEFRAMES,
      intervalMs: POLL_INTERVAL_MS,
      telegramOn,
      webPushOn,
      phemexOn,
      phemexAutoTraderOn: phemexOn && phemexAutoTraderEnabled,
    },
    "Signal notifier started",
  );
  void tick();
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
