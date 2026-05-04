import { useEffect, useRef } from "react";
import { useGetLevels, getGetLevelsQueryKey } from "@workspace/api-client-react";
import type { Timeframe } from "@/components/timeframe-selector";
import { SYMBOLS, fmtPrice, type Symbol } from "@/lib/symbols";

declare global {
  interface Window {
    TradingView: { widget: new (cfg: Record<string, unknown>) => { remove?: () => void } };
  }
}

const TF_MAP: Record<Timeframe, string> = {
  "15m": "15",
  "30m": "30",
  "1h":  "60",
  "1d":  "D",
};

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

export function TradingViewChart({
  symbol,
  timeframe,
}: {
  symbol: Symbol;
  timeframe: Timeframe;
}) {
  const wrapRef   = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<{ remove?: () => void } | null>(null);

  const { data: levels } = useGetLevels(
    { symbol, timeframe },
    {
      query: {
        queryKey: getGetLevelsQueryKey({ symbol, timeframe }),
        refetchInterval: 10_000,
      },
    },
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let cancelled = false;

    wrap.innerHTML = "";
    const inner = document.createElement("div");
    const uid = `tv_${symbol}_${timeframe}_${Date.now()}`;
    inner.id = uid;
    inner.style.cssText = "width:100%;height:100%";
    wrap.appendChild(inner);

    loadTV().then(() => {
      if (cancelled || !document.getElementById(uid)) return;
      widgetRef.current = new window.TradingView.widget({
        container_id:      uid,
        symbol:            SYMBOLS[symbol].tv,
        interval:          TF_MAP[timeframe],
        timezone:          "Etc/UTC",
        theme:             "dark",
        style:             "1",
        locale:            "en",
        toolbar_bg:        "#0a0a0a",
        enable_publishing: false,
        hide_top_toolbar:  false,
        hide_legend:       false,
        save_image:        false,
        autosize:          true,
        withdateranges:    true,
        hide_side_toolbar: false,
        allow_symbol_change: false,
      });
    });

    return () => {
      cancelled = true;
      try { widgetRef.current?.remove?.(); } catch { /* ignore */ }
      widgetRef.current = null;
      if (wrap) wrap.innerHTML = "";
    };
  }, [symbol, timeframe]);

  const meta = SYMBOLS[symbol];
  const signalColor =
    levels?.signal === "BUY"
      ? "bg-emerald-500/95 text-black border-emerald-400"
      : levels?.signal === "SELL"
        ? "bg-red-500/95 text-black border-red-400"
        : "bg-amber-500/95 text-black border-amber-400";

  return (
    <div className="relative h-full w-full rounded-sm overflow-hidden border border-zinc-800">
      <div className="absolute top-2 left-3 z-10 pointer-events-none font-mono text-[11px] text-zinc-400">
        {meta.short}
        {meta.venue && (
          <span className="ml-2 text-zinc-600">{meta.venue}</span>
        )}
      </div>

      {levels && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 font-mono pointer-events-none">
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

      <div ref={wrapRef} className="h-full w-full" />
    </div>
  );
}
