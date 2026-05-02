import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLevelsResponse,
  GetLevelsQueryParams,
  GetPriceHistoryResponse,
  GetPriceHistoryQueryParams,
  GetActiveSignalsResponse,
  GetActiveSignalsQueryParams,
} from "@workspace/api-zod";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
} from "../lib/yahoo-fetch";
import { SYMBOLS, makeRounder, ALL_SYMBOLS, type Symbol } from "../lib/symbols";
import { computeLevelsStable, fetchSpotPrice } from "../lib/signals";

// Timeframes scanned for the all-signals overview. Mirrors the dashboard's
// timeframe selector so the overview shows every signal a trader could be
// monitoring (Telegram only alerts on 30m/1h/1d, but 15m matters for entries).
const OVERVIEW_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "1d"];

const router: IRouter = Router();

router.get("/levels", async (req: Request, res: Response) => {
  try {
    const query = GetLevelsQueryParams.parse(req.query);
    const symbol = (query.symbol ?? "XAGUSD") as Symbol;
    const timeframe = (query.timeframe ?? "1d") as Timeframe;
    // Convert riskPct from human form (1 = 1%) to fraction (0.01) for the
    // signals helper. Clamp to a sane range so a misconfigured client can't
    // produce nonsense leverage values.
    const accountSize = Math.max(1, Math.min(10_000_000, query.accountSize ?? 500));
    const riskPctFrac = Math.max(0.0001, Math.min(1, (query.riskPct ?? 1) / 100));
    const minCollateral = Math.max(0.01, Math.min(1_000_000, query.minCollateral ?? 10));
    const maxLeverage = Math.max(1, Math.min(200, query.maxLeverage ?? 50));
    const [candles, spotPrice] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
    ]);
    if (candles.length < 2) {
      res.status(503).json({ error: "Insufficient candle data for timeframe" });
      return;
    }
    const data = GetLevelsResponse.parse(
      computeLevelsStable(
        candles,
        spotPrice,
        timeframe,
        symbol,
        accountSize,
        riskPctFrac,
        minCollateral,
        maxLeverage,
      ),
    );
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to compute levels");
    res.status(500).json({ error: "Failed to compute price levels" });
  }
});

router.get("/price-history", async (req: Request, res: Response) => {
  try {
    const query = GetPriceHistoryQueryParams.parse(req.query);
    const symbol = (query.symbol ?? "XAGUSD") as Symbol;
    const timeframe = (query.timeframe ?? "1d") as Timeframe;
    const requestedBars = query.bars ?? 200;
    const bars = Math.max(1, Math.min(2000, Math.floor(requestedBars)));

    const [allCandles, spotPrice] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
    ]);
    if (allCandles.length === 0) {
      res.status(503).json({ error: "No candle data available" });
      return;
    }

    const round = makeRounder(SYMBOLS[symbol].decimals);
    const sliced = allCandles.slice(-bars);
    if (sliced.length === 0) {
      res.status(503).json({ error: "No candle data in requested window" });
      return;
    }
    const last = sliced[sliced.length - 1];
    const effectiveSpot = spotPrice ?? last.close;
    // Align Yahoo candles to OANDA spot via ratio scaling so the latest
    // close equals the OANDA price exactly and earlier bars are scaled
    // proportionally — keeps shape but matches OANDA price levels.
    const factor = last.close > 0 ? effectiveSpot / last.close : 1;
    const aligned = sliced.map((c, i) => {
      if (i === sliced.length - 1) {
        return {
          date: c.date,
          open: round(c.open * factor),
          high: round(Math.max(c.high * factor, effectiveSpot)),
          low: round(Math.min(c.low * factor, effectiveSpot)),
          close: round(effectiveSpot),
          volume: c.volume,
        };
      }
      return {
        date: c.date,
        open: round(c.open * factor),
        high: round(c.high * factor),
        low: round(c.low * factor),
        close: round(c.close * factor),
        volume: c.volume,
      };
    });

    const data = GetPriceHistoryResponse.parse({
      symbol,
      candles: aligned,
      currentPrice: round(effectiveSpot),
      lastUpdated: new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch price history");
    res.status(500).json({ error: "Failed to fetch price history" });
  }
});

// Overview of every currently-active BUY/SELL signal across all tracked
// symbols × timeframes. Recomputes each combo via computeLevelsStable so
// the response reflects fresh current price + dynamic state (PENDING vs
// filled-in-profit/drawdown/TP1) rather than stale frozen text.
router.get("/active-signals", async (req: Request, res: Response) => {
  try {
    // Same sizing inputs as /levels — flow them through so the overview's
    // Jupiter $col×lev / SL/TP1/TP2 dollar projections match what the
    // signal panel shows for the same symbol.
    const params = GetActiveSignalsQueryParams.parse(req.query);
    const { accountSize, riskPct, minCollateral, maxLeverage } = params;

    // Dedupe spot fetches: each symbol's spot is the same regardless of
    // timeframe, so issue ONE upstream call per symbol (was 4× before, which
    // caused thundering-herd pressure on OANDA/OKX before the cache populated).
    const spotPromises = new Map<Symbol, Promise<number | null>>();
    for (const symbol of ALL_SYMBOLS) {
      spotPromises.set(symbol, fetchSpotPrice(symbol));
    }

    const combos: Array<{ symbol: Symbol; timeframe: Timeframe }> = [];
    for (const symbol of ALL_SYMBOLS) {
      for (const timeframe of OVERVIEW_TIMEFRAMES) {
        combos.push({ symbol, timeframe });
      }
    }

    type ComboResult =
      | { ok: true; symbol: Symbol; timeframe: Timeframe; levels: ReturnType<typeof computeLevelsStable> }
      | { ok: false; symbol: Symbol; timeframe: Timeframe };

    const results: ComboResult[] = await Promise.all(
      combos.map(async ({ symbol, timeframe }): Promise<ComboResult> => {
        try {
          const [candles, spot] = await Promise.all([
            fetchCandlesForTimeframe(symbol, timeframe),
            spotPromises.get(symbol)!,
          ]);
          if (candles.length < 2) return { ok: false, symbol, timeframe };
          const levels = computeLevelsStable(
            candles,
            spot,
            timeframe,
            symbol,
            accountSize,
            riskPct / 100,
            minCollateral,
            maxLeverage,
          );
          return { ok: true, symbol, timeframe, levels };
        } catch (err) {
          // Per-combo failures must not blank the whole overview, but they
          // ARE surfaced via the coverage block so the UI can distinguish
          // "no signals" from "data feed degraded".
          req.log.warn({ err, symbol, timeframe }, "active-signals combo failed");
          return { ok: false, symbol, timeframe };
        }
      }),
    );

    const succeeded = results.filter((r): r is Extract<ComboResult, { ok: true }> => r.ok);
    const failed = results.filter((r): r is Extract<ComboResult, { ok: false }> => !r.ok);
    const failedSymbols = Array.from(new Set(failed.map((r) => r.symbol)));

    const signals = succeeded
      .filter((r) => r.levels.signal === "BUY" || r.levels.signal === "SELL")
      .map((r) => ({ symbol: r.symbol, timeframe: r.timeframe, levels: r.levels }));

    const data = GetActiveSignalsResponse.parse({
      signals,
      coverage: {
        total: combos.length,
        succeeded: succeeded.length,
        failed: failed.length,
        failedSymbols,
      },
      lastUpdated: new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to compute active signals");
    res.status(500).json({ error: "Failed to compute active signals" });
  }
});

export default router;
