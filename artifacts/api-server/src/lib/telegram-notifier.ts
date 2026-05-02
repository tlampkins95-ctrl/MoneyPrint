import { logger } from "./logger";
import { SYMBOLS, type Symbol, ALL_SYMBOLS } from "./symbols";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
} from "./yahoo-fetch";
import { computeLevels, fetchSpotPrice } from "./signals";

type SignalKind = "BUY" | "SELL" | "WAIT";
type ZoneState = "IN_BUY" | "IN_SELL" | "OUT";

interface TrackedState {
  signal: SignalKind;
  zone: ZoneState;
}

const TRACKED_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "1d"];
const POLL_INTERVAL_MS = 60_000;

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

function classifyZone(
  price: number,
  buyLow: number,
  buyHigh: number,
  sellLow: number,
  sellHigh: number,
): ZoneState {
  if (price >= buyLow && price <= buyHigh) return "IN_BUY";
  if (price >= sellLow && price <= sellHigh) return "IN_SELL";
  return "OUT";
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
    const zone = classifyZone(
      levels.currentPrice,
      levels.buyZone.low,
      levels.buyZone.high,
      levels.sellZone.low,
      levels.sellZone.high,
    );
    const k = key(symbol, timeframe);
    const prev = stateMap.get(k);
    const next: TrackedState = { signal: levels.signal, zone };

    // Seed state on first observation — never alert on first run.
    if (!prev) {
      stateMap.set(k, next);
      return;
    }

    const signalChanged =
      prev.signal !== next.signal && next.signal !== "WAIT";
    const zoneEntered =
      prev.zone !== next.zone && next.zone !== "OUT";

    if (signalChanged || zoneEntered) {
      const tag = next.signal === "BUY" ? "🟢 BUY" : next.signal === "SELL" ? "🔴 SELL" : "⏸ WAIT";
      const reasonHeader = signalChanged
        ? `<b>${tag} signal — ${escapeHtml(SYMBOLS[symbol].label)}</b>`
        : `<b>📍 Price entered ${next.zone === "IN_BUY" ? "BUY" : "SELL"} zone — ${escapeHtml(SYMBOLS[symbol].label)}</b>`;

      const lines = [
        reasonHeader,
        `<i>${escapeHtml(timeframe.toUpperCase())} · ${fmt(symbol, levels.currentPrice)}</i>`,
        "",
        `Entry: <code>${fmt(symbol, levels.entryPrice)}</code>`,
        `SL:    <code>${fmt(symbol, levels.stopLoss)}</code>`,
        `TP1:   <code>${fmt(symbol, levels.takeProfit1)}</code>`,
        `TP2:   <code>${fmt(symbol, levels.takeProfit2)}</code>`,
        `R:R:   <code>1:${levels.riskRewardRatio.toFixed(2)}</code>`,
        "",
        `Buy zone:  <code>${fmt(symbol, levels.buyZone.low)}–${fmt(symbol, levels.buyZone.high)}</code>`,
        `Sell zone: <code>${fmt(symbol, levels.sellZone.low)}–${fmt(symbol, levels.sellZone.high)}</code>`,
        `Trend: <b>${levels.trend}</b> (${levels.trendStrength})`,
        "",
        escapeHtml(levels.signalReason),
      ];
      await sendTelegramMessage(lines.join("\n"));
      logger.info(
        { symbol, timeframe, signal: next.signal, zone: next.zone, prev },
        "Telegram alert sent",
      );
    }

    stateMap.set(k, next);
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
