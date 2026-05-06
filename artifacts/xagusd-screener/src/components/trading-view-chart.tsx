import { useEffect, useRef } from "react";
import { useGetLevels, getGetLevelsQueryKey } from "@workspace/api-client-react";
import type { Timeframe } from "@/components/timeframe-selector";
import { getSymbolMeta, fmtPriceMeta } from "@/lib/symbols";
import type { LevelsData } from "@workspace/api-client-react";

// ─── TradingView free-widget types ────────────────────────────────────────────
interface TVWidget {
  onChartReady(cb: () => void): void;
  remove?(): void;
}
declare global {
  interface Window {
    TradingView: { widget: new (cfg: Record<string, unknown>) => TVWidget };
  }
}

// ─── TradingView script singleton ────────────────────────────────────────────
let _tvLoaded  = false;
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
      s.onload = () => { _tvLoaded = true; _tvQueue.splice(0).forEach((cb) => cb()); };
      document.head.appendChild(s);
    }
  });
}

const TF_MAP: Record<Timeframe, string> = {
  "15m": "15", "30m": "30", "1h": "60", "1d": "D",
};

// ─── Component ────────────────────────────────────────────────────────────────
// NOTE: Signal lines (Entry, SL, TP1, TP2) require the TradingView Charting
// Library (paid). Apply at tradingview.com/HTML5-stock-forex-bitcoin-charting-library/
// Once the library is integrated, restore createOrderLine() calls here.
export function TradingViewChart({
  symbol,
  timeframe,
}: {
  symbol: string;
  timeframe: Timeframe;
}) {
  const wrapRef   = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TVWidget | null>(null);

  const { data: levels } = useGetLevels(
    { symbol, timeframe },
    { query: { queryKey: getGetLevelsQueryKey({ symbol, timeframe }), refetchInterval: 10_000 } },
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let cancelled = false;
    widgetRef.current = null;
    wrap.innerHTML = "";

    const inner = document.createElement("div");
    const uid   = `tv_${symbol}_${timeframe}_${Date.now()}`;
    inner.id    = uid;
    inner.style.cssText = "width:100%;height:100%";
    wrap.appendChild(inner);

    loadTV().then(() => {
      if (cancelled || !document.getElementById(uid)) return;

      const widget = new window.TradingView.widget({
        container_id:        uid,
        symbol:              getSymbolMeta(symbol).tv,
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
    });

    return () => {
      cancelled = true;
      try { widgetRef.current?.remove?.(); } catch { /**/ }
      widgetRef.current = null;
      if (wrap) wrap.innerHTML = "";
    };
  }, [symbol, timeframe]);

  const meta = getSymbolMeta(symbol);
  const signalColor =
    levels?.signal === "BUY"  ? "bg-emerald-500/95 text-black border-emerald-400" :
    levels?.signal === "SELL" ? "bg-red-500/95 text-black border-red-400" :
                                "bg-amber-500/95 text-black border-amber-400";

  return (
    <div className="relative h-full w-full rounded-sm overflow-hidden border border-zinc-800">
      <div ref={wrapRef} className="h-full w-full" />

      {/* Symbol label top-left */}
      <div className="absolute top-2 left-3 z-20 pointer-events-none font-mono text-[11px] text-zinc-400 select-none">
        {meta.short}
        {meta.venue && <span className="ml-2 text-zinc-600">{meta.venue}</span>}
      </div>

      {/* Signal + price badge top-right */}
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
