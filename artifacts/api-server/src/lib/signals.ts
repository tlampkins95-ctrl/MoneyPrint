import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SYMBOLS, makeRounder, type Symbol } from "./symbols";
import { type CandleRaw, type Timeframe } from "./yahoo-fetch";
import { fetchOkxPerpPrice, fetchPhemexPerpPrice } from "./crypto-perp-fetch";
import { fetchPythPrice } from "./pyth-fetch";

// ─── Live spot price (per-symbol cache) ──────────────────────────────────────

interface SpotCacheEntry {
  price: number;
  timestamp: number;
}
const spotCache = new Map<Symbol, SpotCacheEntry>();
const SPOT_CACHE_TTL_MS = 30 * 1000;

async function fetchFromTradingView(symbol: Symbol): Promise<number | null> {
  try {
    const path = SYMBOLS[symbol].tvScrapePath;
    const response = await fetch(`https://www.tradingview.com${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(/"close":"([0-9.]+)"/);
    if (!match) return null;
    const price = parseFloat(match[1]);
    return isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

async function fetchFromGoldApi(symbol: Symbol): Promise<number | null> {
  const goldApi = SYMBOLS[symbol].goldApi;
  if (!goldApi) return null;
  try {
    const response = await fetch(`https://api.gold-api.com/price/${goldApi}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { price: number };
    return typeof json.price === "number" && isFinite(json.price) ? json.price : null;
  } catch {
    return null;
  }
}

async function fetchFromOkxPerp(symbol: Symbol): Promise<number | null> {
  const perp = SYMBOLS[symbol].okxPerp;
  if (!perp) return null;
  return fetchOkxPerpPrice(perp);
}

async function fetchFromPhemexPerp(symbol: Symbol): Promise<number | null> {
  const perp = SYMBOLS[symbol].phemexPerp;
  if (!perp) return null;
  return fetchPhemexPerpPrice(perp);
}

async function fetchFromPhemexSpot(symbol: Symbol): Promise<number | null> {
  const meta = SYMBOLS[symbol];
  const spotSym = meta.phemexSpot;
  const scale = meta.phemexSpotPriceScale;
  if (!spotSym || !scale) return null;
  try {
    const response = await fetch(
      `https://api.phemex.com/md/spot/ticker/24hr?symbol=${spotSym}`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { result?: { lastEp?: number } };
    const ep = json.result?.lastEp;
    if (typeof ep !== "number" || !isFinite(ep) || ep <= 0) return null;
    const price = ep / Math.pow(10, scale);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchFromPyth(symbol: Symbol): Promise<number | null> {
  const feedId = SYMBOLS[symbol].pythFeedId;
  if (!feedId) return null;
  return fetchPythPrice(feedId);
}

async function fetchFromCoinbase(symbol: Symbol): Promise<number | null> {
  const pair = SYMBOLS[symbol].coinbase;
  if (!pair) return null;
  try {
    const response = await fetch(
      `https://api.coinbase.com/v2/prices/${pair}/spot`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: { amount?: string } };
    const raw = json.data?.amount;
    if (typeof raw !== "string") return null;
    const price = parseFloat(raw);
    return isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function fetchSpotPrice(symbol: Symbol): Promise<number | null> {
  const now = Date.now();
  const cached = spotCache.get(symbol);
  if (cached && now - cached.timestamp < SPOT_CACHE_TTL_MS) {
    return cached.price;
  }
  // Price cascade (most authoritative first):
  //  • Phemex spot  — primary for spot tokens (e.g. SKYAI), matches chart exactly
  //  • Phemex perp  — primary for USDT perps (BTC/ETH), matches PHEMEX:BTCUSDT chart
  //  • Pyth oracle  → OKX perp → Coinbase spot → TradingView scrape (fallbacks)
  //  • GoldAPI      — only relevant source for metals (XAG/XAU)
  const price =
    (await fetchFromPhemexSpot(symbol)) ??
    (await fetchFromPhemexPerp(symbol)) ??
    (await fetchFromPyth(symbol)) ??
    (await fetchFromOkxPerp(symbol)) ??
    (await fetchFromCoinbase(symbol)) ??
    (await fetchFromTradingView(symbol)) ??
    (await fetchFromGoldApi(symbol));
  if (price !== null) {
    spotCache.set(symbol, { price, timestamp: now });
    return price;
  }
  return cached?.price ?? null;
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function calcPivots(high: number, low: number, close: number, round: (n: number) => number) {
  const pivot = (high + low + close) / 3;
  return {
    pivot: round(pivot),
    r1: round(2 * pivot - low),
    r2: round(pivot + (high - low)),
    r3: round(high + 2 * (pivot - low)),
    s1: round(2 * pivot - high),
    s2: round(pivot - (high - low)),
    s3: round(low - 2 * (high - pivot)),
  };
}

function calcFibLevels(swingHigh: number, swingLow: number, round: (n: number) => number) {
  const range = swingHigh - swingLow;
  return {
    fib236: round(swingHigh - range * 0.236),
    fib382: round(swingHigh - range * 0.382),
    fib500: round(swingHigh - range * 0.5),
    fib618: round(swingHigh - range * 0.618),
    fib786: round(swingHigh - range * 0.786),
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
  };
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return result;
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcATR(candles: CandleRaw[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  const slice = trs.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function findSwingHighLow(candles: CandleRaw[], lookback = 60) {
  const slice = candles.slice(-lookback);
  return {
    swingHigh: Math.max(...slice.map((c) => c.high)),
    swingLow: Math.min(...slice.map((c) => c.low)),
  };
}

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "15m": "15-minute",
  "30m": "30-minute",
  "1h": "1-hour",
  "1d": "daily",
};

// Minimum R-multiple targets. The structural target (pivot, opposite zone) is
// kept when it is further from entry than these floors; otherwise the target
// is pushed out so a winning trade always pays at least this many R.
export const MIN_RR_TP1 = 1.5;
export const MIN_RR_TP2 = 2.5;

// ─── Position sizing ─────────────────────────────────────────────────────────
// Defaults assume a $500 starting account, 1% risk per trade, Phemex USDT
// perps envelope ($1 min collateral floor, 100× leverage cap), and MT5 micro
// lots (0.01).
export const DEFAULT_ACCOUNT_SIZE = 500;
export const DEFAULT_RISK_PCT = 0.01;
// Phemex USDT-perps have no fixed minimum collateral and allow up to 100×.
// Pick a $1 floor so the "achievable" block stays sane for tiny trades but
// effectively never triggers OVER-SIZED on Phemex (was $10 on Jupiter).
export const DEFAULT_MIN_COLLATERAL = 1;
export const DEFAULT_MAX_LEVERAGE = 100;
export const DEFAULT_MT5_LOTS = 0.01;

// ─── MT5 lot sizing helpers ──────────────────────────────────────────────────
// Standard MT5 contract sizes per symbol class:
//   * Forex: 1 lot = 100,000 base units
//   * XAUUSD (gold): 1 lot = 100 oz
//   * XAGUSD (silver): 1 lot = 5,000 oz
// USD P&L per 1.0 price-unit move per 1.0 lot depends on the quote currency:
//   * X/USD pairs (EUR/GBP/AUD/XAU/XAG): contractSize directly (USD = base × USD/base)
//   * USD/X pairs (USDJPY): contractSize / entry (convert JPY back to USD using live entry)
//   * Cross JPY pairs (GBPJPY): contractSize / liveUsdJpy (read from spotCache;
//       fallback to 150 only on cold start before USDJPY has been fetched once.
//       USDJPY is one of the 9 tracked symbols so this cache is normally warm.)
const USDJPY_FALLBACK = 150;

function getUsdJpyRate(): { rate: number; live: boolean } {
  const cached = spotCache.get("USDJPY");
  if (cached && Number.isFinite(cached.price) && cached.price > 0) {
    return { rate: cached.price, live: true };
  }
  return { rate: USDJPY_FALLBACK, live: false };
}

function mt5ContractSize(symbol: Symbol): { size: number; unit: string } {
  if (symbol === "XAUUSD") return { size: 100, unit: "oz" };
  if (symbol === "XAGUSD") return { size: 5000, unit: "oz" };
  return { size: 100_000, unit: symbol.slice(0, 3) }; // EUR/GBP/AUD/USD
}

function mt5UsdPerPriceUnitPerLot(symbol: Symbol, entry: number): number {
  const { size } = mt5ContractSize(symbol);
  if (symbol === "USDJPY") return entry > 0 ? size / entry : 0;
  if (symbol === "GBPJPY") return size / getUsdJpyRate().rate;
  return size; // EURUSD, GBPUSD, AUDUSD, XAUUSD, XAGUSD
}

interface MT5Sizing {
  lots: number;
  contractSize: number;
  positionSize: number;
  positionSizeUnit: string;
  notional: number;
  pnlAtSL: number;
  pnlAtTP1: number;
  pnlAtTP2: number;
  riskPctOfAccount: number;
  recommendedLots: number;
  recommendedTargetRiskPct: number;
}

// Lots that risk approximately `targetRiskPct` of `accountSize` on SL hit.
// Floored to a 0.01 increment so the user can place exactly that size on
// MT5 (which rounds at micro-lot granularity), and clamped to [0.01, 100].
function computeRecommendedLots(
  lossUsdPerLot: number,
  accountSize: number,
  targetRiskPct: number,
): number {
  if (lossUsdPerLot <= 0 || accountSize <= 0 || targetRiskPct <= 0) return 0.01;
  const targetRiskUsd = (targetRiskPct / 100) * accountSize;
  const ideal = targetRiskUsd / lossUsdPerLot;
  const floored = Math.floor(ideal * 100) / 100;
  return Math.min(100, Math.max(0.01, floored));
}

function computeMT5Sizing(
  symbol: Symbol,
  lots: number,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  accountSize: number,
  riskPct: number,
): MT5Sizing {
  const { size, unit } = mt5ContractSize(symbol);
  const usdPerUnit = mt5UsdPerPriceUnitPerLot(symbol, entry);
  const slDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfit1 - entry);
  const tp2Dist = Math.abs(takeProfit2 - entry);
  const positionSize = lots * size;
  // USD notional = USD-per-price-unit × entry × lots, which works for every
  // class above (X/USD, USD/X, JPY-cross, metals) because usdPerUnit already
  // bakes in the quote-currency conversion.
  const notional = usdPerUnit * entry * lots;
  const lossUsdPerLot = slDist * usdPerUnit;
  const lossUsd = lossUsdPerLot * lots;
  const targetRiskPct = riskPct * 100; // riskPct comes in as 0.01 = 1%
  const recommendedLots = computeRecommendedLots(
    lossUsdPerLot,
    accountSize,
    targetRiskPct,
  );
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    lots: r(lots, 2),
    contractSize: size,
    positionSize: r(positionSize, 2),
    positionSizeUnit: unit,
    notional: r(notional),
    pnlAtSL: r(-lossUsd),
    pnlAtTP1: r(tp1Dist * usdPerUnit * lots),
    pnlAtTP2: r(tp2Dist * usdPerUnit * lots),
    riskPctOfAccount: r((lossUsd / accountSize) * 100, 2),
    recommendedLots: r(recommendedLots, 2),
    recommendedTargetRiskPct: r(targetRiskPct, 2),
  };
}

interface AchievablePosition {
  positionSize: number;
  notional: number;
  collateral: number;
  leverage: number;
  actualRiskAmount: number;
  actualRiskPct: number;
  pnlAtSL: number;
  pnlAtTP1: number;
  pnlAtTP2: number;
  belowMinimum: boolean;
  warning?: string;
}

interface SpotTokenSizing {
  tokenCount: number;
  tokenSymbol: string;
  notional: number;
  riskAmount: number;
  riskPct: number;
  pnlAtSL: number;
  pnlAtTP1: number;
  pnlAtTP2: number;
}

interface PositionSizing {
  venue: "PHEMEX" | "MT5" | "PHEMEX_SPOT";
  accountSize: number;
  riskAmount: number;
  riskPct: number;
  positionSize: number;
  positionSizeUnit: string;
  notional: number;
  leverage?: number;
  leverageNote?: string;
  lots?: { standard: number; mini: number; micro: number };
  achievable?: AchievablePosition;
  mt5?: MT5Sizing;
  spotToken?: SpotTokenSizing;
}

// Compute the "achievable" position given exchange constraints.
//
// Two flavors of exchange floor:
//   • Phemex (minQty/qtyStep): contract-based — BTCUSDT trades in 0.001 BTC
//     increments, ETHUSDT in 0.01. The binding minimum is `minQty × entry`
//     dollars of notional, NOT a fixed collateral. We round qty DOWN to the
//     step (a small under-allocation), and if it lands below minQty we force
//     it up to minQty (the OVER-SIZED case). Forced trades take maxLev so
//     collateral stays tiny — Phemex doesn't require $X locked, only ≥1
//     contract worth of notional.
//   • Legacy ($ minCollateral floor, e.g. Jupiter): notional must clear a
//     fixed dollar amount. Forced over-sized trades use 1× at the floor.
//
// In both flavors the scale-factor approach lets us scale risk & dollar P&L
// proportionally without per-asset math, since ideal P&L = riskAmount × R.
function computeAchievable(
  ideal: { positionSize: number; notional: number; positionSizeUnit: string },
  riskAmount: number,
  accountSize: number,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  minCollateral: number,
  maxLeverage: number,
  minQty?: number,
  qtyStep?: number,
): AchievablePosition {
  const slDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfit1 - entry);
  const tp2Dist = Math.abs(takeProfit2 - entry);
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const usePhemexFloor = minQty != null && qtyStep != null && minQty > 0 && qtyStep > 0;
  // Defensive: maxLeverage=0 would divide by zero downstream. Routes clamp
  // ≥1 today, but belt-and-braces here so the helper is safe in isolation.
  const safeMaxLev = Math.max(1, maxLeverage);

  // ─── Step 1: determine actual position size (qty-stepped or scaled) ──
  let actualPosition: number;
  let scaleFactor = 1;
  let belowMinimum = false;

  if (ideal.notional <= 0 || ideal.positionSize <= 0) {
    // Degenerate ideal — zero out everything so risk/PnL outputs match the
    // (zero) position. Without scaleFactor=0 the function would still report
    // a non-zero actualRiskAmount = riskAmount × 1.
    actualPosition = 0;
    scaleFactor = 0;
  } else if (usePhemexFloor) {
    // Snap to step with a small epsilon so an exact multiple like
    // 0.05 / 0.001 doesn't dip to 0.049 due to IEEE-754 precision (qtyStep
    // is typically 0.001 or 0.01 — both representable, but their quotients
    // aren't always). Epsilon = 1e-9 of the step is well below any real
    // exchange granularity.
    const eps = qtyStep! * 1e-9;
    const stepped = Math.floor(ideal.positionSize / qtyStep! + eps) * qtyStep!;
    if (stepped < minQty!) {
      // Below 1 contract → forced to minQty (OVER-SIZED, scaleFactor > 1).
      actualPosition = minQty!;
      belowMinimum = true;
    } else {
      // Round-down to step (slight under-risk, scaleFactor ≤ 1).
      actualPosition = stepped;
    }
    scaleFactor = actualPosition / ideal.positionSize;
  } else {
    // Legacy $-floor path
    belowMinimum = ideal.notional < minCollateral;
    if (belowMinimum) {
      scaleFactor = minCollateral / ideal.notional;
      actualPosition = ideal.positionSize * scaleFactor;
    } else {
      actualPosition = ideal.positionSize;
    }
  }

  const actualNotional = actualPosition * entry;
  const actualRiskAmount = riskAmount * scaleFactor;

  // ─── Step 2: determine collateral / leverage from actual notional ────
  let collateral: number;
  let leverage: number;
  let warning: string | undefined;

  if (ideal.notional <= 0) {
    collateral = minCollateral;
    leverage = 1;
    warning = `Cannot compute achievable position — ideal notional is zero.`;
  } else if (belowMinimum && usePhemexFloor) {
    // Phemex over-sized: forced to 1 contract, and Phemex's exchange
    // collateral floor is `entry × minQty` (the full notional of one min
    // contract — ~$78 for BTC, ~$30 for ETH). At that floor leverage is 1×.
    collateral = entry * minQty!;
    leverage = 1;
    const overPct = Math.round((scaleFactor - 1) * 100);
    warning =
      `Ideal position smaller than Phemex contract minimum ` +
      `(${minQty} ${ideal.positionSizeUnit} ≈ $${actualNotional.toFixed(2)}) — ` +
      `forced ${overPct}% over-sized.`;
  } else if (belowMinimum) {
    // Legacy $-floor: forced to minCollateral at 1×.
    collateral = minCollateral;
    leverage = 1;
    const overPct = Math.round((scaleFactor - 1) * 100);
    const parts = [`Ideal position too small for $${minCollateral} min collateral — forced ${overPct}% over-sized.`];
    if (collateral > accountSize) {
      parts.push(`Min collateral $${minCollateral} exceeds account $${accountSize}.`);
    }
    warning = parts.join(" ");
  } else if (usePhemexFloor) {
    // CASE A/B (Phemex): Phemex's exchange-enforced collateral floor is
    // `entry × minQty` — the notional of one minimum contract (~$78 for
    // BTC at $78k, ~$30 for ETH at $3k). Use maxLev unless that would
    // dip below the floor, in which case pin collateral to the floor and
    // back-solve leverage. This matches what Phemex actually requires
    // when you place the order.
    const phemexMinCol = entry * minQty!;
    const requiredCollateralAtMaxLev = actualNotional / safeMaxLev;
    if (requiredCollateralAtMaxLev >= phemexMinCol) {
      collateral = requiredCollateralAtMaxLev;
      leverage = safeMaxLev;
    } else {
      collateral = phemexMinCol;
      leverage = actualNotional / phemexMinCol;
    }
    if (collateral > accountSize) {
      warning = `Required collateral $${collateral.toFixed(2)} exceeds account $${accountSize}.`;
    }
  } else {
    // CASE A/B (legacy $-floor venues): respect minCollateral as a floor.
    const requiredCollateralAtMaxLev = actualNotional / safeMaxLev;
    if (requiredCollateralAtMaxLev >= minCollateral) {
      collateral = requiredCollateralAtMaxLev;
      leverage = safeMaxLev;
    } else {
      collateral = minCollateral;
      leverage = actualNotional / minCollateral;
    }
    if (collateral > accountSize) {
      warning = `Required collateral $${collateral.toFixed(2)} exceeds account $${accountSize}.`;
    }
  }

  // ─── Step 3: P&L direct from actual position × distance ──────────────
  // Equivalent to the legacy `(riskAmount / slDist) × dist × scaleFactor`
  // since actualPosition × slDist = actualRiskAmount, but expressed
  // directly so qty-stepped Phemex sizes round-trip cleanly.
  return {
    positionSize: r(actualPosition, 6),
    notional: r(actualNotional),
    collateral: r(collateral, 2),
    leverage: r(leverage, 1),
    actualRiskAmount: r(actualRiskAmount),
    actualRiskPct: r((actualRiskAmount / accountSize) * 100, 2),
    pnlAtSL: r(-actualRiskAmount),
    pnlAtTP1: r(actualPosition * tp1Dist),
    pnlAtTP2: r(actualPosition * tp2Dist),
    belowMinimum,
    warning,
  };
}

function computePositionSizing(
  symbol: Symbol,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  accountSize: number = DEFAULT_ACCOUNT_SIZE,
  riskPct: number = DEFAULT_RISK_PCT,
  minCollateral: number = DEFAULT_MIN_COLLATERAL,
  maxLeverage: number = DEFAULT_MAX_LEVERAGE,
  mt5Lots: number = DEFAULT_MT5_LOTS,
): PositionSizing | undefined {
  const slDist = Math.abs(entry - stopLoss);
  if (!isFinite(slDist) || slDist <= 0 || !isFinite(entry) || entry <= 0) return undefined;

  const riskAmount = accountSize * riskPct;
  const meta = SYMBOLS[symbol];
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

  // ─── Crypto perps (BTC, ETH) — venue: PHEMEX (USDT-margined linear perps) ───
  if (meta.okxPerp) {
    const positionSize = riskAmount / slDist; // coin units
    const notional = positionSize * entry;
    const leverage = Math.max(1, Math.ceil(notional / accountSize));
    let leverageNote: string | undefined;
    // Phemex USDT-perps cap at 100× — bands tuned for that envelope.
    if (leverage > 50) leverageNote = "Required leverage > 50x — high liquidation risk on volatile prints. Consider a larger account.";
    else if (leverage > 25) leverageNote = "High leverage — keep meaningful free margin to absorb wicks.";
    else if (leverage > 10) leverageNote = "Moderate-high leverage — keep extra margin in reserve.";
    const unit = symbol === "BTCUSD" ? "BTC" : "ETH";
    return {
      venue: "PHEMEX",
      accountSize: r(accountSize),
      riskAmount: r(riskAmount),
      riskPct: r(riskPct * 100, 2),
      positionSize: r(positionSize, 6),
      positionSizeUnit: unit,
      notional: r(notional),
      leverage,
      leverageNote,
      achievable: computeAchievable(
        { positionSize, notional, positionSizeUnit: unit },
        riskAmount,
        accountSize,
        entry,
        stopLoss,
        takeProfit1,
        takeProfit2,
        minCollateral,
        maxLeverage,
        meta.phemexMinQty,
        meta.phemexQtyStep,
      ),
    };
  }

  // ─── Metals (XAG, XAU) — venue: MT5 ───
  // OANDA std lot conventions: XAG = 5,000 oz, XAU = 100 oz. SL distance is
  // already in $/oz so risk_$ = ozHeld × slDist exactly. We still emit the
  // risk-budget-derived sizing for context, but the AUTHORITATIVE block for
  // MT5 venue is `mt5` (lots × contractSize → exact $ P&L).
  if (meta.goldApi) {
    const ozPerStd = symbol === "XAGUSD" ? 5000 : 100;
    const positionSize = riskAmount / slDist; // oz
    const notional = positionSize * entry;
    const std = positionSize / ozPerStd;
    return {
      venue: "MT5",
      accountSize: r(accountSize),
      riskAmount: r(riskAmount),
      riskPct: r(riskPct * 100, 2),
      positionSize: r(positionSize, 3),
      positionSizeUnit: "oz",
      notional: r(notional),
      lots: {
        standard: r(std, 4),
        mini: r(std * 10, 3),
        micro: r(std * 100, 2),
      },
      mt5: computeMT5Sizing(symbol, mt5Lots, entry, stopLoss, takeProfit1, takeProfit2, accountSize, riskPct),
    };
  }

  // ─── Spot tokens (Phemex spot — no leverage, whole-token sizing) ───
  // `meta.coinbase` is the canonical marker for a spot-priced symbol whose
  // chart data comes from Coinbase. The user trades on Phemex spot. The
  // negative guards ensure a future symbol that also has a perp/gold feed
  // still routes to its primary venue. Any symbol with `meta.coinbase` and
  // none of those overriding markers is sized as a no-leverage spot buy.
  if (meta.coinbase && !meta.phemexPerp && !meta.goldApi) {
    const spotToken = computeSpotTokenSizing(
      symbol, entry, stopLoss, takeProfit1, takeProfit2, accountSize, riskPct,
    );
    return {
      venue: "PHEMEX_SPOT",
      accountSize: r(accountSize),
      riskAmount: r(riskAmount),
      riskPct: r(riskPct * 100, 2),
      positionSize: spotToken.tokenCount,
      positionSizeUnit: spotToken.tokenSymbol,
      notional: spotToken.notional,
      spotToken,
    };
  }

  // ─── Forex — venue: MT5 ───
  // For BASE/QUOTE pairs, position size is N units of BASE.
  // Loss in QUOTE on SL hit = N × slDist. Convert to USD:
  //   USD-quote pair (EURUSD, GBPUSD, AUDUSD): USD loss = N × slDist
  //     → N = riskUSD / slDist
  //   USD-base pair (USDJPY): JPY loss = N × slDist; USD ≈ JPY / entry
  //     → N = riskUSD × entry / slDist
  //   Cross JPY pair (GBPJPY): use live USDJPY from spotCache (fallback 150)
  //     → N = riskUSD × usdJpy / slDist
  const isUsdBase = symbol === "USDJPY";
  const isJpyCross = symbol === "GBPJPY";
  let positionSize: number;
  let notional: number;
  if (isUsdBase) {
    positionSize = (riskAmount * entry) / slDist; // USD units
    notional = positionSize; // already USD
  } else if (isJpyCross) {
    const usdJpy = getUsdJpyRate().rate;
    positionSize = (riskAmount * usdJpy) / slDist; // GBP units
    notional = (positionSize * entry) / usdJpy; // GBP × JPY/GBP / (JPY/USD) = USD
  } else {
    positionSize = riskAmount / slDist; // base units (EUR, GBP, AUD)
    notional = positionSize * entry; // base × USD/base = USD
  }
  const std = positionSize / 100_000;
  const unit = symbol.slice(0, 3); // EUR, GBP, AUD, USD
  return {
    venue: "MT5",
    accountSize: r(accountSize),
    riskAmount: r(riskAmount),
    riskPct: r(riskPct * 100, 2),
    positionSize: r(positionSize),
    positionSizeUnit: unit,
    notional: r(notional),
    lots: {
      standard: r(std, 4),
      mini: r(std * 10, 3),
      micro: r(std * 100, 2),
    },
    mt5: computeMT5Sizing(symbol, mt5Lots, entry, stopLoss, takeProfit1, takeProfit2, accountSize, riskPct),
  };
}

// ─── Spot token sizing (Coinbase spot — no leverage) ─────────────────────────
// Fires for any symbol that has no okxPerp, phemexPerp, goldApi, or forex
// characteristics. Position size = floor(riskAmount / |entry − stopLoss|)
// expressed in whole tokens.
function computeSpotTokenSizing(
  symbol: Symbol,
  entry: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
  accountSize: number,
  riskPct: number,
): SpotTokenSizing {
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const slDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfit1 - entry);
  const tp2Dist = Math.abs(takeProfit2 - entry);
  const riskAmount = accountSize * riskPct;
  // Floor to whole tokens — spot has no fractional contract concept.
  // If riskAmount/slDist < 1 the result is 0 (position too small to take).
  const tokenCount = Math.floor(riskAmount / slDist);
  const notional = tokenCount * entry;
  const actualRisk = tokenCount * slDist;
  // Derive ticker label: strip trailing "USDT" or "USD" from the symbol key.
  const tokenSymbol = symbol.replace(/USDT$|USD$/, "");
  return {
    tokenCount,
    tokenSymbol,
    notional: r(notional),
    riskAmount: r(actualRisk),
    riskPct: r((actualRisk / accountSize) * 100, 2),
    pnlAtSL: r(-actualRisk),
    pnlAtTP1: r(tokenCount * tp1Dist),
    pnlAtTP2: r(tokenCount * tp2Dist),
  };
}

export function floorTarget(
  entry: number,
  stop: number,
  structural: number,
  minRR: number,
  dir: "BUY" | "SELL",
): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return structural;
  const floor = dir === "BUY" ? entry + risk * minRR : entry - risk * minRR;
  return dir === "BUY" ? Math.max(structural, floor) : Math.min(structural, floor);
}

// ─── Core signal logic ───────────────────────────────────────────────────────

export function computeLevels(
  candles: CandleRaw[],
  spotPrice: number | null,
  timeframe: Timeframe,
  symbol: Symbol,
  accountSize: number = DEFAULT_ACCOUNT_SIZE,
  riskPct: number = DEFAULT_RISK_PCT,
  minCollateral: number = DEFAULT_MIN_COLLATERAL,
  maxLeverage: number = DEFAULT_MAX_LEVERAGE,
  mt5Lots: number = DEFAULT_MT5_LOTS,
) {
  const meta = SYMBOLS[symbol];
  const round = makeRounder(meta.decimals);
  const fmt = (n: number) => `${meta.prefix}${round(n).toFixed(meta.decimals)}`;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const currentPrice = spotPrice ?? last.close;
  const priceChange = round(currentPrice - prev.close);
  const priceChangePct = Math.round((priceChange / prev.close) * 10000) / 100;

  const pivots = calcPivots(prev.high, prev.low, prev.close, round);
  const { swingHigh, swingLow } = findSwingHighLow(candles, 60);
  const fibs = calcFibLevels(swingHigh, swingLow, round);
  const atr = calcATR(candles, 14);

  const closes = candles.map((c) => c.close);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const last21 = ema21[ema21.length - 1];
  const last50 = ema50[ema50.length - 1];
  const ema21Recent = ema21.slice(-5).filter((v) => !isNaN(v));
  const slopeUp = ema21Recent[ema21Recent.length - 1] > ema21Recent[0];

  let trend: "UPTREND" | "DOWNTREND" | "RANGING" = "RANGING";
  let trendStrength = 30;
  if (last21 > last50 && slopeUp) {
    trend = "UPTREND";
    trendStrength = Math.min(100, Math.round(((last21 - last50) / last50) * 1000 + 50));
  } else if (last21 < last50 && !slopeUp) {
    trend = "DOWNTREND";
    trendStrength = Math.min(100, Math.round(((last50 - last21) / last50) * 1000 + 50));
  }

  const zoneGap = pivots.r1 - pivots.s1;
  const halfWidth = round(zoneGap * 0.2);
  const buyZoneLow = round(pivots.s1 - halfWidth);
  const buyZoneHigh = round(pivots.s1 + halfWidth);
  const sellZoneLow = round(pivots.r1 - halfWidth);
  const sellZoneHigh = round(pivots.r1 + halfWidth);

  const inBuyZone = currentPrice >= buyZoneLow && currentPrice <= buyZoneHigh;
  const inSellZone = currentPrice >= sellZoneLow && currentPrice <= sellZoneHigh;
  const approachingBuy = !inBuyZone && currentPrice > buyZoneHigh && (currentPrice - buyZoneHigh) < atr * 0.5;
  const approachingSell = !inSellZone && currentPrice < sellZoneLow && (sellZoneLow - currentPrice) < atr * 0.5;

  let signal: "BUY" | "SELL" | "WAIT" = "WAIT";
  let signalReason = "";
  let entryPrice = currentPrice;
  let stopLoss = currentPrice;
  let takeProfit1 = currentPrice;
  let takeProfit2 = currentPrice;

  const tfLabel = TIMEFRAME_LABELS[timeframe];

  // Trend filter: only allow BUY when EMA21 ≥ EMA50 (uptrend or ranging),
  // only allow SELL when EMA21 ≤ EMA50 (downtrend or ranging). Counter-trend
  // pivot bounces are the lowest-edge setups in the historical data, so we
  // explicitly suppress them and emit WAIT instead.
  const buyAllowed = trend !== "DOWNTREND";
  const sellAllowed = trend !== "UPTREND";

  if ((inBuyZone || approachingBuy) && buyAllowed) {
    signal = "BUY";
    // Anchor entry to the planned limit price at S1, but never above the live
    // print — if price has already dipped at/below S1 the limit would sit
    // ABOVE market and only fill on a bounce, immediately putting the trade
    // in drawdown if it reverses (the original "BUY entry above price" bug).
    // Clamping to currentPrice turns those cases into a market-style entry at
    // the better fill, while pullback approaches from above still stage at S1.
    entryPrice = round(Math.min(pivots.s1, currentPrice));
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    signalReason = inBuyZone
      ? `[${tfLabel}] Price is at the buy zone around pivot S1 (${fmt(pivots.s1)}). ${trend === "UPTREND" ? "Uptrend intact — bounce setup." : "EMA trend neutral — look for a bullish reversal candle to confirm entry."}`
      : `[${tfLabel}] Price is within ${fmt(currentPrice - buyZoneHigh)} of the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}). Stage a limit order near S1 ${fmt(pivots.s1)}.`;
  } else if ((inSellZone || approachingSell) && sellAllowed) {
    signal = "SELL";
    // Mirror of BUY clamp: never set the SELL entry below the live print, or
    // the limit would sit at a worse price than market and only fill on a
    // pullback up. Clamp to currentPrice on rallies-into-zone, keep R1 on
    // approaches from below.
    entryPrice = round(Math.max(pivots.r1, currentPrice));
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
    signalReason = inSellZone
      ? `[${tfLabel}] Price is at the sell zone around pivot R1 (${fmt(pivots.r1)}). ${trend === "DOWNTREND" ? "Downtrend in force — distribution zone." : "EMA trend neutral — look for a bearish rejection candle to confirm short entry."}`
      : `[${tfLabel}] Price is within ${fmt(sellZoneLow - currentPrice)} of the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}). Stage a limit sell order near R1 ${fmt(pivots.r1)}.`;
  } else if (inBuyZone && !buyAllowed) {
    // Price is in the buy zone but the trend filter blocks the long. Show a
    // pending sell setup at R1 instead so the trader sees the next opportunity.
    signal = "WAIT";
    signalReason = `[${tfLabel}] Price is in the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}) but EMA21 < EMA50 (downtrend) — counter-trend longs filtered out. Wait for trend to flip or for price to reach the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}).`;
    entryPrice = round(pivots.r1);
    stopLoss = round(sellZoneHigh + atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
  } else if (inSellZone && !sellAllowed) {
    signal = "WAIT";
    signalReason = `[${tfLabel}] Price is in the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}) but EMA21 > EMA50 (uptrend) — counter-trend shorts filtered out. Wait for trend to flip or for price to reach the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}).`;
    entryPrice = round(pivots.s1);
    stopLoss = round(buyZoneLow - atr * 0.5);
    takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
    takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
  } else {
    signal = "WAIT";
    const aboveSellZone = currentPrice > sellZoneHigh;
    const belowBuyZone = currentPrice < buyZoneLow;

    if (aboveSellZone) {
      const distAboveSell = round(currentPrice - sellZoneHigh);
      const distToR2 = round(pivots.r2 - currentPrice);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) has cleared the sell zone and is ${fmt(distAboveSell)} above resistance. ${distToR2 > 0 ? `Watch R2 at ${fmt(pivots.r2)} (${fmt(distToR2)} away) for the next sell opportunity.` : `Price is above R2 — momentum play, no clean entry zone yet.`} Wait for a pullback into a zone.`;
      entryPrice = round(pivots.r1);
      stopLoss = round(sellZoneHigh + atr * 0.5);
      takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "SELL"));
      takeProfit2 = round(floorTarget(entryPrice, stopLoss, buyZoneHigh, MIN_RR_TP2, "SELL"));
    } else if (belowBuyZone) {
      const distBelowBuy = round(buyZoneLow - currentPrice);
      const distToS2 = round(currentPrice - pivots.s2);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) has broken below the buy zone and is ${fmt(distBelowBuy)} below support. ${distToS2 > 0 ? `Watch S2 at ${fmt(pivots.s2)} (${fmt(distToS2)} away) for the next buy opportunity.` : `Price is below S2 — wait for stabilization before entering.`}`;
      entryPrice = round(pivots.s1);
      stopLoss = round(buyZoneLow - atr * 0.5);
      takeProfit1 = round(floorTarget(entryPrice, stopLoss, pivots.pivot, MIN_RR_TP1, "BUY"));
      takeProfit2 = round(floorTarget(entryPrice, stopLoss, sellZoneLow, MIN_RR_TP2, "BUY"));
    } else {
      const distToBuy = round(currentPrice - buyZoneHigh);
      const distToSell = round(sellZoneLow - currentPrice);
      signalReason = `[${tfLabel}] Price (${fmt(currentPrice)}) is in no-trade territory — ${fmt(distToBuy)} above the buy zone (${fmt(buyZoneLow)}–${fmt(buyZoneHigh)}) and ${fmt(distToSell)} below the sell zone (${fmt(sellZoneLow)}–${fmt(sellZoneHigh)}). Wait for price to reach a zone.`;
      const dir: "BUY" | "SELL" = trend === "UPTREND" ? "BUY" : "SELL";
      entryPrice = round(dir === "BUY" ? pivots.s1 : pivots.r1);
      stopLoss = round(dir === "BUY" ? buyZoneLow - atr * 0.5 : sellZoneHigh + atr * 0.5);
      const structural1 = pivots.pivot;
      const structural2 = dir === "BUY" ? sellZoneLow : buyZoneHigh;
      takeProfit1 = round(floorTarget(entryPrice, stopLoss, structural1, MIN_RR_TP1, dir));
      takeProfit2 = round(floorTarget(entryPrice, stopLoss, structural2, MIN_RR_TP2, dir));
    }
  }

  const riskDist = Math.abs(entryPrice - stopLoss);
  const rewardDist = Math.abs(takeProfit1 - entryPrice);
  const riskRewardRatio = riskDist > 0 ? Math.round((rewardDist / riskDist) * 100) / 100 : 0;

  const positionSizing = computePositionSizing(
    symbol,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    accountSize,
    riskPct,
    minCollateral,
    maxLeverage,
    mt5Lots,
  );

  type LevelType = "resistance" | "support" | "pivot";
  const levels: { label: string; price: number; type: LevelType }[] = [
    { label: "R3",         price: pivots.r3,      type: "resistance" as LevelType },
    { label: "R2",         price: pivots.r2,      type: "resistance" as LevelType },
    { label: "R1",         price: pivots.r1,      type: "resistance" as LevelType },
    { label: "Pivot",      price: pivots.pivot,   type: "pivot"      as LevelType },
    { label: "S1",         price: pivots.s1,      type: "support"    as LevelType },
    { label: "S2",         price: pivots.s2,      type: "support"    as LevelType },
    { label: "S3",         price: pivots.s3,      type: "support"    as LevelType },
    { label: "Fib 23.6%",  price: fibs.fib236,    type: "resistance" as LevelType },
    { label: "Fib 38.2%",  price: fibs.fib382,    type: "resistance" as LevelType },
    { label: "Fib 50.0%",  price: fibs.fib500,    type: "pivot"      as LevelType },
    { label: "Fib 61.8%",  price: fibs.fib618,    type: "support"    as LevelType },
    { label: "Fib 78.6%",  price: fibs.fib786,    type: "support"    as LevelType },
    { label: "Swing High", price: fibs.swingHigh, type: "resistance" as LevelType },
    { label: "Swing Low",  price: fibs.swingLow,  type: "support"    as LevelType },
  ]
    .filter((l) => l.price > 0)
    .sort((a, b) => b.price - a.price);

  // Default tradeState for a fresh (no active snapshot) result. WAIT signals
  // are WAIT; new BUY/SELL is PENDING by default — computeLevelsStable upgrades
  // this to a triggered state if the snapshot fired with price already at/past
  // entry. Cast widens the literal so the inferred Levels.tradeState is the
  // full TradeState union (otherwise TS narrows it to "WAIT" | "PENDING" and
  // rejects FILLED_* assignments downstream).
  const tradeState = (signal === "WAIT" ? "WAIT" : "PENDING") as TradeState;

  return {
    symbol,
    currentPrice: round(currentPrice),
    priceChange,
    priceChangePct,
    signal,
    signalReason,
    tradeState,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskRewardRatio,
    buyZone:  { low: buyZoneLow,  high: buyZoneHigh,  label: "Buy Zone"  },
    sellZone: { low: sellZoneLow, high: sellZoneHigh, label: "Sell Zone" },
    levels,
    pivot: pivots.pivot,
    trend,
    trendStrength,
    lastUpdated: new Date().toISOString(),
    positionSizing,
  };
}

// ─── Stable signal wrapper ───────────────────────────────────────────────────
// Once a BUY/SELL signal fires, freeze entry/SL/TP1/TP2/zones until the trade
// is invalidated. Without this the entry shifts every time a new bar closes
// (because pivots are recomputed from prev.high/low/close), which is bad UX
// for a live trader trying to enter the order book.
//
// Trade is invalidated when:
//   - Stop loss is hit (price closes through SL)
//   - TP2 is hit (full target reached)
//   - Server restarts (in-memory only)
//
// Position sizing always recomputes against the caller's account/risk because
// those are user inputs and must respond live.

type Levels = ReturnType<typeof computeLevels>;

interface ActiveTrade {
  signal: "BUY" | "SELL";
  signalReason: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardRatio: number;
  buyZone: Levels["buyZone"];
  sellZone: Levels["sellZone"];
  pivot: number;
  levelsArr: Levels["levels"];
  trend: Levels["trend"];
  trendStrength: number;
  openedAt: number;
  tp1Hit: boolean;
  // Whether the limit order at `entryPrice` has actually been tagged by price
  // since the snapshot was taken. Critical for honesty: a signal that fires
  // when price is "approaching" the zone may never see a real fill if price
  // bounces away before tagging entry. Without this flag the dashboard would
  // claim "+1R in profit" when no trade actually occurred.
  triggered: boolean;
  // Price at the moment the snapshot was first created. Used only for context
  // in the description; not used for trade math.
  openedPrice: number;
  // Start timestamp + low + high of the candle that contained `openedAt`.
  // Used to detect post-snapshot wicks in that same candle WITHOUT
  // false-positiving on a pre-snapshot wick. A real fill requires the
  // candle's low (BUY) or high (SELL) to extend PAST this baseline AND
  // reach entry — proving the wick happened after the limit was placed.
  openedCandleStartTs: number;
  openedCandleLow: number;
  openedCandleHigh: number;
}

const activeTrades = new Map<string, ActiveTrade>();

// ─── Disk persistence for active trades ──────────────────────────────────────
// The freeze-on-signal logic keeps entry/SL/TP stable from the moment a BUY
// or SELL fires until SL or TP2 hits. Without disk persistence, every server
// restart wiped the in-memory Map, which let the next request re-snapshot
// fresh (drifted) levels. Persist to a JSON file so restarts preserve open
// trades.

const ACTIVE_TRADES_FILE =
  process.env.ACTIVE_TRADES_FILE ??
  join(process.cwd(), ".runtime", "active-trades.json");

function loadActiveTradesFromDisk(): void {
  try {
    const raw = readFileSync(ACTIVE_TRADES_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, Partial<ActiveTrade>>;
    let didMigrate = false;
    for (const [k, v] of Object.entries(obj)) {
      // Backward-compat for snapshots persisted before fill-tracking existed.
      // Default triggered=false; the next tick's candle scan since openedAt
      // will retroactively flip it to true if price actually did tag entry.
      // openedPrice falls back to entryPrice for missing-field cases.
      const needsMigration =
        typeof v.triggered !== "boolean" ||
        typeof v.openedPrice !== "number" ||
        typeof v.openedCandleStartTs !== "number" ||
        typeof v.openedCandleLow !== "number" ||
        typeof v.openedCandleHigh !== "number";
      if (needsMigration) didMigrate = true;
      const migrated: ActiveTrade = {
        ...(v as ActiveTrade),
        triggered: typeof v.triggered === "boolean" ? v.triggered : false,
        openedPrice:
          typeof v.openedPrice === "number" ? v.openedPrice : (v.entryPrice ?? 0),
        // Migrated trades have no baseline. Default the start-ts to openedAt
        // so the containing-candle branch in wasEntryTagged won't fire (a
        // candle's start ts won't equal an arbitrary openedAt). Migrated
        // trades only check fully-post-snapshot candles + live spot — slightly
        // conservative, avoids false-positives on pre-existing wicks.
        openedCandleStartTs:
          typeof v.openedCandleStartTs === "number"
            ? v.openedCandleStartTs
            : (v.openedAt ?? 0),
        // Sentinels of 0 are safe: the containing-candle branch in
        // wasEntryTagged only fires when ts === openedCandleStartTs, which
        // for migrated trades equals openedAt and won't match any real
        // candle's start ts. So the baseline values are unreachable for
        // migrated trades — they're populated solely to satisfy the schema
        // and survive JSON roundtripping (Infinity serializes to null).
        openedCandleLow:
          typeof v.openedCandleLow === "number" ? v.openedCandleLow : 0,
        openedCandleHigh:
          typeof v.openedCandleHigh === "number" ? v.openedCandleHigh : 0,
      };
      activeTrades.set(k, migrated);
    }
    // Flush migrated state to disk so the file matches in-memory shape and
    // diagnostic dumps don't show stale `undefined` for the new fields.
    if (didMigrate) persistActiveTrades();
  } catch {
    // No file yet, or unreadable — start fresh.
  }
}

function persistActiveTrades(): void {
  try {
    mkdirSync(dirname(ACTIVE_TRADES_FILE), { recursive: true });
    const obj: Record<string, ActiveTrade> = {};
    for (const [k, v] of activeTrades) obj[k] = v;
    writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(obj));
  } catch {
    // Persistence is best-effort — never crash the request path.
  }
}

// Eager load on module init. Cheap (single small JSON file).
loadActiveTradesFromDisk();

function tradeKey(symbol: Symbol, timeframe: Timeframe): string {
  return `${symbol}::${timeframe}`;
}

function isInvalidated(trade: ActiveTrade, currentPrice: number): boolean {
  if (trade.signal === "BUY") {
    return currentPrice <= trade.stopLoss || currentPrice >= trade.takeProfit2;
  }
  return currentPrice >= trade.stopLoss || currentPrice <= trade.takeProfit2;
}

// Scan all candles since the trade snapshot to determine whether the limit
// at `entryPrice` was actually tagged. Three candle classes:
//
//   ts > openedCandleStartTs (fully post-snapshot)
//     → simple check: candle wick reaches entry → fill confirmed.
//
//   ts === openedCandleStartTs (the containing candle — was in-progress at
//   snapshot, may have since closed)
//     → baseline check: count only if the wick EXTENDED past the snapshot's
//       opening low/high AND reached entry. Without this we'd false-positive
//       on a pre-snapshot wick (a wick that happened earlier in the same
//       candle, before the limit was even staged) — re-introducing the
//       lying-about-fills bug this whole fix exists to eliminate.
//
//   ts < openedCandleStartTs (closed before snapshot)
//     → skip entirely; the limit didn't exist yet.
function wasEntryTagged(trade: ActiveTrade, candles: CandleRaw[]): boolean {
  for (const c of candles) {
    const ts = Date.parse(c.date);
    if (Number.isNaN(ts)) continue;
    if (ts > trade.openedCandleStartTs) {
      if (trade.signal === "BUY" && c.low <= trade.entryPrice) return true;
      if (trade.signal === "SELL" && c.high >= trade.entryPrice) return true;
    } else if (ts === trade.openedCandleStartTs) {
      if (
        trade.signal === "BUY" &&
        c.low < trade.openedCandleLow &&
        c.low <= trade.entryPrice
      ) {
        return true;
      }
      if (
        trade.signal === "SELL" &&
        c.high > trade.openedCandleHigh &&
        c.high >= trade.entryPrice
      ) {
        return true;
      }
    }
  }
  return false;
}

// Build a context-aware description of an active (frozen) trade based on
// where the live price sits relative to the frozen entry / SL / TPs. The
// snapshot's original signalReason text goes stale fast — once price walks
// away from the zone, "Price is within $0.02 of the buy zone" becomes a lie.
// This recomputes the human-readable explanation every tick so the dashboard
// honestly reflects the trade's current state.
// Typed trade state for UIs and downstream consumers. Avoids the fragile
// pattern of regex-parsing describeFrozenTrade's prose to know whether a
// trade is pending vs filled vs in profit. Keep this in sync with the
// `tradeState` enum in lib/api-spec/openapi.yaml (LevelsData.tradeState).
export type TradeState =
  | "WAIT"
  | "PENDING"
  | "FILLED_PROFIT"
  | "FILLED_DRAWDOWN"
  | "FILLED_TP1"
  | "FILLED_TP2"
  | "FILLED_SL";

// Pure classifier — no text, just the typed state. describeFrozenTrade
// continues to own the human-readable explanation; this helper owns the
// machine-readable label.
export function classifyTradeState(trade: ActiveTrade, currentPrice: number): TradeState {
  if (!trade.triggered) return "PENDING";
  const isBuy = trade.signal === "BUY";
  const beyondTp2 = isBuy ? currentPrice >= trade.takeProfit2 : currentPrice <= trade.takeProfit2;
  const beyondTp1 = isBuy ? currentPrice >= trade.takeProfit1 : currentPrice <= trade.takeProfit1;
  const beyondSl = isBuy ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss;
  const inProfit = isBuy ? currentPrice > trade.entryPrice : currentPrice < trade.entryPrice;
  if (beyondTp2) return "FILLED_TP2";
  if (beyondTp1) return "FILLED_TP1";
  if (beyondSl) return "FILLED_SL";
  if (inProfit) return "FILLED_PROFIT";
  return "FILLED_DRAWDOWN";
}

function describeFrozenTrade(
  trade: ActiveTrade,
  currentPrice: number,
  timeframe: Timeframe,
  symbol: Symbol,
): string {
  const meta = SYMBOLS[symbol];
  const round = makeRounder(meta.decimals);
  const fmt = (n: number) => `${meta.prefix}${round(n).toFixed(meta.decimals)}`;
  const tfLabel = TIMEFRAME_LABELS[timeframe];
  const isBuy = trade.signal === "BUY";
  const dirWord = isBuy ? "BUY" : "SELL";
  const triggered = trade.triggered;

  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  const rawPnl = isBuy ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
  const rMult = risk > 0 ? rawPnl / risk : 0;
  const rStr = `${rMult >= 0 ? "+" : ""}${rMult.toFixed(2)}R`;

  const distToTp1 = Math.abs(trade.takeProfit1 - currentPrice);
  const distToTp2 = Math.abs(trade.takeProfit2 - currentPrice);
  const distToSl = Math.abs(currentPrice - trade.stopLoss);
  const distToEntry = Math.abs(currentPrice - trade.entryPrice);

  const beyondTp2 = isBuy ? currentPrice >= trade.takeProfit2 : currentPrice <= trade.takeProfit2;
  const beyondTp1 = isBuy ? currentPrice >= trade.takeProfit1 : currentPrice <= trade.takeProfit1;
  const inProfit = isBuy ? currentPrice > trade.entryPrice : currentPrice < trade.entryPrice;
  const beyondSl = isBuy ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss;

  // ─── NOT TRIGGERED: limit at entry was never tagged by price ────────────
  // The trade is a pending limit order, not an actual position. R-multiple
  // and "in profit" language do NOT apply — no fill happened.
  //
  // Note: !triggered + beyondTp1/Tp2/SL never reaches this function in
  // practice. computeLevelsStable's isInvalidated (SL/TP2) and auto-MISSED
  // (TP1) checks delete the trade before describe runs. So we only need
  // to handle inProfit and pending-side states.
  if (!triggered) {
    if (inProfit) {
      // Price moved in the trade's favor without the limit being tagged.
      // For BUY: price went up past S1 (above) without coming down to S1.
      // For SELL: price went down past R1 (below) without coming up to R1.
      const dirToEntry = isBuy ? "above" : "below";
      return `[${tfLabel}] ${dirWord} setup PENDING — price ${fmt(currentPrice)} moved ${fmt(distToEntry)} ${dirToEntry} entry ${fmt(trade.entryPrice)} without tagging it. Limit order still staged; needs a pullback to ${fmt(trade.entryPrice)} to fill. Auto-expires if price reaches TP1 ${fmt(trade.takeProfit1)} unfilled.`;
    }
    // Price on the SL side of entry. For BUY this would mean spot crossed
    // entry going down — but the spot-cross trigger would have flipped
    // triggered=true first. So in practice this path is taken only at the
    // exact tick where price equals entry, or in defensive edge cases.
    const dirFromEntry = isBuy ? "below" : "above";
    return `[${tfLabel}] ${dirWord} PENDING — limit at ${fmt(trade.entryPrice)}, price ${fmt(currentPrice)} (${fmt(distToEntry)} ${dirFromEntry} entry, ${fmt(distToSl)} from SL ${fmt(trade.stopLoss)}). Order will fill if price tags ${fmt(trade.entryPrice)}.`;
  }

  // After TP1 hits the engine trails the stop to the entry price, so a
  // post-TP1 SL hit is really a flat break-even exit, not a -1R loss. Detect
  // that case explicitly so the message reads honestly.
  const trailedToBE = trade.tp1Hit && trade.stopLoss === trade.entryPrice;

  // ─── TRIGGERED: position is real ────────────────────────────────────────
  if (beyondTp2) {
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)} reached TP2 ${fmt(trade.takeProfit2)} (${rStr}). Full target hit — trade closing.`;
  }
  if (beyondTp1) {
    const trailNote = trailedToBE
      ? ` Stop trailed to break-even (${fmt(trade.entryPrice)}) — risk-free runner.`
      : "";
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)}: TP1 ${fmt(trade.takeProfit1)} reached (${rStr}).${trailNote} ${fmt(distToTp2)} from TP2 ${fmt(trade.takeProfit2)} — let it run or take partials.`;
  }
  if (inProfit) {
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)}, in profit: price ${fmt(currentPrice)} (${rStr}, ${fmt(distToTp1)} from TP1 ${fmt(trade.takeProfit1)}).`;
  }
  if (beyondSl) {
    if (trailedToBE) {
      return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)} retraced to break-even after TP1 hit — trade closing flat (0R). Stop was trailed up to entry once TP1 tagged.`;
    }
    return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)} hit stop loss ${fmt(trade.stopLoss)} (${rStr}). Trade invalidated.`;
  }
  // Price on SL side after fill — drawdown.
  return `[${tfLabel}] ${dirWord} filled at ${fmt(trade.entryPrice)}, in drawdown: price ${fmt(currentPrice)} (${rStr}, ${fmt(distToSl)} from SL ${fmt(trade.stopLoss)}).`;
}

export function computeLevelsStable(
  candles: CandleRaw[],
  spotPrice: number | null,
  timeframe: Timeframe,
  symbol: Symbol,
  accountSize: number = DEFAULT_ACCOUNT_SIZE,
  riskPct: number = DEFAULT_RISK_PCT,
  minCollateral: number = DEFAULT_MIN_COLLATERAL,
  maxLeverage: number = DEFAULT_MAX_LEVERAGE,
  mt5Lots: number = DEFAULT_MT5_LOTS,
): Levels {
  const fresh = computeLevels(candles, spotPrice, timeframe, symbol, accountSize, riskPct, minCollateral, maxLeverage, mt5Lots);
  const k = tradeKey(symbol, timeframe);
  const existing = activeTrades.get(k);

  // Invalidate if SL or TP2 hit.
  if (existing && isInvalidated(existing, fresh.currentPrice)) {
    activeTrades.delete(k);
    persistActiveTrades();
  }

  // Invalidate when the live signal flips to the opposite direction. The
  // trend has reversed enough that the original thesis is dead — keep the
  // dashboard in sync with the new signal instead of leaving stale levels up.
  // WAIT does NOT invalidate (the active trade is still mathematically open).
  const stillActiveBeforeFlip = activeTrades.get(k);
  if (
    stillActiveBeforeFlip &&
    (fresh.signal === "BUY" || fresh.signal === "SELL") &&
    fresh.signal !== stillActiveBeforeFlip.signal
  ) {
    activeTrades.delete(k);
    persistActiveTrades();
  }

  // Detect fill via two complementary signals:
  //   1. Live spot crossed the limit (catches taps before candle aggregation
  //      catches up — yahoo's hourly low can lag the live tick by minutes).
  //   2. Any candle since openedAt wicked through entry (catches intra-candle
  //      taps between polls when spot has since recovered past entry).
  const preTriggerCheck = activeTrades.get(k);
  if (preTriggerCheck && !preTriggerCheck.triggered) {
    const spotTagged =
      preTriggerCheck.signal === "BUY"
        ? fresh.currentPrice <= preTriggerCheck.entryPrice
        : fresh.currentPrice >= preTriggerCheck.entryPrice;
    if (spotTagged || wasEntryTagged(preTriggerCheck, candles)) {
      preTriggerCheck.triggered = true;
      persistActiveTrades();
    }
  }

  // Auto-invalidate as MISSED: a still-pending limit order whose price has
  // already reached TP1 in the trade's favorable direction is dead — no
  // pullback to entry is going to happen at this point. Drop it so the next
  // genuine setup can take over instead of leaving a phantom "pending" trade
  // on the dashboard forever.
  const missedCheck = activeTrades.get(k);
  if (missedCheck && !missedCheck.triggered) {
    const reachedTp1 =
      missedCheck.signal === "BUY"
        ? fresh.currentPrice >= missedCheck.takeProfit1
        : fresh.currentPrice <= missedCheck.takeProfit1;
    if (reachedTp1) {
      activeTrades.delete(k);
      persistActiveTrades();
    }
  }

  // Keep frozen view if the trade is still active. Note we re-read `existing`
  // because the delete above may have cleared it.
  const stillActive = activeTrades.get(k);
  if (stillActive) {
    // When TP1 is reached on a FILLED trade, trail the stop to break-even
    // (entry). This is standard trader practice: a trade that has already
    // moved +1.5R in your favor should not be allowed to round-trip into a
    // full -1R loss. After this trail, a retrace back to entry trips the
    // existing isInvalidated check on the next tick, closing the trade flat
    // — no more "phantom BUY" hanging on the dashboard after price has
    // already pumped and retraced. PENDING (un-triggered) limit orders are
    // handled separately by the auto-MISSED path above; we only trail real
    // fills.
    if (!stillActive.tp1Hit && stillActive.triggered) {
      const tp1Reached =
        stillActive.signal === "BUY"
          ? fresh.currentPrice >= stillActive.takeProfit1
          : fresh.currentPrice <= stillActive.takeProfit1;
      if (tp1Reached) {
        stillActive.tp1Hit = true;
        stillActive.stopLoss = stillActive.entryPrice;
        persistActiveTrades();
      }
    }
    return {
      ...fresh,
      signal: stillActive.signal,
      // Recompute the explanation against current price — the frozen text is
      // a lie the moment price walks away from the original zone.
      signalReason: describeFrozenTrade(stillActive, fresh.currentPrice, timeframe, symbol),
      // Typed mirror of the same classification — consumers should branch on
      // this, not parse the prose above.
      tradeState: classifyTradeState(stillActive, fresh.currentPrice),
      entryPrice: stillActive.entryPrice,
      stopLoss: stillActive.stopLoss,
      takeProfit1: stillActive.takeProfit1,
      takeProfit2: stillActive.takeProfit2,
      riskRewardRatio: stillActive.riskRewardRatio,
      buyZone: stillActive.buyZone,
      sellZone: stillActive.sellZone,
      pivot: stillActive.pivot,
      levels: stillActive.levelsArr,
      // Recompute sizing fresh against the (possibly updated) account/risk
      // inputs but using the FROZEN entry, stop loss and TP levels.
      positionSizing: computePositionSizing(
        symbol,
        stillActive.entryPrice,
        stillActive.stopLoss,
        stillActive.takeProfit1,
        stillActive.takeProfit2,
        accountSize,
        riskPct,
        minCollateral,
        maxLeverage,
        mt5Lots,
      ),
    };
  }

  // No active trade. If fresh is BUY/SELL, snapshot it as the new active trade.
  if (fresh.signal === "BUY" || fresh.signal === "SELL") {
    // If price is already at/past the limit at fire time, the order would
    // fill immediately. BUY: limit fills when price drops to S1, so a
    // currentPrice ≤ entry means it's already there. SELL: mirror.
    const triggered =
      fresh.signal === "BUY"
        ? fresh.currentPrice <= fresh.entryPrice
        : fresh.currentPrice >= fresh.entryPrice;
    // Capture the in-progress candle's range as a baseline, so subsequent
    // wick extensions (and only those) can prove a real post-snapshot fill.
    const lastCandle = candles[candles.length - 1];
    const openedCandleStartTs = lastCandle ? Date.parse(lastCandle.date) : Date.now();
    const openedCandleLow = lastCandle ? lastCandle.low : Infinity;
    const openedCandleHigh = lastCandle ? lastCandle.high : -Infinity;
    const newTrade: ActiveTrade = {
      signal: fresh.signal,
      signalReason: fresh.signalReason,
      entryPrice: fresh.entryPrice,
      stopLoss: fresh.stopLoss,
      takeProfit1: fresh.takeProfit1,
      takeProfit2: fresh.takeProfit2,
      riskRewardRatio: fresh.riskRewardRatio,
      buyZone: fresh.buyZone,
      sellZone: fresh.sellZone,
      pivot: fresh.pivot,
      levelsArr: fresh.levels,
      trend: fresh.trend,
      trendStrength: fresh.trendStrength,
      openedAt: Date.now(),
      tp1Hit: false,
      triggered,
      openedPrice: fresh.currentPrice,
      openedCandleStartTs: Number.isNaN(openedCandleStartTs) ? Date.now() : openedCandleStartTs,
      openedCandleLow,
      openedCandleHigh,
    };
    activeTrades.set(k, newTrade);
    persistActiveTrades();
    // Upgrade tradeState if the snapshot fired pre-triggered (price already
    // at/past entry). The default "PENDING" set by computeLevels would lie
    // about a brand-new filled trade for one tick otherwise.
    if (triggered) {
      return { ...fresh, tradeState: classifyTradeState(newTrade, fresh.currentPrice) };
    }
  }

  return fresh;
}

// Exposed for diagnostics / testing.
export function getActiveTrade(symbol: Symbol, timeframe: Timeframe): ActiveTrade | undefined {
  return activeTrades.get(tradeKey(symbol, timeframe));
}

export function clearActiveTrade(symbol: Symbol, timeframe: Timeframe): void {
  activeTrades.delete(tradeKey(symbol, timeframe));
  persistActiveTrades();
}
