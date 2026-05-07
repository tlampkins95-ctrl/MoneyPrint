import { logger } from "./logger";
import { SYMBOLS, makeRounder, type Symbol, ALL_SYMBOLS } from "./symbols";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
} from "./yahoo-fetch";
import { computeLevelsStable, fetchSpotPrice, getActiveTrade, applyFuturesBasis, registerOnTradeClosedCallback } from "./signals";
import {
  buildAlertContext,
  sendTelegramAlert,
  isTelegramEnabled,
} from "./telegram-notifier";
import { broadcastWebPush } from "./web-push-notifier";

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

// Alert on 30m, 1h (intraday entries) and 1d (catches major daily moves like metals pumps).
const TRACKED_TIMEFRAMES: Timeframe[] = ["30m", "1h", "1d"];
// Only seed-alert on 30m at startup/restart. 1h and 1d seeds create a barrage
// on every redeploy — they'll still alert on genuine transitions during polling.
const SEED_TIMEFRAMES = new Set<Timeframe>(["30m"]);
const POLL_INTERVAL_MS = 60_000;

const COOLDOWN_BY_TIMEFRAME: Record<Timeframe, number> = {
  "15m": 30 * 60_000,
  "30m": 60 * 60_000,
  "1h": 3 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "15m": "15-min",
  "30m": "30-min",
  "1h": "1-hour",
  "1d": "Daily",
};

const stateMap = new Map<string, TrackedState>();

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
  "30m": "1h",
  "1h": "1d",
};

async function checkSymbol(
  symbol: Symbol,
  timeframe: Timeframe,
): Promise<void> {
  try {
    const higherTf = HIGHER_TIMEFRAME[timeframe];
    const [candles, spot, higherCandles] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
      higherTf ? fetchCandlesForTimeframe(symbol, higherTf) : Promise.resolve([]),
    ]);
    if (candles.length < 2) return;

    // Apply basis shift for metals so alert prices (entry/SL/TP) match broker
    // spot pricing (MT5 / OANDA) rather than SI=F / GC=F futures levels.
    const adjustedCandles =
      spot != null && SYMBOLS[symbol].hasFuturesBasis
        ? applyFuturesBasis(candles, spot, makeRounder(SYMBOLS[symbol].decimals))
        : candles;

    // Snapshot the active trade BEFORE calling computeLevelsStable.
    // computeLevelsStable writes a new ActiveTrade entry the moment a fresh
    // BUY/SELL fires, so reading after the call always finds a trade in the
    // new direction — causing alreadyInSameDirection to fire and silently
    // eat every non-seed alert. Reading before gives us the pre-computation
    // state: null on a genuine new signal, populated on an oscillation.
    const activeTradeBeforeCompute = getActiveTrade(symbol, timeframe);

    const levels = computeLevelsStable(adjustedCandles, spot, timeframe, symbol, SYMBOLS[symbol]);
    const k = key(symbol, timeframe);
    const prev = stateMap.get(k);
    const now = Date.now();

    // Seed state on first observation. If a BUY/SELL is *already active*
    // at seed time (e.g. the server just started while a position was
    // already in its zone), treat it as a transition so the user gets a
    // one-time snapshot alert instead of silently missing the trade. WAIT
    // signals at seed time are still suppressed — there's nothing to
    // alert on.
    // Seeds only fire for SEED_TIMEFRAMES (30m). 1h/1d first-observations just
    // record state silently — they'll alert on genuine transitions during polling.
    const isSeedSnapshot = !prev && SEED_TIMEFRAMES.has(timeframe) && (levels.signal === "BUY" || levels.signal === "SELL");
    const transitioned =
      isSeedSnapshot ||
      (!!prev &&
        prev.signal !== levels.signal &&
        (levels.signal === "BUY" || levels.signal === "SELL"));

    if (!prev && !isSeedSnapshot) {
      stateMap.set(k, { signal: levels.signal, lastAlertAt: 0 });
      return;
    }

    const cooldownMs = COOLDOWN_BY_TIMEFRAME[timeframe];
    // On a seed snapshot there's no prior alert, so cooldown is N/A.
    // Cooldown is direction-aware: it only applies when the new signal matches
    // the last alerted direction. A BUY→SELL (or SELL→BUY) flip bypasses the
    // cooldown entirely — it's a new setup in the opposite direction, not a
    // repeat alert. This prevents the cooldown from silently eating reversals
    // after a trade closes (e.g. KSM TP2 BUY → no SELL alert during reversal).
    const cooldownActive =
      !!prev &&
      now - prev.lastAlertAt < cooldownMs &&
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
      // Gate: pending signals must be confirmed by the next higher TF before alerting.
      // 30m is gated by 1h; 1h is gated by 1d. Filled trades are exempt.
      const isFilledTrade =
        levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
      if (
        higherTf != null &&
        !isFilledTrade &&
        (levels.signal === "BUY" || levels.signal === "SELL") &&
        higherCandles.length >= 2
      ) {
        const adjRound = makeRounder(SYMBOLS[symbol].decimals);
        const adjHigher =
          spot != null && SYMBOLS[symbol].hasFuturesBasis
            ? applyFuturesBasis(higherCandles, spot, adjRound)
            : higherCandles;
        const higherResult = computeLevelsStable(adjHigher, spot, higherTf, symbol, SYMBOLS[symbol]);
        if (higherResult.signal !== levels.signal) {
          logger.info(
            { symbol, timeframe, signal: levels.signal, higherTf, higherSignal: higherResult.signal },
            "Signal alert suppressed (higher TF gate disagrees)",
          );
          // Keep the PREVIOUS signal in stateMap — not the new one. If we
          // record levels.signal here (e.g. BUY), the next tick sees BUY→BUY
          // and never fires. By preserving prev's signal (e.g. WAIT), the
          // transition fires correctly the moment 1h aligns.
          stateMap.set(k, {
            signal: prev?.signal ?? "WAIT",
            lastAlertAt: prev?.lastAlertAt ?? 0,
          });
          return;
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
        const typeTag = levels.signalType === "BREAKOUT" ? " ◈ BREAKOUT" : " ↕ PIVOT";
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
      stateMap.set(k, { signal: levels.signal, lastAlertAt: now, lastAlertSignal: levels.signal });
      return;
    }

    if (transitioned && cooldownActive && prev) {
      logger.info(
        {
          symbol,
          timeframe,
          from: prev.signal,
          to: levels.signal,
          remainingMs: cooldownMs - (now - prev.lastAlertAt),
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

    // Track new signal but preserve lastAlertAt so cooldown still ticks.
    stateMap.set(k, {
      signal: levels.signal,
      lastAlertAt: prev?.lastAlertAt ?? 0,
    });
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
    const [candles, spot, higherCandles] = await Promise.all([
      fetchCandlesForDynamic(tMeta.okxPerp!, timeframe),
      fetchSpotForDynamic(tMeta.okxPerp!),
      higherTf ? fetchCandlesForDynamic(tMeta.okxPerp!, higherTf) : Promise.resolve([]),
    ]);
    if (candles.length < 2) return;

    const k = key(symbolKey, timeframe);
    const prev = stateMap.get(k);
    const levels = computeLevelsStable(candles, spot, timeframe, symbolKey, tMeta);
    const now = Date.now();

    const isSeedSnapshot = !prev && SEED_TIMEFRAMES.has(timeframe) && (levels.signal === "BUY" || levels.signal === "SELL");
    const transitioned =
      isSeedSnapshot ||
      (!!prev && prev.signal !== levels.signal && (levels.signal === "BUY" || levels.signal === "SELL"));

    if (!prev && !isSeedSnapshot) {
      stateMap.set(k, { signal: levels.signal, lastAlertAt: 0 });
      return;
    }

    const cooldownMs = COOLDOWN_BY_TIMEFRAME[timeframe];
    // Direction-aware: only suppress same-direction repeats. A flip in
    // direction (BUY→SELL or SELL→BUY) always bypasses the cooldown.
    const cooldownActive =
      !!prev &&
      now - prev.lastAlertAt < cooldownMs &&
      prev.lastAlertSignal === levels.signal;

    if (transitioned && !cooldownActive) {
      // Gate: pending signals must be confirmed by the next higher TF before alerting.
      // 30m is gated by 1h; 1h is gated by 1d. Filled trades are exempt.
      const isFilledTrade =
        levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
      if (
        higherTf != null &&
        !isFilledTrade &&
        (levels.signal === "BUY" || levels.signal === "SELL") &&
        higherCandles.length >= 2
      ) {
        const higherResult = computeLevelsStable(higherCandles, spot, higherTf, symbolKey, tMeta);
        if (higherResult.signal !== levels.signal) {
          logger.info(
            { symbolKey, timeframe, signal: levels.signal, higherTf, higherSignal: higherResult.signal },
            "Trending signal alert suppressed (higher TF gate disagrees)",
          );
          stateMap.set(k, {
            signal: prev?.signal ?? "WAIT",
            lastAlertAt: prev?.lastAlertAt ?? 0,
          });
          return;
        }
      }

      const tfLabel = TIMEFRAME_LABEL[timeframe];
      const link = buildAppLink(symbolKey, timeframe);
      const ctx = buildAlertContext(symbolKey, tMeta, timeframe, tfLabel, levels, link);
      const tasks: Promise<void>[] = [];
      if (isTelegramEnabled()) tasks.push(sendTelegramAlert(ctx));
      if (isWebPushEnabled()) {
        const sideEmoji = levels.signal === "BUY" ? "🟢" : "🔴";
        const sideWord = levels.signal === "BUY" ? "BUY" : "SELL";
        const typeTagT = levels.signalType === "BREAKOUT" ? " ◈ BREAKOUT" : " ↕ PIVOT";
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
      stateMap.set(k, { signal: levels.signal, lastAlertAt: now, lastAlertSignal: levels.signal });
      return;
    }
    stateMap.set(k, { signal: levels.signal, lastAlertAt: prev?.lastAlertAt ?? 0, lastAlertSignal: prev?.lastAlertSignal });
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
  // Also check trending coins.
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

// Called by signals.ts (via the registered callback) when a trade closes via
// SL, BE_TRAIL, or TP2. Resets lastAlertAt so the next genuine setup on the
// same symbol/TF fires immediately rather than waiting out the cooldown.
function clearCooldown(symbolKey: string, timeframe: Timeframe): void {
  const k = key(symbolKey, timeframe);
  const existing = stateMap.get(k);
  if (existing) {
    // Clear both lastAlertAt and lastAlertSignal so the next signal in either
    // direction fires immediately, regardless of what was last alerted.
    stateMap.set(k, { ...existing, lastAlertAt: 0, lastAlertSignal: undefined });
  }
}

let started = false;

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

  // Wire up the cooldown-reset hook so signals.ts can notify us when a trade
  // closes without creating a circular import.
  registerOnTradeClosedCallback(clearCooldown);

  logger.info(
    {
      symbols: ALL_SYMBOLS.length,
      timeframes: TRACKED_TIMEFRAMES,
      intervalMs: POLL_INTERVAL_MS,
      telegramOn,
      webPushOn,
    },
    "Signal notifier started",
  );
  void tick();
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
