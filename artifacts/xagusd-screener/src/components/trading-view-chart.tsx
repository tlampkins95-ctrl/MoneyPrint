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
type EntityId = string | number;

interface TVTimeRange { from: number; to: number }

interface TVChart {
  // time range — definitely available in free widget
  getVisibleRange(): TVTimeRange | null;
  onVisibleRangeChanged(): { subscribe(ctx: null, cb: (r: TVTimeRange) => void): void };
  // native chart shapes — try before CSS overlay
  createShape(
    point: { price?: number; time?: number },
    options: {
      shape: string;
      lock?: boolean;
      disableSelection?: boolean;
      disableSave?: boolean;
      overrides?: Record<string, unknown>;
    },
  ): EntityId | undefined | null;
  removeEntity(id: EntityId): void;
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

// ─── Attempt to draw signal levels as native TradingView shapes ───────────────
// createShape("horizontal_line") is available in the free widget and draws lines
// that live inside the chart — perfectly price-aligned, no CSS math needed.
function drawShapes(
  chart: TVChart,
  levels: LevelsData,
  sym: Symbol,
  store: EntityId[],
): boolean {
  // Clear previous shapes
  store.splice(0).forEach((id) => { try { chart.removeEntity(id); } catch { /**/ } });

  const add = (
    price: number,
    color: string,
    text: string,
    style = 0,   // 0 solid | 2 dashed
    width = 1,
  ): boolean => {
    try {
      const id = chart.createShape(
        { price },
        {
          shape: "horizontal_line",
          lock: true,
          disableSelection: true,
          disableSave: true,
          overrides: {
            linecolor:        color,
            linewidth:        width,
            linestyle:        style,
            showLabel:        true,
            text:             text,
            textcolor:        color,
            fontsize:         11,
            bold:             false,
            italic:           false,
            horzLabelsAlign:  "right",
            vertLabelsAlign:  "middle",
          },
        },
      );
      if (id != null) { store.push(id); return true; }
    } catch { /**/ }
    return false;
  };

  let anyOk = false;

  anyOk = add(levels.buyZone.high,  "rgba(0,201,80,0.7)",  `Buy Zone  ${fmtPrice(sym, levels.buyZone.high)}`,  2) || anyOk;
  anyOk = add(levels.buyZone.low,   "rgba(0,201,80,0.7)",  `Buy Zone  ${fmtPrice(sym, levels.buyZone.low)}`,   2) || anyOk;
  anyOk = add(levels.sellZone.high, "rgba(239,68,68,0.7)", `Sell Zone ${fmtPrice(sym, levels.sellZone.high)}`, 2) || anyOk;
  anyOk = add(levels.sellZone.low,  "rgba(239,68,68,0.7)", `Sell Zone ${fmtPrice(sym, levels.sellZone.low)}`,  2) || anyOk;

  if (levels.signal !== "WAIT") {
    anyOk = add(levels.entryPrice,  "#f59e0b", `Entry  ${fmtPrice(sym, levels.entryPrice)}`,  0, 2) || anyOk;
    anyOk = add(levels.stopLoss,    "#ef4444", `SL     ${fmtPrice(sym, levels.stopLoss)}`,    0, 1) || anyOk;
    anyOk = add(levels.takeProfit1, "#22c55e", `TP1    ${fmtPrice(sym, levels.takeProfit1)}`, 0, 1) || anyOk;
    anyOk = add(levels.takeProfit2, "#86efac", `TP2    ${fmtPrice(sym, levels.takeProfit2)}`, 2, 1) || anyOk;
  }

  return anyOk;
}

// ─── CSS overlay helpers (fallback when createShape isn't available) ──────────
// Approximate pixel offsets of the TradingView chart canvas inside the iframe.
const TV_TOOLBAR_H   = 52;
const TV_TIMESCALE_H = 26;
const TV_DRAWTOOLS_W = 40;
const TV_PRICEAXIS_W = 68;

interface PriceRange { min: number; max: number }

function priceToY(price: number, range: PriceRange, containerH: number): number {
  const chartH = containerH - TV_TOOLBAR_H - TV_TIMESCALE_H;
  return TV_TOOLBAR_H + ((range.max - price) / (range.max - range.min)) * chartH;
}

function candleRange(candles: Candle[], from: number, to: number): PriceRange | null {
  const vis = candles.filter((c) => {
    const ts = Math.floor(new Date(c.date).getTime() / 1000);
    return ts >= from - 86400 && ts <= to + 86400; // ±1 day timezone buffer
  });
  if (vis.length < 2) return null;
  const lo = Math.min(...vis.map((c) => c.low));
  const hi = Math.max(...vis.map((c) => c.high));
  const pad = (hi - lo) * 0.08;
  return { min: lo - pad, max: hi + pad };
}

interface CssLevel {
  price: number;
  label: string;
  color: string;
  dash?: boolean;
  width?: number;
}

function buildCssLevels(lv: LevelsData, sym: Symbol): CssLevel[] {
  const out: CssLevel[] = [
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
  const wrapRef       = useRef<HTMLDivElement>(null);
  const widgetRef     = useRef<TVWidget | null>(null);
  const shapeIds      = useRef<EntityId[]>([]);
  const usesShapes    = useRef(false);   // true → createShape worked; skip CSS overlay
  const candlesRef    = useRef<Candle[]>([]);
  const lastTvRange   = useRef<TVTimeRange | null>(null); // last range from TV subscription
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);

  const [priceRange, setPriceRange] = useState<PriceRange | null>(null);
  const [containerH, setContainerH] = useState(0);

  // ── Data ─────────────────────────────────────────────────────────────────
  const { data: levels } = useGetLevels(
    { symbol, timeframe },
    { query: { queryKey: getGetLevelsQueryKey({ symbol, timeframe }), refetchInterval: 10_000 } },
  );

  const { data: priceHistory } = useGetPriceHistory(
    { symbol, timeframe, bars: 500 },
    { query: { queryKey: getGetPriceHistoryQueryKey({ symbol, timeframe, bars: 500 }), staleTime: 60_000 } },
  );

  useEffect(() => {
    if (!priceHistory?.candles) return;
    candlesRef.current = priceHistory.candles;
    // If TV already fired onVisibleRangeChanged before candles arrived, compute now
    const tvr = lastTvRange.current;
    if (tvr && !usesShapes.current) {
      const from = tvr.from > 1e11 ? tvr.from / 1000 : tvr.from;
      const to   = tvr.to   > 1e11 ? tvr.to   / 1000 : tvr.to;
      const r = candleRange(priceHistory.candles, from, to);
      if (r) setPriceRange(r);
    }
  }, [priceHistory]);

  // ── When levels update, redraw shapes (if the chart is ready) ────────────
  useEffect(() => {
    if (!levels || !widgetRef.current || !usesShapes.current) return;
    try {
      const ok = drawShapes(widgetRef.current.chart(), levels, symbol, shapeIds.current);
      if (!ok) usesShapes.current = false;
    } catch { /**/ }
  }, [levels, symbol]);

  // ── Widget lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let cancelled = false;
    widgetRef.current = null;
    usesShapes.current = false;
    shapeIds.current = [];
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

      widget.onChartReady(() => {
        if (cancelled) return;
        const chart = widget.chart();

        // ── Attempt 1: createShape() (native, perfectly price-aligned) ──────
        if (levels) {
          const ok = drawShapes(chart, levels, symbol, shapeIds.current);
          if (ok) {
            usesShapes.current = true;
            return; // shapes work — no CSS overlay needed
          }
        }

        // ── Attempt 2: CSS overlay — subscribe to visible range changes ──────
        // onVisibleRangeChanged fires on initial load AND on pan/zoom,
        // giving us the exact candle window to compute the price range.
        const updateRange = (range: TVTimeRange) => {
          lastTvRange.current = range; // store so candle-load can retry
          if (!candlesRef.current.length) return;
          const from = range.from > 1e11 ? range.from / 1000 : range.from;
          const to   = range.to   > 1e11 ? range.to   / 1000 : range.to;
          const r = candleRange(candlesRef.current, from, to);
          if (r) setPriceRange(r);
        };

        try {
          chart.onVisibleRangeChanged().subscribe(null, updateRange);
          // Also seed with current range immediately
          const initial = chart.getVisibleRange();
          if (initial) updateRange(initial);
        } catch { /**/ }

        // Poll containerH so the overlay stays sized correctly on resize
        if (wrapRef.current) setContainerH(wrapRef.current.clientHeight);
        pollRef.current = setInterval(() => {
          if (wrapRef.current) setContainerH(wrapRef.current.clientHeight);
        }, 500);
      });
    });

    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      shapeIds.current.forEach((id) => {
        try { widgetRef.current?.chart().removeEntity(id); } catch { /**/ }
      });
      shapeIds.current = [];
      widgetRef.current = null;
      if (wrap) wrap.innerHTML = "";
    };
  }, [symbol, timeframe]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ───────────────────────────────────────────────────────────────
  const cssLevels  = (!usesShapes.current && levels) ? buildCssLevels(levels, symbol) : [];
  const canOverlay = !usesShapes.current && priceRange && containerH > 0 && priceRange.max > priceRange.min;

  const meta = SYMBOLS[symbol];
  const signalColor =
    levels?.signal === "BUY"  ? "bg-emerald-500/95 text-black border-emerald-400" :
    levels?.signal === "SELL" ? "bg-red-500/95 text-black border-red-400" :
                                "bg-amber-500/95 text-black border-amber-400";

  return (
    <div className="relative h-full w-full rounded-sm overflow-hidden border border-zinc-800">
      <div ref={wrapRef} className="h-full w-full" />

      {/* CSS overlay — only shown when createShape isn't available */}
      {canOverlay && cssLevels.map((lvl) => {
        const y = priceToY(lvl.price, priceRange!, containerH);
        if (y < TV_TOOLBAR_H - 4 || y > containerH - TV_TIMESCALE_H + 4) return null;
        return (
          <div
            key={lvl.label}
            className="absolute pointer-events-none select-none"
            style={{ top: Math.round(y), left: TV_DRAWTOOLS_W, right: TV_PRICEAXIS_W, height: lvl.width ?? 1 }}
          >
            <div
              className="absolute inset-0"
              style={lvl.dash ? {
                backgroundImage: `repeating-linear-gradient(90deg,${lvl.color} 0,${lvl.color} 6px,transparent 6px,transparent 10px)`,
              } : {
                backgroundColor: lvl.color,
              }}
            />
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

      {/* Symbol label */}
      <div className="absolute top-2 left-3 z-20 pointer-events-none font-mono text-[11px] text-zinc-400 select-none">
        {meta.short}
        {meta.venue && <span className="ml-2 text-zinc-600">{meta.venue}</span>}
      </div>

      {/* Signal + price badge */}
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
