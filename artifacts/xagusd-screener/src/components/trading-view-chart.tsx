import { useEffect, useRef } from "react";
import { useGetLevels } from "@workspace/api-client-react";
import type { Timeframe } from "@/components/timeframe-selector";

const TV_INTERVAL: Record<Timeframe, string> = {
  "1m": "1",
  "30m": "30",
  "1h": "60",
  "1d": "D",
};

export function TradingViewChart({ timeframe }: { timeframe: Timeframe }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);

  const { data: levels } = useGetLevels(
    { timeframe },
    { query: { refetchInterval: 60000 } },
  );

  useEffect(() => {
    if (!widgetRef.current) return;
    widgetRef.current.innerHTML = "";
    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: "OANDA:XAGUSD",
      interval: TV_INTERVAL[timeframe],
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: false,
      calendar: false,
      hide_side_toolbar: false,
      support_host: "https://www.tradingview.com",
    });
    widgetRef.current.appendChild(script);
  }, [timeframe]);

  return (
    <div
      ref={containerRef}
      className="relative tradingview-widget-container h-full w-full bg-card rounded-sm overflow-hidden border"
    >
      <div
        ref={widgetRef}
        className="tradingview-widget-container__widget h-[calc(100%-32px)] w-full"
      />

      {/* Floating signals overlay — top-right corner, doesn't block OHLC header */}
      {levels && (
        <div className="absolute top-12 right-2 z-10 pointer-events-none flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider w-[210px]">
          <div className="flex items-center gap-1">
            <span
              className={`px-2 py-0.5 rounded-sm font-bold tracking-widest border text-[11px] ${
                levels.signal === "BUY"
                  ? "bg-emerald-500/95 text-black border-emerald-400"
                  : levels.signal === "SELL"
                    ? "bg-red-500/95 text-black border-red-400"
                    : "bg-amber-500/95 text-black border-amber-400"
              }`}
            >
              {levels.signal}
            </span>
            <span className="px-2 py-0.5 rounded-sm bg-black/80 border border-border/60 text-foreground text-[11px] flex-1 text-right">
              ${levels.currentPrice.toFixed(3)}
            </span>
          </div>

          <div className="flex flex-col gap-0.5 bg-black/80 backdrop-blur-sm border border-border/60 rounded-sm p-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-emerald-400">BUY</span>
              <span className="text-foreground/90 text-[10px]">
                {levels.buyZone.low.toFixed(2)}–{levels.buyZone.high.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-red-400">SELL</span>
              <span className="text-foreground/90 text-[10px]">
                {levels.sellZone.low.toFixed(2)}–{levels.sellZone.high.toFixed(2)}
              </span>
            </div>
            <div className="border-t border-border/40 my-0.5" />
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">ENTRY</span>
              <span className="text-foreground">${levels.entryPrice.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-red-400">SL</span>
              <span className="text-foreground">${levels.stopLoss.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-emerald-400">TP1</span>
              <span className="text-foreground">${levels.takeProfit1.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-emerald-400">TP2</span>
              <span className="text-foreground">${levels.takeProfit2.toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
