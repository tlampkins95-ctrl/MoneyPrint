import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLevelsResponse,
  GetLevelsQueryParams,
  GetPriceHistoryResponse,
  GetPriceHistoryQueryParams,
} from "@workspace/api-zod";
import {
  fetchCandlesForTimeframe,
  type Timeframe,
} from "../lib/yahoo-fetch";
import { SYMBOLS, makeRounder, type Symbol } from "../lib/symbols";
import { computeLevels, fetchSpotPrice } from "../lib/signals";

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
    const [candles, spotPrice] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
    ]);
    if (candles.length < 2) {
      res.status(503).json({ error: "Insufficient candle data for timeframe" });
      return;
    }
    const data = GetLevelsResponse.parse(
      computeLevels(candles, spotPrice, timeframe, symbol, accountSize, riskPctFrac),
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

export default router;
