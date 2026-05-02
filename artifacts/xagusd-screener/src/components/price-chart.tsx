import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type Time,
} from "lightweight-charts";
import { useGetLevels, useGetPriceHistory } from "@workspace/api-client-react";

export function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  // Fetch data
  const { data: history } = useGetPriceHistory({ params: { bars: 120 } });
  const { data: levels } = useGetLevels({
    query: { refetchInterval: 60000 },
  });

  // Create chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Guard against calling methods on a destroyed chart
    let destroyed = false;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0a" },
        textColor: "#6b7280",
        fontSize: 11,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      },
      grid: {
        vertLines: { color: "#1a1a1a" },
        horzLines: { color: "#1a1a1a" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#374151", labelBackgroundColor: "#1f2937" },
        horzLine: { color: "#374151", labelBackgroundColor: "#1f2937" },
      },
      rightPriceScale: {
        borderColor: "#1f2937",
        textColor: "#6b7280",
      },
      timeScale: {
        borderColor: "#1f2937",
        timeVisible: true,
        secondsVisible: false,
      },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#00c950",
      downColor: "#e53e3e",
      borderUpColor: "#00c950",
      borderDownColor: "#e53e3e",
      wickUpColor: "#00c950",
      wickDownColor: "#e53e3e",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (!destroyed && el) {
        try {
          chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
        } catch { /* chart may have been removed */ }
      }
    });
    ro.observe(el);

    return () => {
      destroyed = true;
      ro.disconnect();
      priceLinesRef.current = [];
      chartRef.current = null;
      seriesRef.current = null;
      try { chart.remove(); } catch { /* ignore */ }
    };
  }, []);

  // Update candles
  useEffect(() => {
    if (!seriesRef.current || !history?.candles?.length) return;
    const data: CandlestickData<Time>[] = history.candles.map((c) => ({
      time: c.date as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [history]);

  // Draw / redraw price lines whenever levels change
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Remove old lines
    priceLinesRef.current.forEach((pl) => {
      try { series.removePriceLine(pl); } catch { /* ignore */ }
    });
    priceLinesRef.current = [];

    if (!levels) return;

    const add = (
      price: number,
      color: string,
      title: string,
      lineWidth: 1 | 2 | 3 | 4 = 1,
      lineStyle: LineStyle = LineStyle.Dashed,
      axisLabelVisible = true,
    ) => {
      const pl = series.createPriceLine({
        price,
        color,
        lineWidth,
        lineStyle,
        axisLabelVisible,
        title: ` ${title}`,
      });
      priceLinesRef.current.push(pl);
    };

    // ── Individual S/R levels — lines only, no axis labels (avoid crowding) ──
    for (const level of levels.levels) {
      const isZoneBoundary =
        level.price === levels.buyZone.low ||
        level.price === levels.buyZone.high ||
        level.price === levels.sellZone.low ||
        level.price === levels.sellZone.high;

      if (isZoneBoundary) continue;

      const color =
        level.type === "resistance"
          ? "rgba(239,68,68,0.35)"
          : level.type === "support"
          ? "rgba(0,201,80,0.35)"
          : "rgba(156,163,175,0.3)";

      // Show line label (title) but NO axis label — keeps the price scale clean
      const isPivot = level.label === "Pivot";
      add(level.price, isPivot ? "rgba(156,163,175,0.7)" : color,
          level.label, 1,
          isPivot ? LineStyle.Dashed : LineStyle.Dotted,
          false); // axisLabelVisible = false for all individual levels
    }

    // ── Buy zone: thick boundary lines, axis label only on the top edge ───────
    add(levels.buyZone.high, "#00c950",
        `BUY ZONE  $${levels.buyZone.low.toFixed(2)} – $${levels.buyZone.high.toFixed(2)}`,
        2, LineStyle.Solid, true);
    add(levels.buyZone.low, "#00c950", "", 2, LineStyle.Solid, false);

    // ── Sell zone: thick boundary lines, axis label only on the bottom edge ───
    add(levels.sellZone.low, "#e53e3e",
        `SELL ZONE  $${levels.sellZone.low.toFixed(2)} – $${levels.sellZone.high.toFixed(2)}`,
        2, LineStyle.Solid, true);
    add(levels.sellZone.high, "#e53e3e", "", 2, LineStyle.Solid, false);

    // ── Trade setup lines — axis labels on, but only Entry/SL/TP ─────────────
    if (levels.signal !== "WAIT") {
      add(levels.entryPrice, "#f59e0b", "Entry", 2, LineStyle.Solid, true);
      add(levels.stopLoss, "#f87171", "SL", 1, LineStyle.Dashed, true);
      add(levels.takeProfit1, "#4ade80", "TP1", 1, LineStyle.Dashed, true);
      add(levels.takeProfit2, "#86efac", "TP2", 1, LineStyle.Dotted, true);
    }
  }, [levels]);

  return (
    <div className="w-full h-full flex flex-col rounded-xl border border-zinc-800 overflow-hidden bg-[#0a0a0a]">
      {/* Chart header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-zinc-500">OANDA:XAGUSD</span>
          <span className="text-zinc-700">|</span>
          <span className="text-zinc-500">Daily</span>
          <span className="text-zinc-700">|</span>
          <span className="text-zinc-600">pivot zones + fib levels</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-[2px] inline-block bg-[#00c950]" />
            <span className="text-zinc-500">Buy Zone</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-[2px] inline-block bg-[#e53e3e]" />
            <span className="text-zinc-500">Sell Zone</span>
          </span>
          {levels?.signal !== "WAIT" && (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-[2px] inline-block bg-[#f59e0b]" />
              <span className="text-zinc-500">Trade Setup</span>
            </span>
          )}
        </div>
      </div>
      {/* Chart canvas */}
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
