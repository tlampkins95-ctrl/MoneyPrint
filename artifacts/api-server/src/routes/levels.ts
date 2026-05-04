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
import { computeLevelsStable, fetchSpotPrice, applyFuturesBasis } from "../lib/signals";

// Only 30m is tracked in the active-signals overview. It's the entry
// timeframe — 1h and daily are alignment gates, not signals in their own right.
const OVERVIEW_TIMEFRAMES: Timeframe[] = ["30m"];

const router: IRouter = Router();

// Gates applied to lower-TF signals. Checked in order; first failure suppresses.
//
//  require_agree  — higher TF must show the SAME direction (BUY/SELL).
//                   WAIT on the higher TF also suppresses (no confirmation).
//                   Use for: 1h confirming 30m entries.
//
//  block_oppose   — higher TF may say anything EXCEPT the opposite direction.
//                   WAIT on the higher TF is fine (neutral, not blocking).
//                   Use for: daily not fighting 30m/1h direction.
interface TfGate {
  higherTf: Timeframe;
  mode: "require_agree" | "block_oppose";
}
const TF_GATES: Partial<Record<Timeframe, TfGate[]>> = {
  "30m": [
    { higherTf: "1h", mode: "require_agree" }, // 1h must confirm direction
    { higherTf: "1d", mode: "block_oppose"  }, // daily must not oppose
  ],
};

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
    const mt5Lots = Math.max(0.01, Math.min(100, query.mt5Lots ?? 0.01));

    const gates = TF_GATES[timeframe] ?? [];

    // Fetch candles for every unique higher TF in parallel with the primary fetch
    const uniqueHigherTfs = [...new Set(gates.map((g) => g.higherTf))];
    const [candles, spotPrice, ...higherTfCandlesArr] = await Promise.all([
      fetchCandlesForTimeframe(symbol, timeframe),
      fetchSpotPrice(symbol),
      ...uniqueHigherTfs.map((tf) => fetchCandlesForTimeframe(symbol, tf)),
    ]);
    const higherTfMap = new Map(
      uniqueHigherTfs.map((tf, i) => [tf, higherTfCandlesArr[i]]),
    );

    if (candles.length < 2) {
      res.status(503).json({ error: "Insufficient candle data for timeframe" });
      return;
    }
    const round = makeRounder(SYMBOLS[symbol].decimals);
    const adjustedCandles =
      spotPrice != null && SYMBOLS[symbol].hasFuturesBasis
        ? applyFuturesBasis(candles, spotPrice, round)
        : candles;

    const result = computeLevelsStable(
      adjustedCandles,
      spotPrice,
      timeframe,
      symbol,
      accountSize,
      riskPctFrac,
      minCollateral,
      maxLeverage,
      mt5Lots,
    );

    // ── Multi-gate alignment check ────────────────────────────────────────────
    // Run each gate in order. First failure suppresses the signal to WAIT.
    //
    // Gates only apply to PENDING (unfilled) limit orders. A FILLED trade
    // means the trader is already in the position — suppressing it to WAIT
    // hides a live trade from the signal panel while Active Signals (which
    // skips gates) still shows it, producing a contradictory display.
    // Once filled, show the real trade state regardless of higher-TF alignment.
    const isFilledTrade =
      result.tradeState !== "WAIT" && result.tradeState !== "PENDING";
    if (!isFilledTrade && (result.signal === "BUY" || result.signal === "SELL")) {
      for (const gate of gates) {
        const rawHigher = higherTfMap.get(gate.higherTf);
        if (!rawHigher || rawHigher.length < 2) continue;

        const adjHigher =
          spotPrice != null && SYMBOLS[symbol].hasFuturesBasis
            ? applyFuturesBasis(rawHigher, spotPrice, round)
            : rawHigher;
        const higherResult = computeLevelsStable(
          adjHigher, spotPrice, gate.higherTf, symbol,
          accountSize, riskPctFrac, minCollateral, maxLeverage, mt5Lots,
        );
        const higherSignal = higherResult.signal;

        const blocked =
          gate.mode === "require_agree"
            ? higherSignal !== result.signal           // must match (WAIT also blocks)
            : higherSignal === (result.signal === "BUY" ? "SELL" : "BUY"); // only block opposite

        if (blocked) {
          const higherLabel = higherSignal === "BUY" || higherSignal === "SELL"
            ? higherSignal : "WAIT";
          const modeNote =
            gate.mode === "block_oppose"
              ? ` (daily WAIT is fine — only blocks when daily opposes)`
              : "";
          const data = GetLevelsResponse.parse({
            ...result,
            signal: "WAIT",
            signalReason:
              `[${timeframe}] ${result.signal} setup suppressed — ` +
              `${gate.higherTf} says ${higherLabel}. ` +
              `Wait for ${gate.higherTf} to align before entering.${modeNote}`,
          });
          res.json(data);
          return;
        }
      }
    }

    const data = GetLevelsResponse.parse(result);
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

    // Drop any live-tick stub Yahoo injects for the current partial period.
    // Yahoo injects a zero-range bar (O=H=L=C) at the EXACT current clock
    // time (e.g. 02:28:38) rather than a candle-grid boundary (e.g. 02:00:00).
    // Genuine market-close candles can also be zero-range but always land on
    // a proper grid boundary, so we only strip stubs whose timestamp has
    // non-zero seconds (intraday) or whose date string contains a "T" with
    // a non-zero seconds component.
    const rawSliced = allCandles.slice(-bars);
    const last = rawSliced[rawSliced.length - 1];
    const isOffGrid = (d: string) => {
      // Intraday ISO strings: "2026-05-04T02:28:38.000Z" — check seconds
      const match = d.match(/T\d{2}:\d{2}:(\d{2})/);
      return match ? parseInt(match[1], 10) !== 0 : false;
    };
    const isLiveTickStub =
      last &&
      last.high === last.low &&
      last.high === last.close &&
      isOffGrid(last.date);
    const sliced = isLiveTickStub ? rawSliced.slice(0, -1) : rawSliced;

    if (sliced.length === 0) {
      res.status(503).json({ error: "No candle data in requested window" });
      return;
    }
    const lastGood = sliced[sliced.length - 1];
    const effectiveSpot = spotPrice ?? lastGood.close;

    // Apply futures basis shift for metals (SI=F / GC=F Yahoo symbols).
    // This shifts every OHLCV bar by the constant basis (spot − futures_close)
    // so chart candles and S/R levels align with broker spot pricing (MT5 /
    // OANDA) rather than showing the futures contango premium (~40c for silver).
    // For spot-priced symbols (EURUSD=X etc.) the basis is effectively zero.
    const aligned = applyFuturesBasis(sliced, effectiveSpot, round);

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
    const { accountSize, riskPct, minCollateral, maxLeverage, mt5Lots } = params;

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
          const adjRound = makeRounder(SYMBOLS[symbol].decimals);
          const adjustedCandles =
            spot != null && SYMBOLS[symbol].hasFuturesBasis
              ? applyFuturesBasis(candles, spot, adjRound)
              : candles;
          const levels = computeLevelsStable(
            adjustedCandles,
            spot,
            timeframe,
            symbol,
            accountSize,
            riskPct / 100,
            minCollateral,
            maxLeverage,
            mt5Lots,
          );

          // Gate: for pending 30m signals, 1h must agree before showing
          // in the overview. Filled trades are exempt — already in position.
          const isFilledTrade =
            levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
          if (
            timeframe === "30m" &&
            !isFilledTrade &&
            (levels.signal === "BUY" || levels.signal === "SELL")
          ) {
            try {
              const rawHigher = await fetchCandlesForTimeframe(symbol, "1h");
              if (rawHigher.length >= 2) {
                const adjRound2 = makeRounder(SYMBOLS[symbol].decimals);
                const adjHigher =
                  spot != null && SYMBOLS[symbol].hasFuturesBasis
                    ? applyFuturesBasis(rawHigher, spot, adjRound2)
                    : rawHigher;
                const higherResult = computeLevelsStable(
                  adjHigher, spot, "1h", symbol,
                  accountSize, riskPct / 100, minCollateral, maxLeverage, mt5Lots,
                );
                if (higherResult.signal !== levels.signal) {
                  return { ok: false, symbol, timeframe };
                }
              }
            } catch {
              // gate fetch failed — include the signal anyway
            }
          }

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
