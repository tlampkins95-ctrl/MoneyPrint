// CoinMarketCap Top-200-trending discovery — mirrors trending-discovery.ts's
// structure and two-venue existence check, but sources from CoinMarketCap
// instead of CoinGecko/OKX-gainers, per the harmonic-pattern spec's symbol
// universe requirement (static TradingView watchlist ∪ CMC Top 200, filtered
// to symbols with both an OKX SWAP instrument and a Phemex USDT-perp).
//
// Kept as its own table/cache (not merged into trending_symbols) so the two
// discovery systems stay independently inspectable. Candle/spot fetching for
// discovered symbols reuses trending-discovery.ts's fetchCandlesForDynamic/
// fetchSpotForDynamic directly — those are generic over any OKX perp instId,
// not tied to the trending cache, so no need to duplicate them here.

import { Pool } from "pg";
import type { SymbolMeta } from "./symbols";
import { fetchOkxSwapInstruments, fetchPhemexPerpProducts, inferDecimals } from "./trending-discovery";
import { logger } from "./logger";

export interface CmcMeta extends SymbolMeta {
  symbolKey: string;
  baseAsset: string;
  priceChange24h: number;
  cmcRank: number;
  expiresAt: number;
  discoveredAt: number;
}

const cmcCache: CmcMeta[] = [];
let _pool: Pool | null = null;

export function getCmcUniverse(): CmcMeta[] {
  const now = Date.now();
  return cmcCache.filter((c) => c.expiresAt > now);
}

// Checks the live in-memory cache first, then falls back to the DB (including
// recently-expired rows) so a symbol that just dropped out of the TTL window
// still resolves rather than erroring — same fallback trending-discovery.ts
// uses for findTrendingSymbolByKey.
export async function findCmcSymbolByKey(symbolKey: string): Promise<CmcMeta | undefined> {
  const live = cmcCache.find((c) => c.symbolKey === symbolKey);
  if (live) return live;
  if (!_pool) return undefined;
  try {
    const res = await _pool.query<{
      symbol_key: string; base_asset: string; okx_symbol: string; phemex_symbol: string;
      decimals: number; min_qty: number; qty_step: number; price_change_24h: number;
      cmc_rank: number; discovered_at: Date; expires_at: Date;
    }>("SELECT * FROM cmc_symbols WHERE symbol_key = $1 LIMIT 1", [symbolKey]);
    if (res.rows.length === 0) return undefined;
    const row = res.rows[0];
    return buildCmcMeta(
      row.symbol_key, row.base_asset, row.okx_symbol, row.phemex_symbol,
      row.decimals, row.min_qty, row.qty_step, row.price_change_24h, row.cmc_rank,
      new Date(row.expires_at).getTime(), new Date(row.discovered_at).getTime(),
    );
  } catch {
    return undefined;
  }
}

function buildCmcMeta(
  symbolKey: string,
  baseAsset: string,
  okxSymbol: string,
  phemexSymbol: string,
  decimals: number,
  minQty: number,
  qtyStep: number,
  priceChange24h: number,
  cmcRank: number,
  expiresAt: number,
  discoveredAt: number,
): CmcMeta {
  return {
    symbolKey, baseAsset, priceChange24h, cmcRank, expiresAt, discoveredAt,
    yahoo: "",
    tvSymbol: `OKX:${phemexSymbol}.P`,
    tvScrapePath: "",
    label: `${baseAsset} / USDT (CMC Top 200)`,
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

// Coins already covered by the static SYMBOLS map or the TradingView watchlist
// don't need CMC-driven duplication.
const EXCLUDED_TICKERS = new Set(["BTC", "ETH", "SOL", "ZEC"]);

const CMC_LIMIT = 200;
// CMC free tier is rate-limited tighter than CoinGecko — refresh less often.
const DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 4× the discovery interval so one missed/empty cycle doesn't drop a symbol
// out from under an in-progress alert.
const CMC_TTL_MS = 24 * 60 * 60 * 1000;

interface CmcListing {
  symbol: string;
  cmc_rank: number;
  quote: { USD: { percent_change_24h: number; price: number } };
}

async function fetchCmcTop200(): Promise<{ symbol: string; rank: number; priceChange24h: number; price: number }[]> {
  const apiKey = process.env["COINMARKETCAP_API_KEY"];
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${CMC_LIMIT}&convert=USD`,
      {
        headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "CMC listings fetch failed");
      return [];
    }
    const json = (await res.json()) as { data?: CmcListing[] };
    return (json.data ?? []).map((c) => ({
      symbol: c.symbol.toUpperCase(),
      rank: c.cmc_rank,
      priceChange24h: c.quote.USD.percent_change_24h ?? 0,
      price: c.quote.USD.price ?? 1,
    }));
  } catch (err) {
    logger.warn({ err }, "CMC listings fetch error");
    return [];
  }
}

// ─── DB persistence ───────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS cmc_symbols (
    symbol_key text PRIMARY KEY,
    base_asset text NOT NULL,
    okx_symbol text NOT NULL,
    phemex_symbol text NOT NULL,
    decimals integer NOT NULL DEFAULT 4,
    min_qty double precision NOT NULL DEFAULT 1,
    qty_step double precision NOT NULL DEFAULT 1,
    price_change_24h double precision NOT NULL DEFAULT 0,
    cmc_rank integer NOT NULL DEFAULT 999,
    discovered_at timestamptz NOT NULL DEFAULT NOW(),
    expires_at timestamptz NOT NULL
  )
`;

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(CREATE_TABLE_SQL);
}

async function persistCmcToDb(rows: CmcMeta[], pool: Pool): Promise<void> {
  if (rows.length === 0) return;
  try {
    await ensureTable(pool);
    for (const r of rows) {
      await pool.query(
        `INSERT INTO cmc_symbols
           (symbol_key, base_asset, okx_symbol, phemex_symbol, decimals, min_qty, qty_step, price_change_24h, cmc_rank, discovered_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10)
         ON CONFLICT (symbol_key) DO UPDATE SET
           base_asset = EXCLUDED.base_asset,
           okx_symbol = EXCLUDED.okx_symbol,
           phemex_symbol = EXCLUDED.phemex_symbol,
           decimals = EXCLUDED.decimals,
           min_qty = EXCLUDED.min_qty,
           qty_step = EXCLUDED.qty_step,
           price_change_24h = EXCLUDED.price_change_24h,
           cmc_rank = EXCLUDED.cmc_rank,
           expires_at = EXCLUDED.expires_at`,
        [
          r.symbolKey, r.baseAsset, r.okxPerp!, r.phemexPerp!,
          r.decimals, r.phemexMinQty ?? 1, r.phemexQtyStep ?? 1,
          r.priceChange24h, r.cmcRank, new Date(r.expiresAt).toISOString(),
        ],
      );
    }
    await pool.query("DELETE FROM cmc_symbols WHERE expires_at < NOW()");
  } catch (err) {
    logger.warn({ err }, "Failed to persist CMC symbols to DB");
  }
}

async function loadCmcFromDb(pool: Pool): Promise<void> {
  try {
    await ensureTable(pool);
    const res = await pool.query<{
      symbol_key: string; base_asset: string; okx_symbol: string; phemex_symbol: string;
      decimals: number; min_qty: number; qty_step: number; price_change_24h: number;
      cmc_rank: number; discovered_at: Date; expires_at: Date;
    }>("SELECT * FROM cmc_symbols WHERE expires_at > NOW() ORDER BY price_change_24h DESC");

    cmcCache.length = 0;
    for (const row of res.rows) {
      cmcCache.push(buildCmcMeta(
        row.symbol_key, row.base_asset, row.okx_symbol, row.phemex_symbol,
        row.decimals, row.min_qty, row.qty_step, row.price_change_24h, row.cmc_rank,
        new Date(row.expires_at).getTime(), new Date(row.discovered_at).getTime(),
      ));
    }
    if (cmcCache.length > 0) {
      logger.info({ count: cmcCache.length }, "Loaded CMC symbols from DB");
    }
  } catch {
    // Table may not exist yet on first boot — handled by ensureTable above.
  }
}

// ─── Discovery job ─────────────────────────────────────────────────────────────

async function runCmcDiscovery(pool: Pool): Promise<void> {
  try {
    logger.info("Running CMC Top-200 discovery");

    const [coins, okxMap, phemexMap] = await Promise.all([
      fetchCmcTop200(),
      fetchOkxSwapInstruments(),
      fetchPhemexPerpProducts(),
    ]);

    if (coins.length === 0) {
      logger.warn("CMC returned no listings — skipping discovery cycle");
      return;
    }
    if (phemexMap.size === 0) {
      logger.warn("Phemex returned no USDT-perp products — skipping discovery cycle");
      return;
    }

    const discovered: CmcMeta[] = [];
    for (const coin of coins) {
      const ticker = coin.symbol;
      if (EXCLUDED_TICKERS.has(ticker)) continue;

      const okxKey = `${ticker}-USDT-SWAP`;
      if (!okxMap.has(okxKey)) continue; // need OKX for candle data

      const phemexKey = `${ticker}USDT`;
      const phemexInst = phemexMap.get(phemexKey);
      if (!phemexInst) continue; // must be listed as a Phemex USDT-perp

      discovered.push(buildCmcMeta(
        phemexKey, ticker, okxKey, phemexKey,
        inferDecimals(coin.price), phemexInst.minQty, phemexInst.qtyStep,
        coin.priceChange24h, coin.rank, Date.now() + CMC_TTL_MS, Date.now(),
      ));
    }

    logger.info({ count: discovered.length }, "CMC discovery cycle complete");

    // Merge into cache: refresh matched symbols (preserving discoveredAt),
    // and let symbols that dropped out of this cycle's Top 200 decay
    // naturally via their existing expiresAt rather than being force-purged
    // (so an in-progress alert on a coin isn't orphaned by one quiet cycle).
    const existingMap = new Map(cmcCache.map((c) => [c.symbolKey, c]));
    for (const d of discovered) {
      const existing = existingMap.get(d.symbolKey);
      existingMap.set(d.symbolKey, { ...d, discoveredAt: existing ? existing.discoveredAt : d.discoveredAt });
    }
    const now = Date.now();
    cmcCache.length = 0;
    for (const [key, meta] of existingMap) {
      if (discovered.some((d) => d.symbolKey === key) || meta.expiresAt > now) {
        cmcCache.push(meta);
      }
    }
    cmcCache.sort((a, b) => a.cmcRank - b.cmcRank);

    await persistCmcToDb(discovered, pool);
  } catch (err) {
    logger.warn({ err }, "CMC discovery cycle failed");
  }
}

let discoveryStarted = false;

export function startCmcDiscovery(): void {
  if (discoveryStarted) return;
  discoveryStarted = true;

  const poolUrl = process.env["DATABASE_URL"];
  if (!poolUrl) {
    logger.info("No DATABASE_URL — CMC discovery disabled");
    return;
  }
  if (!process.env["COINMARKETCAP_API_KEY"]) {
    logger.info("No COINMARKETCAP_API_KEY — CMC discovery disabled");
    return;
  }

  const pool = new Pool({ connectionString: poolUrl });
  _pool = pool;

  void loadCmcFromDb(pool).then(() => {
    void runCmcDiscovery(pool);
  });

  setInterval(() => {
    void runCmcDiscovery(pool);
  }, DISCOVERY_INTERVAL_MS);
}
