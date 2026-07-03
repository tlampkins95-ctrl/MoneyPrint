import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  BaselineSeries,
  LineSeries,
  HistogramSeries,
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
  const bbUpperRef        = useRef<ISeriesApi<"Line"> | null>(null);
  const bbMiddleRef       = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerRef        = useRef<ISeriesApi<"Line"> | null>(null);
  const linesRef          = useRef<IPriceLine[]>([]);
  // Raw date strings from the first/last candle — used to anchor zone band data.
  // Stored as strings so toTime() can apply the right conversion (business-day
  // vs UTCTimestamp) consistently when building BaselineSeries data points.
  const firstDateRef      = useRef<string | null>(null);
  const lastDateRef       = useRef<string | null>(null);
  // Only scroll to real-time once per chart instance (not on every 10s refetch)
  const hasScrolledRef    = useRef(false);
  // MACD subpanel — separate chart instance, synced time scale
  const macdContainerRef  = useRef<HTMLDivElement>(null);
  const macdChartRef      = useRef<IChartApi | null>(null);
  const macdHistRef       = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdLineRef       = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef     = useRef<ISeriesApi<"Line"> | null>(null);
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

  // Bollinger Bands toggle — default ON.
  const [showBB, setShowBB] = useState(true);

  // Fib levels toggle — shows swingA, swingB, and 50% fib lines so the user
  // can verify the app is reading the same swing structure as the chart.
  // Default OFF to keep the chart clean. Resets on symbol/TF change.
  const [showFibs, setShowFibs] = useState(false);

  // MACD(12,26,9) subpane toggle — default ON.
  const [showMacd, setShowMacd] = useState(true);

  // Reset overlays when symbol/timeframe changes so defaults re-evaluate.
  useEffect(() => {
    setPatternUserOverride(null);
    setShowBB(true);
    setShowFibs(false);
    setShowMacd(true);
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

    // ── Bollinger Bands series (upper / middle / lower) ──────────────────
    // Sky-blue palette; upper/lower solid, middle dashed SMA line.
    // Data is populated (or cleared) by the separate BB effect below.
    const BB_COLOR_BAND = "rgba(14,165,233,0.55)";
    const BB_COLOR_MID  = "rgba(14,165,233,0.35)";
    const bbUpper = chart.addSeries(LineSeries, {
      color:                  BB_COLOR_BAND,
      lineWidth:              1 as LineWidth,
      lineStyle:              LineStyle.Solid,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    const bbMiddle = chart.addSeries(LineSeries, {
      color:                  BB_COLOR_MID,
      lineWidth:              1 as LineWidth,
      lineStyle:              LineStyle.Dashed,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    const bbLower = chart.addSeries(LineSeries, {
      color:                  BB_COLOR_BAND,
      lineWidth:              1 as LineWidth,
      lineStyle:              LineStyle.Solid,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });

    candleSeriesRef.current   = candles;
    buyZoneRef.current        = buyZone;
    sellZoneRef.current       = sellZone;
    patUpperRailRef.current   = patUpper;
    patLowerRailRef.current   = patLower;
    bbUpperRef.current        = bbUpper;
    bbMiddleRef.current       = bbMiddle;
    bbLowerRef.current        = bbLower;
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
      bbUpperRef.current        = null;
      bbMiddleRef.current       = null;
      bbLowerRef.current        = null;
      firstDateRef.current      = null;
      lastDateRef.current       = null;
      hasScrolledRef.current    = false;
      try { chart.remove(); } catch { /**/ }
      chartRef.current = null;
    };
  }, [symbol, timeframe]);

  // ── MACD chart (separate synced instance) ─────────────────────────────
  // Recreated whenever symbol or timeframe changes so the time scale stays
  // in sync with the main chart. Uses a dedicated div below the main chart.
  useEffect(() => {
    const el = macdContainerRef.current;
    if (!el) return;

    const macdChart = createChart(el, {
      layout: {
        background: { color: "#0a0a0a" },
        textColor:  "#71717a",
        fontSize:   10,
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
      },
      grid: {
        vertLines: { color: "#18181b" },
        horzLines: { color: "#18181b" },
      },
      rightPriceScale: { borderColor: "#27272a", minimumWidth: 60 },
      leftPriceScale:  { visible: false },
      timeScale:       { borderColor: "#27272a", visible: false },
      crosshair:       { vertLine: { visible: true }, horzLine: { visible: false } },
      autoSize: true,
    });

    const macdHist = macdChart.addSeries(HistogramSeries, {
      priceScaleId:     "right",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const macdLine = macdChart.addSeries(LineSeries, {
      color:                  "#60a5fa",
      lineWidth:              1 as LineWidth,
      priceScaleId:           "right",
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    const macdSignal = macdChart.addSeries(LineSeries, {
      color:                  "#f59e0b",
      lineWidth:              1 as LineWidth,
      lineStyle:              LineStyle.Dashed,
      priceScaleId:           "right",
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });

    // Sync time scales by calendar time (not bar index), so the different
    // bar counts between the two charts don't mis-align the view.
    let syncing = false;
    const onMainTime = (range: { from: Time; to: Time } | null) => {
      if (syncing || !range) return;
      syncing = true;
      try { macdChart.timeScale().setVisibleRange(range); } catch { /**/ }
      syncing = false;
    };
    const onMacdTime = (range: { from: Time; to: Time } | null) => {
      if (syncing || !range) return;
      syncing = true;
      try { chartRef.current?.timeScale().setVisibleRange(range); } catch { /**/ }
      syncing = false;
    };
    chartRef.current?.timeScale().subscribeVisibleTimeRangeChange(onMainTime);
    macdChart.timeScale().subscribeVisibleTimeRangeChange(onMacdTime);

    macdChartRef.current  = macdChart;
    macdHistRef.current   = macdHist;
    macdLineRef.current   = macdLine;
    macdSignalRef.current = macdSignal;

    return () => {
      chartRef.current?.timeScale().unsubscribeVisibleTimeRangeChange(onMainTime);
      macdChart.timeScale().unsubscribeVisibleTimeRangeChange(onMacdTime);
      macdHistRef.current   = null;
      macdLineRef.current   = null;
      macdSignalRef.current = null;
      try { macdChart.remove(); } catch { /**/ }
      macdChartRef.current = null;
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

    // Derive the right decimal precision from the actual price level so that
    // sub-penny assets (e.g. KATUSDT ~$0.0086) don't get rounded to "$0.01"
    // by the lightweight-charts default precision of 2.
    //
    // Formula: leading zeros past the decimal point + 2 extra digits,
    // but never fewer than the symbol's configured decimals floor.
    // Examples: $0.00855 → precision 5 (→ "0.00855")
    //           $75.85   → precision 3 (→ "75.850", floor from meta.decimals=3)
    //           $1.1631  → precision 5 (→ "1.16310", floor from meta.decimals=5)
    {
      const meta       = getSymbolMeta(symbol);
      const midClose   = history.candles[Math.floor(history.candles.length / 2)].close;
      const leadZeros  = midClose > 0 ? Math.max(0, -Math.floor(Math.log10(midClose))) : 0;
      const precision  = Math.max(meta.decimals, leadZeros + 2);
      const minMove    = Number(`1e-${precision}`);
      series.applyOptions({ priceFormat: { type: "price", precision, minMove } });
    }
    firstDateRef.current = history.candles[0].date;
    lastDateRef.current  = history.candles[history.candles.length - 1].date;

    // On first load: fit content so the full price range is visible (prevents
    // the current price being off-screen when the asset has dropped far from
    // historical highs), then scroll to pin the latest candle at the right edge.
    if (!hasScrolledRef.current) {
      chartRef.current?.timeScale().fitContent();
      chartRef.current?.timeScale().scrollToRealTime();
      hasScrolledRef.current = true;
    }
  }, [history]);

  // ── Bollinger Bands (SMA-30, 2σ) computed from candle history ─────────
  // Runs whenever candle history loads or the BB toggle changes.
  // All arithmetic is done in the component — no extra API round-trip needed.
  useEffect(() => {
    const upper  = bbUpperRef.current;
    const middle = bbMiddleRef.current;
    const lower  = bbLowerRef.current;
    if (!upper || !middle || !lower) return;

    if (!showBB || !history?.candles?.length) {
      upper.setData([]);
      middle.setData([]);
      lower.setData([]);
      return;
    }

    const cs      = history.candles;
    const PERIOD  = 30;
    const MULT    = 2;
    type Pt = { time: ReturnType<typeof toTime>; value: number };
    const uData: Pt[] = [], mData: Pt[] = [], lData: Pt[] = [];

    for (let i = PERIOD - 1; i < cs.length; i++) {
      const slice  = cs.slice(i - PERIOD + 1, i + 1);
      const mean   = slice.reduce((s, c) => s + c.close, 0) / PERIOD;
      const stdDev = Math.sqrt(slice.reduce((s, c) => s + (c.close - mean) ** 2, 0) / PERIOD);
      const time   = toTime(cs[i].date);
      uData.push({ time, value: mean + MULT * stdDev });
      mData.push({ time, value: mean });
      lData.push({ time, value: mean - MULT * stdDev });
    }

    upper.setData(uData);
    middle.setData(mData);
    lower.setData(lData);
  }, [history, showBB]);

  // ── MACD(12,26,9) subpane ─────────────────────────────────────────────
  // Computed entirely in the component from candle closes — same formula as
  // the backend calcMACDHist gate. Histogram colour follows TradingView convention:
  //   positive & rising  → bright green;  positive & falling → pale green
  //   negative & falling → bright red;    negative & rising  → pale red
  useEffect(() => {
    const hist   = macdHistRef.current;
    const line   = macdLineRef.current;
    const signal = macdSignalRef.current;
    if (!hist || !line || !signal) return;

    if (!showMacd || !history?.candles?.length) {
      hist.setData([]);
      line.setData([]);
      signal.setData([]);
      return;
    }

    const closes = history.candles.map((c) => c.close);

    // EMA helper (standard Wilder/TradingView variant: SMA seed then EMA)
    const ema = (src: number[], period: number): number[] => {
      const k = 2 / (period + 1);
      const out: number[] = new Array(src.length).fill(NaN);
      const seed = period - 1;
      if (src.length <= seed) return out;
      out[seed] = src.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = seed + 1; i < src.length; i++) {
        out[i] = src[i] * k + out[i - 1] * (1 - k);
      }
      return out;
    };

    const ema12  = ema(closes, 12);
    const ema26  = ema(closes, 26);
    const macdLine: number[] = ema12.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(ema26[i]) ? v - ema26[i] : NaN,
    );
    // Seed signal EMA from the first finite MACD value
    const signalLine = ema(macdLine.filter((v) => Number.isFinite(v)), 9);
    // Rebuild full-length signal array aligned to candle indices
    const signalFull: number[] = new Array(closes.length).fill(NaN);
    let sigIdx = 0;
    for (let i = 0; i < closes.length; i++) {
      if (Number.isFinite(macdLine[i])) {
        if (sigIdx < signalLine.length) signalFull[i] = signalLine[sigIdx++];
      }
    }

    type HistPt = { time: ReturnType<typeof toTime>; value: number; color: string };
    type LinePt  = { time: ReturnType<typeof toTime>; value: number };
    const histData: HistPt[] = [];
    const lineData: LinePt[] = [];
    const sigData:  LinePt[] = [];

    for (let i = 0; i < closes.length; i++) {
      const m  = macdLine[i];
      const s  = signalFull[i];
      const mp = macdLine[i - 1];
      const t  = toTime(history.candles[i].date);
      if (Number.isFinite(m)) lineData.push({ time: t, value: m });
      if (Number.isFinite(s)) sigData.push({ time: t, value: s });
      if (Number.isFinite(m) && Number.isFinite(s)) {
        const hval = m - s;
        const prev = i > 0 && Number.isFinite(macdLine[i - 1]) && Number.isFinite(signalFull[i - 1])
          ? mp - signalFull[i - 1]
          : hval;
        const rising = hval >= prev;
        const color  = hval >= 0
          ? (rising ? "#26a69a" : "#a0d9cf")   // green shades
          : (rising ? "#f4a0a0" : "#ef5350");   // red shades
        histData.push({ time: t, value: hval, color });
      }
    }

    hist.setData(histData);
    line.setData(lineData);
    signal.setData(sigData);

    // After populating data, copy the main chart's current time window to
    // the MACD chart. The subscription only fires on CHANGES, so first load
    // requires an explicit copy.
    const tRange = chartRef.current?.timeScale().getVisibleRange();
    if (tRange) {
      try { macdChartRef.current?.timeScale().setVisibleRange(tRange); } catch { /**/ }
    } else {
      macdChartRef.current?.timeScale().fitContent();
    }
  }, [history, showMacd]);

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

    // ── Current price line ────────────────────────────────────────────────
    if (levels.currentPrice) {
      addLine(levels.currentPrice, "#e2e8f0", "▶ Price", LineStyle.Solid, 1);
    }

    // ── Active trade lines ────────────────────────────────────────────────
    if (isBuy || isSell) {
      addLine(levels.entryPrice, isBuy ? "#22c55e" : "#ef4444", "Entry", LineStyle.Solid, 2);
      if (levels.dca1 != null) addLine(levels.dca1, "#f59e0b", "DCA", LineStyle.Dashed);
      addLine(levels.stopLoss,    "#ef4444", "SL",  LineStyle.Dashed);
      addLine(levels.takeProfit1, "#10b981", "TP1", LineStyle.Dashed);
      addLine(levels.takeProfit2, "#10b981", "TP2", LineStyle.Dashed);
    }

    // ── Pivot structure (S1–S3, R1–R3, Pivot) ────────────────────────────
    for (const { label, price, type } of levels.levels) {
      if (label.startsWith("Fib") || label.startsWith("Swing")) {
        // Draw fib / swing lines only when the toggle is ON.
        if (showFibs && price > 0) {
          const color =
            label === "Swing High" ? "#f59e0b" :  // amber — upper swing point
            label === "Swing Low"  ? "#a855f7" :  // violet — lower swing point
                                     "#94a3b8";   // slate — 50% fib (entry zone)
          addLine(price, color, label, LineStyle.Dashed, 1);
        }
        continue;
      }
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
      "BULL_PENNANT", "BEAR_PENNANT", "BULL_FLAG", "BEAR_FLAG",
    ]);
    const isCandlestickOnly  = CANDLESTICK_TYPES.has(levels.detectedPattern ?? "");
    const hasDiagonalPattern = DIAGONAL_TYPES.has(levels.detectedPattern ?? "");

    const patUpper = patUpperRailRef.current;
    const patLower = patLowerRailRef.current;

    // Draw diagonal rails for forming AND recently confirmed patterns.
    // Confirmed = breakout just happened — rails show context for the move.
    // Truly stale confirmed patterns are expired server-side (5-bar window)
    // so they never reach the chart at all.
    const canDrawDiagonal =
      showPatterns &&
      hasDiagonalPattern &&
      levels.patternStartDate != null &&
      levels.patternNecklineStart != null &&
      levels.patternEndDate != null;

    if (canDrawDiagonal && patUpper && patLower) {
      const startTime = toTime(levels.patternStartDate!);
      const endTime   = toTime(levels.patternEndDate!);

      const upperStart = levels.patternUpperBoundStart ?? levels.patternUpperBound!;
      const upperEnd   = levels.patternUpperBound!;
      const lowerStart = levels.patternNecklineStart!;
      const lowerEnd   = levels.patternNeckline!;

      // Extrapolate the slope forward to the current candle so the rails
      // always reach the current price position, even as new bars print.
      const startMs = new Date(levels.patternStartDate!).getTime();
      const endMs   = new Date(levels.patternEndDate!).getTime();
      const spanMs  = endMs - startMs;
      const upperSlope = spanMs > 0 ? (upperEnd - upperStart) / spanMs : 0;
      const lowerSlope = spanMs > 0 ? (lowerEnd - lowerStart) / spanMs : 0;

      const lastDate = lastDateRef.current;
      const lastMs   = lastDate ? new Date(lastDate).getTime() : 0;
      const shouldExtend = lastDate !== null && lastMs > endMs + 1000;

      const upperData: { time: ReturnType<typeof toTime>; value: number }[] = [
        { time: startTime, value: upperStart },
        { time: endTime,   value: upperEnd },
      ];
      const lowerData: { time: ReturnType<typeof toTime>; value: number }[] = [
        { time: startTime, value: lowerStart },
        { time: endTime,   value: lowerEnd },
      ];

      if (shouldExtend) {
        const extraMs  = lastMs - endMs;
        const lastTime = toTime(lastDate!);
        upperData.push({ time: lastTime, value: upperEnd + upperSlope * extraMs });
        lowerData.push({ time: lastTime, value: lowerEnd + lowerSlope * extraMs });
      }

      patUpper.setData(upperData as Parameters<typeof patUpper.setData>[0]);
      patLower.setData(lowerData as Parameters<typeof patLower.setData>[0]);
    } else {
      // Clear rails — either no diagonal, already confirmed, or missing coords.
      patUpper?.setData([]);
      patLower?.setData([]);

      // Horizontal lines for non-diagonal structural patterns (H&S, double top/bottom,
      // flags). Diagonal patterns are excluded — their rails were cleared above and
      // horizontal approximations would be meaningless.
      const p = levels.detectedPattern;
      const isDoublePattern = p === "DOUBLE_TOP" || p === "DOUBLE_BOTTOM";
      const isHS = p === "HEAD_AND_SHOULDERS" || p === "INVERSE_HEAD_AND_SHOULDERS";
      const drawHorizontals =
        showPatterns &&
        levels.patternNeckline != null &&
        !isCandlestickOnly &&
        !hasDiagonalPattern &&
        (levels.patternConfirmed === true || isDoublePattern);
      if (drawHorizontals) {
        const lowerLabel = isHS ? "Neckline" : isDoublePattern ? (p === "DOUBLE_TOP" ? "DT Neck" : "DB Neck") : "Pat Low";
        const upperLabel = p === "INVERSE_HEAD_AND_SHOULDERS" ? "IHS Target"
                         : p === "HEAD_AND_SHOULDERS"         ? "H&S Head"
                         : isDoublePattern ? (p === "DOUBLE_TOP" ? "DT Resist" : "DB Support")
                         : "Pat High";
        addLine(levels.patternNeckline!, "#a855f7", lowerLabel, LineStyle.SparseDotted, 1);
        if (levels.patternUpperBound != null) {
          addLine(levels.patternUpperBound, "#fbbf24", upperLabel, LineStyle.SparseDotted, 1);
        }
      }

      // Candlestick key-level line — draw the candle's defining price as a
      // dashed horizontal so the level is visible on the chart.
      // Bullish (engulfing/hammer): support at the candle's low (green).
      // Bearish (engulfing/star):   resistance at the candle's high (red).
      if (showPatterns && isCandlestickOnly && levels.patternConfirmed === true && levels.patternNeckline != null) {
        const isBullishCandle = p === "BULLISH_ENGULFING" || p === "HAMMER";
        const candleLabel =
          p === "BULLISH_ENGULFING" ? "Engulf Sup" :
          p === "BEARISH_ENGULFING" ? "Engulf Res" :
          p === "HAMMER"            ? "Hammer Low" :
                                      "Star High";
        const candleColor = isBullishCandle ? "#22c55e" : "#ef4444";
        addLine(levels.patternNeckline!, candleColor, candleLabel, LineStyle.SparseDotted, 1);
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
  }, [levels, history, showPatterns, showFibs]);

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
    <div className="relative h-full w-full rounded-sm overflow-hidden border border-zinc-800 flex flex-col">
      <div ref={containerRef} className="flex-1 min-h-0" />
      {/* MACD subpanel — separate synced chart */}
      <div
        ref={macdContainerRef}
        className={`border-t border-zinc-800 transition-all duration-200 ${showMacd ? "h-[120px]" : "h-0 overflow-hidden"}`}
      />

      {/* Symbol label — top-left */}
      <div className="absolute top-2 left-3 z-20 pointer-events-none font-mono text-[11px] text-zinc-400 select-none">
        {meta.short}
        {meta.venue && <span className="ml-2 text-zinc-600">{meta.venue}</span>}
      </div>

      {/* Signal + live price badge — top-right */}
      {levels && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1 font-mono select-none">
          {/* MACD toggle — subpane with histogram + line + signal. Default ON. */}
          <button
            onClick={() => setShowMacd(v => !v)}
            className={`px-2 py-0.5 rounded-sm font-mono text-[10px] border transition-colors cursor-pointer ${
              showMacd
                ? "bg-violet-950/90 border-violet-500/60 text-violet-300 hover:bg-violet-900/90"
                : "bg-zinc-900/80 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
            }`}
          >
            MACD
          </button>
          {/* BB toggle — Bollinger Bands (SMA-30, 2σ). Always ON per symbol/TF load. */}
          <button
            onClick={() => setShowBB(v => !v)}
            className={`px-2 py-0.5 rounded-sm font-mono text-[10px] border transition-colors cursor-pointer ${
              showBB
                ? "bg-sky-950/90 border-sky-500/60 text-sky-300 hover:bg-sky-900/90"
                : "bg-zinc-900/80 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
            }`}
          >
            BB(30,2)
          </button>
          {/* Fib toggle — swing high/low + 50% fib lines. Default OFF. */}
          <button
            onClick={() => setShowFibs(v => !v)}
            className={`px-2 py-0.5 rounded-sm font-mono text-[10px] border transition-colors cursor-pointer ${
              showFibs
                ? "bg-amber-950/90 border-amber-500/60 text-amber-300 hover:bg-amber-900/90"
                : "bg-zinc-900/80 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
            }`}
          >
            Fibs
          </button>
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
