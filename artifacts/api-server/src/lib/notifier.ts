import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "./logger";
import { SYMBOLS, makeRounder, type Symbol, type SymbolMeta, ALL_SYMBOLS } from "./symbols";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
} from "./yahoo-fetch";
import { computeLevelsStable, fetchSpotPrice, getActiveTrade, clearActiveTrade, markTradeTriggered, applyFuturesBasis, registerOnTradeClosedCallback, calcMACDHist, computePositionSizing, DEFAULT_ACCOUNT_SIZE, DEFAULT_RISK_PCT, DEFAULT_MIN_COLLATERAL, DEFAULT_MAX_LEVERAGE, DEFAULT_MT5_LOTS, setPhemexOrderPlaced, logClosedTrade, findActiveTradesByPhemexSymbol, getPhemexTradedSymbols, getAllActiveTradeSymbols, type ClosedOutcome } from "./signals";
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
  marketClosePosition,
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
const TRACKED_TIMEFRAMES: Timeframe[] = ["1h", "4h", "1d"];
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
  placedAt?:    number;    // Date.now() when the entry limit was first placed/detected
  // Split-TP tracking (set for every auto-traded order)
  fullQty?:     number;    // full position qty at entry
  entryPx?:     number;    // actual entry price (anchored for Market IOC)
  pxDecimals?:  number;
  qtyDecimals?: number;
  tp1OrderId?:  string;    // reduce-only limit at TP1 (half qty)
  tp2OrderId?:  string;    // reduce-only limit at TP2 (half qty)
  tp1Filled?:   boolean;   // true once TP1 fills and SL has been moved to BE
  tp1Price?:    number;    // TP1 price, used for partial-profit BE trigger
  beMoved?:     boolean;   // true once SL has been moved to breakeven (partial-profit trigger)
}

// How long an unfilled entry limit may sit before it is considered stale and
// cancelled so the next poll can re-enter at the current price.
// Threshold = 1 × the candle period for the timeframe.
const TF_STALE_MS: Record<string, number> = {
  "1h":     60 * 60_000,   // 1 hour
  "4h":    240 * 60_000,   // 4 hours
  "1d":   1440 * 60_000,   // 1 day
  "1w":  10080 * 60_000,   // 1 week
};
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

  // Per-signal-type auto-trade gate. PHEMEX_AUTOTRADER_SIGNAL_TYPES overrides
  // the default allowlist. Unset = use the hardcoded default below.
  // Alerts still fire for blocked types — only Phemex order placement is suppressed.
  const DEFAULT_ALLOWED_SIGNAL_TYPES = "FIB50_SWING,BB_REJECTION,DOUBLE_BOTTOM,DOUBLE_TOP,BB_BREAKOUT,MACD_DIP_LONG";
  const allowedSignalTypes = (process.env.PHEMEX_AUTOTRADER_SIGNAL_TYPES ?? "").trim() || DEFAULT_ALLOWED_SIGNAL_TYPES;
  const allowed = allowedSignalTypes.split(",").map(s => s.trim()).filter(Boolean);
  if (levels.signalType && !allowed.includes(levels.signalType)) {
    logger.info(
      { symbol, timeframe, signalType: levels.signalType, allowedSignalTypes },
      "phemex-trader: auto-trade skipped — signal type not in allowlist",
    );
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
  let existingPos: { size: number; stopLossRp: number; markPrice: number } | null;
  try {
    existingPos = await checkExistingPosition(phemexSymbol, posSideForCheck);
  } catch {
    // API failure: safest default is to skip rather than risk doubling exposure.
    logger.warn({ symbol, timeframe, phemexSymbol }, "phemex-trader: checkExistingPosition threw — skipping order (safe default)");
    return;
  }
  if (existingPos !== null) {
    const { size: existingSize, stopLossRp: existingSlPrice, markPrice: existingMarkPrice } = existingPos;
    logger.info(
      { symbol, timeframe, phemexSymbol, side, existingSize, existingSlPrice, existingMarkPrice },
      "phemex-trader: position already exists on Phemex — registering in tracker, skipping new order",
    );
    // If Phemex shows no SL on this position (stopLossRp === 0), the bracket
    // was silently dropped or the position predates bracket support. Place a
    // stop-market reduce-only order now to protect it.
    if (existingSlPrice === 0) {
      const storedSl = levels.stopLoss;
      // Safety gate: if the stored SL is within 3% of current mark price, the
      // position has moved into the SL zone since the signal was recorded.
      // Placing it now would cause an immediate or near-immediate stopout.
      // Skip and log — manual intervention required.
      const slDistancePct = existingMarkPrice > 0
        ? Math.abs(existingMarkPrice - storedSl) / existingMarkPrice
        : 1;
      if (slDistancePct < 0.03) {
        logger.warn(
          { symbol, timeframe, phemexSymbol, storedSl, existingMarkPrice, slDistancePct: slDistancePct.toFixed(4) },
          "phemex-trader: skipping restart SL — stored SL is within 3% of current mark price (would cause immediate stopout)",
        );
      } else {
        logger.warn(
          { symbol, timeframe, phemexSymbol, slPrice: storedSl, existingMarkPrice, slDistancePct: slDistancePct.toFixed(4) },
          "phemex-trader: existing position has no SL — placing stop-market order",
        );
        // Cancel any stale SL stop orders from prior restarts before placing a
        // fresh one. Without this, every restart stacks another stop-market.
        await cancelExistingStopOrders(phemexSymbol, posSideForCheck);
        await placeStopOrder({
          phemexSymbol,
          posSide:    posSideForCheck,
          stopPx:     storedSl,
          qtyRq:      existingSize.toFixed(qtyDecimals),
          pxDecimals,
        });
      }
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
    // beMoved: if TP1 already hit the runner is protected at BE by the TP1 fill
    // path (which also moves SL). If TP1 hasn't hit yet we don't know whether
    // the 40% BE move already fired in a prior session, but setting beMoved=false
    // is the safe default — worst case we re-move SL to an already-correct BE
    // level, which is a no-op in terms of risk.
    openPhemexOrders.set(k, {
      orderId:    `pre-existing-${entryTs}`,
      phemexSymbol,
      posSide:    posSideForCheck,
      fullQty:    tp1AlreadyHit ? existingSize * 2 : existingSize,
      entryPx:    levels.entryPrice,
      tp1Price:   levels.takeProfit1,
      pxDecimals,
      qtyDecimals,
      tp1OrderId: tp1OrderId ?? undefined,
      tp2OrderId: tp2OrderId ?? undefined,
      tp1Filled:  tp1AlreadyHit,
      beMoved:    tp1AlreadyHit,
    });
    logger.info(
      { symbol, timeframe, phemexSymbol, existingSize, tp1AlreadyHit,
        tp1: levels.takeProfit1, tp2: levels.takeProfit2, tp1OrderId, tp2OrderId },
      "phemex-trader: existing position — split-TP orders restored",
    );
    // Mark the trade as triggered so classifyTradeState returns a FILLED_*
    // state instead of PENDING. Without this, a position that predates
    // triggered=true (or whose flag was wiped) would stay invisible in the
    // "filled positions" UI column after every restart.
    markTradeTriggered(symbol, timeframe);
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
    // BB_WALK is exempt: TP1 = BB upper + ATR intentionally projects above recent candle
    // history (that's the whole point — buying into a breakout extension).
    if (levels.signal === "BUY" && levels.takeProfit1 > candleRange.high && levels.signalType !== "BB_WALK") {
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
  // Applies to most signal types: PATTERN_BREAKOUT, FIB50_SWING, etc.
  // BB_WALK is exempt: it intentionally enters when price is extended above EMA20
  // (the whole point is to buy trend continuation at the upper BB).
  // If ema20 could not be computed (too few candles), skip the guard rather than
  // silently passing — treat it as a rejection to avoid blindly entering extended moves.
  if (candleRange !== undefined && levels.signalType !== "BB_WALK") {
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

  // Risk-based sizing: dollar loss at SL = accountSize × riskPct.
  // This guarantees the maximum loss is predictable regardless of SL distance.
  //   dollarRisk = accountSize × riskPct   (e.g. $1,561 × 4% = $62.44)
  //   slDistance = |entryPrice - stopLoss|
  //   qty        = dollarRisk / slDistance
  const dollarRisk = accountSize * phemexRiskPct();
  const slDistance = Math.abs(levels.entryPrice - levels.stopLoss);
  const rawQty = slDistance > 0 ? dollarRisk / slDistance : 0;
  logger.info(
    { symbol, timeframe, accountSize, riskPct: phemexRiskPct(), dollarRisk, slDistance, rawQty },
    "phemex-trader: risk-based sizing",
  );
  if (!rawQty || rawQty <= 0) {
    logger.warn({ symbol, timeframe, sizing }, "phemex-trader: zero qty — skipping order");
    return;
  }

  // SWING_BREAK is ALWAYS excluded from catch-up regardless of tradeState.
  // Its entry is pinned to a specific breakout price level — if the server
  // restarts after that candle has closed, re-entering at the old level is
  // stale and wrong. Let the next genuine signal transition handle re-entry.
  if (isCatchUp && levels.signalType === "SWING_BREAK") {
    logger.info(
      { symbol, timeframe, signalType: levels.signalType, tradeState: levels.tradeState },
      "phemex-trader: catch-up skipped — SWING_BREAK entries are breakout-level-pinned, not zone-based",
    );
    if (!openPhemexOrders.has(k)) {
      openPhemexOrders.set(k, { orderId: `no-catchup-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
    }
    return;
  }

  // Non-zone-based catch-up guard: no position exists and the signal is
  // price-pinned (DOUBLE_TOP, DOUBLE_BOTTOM, BB_REJECTION, PATTERN_BREAKOUT).
  // Re-entering at current price with the original SL is dangerous — skip and
  // register a sentinel so the catch-up block stops retrying.
  // FIB50_SWING and DUMP_RECOVERY use zone-based entries that tolerate catch-up
  // re-entry (they enter at currentPrice near a structural extreme, not a
  // time-pinned price level).
  // EXCEPTION: FILLED_PROFIT / FILLED_DRAWDOWN both mean the entry already
  // happened — the position is open. We only need to restore TP orders, not
  // place a new entry. Let both fall through to checkExistingPosition.
  if (isCatchUp && levels.signalType !== "FIB50_SWING" && levels.signalType !== "DUMP_RECOVERY" && levels.tradeState !== "FILLED_PROFIT" && levels.tradeState !== "FILLED_DRAWDOWN") {
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
  // IMPORTANT: only apply this guard when tradeState is FILLED_PROFIT. That
  // state means a position actually existed (TP1 hit) and was subsequently
  // closed — which is a genuine externally-closed scenario. For PENDING state
  // the entry limit was never filled (stale-cancelled or missed) — blocking
  // catch-up there prevents the system from ever placing any order after a
  // restart, which is the wrong behaviour. Let PENDING fall through so the
  // limit order is re-placed.
  //
  // Fresh transitions (isCatchUp=false) are NOT blocked here: a stale DB record
  // from a previous deployment must not prevent a newly-formed signal from
  // firing. The alreadyInSameDirection guard in checkSymbol handles the case
  // where the signal hasn't changed direction.
  if (isCatchUp && levels.tradeState === "FILLED_PROFIT") {
    const existingActiveTrade = getActiveTrade(symbol, timeframe);
    if (existingActiveTrade) {
      // Only treat as potentially externally-closed if the auto-trader actually
      // placed an order for this record (phemexOrderPlaced=true). Records without
      // this flag are pure signal-tracking entries that were never on Phemex
      // (e.g. loaded from the JSON file before auto-trading was enabled, or from
      // a prior session where the signal fired but no order was placed). For those,
      // clear the record and fall through to place a fresh order.
      if (!existingActiveTrade.phemexOrderPlaced) {
        logger.info(
          { symbol, timeframe, signal: levels.signal, signalType: levels.signalType },
          "phemex-trader: FILLED_PROFIT record never on Phemex (no phemexOrderPlaced flag) — clearing for fresh entry",
        );
        clearActiveTrade(symbol, timeframe);
        // Fall through — order placement proceeds as a fresh entry.
      } else {
      // If the stored record is older than 3 candle periods for this timeframe the
      // trade closed long ago and the current signal is an entirely new setup.
      // Clear the stale record and fall through to place a fresh order.
      // If the record is recent (< 3 candles old), treat as a genuine externally-
      // closed position (user manually closed mid-trade) and suppress re-entry.
      const recordAgeMs = Date.now() - (existingActiveTrade.openedAt ?? 0);
      const isStaleRecord = recordAgeMs > 3 * CANDLE_PERIOD_MS[timeframe];

      // Also treat as a new setup if the signal's entry price has moved more
      // than 2% from the stored record. A coin up 10% on the day forms a new
      // BB_BREAKOUT at a completely different price — blocking it because the
      // previous attempt was 36 minutes ago is wrong.
      const storedEntry  = existingActiveTrade.entryPrice ?? 0;
      const currentEntry = levels.entryPrice ?? 0;
      const entryMovedPct = storedEntry > 0 ? Math.abs(currentEntry - storedEntry) / storedEntry : 0;
      const isNewSetup = entryMovedPct > 0.02; // >2% price move = new setup

      if (isStaleRecord || isNewSetup) {
        logger.info(
          { symbol, timeframe, recordAgeDays: (recordAgeMs / 86_400_000).toFixed(1), openedAt: existingActiveTrade.openedAt, entryMovedPct: entryMovedPct.toFixed(3) },
          "phemex-trader: FILLED_PROFIT record cleared — stale or new price level, allowing fresh re-entry",
        );
        clearActiveTrade(symbol, timeframe);
        // Fall through — order placement proceeds as a fresh entry.
      } else {
        logger.warn(
          { symbol, timeframe, phemexSymbol, signal: levels.signal },
          "phemex-trader: catch-up skipped — DB record exists but no Phemex position (externally closed or stale)",
        );
        if (!openPhemexOrders.has(k)) {
          openPhemexOrders.set(k, { orderId: `externally-closed-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
        }
        return;
      }
      } // end else (phemexOrderPlaced === true)
    }
  }

  // Prevent self-hedging: if an opposite-side position already exists for this
  // symbol (opened by a conflicting timeframe signal), skip rather than creating
  // a simultaneous Long+Short on the same asset.
  //
  // Check the in-memory tracker FIRST — it's instantaneous and catches races
  // where two timeframe signals fire in the same poll cycle before either has
  // landed on Phemex (so the API-based check would see nothing and let both through).
  const oppositeSideForCheck: "Long" | "Short" = posSideForCheck === "Long" ? "Short" : "Long";
  const trackedOpposite = [...openPhemexOrders.values()].find(
    o => o.phemexSymbol === phemexSymbol && o.posSide === oppositeSideForCheck,
  );
  if (trackedOpposite) {
    logger.warn(
      { symbol, timeframe, phemexSymbol, signal: levels.signal, oppositeSide: oppositeSideForCheck, trackedOrderId: trackedOpposite.orderId },
      "phemex-trader: opposite-side tracked order exists in-memory — skipping to avoid self-hedge",
    );
    if (!openPhemexOrders.has(k)) {
      openPhemexOrders.set(k, { orderId: `opposite-blocked-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
    }
    return;
  }

  // Also check Phemex directly — catches positions that survived a restart and
  // weren't yet re-registered in openPhemexOrders (e.g. during catch-up window).
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
      "phemex-trader: opposite-side position already open on Phemex — skipping to avoid self-hedge",
    );
    if (!openPhemexOrders.has(k)) {
      openPhemexOrders.set(k, { orderId: `opposite-blocked-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
    }
    return;
  }

  // Cross-TF veto: don't short a coin that has an active triggered BUY on a
  // higher timeframe, and don't long a coin with an active triggered SELL on a
  // higher TF. Prevents entering against the established higher-TF trend —
  // e.g. the system shorting into weekly support while a weekly BUY is live.
  const TF_ORDER_HTF = ["1h", "4h", "1d", "1w"] as const;
  const currentTfRank = TF_ORDER_HTF.indexOf(timeframe as typeof TF_ORDER_HTF[number]);
  if (currentTfRank !== -1) {
    const oppositePosSideHTF: "Long" | "Short" = levels.signal === "BUY" ? "Short" : "Long";
    // Only veto for weekly (1w) conflicts. Every signal already has a daily
    // MACD gate (higherTfAllowsBuy/Sell) that covers 1d alignment — adding a
    // 1d veto here causes double-gating and blocks valid entries when a stale
    // triggered 1d trade exists but the daily MACD has since reversed.
    // 4h vs 1h disagreement is also normal multi-TF behaviour, so 4h is excluded too.
    const minVetoRank = TF_ORDER_HTF.indexOf("1w");
    const htfConflict = findActiveTradesByPhemexSymbol(phemexSymbol, oppositePosSideHTF)
      .find(({ timeframe: tf, trade }) => {
        if (!trade.triggered) return false;
        const rank = TF_ORDER_HTF.indexOf(tf as typeof TF_ORDER_HTF[number]);
        return rank > currentTfRank && rank >= minVetoRank;
      });
    if (htfConflict) {
      logger.warn(
        { symbol, timeframe, phemexSymbol, signal: levels.signal,
          htfTimeframe: htfConflict.timeframe, htfSignalType: htfConflict.trade.signalType },
        "phemex-trader: higher-TF conflict — opposite triggered trade on HTF, skipping to avoid fighting the trend",
      );
      if (!openPhemexOrders.has(k)) {
        openPhemexOrders.set(k, { orderId: `htf-conflict-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
      }
      return;
    }
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
    // Carry forward placedAt from the first time we saw this order so per-poll
    // stale checks (in checkSymbol/checkTrendingSymbol) use the original
    // placement time, not Date.now() on each restart. Stale-cancel is handled
    // per-poll, not here, to avoid only running on catch-up triggers.
    const prevEntry = openPhemexOrders.get(k);
    const placedAt  = prevEntry?.placedAt ?? Date.now();
    logger.info(
      { symbol, timeframe, phemexSymbol, side, existingOrderId, ageMs: Date.now() - placedAt },
      "phemex-trader: pending order already exists on Phemex — registering in tracker, skipping new order",
    );
    openPhemexOrders.set(k, { ...(prevEntry ?? {}), orderId: existingOrderId, phemexSymbol, posSide: posSideForCheck, placedAt });
    return;
  }

  // When a signal's entry price is below Phemex's minPriceRp floor, the limit
  // order is clamped to minPriceRp and fills immediately at market (current
  // ask for BUY, current bid for SELL). The signal's SL/TP are calculated
  // relative to the original fib/band entry, so they are completely wrong at
  // the actual fill price. Re-anchor SL and TPs to currentPrice, preserving
  // the designed R:R (risk/reward distances in $ terms).
  //
  //  BUY re-anchor:  new_SL  = currentPrice - (entryPrice - stopLoss)
  //                  new_TP  = currentPrice + (takeProfit1 - entryPrice)
  //  SELL re-anchor: new_SL  = currentPrice + (stopLoss - entryPrice)
  //                  new_TP  = currentPrice - (entryPrice - takeProfit1)
  const minPx  = getMinPriceRp(phemexSymbol);
  const ref    = levels.currentPrice ?? 0;
  const pct24h = levels.priceChangePct ?? 0;

  // Market IOC when:
  //  (a) Entry is below Phemex minPriceRp floor (order would be rejected), OR
  //  (b) Price has already run past the limit entry by >0.5% — a resting limit
  //      at the original fib/band level will never fill if price has blown through.
  //      Enter at market now and re-anchor SL/TP to current price preserving R:R.
  const priceRunPastEntryBuy  = side === "Buy"  && ref > levels.entryPrice * 1.005;
  const priceRunPastEntrySell = side === "Sell" && ref < levels.entryPrice * 0.995;
  const isMarketIocSell = side === "Sell" && (
    (minPx > 0 && levels.entryPrice < minPx) || priceRunPastEntrySell
  );
  const isMarketIocBuy = side === "Buy" && (
    (minPx > 0 && levels.entryPrice < minPx) || priceRunPastEntryBuy
  );
  let effectiveSL  = levels.stopLoss;
  let effectiveTP  = levels.takeProfit1;
  let effectiveTP2 = levels.takeProfit2;
  if (isMarketIocSell) {
    const reward  = levels.entryPrice - levels.takeProfit1;
    const reward2 = levels.entryPrice - levels.takeProfit2;
    const risk    = levels.stopLoss   - levels.entryPrice;
    effectiveTP   = ref - reward;
    effectiveTP2  = ref - reward2;
    effectiveSL   = ref + risk;
    logger.info(
      { symbol, phemexSymbol, signalEntry: levels.entryPrice, currentPrice: ref,
        origSL: levels.stopLoss, origTP: levels.takeProfit1,
        newSL: effectiveSL, newTP: effectiveTP, newTP2: effectiveTP2,
        reason: priceRunPastEntrySell ? "price-ran-past-entry" : "min-price-floor" },
      "phemex-trader: Market IOC SELL — SL/TP re-anchored to current price",
    );
  } else if (isMarketIocBuy) {
    // Only re-anchor to market if the coin is actually pumping:
    //  1. currentPrice > signalEntry — price broke above the fib/band entry
    //  2. priceChangePct > 0        — coin is positive on the day
    // If either fails, the fib entry hasn't been reached from above, or the
    // coin is declining — a market fill at a higher price makes no sense.
    const isPumping = ref > levels.entryPrice && pct24h > 0;
    if (!isPumping) {
      logger.warn(
        { symbol, phemexSymbol, signalEntry: levels.entryPrice, currentPrice: ref, priceChangePct: pct24h },
        "phemex-trader: Market IOC BUY skipped — coin not pumping (price not above fib entry or negative 24h)",
      );
      if (!openPhemexOrders.has(k)) {
        openPhemexOrders.set(k, { orderId: `market-ioc-skip-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
      }
      return;
    }
    const reward  = levels.takeProfit1 - levels.entryPrice;
    const reward2 = levels.takeProfit2 - levels.entryPrice;
    const risk    = levels.entryPrice  - levels.stopLoss;
    effectiveTP   = ref + reward;
    effectiveTP2  = ref + reward2;
    effectiveSL   = ref - risk;
    logger.info(
      { symbol, phemexSymbol, signalEntry: levels.entryPrice, currentPrice: ref, priceChangePct: pct24h,
        origSL: levels.stopLoss, origTP: levels.takeProfit1,
        newSL: effectiveSL, newTP: effectiveTP, newTP2: effectiveTP2,
        reason: priceRunPastEntryBuy ? "price-ran-past-entry" : "min-price-floor" },
      "phemex-trader: Market IOC BUY — SL/TP re-anchored to current price",
    );
  }

  // Sanity-check re-anchored prices BEFORE placing any order.
  // Two degenerate cases must be rejected:
  //
  //  1. Negative / zero TP — happens when a SELL signal's measured-move target
  //     was already deep below zero before re-anchoring (e.g. LAB TP2 = -0.95).
  //     Phemex rejects with "Invalid price".
  //
  //  2. SL beyond liquidation — with 25x leverage the liq distance is ~4%.
  //     A signal with a 40%+ SL (designed for a slow 1d move) re-anchored to a
  //     market-IOC fill results in SL > liq price; Phemex rejects with
  //     TE_SELL_SL_SHOULD_LT_LIQ / TE_BUY_SL_SHOULD_GT_LIQ.
  //     Guard: SL distance must be < 85% of the theoretical liq distance
  //     (1 / maxLeverage) to leave margin for funding and mark-price spread.
  if (isMarketIocSell || isMarketIocBuy) {
    const tpFloor = minPx > 0 ? minPx : 0;
    if (effectiveTP <= tpFloor || effectiveTP2 <= tpFloor) {
      logger.warn(
        { symbol, timeframe, effectiveTP, effectiveTP2, tpFloor },
        "phemex-trader: Market IOC skipped — re-anchored TP would be at or below price floor (degenerate R:R)",
      );
      if (!openPhemexOrders.has(k)) {
        openPhemexOrders.set(k, { orderId: `degenerate-rr-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
      }
      return;
    }
    const slDistanceFrac = ref > 0 ? Math.abs(effectiveSL - ref) / ref : 1;
    const maxSlFrac = 0.85 / Math.max(phemexMaxLeverage(), 1);
    if (slDistanceFrac > maxSlFrac) {
      logger.warn(
        { symbol, timeframe, effectiveSL, currentPrice: ref, slDistanceFrac: slDistanceFrac.toFixed(4), maxSlFrac: maxSlFrac.toFixed(4) },
        "phemex-trader: Market IOC skipped — re-anchored SL exceeds leverage-adjusted liquidation distance",
      );
      if (!openPhemexOrders.has(k)) {
        openPhemexOrders.set(k, { orderId: `sl-beyond-liq-${Date.now()}`, phemexSymbol, posSide: posSideForCheck });
      }
      return;
    }
  }

  // Set leverage on Phemex to match what the sizing math assumed.
  // Without this, Phemex uses whatever leverage is already on the account for
  // that symbol — which may be 1x (the default), causing the margin used to be
  // orders of magnitude larger than the intended 2% risk would suggest.
  await setSymbolLeverage(phemexSymbol, phemexMaxLeverage());

  const entryTs = Date.now();
  const isMarketIoc = isMarketIocSell || isMarketIocBuy;
  const orderId = await placeOrder({
    phemexSymbol,
    side,
    qtyRq:       rawQty.toFixed(qtyDecimals),
    priceRp:     (isMarketIoc ? ref : levels.entryPrice).toFixed(pxDecimals),
    stopLossRp:  effectiveSL.toFixed(pxDecimals),
    forceMarket: isMarketIoc,
    // No bracket TP — two reduce-only limit orders below handle TP1/TP2 separately.
    clOrdID:     `phx-${symbol}-${timeframe}-${entryTs}`,
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
      placedAt:   Date.now(),
      fullQty:    rawQty,
      entryPx:    actualEntryPx,
      tp1Price:   effectiveTP,
      pxDecimals,
      qtyDecimals,
      tp1OrderId: tp1OrderId ?? undefined,
      tp2OrderId: tp2OrderId ?? undefined,
      tp1Filled:  false,
      beMoved:    false,
    });
    // Stamp the flag so subsequent restarts know a real Phemex order existed
    // for this slot — enabling the externally-closed guard to work correctly.
    setPhemexOrderPlaced(symbol, timeframe);
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
  "1h": "4h",
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

    // For 4h: higherCandles are already daily candles (HIGHER_TIMEFRAME["4h"] = "1d").
    // Reuse them as dailyForWeekly so the 4h higher-TF MACD gate in computeLevels
    // receives real daily data. Without this fix, dailyCandlesForWeekly is undefined
    // for 4h → the `&& dailyCandlesForWeekly` guard in the gate never passes →
    // higherTfAllowsBuy/Sell stays true → every 4h signal fires with no daily check.
    const dailyForWeekly =
      timeframe === "4h" && higherCandles.length > 0 ? higherCandles :
      rawDailyForWeekly.length > 0 ? rawDailyForWeekly : undefined;
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

      // Hard type filter. Only FIB50_SWING, DUMP_RECOVERY, DOUBLE_TOP, DOUBLE_BOTTOM,
      // BB_REJECTION, and BB_WALK signals trigger notifications and Phemex auto-trades.
      // PATTERN_BREAKOUT is excluded — entries are time-sensitive and degrade rapidly
      // after the breakout bar. Filled trades bypass this: a fill notification is
      // always actionable regardless of what signal type originally opened the position.
      if (!isFilledTrade) {
        const signalTypeAllowed = levels.signalType === "FIB50_SWING" || levels.signalType === "DOUBLE_TOP" || levels.signalType === "DOUBLE_BOTTOM" || levels.signalType === "BB_REJECTION" || levels.signalType === "BB_WALK" || levels.signalType === "DUMP_RECOVERY" || levels.signalType === "BB_BREAKOUT" || levels.signalType === "BB_OVEREXTENSION" || levels.signalType === "SWING_BREAK" || levels.signalType === "MACD_DIP_LONG";
        if (!signalTypeAllowed) {
          logger.info(
            { symbol, timeframe, signalType: levels.signalType },
            "Signal alert suppressed (signal type not allowed for notifications)",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // 24h momentum gate (all symbols, fresh entries only).
      // Trend-following signals must trade with the daily flow: don't long red
      // coins or short green ones. Counter-trend signals are explicitly exempt —
      // BB_OVEREXTENSION, BB_REJECTION, DOUBLE_TOP, and DOUBLE_BOTTOM fire
      // BECAUSE the coin made a large move; a big 24h change is a requirement
      // for those setups, not a reason to block them.
      // Filled trades and direction flips are always exempt.
      const isTrendFollowing =
        levels.signalType === "FIB50_SWING" ||
        levels.signalType === "DUMP_RECOVERY" ||
        levels.signalType === "BB_BREAKOUT" ||
        levels.signalType === "BB_WALK";
      if (!isFilledTrade && !isDirectionFlip && isTrendFollowing && (levels.signal === "BUY" || levels.signal === "SELL")) {
        const pct24h = levels.priceChangePct ?? 0;
        const momentumOk =
          (levels.signal === "BUY" && pct24h > 0) ||
          (levels.signal === "SELL" && pct24h < 0);
        if (!momentumOk) {
          logger.info(
            { symbol, timeframe, signal: levels.signal, signalType: levels.signalType, priceChangePct: pct24h },
            "Signal suppressed — 24h momentum opposes trend-following signal direction",
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

      // BB_REJECTION SELL conflict guard: suppress even on direction flips when
      // the daily is actively BUY. The higher-TF gate above exempts direction
      // flips (1h BUY→SELL), but a mean-reversion short against a confirmed
      // daily bullish setup is almost always wrong — UNI-type scenario where
      // a 1h BB_REJECTION fires into a daily bullish triangle breakout.
      if (
        !isFilledTrade &&
        levels.signalType === "BB_REJECTION" &&
        levels.signal === "SELL" &&
        higherTf === "1d" &&
        higherCandles.length >= 2
      ) {
        const adjHigherBbr =
          spot != null && SYMBOLS[symbol].hasFuturesBasis
            ? applyFuturesBasis(higherCandles, spot, makeRounder(SYMBOLS[symbol].decimals))
            : higherCandles;
        const dailyResultBbr = computeLevelsStable(adjHigherBbr, spot, "1d", symbol, SYMBOLS[symbol]);
        if (dailyResultBbr.signal === "BUY") {
          logger.info(
            { symbol, timeframe, signalType: levels.signalType, dailySignal: dailyResultBbr.signal },
            "BB_REJECTION SELL suppressed — daily is actively bullish (conflict guard)",
          );
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
        // BB_BREAKOUT BUY: 0 TP1 hits across all tracked trades — entering at
        // momentum peaks (price above upper BB) with no follow-through. Blocked.
        const bbBreakoutBuyBlocked = levels.signalType === "BB_BREAKOUT" && levels.signal === "BUY";
        if (tradingEnabled && autoTraderOn && phemexSymbol && !bbBreakoutBuyBlocked) {
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

    // Partial-profit breakeven trigger: if price moves 40% of the way from
    // entry to TP1, move SL to breakeven on the full position immediately.
    // This fires BEFORE TP1 prints so a reversal can never turn a winning
    // trade into a full SL loss (e.g. up $15 on Gold then back to -$95).
    const tp1CheckOrder = openPhemexOrders.get(k);
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      tp1CheckOrder?.fullQty !== undefined &&
      tp1CheckOrder.entryPx !== undefined &&
      tp1CheckOrder.tp1Price !== undefined &&
      !tp1CheckOrder.beMoved &&
      !tp1CheckOrder.tp1Filled
    ) {
      const cur = levels.currentPrice ?? 0;
      const entry = tp1CheckOrder.entryPx;
      const tp1   = tp1CheckOrder.tp1Price;
      const partialThreshold = entry + (tp1 - entry) * 0.4;
      const beTriggered = tp1CheckOrder.posSide === "Long"
        ? cur >= partialThreshold
        : cur <= partialThreshold;
      if (beTriggered) {
        try {
          await cancelExistingStopOrders(tp1CheckOrder.phemexSymbol, tp1CheckOrder.posSide!);
          await placeStopOrder({
            phemexSymbol: tp1CheckOrder.phemexSymbol,
            posSide:      tp1CheckOrder.posSide!,
            stopPx:       entry,
            qtyRq:        tp1CheckOrder.fullQty.toFixed(tp1CheckOrder.qtyDecimals ?? 0),
            pxDecimals:   tp1CheckOrder.pxDecimals ?? 2,
          });
          openPhemexOrders.set(k, { ...tp1CheckOrder, beMoved: true });
          logger.info(
            { symbol, timeframe, entryPx: entry, tp1Price: tp1, currentPrice: cur, partialThreshold },
            "phemex-trader: partial profit — SL moved to breakeven (40% toward TP1)",
          );
        } catch (err) {
          logger.warn({ err, symbol, timeframe }, "phemex-trader: partial profit BE move failed");
        }
      }
    }

    // TP1 fill detection: if the tracked position has shrunk to ~50% of fullQty,
    // TP1 hit. Cancel the bracket SL and place a new stop at breakeven (entry price)
    // so the second half rides risk-free to TP2.
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

    // Per-poll stale entry-limit check: runs every tick while an order is tracked,
    // unlike the executePhemexTrade path which only runs on transitions/catch-up.
    // If a real entry limit has been sitting unfilled for > 2× the candle period,
    // cancel it so the catch-up block below can place a fresh order this same poll.
    //
    // Guards:
    //  • tradeState === "PENDING": entry not yet filled, so no open position
    //    and no TP/SL orders exist — makes the post-cancel confirmation safe.
    //  • cancelOrder() swallows errors, so we confirm cancellation by calling
    //    checkExistingOrder() after the cancel. Because tradeState is PENDING,
    //    there are no TP orders sharing the posSide — a null return truly means
    //    the entry is gone and it is safe to delete the tracker.
    if (isPhemexTradingEnabled() && phemexAutoTraderEnabled) {
      const staleCand = openPhemexOrders.get(k);
      if (
        staleCand?.placedAt != null &&
        levels.tradeState === "PENDING" &&
        (levels.signal === "BUY" || levels.signal === "SELL")
      ) {
        const ageMs   = Date.now() - staleCand.placedAt;
        const staleMs = TF_STALE_MS[timeframe] ?? TF_STALE_MS["1h"]!;
        if (ageMs > staleMs) {
          const stalePosSide = levels.signal === "BUY" ? "Long" : "Short";
          try {
            await cancelOrder(staleCand.phemexSymbol, staleCand.orderId, stalePosSide);
            // cancelOrder swallows errors; confirm the order is truly gone.
            const stillActive = await checkExistingOrder(staleCand.phemexSymbol, stalePosSide);
            if (stillActive === null) {
              logger.info(
                { symbol, timeframe, phemexSymbol: staleCand.phemexSymbol, orderId: staleCand.orderId, ageMs, staleMs },
                "phemex-trader: stale unfilled limit cancelled — placing fresh order",
              );
              openPhemexOrders.delete(k);
            } else {
              logger.warn(
                { symbol, timeframe, phemexSymbol: staleCand.phemexSymbol, orderId: staleCand.orderId },
                "phemex-trader: stale cancel did not remove order — keeping tracker",
              );
            }
          } catch (staleErr) {
            logger.warn({ staleErr, symbol, timeframe }, "phemex-trader: stale-limit cancel failed — keeping existing tracker");
          }
        }
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
    // If an externally-closed sentinel is blocking catch-up but the freshly-
    // computed signal entry price has moved >2% from the DB record, the old
    // trade is gone and a genuinely new setup has formed — clear the sentinel.
    // This runs here (poll cycle) not inside executePhemexTrade because only
    // here does `levels` reflect current market prices, not the stale stateMap.
    {
      const sentinel = openPhemexOrders.get(k);
      if (sentinel?.orderId?.startsWith("externally-closed-")) {
        const dbTrade = getActiveTrade(symbol, timeframe);
        const storedEntry = dbTrade?.entryPrice ?? 0;
        const movedPct = storedEntry > 0
          ? Math.abs((levels.entryPrice ?? 0) - storedEntry) / storedEntry
          : 0;
        if (movedPct > 0.02) {
          logger.info(
            { symbol, timeframe, storedEntry, currentEntry: levels.entryPrice, movedPct: movedPct.toFixed(3) },
            "phemex-trader: entry moved >2% since external close — clearing sentinel, allowing fresh re-entry",
          );
          openPhemexOrders.delete(k);
          clearActiveTrade(symbol, timeframe);
        }
      }
    }
    // All signal types reach executePhemexTrade for catch-up.
    // The re-entry type gate (FIB50_SWING only) lives inside executePhemexTrade:
    // if a position already exists it restores TPs for any signal type; if no
    // position exists it only re-enters for FIB50_SWING.
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      (levels.tradeState === "PENDING" || levels.tradeState === "FILLED_PROFIT" || levels.tradeState === "FILLED_DRAWDOWN") &&
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
        const skipRewardCheck = levels.tradeState === "FILLED_PROFIT" || levels.tradeState === "FILLED_DRAWDOWN";
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

    // Same fix as checkSymbol: for 4h, higherCandles ARE daily candles — reuse them.
    const dailyForWeekly =
      timeframe === "4h" && (higherCandles as typeof candles).length > 0
        ? (higherCandles as typeof candles)
        : (rawDailyForWeekly as typeof candles).length > 0
          ? (rawDailyForWeekly as typeof candles)
          : undefined;
    // For 1D: pass weekly candles (already fetched as higherCandles) so the
    // 1d signal is gated by the weekly EMA21/50 trend.
    const weeklyCandlesForDailyT = timeframe === "1d" && (higherCandles as typeof candles).length >= 2
      ? (higherCandles as typeof candles)
      : undefined;

    const k = key(symbolKey, timeframe);

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

    // Bootstrap: if this coin/TF has never been evaluated and the signal is a
    // fresh BUY/SELL that was never alerted, seed stateMap to WAIT so the
    // standard transition logic fires the alert on this very first tick.
    // Without this, the first evaluation stores the state and returns — then
    // every subsequent tick sees prev.signal === levels.signal so transitioned
    // stays false forever.
    // Allow bootstrap even when activeTradeBeforeCompute is set, as long as
    // the trade is still PENDING/unfilled (loaded from JSON snapshot but never
    // actually triggered). Only block when the trade is already filled — that's
    // genuine restart recovery where the user is already in a position.
    // A trade is "filled" (actually triggered) only when triggered===true.
    // A PENDING trade (triggered===false/undefined) loaded from the JSON
    // snapshot on restart is not a real position — allow bootstrap to fire.
    const activeTradeIsFilled =
      activeTradeBeforeCompute != null && activeTradeBeforeCompute.triggered === true;
    if (!stateMap.has(k) && !isSeedSnapshot && !activeTradeIsFilled &&
        (levels.signal === "BUY" || levels.signal === "SELL") &&
        levels.tradeState === "PENDING") {
      stateMap.set(k, { signal: "WAIT", lastAlertAt: 0 });
    }

    const prev = stateMap.get(k);

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
      // BB_REJECTION SELL IS allowed on trending coins — shorting overextended
      // pumping coins (touching upper band with MACD declining) is the core
      // winning strategy (HYPE, PENGU, DYDX shorts all used this pattern).
      // Filled trades bypass this: fills are always actionable regardless of
      // what signal type originally opened the position.
      if (!isFilledTrade) {
        const trendingTypeAllowed = levels.signalType === "FIB50_SWING" || levels.signalType === "DOUBLE_TOP" || levels.signalType === "DOUBLE_BOTTOM" || levels.signalType === "BB_REJECTION" || levels.signalType === "BB_WALK" || levels.signalType === "BB_BREAKOUT" || levels.signalType === "BB_OVEREXTENSION" || levels.signalType === "SWING_BREAK" || levels.signalType === "MACD_DIP_LONG";
        if (!trendingTypeAllowed) {
          logger.info(
            { symbolKey, timeframe, signalType: levels.signalType, signal: levels.signal },
            "Trending signal alert suppressed (signal type not allowed for trending coins)",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // Overlap guard: suppress a 1h BUY when a daily BUY is already active for
      // this coin at a lower entry price. The 1h signal fired above the daily
      // structural level — buying a bounce on top of the daily setup, not the
      // level itself. The user is already long at a better price; a second entry
      // above it increases average cost, doubles margin, and adds nothing.
      if (
        !isFilledTrade &&
        timeframe === "1h" &&
        levels.signal === "BUY"
      ) {
        const dailyActiveTrade = getActiveTrade(symbolKey, "1d");
        if (dailyActiveTrade?.signal === "BUY" && dailyActiveTrade.entryPrice < levels.entryPrice) {
          logger.info(
            { symbolKey, dailyEntry: dailyActiveTrade.entryPrice, hourlyEntry: levels.entryPrice },
            "Trending 1h BUY suppressed — daily BUY already active at a lower entry (overlap guard)",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // 24h momentum gate (trending coins, fresh entries only).
      // Trend-following signals must trade with the daily flow. Counter-trend
      // signals (BB_OVEREXTENSION, BB_REJECTION, DOUBLE_TOP, DOUBLE_BOTTOM)
      // are exempt — a big 24h move is a precondition for those setups.
      // Filled trades and direction flips are always exempt.
      const isTrendFollowingT =
        levels.signalType === "FIB50_SWING" ||
        levels.signalType === "DUMP_RECOVERY" ||
        levels.signalType === "BB_BREAKOUT" ||
        levels.signalType === "BB_WALK";
      if (!isFilledTrade && !isDirectionFlip && isTrendFollowingT && (levels.signal === "BUY" || levels.signal === "SELL")) {
        const pct24h = levels.priceChangePct ?? 0;
        const momentumOk =
          (levels.signal === "BUY" && pct24h > 0) ||
          (levels.signal === "SELL" && pct24h < 0);
        if (!momentumOk) {
          logger.info(
            { symbolKey, timeframe, signal: levels.signal, signalType: levels.signalType, priceChangePct: pct24h },
            "Trending signal suppressed — 24h momentum opposes trend-following signal direction",
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
        const higherResult = computeLevelsStable(higherCandles as typeof candles, spot, higherTf, symbolKey, tMeta);
        // Block only when the higher TF is actively opposed — daily SELL blocks
        // lower-TF BUY, daily BUY blocks lower-TF SELL. Daily WAIT does NOT block
        // lower-TF BUY: green daily MACD with the signal type gates already applied
        // is sufficient confirmation to ride a pump.
        const higherTfOpposedT =
          (higherResult.signal === "BUY" && levels.signal === "SELL") ||
          (higherResult.signal === "SELL" && levels.signal === "BUY");
        if (higherTfOpposedT) {
          logger.info(
            { symbolKey, timeframe, signal: levels.signal, higherTf, higherSignal: higherResult.signal },
            "Trending signal alert suppressed (higher TF not actively BUY for trending long, or actively opposed)",
          );
          stateMap.set(k, {
            ...(prev ?? {}),
            signal: prev?.signal ?? "WAIT",
            lastAlertAt: prev?.lastAlertAt ?? 0,
          });
          return;
        }
      }

      // Daily MACD gate for 1h trending SELL signals.
      // For static symbols, computeLevelsStable gates all 1h SELL paths via
      // higherTfAllowsSell (daily MACD histogram must be < 0). Trending coins
      // were missing this gate — higherTfOpposedT only blocks when 4h is
      // actively BUY. When 4h flips to WAIT, a 1h SELL slips through even if
      // the daily MACD histogram is still green. Block it here.
      // rawDailyForWeekly is always fetched as daily candles when timeframe === "1h".
      if (!isFilledTrade && timeframe === "1h" && levels.signal === "SELL") {
        const dailyCandlesForGate = rawDailyForWeekly as typeof candles;
        let dailyMacdAllowsSell = false;
        if (dailyCandlesForGate.length >= 35) {
          const dailyCloses = dailyCandlesForGate.map(c => c.close);
          const dailyHist = calcMACDHist(dailyCloses);
          const lastHist = dailyHist[dailyHist.length - 1];
          dailyMacdAllowsSell = isFinite(lastHist) && lastHist < 0;
        }
        if (!dailyMacdAllowsSell) {
          logger.info(
            { symbolKey, timeframe, signalType: levels.signalType },
            "Trending 1h SELL suppressed — daily MACD not confirmed negative",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: prev?.signal ?? "WAIT", lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // Symmetric gate for BUY: don't long if daily MACD is red (histogram < 0
      // or uncomputable). Mirrors the SELL gate above.
      if (!isFilledTrade && timeframe === "1h" && levels.signal === "BUY") {
        const dailyCandlesForGate = rawDailyForWeekly as typeof candles;
        let dailyMacdAllowsBuy = false;
        if (dailyCandlesForGate.length >= 35) {
          const dailyCloses = dailyCandlesForGate.map(c => c.close);
          const dailyHist = calcMACDHist(dailyCloses);
          const lastHist = dailyHist[dailyHist.length - 1];
          dailyMacdAllowsBuy = isFinite(lastHist) && lastHist > 0;
        }
        if (!dailyMacdAllowsBuy) {
          logger.info(
            { symbolKey, timeframe, signalType: levels.signalType },
            "Trending 1h BUY suppressed — daily MACD not confirmed positive",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: prev?.signal ?? "WAIT", lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // Same daily MACD gates for 4h signals.
      // For 4h, higherCandles ARE the daily candles (HIGHER_TIMEFRAME["4h"] = "1d").
      if (!isFilledTrade && timeframe === "4h") {
        const dailyCandlesForGate = higherCandles as typeof candles;
        let dailyMacdOk = false;
        if (dailyCandlesForGate.length >= 35) {
          const dailyCloses = dailyCandlesForGate.map(c => c.close);
          const dailyHist = calcMACDHist(dailyCloses);
          const lastHist = dailyHist[dailyHist.length - 1];
          if (levels.signal === "BUY")  dailyMacdOk = isFinite(lastHist) && lastHist > 0;
          if (levels.signal === "SELL") dailyMacdOk = isFinite(lastHist) && lastHist < 0;
        }
        if (!dailyMacdOk && (levels.signal === "BUY" || levels.signal === "SELL")) {
          logger.info(
            { symbolKey, timeframe, signalType: levels.signalType, signal: levels.signal },
            "Trending 4h signal suppressed — daily MACD not confirmed in signal direction",
          );
          stateMap.set(k, { ...(prev ?? {}), signal: prev?.signal ?? "WAIT", lastAlertAt: prev?.lastAlertAt ?? 0 });
          return;
        }
      }

      // BB_REJECTION SELL conflict guard (trending coins): suppress even on
      // direction flips when the daily is actively BUY. Trending coins are on
      // the list because they're pumping — shorting them via mean-reversion
      // against a confirmed daily BUY is always wrong.
      if (
        !isFilledTrade &&
        levels.signalType === "BB_REJECTION" &&
        levels.signal === "SELL" &&
        higherTf === "1d" &&
        (higherCandles as typeof candles).length >= 2
      ) {
        const dailyResultBbrT = computeLevelsStable(
          higherCandles as typeof candles, spot, "1d", symbolKey, tMeta,
        );
        if (dailyResultBbrT.signal === "BUY") {
          logger.info(
            { symbolKey, timeframe, signalType: levels.signalType, dailySignal: dailyResultBbrT.signal },
            "Trending BB_REJECTION SELL suppressed — daily is actively bullish (conflict guard)",
          );
          stateMap.set(k, {
            ...(prev ?? {}),
            signal: prev?.signal ?? "WAIT",
            lastAlertAt: prev?.lastAlertAt ?? 0,
          });
          return;
        }
      }

      // FIB50_SWING SELL guard (trending coins): require daily to be actively SELL.
      // FIB50_SWING is trend-following — a SELL fires when price rejects a fib
      // level. On a trending coin (discovered because it's pumping), a 1h fib
      // rejection during a daily uptrend is a pullback, not a reversal.
      // Applies even on direction flips: a flip from BUY→SELL on a coin whose
      // daily is BUY or WAIT is still just a short-term pullback.
      if (
        !isFilledTrade &&
        levels.signalType === "FIB50_SWING" &&
        levels.signal === "SELL" &&
        higherTf === "1d" &&
        (higherCandles as typeof candles).length >= 2
      ) {
        const dailyResultFibT = computeLevelsStable(
          higherCandles as typeof candles, spot, "1d", symbolKey, tMeta,
        );
        if (dailyResultFibT.signal !== "SELL") {
          logger.info(
            { symbolKey, timeframe, signalType: levels.signalType, dailySignal: dailyResultFibT.signal },
            "Trending FIB50_SWING SELL suppressed — daily not actively bearish (uptrend pullback guard)",
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

    // Partial-profit breakeven trigger for trending coins — same logic as checkSymbol.
    const tp1CheckOrderT = openPhemexOrders.get(k);
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      tp1CheckOrderT?.fullQty !== undefined &&
      tp1CheckOrderT.entryPx !== undefined &&
      tp1CheckOrderT.tp1Price !== undefined &&
      !tp1CheckOrderT.beMoved &&
      !tp1CheckOrderT.tp1Filled
    ) {
      const cur = levels.currentPrice ?? 0;
      const entry = tp1CheckOrderT.entryPx;
      const tp1   = tp1CheckOrderT.tp1Price;
      const partialThreshold = entry + (tp1 - entry) * 0.4;
      const beTriggered = tp1CheckOrderT.posSide === "Long"
        ? cur >= partialThreshold
        : cur <= partialThreshold;
      if (beTriggered) {
        try {
          await cancelExistingStopOrders(tp1CheckOrderT.phemexSymbol, tp1CheckOrderT.posSide!);
          await placeStopOrder({
            phemexSymbol: tp1CheckOrderT.phemexSymbol,
            posSide:      tp1CheckOrderT.posSide!,
            stopPx:       entry,
            qtyRq:        tp1CheckOrderT.fullQty.toFixed(tp1CheckOrderT.qtyDecimals ?? 0),
            pxDecimals:   tp1CheckOrderT.pxDecimals ?? 2,
          });
          openPhemexOrders.set(k, { ...tp1CheckOrderT, beMoved: true });
          logger.info(
            { symbolKey, timeframe, entryPx: entry, tp1Price: tp1, currentPrice: cur, partialThreshold },
            "phemex-trader: trending partial profit — SL moved to breakeven (40% toward TP1)",
          );
        } catch (err) {
          logger.warn({ err, symbolKey, timeframe }, "phemex-trader: trending partial profit BE move failed");
        }
      }
    }

    // TP1 fill detection for trending coins — same logic as checkSymbol.
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
    // Per-poll stale entry-limit check for trending coins — mirrors checkSymbol.
    // Gated on tradeState === "PENDING": entry unfilled, no position open, no
    // TP orders exist — checkExistingOrder post-cancel is unambiguous.
    // cancelOrder() swallows errors; confirm via checkExistingOrder before delete.
    if (isPhemexTradingEnabled() && phemexAutoTraderEnabled) {
      const staleCandT = openPhemexOrders.get(k);
      if (
        staleCandT?.placedAt != null &&
        levels.tradeState === "PENDING" &&
        (levels.signal === "BUY" || levels.signal === "SELL")
      ) {
        const ageMsT   = Date.now() - staleCandT.placedAt;
        const staleMsT = TF_STALE_MS[timeframe] ?? TF_STALE_MS["1h"]!;
        if (ageMsT > staleMsT) {
          const stalePosSideT = levels.signal === "BUY" ? "Long" : "Short";
          try {
            await cancelOrder(staleCandT.phemexSymbol, staleCandT.orderId, stalePosSideT);
            const stillActiveT = await checkExistingOrder(staleCandT.phemexSymbol, stalePosSideT);
            if (stillActiveT === null) {
              logger.info(
                { symbolKey, timeframe, phemexSymbol: staleCandT.phemexSymbol, orderId: staleCandT.orderId, ageMs: ageMsT, staleMs: staleMsT },
                "phemex-trader: trending stale unfilled limit cancelled — placing fresh order",
              );
              openPhemexOrders.delete(k);
            } else {
              logger.warn(
                { symbolKey, timeframe, phemexSymbol: staleCandT.phemexSymbol, orderId: staleCandT.orderId },
                "phemex-trader: trending stale cancel did not remove order — keeping tracker",
              );
            }
          } catch (staleErrT) {
            logger.warn({ staleErrT, symbolKey, timeframe }, "phemex-trader: trending stale-limit cancel failed — keeping existing tracker");
          }
        }
      }
    }

    // DOUBLE_TOP, DOUBLE_BOTTOM, and PATTERN_BREAKOUT are excluded from fresh
    // catch-up re-entry: their entries are pinned to a specific price level at
    // signal time. If price has already moved away (e.g. TAO shorted at the
    // bottom after falling from the pattern high), a catch-up re-enters at a
    // worse price with the same SL — near-zero reward or loss on entry.
    // EXCEPTION: FILLED_PROFIT means a position is already open. We only need
    // to restore TP orders — skip the type gate entirely in that case.
    // Same externally-closed sentinel clear as static symbols: if fresh levels
    // show entry moved >2% the old trade is gone and a new setup has formed.
    {
      const sentinelT = openPhemexOrders.get(k);
      if (sentinelT?.orderId?.startsWith("externally-closed-")) {
        const dbTradeT = getActiveTrade(symbolKey, timeframe);
        const storedEntryT = dbTradeT?.entryPrice ?? 0;
        const movedPctT = storedEntryT > 0
          ? Math.abs((levels.entryPrice ?? 0) - storedEntryT) / storedEntryT
          : 0;
        if (movedPctT > 0.02) {
          logger.info(
            { symbolKey, timeframe, storedEntry: storedEntryT, currentEntry: levels.entryPrice, movedPct: movedPctT.toFixed(3) },
            "phemex-trader: trending entry moved >2% since external close — clearing sentinel, allowing fresh re-entry",
          );
          openPhemexOrders.delete(k);
          clearActiveTrade(symbolKey, timeframe);
        }
      }
    }
    const trendingCatchUpTypeAllowed =
      levels.signalType === "FIB50_SWING" || levels.signalType === "DUMP_RECOVERY" || levels.signalType === "MACD_DIP_LONG" || levels.signalType === "BB_BREAKOUT" || levels.signalType === "BB_REJECTION" || levels.tradeState === "FILLED_PROFIT" || levels.tradeState === "FILLED_DRAWDOWN";
    if (
      (levels.signal === "BUY" || levels.signal === "SELL") &&
      (levels.tradeState === "PENDING" || levels.tradeState === "FILLED_PROFIT" || levels.tradeState === "FILLED_DRAWDOWN") &&
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

// ─── Profit-lock runtime state ────────────────────────────────────────────────
const PROFIT_LOCK_STATE_FILE = join(
  process.env["ACTIVE_TRADES_FILE"]
    ? dirname(process.env["ACTIVE_TRADES_FILE"])
    : join(process.cwd(), ".runtime"),
  "profit-lock-state.json",
);

interface ProfitLockState { enabled: boolean; threshold: number }

function loadProfitLockState(): ProfitLockState {
  const envThreshold = parseFloat(process.env["PROFIT_LOCK_USD"] ?? "30");
  const defaults: ProfitLockState = { enabled: true, threshold: envThreshold };
  try {
    if (!existsSync(PROFIT_LOCK_STATE_FILE)) return defaults;
    const parsed = JSON.parse(readFileSync(PROFIT_LOCK_STATE_FILE, "utf8")) as Partial<ProfitLockState>;
    return {
      enabled:   typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      threshold: typeof parsed.threshold === "number" && isFinite(parsed.threshold) ? parsed.threshold : envThreshold,
    };
  } catch { return defaults; }
}

function persistProfitLockState(s: ProfitLockState): void {
  try {
    mkdirSync(dirname(PROFIT_LOCK_STATE_FILE), { recursive: true });
    writeFileSync(PROFIT_LOCK_STATE_FILE, JSON.stringify(s), "utf8");
  } catch (err) {
    logger.warn({ err }, "phemex-trader: failed to persist profit-lock state");
  }
}

let profitLockState = loadProfitLockState();

export function setProfitLockEnabled(enabled: boolean): void {
  profitLockState = { ...profitLockState, enabled };
  persistProfitLockState(profitLockState);
  logger.info({ enabled }, `phemex-trader: profit-lock ${enabled ? "ENABLED" : "DISABLED"}`);
}

export function setProfitLockThreshold(threshold: number): void {
  profitLockState = { ...profitLockState, threshold };
  persistProfitLockState(profitLockState);
  logger.info({ threshold }, "phemex-trader: profit-lock threshold updated");
}

export function getProfitLockState(): ProfitLockState {
  return { ...profitLockState };
}

/**
 * Profit-lock: scans every open Phemex position each poll cycle.
 * If unrealized PnL >= threshold, cancel all pending TP/SL orders
 * and market-close the position immediately to bank the profit.
 *
 * Configurable at runtime via /api/phemex/profit-lock (toggle + threshold).
 */
async function lockProfits(): Promise<void> {
  if (!isPhemexTradingEnabled()) return;
  if (!profitLockState.enabled) return;
  const threshold = profitLockState.threshold;
  try {
    const positions = await getAllOpenPhemexPositions();
    for (const pos of positions) {
      if (!isFinite(pos.unrealisedPnl) || pos.unrealisedPnl < threshold) continue;
      logger.info(
        { symbol: pos.phemexSymbol, posSide: pos.posSide, unrealisedPnl: pos.unrealisedPnl, threshold },
        "phemex-trader: profit-lock triggered — closing position",
      );
      // Cancel TPs and SL so they don't interfere with the market close
      await Promise.allSettled([
        cancelExistingTpOrders(pos.phemexSymbol, pos.posSide),
        cancelExistingStopOrders(pos.phemexSymbol, pos.posSide),
      ]);
      const spec = getMinPriceRp(pos.phemexSymbol);
      const tickSize = spec > 0 ? spec : 0.01;
      const pxDecimals = Math.max(0, -Math.floor(Math.log10(tickSize)));
      await marketClosePosition({
        phemexSymbol: pos.phemexSymbol,
        posSide:      pos.posSide,
        qtyRq:        pos.size.toFixed(pxDecimals),
      });
      // Record to closed_trades so profit-lock closes aren't invisible
      const matches = findActiveTradesByPhemexSymbol(pos.phemexSymbol, pos.posSide);
      for (const { symbolKey, timeframe, trade } of matches) {
        logClosedTrade(trade, symbolKey, timeframe, pos.markPrice, "PROFIT_LOCK");
        clearActiveTrade(symbolKey, timeframe);
        logger.info(
          { symbolKey, timeframe, signalType: trade.signalType, signal: trade.signal, exitPrice: pos.markPrice, pnl: pos.unrealisedPnl },
          "phemex-trader: profit-lock close recorded to closed_trades",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "phemex-trader: lockProfits scan failed (non-fatal)");
  }
}

async function tick(): Promise<void> {
  // Profit-lock runs first — if any position is up ≥ $30, close it before
  // the signal checks can interfere.
  await lockProfits();

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
  const trendingSymbolKeys = new Set<string>();
  try {
    const { getTrendingSymbols, findTrendingSymbolByKey } = await import("./trending-discovery");
    const { getAllActiveTradeSymbols } = await import("./signals");

    for (const t of getTrendingSymbols()) {
      trendingSymbolKeys.add(t.symbolKey);
      for (const tf of TRACKED_TIMEFRAMES) {
        tasks.push(checkTrendingSymbol(t.symbolKey, tf));
      }
    }

    // Also poll coins that have active trade records but fell out of the trending
    // discovery list. Without this, their "filled" signals persist in the UI
    // indefinitely but are never re-evaluated or auto-traded.
    const staticKeys = new Set(ALL_SYMBOLS.map(String));
    for (const { symbolKey, timeframe } of getAllActiveTradeSymbols()) {
      if (trendingSymbolKeys.has(symbolKey) || staticKeys.has(symbolKey)) continue;
      // Attempt to find metadata via DB fallback (findTrendingSymbolByKey queries
      // recently-expired rows, not just live cache). If found, run the check.
      // If not found, skip — checkTrendingSymbol will return early if tMeta is null.
      void findTrendingSymbolByKey(symbolKey).then((meta) => {
        if (meta) tasks.push(checkTrendingSymbol(symbolKey, timeframe));
      });
    }

    // MACD_DIP_LONG: poll all coins that have ever had a Phemex order placed on
    // the 1h timeframe. This catches coins that fell out of the trending cache
    // but the user still wants watched for dip-recovery entries.
    // Static symbols are already covered by checkSymbol above.
    // Trending coins currently in cache are already covered above.
    for (const symbolKey of getPhemexTradedSymbols()) {
      if (trendingSymbolKeys.has(symbolKey) || staticKeys.has(symbolKey)) continue;
      void findTrendingSymbolByKey(symbolKey).then((meta) => {
        if (meta) tasks.push(checkTrendingSymbol(symbolKey, "1h"));
      });
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
    // Ensure hedge mode is detected before any cancel/place calls.
    // resolveHedgeMode() reads from a cached value set by getUSDTBalance().
    // Without this, all order operations omit posSide → Phemex 10500/39999.
    await getUSDTBalance();
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

/**
 * One-shot startup check: for every triggered trade that was placed on Phemex
 * (phemexOrderPlaced=true), verify the position still exists. If Phemex shows
 * no open position, the trade closed while the server was down (SL hit, TP hit,
 * or manually closed). Log it as closed so it appears in closed_trades instead
 * of hanging in activeTrades indefinitely.
 *
 * Uses stopLoss as the exit price proxy — the outcome auto-derives as "SL" for
 * losing trades, "TP2" if stopLoss somehow exceeded takeProfit2 (shouldn't
 * happen in practice). This is a conservative approximation; the alternative
 * (no record at all) is far worse.
 *
 * Must be called AFTER syncFromDb() so activeTrades is populated, and BEFORE
 * startSignalNotifier() so the polling loop doesn't race with this check.
 */
export async function reconcilePhemexPositions(): Promise<void> {
  if (!isPhemexTradingEnabled()) return;

  const allTrades = getAllActiveTradeSymbols();
  if (allTrades.length === 0) return;

  // getUSDTBalance() must run first — it sets the detectedHedgeMode side-effect
  // that checkExistingPosition relies on for posSide parameters.
  try {
    await getUSDTBalance();
  } catch (err) {
    logger.warn({ err }, "reconcile: could not fetch Phemex balance — skipping position reconciliation");
    return;
  }

  logger.info({ count: allTrades.length }, "reconcile: checking Phemex positions for triggered trades");

  for (const { symbolKey, timeframe } of allTrades) {
    const trade = getActiveTrade(symbolKey, timeframe);
    if (!trade) continue;

    // Only reconcile trades that were actually filled on Phemex
    if (!trade.triggered || !trade.phemexOrderPlaced) continue;

    // Derive phemex perpetual symbol: static symbols have it in SYMBOLS,
    // trending coins use the symbolKey directly (e.g. "VVVUSDT").
    const staticMeta = SYMBOLS[symbolKey as Symbol];
    const phemexSymbol: string = staticMeta?.phemexPerp ?? symbolKey;

    const posSide = trade.signal === "BUY" ? ("Long" as const) : ("Short" as const);

    let existingPos: Awaited<ReturnType<typeof checkExistingPosition>> | undefined;
    try {
      existingPos = await checkExistingPosition(phemexSymbol, posSide);
    } catch (err) {
      logger.warn({ err, symbolKey, timeframe, phemexSymbol }, "reconcile: checkExistingPosition threw — skipping symbol");
      continue;
    }

    if (existingPos === null) {
      // Position is gone — it closed while the server was down.
      // Use stopLoss as exit price proxy so outcome auto-derives correctly:
      // a losing trade records as SL, a breakeven-trailed trade as BE_TRAIL.
      logger.info(
        { symbolKey, timeframe, phemexSymbol, signal: trade.signal, entryPrice: trade.entryPrice, stopLoss: trade.stopLoss },
        "reconcile: triggered position no longer on Phemex — logging as closed and clearing active trade",
      );
      logClosedTrade(trade, symbolKey, timeframe, trade.stopLoss);
      clearActiveTrade(symbolKey, timeframe);
    } else {
      logger.info(
        { symbolKey, timeframe, phemexSymbol, size: existingPos.size },
        "reconcile: position still open on Phemex — no action needed",
      );
    }
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
