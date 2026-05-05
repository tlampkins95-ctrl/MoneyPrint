import { logger } from "./logger";
import { SYMBOLS, type Symbol } from "./symbols";
import type { Timeframe } from "./yahoo-fetch";
import type { computeLevelsStable } from "./signals";

type Levels = ReturnType<typeof computeLevelsStable>;

export interface AlertContext {
  symbol: Symbol;
  timeframe: Timeframe;
  tfLabel: string;
  levels: Levels;
  link: string | null;
}

export function isTelegramEnabled(): boolean {
  const flag = process.env["ENABLE_TELEGRAM_NOTIFIER"];
  if (flag === "false" || flag === "0") return false;
  return Boolean(
    process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"],
  );
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

// Pure data context — both Telegram and (potentially) other channels can
// build their own formatted output from this without re-fetching anything.
export function buildAlertContext(
  symbol: Symbol,
  timeframe: Timeframe,
  tfLabel: string,
  levels: Levels,
  link: string | null,
): AlertContext {
  return { symbol, timeframe, tfLabel, levels, link };
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
      logger.warn({ status: res.status, body }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.warn({ err }, "Telegram sendMessage error");
  }
}

export async function sendTelegramAlert(ctx: AlertContext): Promise<void> {
  const { symbol, tfLabel, levels, link } = ctx;
  const sideEmoji = levels.signal === "BUY" ? "🟢" : "🔴";
  const sideWord = levels.signal === "BUY" ? "BUY" : "SELL";

  const risk = Math.abs(levels.entryPrice - levels.stopLoss);
  const tp1R =
    risk > 0 ? Math.abs(levels.takeProfit1 - levels.entryPrice) / risk : 0;
  const tp2R =
    risk > 0 ? Math.abs(levels.takeProfit2 - levels.entryPrice) / risk : 0;

  const ps = levels.positionSizing;
  const ach = ps?.achievable;
  const slDollar = ach
    ? `−$${Math.abs(ach.pnlAtSL).toFixed(2)}`
    : ps
      ? `−$${ps.riskAmount.toFixed(2)}`
      : "—";
  const tp1Dollar = ach
    ? `+$${ach.pnlAtTP1.toFixed(2)}`
    : ps
      ? `+$${(ps.riskAmount * tp1R).toFixed(2)}`
      : "—";
  const tp2Dollar = ach
    ? `+$${ach.pnlAtTP2.toFixed(2)}`
    : ps
      ? `+$${(ps.riskAmount * tp2R).toFixed(2)}`
      : "—";

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
    lines.push(
      `Risk: <b>$${ps.riskAmount.toFixed(2)}</b> on $${ps.accountSize} acct (${ps.riskPct.toFixed(1)}%)`,
    );
    lines.push(sizeLine);
  }

  lines.push("", escapeHtml(levels.signalReason));

  if (link) {
    lines.push("", `<a href="${link}">📈 Open chart →</a>`);
  }

  await sendTelegramMessage(lines.join("\n"));
}
