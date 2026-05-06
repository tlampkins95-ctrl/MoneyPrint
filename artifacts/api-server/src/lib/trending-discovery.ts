import { Pool } from "pg";
import { fetchOkxPerpPrice } from "./crypto-perp-fetch";
import { fetchOkxPerpCandles } from "./crypto-perp-fetch";
import type { CandleRaw, Timeframe } from "./yahoo-fetch";
import type { SymbolMeta } from "./symbols";
import { logger } from "./logger";

// ─── Trending symbol meta (runtime) ──────────────────────────────────────────
export interface TrendingMeta extends SymbolMeta {
  symbolKey: string;
  baseAsset: string;
  priceChange24h: number;
  rank: number;
  expiresAt: number;
  discoveredAt: number; // true first-seen timestamp
}

// In-memory cache of currently-trending coins (loaded from DB on boot, refreshed every 4h).
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

// ─── Discovery job ─────────────────────────────────────────────────────────────

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
  discoveredAt: number,
): TrendingMeta {
  return {
    symbolKey,
    baseAsset,
    priceChange24h,
    rank,
    expiresAt,
    discoveredAt,
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

// TTL for a discovered trending coin: 8 hours (after dropout, they age out).
const TRENDING_TTL_MS = 8 * 60 * 60 * 1000;

// Refresh interval: every 4 hours.
const DISCOVERY_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface CmcQuote {
  percent_change_24h: number;
  price: number;
}

interface CmcCoin {
  symbol: string;
  quote: { USD: CmcQuote };
}

interface OkxInstrument {
  instId: string;
  minSz: string;
  lotSz: string;
}

interface PhemexPerpProduct {
  symbol: string;
  qtyStepSizeRq?: string;  // USDT-margined sizing
  minOrderQtyRq?: string;
  lotSize?: string;        // coin-margined fallback
  minOrderQty?: string;
  contractSizeRq?: string; // contract size in base asset (USDT-margined)
  priceScaleRq?: string;   // price tick scale
}

// Fetch top gainers from CoinMarketCap's /v1/cryptocurrency/listings/latest
// sorted by percent_change_24h descending.  Requires COINMARKETCAP_API_KEY.
async function fetchCmcGainers(): Promise<CmcCoin[]> {
  const apiKey = process.env["COINMARKETCAP_API_KEY"];
  if (!apiKey) {
    logger.warn("COINMARKETCAP_API_KEY not set — skipping CMC gainers fetch");
    return [];
  }
  try {
    const url =
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest" +
      "?limit=200&sort=percent_change_24h&sort_dir=desc&cryptocurrency_type=coins" +
      "&convert=USD";
    const res = await fetch(url, {
      headers: {
        "X-CMC_PRO_API_KEY": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "CMC gainers fetch failed");
      return [];
    }
    const json = (await res.json()) as { data?: CmcCoin[] };
    return Array.isArray(json.data) ? json.data : [];
  } catch (err) {
    logger.warn({ err }, "CMC fetch error");
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

// Fetch Phemex USDT-margined perpetual products and return a map of
// symbol (e.g. "BTCUSDT") → sizing params.
async function fetchPhemexPerpProducts(): Promise<
  Map<string, { minQty: number; qtyStep: number }>
> {
  try {
    const res = await fetch("https://api.phemex.com/public/products", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Phemex products fetch failed");
      return new Map();
    }
    const json = (await res.json()) as {
      code: number;
      data?: {
        perpProductsV2?: PhemexPerpProduct[];
        products?: PhemexPerpProduct[];
      };
    };
    if (json.code !== 0) return new Map();

    const map = new Map<string, { minQty: number; qtyStep: number }>();

    // USDT-margined perps are in perpProductsV2 (symbols end with "USDT").
    const perps = json.data?.perpProductsV2 ?? [];
    for (const p of perps) {
      if (!p.symbol.endsWith("USDT")) continue;
      const minQty = parseFloat(p.minOrderQtyRq ?? p.minOrderQty ?? "1") || 1;
      const qtyStep = parseFloat(p.qtyStepSizeRq ?? p.lotSize ?? "1") || 1;
      map.set(p.symbol, { minQty, qtyStep });
    }
    return map;
  } catch (err) {
    logger.warn({ err }, "Phemex products fetch error");
    return new Map();
  }
}

// ─── DB persistence ───────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS trending_symbols (
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
  )
`;

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(CREATE_TABLE_SQL);
}

async function persistTrendingToDb(
  rows: TrendingMeta[],
  pool: Pool,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await ensureTable(pool);
    const expiresAt = new Date(Date.now() + TRENDING_TTL_MS);

    for (const r of rows) {
      await pool.query(
        // discovered_at: set only on first insert; never overwrite on conflict
        // so we preserve the true first-seen timestamp.
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
           expires_at = EXCLUDED.expires_at`,
        // NOTE: discovered_at is intentionally excluded from the DO UPDATE set
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

    // Purge rows whose TTL has elapsed.
    await pool.query("DELETE FROM trending_symbols WHERE expires_at < NOW()");
  } catch (err) {
    logger.warn({ err }, "Failed to persist trending symbols to DB");
  }
}

async function loadTrendingFromDb(pool: Pool): Promise<void> {
  try {
    await ensureTable(pool);
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
      discovered_at: Date;
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
          new Date(row.discovered_at).getTime(),
        ),
      );
    }
    if (trendingCache.length > 0) {
      logger.info({ count: trendingCache.length }, "Loaded trending symbols from DB");
    }
  } catch {
    // Table may not exist yet on first boot — handled by ensureTable above.
  }
}

async function runDiscovery(pool: Pool): Promise<void> {
  try {
    logger.info("Running trending coin discovery");

    // Fetch all three sources in parallel.
    const [gainers, okxMap, phemexMap] = await Promise.all([
      fetchCmcGainers(),
      fetchOkxSwapInstruments(),
      fetchPhemexPerpProducts(),
    ]);

    if (gainers.length === 0) {
      logger.warn("CMC returned no data — skipping discovery cycle");
      return;
    }

    if (phemexMap.size === 0) {
      logger.warn("Phemex returned no USDT-perp products — skipping discovery cycle");
      return;
    }

    const discovered: TrendingMeta[] = [];
    let rank = 0;

    for (const coin of gainers) {
      if (discovered.length >= MAX_TRENDING) break;
      const ticker = coin.symbol.toUpperCase();
      if (EXCLUDED_TICKERS.has(ticker)) continue;

      const change = coin.quote.USD.percent_change_24h ?? 0;
      if (change < 1) continue; // only coins up ≥1% in 24h

      const okxKey = `${ticker}-USDT-SWAP`;
      if (!okxMap.has(okxKey)) continue; // need OKX for candle data

      const phemexKey = `${ticker}USDT`;
      const phemexInst = phemexMap.get(phemexKey);
      if (!phemexInst) continue; // must be listed as a Phemex USDT-perp

      const price = coin.quote.USD.price ?? 1;
      const decimals = inferDecimals(price);
      const expiresAt = Date.now() + TRENDING_TTL_MS;
      const discoveredAt = Date.now(); // will be preserved in DB on conflict

      rank++;
      discovered.push(
        buildDynamicMeta(
          phemexKey,
          ticker,
          okxKey,
          phemexKey,
          decimals,
          phemexInst.minQty,
          phemexInst.qtyStep,
          change,
          rank,
          expiresAt,
          discoveredAt,
        ),
      );
    }

    if (discovered.length === 0) {
      logger.info("No qualifying trending coins this cycle (CoinGecko × OKX × Phemex)");
      return;
    }

    logger.info(
      { coins: discovered.map((d) => d.symbolKey) },
      "Trending coins discovered",
    );

    // Merge into in-memory cache:
    // - Coins that appear in this discovery cycle get their rank/change/expiresAt
    //   refreshed but their discoveredAt preserved.
    // - Coins that dropped out of the discovery set are kept in cache until their
    //   expiresAt (8h cooldown) so active trades on dropped coins aren't orphaned.
    const existingMap = new Map(trendingCache.map((t) => [t.symbolKey, t]));
    const discoveredKeys = new Set(discovered.map((d) => d.symbolKey));
    for (const d of discovered) {
      const existing = existingMap.get(d.symbolKey);
      existingMap.set(d.symbolKey, {
        ...d,
        discoveredAt: existing ? existing.discoveredAt : d.discoveredAt,
      });
    }
    const now = Date.now();
    trendingCache.length = 0;
    for (const [, meta] of existingMap) {
      if (discoveredKeys.has(meta.symbolKey)) {
        // Re-discovered this cycle — already has a fresh expiresAt.
        trendingCache.push(meta);
      } else if (meta.expiresAt > now) {
        // Dropped out this cycle — extend TTL to a full 8h from now so the
        // post-dropout cooldown window is always ~8h regardless of when the
        // coin was last refreshed.
        trendingCache.push({ ...meta, expiresAt: now + TRENDING_TTL_MS });
      }
    }
    trendingCache.sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0));

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

  // Refresh every 4 hours.
  setInterval(() => {
    void runDiscovery(pool);
  }, DISCOVERY_INTERVAL_MS);
}
