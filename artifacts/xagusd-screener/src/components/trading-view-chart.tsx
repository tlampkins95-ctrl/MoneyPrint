import { useEffect, useRef } from "react";
import { useGetLevels, getGetLevelsQueryKey } from "@workspace/api-client-react";
import type { Timeframe } from "@/components/timeframe-selector";
import { SYMBOLS, fmtPrice, type Symbol } from "@/lib/symbols";
import type { LevelsData } from "@workspace/api-client-react";

// ─── Minimal TradingView widget typings ──────────────────────────────────────
interface TVLine {
  setPrice(p: number): TVLine;
  setText(t: string): TVLine;
  setQuantity(q: string): TVLine;
  setLineColor(c: string): TVLine;
  setLineStyle(s: number): TVLine;   // 0 solid | 1 dotted | 2 dashed
  setLineWidth(w: number): TVLine;
  setBodyBackgroundColor(c: string): TVLine;
  setBodyBorderColor(c: string): TVLine;
  setBodyTextColor(c: string): TVLine;
  setQuantityBackgroundColor(c: string): TVLine;
  setQuantityBorderColor(c: string): TVLine;
  setQuantityTextColor(c: string): TVLine;
  setCancelButtonBackgroundColor(c: string): TVLine;
  setCancelButtonBorderColor(c: string): TVLine;
  setCancelButtonIconColor(c: string): TVLine;
  remove(): void;
}
interface TVChart {
  createOrderLine(opts?: object): TVLine;
}
interface TVWidget {
  onChartReady(cb: () => void): void;
  chart(): TVChart;
  remove?(): void;
}

declare global {
  interface Window {
    TradingView: { widget: new (cfg: Record<string, unknown>) => TVWidget };
  }
}

// ─── TradingView script singleton ────────────────────────────────────────────
let _tvLoaded = false;
let _tvLoading = false;
const _tvQueue: Array<() => void> = [];

function loadTV(): Promise<void> {
  if (_tvLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    _tvQueue.push(resolve);
    if (!_tvLoading) {
      _tvLoading = true;
      const s = document.createElement("script");
      s.src = "https://s3.tradingview.com/tv.js";
      s.async = true;
      s.onload = () => {
        _tvLoaded = true;
        _tvQueue.splice(0).forEach((cb) => cb());
      };
      document.head.appendChild(s);
    }
  });
}

// ─── Timeframe → TradingView interval ────────────────────────────────────────
const TF_MAP: Record<Timeframe, string> = {
  "15m": "15",
  "30m": "30",
  "1h":  "60",
  "1d":  "D",
};

// ─── Draw / clear signal lines on the chart ──────────────────────────────────
function drawSignalLines(
  chart: TVChart,
  levels: LevelsData,
  symbol: Symbol,
  linesStore: TVLine[],
): void {
  // Clear previous lines
  linesStore.splice(0).forEach((l) => { try { l.remove(); } catch { /* ignore */ } });

  const { signal, entryPrice, stopLoss, takeProfit1, takeProfit2, buyZone, sellZone } = levels;
  const isBuy  = signal === "BUY";
  const isSell = signal === "SELL";

  const addLine = (
    price: number,
    label: string,
    qty: string,
    lineColor: string,
    bodyBg: string,
    bodyText: string,
    style = 0,
    width = 1,
  ) => {
    const transparent = "rgba(0,0,0,0)";
    const line = chart
      .createOrderLine()
      .setPrice(price)
      .setText(label)
      .setQuantity(qty)
      .setLineColor(lineColor)
      .setLineStyle(style)
      .setLineWidth(width)
      .setBodyBackgroundColor(bodyBg)
      .setBodyBorderColor(lineColor)
      .setBodyTextColor(bodyText)
      .setQuantityBackgroundColor(bodyBg)
      .setQuantityBorderColor(lineColor)
      .setQuantityTextColor(bodyText)
      // hide the cancel ✕ button — we manage lines ourselves
      .setCancelButtonBackgroundColor(transparent)
      .setCancelButtonBorderColor(transparent)
      .setCancelButtonIconColor(transparent);
    linesStore.push(line);
  };

  // Buy zone band
  addLine(buyZone.high, "Buy Zone ▲", fmtPrice(symbol, buyZone.high), "rgba(0,201,80,0.5)",  "rgba(0,30,10,0.7)",   "#00c950", 2, 1);
  addLine(buyZone.low,  "Buy Zone ▼", fmtPrice(symbol, buyZone.low),  "rgba(0,201,80,0.5)",  "rgba(0,30,10,0.7)",   "#00c950", 2, 1);

  // Sell zone band
  addLine(sellZone.high, "Sell Zone ▲", fmtPrice(symbol, sellZone.high), "rgba(229,62,62,0.5)", "rgba(40,0,0,0.7)", "#ef4444", 2, 1);
  addLine(sellZone.low,  "Sell Zone ▼", fmtPrice(symbol, sellZone.low),  "rgba(229,62,62,0.5)", "rgba(40,0,0,0.7)", "#ef4444", 2, 1);

  // Entry / SL / TP only when there's an active signal
  if (isBuy || isSell) {
    const entryColor = "#f59e0b";
    const slColor    = "#ef4444";
    const tp1Color   = "#22c55e";
    const tp2Color   = "#86efac";

    addLine(entryPrice,  "Entry",  fmtPrice(symbol, entryPrice),  entryColor, "#1a1000", "#f59e0b", 0, 2);
    addLine(stopLoss,    "SL",     fmtPrice(symbol, stopLoss),    slColor,    "#1a0000", "#ef4444", 0, 1);
    addLine(takeProfit1, "TP1",    fmtPrice(symbol, takeProfit1), tp1Color,   "#001a08", "#22c55e", 0, 1);
    addLine(takeProfit2, "TP2",    fmtPrice(symbol, takeProfit2), tp2Color,   "#001a08", "#86efac", 1, 1);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export function TradingViewChart({
  symbol,
  timeframe,
}: {
  symbol: Symbol;
  timeframe: Timeframe;
}) {
  const wrapRef      = useRef<HTMLDivElement>(null);
  const widgetRef    = useRef<TVWidget | null>(null);
  const chartRef     = useRef<TVChart | null>(null);
  const signalLines  = useRef<TVLine[]>([]);
  const pendingLevels = useRef<LevelsData | null>(null);

  const { data: levels } = useGetLevels(
    { symbol, timeframe },
    {
      query: {
        queryKey: getGetLevelsQueryKey({ symbol, timeframe }),
        refetchInterval: 10_000,
      },
    },
  );

  // Create / recreate widget when symbol or timeframe changes
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let cancelled = false;
    chartRef.current = null;
    signalLines.current = [];
    pendingLevels.current = null;
    wrap.innerHTML = "";

    const inner = document.createElement("div");
    const uid = `tv_${symbol}_${timeframe}_${Date.now()}`;
    inner.id = uid;
    inner.style.cssText = "width:100%;height:100%";
    wrap.appendChild(inner);

    loadTV().then(() => {
      if (cancelled || !document.getElementById(uid)) return;

      const widget = new window.TradingView.widget({
        container_id:        uid,
        symbol:              SYMBOLS[symbol].tv,
        interval:            TF_MAP[timeframe],
        timezone:            "Etc/UTC",
        theme:               "dark",
        style:               "1",
        locale:              "en",
        toolbar_bg:          "#0a0a0a",
        enable_publishing:   false,
        hide_top_toolbar:    false,
        hide_legend:         false,
        save_image:          false,
        autosize:            true,
        withdateranges:      true,
        hide_side_toolbar:   false,
        allow_symbol_change: false,
      });

      widgetRef.current = widget;

      widget.onChartReady(() => {
        if (cancelled) return;
        const chart = widget.chart();
        chartRef.current = chart;
        // Draw whatever levels arrived while the chart was loading
        if (pendingLevels.current) {
          drawSignalLines(chart, pendingLevels.current, symbol, signalLines.current);
          pendingLevels.current = null;
        }
      });
    });

    return () => {
      cancelled = true;
      chartRef.current = null;
      signalLines.current = [];
      try { widgetRef.current?.remove?.(); } catch { /* ignore */ }
      widgetRef.current = null;
      if (wrap) wrap.innerHTML = "";
    };
  }, [symbol, timeframe]);

  // Redraw signal lines whenever levels update
  useEffect(() => {
    if (!levels) return;
    if (chartRef.current) {
      drawSignalLines(chartRef.current, levels, symbol, signalLines.current);
    } else {
      // Chart not ready yet — buffer the latest levels
      pendingLevels.current = levels;
    }
  }, [levels, symbol]);

  const meta = SYMBOLS[symbol];
  const signalColor =
    levels?.signal === "BUY"
      ? "bg-emerald-500/95 text-black border-emerald-400"
      : levels?.signal === "SELL"
        ? "bg-red-500/95 text-black border-red-400"
        : "bg-amber-500/95 text-black border-amber-400";

  return (
    <div className="relative h-full w-full rounded-sm overflow-hidden border border-zinc-800">
      <div className="absolute top-2 left-3 z-10 pointer-events-none font-mono text-[11px] text-zinc-400 select-none">
        {meta.short}
        {meta.venue && <span className="ml-2 text-zinc-600">{meta.venue}</span>}
      </div>

      {levels && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 font-mono pointer-events-none select-none">
          <span className={`px-2 py-0.5 rounded-sm font-bold tracking-widest border text-[11px] ${signalColor}`}>
            {levels.signal}
          </span>
          <span className="px-2 py-0.5 rounded-sm bg-black/80 border border-zinc-700 text-zinc-100 text-[11px]">
            {fmtPrice(symbol, levels.currentPrice)}
          </span>
        </div>
      )}

      <div ref={wrapRef} className="h-full w-full" />
    </div>
  );
}
