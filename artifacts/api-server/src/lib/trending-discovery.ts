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
  pinned: boolean;      // true = manually pinned, never auto-purged
}

// In-memory cache of currently-trending coins (loaded from DB on boot, refreshed every 4h).
const trendingCache: TrendingMeta[] = [];
// Module-level pool reference so findTrendingSymbolByKey can fall back to the DB.
let _pool: Pool | null = null;

export function getTrendingSymbols(): TrendingMeta[] {
  const now = Date.now();
  // Always include pinned coins regardless of expiry so manual pins can never
  // silently disappear from the API even if their expiresAt were somehow stale.
  return trendingCache.filter((t) => t.pinned || t.expiresAt > now);
}

// Look up a trending coin by symbolKey. Checks the live in-memory cache first,
// then falls back to the DB (including recently-expired rows) so that a coin
// that just dropped out of the 8-hour TTL window still returns data rather than
// a 400 error.
export async function findTrendingSymbolByKey(symbolKey: string): Promise<TrendingMeta | null> {
  const live = trendingCache.find((t) => t.symbolKey === symbolKey);
  if (live) return live;
  if (!_pool) return null;
  try {
    const res = await _pool.query<{
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
      pinned: boolean;
    }>("SELECT * FROM trending_symbols WHERE symbol_key = $1 LIMIT 1", [symbolKey]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return buildDynamicMeta(
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
      row.pinned,
    );
  } catch {
    return null;
  }
}

// ─── Candle cache for dynamic symbols ────────────────────────────────────────
interface DynCacheEntry {
  candles: CandleRaw[];
  timestamp: number;
}
const dynCandleCache = new Map<string, DynCacheEntry>();
const dynInFlight = new Map<string, Promise<CandleRaw[]>>();

const DYN_CACHE_TTL_MS: Record<Timeframe, number> = {
  "1h": 5 * 60 * 1000,
  "4h": 15 * 60 * 1000,
  "1d": 5 * 60 * 1000,
  "1w": 30 * 60 * 1000,
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
export function inferDecimals(price: number): number {
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
  pinned = false,
): TrendingMeta {
  return {
    symbolKey,
    baseAsset,
    priceChange24h,
    rank,
    expiresAt,
    discoveredAt,
    pinned,
    // SymbolMeta fields
    yahoo: "",
    tvSymbol: `OKX:${phemexSymbol}.P`,
    tvScrapePath: "",
    label: `${baseAsset} / USDT (Trending)`,
    decimals,
    prefix: "$",
    category: "crypto",
    okxPerp: okxSymbol,
    phemexPerp: phemexSymbol,
    phemexMinQty: minQty,
    phemexQtyStep: qtyStep,
    venue: "PHEMEX · USDT perp",
  };
}

// Static list of coins to exclude (already in the static SYMBOLS map).
const EXCLUDED_TICKERS = new Set([
  "BTC", "ETH", "ZEC",
]);

// How many trending coins to track (beyond the static list).
const MAX_TRENDING = 15;

// TTL for a discovered trending coin in the DB: 8 hours (2× the discovery
// interval). This gives coins a full extra cycle of buffer before expiring,
// so a single empty discovery run (e.g. quiet market day) doesn't immediately
// wipe them. Active-trade protection is handled by the signals layer.
const TRENDING_TTL_MS = 8 * 60 * 60 * 1000;

// Refresh interval: every 4 hours.
const DISCOVERY_INTERVAL_MS = 4 * 60 * 60 * 1000;

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

interface TrendingCoin {
  symbol: string;
  cmcRank: number;
  priceChange24h: number;
  price: number;
}

interface CoinGeckoTrendingItem {
  item: {
    symbol: string;
    score: number; // 0-indexed trending rank
    data?: {
      price?: number;
      price_change_percentage_24h?: Record<string, number>;
    };
  };
}

interface CoinGeckoMarketItem {
  symbol: string;
  current_price: number;
  price_change_percentage_24h: number;
  total_volume: number;
}

// Fetch top 24h gainers from CoinGecko markets. Runs alongside trending to
// expand the discovery pool with coins that are pumping right now.
async function fetchTopGainers(): Promise<TrendingCoin[]> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=50&page=1&sparkline=false",
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "Top gainers fetch failed");
      return [];
    }
    const data = (await res.json()) as CoinGeckoMarketItem[];
    return data
      .filter(
        (c) =>
          (c.price_change_percentage_24h ?? 0) > 3 &&
          (c.total_volume ?? 0) > 500_000,
      )
      .map((c, idx) => ({
        symbol: c.symbol.toUpperCase(),
        cmcRank: 100 + idx, // offset so gainers don't collide with trending ranks
        priceChange24h: c.price_change_percentage_24h,
        price: c.current_price ?? 1,
      }));
  } catch (err) {
    logger.warn({ err }, "Top gainers fetch error");
    return [];
  }
}

// Fetch trending coins ranked by user search interest — same concept as the
// CMC trending tab. No API key required.
async function fetchCmcTrending(): Promise<TrendingCoin[]> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/search/trending", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Trending fetch failed");
      return [];
    }
    const json = (await res.json()) as { coins?: CoinGeckoTrendingItem[] };
    return (json.coins ?? []).map((c) => ({
      symbol: c.item.symbol.toUpperCase(),
      cmcRank: (c.item.score ?? 0) + 1,
      priceChange24h: c.item.data?.price_change_percentage_24h?.["usd"] ?? 0,
      price: c.item.data?.price ?? 1,
    }));
  } catch (err) {
    logger.warn({ err }, "Trending fetch error");
    return [];
  }
}

export async function fetchOkxSwapInstruments(): Promise<Map<string, OkxInstrument>> {
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
export async function fetchPhemexPerpProducts(): Promise<
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
    expires_at timestamptz NOT NULL,
    pinned boolean NOT NULL DEFAULT false
  )
`;

// Far-future timestamp used for pinned coins (avoids PostgreSQL 'infinity' edge cases).
const PINNED_EXPIRES_AT = new Date("2099-01-01T00:00:00Z");

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(CREATE_TABLE_SQL);
  // Idempotent column migration for existing deployments that predate the pinned column.
  await pool.query(
    "ALTER TABLE trending_symbols ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false",
  );
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
        // WHERE NOT trending_symbols.pinned: skip update entirely for pinned coins
        // so auto-discovery never overwrites a user-pinned coin's expiry or metadata.
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
           expires_at = EXCLUDED.expires_at
         WHERE NOT trending_symbols.pinned`,
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

    // Purge rows whose TTL has elapsed — never delete pinned coins.
    await pool.query("DELETE FROM trending_symbols WHERE expires_at < NOW() AND NOT pinned");
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
      pinned: boolean;
    }>(
      // Load active auto-discovered coins + ALL pinned coins (pinned have far-future expires_at
      // but we guard explicitly so pinned coins always appear even if expires_at were stale).
      "SELECT * FROM trending_symbols WHERE expires_at > NOW() OR pinned = true ORDER BY price_change_24h DESC",
    );

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
          row.pinned,
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

    const [trendingCoins, gainerCoins, okxMap, phemexMap] = await Promise.all([
      fetchCmcTrending(),
      fetchTopGainers(),
      fetchOkxSwapInstruments(),
      fetchPhemexPerpProducts(),
    ]);

    // Merge trending + gainers, deduplicating by ticker (trending takes priority),
    // then sort by 24h gain descending so the biggest movers get first pick of slots.
    const seenTickers = new Set(trendingCoins.map((c) => c.symbol));
    const mergedCoins: TrendingCoin[] = [
      ...trendingCoins,
      ...gainerCoins.filter((c) => !seenTickers.has(c.symbol)),
    ].sort((a, b) => (b.priceChange24h ?? 0) - (a.priceChange24h ?? 0));

    if (mergedCoins.length === 0) {
      logger.warn("No trending or gainer data returned — skipping discovery cycle");
      return;
    }

    if (phemexMap.size === 0) {
      logger.warn("Phemex returned no USDT-perp products — skipping discovery cycle");
      return;
    }

    const discovered: TrendingMeta[] = [];

    // Iterate merged list: trending first (by search interest), then gainers.
    for (const coin of mergedCoins) {
      if (discovered.length >= MAX_TRENDING) break;
      const { symbol: ticker, cmcRank, priceChange24h: change, price } = coin;
      if (EXCLUDED_TICKERS.has(ticker)) continue;

      const okxKey = `${ticker}-USDT-SWAP`;
      if (!okxMap.has(okxKey)) continue; // need OKX for candle data

      const phemexKey = `${ticker}USDT`;
      const phemexInst = phemexMap.get(phemexKey);
      if (!phemexInst) continue; // must be listed as a Phemex USDT-perp

      const decimals = inferDecimals(price);
      const expiresAt = Date.now() + TRENDING_TTL_MS;
      const discoveredAt = Date.now(); // will be preserved in DB on conflict

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
          cmcRank,
          expiresAt,
          discoveredAt,
        ),
      );
    }

    if (discovered.length === 0) {
      logger.info("No qualifying trending coins this cycle (CMC × OKX × Phemex) — extending TTL on existing cache");
      // No new coins qualify, but we must not let previously-discovered coins silently
      // expire from the DB. Refresh their expires_at by the full TTL so they survive
      // until the next successful discovery cycle.
      const now = Date.now();
      const surviving = trendingCache.filter((t) => t.expiresAt > now);
      if (surviving.length > 0) {
        const refreshed = surviving.map((t) => ({ ...t, expiresAt: now + TRENDING_TTL_MS }));
        trendingCache.length = 0;
        trendingCache.push(...refreshed);
        await persistTrendingToDb(refreshed, pool);
        logger.info({ symbols: refreshed.map((t) => t.symbolKey) }, "Extended TTL on surviving trending coins");
      }
      return;
    }

    logger.info(
      { coins: discovered.map((d) => d.symbolKey) },
      "Trending coins discovered",
    );

    // Merge into in-memory cache:
    // - Coins that appear in this discovery cycle get their rank/change/expiresAt
    //   refreshed but their discoveredAt and pinned state preserved.
    // - Coins that dropped out of the discovery set are kept in cache until their
    //   expiresAt (8h cooldown) so active trades on dropped coins aren't orphaned.
    // - Pinned coins are NEVER overwritten with auto-discovery data and NEVER have
    //   their far-future expiry rolled back to an 8h TTL.
    const existingMap = new Map(trendingCache.map((t) => [t.symbolKey, t]));
    const discoveredKeys = new Set(discovered.map((d) => d.symbolKey));
    for (const d of discovered) {
      const existing = existingMap.get(d.symbolKey);
      if (existing?.pinned) {
        // Pinned coin — keep the pinned entry intact; only refresh market data.
        existingMap.set(d.symbolKey, {
          ...existing,
          priceChange24h: d.priceChange24h,
          rank: d.rank,
        });
      } else {
        existingMap.set(d.symbolKey, {
          ...d,
          discoveredAt: existing ? existing.discoveredAt : d.discoveredAt,
        });
      }
    }
    const now = Date.now();
    trendingCache.length = 0;
    for (const [, meta] of existingMap) {
      if (meta.pinned) {
        // Pinned coins always stay in cache with their far-future expiry intact.
        trendingCache.push(meta);
      } else if (discoveredKeys.has(meta.symbolKey)) {
        // Re-discovered this cycle — already has a fresh expiresAt.
        trendingCache.push(meta);
      } else if (meta.expiresAt > now) {
        // Dropped out this cycle but not yet expired — extend TTL to a full
        // 4h from now so it stays through the next discovery run, then falls
        // off if it still doesn't qualify, freeing the slot for new entrants.
        trendingCache.push({ ...meta, expiresAt: now + TRENDING_TTL_MS });
      }
    }
    trendingCache.sort((a, b) => (b.priceChange24h ?? 0) - (a.priceChange24h ?? 0));

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
  _pool = pool;

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

// ─── Manual watchlist: pin / unpin ───────────────────────────────────────────

/**
 * Pin a coin by ticker (e.g. "LAB", "LABUSDT").
 * Resolves Phemex + OKX metadata, inserts into DB with pinned=true and a
 * far-future expires_at, and updates the in-memory cache immediately.
 */
export async function addPinnedSymbol(
  ticker: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!_pool) return { ok: false, error: "Database not configured" };

  // Normalise: strip trailing USDT if the user typed the full key.
  const base = ticker.toUpperCase().replace(/USDT$/, "");
  const phemexKey = `${base}USDT`;
  const okxKey = `${base}-USDT-SWAP`;

  try {
    const [okxMap, phemexMap] = await Promise.all([
      fetchOkxSwapInstruments(),
      fetchPhemexPerpProducts(),
    ]);

    if (!phemexMap.has(phemexKey)) {
      return { ok: false, error: `${phemexKey} is not listed as a Phemex USDT-perp` };
    }
    if (!okxMap.has(okxKey)) {
      return { ok: false, error: `${okxKey} is not listed as an OKX SWAP instrument` };
    }

    const inst = phemexMap.get(phemexKey)!;

    // Best-effort: infer decimals from live price.
    let price = 1;
    try {
      const p = await fetchOkxPerpPrice(okxKey);
      if (p !== null) price = p;
    } catch { /* use fallback */ }
    const decimals = inferDecimals(price);

    await ensureTable(_pool);
    await _pool.query(
      `INSERT INTO trending_symbols
         (symbol_key, base_asset, okx_symbol, phemex_symbol, decimals, min_qty, qty_step,
          price_change_24h, rank, discovered_at, expires_at, pinned)
       VALUES ($1,$2,$3,$4,$5,$6,$7, 0, 999, NOW(), $8, true)
       ON CONFLICT (symbol_key) DO UPDATE SET
         pinned    = true,
         expires_at = $8`,
      [phemexKey, base, okxKey, phemexKey, decimals, inst.minQty, inst.qtyStep, PINNED_EXPIRES_AT.toISOString()],
    );

    // Sync in-memory cache.
    const meta = buildDynamicMeta(
      phemexKey, base, okxKey, phemexKey,
      decimals, inst.minQty, inst.qtyStep,
      0, 999,
      PINNED_EXPIRES_AT.getTime(), Date.now(),
      true,
    );
    const idx = trendingCache.findIndex((t) => t.symbolKey === phemexKey);
    if (idx >= 0) {
      trendingCache[idx] = meta;
    } else {
      trendingCache.push(meta);
    }

    logger.info({ symbolKey: phemexKey }, "Pinned coin added to watchlist");
    return { ok: true };
  } catch (err) {
    logger.warn({ err, ticker }, "addPinnedSymbol failed");
    return { ok: false, error: "Internal error resolving coin metadata" };
  }
}

/**
 * Unpin a coin by symbolKey (e.g. "LABUSDT").
 * Only pinned coins can be removed; auto-discovered coins expire naturally.
 */
export async function removePinnedSymbol(
  symbolKey: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!_pool) return { ok: false, error: "Database not configured" };

  try {
    await ensureTable(_pool);
    const check = await _pool.query<{ pinned: boolean }>(
      "SELECT pinned FROM trending_symbols WHERE symbol_key = $1",
      [symbolKey],
    );
    if (check.rows.length === 0) {
      return { ok: false, error: `${symbolKey} not found in watchlist` };
    }
    if (!check.rows[0].pinned) {
      return { ok: false, error: "Only manually-pinned coins can be removed; auto-discovered coins expire on their own" };
    }

    await _pool.query("DELETE FROM trending_symbols WHERE symbol_key = $1 AND pinned = true", [symbolKey]);

    // Remove from in-memory cache.
    const idx = trendingCache.findIndex((t) => t.symbolKey === symbolKey);
    if (idx >= 0) trendingCache.splice(idx, 1);

    logger.info({ symbolKey }, "Pinned coin removed from watchlist");
    return { ok: true };
  } catch (err) {
    logger.warn({ err, symbolKey }, "removePinnedSymbol failed");
    return { ok: false, error: "Internal error removing coin from watchlist" };
  }
}
