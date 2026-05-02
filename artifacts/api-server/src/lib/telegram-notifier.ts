import { logger } from "./logger";
import { SYMBOLS, type Symbol, ALL_SYMBOLS } from "./symbols";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
} from "./yahoo-fetch";
import { computeLevels, fetchSpotPrice } from "./signals";

type SignalKind = "BUY" | "SELL" | "WAIT";

interface TrackedState {
  signal: SignalKind;
  lastAlertAt: number; // epoch ms of most recent alert for this symbol/tf
}

// 15m dropped — too noisy at intraday cadence (zones get re-tagged every few
// minutes near the pivot). 30m / 1h / 1d give meaningful, actionable alerts.
const TRACKED_TIMEFRAMES: Timeframe[] = ["30m", "1h", "1d"];
const POLL_INTERVAL_MS = 60_000;

// Minimum gap between alerts for the same symbol/timeframe. Prevents
// flip-flop spam when price hovers around a zone edge.
const COOLDOWN_BY_TIMEFRAME: Record<Timeframe, number> = {
  "1m": 10 * 60_000,
  "15m": 30 * 60_000,
  "30m": 60 * 60_000,
  "1h": 3 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "1m": "1-min",
  "15m": "15-min",
  "30m": "30-min",
  "1h": "1-hour",
  "1d": "Daily",
};

const stateMap = new Map<string, TrackedState>();

function key(symbol: Symbol, timeframe: Timeframe): string {
  return `${symbol}::${timeframe}`;
}

function fmt(symbol: Symbol, n: number): string {
  const m = SYMBOLS[symbol];
  return `${m.prefix}${n.toFixed(m.decimals)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Build a deep link back to the screener for a given symbol/timeframe.
// Prefers REPLIT_DOMAINS (set in production, comma-separated), falling back to
// REPLIT_DEV_DOMAIN in development. Returns null if neither is set so we can
// safely omit the link.
function buildAppLink(symbol: Symbol, timeframe: Timeframe): string | null {
  const prodDomains = process.env["REPLIT_DOMAINS"];
  const devDomain = process.env["REPLIT_DEV_DOMAIN"];
  const host = prodDomains?.split(",")[0]?.trim() || devDomain?.trim();
  if (!host) return null;
  return `https://${host}/?symbol=${symbol}&timeframe=${timeframe}`;
}

async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chatId) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body },
        "Telegram sendMessage failed",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Telegram sendMessage error");
  }
}

async function checkSymbol(
  symbol: Symbol,
  timeframe: Timeframe,
): Promise<void> {
  try {
    const [candles, spot] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
    ]);
    if (candles.length < 2) return;

    const levels = computeLevels(candles, spot, timeframe, symbol);
    const k = key(symbol, timeframe);
    const prev = stateMap.get(k);
    const now = Date.now();

    // Seed state on first observation — never alert on first run.
    if (!prev) {
      stateMap.set(k, { signal: levels.signal, lastAlertAt: 0 });
      return;
    }

    // We only alert when the signal *transitions into* BUY or SELL. Bare
    // zone re-entries are dropped because the signal logic already requires
    // zone + trend confirmation before flipping to BUY/SELL.
    const transitioned =
      prev.signal !== levels.signal &&
      (levels.signal === "BUY" || levels.signal === "SELL");

    const cooldownMs = COOLDOWN_BY_TIMEFRAME[timeframe];
    const cooldownActive = now - prev.lastAlertAt < cooldownMs;

    if (transitioned && !cooldownActive) {
      const sideEmoji = levels.signal === "BUY" ? "🟢" : "🔴";
      const sideWord = levels.signal === "BUY" ? "BUY" : "SELL";
      const tfLabel = TIMEFRAME_LABEL[timeframe];

      const risk = Math.abs(levels.entryPrice - levels.stopLoss);
      const tp1R = risk > 0 ? Math.abs(levels.takeProfit1 - levels.entryPrice) / risk : 0;
      const tp2R = risk > 0 ? Math.abs(levels.takeProfit2 - levels.entryPrice) / risk : 0;

      // Dollar P&L per leg, scaled to the configured risk amount. Falls back
      // to "—" when sizing isn't available (shouldn't happen for valid setups).
      const ps = levels.positionSizing;
      const slDollar = ps ? `−$${ps.riskAmount.toFixed(2)}` : "—";
      const tp1Dollar = ps ? `+$${(ps.riskAmount * tp1R).toFixed(2)}` : "—";
      const tp2Dollar = ps ? `+$${(ps.riskAmount * tp2R).toFixed(2)}` : "—";

      const lines = [
        `${sideEmoji} <b>${sideWord} ${escapeHtml(SYMBOLS[symbol].label)}</b>`,
        `<i>${tfLabel} · now ${fmt(symbol, levels.currentPrice)}</i>`,
        "",
        `🎯 Entry  <b>${fmt(symbol, levels.entryPrice)}</b>`,
        `🛑 Stop   <b>${fmt(symbol, levels.stopLoss)}</b>  <i>${slDollar}</i>`,
        `✅ TP1    <b>${fmt(symbol, levels.takeProfit1)}</b>  <i>${tp1Dollar} (+${tp1R.toFixed(1)}R)</i>`,
        `🏆 TP2    <b>${fmt(symbol, levels.takeProfit2)}</b>  <i>${tp2Dollar} (+${tp2R.toFixed(1)}R)</i>`,
        "",
        `Trend: <b>${levels.trend}</b> (${levels.trendStrength})`,
      ];

      if (ps) {
        const sizeLine =
          ps.leverage !== undefined
            ? `Size: <b>${ps.positionSize} ${ps.positionSizeUnit}</b> · <b>${ps.leverage}x</b> lev · $${ps.notional.toFixed(0)} notional`
            : ps.lots
              ? `Size: <b>${ps.lots.mini.toFixed(2)} mini lots</b> (${ps.lots.micro.toFixed(1)} micro) · $${ps.notional.toFixed(0)} notional`
              : `Size: <b>${ps.positionSize} ${ps.positionSizeUnit}</b> · $${ps.notional.toFixed(0)} notional`;
        lines.push(`Risk: <b>$${ps.riskAmount.toFixed(2)}</b> on $${ps.accountSize} acct (${ps.riskPct.toFixed(1)}%)`);
        lines.push(sizeLine);
      }

      lines.push("", escapeHtml(levels.signalReason));

      const link = buildAppLink(symbol, timeframe);
      if (link) {
        lines.push("", `<a href="${link}">📈 Open chart →</a>`);
      }

      await sendTelegramMessage(lines.join("\n"));
      logger.info(
        { symbol, timeframe, from: prev.signal, to: levels.signal },
        "Telegram alert sent",
      );
      stateMap.set(k, { signal: levels.signal, lastAlertAt: now });
      return;
    }

    if (transitioned && cooldownActive) {
      logger.debug(
        {
          symbol,
          timeframe,
          from: prev.signal,
          to: levels.signal,
          remainingMs: cooldownMs - (now - prev.lastAlertAt),
        },
        "Telegram alert suppressed (cooldown)",
      );
    }

    // Always update the tracked signal so next transition fires correctly,
    // but preserve the previous lastAlertAt so the cooldown still ticks.
    stateMap.set(k, { signal: levels.signal, lastAlertAt: prev.lastAlertAt });
  } catch (err) {
    logger.warn({ err, symbol, timeframe }, "Notifier check failed");
  }
}

async function tick(): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const symbol of ALL_SYMBOLS) {
    for (const tf of TRACKED_TIMEFRAMES) {
      tasks.push(checkSymbol(symbol, tf));
    }
  }
  await Promise.allSettled(tasks);
}

let started = false;

export function startTelegramNotifier(): void {
  if (started) return;
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chatId) {
    logger.info(
      "Telegram notifier disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)",
    );
    return;
  }
  started = true;
  logger.info(
    { symbols: ALL_SYMBOLS.length, timeframes: TRACKED_TIMEFRAMES, intervalMs: POLL_INTERVAL_MS },
    "Telegram notifier started",
  );
  // Kick off immediately to seed state, then on a regular interval.
  void tick();
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
