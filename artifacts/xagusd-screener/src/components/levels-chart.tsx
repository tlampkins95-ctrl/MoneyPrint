import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  BaselineSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type BusinessDay,
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

// Convert a candle date string to the correct lightweight-charts Time type.
//
// Daily candles:    "2026-05-11"                → BusinessDay object { year, month, day }.
//   lightweight-charts spaces BusinessDay values as consecutive trading days,
//   so Saturday/Sunday never appear as blank columns.
// Intraday candles: "2026-05-15T04:00:00.000Z" → UTCTimestamp (epoch seconds).
//   Real calendar timestamps are needed so bars land on the correct clock slot.
function toTime(dateStr: string): Time {
  if (dateStr.includes("T")) {
    return Math.floor(new Date(dateStr).getTime() / 1000) as UTCTimestamp;
  }
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day } as BusinessDay;
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
  const patUpperRailRef   = useRef<ISeriesApi<"Line"> | null>(null);
  const patLowerRailRef   = useRef<ISeriesApi<"Line"> | null>(null);
  const linesRef          = useRef<IPriceLine[]>([]);
  // Raw date strings from the first/last candle — used to anchor zone band data.
  // Stored as strings so toTime() can apply the right conversion (business-day
  // vs UTCTimestamp) consistently when building BaselineSeries data points.
  const firstDateRef      = useRef<string | null>(null);
  const lastDateRef       = useRef<string | null>(null);
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

  // Pattern overlay toggle.
  // `patternUserOverride` stores an explicit user preference (null = use derived default).
  // Default: ON when a confirmed pattern is active, OFF otherwise (no clutter when empty).
  // Override is reset to null whenever symbol or timeframe changes so the default
  // re-evaluates against the newly loaded pattern state.
  const [patternUserOverride, setPatternUserOverride] = useState<boolean | null>(null);
  const showPatterns = patternUserOverride !== null
    ? patternUserOverride
    : levels?.patternConfirmed === true;

  // Reset user override when symbol/timeframe changes so the default (confirmed=ON,
  // otherwise OFF) re-evaluates against the newly loaded symbol's pattern state.
  useEffect(() => {
    setPatternUserOverride(null);
  }, [symbol, timeframe]);

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

    // ── Pattern diagonal rail series ──────────────────────────────────────
    // Two LineSeries with exactly 2 data points each (start + end of pattern).
    // Data is cleared when no diagonal pattern is active. priceLineVisible and
    // lastValueVisible are off so they don't clutter the axis.
    const patUpper = chart.addSeries(LineSeries, {
      color:                  "#fbbf24",
      lineWidth:              1 as LineWidth,
      lineStyle:              LineStyle.Dashed,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    const patLower = chart.addSeries(LineSeries, {
      color:                  "#a855f7",
      lineWidth:              1 as LineWidth,
      lineStyle:              LineStyle.Dashed,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });

    candleSeriesRef.current   = candles;
    buyZoneRef.current        = buyZone;
    sellZoneRef.current       = sellZone;
    patUpperRailRef.current   = patUpper;
    patLowerRailRef.current   = patLower;
    chartRef.current          = chart;
    linesRef.current          = [];
    firstDateRef.current      = null;
    lastDateRef.current       = null;
    hasScrolledRef.current    = false;

    return () => {
      linesRef.current          = [];
      candleSeriesRef.current   = null;
      buyZoneRef.current        = null;
      sellZoneRef.current       = null;
      patUpperRailRef.current   = null;
      patLowerRailRef.current   = null;
      firstDateRef.current      = null;
      lastDateRef.current       = null;
      hasScrolledRef.current    = false;
      try { chart.remove(); } catch { /**/ }
      chartRef.current = null;
    };
  }, [symbol, timeframe]);

  // ── Feed candle data ───────────────────────────────────────────────────
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !history?.candles?.length) return;

    const data = history.candles.map((c) => ({
      time:  toTime(c.date),
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));

    series.setData(data);
    firstDateRef.current = history.candles[0].date;
    lastDateRef.current  = history.candles[history.candles.length - 1].date;

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

    // ── Pattern trendlines ────────────────────────────────────────────────
    // Only drawn when the overlay is ON AND the pattern is confirmed.
    // Forming patterns: badge only, no lines (avoid noise during the setup phase).
    // Candlestick patterns (single/two-bar): badge only, no structural chart lines.
    //
    // Diagonal patterns (triangles, wedges): rendered as 2-point LineSeries so the
    // rails slope correctly across time. Start coordinates come from the API's
    // patternStartDate + patternNecklineStart/patternUpperBoundStart fields.
    //
    // Horizontal patterns (H&S neckline, flags): rendered as priceLine as before.
    const CANDLESTICK_TYPES = new Set([
      "BULLISH_ENGULFING", "BEARISH_ENGULFING", "HAMMER", "SHOOTING_STAR",
    ]);
    const DIAGONAL_TYPES = new Set([
      "ASCENDING_TRIANGLE", "DESCENDING_TRIANGLE", "SYMMETRICAL_TRIANGLE",
      "RISING_WEDGE", "FALLING_WEDGE",
    ]);
    const isCandlestickOnly  = CANDLESTICK_TYPES.has(levels.detectedPattern ?? "");
    const hasDiagonalPattern = DIAGONAL_TYPES.has(levels.detectedPattern ?? "");

    const patUpper = patUpperRailRef.current;
    const patLower = patLowerRailRef.current;

    // Draw diagonal rails for any detected wedge/triangle regardless of confirmation.
    // The rails are shifted to touch the actual swing extremes (server-side), so price
    // is geometrically inside the formation during development and only exits on a
    // genuine breakout above/below the outermost swing high/low trajectory.
    const canDrawDiagonal =
      showPatterns &&
      hasDiagonalPattern &&
      levels.patternStartDate != null &&
      levels.patternNecklineStart != null &&
      levels.patternEndDate != null;

    if (canDrawDiagonal && patUpper && patLower) {
      // Rails run from the earliest swing point (left) to the last completed bar (right).
      // The shifted regression ensures all historical candles stay inside the wedge.
      const startTime = toTime(levels.patternStartDate!);
      const endTime   = toTime(levels.patternEndDate!);
      patUpper.setData([
        { time: startTime, value: levels.patternUpperBoundStart ?? levels.patternUpperBound ?? 0 },
        { time: endTime,   value: levels.patternUpperBound! },
      ]);
      patLower.setData([
        { time: startTime, value: levels.patternNecklineStart! },
        { time: endTime,   value: levels.patternNeckline! },
      ]);
    } else {
      // No diagonal pattern — clear the rail series so previous lines don't linger.
      patUpper?.setData([]);
      patLower?.setData([]);

      // Horizontal fallback for H&S necklines, flags/pennants, double tops/bottoms.
      // Double top/bottom: draw both levels even while forming — the resistance/support
      // structure is actionable before confirmation (neckline break).
      const p = levels.detectedPattern;
      const isDoublePattern = p === "DOUBLE_TOP" || p === "DOUBLE_BOTTOM";
      const isHS = p === "HEAD_AND_SHOULDERS" || p === "INVERSE_HEAD_AND_SHOULDERS";
      const drawHorizontals =
        showPatterns &&
        levels.patternNeckline != null &&
        !isCandlestickOnly &&
        (levels.patternConfirmed === true || isDoublePattern);
      if (drawHorizontals) {
        const lowerLabel = isHS ? "Neckline" : isDoublePattern ? (p === "DOUBLE_TOP" ? "DT Neck" : "DB Neck") : "Pat Low";
        const upperLabel = isDoublePattern ? (p === "DOUBLE_TOP" ? "DT Resist" : "DB Support") : "Pat High";
        addLine(levels.patternNeckline!, "#a855f7", lowerLabel, LineStyle.SparseDotted, 1);
        if (levels.patternUpperBound != null) {
          addLine(levels.patternUpperBound, "#fbbf24", upperLabel, LineStyle.SparseDotted, 1);
        }
      }
    }

    // ── Zone bands (BaselineSeries) ───────────────────────────────────────
    // Skip until candle date strings are available (effect re-runs once history
    // arrives, since history is a dependency). ISO date string comparison is
    // lexicographically correct for "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm:ss.sssZ".
    const firstDate = firstDateRef.current;
    const lastDate  = lastDateRef.current;

    if (firstDate !== null && lastDate !== null && firstDate < lastDate) {
      const anchorTs = toTime(firstDate);
      const latestTs = toTime(lastDate);

      buyZone.applyOptions({ baseValue: { type: "price", price: levels.buyZone.low } });
      buyZone.setData([
        { time: anchorTs, value: levels.buyZone.high },
        { time: latestTs, value: levels.buyZone.high },
      ]);

      sellZone.applyOptions({ baseValue: { type: "price", price: levels.sellZone.low } });
      sellZone.setData([
        { time: anchorTs, value: levels.sellZone.high },
        { time: latestTs, value: levels.sellZone.high },
      ]);
    }
  }, [levels, history, showPatterns]);

  // ── UI ────────────────────────────────────────────────────────────────
  const meta = getSymbolMeta(symbol);

  const signalColor =
    levels?.signal === "BUY"  ? "bg-emerald-500/95 text-black border-emerald-400" :
    levels?.signal === "SELL" ? "bg-red-500/95 text-black border-red-400" :
                                "bg-amber-500/95 text-black border-amber-400";

  const hasAnyPattern = levels?.detectedPattern != null;

  // Shown for both confirmed and forming patterns (when toggle is ON).
  // Confirmed: bright fuchsia badge with "Confirmed" suffix.
  // Forming: muted badge with "Forming" suffix — no lines drawn.
  const patternLabel = (() => {
    if (!hasAnyPattern || !showPatterns) return null;
    const raw = levels!.detectedPattern as string;
    const dir = levels!.patternDirection as string | undefined;
    const name = raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const arrow = dir === "bearish" ? "▼" : dir === "bullish" ? "▲" : "";
    const suffix = levels!.patternConfirmed ? "Confirmed" : "Forming";
    return { text: `${arrow} ${name} ${suffix}`, confirmed: levels!.patternConfirmed === true };
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
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1 font-mono select-none">
          {/* Patterns toggle — always visible when levels are loaded so the user
              can see and control the ON/OFF state. Default is derived from
              patternConfirmed (ON = confirmed pattern present, OFF otherwise). */}
          <button
            onClick={() => setPatternUserOverride(p => !(p ?? levels?.patternConfirmed === true))}
            className={`px-2 py-0.5 rounded-sm font-mono text-[10px] border transition-colors cursor-pointer ${
              showPatterns
                ? "bg-fuchsia-950/90 border-fuchsia-500/60 text-fuchsia-300 hover:bg-fuchsia-900/90"
                : "bg-zinc-900/80 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
            }`}
          >
            Patterns
          </button>
          <span className={`px-2 py-0.5 rounded-sm font-bold tracking-widest border text-[11px] pointer-events-none ${signalColor}`}>
            {levels.signal}
          </span>
          <span className="px-2 py-0.5 rounded-sm bg-black/80 border border-zinc-700 text-zinc-100 text-[11px] pointer-events-none">
            {fmtPriceMeta(meta, levels.currentPrice)}
          </span>
        </div>
      )}

      {/* Pattern badge — bottom-left, visible when toggle is ON and pattern detected */}
      {patternLabel && (
        <div className="absolute bottom-6 left-3 z-20 pointer-events-none select-none">
          <span className={`px-2 py-0.5 rounded-sm font-mono font-semibold text-[11px] tracking-wide border ${
            patternLabel.confirmed
              ? "bg-fuchsia-950/90 border-fuchsia-500/60 text-fuchsia-300"
              : "bg-zinc-900/80 border-zinc-700/60 text-zinc-400"
          }`}>
            {patternLabel.text}
          </span>
        </div>
      )}
    </div>
  );
}
