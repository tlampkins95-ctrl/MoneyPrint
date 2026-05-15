import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
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

export function LevelsChart({
  symbol,
  timeframe,
}: {
  symbol: string;
  timeframe: Timeframe;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef    = useRef<IChartApi | null>(null);
  const seriesRef   = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef    = useRef<IPriceLine[]>([]);

  const { data: history } = useGetPriceHistory(
    { symbol: symbol as GetPriceHistorySymbol, timeframe, bars: 200 },
    {
      query: {
        queryKey: getGetPriceHistoryQueryKey({ symbol: symbol as GetPriceHistorySymbol, timeframe, bars: 200 }),
        refetchInterval: 60_000,
      },
    },
  );

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
      rightPriceScale: {
        borderColor: "#27272a",
      },
      timeScale: {
        borderColor: "#27272a",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
      },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:        "#22c55e",
      downColor:      "#ef4444",
      borderUpColor:  "#22c55e",
      borderDownColor:"#ef4444",
      wickUpColor:    "#22c55e",
      wickDownColor:  "#ef4444",
      priceLineVisible: false,
    });

    chartRef.current  = chart;
    seriesRef.current = series;
    linesRef.current  = [];

    return () => {
      linesRef.current  = [];
      seriesRef.current = null;
      try { chart.remove(); } catch { /**/ }
      chartRef.current = null;
    };
  }, [symbol, timeframe]);

  // ── Feed candle data ───────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !history?.candles?.length) return;

    try {
      series.setData(
        history.candles.map((c) => ({
          time:  c.date as Time,
          open:  c.open,
          high:  c.high,
          low:   c.low,
          close: c.close,
        })),
      );
      chartRef.current?.timeScale().scrollToRealTime();
    } catch { /**/ }
  }, [history]);

  // ── Draw / refresh price lines whenever levels change ──────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !levels) return;

    for (const pl of linesRef.current) {
      try { series.removePriceLine(pl); } catch { /**/ }
    }
    linesRef.current = [];

    const add = (
      price:  number,
      color:  string,
      title:  string,
      style:  LineStyle  = LineStyle.Solid,
      width:  LineWidth  = 1,
    ) => {
      try {
        linesRef.current.push(
          series.createPriceLine({ price, color, title, lineWidth: width, lineStyle: style, axisLabelVisible: true }),
        );
      } catch { /**/ }
    };

    const isBuy  = levels.signal === "BUY";
    const isSell = levels.signal === "SELL";

    // ── Active trade lines ───────────────────────────────────────────────
    if (isBuy || isSell) {
      add(levels.entryPrice, isBuy ? "#22c55e" : "#ef4444", "Entry", LineStyle.Solid, 2);
      add(levels.stopLoss,   "#ef4444", "SL",  LineStyle.Dashed, 1);
      add(levels.takeProfit1,"#10b981", "TP1", LineStyle.Dashed, 1);
      add(levels.takeProfit2,"#10b981", "TP2", LineStyle.Dashed, 1);
    }

    // ── Pivot structure levels (S1–S3, R1–R3, Pivot) ────────────────────
    for (const { label, price, type } of levels.levels) {
      if (label.startsWith("Fib") || label.startsWith("Swing")) continue;
      add(
        price,
        type === "resistance" ? "#f97316" : type === "support" ? "#3b82f6" : "#71717a",
        label,
        LineStyle.Solid,
        1,
      );
    }

    // ── Buy / sell zone boundaries ───────────────────────────────────────
    add(levels.buyZone.low,   "#22c55e", "Buy↓",  LineStyle.Dotted, 1);
    add(levels.buyZone.high,  "#22c55e", "Buy↑",  LineStyle.Dotted, 1);
    add(levels.sellZone.low,  "#ef4444", "Sell↓", LineStyle.Dotted, 1);
    add(levels.sellZone.high, "#ef4444", "Sell↑", LineStyle.Dotted, 1);

    // ── Pattern neckline ─────────────────────────────────────────────────
    if (levels.patternNeckline != null) {
      add(levels.patternNeckline, "#a855f7", "Neckline", LineStyle.SparseDotted, 1);
    }
  }, [levels]);

  // ── UI ────────────────────────────────────────────────────────────────
  const meta = getSymbolMeta(symbol);
  const signalColor =
    levels?.signal === "BUY"  ? "bg-emerald-500/95 text-black border-emerald-400" :
    levels?.signal === "SELL" ? "bg-red-500/95 text-black border-red-400" :
                                "bg-amber-500/95 text-black border-amber-400";

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
    </div>
  );
}
