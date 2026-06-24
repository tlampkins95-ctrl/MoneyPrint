/**
 * Phemex USDT-margined linear perpetual auto-trader.
 *
 * Authentication: HMAC-SHA256(apiSecret, path + rawQuery + expiry + body)
 * All price fields use the "Rp" suffix (real price, not scaled int).
 * All quantity fields use the "Rq" suffix (real quantity).
 *
 * Env vars:
 *   PHEMEX_API_KEY       — Phemex API key (required to enable trading)
 *   PHEMEX_API_SECRET    — Phemex API secret (required to enable trading)
 *   PHEMEX_TESTNET       — "true" to use testnet-api.phemex.com (default: false)
 *   PHEMEX_RISK_PCT      — fraction of balance to risk per trade (default: 0.01 = 1%)
 *   PHEMEX_MAX_LEVERAGE  — max leverage cap for auto orders (default: 20)
 *   PHEMEX_HEDGE_MODE    — "true" to send posSide Long/Short (default: false = one-way)
 */

import { createHmac } from "node:crypto";
import { logger } from "./logger";

const LIVE_URL     = "https://api.phemex.com";
const TESTNET_URL  = "https://testnet-api.phemex.com";

function baseUrl(): string {
  return process.env["PHEMEX_TESTNET"] === "true" ? TESTNET_URL : LIVE_URL;
}

export function isPhemexTradingEnabled(): boolean {
  return !!(process.env["PHEMEX_API_KEY"] && process.env["PHEMEX_API_SECRET"]);
}

export function phemexRiskPct(): number {
  const v = parseFloat(process.env["PHEMEX_RISK_PCT"] ?? "0.01");
  return isFinite(v) && v > 0 && v <= 0.2 ? v : 0.01;
}

export function phemexMaxLeverage(): number {
  const v = parseFloat(process.env["PHEMEX_MAX_LEVERAGE"] ?? "20");
  return isFinite(v) && v >= 1 ? Math.min(v, 100) : 20;
}

function sign(
  secret: string,
  path: string,
  rawQuery: string,
  body: string,
  expiry: number,
): string {
  const msg = path + rawQuery + expiry.toString() + body;
  return createHmac("sha256", secret).update(msg).digest("hex");
}

async function phemexRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  query: Record<string, string> = {},
  body?: object,
): Promise<T> {
  const apiKey    = process.env["PHEMEX_API_KEY"]!;
  const apiSecret = process.env["PHEMEX_API_SECRET"]!;
  const expiry    = Math.floor(Date.now() / 1000) + 60;

  const rawQuery = Object.keys(query).length
    ? new URLSearchParams(query).toString()
    : "";
  const bodyStr  = body ? JSON.stringify(body) : "";
  const sig      = sign(apiSecret, path, rawQuery, bodyStr, expiry);

  const url = `${baseUrl()}${path}${rawQuery ? "?" + rawQuery : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-phemex-access-token":      apiKey,
      "x-phemex-request-expiry":    expiry.toString(),
      "x-phemex-request-signature": sig,
    },
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(12_000),
  });

  const json = (await res.json()) as { code: number; msg?: string; data: T };
  if (json.code !== 0) {
    throw Object.assign(
      new Error(`Phemex ${method} ${path} → code ${json.code}: ${json.msg ?? "unknown"}`),
      { phemexCode: json.code, phemexMsg: json.msg, phemexRaw: JSON.stringify(json) },
    );
  }
  return json.data;
}

// ─── Account ─────────────────────────────────────────────────────────────────

interface AccountData {
  account?: {
    accountBalanceRv?: string;
    freeMarginRv?: string;
    availableBalanceRv?: string;
  };
}

/**
 * Returns the free USDT margin available for new positions.
 * Returns null on any failure — the caller falls back to the default account size.
 */
export async function getUSDTBalance(): Promise<number | null> {
  try {
    const data = await phemexRequest<AccountData>(
      "GET",
      "/g-accounts/accountPositions",
      { currency: "USDT" },
    );
    const raw =
      data.account?.freeMarginRv ??
      data.account?.availableBalanceRv ??
      data.account?.accountBalanceRv;
    const v = parseFloat(raw ?? "");
    if (!isFinite(v) || v <= 0) {
      logger.warn({ raw, data }, "Phemex balance parse failed — raw value unexpected");
      return null;
    }
    return v;
  } catch (err) {
    logger.warn({ err }, "getUSDTBalance: request failed");
    return null;
  }
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  phemexSymbol:  string;    // e.g. "BTCUSDT"
  side:          "Buy" | "Sell";
  qtyRq:         string;    // base-currency quantity, already step-rounded, as string
  priceRp:       string;    // limit entry price as string
  stopLossRp:    string;    // SL trigger price as string
  takeProfitRp:  string;    // TP trigger price as string
  clOrdID:       string;    // unique client order id
}

interface OrderResponseData {
  orderID:  string;
  clOrdID?: string;
}

/**
 * Places a USDT-perp limit order with an attached SL/TP bracket.
 * Returns the exchange orderID, or null on failure.
 */
export async function placeOrder(params: PlaceOrderParams): Promise<string | null> {
  const hedgeMode = process.env["PHEMEX_HEDGE_MODE"] === "true";
  const isTestnet = process.env["PHEMEX_TESTNET"] === "true";

  const body: Record<string, string | boolean> = {
    symbol:       params.phemexSymbol,
    clOrdID:      params.clOrdID,
    side:         params.side,
    ordType:      "Limit",
    timeInForce:  "GoodTillCancel",
    orderQtyRq:   params.qtyRq,
    priceRp:      params.priceRp,
    stopLossRp:   params.stopLossRp,
    takeProfitRp: params.takeProfitRp,
    // NOTE: do NOT include slOrdPxRp / tpOrdPxRp — even "0" causes code 39999
    // on linear perp bracket orders. Market execution is the default when these
    // fields are absent.
    // NOTE: triggerType is for conditional/stop orders only — do NOT include it
    // on a plain Limit order with bracket SL/TP. Phemex rejects with code 39999.
    reduceOnly:   false,
  };

  if (hedgeMode) {
    body["posSide"] = params.side === "Buy" ? "Long" : "Short";
  }

  logger.info(
    { ...body, testnet: isTestnet },
    "phemex-trader: placing order",
  );

  try {
    const data = await phemexRequest<OrderResponseData>("POST", "/g-orders", {}, body);
    logger.info(
      { orderID: data.orderID, clOrdID: params.clOrdID, testnet: isTestnet },
      "phemex-trader: order placed",
    );
    return data.orderID;
  } catch (err) {
    logger.warn({ err, params }, "phemex-trader: placeOrder failed");
    return null;
  }
}

/**
 * Cancels a specific open order by its exchange orderID.
 * Ignores errors (order may already be filled/cancelled).
 */
export async function cancelOrder(
  phemexSymbol: string,
  orderId: string,
): Promise<void> {
  try {
    await phemexRequest<unknown>("DELETE", "/g-orders/cancel", {
      orderId,
      symbol: phemexSymbol,
    });
    logger.info({ orderId, phemexSymbol }, "phemex-trader: order cancelled");
  } catch (err) {
    // Ignore — order already filled or cancelled
    logger.info({ err, orderId, phemexSymbol }, "phemex-trader: cancel skipped (likely filled)");
  }
}

/**
 * Cancels ALL open orders for a symbol.
 * Used when a signal flips direction mid-session.
 */
export async function cancelAllOrders(phemexSymbol: string): Promise<void> {
  try {
    await phemexRequest<unknown>("DELETE", "/g-orders/all", {
      symbol: phemexSymbol,
    });
    logger.info({ phemexSymbol }, "phemex-trader: all open orders cancelled");
  } catch (err) {
    logger.warn({ err, phemexSymbol }, "phemex-trader: cancelAllOrders failed");
  }
}
