import { useEffect, useRef, useState } from "react";
import {
  useGetLevels, getGetLevelsQueryKey,
  useGetPriceHistory, getGetPriceHistoryQueryKey,
} from "@workspace/api-client-react";
import type { Candle } from "@workspace/api-client-react";
import type { Timeframe } from "@/components/timeframe-selector";
import { SYMBOLS, fmtPrice, type Symbol } from "@/lib/symbols";
import type { LevelsData } from "@workspace/api-client-react";

// ─── TradingView free-widget types ────────────────────────────────────────────
interface TVTimeRange { from: number; to: number }
interface TVChart {
  getVisibleRange(): TVTimeRange | null;
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

// ─── Approximate layout of the TradingView chart area inside the iframe ───────
// These constants let us map a price → a pixel Y on our overlay div.
// They reflect the default TradingView dark theme with side-toolbar shown.
const TV_TOOLBAR_H   = 52;  // top bar (timeframe buttons, indicators, etc.)
const TV_TIMESCALE_H = 26;  // bottom time axis
const TV_DRAWTOOLS_W = 40;  // left drawing-tools sidebar
const TV_PRICEAXIS_W = 68;  // right price axis (TV renders its own labels there)

interface PriceRange { min: number; max: number }

/** Map a price to a pixel Y within our overlay container. */
function priceToY(price: number, range: PriceRange, containerH: number): number {
  const chartH = containerH - TV_TOOLBAR_H - TV_TIMESCALE_H;
  const pct    = (range.max - price) / (range.max - range.min);
  return TV_TOOLBAR_H + pct * chartH;
}

/**
 * Given a set of candles that are visible in the TradingView chart, compute the
 * price range TradingView would auto-scale to (min_low → max_high + 8% padding).
 * TradingView adds roughly 5–10% top/bottom breathing room by default.
 */
function visibleRange(candles: Candle[], from: number, to: number): PriceRange | null {
  const vis = candles.filter((c) => {
    const ts = Math.floor(new Date(c.date).getTime() / 1000);
    return ts >= from && ts <= to;
  });
  if (vis.length === 0) return null;
  const minLow  = Math.min(...vis.map((c) => c.low));
  const maxHigh = Math.max(...vis.map((c) => c.high));
  const pad     = (maxHigh - minLow) * 0.08;
  return { min: minLow - pad, max: maxHigh + pad };
}

// ─── Signal level definitions ─────────────────────────────────────────────────
interface Level {
  price: number;
  label: string;
  color: string;
  dash?: boolean;
  width?: number;
}

function buildLevels(lv: LevelsData, sym: Symbol): Level[] {
  const out: Level[] = [
    { price: lv.buyZone.high,  label: `Buy Zone  ${fmtPrice(sym, lv.buyZone.high)}`,  color: "rgba(0,201,80,0.6)",  dash: true },
    { price: lv.buyZone.low,   label: `Buy Zone  ${fmtPrice(sym, lv.buyZone.low)}`,   color: "rgba(0,201,80,0.6)",  dash: true },
    { price: lv.sellZone.high, label: `Sell Zone ${fmtPrice(sym, lv.sellZone.high)}`, color: "rgba(239,68,68,0.6)", dash: true },
    { price: lv.sellZone.low,  label: `Sell Zone ${fmtPrice(sym, lv.sellZone.low)}`,  color: "rgba(239,68,68,0.6)", dash: true },
  ];
  if (lv.signal !== "WAIT") {
    out.push(
      { price: lv.entryPrice,  label: `Entry  ${fmtPrice(sym, lv.entryPrice)}`,  color: "#f59e0b", width: 2 },
      { price: lv.stopLoss,    label: `SL     ${fmtPrice(sym, lv.stopLoss)}`,    color: "#ef4444" },
      { price: lv.takeProfit1, label: `TP1    ${fmtPrice(sym, lv.takeProfit1)}`, color: "#22c55e" },
      { price: lv.takeProfit2, label: `TP2    ${fmtPrice(sym, lv.takeProfit2)}`, color: "#86efac", dash: true },
    );
  }
  return out;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function TradingViewChart({
  symbol,
  timeframe,
}: {
  symbol: Symbol;
  timeframe: Timeframe;
}) {
  const wrapRef    = useRef<HTMLDivElement>(null);
  const widgetRef  = useRef<TVWidget | null>(null);
  const chartReady = useRef(false);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  // Store latest price history in a ref so the polling closure always sees it
  const candlesRef = useRef<Candle[]>([]);

  const [priceRange, setPriceRange] = useState<PriceRange | null>(null);
  const [containerH, setContainerH] = useState(0);

  // ── Data fetching ────────────────────────────────────────────────────────
  const { data: levels } = useGetLevels(
    { symbol, timeframe },
    { query: { queryKey: getGetLevelsQueryKey({ symbol, timeframe }), refetchInterval: 10_000 } },
  );

  // Fetch 500 bars so we almost certainly cover whatever TradingView renders
  const { data: priceHistory } = useGetPriceHistory(
    { symbol, timeframe, bars: 500 },
    { query: { queryKey: getGetPriceHistoryQueryKey({ symbol, timeframe, bars: 500 }), staleTime: 60_000 } },
  );

  // Keep ref in sync so polling closure sees latest candles
  useEffect(() => {
    if (priceHistory?.candles) candlesRef.current = priceHistory.candles;
  }, [priceHistory]);

  // ── Poll the visible time range every 300 ms ─────────────────────────────
  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = () => {
      if (!widgetRef.current) return;
      const candles = candlesRef.current;

      let range: PriceRange | null = null;

      // ① Try the free-widget getVisibleRange() — returns {from,to} in seconds
      //    (some versions return ms; normalise either way)
      if (chartReady.current) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tvRange = (widgetRef.current as any).chart?.().getVisibleRange?.();
          if (tvRange?.from != null && candles.length > 0) {
            const from = tvRange.from > 1e11 ? tvRange.from / 1000 : tvRange.from;
            const to   = tvRange.to   > 1e11 ? tvRange.to   / 1000 : tvRange.to;
            // ±1 day buffer for timezone mismatches between Yahoo and TradingView
            range = visibleRange(candles, from - 86400, to + 86400);
          }
        } catch { /* chart not yet fully initialised */ }
      }

      // ② Fallback: last 200 candles (matches TradingView's ~200-bar default view)
      if (!range && candles.length > 0) {
        const slice   = candles.slice(-200);
        const minLow  = Math.min(...slice.map((c) => c.low));
        const maxHigh = Math.max(...slice.map((c) => c.high));
        const pad     = (maxHigh - minLow) * 0.08;
        range = { min: minLow - pad, max: maxHigh + pad };
      }

      if (range) setPriceRange(range);
      if (wrapRef.current) setContainerH(wrapRef.current.clientHeight);
    };
    tick();
    pollRef.current = setInterval(tick, 300);
  }

  // ── Create / recreate the TradingView widget ─────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let cancelled = false;
    chartReady.current = false;
    widgetRef.current  = null;
    setPriceRange(null);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
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

      // Start polling immediately — the fallback (last-200-candles) works
      // without the chart being ready; the getVisibleRange() path upgrades
      // automatically once chartReady is set inside onChartReady.
      if (!cancelled) startPolling();

      widget.onChartReady(() => {
        if (cancelled) return;
        chartReady.current = true;
        // No need to restart polling; the existing interval now has chart access
      });
    });

    return () => {
      cancelled = true;
      chartReady.current = false;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      widgetRef.current = null;
      if (wrap) wrap.innerHTML = "";
    };
    // startPolling is stable (defined in component body without deps) — safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  // ── Build overlay lines ──────────────────────────────────────────────────
  const signalLevels = levels ? buildLevels(levels, symbol) : [];
  const canOverlay   = priceRange && containerH > 0 && priceRange.max > priceRange.min;

  const meta = SYMBOLS[symbol];
  const signalColor =
    levels?.signal === "BUY"  ? "bg-emerald-500/95 text-black border-emerald-400" :
    levels?.signal === "SELL" ? "bg-red-500/95 text-black border-red-400" :
                                "bg-amber-500/95 text-black border-amber-400";

  return (
    <div className="relative h-full w-full rounded-sm overflow-hidden border border-zinc-800">
      {/* TradingView iframe fills the container */}
      <div ref={wrapRef} className="h-full w-full" />

      {/* ── Signal line overlay ────────────────────────────────────────────
          Absolutely positioned on top of the iframe. pointer-events:none so
          all chart interactions (pan, zoom, drawing tools) pass straight
          through to TradingView. Lines are clipped to the candle area. */}
      {canOverlay && signalLevels.map((lvl) => {
        const y = priceToY(lvl.price, priceRange!, containerH);
        // Only show levels that are within the visible chart area
        if (y < TV_TOOLBAR_H - 4 || y > containerH - TV_TIMESCALE_H + 4) return null;
        const yPx = Math.round(y);
        return (
          <div
            key={lvl.label}
            className="absolute pointer-events-none select-none"
            style={{
              top:    yPx,
              left:   TV_DRAWTOOLS_W,
              right:  TV_PRICEAXIS_W,
              height: lvl.width ?? 1,
            }}
          >
            {/* Horizontal line — dashed via repeating gradient for dashed style */}
            <div
              className="absolute inset-0"
              style={lvl.dash ? {
                backgroundImage: `repeating-linear-gradient(90deg,${lvl.color} 0,${lvl.color} 6px,transparent 6px,transparent 10px)`,
              } : {
                backgroundColor: lvl.color,
              }}
            />
            {/* Label floated just inside the price axis edge */}
            <span
              className="absolute right-1 font-mono whitespace-nowrap leading-none"
              style={{
                top:        -(lvl.width ?? 1) - 8,
                fontSize:   10,
                color:      lvl.color,
                textShadow: "0 0 6px #000, 0 0 3px #000, 1px 1px 0 #000",
              }}
            >
              {lvl.label}
            </span>
          </div>
        );
      })}

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
            {fmtPrice(symbol, levels.currentPrice)}
          </span>
        </div>
      )}
    </div>
  );
}
