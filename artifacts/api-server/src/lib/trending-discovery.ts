import { Pool } from "pg";
import { fetchOkxPerpPrice } from "./crypto-perp-fetch";
import { fetchOkxPerpCandles } from "./crypto-perp-fetch";
import type { CandleRaw, Timeframe } from "./yahoo-fetch";
import type { SymbolMeta } from "./symbols";
import { logger } from "./logger";

// ─── Trending symbol meta (runtime, not persisted) ───────────────────────────
export interface TrendingMeta extends SymbolMeta {
  symbolKey: string;
  baseAsset: string;
  priceChange24h: number;
  rank: number;
  expiresAt: number;
}

// In-memory cache of currently-trending coins (loaded from DB on boot, refreshed hourly).
const trendingCache: TrendingMeta[] = [];

export function getTrendingSymbols(): TrendingMeta[] {
  const now = Date.now();
  return trendingCache.filter((t) => t.expiresAt > now);
}

// ─── Candle cache for dynamic symbols ────────────────────────────────────────
interface DynCacheEntry {
  candles: CandleRaw[];
  timestamp: number;
}
const dynCandleCache = new Map<string, DynCacheEntry>();
const dynInFlight = new Map<string, Promise<CandleRaw[]>>();

const DYN_CACHE_TTL_MS: Record<Timeframe, number> = {
  "15m": 60 * 1000,
  "30m": 2 * 60 * 1000,
  "1h": 5 * 60 * 1000,
  "1d": 5 * 60 * 1000,
};

export async function fetchCandlesForDynamic(
  okxPerp: string,
  timeframe: Timeframe,
): Promise<CandleRaw[]> {
  const key = `dyn::${okxPerp}::${timeframe}`;
  const now = Date.now();
  const existing = dynCandleCache.get(key);
  if (existing && now - existing.timestamp < DYN_CACHE_TTL_MS[timeframe]) {
    return existing.candles;
  }
  const pending = dynInFlight.get(key);
  if (pending) return pending;
  const promise = fetchOkxPerpCandles(okxPerp, timeframe)
    .then((candles) => {
      dynCandleCache.set(key, { candles, timestamp: Date.now() });
      return candles;
    })
    .finally(() => {
      dynInFlight.delete(key);
    });
  dynInFlight.set(key, promise);
  return promise;
}

// ─── Spot price cache for dynamic symbols ────────────────────────────────────
interface DynSpotEntry {
  price: number;
  timestamp: number;
}
const dynSpotCache = new Map<string, DynSpotEntry>();
const DYN_SPOT_TTL_MS = 30 * 1000;

export async function fetchSpotForDynamic(
  okxPerp: string,
): Promise<number | null> {
  const now = Date.now();
  const cached = dynSpotCache.get(okxPerp);
  if (cached && now - cached.timestamp < DYN_SPOT_TTL_MS) {
    return cached.price;
  }
  const price = await fetchOkxPerpPrice(okxPerp);
  if (price !== null) {
    dynSpotCache.set(okxPerp, { price, timestamp: now });
  }
  return price;
}

// ─── Discovery job ────────────────────────────────────────────────────────────

// Decimals inferred from price magnitude.
function inferDecimals(price: number): number {
  if (price >= 1000) return 1;
  if (price >= 100) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 5;
  return 6;
}

// Build a SymbolMeta-compatible shape from a trending coin row.
export function buildDynamicMeta(
  symbolKey: string,
  baseAsset: string,
  okxSymbol: string,
  phemexSymbol: string,
  decimals: number,
  minQty: number,
  qtyStep: number,
  priceChange24h: number,
  rank: number,
  expiresAt: number,
): TrendingMeta {
  return {
    symbolKey,
    baseAsset,
    priceChange24h,
    rank,
    expiresAt,
    // SymbolMeta fields
    yahoo: "",
    tvSymbol: `OKX:${phemexSymbol}.P`,
    tvScrapePath: "",
    label: `${baseAsset} / USDT (Trending)`,
    decimals,
    prefix: "$",
    okxPerp: okxSymbol,
    phemexPerp: phemexSymbol,
    phemexMinQty: minQty,
    phemexQtyStep: qtyStep,
    venue: "PHEMEX · USDT perp",
  };
}

// Static list of coins to exclude (already in the static SYMBOLS map).
const EXCLUDED_TICKERS = new Set([
  "BTC", "ETH", "ZEC", "SKYAI",
]);

// How many trending coins to track (beyond the static list).
const MAX_TRENDING = 5;

// TTL for a discovered trending coin: 24 hours.
const TRENDING_TTL_MS = 24 * 60 * 60 * 1000;

// Refresh interval: 1 hour.
const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

interface CoinGeckoMarket {
  id: string;
  symbol: string;
  name: string;
  price_change_percentage_24h: number | null;
  current_price: number | null;
}

interface OkxInstrument {
  instId: string;
  minSz: string;
  lotSz: string;
}

async function fetchCoinGeckoGainers(): Promise<CoinGeckoMarket[]> {
  try {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd&order=price_change_percentage_24h_desc" +
      "&per_page=100&page=1&price_change_percentage=24h";
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "CoinGecko gainers fetch failed");
      return [];
    }
    const data = (await res.json()) as CoinGeckoMarket[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn({ err }, "CoinGecko fetch error");
    return [];
  }
}

async function fetchOkxSwapInstruments(): Promise<Map<string, OkxInstrument>> {
  try {
    const res = await fetch(
      "https://www.okx.com/api/v5/public/instruments?instType=SWAP",
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return new Map();
    const json = (await res.json()) as { data?: OkxInstrument[] };
    const map = new Map<string, OkxInstrument>();
    for (const inst of json.data ?? []) {
      if (inst.instId.endsWith("-USDT-SWAP")) {
        map.set(inst.instId, inst);
      }
    }
    return map;
  } catch (err) {
    logger.warn({ err }, "OKX instruments fetch error");
    return new Map();
  }
}

async function persistTrendingToDb(
  rows: TrendingMeta[],
  pool: Pool,
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TRENDING_TTL_MS);
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS trending_symbols (
        symbol_key text PRIMARY KEY,
        base_asset text NOT NULL,
        okx_symbol text NOT NULL,
        phemex_symbol text NOT NULL,
        decimals integer NOT NULL DEFAULT 4,
        min_qty double precision NOT NULL DEFAULT 1,
        qty_step double precision NOT NULL DEFAULT 1,
        price_change_24h double precision NOT NULL DEFAULT 0,
        rank integer NOT NULL DEFAULT 999,
        discovered_at timestamptz NOT NULL DEFAULT NOW(),
        expires_at timestamptz NOT NULL
      )`,
    );

    for (const r of rows) {
      await pool.query(
        `INSERT INTO trending_symbols
           (symbol_key, base_asset, okx_symbol, phemex_symbol, decimals, min_qty, qty_step, price_change_24h, rank, discovered_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10)
         ON CONFLICT (symbol_key) DO UPDATE SET
           base_asset = EXCLUDED.base_asset,
           okx_symbol = EXCLUDED.okx_symbol,
           phemex_symbol = EXCLUDED.phemex_symbol,
           decimals = EXCLUDED.decimals,
           min_qty = EXCLUDED.min_qty,
           qty_step = EXCLUDED.qty_step,
           price_change_24h = EXCLUDED.price_change_24h,
           rank = EXCLUDED.rank,
           discovered_at = NOW(),
           expires_at = EXCLUDED.expires_at`,
        [
          r.symbolKey,
          r.baseAsset,
          r.okxPerp!,
          r.phemexPerp!,
          r.decimals,
          r.phemexMinQty ?? 1,
          r.phemexQtyStep ?? 1,
          r.priceChange24h,
          r.rank,
          expiresAt.toISOString(),
        ],
      );
    }

    // Purge expired rows.
    await pool.query("DELETE FROM trending_symbols WHERE expires_at < NOW()");
  } catch (err) {
    logger.warn({ err }, "Failed to persist trending symbols to DB");
  }
}

async function loadTrendingFromDb(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS trending_symbols (
        symbol_key text PRIMARY KEY,
        base_asset text NOT NULL,
        okx_symbol text NOT NULL,
        phemex_symbol text NOT NULL,
        decimals integer NOT NULL DEFAULT 4,
        min_qty double precision NOT NULL DEFAULT 1,
        qty_step double precision NOT NULL DEFAULT 1,
        price_change_24h double precision NOT NULL DEFAULT 0,
        rank integer NOT NULL DEFAULT 999,
        discovered_at timestamptz NOT NULL DEFAULT NOW(),
        expires_at timestamptz NOT NULL
      )`,
    );
    const res = await pool.query<{
      symbol_key: string;
      base_asset: string;
      okx_symbol: string;
      phemex_symbol: string;
      decimals: number;
      min_qty: number;
      qty_step: number;
      price_change_24h: number;
      rank: number;
      expires_at: Date;
    }>("SELECT * FROM trending_symbols WHERE expires_at > NOW() ORDER BY rank ASC");
    trendingCache.length = 0;
    for (const row of res.rows) {
      trendingCache.push(
        buildDynamicMeta(
          row.symbol_key,
          row.base_asset,
          row.okx_symbol,
          row.phemex_symbol,
          row.decimals,
          row.min_qty,
          row.qty_step,
          row.price_change_24h,
          row.rank,
          new Date(row.expires_at).getTime(),
        ),
      );
    }
    if (trendingCache.length > 0) {
      logger.info({ count: trendingCache.length }, "Loaded trending symbols from DB");
    }
  } catch {
    // Table may not exist yet — that's fine on first boot.
  }
}

async function runDiscovery(pool: Pool): Promise<void> {
  try {
    logger.info("Running trending coin discovery");
    const [gainers, okxMap] = await Promise.all([
      fetchCoinGeckoGainers(),
      fetchOkxSwapInstruments(),
    ]);

    if (gainers.length === 0) {
      logger.warn("CoinGecko returned no data — skipping discovery cycle");
      return;
    }

    const discovered: TrendingMeta[] = [];
    let rank = 0;

    for (const coin of gainers) {
      if (discovered.length >= MAX_TRENDING) break;
      const ticker = coin.symbol.toUpperCase();
      if (EXCLUDED_TICKERS.has(ticker)) continue;
      const okxKey = `${ticker}-USDT-SWAP`;
      const inst = okxMap.get(okxKey);
      if (!inst) continue;

      const change = coin.price_change_percentage_24h ?? 0;
      if (change <= 0) continue; // only gainers

      const price = coin.current_price ?? 1;
      const decimals = inferDecimals(price);
      const minQty = parseFloat(inst.minSz) || 1;
      const qtyStep = parseFloat(inst.lotSz) || 1;
      const expiresAt = Date.now() + TRENDING_TTL_MS;

      rank++;
      discovered.push(
        buildDynamicMeta(
          `${ticker}USDT`,
          ticker,
          okxKey,
          `${ticker}USDT`,
          decimals,
          minQty,
          qtyStep,
          change,
          rank,
          expiresAt,
        ),
      );
    }

    if (discovered.length === 0) {
      logger.info("No new trending coins discovered this cycle");
      return;
    }

    logger.info(
      { coins: discovered.map((d) => d.symbolKey) },
      "Trending coins discovered",
    );

    trendingCache.length = 0;
    trendingCache.push(...discovered);
    await persistTrendingToDb(discovered, pool);
  } catch (err) {
    logger.warn({ err }, "Trending discovery cycle failed");
  }
}

let discoveryStarted = false;

export function startTrendingDiscovery(): void {
  if (discoveryStarted) return;
  discoveryStarted = true;

  const poolUrl = process.env["DATABASE_URL"];
  if (!poolUrl) {
    logger.info("No DATABASE_URL — trending discovery disabled");
    return;
  }

  const pool = new Pool({ connectionString: poolUrl });

  // Load existing rows from DB immediately (so the API can serve them on boot).
  void loadTrendingFromDb(pool).then(() => {
    // Then run a fresh discovery cycle.
    void runDiscovery(pool);
  });

  // Refresh hourly.
  setInterval(() => {
    void runDiscovery(pool);
  }, DISCOVERY_INTERVAL_MS);
}
