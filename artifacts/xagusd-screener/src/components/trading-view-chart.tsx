import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type IPriceLine,
} from "lightweight-charts";
import {
  useGetLevels,
  getGetLevelsQueryKey,
  useGetPriceHistory,
  getGetPriceHistoryQueryKey,
} from "@workspace/api-client-react";
import type { Timeframe } from "@/components/timeframe-selector";
import { SYMBOLS, fmtPrice, type Symbol } from "@/lib/symbols";

const REFETCH_MS: Record<Timeframe, number> = {
  "15m": 60_000,
  "30m": 60_000,
  "1h": 60_000,
  "1d": 60_000,
};

function toUnixTime(dateStr: string): Time {
  // lightweight-charts wants a UTCTimestamp (seconds) or business day string.
  // Use seconds-from-epoch for both intraday and daily so ordering is stable.
  return Math.floor(new Date(dateStr).getTime() / 1000) as Time;
}

export function TradingViewChart({
  symbol,
  timeframe,
}: {
  symbol: Symbol;
  timeframe: Timeframe;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);

  const refetchInterval = REFETCH_MS[timeframe];

  const { data: history } = useGetPriceHistory(
    { symbol, timeframe, bars: 240 },
    {
      query: {
        queryKey: getGetPriceHistoryQueryKey({ symbol, timeframe, bars: 240 }),
        refetchInterval,
      },
    },
  );

  const { data: levels } = useGetLevels(
    { symbol, timeframe },
    {
      query: {
        queryKey: getGetLevelsQueryKey({ symbol, timeframe }),
        refetchInterval,
      },
    },
  );

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: "#0a0a0a" },
        textColor: "#a1a1aa",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(63,63,70,0.25)" },
        horzLines: { color: "rgba(63,63,70,0.25)" },
      },
      rightPriceScale: {
        borderColor: "rgba(63,63,70,0.5)",
      },
      timeScale: {
        borderColor: "rgba(63,63,70,0.5)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#00c950",
      downColor: "#e53e3e",
      borderUpColor: "#00c950",
      borderDownColor: "#e53e3e",
      wickUpColor: "#00c950",
      wickDownColor: "#e53e3e",
      // Live price line — the dominant reference on the chart.
      priceLineColor: "#22d3ee",
      priceLineWidth: 3,
      priceLineStyle: LineStyle.Solid,
      lastValueVisible: true,
      priceFormat: {
        type: "price",
        precision: SYMBOLS[symbol].decimals,
        minMove: Math.pow(10, -SYMBOLS[symbol].decimals),
      },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, [symbol]);

  // Update candle data
  useEffect(() => {
    if (!seriesRef.current || !history) return;
    // Sort first, then dedupe by timestamp keeping the last occurrence —
    // lightweight-charts requires strictly ascending unique times.
    const sorted = history.candles
      .map((c) => ({
        time: toUnixTime(c.date),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    const byTime = new Map<number, CandlestickData>();
    for (const d of sorted) byTime.set(d.time as number, d);
    const data: CandlestickData[] = Array.from(byTime.values());
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [history]);

  // Draw signal price lines (entry / SL / TP1 / TP2 / zones)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !levels) return;

    // Clear previous lines
    for (const line of linesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        // ignore — series may have been recreated
      }
    }
    linesRef.current = [];

    const isBuy = levels.signal === "BUY";
    const isSell = levels.signal === "SELL";

    const add = (
      price: number,
      color: string,
      title: string,
      style: LineStyle = LineStyle.Solid,
      width: 1 | 2 | 3 | 4 = 2,
    ) => {
      const line = series.createPriceLine({
        price,
        color,
        lineWidth: width,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      });
      linesRef.current.push(line);
    };

    // Buy zone (emerald) — dashed band
    add(levels.buyZone.high, "rgba(0,201,80,0.45)", "Buy ▲", LineStyle.Dashed, 1);
    add(levels.buyZone.low, "rgba(0,201,80,0.45)", "Buy ▼", LineStyle.Dashed, 1);

    // Sell zone (red) — dashed band
    add(levels.sellZone.high, "rgba(229,62,62,0.45)", "Sell ▲", LineStyle.Dashed, 1);
    add(levels.sellZone.low, "rgba(229,62,62,0.45)", "Sell ▼", LineStyle.Dashed, 1);

    // Active trade (only when there's a real signal). Amber Entry so it doesn't
    // compete with the cyan live-price line; all reference lines kept thin.
    if (isBuy || isSell) {
      add(levels.entryPrice, "#f59e0b", `Entry ${fmtPrice(symbol, levels.entryPrice)}`, LineStyle.Solid, 1);
      add(levels.stopLoss, "rgba(229,62,62,0.85)", `SL ${fmtPrice(symbol, levels.stopLoss)}`, LineStyle.Solid, 1);
      add(levels.takeProfit1, "rgba(74,222,128,0.85)", `TP1 ${fmtPrice(symbol, levels.takeProfit1)}`, LineStyle.Solid, 1);
      add(levels.takeProfit2, "rgba(134,239,172,0.7)", `TP2 ${fmtPrice(symbol, levels.takeProfit2)}`, LineStyle.Dotted, 1);
    }

    // Pivot
    add(levels.pivot, "rgba(251,191,36,0.5)", `Pivot ${fmtPrice(symbol, levels.pivot)}`, LineStyle.Dotted, 1);
  }, [levels, symbol]);

  const meta = SYMBOLS[symbol];
  const signalColor =
    levels?.signal === "BUY"
      ? "bg-emerald-500/95 text-black border-emerald-400"
      : levels?.signal === "SELL"
        ? "bg-red-500/95 text-black border-red-400"
        : "bg-amber-500/95 text-black border-amber-400";

  return (
    <div className="relative h-full w-full bg-[#0a0a0a]/65 backdrop-blur-md rounded-sm overflow-hidden border border-zinc-800">
      {/* Header: symbol + signal + price */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 py-2 pointer-events-none">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className="text-zinc-300 font-bold tracking-wider">
            {meta.short}
          </span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-500 uppercase tracking-widest">
            {timeframe} · {meta.venue ?? "OANDA"}
          </span>
        </div>
        {levels && (
          <div className="flex items-center gap-1 font-mono">
            <span
              className={`px-2 py-0.5 rounded-sm font-bold tracking-widest border text-[11px] ${signalColor}`}
            >
              {levels.signal}
            </span>
            <span className="px-2 py-0.5 rounded-sm bg-black/80 border border-zinc-700 text-zinc-100 text-[11px]">
              {fmtPrice(symbol, levels.currentPrice)}
            </span>
          </div>
        )}
      </div>

      {/* Chart area */}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
