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
  method: "GET" | "POST" | "PUT" | "DELETE",
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

// ─── Contract specs (minPriceRp cache) ───────────────────────────────────────

interface ContractSpec {
  minPriceRp: number;
  tickSize:   number;
}
const contractSpecCache = new Map<string, ContractSpec>();

/**
 * Fetches all USDT-perp contract specs from the public products endpoint and
 * populates the cache. No auth required. Called once at startup alongside
 * getUSDTBalance. Subsequent placeOrder calls use the cache to clamp priceRp.
 */
export async function fetchContractSpecs(): Promise<void> {
  try {
    const res = await fetch("https://api.phemex.com/public/products", {
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { code: number; data?: { perpProductsV2?: Array<{
      symbol:      string;
      minPriceRp?: string;
      tickSize?:   string;
    }> } };
    const perps = json.data?.perpProductsV2 ?? [];
    for (const p of perps) {
      const min = parseFloat(p.minPriceRp ?? "0");
      const tick = parseFloat(p.tickSize   ?? "0.01");
      if (p.symbol && isFinite(min)) {
        contractSpecCache.set(p.symbol, { minPriceRp: min, tickSize: tick });
      }
    }
    logger.info({ count: contractSpecCache.size }, "phemex-trader: contract specs cached");
  } catch (err) {
    logger.warn({ err }, "phemex-trader: fetchContractSpecs failed — price clamping disabled");
  }
}

/**
 * Returns the minimum allowed order price for a Phemex symbol.
 * 0 when unknown (no clamping applied).
 */
export function getMinPriceRp(symbol: string): number {
  return contractSpecCache.get(symbol)?.minPriceRp ?? 0;
}

// ─── Account ─────────────────────────────────────────────────────────────────

interface AccountData {
  account?: {
    accountBalanceRv?: string;       // wallet balance (realized PnL only)
    totalUnrealisedPnlRv?: string;   // unrealized PnL across all open positions
    freeMarginRv?: string;
    availableBalanceRv?: string;
    userMode?: number;  // 0 = one-way, 1 = hedge (two-way)
  };
  positions?: Array<{
    symbol:              string;
    posSide?:            string;
    side?:               string;
    size?:               string;
    qty?:                string;
    avgEntryPriceRp?:    string;
    stopLossRp?:         string;  // "0" when no SL is attached
    unrealisedPnlRv?:    string;  // per-position unrealized PnL in USDT
  }>;
}

/**
 * Cached hedge-mode detection.
 * null  = not yet detected
 * true  = hedge mode (userMode=1) — posSide required on every order
 * false = one-way mode (userMode=0)
 *
 * The env var PHEMEX_HEDGE_MODE overrides auto-detection when explicitly set.
 */
let detectedHedgeMode: boolean | null = null;

function resolveHedgeMode(): boolean {
  const envOverride = process.env["PHEMEX_HEDGE_MODE"];
  if (envOverride === "true")  return true;
  if (envOverride === "false") return false;
  return detectedHedgeMode ?? false;
}

/**
 * Returns the free USDT margin available for new positions.
 * Also caches the account's position mode (hedge vs one-way) as a side-effect.
 * Returns null on any failure — the caller falls back to the default account size.
 */
export async function getUSDTBalance(): Promise<number | null> {
  try {
    const data = await phemexRequest<AccountData>(
      "GET",
      "/g-accounts/accountPositions",
      { currency: "USDT" },
    );

    // Auto-detect hedge mode once — userMode 1 = hedge (posSide required).
    if (data.account?.userMode !== undefined && detectedHedgeMode === null) {
      detectedHedgeMode = data.account.userMode === 1;
      logger.info(
        { userMode: data.account.userMode, hedgeMode: detectedHedgeMode },
        "phemex-trader: account position mode detected",
      );
    }

    // Total equity = wallet balance + unrealized PnL across open positions.
    // The Phemex UI shows this combined figure. Using wallet-only
    // (accountBalanceRv) causes 2% sizing to drift from what the user expects
    // when open positions have unrealized gains or losses.
    const walletRaw =
      data.account?.accountBalanceRv ??
      data.account?.availableBalanceRv ??
      data.account?.freeMarginRv;
    const wallet     = parseFloat(walletRaw ?? "");
    const unrealised = parseFloat(data.account?.totalUnrealisedPnlRv ?? "0");
    const equity     = wallet + (isFinite(unrealised) ? unrealised : 0);
    if (!isFinite(wallet) || wallet <= 0) {
      logger.warn({ walletRaw, data }, "Phemex balance parse failed — raw value unexpected");
      return null;
    }
    logger.info(
      { walletBalance: wallet, unrealisedPnl: isFinite(unrealised) ? unrealised : 0, totalEquity: equity },
      "phemex-trader: account equity",
    );
    return equity;
  } catch (err) {
    logger.warn({ err }, "getUSDTBalance: request failed");
    return null;
  }
}

/**
 * Returns the orderId of an active (unfilled) limit order for a given
 * symbol+posSide, or null if none exists. Used at order time so that a server
 * restart doesn't place a duplicate entry order when one is already pending on
 * Phemex but openPhemexOrders was wiped.
 */
export async function checkExistingOrder(
  phemexSymbol: string,
  posSide: "Long" | "Short",
): Promise<string | null> {
  try {
    const data = await phemexRequest<{ rows: Array<{ orderID: string; symbol: string; posSide?: string; side?: string; ordStatus: string }> }>(
      "GET",
      "/g-orders/activeList",
      { symbol: phemexSymbol, currency: "USDT" },
    );
    const rows = data?.rows ?? [];
    const match = rows.find(
      o => o.symbol === phemexSymbol &&
           (o.posSide ?? o.side) === posSide &&
           o.ordStatus !== "Cancelled" &&
           o.ordStatus !== "Filled",
    );
    return match?.orderID ?? null;
  } catch (err: unknown) {
    // Phemex returns code 10002 (OM_ORDER_NOT_FOUND) when a symbol has no
    // active orders rather than code 0 + empty rows. This is a valid "no
    // orders" response — return null so the caller proceeds normally.
    if ((err as { phemexCode?: number }).phemexCode === 10002) {
      return null;
    }
    logger.warn({ err, phemexSymbol, posSide }, "phemex-trader: checkExistingOrder failed — skipping order (safe default)");
    throw err;
  }
}

/**
 * Returns the existing open position size (non-zero) for a given symbol+side,
 * or null if no position exists. Used at order time to detect positions that
 * survived a server restart (openPhemexOrders was wiped but Phemex still holds
 * the position) so the catch-up block doesn't double-enter them.
 */
export async function checkExistingPosition(
  phemexSymbol: string,
  posSide: "Long" | "Short",
): Promise<{ size: number; stopLossRp: number; markPrice: number } | null> {
  try {
    const data = await phemexRequest<AccountData>(
      "GET",
      "/g-accounts/accountPositions",
      { currency: "USDT" },
    );
    const match = (data.positions ?? []).find(
      p => p.symbol === phemexSymbol &&
           (p.posSide ?? p.side) === posSide &&
           parseFloat(p.size ?? p.qty ?? "0") !== 0,
    );
    if (!match) return null;
    return {
      size:        parseFloat(match.size ?? match.qty ?? "0"),
      stopLossRp:  parseFloat(match.stopLossRp ?? "0"),
      markPrice:   parseFloat((match as Record<string, string>)["markPriceRp"] ?? match.avgEntryPriceRp ?? "0"),
    };
  } catch (err) {
    // Re-throw so the caller treats an API failure as "unknown, skip order"
    // rather than "no position, proceed" — prevents double-entry on Phemex errors.
    logger.warn({ err, phemexSymbol, posSide }, "phemex-trader: checkExistingPosition failed — skipping order (safe default)");
    throw err;
  }
}

export interface OpenPhemexPosition {
  phemexSymbol:   string;
  posSide:        "Long" | "Short";
  size:           number;
  entryPrice:     number;
  stopLossRp:     number;
  unrealisedPnl:  number;
}

/**
 * Returns all open USDT-perp positions on the account (size > 0).
 * Used at startup to detect positions not tracked by openPhemexOrders.
 * Never throws — returns [] on any API failure.
 */
export async function getAllOpenPhemexPositions(): Promise<OpenPhemexPosition[]> {
  try {
    const data = await phemexRequest<AccountData>(
      "GET",
      "/g-accounts/accountPositions",
      { currency: "USDT" },
    );
    const result: OpenPhemexPosition[] = [];
    for (const p of data.positions ?? []) {
      const size = parseFloat(p.size ?? p.qty ?? "0");
      if (!isFinite(size) || size === 0) continue;
      const rawPosSide = p.posSide ?? p.side ?? "";
      if (rawPosSide !== "Long" && rawPosSide !== "Short") continue;
      result.push({
        phemexSymbol:  p.symbol,
        posSide:       rawPosSide as "Long" | "Short",
        size,
        entryPrice:    parseFloat(p.avgEntryPriceRp ?? "0"),
        stopLossRp:    parseFloat(p.stopLossRp ?? "0"),
        unrealisedPnl: parseFloat(p.unrealisedPnlRv ?? "0"),
      });
    }
    return result;
  } catch (err) {
    logger.warn({ err }, "phemex-trader: getAllOpenPhemexPositions failed");
    return [];
  }
}

/**
 * Market-closes a position immediately (reduce-only Market IOC).
 * Used by the profit-lock mechanism to exit when unrealized PnL hits the target.
 */
export async function marketClosePosition(params: {
  phemexSymbol: string;
  posSide:      "Long" | "Short";
  qtyRq:        string;
}): Promise<string | null> {
  const hedgeMode = resolveHedgeMode();
  const closeSide = params.posSide === "Long" ? "Sell" : "Buy";
  const clOrdID   = `phx-plock-${Date.now()}`;
  const body: Record<string, string | boolean> = {
    symbol:      params.phemexSymbol,
    clOrdID,
    side:        closeSide,
    ordType:     "Market",
    timeInForce: "ImmediateOrCancel",
    orderQtyRq:  params.qtyRq,
    reduceOnly:  true,
  };
  if (hedgeMode) body["posSide"] = params.posSide;
  try {
    logger.info({ ...params, clOrdID }, "phemex-trader: profit-lock market close");
    const result = await phemexRequest<{ data: { orderID?: string } }>("POST", "/g-orders", undefined, body);
    return result?.data?.orderID ?? clOrdID;
  } catch (err) {
    logger.warn({ err, ...params }, "phemex-trader: profit-lock market close failed");
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
  takeProfitRp?: string;    // TP trigger price as string (omit to skip bracket TP)
  clOrdID:       string;    // unique client order id
}

interface OrderResponseData {
  orderID:  string;
  clOrdID?: string;
}

/**
 * Sets the leverage for a USDT-perp symbol on Phemex before placing an order.
 * This ensures the exchange actually uses the leverage the sizing math assumed.
 * Silently skips on failure — the order will still be placed at whatever
 * leverage Phemex currently has for the symbol.
 */
export async function setSymbolLeverage(
  phemexSymbol: string,
  leverage: number,
): Promise<void> {
  const lev = leverage.toFixed(0);
  const hedgeMode = resolveHedgeMode();

  // Step 1: switch to cross margin and set leverage in one call.
  // Isolated margin blocks the regular /g-positions/leverage endpoint (code 39108),
  // so we always switch to cross first. /g-positions/switch-isolated with
  // isolated=false handles both margin-mode change + leverage in a single request.
  // Phemex endpoint uses query params (not body) — body sends cause code 10500.
  if (hedgeMode) {
    const switchQuery: Record<string, string> = {
      symbol: phemexSymbol,
      isolated: "false",
      longLeverageRq: lev,
      shortLeverageRq: lev,
    };
    try {
      await phemexRequest<unknown>("PUT", "/g-positions/switch-isolated", switchQuery);
      logger.info({ phemexSymbol, leverage }, "phemex-trader: switched to cross + leverage set");
      return;
    } catch (switchErr) {
      logger.warn({ err: switchErr, phemexSymbol, leverage }, "phemex-trader: switch-isolated failed, falling back to /g-positions/leverage");
    }
  }

  // Step 2: fallback — direct leverage set (works for cross margin or one-way mode).
  const query: Record<string, string> = hedgeMode
    ? { symbol: phemexSymbol, longLeverageRq: lev, shortLeverageRq: lev }
    : { symbol: phemexSymbol, leverageRq: lev };
  try {
    await phemexRequest<unknown>("PUT", "/g-positions/leverage", query);
    logger.info({ phemexSymbol, leverage }, "phemex-trader: leverage set");
  } catch (err) {
    logger.warn({ err, phemexSymbol, leverage }, "phemex-trader: setSymbolLeverage failed — order will use existing account leverage");
  }
}

/**
 * Places a USDT-perp limit order with an attached SL/TP bracket.
 * Returns the exchange orderID, or null on failure.
 */
export async function placeOrder(params: PlaceOrderParams): Promise<string | null> {
  const hedgeMode = resolveHedgeMode();
  const isTestnet = process.env["PHEMEX_TESTNET"] === "true";

  const rawPrice = parseFloat(params.priceRp);
  const minPrice = getMinPriceRp(params.phemexSymbol);
  const spec     = contractSpecCache.get(params.phemexSymbol);

  // If contract specs are loaded but this symbol isn't in them, it's not a
  // listed Phemex perp — skip immediately rather than getting code 39999.
  if (contractSpecCache.size > 0 && !spec) {
    logger.warn(
      { symbol: params.phemexSymbol },
      "phemex-trader: symbol not in contract spec cache — not a listed Phemex perp, skipping",
    );
    return null;
  }

  const tickSize = spec?.tickSize ?? 0.01;
  const pxPrec   = Math.max(0, -Math.floor(Math.log10(tickSize)));

  // Price-floor handling differs by side:
  //   BUY  — clamp UP to minPriceRp. A limit BUY above market fills immediately
  //           as a taker at the real market price. ✓
  //   SELL — clamping UP does NOT help: a limit SELL above market sits resting
  //           waiting for price to rise, and Phemex rejects it because SL
  //           (above signal entry) is below the clamped limit price
  //           (TE_SELL_SL_SHOULD_GT_BASE). Use a Market IOC order instead so
  //           the SELL fills at the current bid immediately.
  const belowFloor = minPrice > 0 && rawPrice < minPrice;
  const useMarket  = belowFloor && params.side === "Sell";
  const clampedPrice = (!useMarket && belowFloor)
    ? minPrice.toFixed(pxPrec)
    : params.priceRp;

  if (useMarket) {
    logger.info(
      { symbol: params.phemexSymbol, signalEntry: rawPrice, minPriceRp: minPrice },
      "phemex-trader: SELL below minPriceRp — using Market IOC",
    );
  } else if (clampedPrice !== params.priceRp) {
    logger.info(
      { symbol: params.phemexSymbol, signalEntry: rawPrice, clampedTo: clampedPrice, minPriceRp: minPrice },
      "phemex-trader: priceRp clamped to minPriceRp — will fill at market",
    );
  }

  const body: Record<string, string | boolean> = {
    symbol:       params.phemexSymbol,
    clOrdID:      params.clOrdID,
    side:         params.side,
    ordType:      useMarket ? "Market" : "Limit",
    timeInForce:  useMarket ? "ImmediateOrCancel" : "GoodTillCancel",
    orderQtyRq:   params.qtyRq,
    stopLossRp:   params.stopLossRp,
    // NOTE: do NOT include slOrdPxRp / tpOrdPxRp — even "0" causes code 39999
    // on linear perp bracket orders. Market execution is the default when these
    // fields are absent.
    // NOTE: triggerType is for conditional/stop orders only — do NOT include it
    // on a plain Limit order with bracket SL/TP. Phemex rejects with code 39999.
    reduceOnly:   false,
  };
  // Market orders must not include priceRp.
  if (!useMarket) {
    body["priceRp"] = clampedPrice;
  }
  // Bracket TP is optional — omit when using separate reduce-only TP limit orders.
  if (params.takeProfitRp !== undefined) {
    body["takeProfitRp"] = params.takeProfitRp;
  }

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
 * Cancels all resting reduce-only Limit orders for a given symbol+side.
 * Called before re-placing split-TP orders on restart to prevent duplicate
 * close orders stacking across server restarts.
 */
export async function cancelExistingTpOrders(
  phemexSymbol: string,
  posSide: "Long" | "Short",
): Promise<void> {
  try {
    const data = await phemexRequest<{ rows: Array<Record<string, unknown>> }>(
      "GET", "/g-orders/activeList", { symbol: phemexSymbol },
    );
    const tpOrders = (data.rows ?? []).filter(
      o => o["orderType"] === "Limit" && o["execInst"] === "ReduceOnly",
    ).filter(o => {
      const derivedPosSide = o["side"] === "Buy" ? "Short" : "Long";
      return derivedPosSide === posSide;
    });
    if (tpOrders.length === 0) return;
    logger.info(
      { phemexSymbol, posSide, count: tpOrders.length },
      "phemex-trader: cancelling stale TP limit orders before placing new ones",
    );
    await Promise.all(
      tpOrders.map(o =>
        cancelOrder(phemexSymbol, o["orderID"] as string, posSide),
      ),
    );
  } catch (err) {
    logger.warn({ err, phemexSymbol, posSide }, "phemex-trader: cancelExistingTpOrders failed (non-fatal)");
  }
}

/**
 * Cancels all resting reduce-only Stop orders for a given symbol+side.
 * Called before placing a new protective SL to prevent stacking duplicate
 * stop-market orders across server restarts.
 */
export async function cancelExistingStopOrders(
  phemexSymbol: string,
  posSide: "Long" | "Short",
): Promise<void> {
  try {
    const data = await phemexRequest<{ rows: Array<Record<string, unknown>> }>(
      "GET", "/g-orders/activeList", { symbol: phemexSymbol },
    );
    // Phemex activeList uses "orderType" (not "ordType") and "execInst" (not
    // "reduceOnly"). The order row has no "posSide" field — derive it from
    // the order side: a Buy-side reduce-only Stop closes a Short position;
    // a Sell-side reduce-only Stop closes a Long position.
    const stopOrders = (data.rows ?? []).filter(
      o => o["orderType"] === "Stop" && o["execInst"] === "ReduceOnly",
    ).filter(o => {
      const derivedPosSide = o["side"] === "Buy" ? "Short" : "Long";
      return derivedPosSide === posSide;
    });
    if (stopOrders.length === 0) return;
    logger.info(
      { phemexSymbol, posSide, count: stopOrders.length },
      "phemex-trader: cancelling stale SL stop orders before placing new one",
    );
    await Promise.all(
      stopOrders.map(o =>
        cancelOrder(phemexSymbol, o["orderID"] as string, posSide),
      ),
    );
  } catch (err) {
    // Non-fatal — worst case we place one more duplicate stop, which is benign
    logger.warn({ err, phemexSymbol, posSide }, "phemex-trader: cancelExistingStopOrders failed (non-fatal)");
  }
}

/**
 * Places a stop-market reduce-only order to protect an already-open position
 * that has no stop loss attached (e.g. SL bracket was silently dropped, or the
 * position was opened before bracket support was added).
 * Returns the exchange orderID, or null on failure.
 */
export async function placeStopOrder(params: {
  phemexSymbol: string;
  posSide:      "Long" | "Short";
  stopPx:       number;
  qtyRq:        string;
  pxDecimals:   number;
}): Promise<string | null> {
  const hedgeMode = resolveHedgeMode();
  // To close a Long, we Sell; to close a Short, we Buy.
  const side: "Buy" | "Sell" = params.posSide === "Long" ? "Sell" : "Buy";
  const clOrdID = `phx-sl-${params.phemexSymbol}-${Date.now()}`;

  const body: Record<string, string | boolean> = {
    symbol:      params.phemexSymbol,
    clOrdID,
    side,
    ordType:     "Stop",
    timeInForce: "GoodTillCancel",
    orderQtyRq:  params.qtyRq,
    stopPxRp:    params.stopPx.toFixed(params.pxDecimals),
    triggerType: "ByLastPrice",
    reduceOnly:  true,
  };
  if (hedgeMode) {
    body["posSide"] = params.posSide;
  }

  logger.info({ ...body }, "phemex-trader: placing stop-market for unprotected position");

  try {
    const data = await phemexRequest<OrderResponseData>("POST", "/g-orders", {}, body);
    logger.info({ orderID: data.orderID, clOrdID }, "phemex-trader: stop-market placed");
    return data.orderID;
  } catch (err) {
    logger.warn({ err, params }, "phemex-trader: placeStopOrder failed");
    return null;
  }
}

/**
 * Places a reduce-only GTC limit order to close part of an open position.
 * Used for split-TP: two separate half-qty limit orders at TP1 and TP2 instead
 * of a single bracket TP that would close the full position.
 */
export async function placeLimitClose(params: {
  phemexSymbol: string;
  posSide:      "Long" | "Short";
  priceRp:      string;
  qtyRq:        string;
  clOrdID:      string;
}): Promise<string | null> {
  const hedgeMode = resolveHedgeMode();
  // Close direction is opposite to position direction.
  const side: "Buy" | "Sell" = params.posSide === "Long" ? "Sell" : "Buy";
  const body: Record<string, string | boolean> = {
    symbol:      params.phemexSymbol,
    clOrdID:     params.clOrdID,
    side,
    ordType:     "Limit",
    timeInForce: "GoodTillCancel",
    orderQtyRq:  params.qtyRq,
    priceRp:     params.priceRp,
    reduceOnly:  true,
  };
  if (hedgeMode) {
    body["posSide"] = params.posSide;
  }
  logger.info({ ...body }, "phemex-trader: placing reduce-only TP limit close");
  try {
    const data = await phemexRequest<OrderResponseData>("POST", "/g-orders", {}, body);
    logger.info({ orderID: data.orderID, clOrdID: params.clOrdID }, "phemex-trader: TP limit close placed");
    return data.orderID;
  } catch (err) {
    logger.warn({ err, params }, "phemex-trader: placeLimitClose failed");
    return null;
  }
}

/**
 * Cancels a specific open order by its exchange orderID.
 * In hedge mode, posSide must be supplied or Phemex rejects the cancel.
 * Ignores errors (order may already be filled/cancelled).
 */
export async function cancelOrder(
  phemexSymbol: string,
  orderId: string,
  posSide?: "Long" | "Short",
): Promise<void> {
  const query: Record<string, string> = { orderID: orderId, symbol: phemexSymbol };
  if (resolveHedgeMode() && posSide) {
    query["posSide"] = posSide;
  }
  try {
    await phemexRequest<unknown>("DELETE", "/g-orders/cancel", query);
    logger.info({ orderId, phemexSymbol, posSide }, "phemex-trader: order cancelled");
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
