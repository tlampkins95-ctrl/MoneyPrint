import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLevelsResponse,
  GetPriceHistoryResponse,
  GetPriceHistoryQueryParams,
  GetActiveSignalsResponse,
  GetActiveSignalsQueryParams,
} from "@workspace/api-zod";
import {
  fetchCandlesForTimeframe,
  type CandleRaw,
  type Timeframe,
} from "../lib/yahoo-fetch";
import { SYMBOLS, makeRounder, ALL_SYMBOLS, type Symbol } from "../lib/symbols";
import { computeLevelsStable, fetchSpotPrice, applyFuturesBasis, seedActiveTrades, clearActiveTrade, calcMACDHist } from "../lib/signals";
import { getNotifierStatus } from "../lib/notifier";
import {
  getTrendingSymbols,
  findTrendingSymbolByKey,
  fetchCandlesForDynamic,
  fetchSpotForDynamic,
} from "../lib/trending-discovery";

// ──── Category & Confluence helpers ─────────────────────────────────────────

function getCategory(timeframe: string): "SWING" | "POSITION" {
  if (timeframe === "1h" || timeframe === "4h") return "SWING";
  return "POSITION";
}

const CONFLUENCE_TOLERANCE = 0.003; // 0.3 % price difference — tight enough to be meaningful

function pctDiff(a: number, b: number): number {
  if (a === 0 || b === 0) return Infinity;
  return Math.abs(a - b) / Math.max(a, b);
}

interface SignalConfluence {
  type: "TP1_AT_ENTRY" | "TP2_AT_ENTRY" | "ENTRY_ZONE_OVERLAP";
  withTimeframe: string;
  withSignal: "BUY" | "SELL";
  myLevel: "TP1" | "TP2" | "ENTRY";
  myPrice: number;
  theirLevel: "ENTRY" | "TP1";
  theirPrice: number;
  overlapPct: number;
  label: string;
}

function detectConfluences(
  signals: Array<{ symbol: string; timeframe: string; levels: { signal: string; entryPrice: number; takeProfit1: number; takeProfit2: number } }>,
): Map<string, SignalConfluence> {
  const result = new Map<string, SignalConfluence>();

  const bySymbol = new Map<string, typeof signals>();
  for (const s of signals) {
    const arr = bySymbol.get(s.symbol) ?? [];
    arr.push(s);
    bySymbol.set(s.symbol, arr);
  }

  for (const group of bySymbol.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      const key = `${a.symbol}::${a.timeframe}`;
      if (result.has(key)) continue; // already found best confluence for this signal
      for (const b of group) {
        if (a.timeframe === b.timeframe) continue;

        // Priority 1: TP1 of A lands at entry of B
        const d1 = pctDiff(a.levels.takeProfit1, b.levels.entryPrice);
        if (d1 < CONFLUENCE_TOLERANCE) {
          const isLayered = a.levels.signal !== b.levels.signal;
          result.set(key, {
            type: "TP1_AT_ENTRY",
            withTimeframe: b.timeframe,
            withSignal: b.levels.signal as "BUY" | "SELL",
            myLevel: "TP1",
            myPrice: a.levels.takeProfit1,
            theirLevel: "ENTRY",
            theirPrice: b.levels.entryPrice,
            overlapPct: Number((d1 * 100).toFixed(3)),
            label: isLayered
              ? `TP1 lands at ${b.timeframe} ${b.levels.signal} entry — layered setup`
              : `TP1 confluent with ${b.timeframe} ${b.levels.signal} entry`,
          });
          break;
        }

        // Priority 2: TP2 of A lands at entry of B
        const d2 = pctDiff(a.levels.takeProfit2, b.levels.entryPrice);
        if (d2 < CONFLUENCE_TOLERANCE) {
          const isLayered = a.levels.signal !== b.levels.signal;
          result.set(key, {
            type: "TP2_AT_ENTRY",
            withTimeframe: b.timeframe,
            withSignal: b.levels.signal as "BUY" | "SELL",
            myLevel: "TP2",
            myPrice: a.levels.takeProfit2,
            theirLevel: "ENTRY",
            theirPrice: b.levels.entryPrice,
            overlapPct: Number((d2 * 100).toFixed(3)),
            label: isLayered
              ? `TP2 lands at ${b.timeframe} ${b.levels.signal} entry — layered setup`
              : `TP2 confluent with ${b.timeframe} ${b.levels.signal} entry`,
          });
          break;
        }

        // Priority 3: Same-direction entry confluence (strong zone agreement)
        if (a.levels.signal === b.levels.signal) {
          const d3 = pctDiff(a.levels.entryPrice, b.levels.entryPrice);
          if (d3 < CONFLUENCE_TOLERANCE) {
            result.set(key, {
              type: "ENTRY_ZONE_OVERLAP",
              withTimeframe: b.timeframe,
              withSignal: b.levels.signal as "BUY" | "SELL",
              myLevel: "ENTRY",
              myPrice: a.levels.entryPrice,
              theirLevel: "ENTRY",
              theirPrice: b.levels.entryPrice,
              overlapPct: Number((d3 * 100).toFixed(3)),
              label: `Entry confluent with ${b.timeframe} ${b.levels.signal} — strong zone`,
            });
            break;
          }
        }
      }
    }
  }

  return result;
}

// Show active signals across all tracked entry timeframes.
const OVERVIEW_TIMEFRAMES: Timeframe[] = ["1h", "4h", "1d", "1w"];

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
  "1h": [
    { higherTf: "4h", mode: "block_oppose"  }, // 4h must not oppose 1h signal
    { higherTf: "1d", mode: "block_oppose"  }, // daily must not oppose 1h signal
  ],
  "4h": [
    { higherTf: "1d", mode: "block_oppose"  }, // daily must not oppose 4h signal
  ],
  "1d": [
    { higherTf: "1w", mode: "block_oppose"  }, // weekly must not oppose daily signal
  ],
  // "1w": no gates — weekly is the highest tracked TF
};

router.get("/levels", async (req: Request, res: Response) => {
  try {
    // Symbol: accept both static enum and dynamic trending keys.
    const rawSymbol = typeof req.query.symbol === "string" ? req.query.symbol : "XAGUSD";
    const rawTf = typeof req.query.timeframe === "string" ? req.query.timeframe : "1d";
    const VALID_TIMEFRAMES: Timeframe[] = ["1h", "4h", "1d", "1w"];
    if (!VALID_TIMEFRAMES.includes(rawTf as Timeframe)) {
      res.status(400).json({ error: `Invalid timeframe: ${rawTf}. Must be one of: ${VALID_TIMEFRAMES.join(", ")}` });
      return;
    }
    const timeframe = rawTf as Timeframe;
    const accountSize = Math.max(1, Math.min(10_000_000, Number(req.query.accountSize) || 500));
    const riskPctFrac = Math.max(0.0001, Math.min(1, (Number(req.query.riskPct) || 1) / 100));
    const minCollateral = Math.max(0.01, Math.min(1_000_000, Number(req.query.minCollateral) || 10));
    const maxLeverage = Math.max(1, Math.min(200, Number(req.query.maxLeverage) || 50));
    const mt5Lots = Math.max(0.01, Math.min(100, Number(req.query.mt5Lots) || 0.01));

    // Resolve meta — check static symbols first, then live trending cache,
    // then fall back to the DB (handles coins that recently expired from the
    // in-memory TTL window but are still valid on OKX).
    const isStaticSymbol = rawSymbol in SYMBOLS;
    const trendingMeta = isStaticSymbol
      ? null
      : (getTrendingSymbols().find((t) => t.symbolKey === rawSymbol) ?? await findTrendingSymbolByKey(rawSymbol));
    if (!isStaticSymbol && !trendingMeta) {
      res.status(400).json({ error: `Unknown symbol: ${rawSymbol}` });
      return;
    }

    const gates = TF_GATES[timeframe] ?? [];
    const uniqueHigherTfs = [...new Set(gates.map((g) => g.higherTf))];

    let candles: Awaited<ReturnType<typeof fetchCandlesForTimeframe>>;
    let spotPrice: number | null;

    // For 1H, also fetch daily candles so FIB50_SWING can synthesize weekly
    // bars for the macro trend gate. Fetch in parallel with primary candles.
    let dailyForWeekly: Awaited<ReturnType<typeof fetchCandlesForTimeframe>> | undefined;

    if (isStaticSymbol) {
      const symbol = rawSymbol as Symbol;
      const fetches: Promise<unknown>[] = [
        fetchCandlesForTimeframe(symbol, timeframe),
        fetchSpotPrice(symbol),
      ];
      if (timeframe === "1h" || timeframe === "4h") fetches.push(fetchCandlesForTimeframe(symbol, "1d"));
      const [c, sp, dc] = await Promise.all(fetches);
      candles = c as typeof candles;
      spotPrice = sp as typeof spotPrice;
      if (dc) dailyForWeekly = dc as typeof candles;
    } else {
      // Dynamic trending coin — use OKX candles and spot price.
      const needDailyForWeekly = timeframe === "1h" || timeframe === "4h";
      const fetches: Promise<unknown>[] = [
        fetchCandlesForDynamic(trendingMeta!.okxPerp!, timeframe),
        fetchSpotForDynamic(trendingMeta!.okxPerp!),
      ];
      if (needDailyForWeekly) fetches.push(fetchCandlesForDynamic(trendingMeta!.okxPerp!, "1d"));
      const [c, sp, dc] = await Promise.all(fetches);
      candles = c as typeof candles;
      spotPrice = sp as typeof spotPrice;
      if (dc) dailyForWeekly = dc as typeof candles;
    }

    // Fetch higher-TF candles for gate checks — applies to both static and dynamic symbols.
    const higherTfCandlesArr = await Promise.all(
      uniqueHigherTfs.map((tf) =>
        isStaticSymbol
          ? fetchCandlesForTimeframe(rawSymbol as Symbol, tf)
          : fetchCandlesForDynamic(trendingMeta!.okxPerp!, tf),
      ),
    );
    const higherTfMap = new Map(
      uniqueHigherTfs.map((tf, i) => [tf, higherTfCandlesArr[i] ?? []]),
    );

    if (candles.length < 2) {
      res.status(503).json({ error: "Insufficient candle data for timeframe" });
      return;
    }

    const meta = isStaticSymbol ? SYMBOLS[rawSymbol as Symbol] : trendingMeta!;
    const round = makeRounder(meta.decimals);
    const adjustedCandles =
      isStaticSymbol && spotPrice != null && SYMBOLS[rawSymbol as Symbol].hasFuturesBasis
        ? applyFuturesBasis(candles, spotPrice, round)
        : candles;

    // For 1D: pass actual weekly candles (already fetched for the TF gate) so
    // computeLevels can gate the 1d signal by the weekly EMA21/50 trend.
    const weeklyCandlesForDaily = timeframe === "1d"
      ? (higherTfMap.get("1w") ?? [])
      : undefined;

    const result = computeLevelsStable(
      adjustedCandles,
      spotPrice,
      timeframe,
      rawSymbol,
      meta,
      accountSize,
      riskPctFrac,
      minCollateral,
      maxLeverage,
      mt5Lots,
      dailyForWeekly,
      weeklyCandlesForDaily,
    );

    // ── Multi-gate alignment check (applies to both static and dynamic symbols) ─
    const isFilledTrade =
      result.tradeState !== "WAIT" && result.tradeState !== "PENDING";
    if (!isFilledTrade && (result.signal === "BUY" || result.signal === "SELL")) {
      for (const gate of gates) {
        const rawHigher = higherTfMap.get(gate.higherTf);
        if (!rawHigher || rawHigher.length < 2) continue;

        const adjHigher =
          isStaticSymbol && spotPrice != null && SYMBOLS[rawSymbol as Symbol].hasFuturesBasis
            ? applyFuturesBasis(rawHigher, spotPrice, round)
            : rawHigher;
        const higherResult = computeLevelsStable(
          adjHigher, spotPrice, gate.higherTf, rawSymbol, meta,
          accountSize, riskPctFrac, minCollateral, maxLeverage, mt5Lots,
        );
        const higherSignal = higherResult.signal;

        // For 4h: also suppress when the higher-TF ADX trend directly opposes
        // the signal even if no active setup is on the higher TF yet.
        // e.g. 4h BUY blocked when daily is in confirmed DOWNTREND (and vice-versa).
        const trendOpposes4h =
          timeframe === "4h" && (
            (result.signal === "BUY"  && higherResult.trend === "DOWNTREND") ||
            (result.signal === "SELL" && higherResult.trend === "UPTREND")
          );

        const blocked =
          gate.mode === "require_agree"
            ? higherSignal !== result.signal
            : higherSignal === (result.signal === "BUY" ? "SELL" : "BUY") || trendOpposes4h;

        if (blocked) {
          const higherLabel = higherSignal === "BUY" || higherSignal === "SELL"
            ? higherSignal : "WAIT";
          const trendNote = trendOpposes4h && higherSignal === "WAIT"
            ? ` (daily trend is ${higherResult.trend} — opposing the 4h signal)`
            : "";
          const modeNote =
            !trendOpposes4h && gate.mode === "block_oppose"
              ? ` (daily WAIT is fine — only blocks when daily opposes)`
              : "";
          const data = GetLevelsResponse.parse({
            ...result,
            signal: "WAIT",
            signalReason:
              `[${timeframe}] ${result.signal} setup suppressed — ` +
              `${gate.higherTf} says ${higherLabel}. ` +
              `Wait for ${gate.higherTf} to align before entering.${modeNote}${trendNote}`,
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
    // Parse symbol manually so trending coins (not in the static Zod enum) are
    // accepted. Timeframe and bars still go through the generated schema.
    const rawSymbol = typeof req.query.symbol === "string" ? req.query.symbol : "XAGUSD";
    const rawTf     = typeof req.query.timeframe === "string" ? req.query.timeframe : "1d";
    const VALID_TIMEFRAMES: Timeframe[] = ["1h", "4h", "1d", "1w"];
    if (!VALID_TIMEFRAMES.includes(rawTf as Timeframe)) {
      res.status(400).json({ error: `Invalid timeframe: ${rawTf}` });
      return;
    }
    const timeframe = rawTf as Timeframe;
    const requestedBars = Number(req.query.bars) || 200;
    const bars = Math.max(1, Math.min(2000, Math.floor(requestedBars)));

    // Resolve symbol — static or trending (with DB fallback for expired coins).
    const isStaticSymbol = rawSymbol in SYMBOLS;
    const trendingMeta = isStaticSymbol
      ? null
      : (getTrendingSymbols().find((t) => t.symbolKey === rawSymbol) ?? await findTrendingSymbolByKey(rawSymbol));
    if (!isStaticSymbol && !trendingMeta) {
      res.status(400).json({ error: `Unknown symbol: ${rawSymbol}` });
      return;
    }

    let allCandles: Awaited<ReturnType<typeof fetchCandlesForTimeframe>>;
    let spotPrice: number | null;

    if (isStaticSymbol) {
      const sym = rawSymbol as Symbol;
      [allCandles, spotPrice] = await Promise.all([
        fetchCandlesForTimeframe(sym, timeframe),
        fetchSpotPrice(sym),
      ]);
    } else {
      [allCandles, spotPrice] = await Promise.all([
        fetchCandlesForDynamic(trendingMeta!.okxPerp!, timeframe),
        fetchSpotForDynamic(trendingMeta!.okxPerp!),
      ]);
    }

    if (allCandles.length === 0) {
      res.status(503).json({ error: "No candle data available" });
      return;
    }

    const decimals = isStaticSymbol ? SYMBOLS[rawSymbol as Symbol].decimals : trendingMeta!.decimals;
    const round = makeRounder(decimals);

    const rawSliced = allCandles.slice(-bars);
    const last = rawSliced[rawSliced.length - 1];
    const isOffGrid = (d: string) => {
      const match = d.match(/T\d{2}:\d{2}:(\d{2})/);
      return match ? parseInt(match[1], 10) !== 0 : false;
    };
    const isLiveTickStub =
      last && last.high === last.low && last.high === last.close && isOffGrid(last.date);
    const sliced = isLiveTickStub ? rawSliced.slice(0, -1) : rawSliced;

    if (sliced.length === 0) {
      res.status(503).json({ error: "No candle data in requested window" });
      return;
    }
    const lastGood = sliced[sliced.length - 1];
    const effectiveSpot = spotPrice ?? lastGood.close;

    // Only apply futures basis adjustment for static symbols that need it.
    const aligned =
      isStaticSymbol && spotPrice != null && SYMBOLS[rawSymbol as Symbol].hasFuturesBasis
        ? applyFuturesBasis(sliced, effectiveSpot, round)
        : sliced;

    const data = GetPriceHistoryResponse.parse({
      symbol: rawSymbol,
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
    const params = GetActiveSignalsQueryParams.parse(req.query);
    const { accountSize, riskPct, minCollateral, maxLeverage, mt5Lots } = params;

    // Dedupe spot fetches per symbol.
    const spotPromises = new Map<string, Promise<number | null>>();
    for (const symbol of ALL_SYMBOLS) {
      spotPromises.set(symbol, fetchSpotPrice(symbol));
    }

    // Include trending coins in spot deduplication.
    const trendingNow = getTrendingSymbols();
    for (const t of trendingNow) {
      if (!spotPromises.has(t.symbolKey)) {
        spotPromises.set(t.symbolKey, fetchSpotForDynamic(t.okxPerp!));
      }
    }

    type ComboItem =
      | { kind: "static"; symbol: Symbol; timeframe: Timeframe }
      | { kind: "dynamic"; symbolKey: string; timeframe: Timeframe };

    const combos: ComboItem[] = [];
    for (const symbol of ALL_SYMBOLS) {
      for (const timeframe of OVERVIEW_TIMEFRAMES) {
        combos.push({ kind: "static", symbol, timeframe });
      }
    }
    for (const t of trendingNow) {
      for (const timeframe of OVERVIEW_TIMEFRAMES) {
        combos.push({ kind: "dynamic", symbolKey: t.symbolKey, timeframe });
      }
    }

    type ComboResult =
      | { ok: true; symbolKey: string; timeframe: Timeframe; levels: ReturnType<typeof computeLevelsStable> }
      | { ok: false; symbolKey: string; timeframe: Timeframe };

    const results: ComboResult[] = await Promise.all(
      combos.map(async (combo): Promise<ComboResult> => {
        const symbolKey = combo.kind === "static" ? combo.symbol : combo.symbolKey;
        const timeframe = combo.timeframe;
        try {
          if (combo.kind === "static") {
            const symbol = combo.symbol;
            const fetches: Promise<unknown>[] = [
              fetchCandlesForTimeframe(symbol, timeframe),
              spotPromises.get(symbol)!,
            ];
            if (timeframe === "1h" || timeframe === "4h") fetches.push(fetchCandlesForTimeframe(symbol, "1d"));
            if (timeframe === "1d") fetches.push(fetchCandlesForTimeframe(symbol, "1w"));
            const [candlesRaw, spotRaw, extraRaw] = await Promise.all(fetches);
            const candles = candlesRaw as Awaited<ReturnType<typeof fetchCandlesForTimeframe>>;
            const spot = spotRaw as number | null;
            const dailyForWeekly = (timeframe === "1h" || timeframe === "4h") && extraRaw ? (extraRaw as typeof candles) : undefined;
            const weeklyCandlesForDailyStatic = timeframe === "1d" && extraRaw ? (extraRaw as typeof candles) : undefined;
            if (candles.length < 2) return { ok: false, symbolKey, timeframe };
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
              SYMBOLS[symbol],
              accountSize,
              riskPct / 100,
              minCollateral,
              maxLeverage,
              mt5Lots,
              dailyForWeekly,
              weeklyCandlesForDailyStatic,
            );

            // Apply TF_GATES for this timeframe (filled trades bypass gates).
            const isFilledTrade =
              levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";
            if (!isFilledTrade && (levels.signal === "BUY" || levels.signal === "SELL")) {
              const gates = TF_GATES[timeframe] ?? [];
              for (const gate of gates) {
                try {
                  const rawHigher = await fetchCandlesForTimeframe(symbol, gate.higherTf);
                  if (rawHigher.length >= 2) {
                    const adjRound2 = makeRounder(SYMBOLS[symbol].decimals);
                    const adjHigher =
                      spot != null && SYMBOLS[symbol].hasFuturesBasis
                        ? applyFuturesBasis(rawHigher, spot, adjRound2)
                        : rawHigher;
                    const higherResult = computeLevelsStable(
                      adjHigher, spot, gate.higherTf, symbol, SYMBOLS[symbol],
                      accountSize, riskPct / 100, minCollateral, maxLeverage, mt5Lots,
                    );
                    const opposite = levels.signal === "BUY" ? "SELL" : "BUY";
                    const trendOpposes4h =
                      timeframe === "4h" && (
                        (levels.signal === "BUY"  && higherResult.trend === "DOWNTREND") ||
                        (levels.signal === "SELL" && higherResult.trend === "UPTREND")
                      );
                    const suppressed =
                      gate.mode === "require_agree"
                        ? higherResult.signal !== levels.signal
                        : higherResult.signal === opposite || trendOpposes4h;
                    if (suppressed) {
                      const trendNote = trendOpposes4h && higherResult.signal === "WAIT"
                        ? ` (daily trend is ${higherResult.trend})`
                        : "";
                      return {
                        ok: true,
                        symbolKey,
                        timeframe,
                        levels: {
                          ...levels,
                          signal: "WAIT" as const,
                          tradeState: "WAIT" as const,
                          signalReason: `[${timeframe}] ${levels.signal} suppressed — ${gate.higherTf} says ${higherResult.signal ?? "WAIT"}. Wait for alignment.${trendNote}`,
                        },
                      };
                    }
                  }
                } catch {
                  // gate fetch failed — include the signal anyway
                }
              }
            }

            return { ok: true, symbolKey, timeframe, levels };
          } else {
            // Dynamic trending coin — same gate logic as static.
            const tMeta = trendingNow.find((t) => t.symbolKey === combo.symbolKey);
            if (!tMeta) return { ok: false, symbolKey, timeframe };
            const needDailyForWeekly = timeframe === "1h" || timeframe === "4h";
            const [candles, spot, rawDailyForWeekly] = await Promise.all([
              fetchCandlesForDynamic(tMeta.okxPerp!, timeframe),
              spotPromises.get(combo.symbolKey)!,
              needDailyForWeekly ? fetchCandlesForDynamic(tMeta.okxPerp!, "1d") : Promise.resolve([]),
            ]);
            if (candles.length < 2) return { ok: false, symbolKey, timeframe };
            const dailyForWeekly = needDailyForWeekly && (rawDailyForWeekly as CandleRaw[]).length > 0
              ? (rawDailyForWeekly as CandleRaw[])
              : undefined;
            const levels = computeLevelsStable(
              candles,
              spot,
              timeframe,
              combo.symbolKey,
              tMeta,
              accountSize,
              riskPct / 100,
              minCollateral,
              maxLeverage,
              mt5Lots,
              dailyForWeekly,
            );

            const dynFilledTrade =
              levels.tradeState !== "WAIT" && levels.tradeState !== "PENDING";

            return { ok: true, symbolKey, timeframe, levels };
          }
        } catch (err) {
          req.log.warn({ err, symbolKey, timeframe }, "active-signals combo failed");
          return { ok: false, symbolKey, timeframe };
        }
      }),
    );

    const succeeded = results.filter((r): r is Extract<ComboResult, { ok: true }> => r.ok);
    const failed = results.filter((r): r is Extract<ComboResult, { ok: false }> => !r.ok);
    const failedSymbols = Array.from(new Set(failed.map((r) => r.symbolKey)));

    const rawSignals = succeeded
      .filter((r) => r.levels.signal === "BUY" || r.levels.signal === "SELL")
      .map((r) => ({ symbol: r.symbolKey, timeframe: r.timeframe, levels: r.levels }));

    const confluenceMap = detectConfluences(rawSignals);

    const signals = rawSignals.map((s) => ({
      ...s,
      category: getCategory(s.timeframe),
      confluence: confluenceMap.get(`${s.symbol}::${s.timeframe}`),
    }));

    const payload = {
      signals,
      coverage: {
        total: combos.length,
        succeeded: succeeded.length,
        failed: failed.length,
        failedSymbols,
      },
      lastUpdated: new Date().toISOString(),
    };
    const parsed = GetActiveSignalsResponse.safeParse(payload);
    if (!parsed.success) {
      req.log.warn({ err: parsed.error }, "GetActiveSignalsResponse schema mismatch — returning raw data");
    }
    res.json(parsed.success ? parsed.data : payload);
  } catch (err) {
    req.log.error({ err }, "Failed to compute active signals");
    res.status(500).json({ error: "Failed to compute active signals" });
  }
});

// GET /api/trending-symbols — list of dynamically-discovered trending coins.
router.get("/trending-symbols", (_req: Request, res: Response) => {
  const symbols = getTrendingSymbols().slice().sort((a, b) => (b.priceChange24h ?? 0) - (a.priceChange24h ?? 0));
  const now = Date.now();
  res.json({
    symbols: symbols.map((t) => ({
      symbolKey: t.symbolKey,
      baseAsset: t.baseAsset,
      okxSymbol: t.okxPerp!,
      phemexSymbol: t.phemexPerp!,
      decimals: t.decimals,
      priceChange24h: t.priceChange24h,
      rank: t.rank,
      discoveredAt: new Date(t.discoveredAt).toISOString(),
      expiresAt: new Date(t.expiresAt).toISOString(),
    })),
    lastUpdated: new Date().toISOString(),
  });
});

// GET /api/symbol-changes — 24h % change for watchlist symbols via CMC quotes.
// Maps our internal symbol key → CMC ticker symbol.
const CMC_WATCHLIST: Record<string, string> = {
  ZECUSD: "ZEC",
};
router.get("/symbol-changes", async (_req: Request, res: Response) => {
  const changes: Record<string, number | null> = Object.fromEntries(
    Object.keys(CMC_WATCHLIST).map((k) => [k, null]),
  );
  const apiKey = process.env["COINMARKETCAP_API_KEY"];
  if (apiKey) {
    try {
      const tickers = Object.values(CMC_WATCHLIST).join(",");
      const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${tickers}&convert=USD`;
      const r = await fetch(url, {
        headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) {
        const json = (await r.json()) as { data?: Record<string, { quote: { USD: { percent_change_24h: number } } }> };
        for (const [symKey, cmcTicker] of Object.entries(CMC_WATCHLIST)) {
          const entry = json.data?.[cmcTicker];
          changes[symKey] = entry?.quote?.USD?.percent_change_24h ?? null;
        }
      }
    } catch { /* return nulls */ }
  }
  res.json({ changes });
});

// ─── Admin seed endpoint ──────────────────────────────────────────────────────
router.post("/admin/seed-trades", (req: Request, res: Response) => {
  const secret = process.env["ADMIN_SECRET"];
  if (!secret) {
    res.status(503).json({ error: "Admin endpoint not configured" });
    return;
  }
  const auth = req.headers["authorization"] ?? "";
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Expected JSON object body" });
    return;
  }
  const count = seedActiveTrades(body);
  res.json({ ok: true, seeded: count });
});

// DELETE /api/admin/active-trade?symbol=XAUUSD&timeframe=30m
router.delete("/admin/active-trade", (req: Request, res: Response) => {
  const secret = process.env["ADMIN_SECRET"];
  if (!secret) { res.status(503).json({ error: "Admin endpoint not configured" }); return; }
  const provided = req.headers["x-admin-secret"];
  if (provided !== secret) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { symbol, timeframe } = req.query as { symbol?: string; timeframe?: string };
  if (!symbol || !timeframe) { res.status(400).json({ error: "symbol and timeframe required" }); return; }
  clearActiveTrade(symbol, timeframe as Timeframe);
  res.json({ ok: true, cleared: `${symbol}::${timeframe}` });
});

// GET /api/notifier-status
// Returns the current state of the signal notifier including per-symbol/TF
// cooldown info and the consecutive-SL circuit-breaker streak counters.
router.get("/notifier-status", (_req: Request, res: Response) => {
  res.json(getNotifierStatus());
});

export default router;
