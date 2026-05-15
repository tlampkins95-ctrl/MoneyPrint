import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  BaselineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type Time,
  type LineWidth,
} from "lightweight-charts";
import {
  useGetLevels,
  useGetPriceHistory,
  getGetLevelsQueryKey,
  getGetPriceHistoryQueryKey,
  type GetPriceHistorySymbol,
} from "@workspace/api-client-react";
import type { Timeframe } from "@/components/timeframe-selector";
import { getSymbolMeta, fmtPriceMeta } from "@/lib/symbols";

// Convert any ISO date/datetime string to a UTCTimestamp (seconds) that
// lightweight-charts requires for the time axis. Works for both daily
// ("2026-05-11") and intraday ("2026-05-15T04:00:00.000Z") formats.
function toUTC(dateStr: string): UTCTimestamp {
  return Math.floor(new Date(dateStr).getTime() / 1000) as UTCTimestamp;
}

export function LevelsChart({
  symbol,
  timeframe,
}: {
  symbol: string;
  timeframe: Timeframe;
}) {
  const containerRef      = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<IChartApi | null>(null);
  const candleSeriesRef   = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const buyZoneRef        = useRef<ISeriesApi<"Baseline"> | null>(null);
  const sellZoneRef       = useRef<ISeriesApi<"Baseline"> | null>(null);
  const linesRef          = useRef<IPriceLine[]>([]);
  // First / last candle timestamps — used to anchor zone band data
  const firstTsRef        = useRef<UTCTimestamp | null>(null);
  const lastTsRef         = useRef<UTCTimestamp | null>(null);
  // Only scroll to real-time once per chart instance (not on every 10s refetch)
  const hasScrolledRef    = useRef(false);

  const histParams = { symbol: symbol as GetPriceHistorySymbol, timeframe, bars: 200 };

  const { data: history } = useGetPriceHistory(histParams, {
    query: {
      queryKey: getGetPriceHistoryQueryKey(histParams),
      refetchInterval: 10_000,
    },
  });

  const { data: levels } = useGetLevels(
    { symbol, timeframe },
    {
      query: {
        queryKey: getGetLevelsQueryKey({ symbol, timeframe }),
        refetchInterval: 10_000,
      },
    },
  );

  // ── Create / recreate chart when symbol or timeframe changes ───────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "#0a0a0a" },
        textColor: "#a1a1aa",
        fontSize: 11,
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
      },
      grid: {
        vertLines: { color: "#18181b" },
        horzLines: { color: "#18181b" },
      },
      rightPriceScale: { borderColor: "#27272a" },
      timeScale: {
        borderColor: "#27272a",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
      },
      autoSize: true,
    });

    // ── Candlestick series ────────────────────────────────────────────────
    const candles = chart.addSeries(CandlestickSeries, {
      upColor:          "#22c55e",
      downColor:        "#ef4444",
      borderUpColor:    "#22c55e",
      borderDownColor:  "#ef4444",
      wickUpColor:      "#22c55e",
      wickDownColor:    "#ef4444",
      priceLineVisible: false,
    });

    // ── Buy zone band (BaselineSeries) ────────────────────────────────────
    // baseline = zone.low, data value = zone.high → fills the band between them
    const buyZone = chart.addSeries(BaselineSeries, {
      priceScaleId:     "right",
      baseValue:        { type: "price", price: 0 },
      topFillColor1:    "rgba(34,197,94,0.18)",
      topFillColor2:    "rgba(34,197,94,0.06)",
      bottomFillColor1: "rgba(0,0,0,0)",
      bottomFillColor2: "rgba(0,0,0,0)",
      topLineColor:     "rgba(34,197,94,0.5)",
      bottomLineColor:  "rgba(0,0,0,0)",
      lineWidth:        1 as LineWidth,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // ── Sell zone band (BaselineSeries) ───────────────────────────────────
    const sellZone = chart.addSeries(BaselineSeries, {
      priceScaleId:     "right",
      baseValue:        { type: "price", price: 0 },
      topFillColor1:    "rgba(239,68,68,0.18)",
      topFillColor2:    "rgba(239,68,68,0.06)",
      bottomFillColor1: "rgba(0,0,0,0)",
      bottomFillColor2: "rgba(0,0,0,0)",
      topLineColor:     "rgba(239,68,68,0.5)",
      bottomLineColor:  "rgba(0,0,0,0)",
      lineWidth:        1 as LineWidth,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    candleSeriesRef.current = candles;
    buyZoneRef.current      = buyZone;
    sellZoneRef.current     = sellZone;
    chartRef.current        = chart;
    linesRef.current        = [];
    firstTsRef.current      = null;
    lastTsRef.current       = null;
    hasScrolledRef.current  = false;

    return () => {
      linesRef.current        = [];
      candleSeriesRef.current = null;
      buyZoneRef.current      = null;
      sellZoneRef.current     = null;
      firstTsRef.current      = null;
      lastTsRef.current       = null;
      hasScrolledRef.current  = false;
      try { chart.remove(); } catch { /**/ }
      chartRef.current = null;
    };
  }, [symbol, timeframe]);

  // ── Feed candle data ───────────────────────────────────────────────────
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !history?.candles?.length) return;

    const data = history.candles.map((c) => ({
      time:  toUTC(c.date) as Time,
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));

    series.setData(data);
    firstTsRef.current = toUTC(history.candles[0].date);
    lastTsRef.current  = toUTC(history.candles[history.candles.length - 1].date);

    // Only scroll to the right edge on first load; don't yank the view back
    // every time price-history refreshes (every 10 s).
    if (!hasScrolledRef.current) {
      chartRef.current?.timeScale().scrollToRealTime();
      hasScrolledRef.current = true;
    }
  }, [history]);

  // ── Refresh price lines + zone bands whenever levels change ───────────
  useEffect(() => {
    const series   = candleSeriesRef.current;
    const buyZone  = buyZoneRef.current;
    const sellZone = sellZoneRef.current;
    if (!series || !buyZone || !sellZone || !levels) return;

    // Remove stale price lines
    for (const pl of linesRef.current) {
      try { series.removePriceLine(pl); } catch { /**/ }
    }
    linesRef.current = [];

    const addLine = (
      price: number,
      color: string,
      title: string,
      style: LineStyle = LineStyle.Solid,
      width: LineWidth = 1,
    ) => {
      const pl = series.createPriceLine({ price, color, title, lineWidth: width, lineStyle: style, axisLabelVisible: true });
      linesRef.current.push(pl);
    };

    const isBuy  = levels.signal === "BUY";
    const isSell = levels.signal === "SELL";

    // ── Active trade lines ────────────────────────────────────────────────
    if (isBuy || isSell) {
      addLine(levels.entryPrice, isBuy ? "#22c55e" : "#ef4444", "Entry", LineStyle.Solid, 2);
      addLine(levels.stopLoss,    "#ef4444", "SL",  LineStyle.Dashed);
      addLine(levels.takeProfit1, "#10b981", "TP1", LineStyle.Dashed);
      addLine(levels.takeProfit2, "#10b981", "TP2", LineStyle.Dashed);
    }

    // ── Pivot structure (S1–S3, R1–R3, Pivot) ────────────────────────────
    for (const { label, price, type } of levels.levels) {
      if (label.startsWith("Fib") || label.startsWith("Swing")) continue;
      addLine(
        price,
        type === "resistance" ? "#f97316" : type === "support" ? "#3b82f6" : "#71717a",
        label,
      );
    }

    // ── Pattern neckline ──────────────────────────────────────────────────
    // Draw more prominently (solid, thicker) when the pattern is confirmed.
    if (levels.patternNeckline != null) {
      const confirmed = levels.patternConfirmed === true;
      addLine(
        levels.patternNeckline,
        confirmed ? "#e879f9" : "#a855f7",
        confirmed ? "Neckline ✓" : "Neckline",
        confirmed ? LineStyle.Solid : LineStyle.SparseDotted,
        confirmed ? 2 : 1,
      );
    }

    // ── Zone bands (BaselineSeries) ───────────────────────────────────────
    // Skip until candle timestamps are available (effect re-runs with history dep).
    const anchorTs = firstTsRef.current;
    const latestTs = lastTsRef.current;

    if (anchorTs !== null && latestTs !== null && anchorTs < latestTs) {
      buyZone.applyOptions({ baseValue: { type: "price", price: levels.buyZone.low } });
      buyZone.setData([
        { time: anchorTs as Time, value: levels.buyZone.high },
        { time: latestTs as Time, value: levels.buyZone.high },
      ]);

      sellZone.applyOptions({ baseValue: { type: "price", price: levels.sellZone.low } });
      sellZone.setData([
        { time: anchorTs as Time, value: levels.sellZone.high },
        { time: latestTs as Time, value: levels.sellZone.high },
      ]);
    }
  }, [levels, history]);

  // ── UI ────────────────────────────────────────────────────────────────
  const meta = getSymbolMeta(symbol);

  const signalColor =
    levels?.signal === "BUY"  ? "bg-emerald-500/95 text-black border-emerald-400" :
    levels?.signal === "SELL" ? "bg-red-500/95 text-black border-red-400" :
                                "bg-amber-500/95 text-black border-amber-400";

  const isPatternConfirmed =
    levels?.patternConfirmed === true &&
    levels?.detectedPattern != null;

  const patternLabel = (() => {
    if (!isPatternConfirmed || !levels?.detectedPattern) return null;
    const raw = levels.detectedPattern as string;
    const dir = levels.patternDirection as string | undefined;
    // "DOUBLE_TOP" → "Double Top"
    const name = raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const arrow = dir === "bearish" ? "▼" : dir === "bullish" ? "▲" : "";
    return `${arrow} ${name} Confirmed`;
  })();

  return (
    <div className="relative h-full w-full rounded-sm overflow-hidden border border-zinc-800">
      <div ref={containerRef} className="h-full w-full" />

      {/* Symbol label — top-left */}
      <div className="absolute top-2 left-3 z-20 pointer-events-none font-mono text-[11px] text-zinc-400 select-none">
        {meta.short}
        {meta.venue && <span className="ml-2 text-zinc-600">{meta.venue}</span>}
      </div>

      {/* Signal + live price badge — top-right */}
      {levels && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1 font-mono pointer-events-none select-none">
          <span className={`px-2 py-0.5 rounded-sm font-bold tracking-widest border text-[11px] ${signalColor}`}>
            {levels.signal}
          </span>
          <span className="px-2 py-0.5 rounded-sm bg-black/80 border border-zinc-700 text-zinc-100 text-[11px]">
            {fmtPriceMeta(meta, levels.currentPrice)}
          </span>
        </div>
      )}

      {/* Pattern badge — bottom-left, only when confirmed */}
      {patternLabel && (
        <div className="absolute bottom-6 left-3 z-20 pointer-events-none select-none">
          <span className="px-2 py-0.5 rounded-sm font-mono font-semibold text-[11px] bg-fuchsia-950/90 border border-fuchsia-500/60 text-fuchsia-300 tracking-wide">
            {patternLabel}
          </span>
        </div>
      )}
    </div>
  );
}
