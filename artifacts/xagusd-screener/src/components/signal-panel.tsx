import { useEffect, useState } from "react";
import { useGetLevels, getGetLevelsQueryKey, useGetBacktest } from "@workspace/api-client-react";
import { format } from "date-fns";
import { RefreshCw, TrendingUp, TrendingDown, ArrowRight, AlertTriangle, Wallet, Settings, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Timeframe } from "@/components/timeframe-selector";
import { getSymbolMeta, fmtPriceMeta, fmtPriceCompactMeta, type Symbol } from "@/lib/symbols";

const ACCOUNT_KEY = "screener.accountSize";
const RISK_KEY = "screener.riskPct";
const MAX_LEV_KEY = "screener.maxLeverage";
// MT5 lot size for forex/metals (BTC/ETH use Phemex USDT-perp collateral × leverage).
// 0.01 lot = 1 micro lot, the standard "starter" size on most MT5 brokers.
const MT5_LOTS_KEY = "screener.mt5Lots";

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "1h": "1h",
  "4h": "4h",
  "1d": "Daily",
  "1w": "Weekly",
};

export function SignalPanel({
  symbol,
  timeframe,
  expanded,
  onExpandedChange,
}: {
  symbol: string;
  timeframe: Timeframe;
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
}) {
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [accountSize, setAccountSize] = useState<number>(() => readNumber(ACCOUNT_KEY, 500));
  const [accountSizeText, setAccountSizeText] = useState<string>(() => String(readNumber(ACCOUNT_KEY, 500)));
  const [riskPct, setRiskPct] = useState<number>(() => readNumber(RISK_KEY, 1));
  const [riskPctText, setRiskPctText] = useState<string>(() => String(readNumber(RISK_KEY, 1)));
  // Phemex's binding minimum is the contract qty (0.001 BTC, 0.01 ETH),
  // enforced server-side from symbol meta — there is no $-collateral floor
  // on Phemex USDT-perps, so the only user-facing knob here is the lev cap.
  const [maxLeverage, setMaxLeverage] = useState<number>(() => readNumber(MAX_LEV_KEY, 100));
  const [maxLeverageText, setMaxLeverageText] = useState<string>(() => String(readNumber(MAX_LEV_KEY, 100)));
  const [mt5Lots, setMt5Lots] = useState<number>(() => readNumber(MT5_LOTS_KEY, 0.01));
  // The lots input is backed by a string buffer so the user can freely type
  // intermediate values like "0." or "0.0" without our >= 0.01 guard
  // rejecting them and leaving the visible input out of sync with state
  // (a real bug we hit with a controlled type=number input). The numeric
  // mt5Lots state is only updated when the buffer parses to a valid value.
  const [mt5LotsText, setMt5LotsText] = useState<string>(() =>
    String(readNumber(MT5_LOTS_KEY, 0.01)),
  );
  useEffect(() => {
    window.localStorage.setItem(ACCOUNT_KEY, String(accountSize));
  }, [accountSize]);
  useEffect(() => {
    window.localStorage.setItem(RISK_KEY, String(riskPct));
  }, [riskPct]);
  useEffect(() => {
    window.localStorage.setItem(MAX_LEV_KEY, String(maxLeverage));
  }, [maxLeverage]);
  useEffect(() => {
    window.localStorage.setItem(MT5_LOTS_KEY, String(mt5Lots));
  }, [mt5Lots]);

  const params = { symbol, timeframe, accountSize, riskPct, maxLeverage, mt5Lots };
  const { data, isLoading, isError, error, refetch, isFetching } = useGetLevels(
    params,
    {
      query: {
        queryKey: getGetLevelsQueryKey(params),
        refetchInterval: 10000,
        // Don't retry client errors (4xx) — they won't succeed on retry and
        // cause long delays before the "Unknown symbol" auto-reset fires.
        retry: (count, err) =>
          count < 3 && !err.message.includes("Bad Request"),
      },
    },
  );

  const handleRefresh = async () => {
    await refetch();
    setLastRefreshed(new Date());
  };

  const isActiveSignal = data?.signal === "BUY" || data?.signal === "SELL";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: btData } = useGetBacktest(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { symbol: symbol as any, timeframe, signalType: "FIB50_SWING" as const },
    { query: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false, enabled: isActiveSignal } as never },
  );
  const poorWinRate = !!btData && btData.totalTrades >= 15 && btData.winRate < 45;

  useEffect(() => {
    if (data?.lastUpdated) setLastRefreshed(new Date(data.lastUpdated));
  }, [data?.lastUpdated]);


  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-[#0a0a0a]/50 rounded-xl border border-zinc-800 p-5 animate-pulse space-y-4">
        <div className="h-36 bg-white/5 rounded-lg" />
        <div className="h-12 bg-white/5 rounded-lg" />
        <div className="h-48 bg-white/5 rounded-lg" />
        <div className="h-16 bg-white/5 rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    const isUnknown = error?.message?.includes("Unknown symbol");
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0a0a0a]/50 rounded-xl border border-red-500/20 p-6 text-center">
        <AlertTriangle className="w-8 h-8 text-red-500 mb-3" />
        <div className="text-red-500 mb-2 font-bold">Signal data unavailable</div>
        <p className="text-sm text-zinc-400 mb-6">
          {isUnknown
            ? "This coin isn't listed on OKX perpetuals — no candle data to compute signals from."
            : (error?.message ?? "Connection to trading terminal lost.")}
        </p>
        <button
          onClick={handleRefresh}
          className="px-6 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md transition-colors text-sm font-mono flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      </div>
    );
  }

  const isPositive = data.priceChange >= 0;
  const meta = getSymbolMeta(symbol);

  // Venue routing: BTC/ETH trade on Phemex USDT perps ($collateral × leverage),
  // XAU/XAG/forex pairs trade on MetaTrader 5 (lot-based),
  // SKYAIUSDT and other Coinbase spot tokens use simple token sizing.
  // The sizing block emits parallel projection shapes per venue:
  //   • achievable   — PHEMEX exchange-floor rounded values
  //   • mt5          — lot-based USD P&L for the chosen lots
  //   • spotToken    — whole-token count, notional, risk (no leverage)
  // Read whichever matches the venue so the TradeRow $ figures and the
  // EXACT TRADE TO PLACE panel both reflect the actual venue the trader uses.
  const venue: "PHEMEX" | "MT5" | "PHEMEX_SPOT" = data.positionSizing?.venue ?? "PHEMEX";
  const isMT5 = venue === "MT5";
  const isCoinbaseSpot = venue === "PHEMEX_SPOT";
  const pnls = isMT5
    ? data.positionSizing?.mt5
    : isCoinbaseSpot
      ? data.positionSizing?.spotToken
      : data.positionSizing?.achievable;

  // Inverted hero: instead of a bright signal-colored background with dark text,
  // we render a near-black box and let the signal word itself glow in colour.
  // A subtle vertical tint preserves each signal's identity without the
  // billboard-bright wash of the old design.
  const signalBg = data.signal === "BUY"
    ? "bg-gradient-to-b from-emerald-950/70 via-[#0a0a0a]/85 to-[#0a0a0a]/85"
    : data.signal === "SELL"
    ? "bg-gradient-to-b from-red-950/70 via-[#0a0a0a]/85 to-[#0a0a0a]/85"
    : "bg-gradient-to-b from-amber-950/70 via-[#0a0a0a]/85 to-[#0a0a0a]/85";

  // Body text (timeframe pill, reason copy) sits on the dark hero, so default
  // to light text for everything; the BUY/SELL/WAIT word itself is overridden
  // below with its own glow style.
  const signalTextColor = "text-zinc-100";

  const signalGlow: Record<typeof data.signal, { color: string; shadow: string; stroke: string }> = {
    BUY: {
      color: "#22E07A",
      shadow:
        "0 0 6px rgba(34,224,122,0.95), 0 0 20px rgba(0,201,80,0.75), 0 0 44px rgba(0,201,80,0.45)",
      stroke: "0.5px rgba(0, 80, 35, 0.55)",
    },
    SELL: {
      color: "#FF5F6D",
      shadow:
        "0 0 6px rgba(255,95,109,0.95), 0 0 20px rgba(229,62,62,0.75), 0 0 44px rgba(229,62,62,0.45)",
      stroke: "0.5px rgba(110, 0, 0, 0.55)",
    },
    WAIT: {
      color: "#FFD56B",
      shadow:
        "0 0 6px rgba(255,213,107,0.95), 0 0 20px rgba(255,191,36,0.7), 0 0 44px rgba(255,165,0,0.45)",
      stroke: "0.5px rgba(120, 80, 0, 0.55)",
    },
  };
  const glow = signalGlow[data.signal];
  const signalWordStyle: React.CSSProperties = {
    fontFamily: "var(--app-font-display)",
    color: glow.color,
    textShadow: glow.shadow,
    WebkitTextStroke: glow.stroke,
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]/50 backdrop-blur-md text-zinc-100 rounded-xl border border-zinc-800 overflow-hidden font-mono shadow-2xl">

      {/* ── Collapsed: compact tap-to-expand bar ─────────────────────── */}
      {!expanded && (
        <button
          className={cn("w-full flex items-center gap-3 px-4 py-3 shrink-0 text-left", signalBg)}
          onClick={() => onExpandedChange(true)}
          aria-label="Expand signal details"
        >
          <span className="text-2xl font-black tracking-tight shrink-0" style={signalWordStyle}>
            {data.signal}
          </span>
          <span className="text-xs text-zinc-300 flex-1 truncate leading-snug">
            {data.signalReason}
          </span>
          <ChevronDown className="w-4 h-4 text-white/40 shrink-0" />
        </button>
      )}

      {/* ── 1. Signal Hero (click to collapse) ──────────────────────── */}
      {expanded && (
        <div
          className={cn("px-5 py-5 flex flex-col items-center text-center shrink-0 relative cursor-pointer select-none", signalBg, signalTextColor)}
          onClick={() => onExpandedChange(false)}
          role="button"
          tabIndex={0}
          aria-label="Collapse signal details"
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onExpandedChange(false); }}
        >
          <span className="absolute top-2 right-3 text-[10px] tracking-widest font-bold opacity-80 bg-black/30 rounded px-2 py-0.5">
            {TIMEFRAME_LABEL[timeframe]}
          </span>
          <div
            className="text-[64px] leading-none font-black tracking-tight"
            style={signalWordStyle}
          >
            {data.signal}
          </div>
          {(data.signal === "BUY" || data.signal === "SELL") && (() => {
            const st = data.signalType;
            if (st === "DOUBLE_TOP")
              return (
                <span className="mt-1 px-3 py-0.5 text-[10px] font-bold tracking-widest rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  ⫟ DOUBLE TOP
                </span>
              );
            if (st === "DOUBLE_BOTTOM")
              return (
                <span className="mt-1 px-3 py-0.5 text-[10px] font-bold tracking-widest rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  ⫠ DOUBLE BOTTOM
                </span>
              );
            if (st === "BB_REJECTION")
              return (
                <span className="mt-1 px-3 py-0.5 text-[10px] font-bold tracking-widest rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/40">
                  ⊛ BB REJECTION
                </span>
              );
            // Default: FIB50_SWING
            return (
              <span className="mt-1 px-3 py-0.5 text-[10px] font-bold tracking-widest rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                ◈ FIB50 SWING
              </span>
            );
          })()}
          {data.detectedPattern && (
            <span className={[
              "mt-1 px-2 py-0.5 text-[9px] font-bold tracking-widest rounded-full border",
              data.patternConfirmed
                ? data.patternDirection === "bearish"
                  ? "bg-rose-950/70 text-rose-300 border-rose-700/50"
                  : "bg-emerald-950/70 text-emerald-300 border-emerald-700/50"
                : "bg-zinc-800/60 text-zinc-400 border-zinc-600/40",
            ].join(" ")}>
              {data.patternConfirmed
                ? data.patternDirection === "bearish" ? "⚠ " : "✓ "
                : "◌ "}
              {{
                HEAD_AND_SHOULDERS:          "H&S",
                INVERSE_HEAD_AND_SHOULDERS:  "Inv H&S",
                DOUBLE_TOP:                  "Double Top",
                DOUBLE_BOTTOM:               "Double Bottom",
                ASCENDING_TRIANGLE:          "Asc Triangle",
                DESCENDING_TRIANGLE:         "Desc Triangle",
                SYMMETRICAL_TRIANGLE:        "Sym Triangle",
                RISING_WEDGE:                "Rising Wedge",
                FALLING_WEDGE:               "Falling Wedge",
                BULL_FLAG:                   "Bull Flag",
                BEAR_FLAG:                   "Bear Flag",
                BULL_PENNANT:                "Bull Pennant",
                BEAR_PENNANT:                "Bear Pennant",
                BULLISH_ENGULFING:           "Bull Engulf",
                BEARISH_ENGULFING:           "Bear Engulf",
                HAMMER:                      "Hammer",
                SHOOTING_STAR:               "Shooting Star",
              }[data.detectedPattern] ?? data.detectedPattern}
              {data.patternConfirmed ? " (confirmed)" : " (forming)"}
            </span>
          )}
          {poorWinRate && btData && (
            <div className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-950/60 border border-rose-700/50 text-rose-300 text-[10px] font-mono font-semibold tracking-wide">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              Poor historical win rate ({btData.winRate.toFixed(1)}% over {btData.totalTrades} trades) — low edge setup
            </div>
          )}
          <p className="mt-2 text-sm font-medium leading-snug max-w-xs bg-black/20 rounded-lg px-3 py-2">
            {data.signalReason}
          </p>
          <ChevronDown className="mt-2 w-4 h-4 text-white/30 rotate-180" />
        </div>
      )}

      {expanded && <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-4 space-y-5">

          {/* ── 2. Price bar ────────────────────────────────────────────── */}
          <div className="flex items-baseline justify-between bg-zinc-900/60 rounded-lg px-4 py-3 border border-zinc-800/50">
            <div>
              <div className="text-[10px] text-zinc-500 font-sans font-semibold tracking-widest mb-0.5">
                {meta.short}
              </div>
              <div className="text-3xl font-bold tracking-tight">
                {fmtPriceMeta(meta, data.currentPrice)}
              </div>
            </div>
            <div className={cn("text-right", isPositive ? "text-[#00c950]" : "text-[#e53e3e]")}>
              <div className="text-lg font-bold flex items-center justify-end gap-1">
                {isPositive ? "+" : ""}
                {data.priceChange.toFixed(meta.decimals)}
                {isPositive
                  ? <TrendingUp className="w-4 h-4" />
                  : <TrendingDown className="w-4 h-4" />}
              </div>
              <div className="text-sm font-semibold opacity-90">
                {isPositive ? "+" : ""}
                {data.priceChangePct.toFixed(2)}%
              </div>
            </div>
          </div>

          {/* ── 3+4. Trade Ticket + Zone Watch (side-by-side) ───────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
            {/* Trade Ticket */}
            <div className="min-w-0">
              <div className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold mb-2 flex items-center gap-2">
                <span className={cn("w-1.5 h-1.5 rounded-full inline-block", data.signal === "WAIT" ? "bg-amber-500/60" : "bg-zinc-600")} />
                {data.signal === "WAIT" ? "NEXT SETUP" : "TRADE TICKET"}
                {data.signal !== "WAIT" && (
                  <span
                    className={cn(
                      "ml-auto text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded",
                      data.signal === "BUY"
                        ? "bg-emerald-500/30 text-emerald-300 animate-pulse"
                        : "bg-red-500/30 text-red-300 animate-pulse",
                    )}
                  >
                    LIVE
                  </span>
                )}
                {data.signal === "WAIT" && (
                  <span className="ml-auto text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
                    WATCHING
                  </span>
                )}
              </div>
              <div
                className={cn(
                  "rounded-lg overflow-hidden border divide-y divide-zinc-800/60 bg-[#111] transition-all",
                  data.signal === "BUY"
                    ? "border-emerald-400/80 bg-emerald-950/20 shadow-[0_0_24px_rgba(0,201,80,0.45)] ring-1 ring-emerald-400/40"
                    : data.signal === "SELL"
                      ? "border-red-400/80 bg-red-950/20 shadow-[0_0_24px_rgba(229,62,62,0.45)] ring-1 ring-red-400/40"
                      : "border-zinc-800",
                )}
              >
                {data.signal === "WAIT" && (() => {
                  const pendingDir = data.stopLoss > data.entryPrice ? "SELL" : "BUY";
                  return (
                    <div className="flex justify-between items-center px-3 py-2 bg-zinc-950/60">
                      <span className="text-[9px] font-sans font-semibold tracking-widest text-zinc-500">DIRECTION</span>
                      <span className={cn(
                        "text-[10px] font-bold tracking-widest px-2 py-0.5 rounded",
                        pendingDir === "BUY"
                          ? "bg-emerald-500/20 text-emerald-400"
                          : "bg-red-500/20 text-red-400"
                      )}>
                        {pendingDir === "BUY" ? "▲ BUY on dip" : "▼ SELL on rally"}
                      </span>
                    </div>
                  );
                })()}
                <Row label="Entry" value={fmtPriceMeta(meta, data.entryPrice)} />
                {data.dca1 != null && (
                  <TradeRow
                    label="DCA"
                    value={fmtPriceMeta(meta, data.dca1)}
                    pnl={null}
                    rMultiple={null}
                    valueClass="text-[#f59e0b]"
                    labelClass="text-[#f59e0b]"
                    bg="bg-amber-950/10"
                  />
                )}
                <TradeRow
                  label="Stop Loss"
                  value={fmtPriceMeta(meta, data.stopLoss)}
                  pnl={pnls?.pnlAtSL ?? null}
                  rMultiple={-1}
                  valueClass="text-[#e53e3e]"
                  labelClass="text-[#e53e3e]"
                  bg="bg-red-950/10"
                />
                <TradeRow
                  label="Take Profit 1"
                  value={fmtPriceMeta(meta, data.takeProfit1)}
                  pnl={pnls?.pnlAtTP1 ?? null}
                  rMultiple={computeR(data.entryPrice, data.stopLoss, data.takeProfit1)}
                  valueClass="text-[#4ade80]"
                  labelClass="text-[#4ade80]"
                  bg="bg-emerald-950/10"
                />
                <TradeRow
                  label="Take Profit 2"
                  value={fmtPriceMeta(meta, data.takeProfit2)}
                  pnl={pnls?.pnlAtTP2 ?? null}
                  rMultiple={computeR(data.entryPrice, data.stopLoss, data.takeProfit2)}
                  valueClass="text-[#86efac]"
                  labelClass="text-[#86efac]"
                  bg="bg-emerald-900/10"
                />
                <div className="flex justify-between items-center px-3 py-2.5 bg-zinc-950 gap-2">
                  <span className="text-[9px] font-sans font-semibold tracking-widest text-zinc-500">
                    R / R
                  </span>
                  <span className="font-bold text-white text-base">
                    1:{data.riskRewardRatio.toFixed(1)}
                  </span>
                </div>
              </div>
            </div>

            {/* Zone Watch */}
            <div className="min-w-0">
              {(() => {
                // FIB50_SWING always displays the entry zones (50% fib ± tolerance).
                const isBreakout = false;
                const isBuyBreakout = false;
                const isSellBreakout = false;
                const longZoneLabel = `${fmtPriceCompactMeta(meta, data.buyZone.low, 1)}–${fmtPriceCompactMeta(meta, data.buyZone.high, 1)}`;
                const shortZoneLabel = `${fmtPriceCompactMeta(meta, data.sellZone.low, 1)}–${fmtPriceCompactMeta(meta, data.sellZone.high, 1)}`;
                const longZoneLow  = data.buyZone.low;
                const longZoneHigh = data.buyZone.high;
                const shortZoneLow  = data.sellZone.low;
                const shortZoneHigh = data.sellZone.high;
                return (
                  <>
                    <div className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold mb-2 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
                      ZONE WATCH
                    </div>
                    <div className="rounded-lg overflow-hidden border border-zinc-800 divide-y divide-zinc-800/60 bg-[#111]">
                      <ZoneRow
                        symbol={symbol}
                        side="LONG"
                        sideLabel={isBuyBreakout ? "SUPPORT (was R2)" : isSellBreakout ? "SUPPORT (S3)" : undefined}
                        zoneLabel={longZoneLabel}
                        price={data.currentPrice}
                        zoneLow={longZoneLow}
                        zoneHigh={longZoneHigh}
                        isActive={data.signal === "BUY"}
                      />
                      <ZoneRow
                        symbol={symbol}
                        side="SHORT"
                        sideLabel={isBuyBreakout ? "RESISTANCE (R3)" : isSellBreakout ? "RESISTANCE (was S2)" : undefined}
                        zoneLabel={shortZoneLabel}
                        price={data.currentPrice}
                        zoneLow={shortZoneLow}
                        zoneHigh={shortZoneHigh}
                        isActive={data.signal === "SELL"}
                      />
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* ── 4.5. Position Size ──────────────────────────────────────── */}
          {data.positionSizing && (
            <div>
              <div className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold mb-2 flex items-center gap-2 flex-wrap">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
                POSITION SIZE
                <div className="ml-auto flex items-center gap-1.5 text-[10px] text-zinc-400 font-sans font-normal tracking-normal flex-wrap justify-end">
                  <Settings className="w-3 h-3 text-zinc-600" />
                  <span>$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={accountSizeText}
                    onChange={(e) => {
                      const text = e.target.value;
                      setAccountSizeText(text);
                      const v = Number(text);
                      if (Number.isFinite(v) && v > 0) setAccountSize(v);
                    }}
                    onBlur={() => setAccountSizeText(String(accountSize))}
                    className="w-16 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-right tabular-nums text-zinc-100 focus:outline-none focus:border-amber-500/60"
                    aria-label="Account size in USD"
                  />
                  {isMT5 ? (
                    <>
                      {/* MT5 venue: only the lot size matters — risk %, min collateral
                          and max leverage are PHEMEX-specific concepts. */}
                      <span className="text-zinc-700 ml-1">|</span>
                      <span title="MT5 lot size (0.01 = 1 micro lot)">lots</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={mt5LotsText}
                        onChange={(e) => {
                          const text = e.target.value;
                          setMt5LotsText(text);
                          const v = Number(text);
                          if (Number.isFinite(v) && v >= 0.01 && v <= 100) {
                            setMt5Lots(v);
                          }
                        }}
                        onBlur={() => {
                          // On blur, snap the visible buffer back to the
                          // last accepted numeric value so partial typing
                          // ("0." / "0.0" / "") doesn't linger in the UI.
                          setMt5LotsText(String(mt5Lots));
                        }}
                        className="w-14 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-right tabular-nums text-zinc-100 focus:outline-none focus:border-amber-500/60"
                        aria-label="MT5 lot size"
                        data-testid="mt5-lots-input"
                      />
                      {data.positionSizing?.mt5 &&
                        data.positionSizing.mt5.recommendedLots !== mt5Lots && (
                          <button
                            type="button"
                            onClick={() => {
                              const v = data.positionSizing!.mt5!.recommendedLots;
                              setMt5Lots(v);
                              setMt5LotsText(String(v));
                            }}
                            className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/25 transition-colors"
                            title={`Auto-size to risk ${data.positionSizing.mt5.recommendedTargetRiskPct}% of $${data.positionSizing.accountSize} = ${data.positionSizing.mt5.recommendedLots} lots`}
                            data-testid="mt5-lots-apply-recommended"
                          >
                            ≈ {data.positionSizing.mt5.recommendedLots} for{" "}
                            {data.positionSizing.mt5.recommendedTargetRiskPct}%
                          </button>
                        )}
                    </>
                  ) : isCoinbaseSpot ? (
                    <>
                      {/* Spot venue: only risk % matters — no leverage, no lots. */}
                      <span className="text-zinc-600">·</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={riskPctText}
                        onChange={(e) => {
                          const text = e.target.value;
                          setRiskPctText(text);
                          const v = Number(text);
                          if (Number.isFinite(v) && v > 0) setRiskPct(v);
                        }}
                        onBlur={() => setRiskPctText(String(riskPct))}
                        className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-right tabular-nums text-zinc-100 focus:outline-none focus:border-amber-500/60"
                        aria-label="Risk percent of account"
                      />
                      <span>% risk</span>
                    </>
                  ) : (
                    <>
                      <span className="text-zinc-600">·</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={riskPctText}
                        onChange={(e) => {
                          const text = e.target.value;
                          setRiskPctText(text);
                          const v = Number(text);
                          if (Number.isFinite(v) && v > 0) setRiskPct(v);
                        }}
                        onBlur={() => setRiskPctText(String(riskPct))}
                        className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-right tabular-nums text-zinc-100 focus:outline-none focus:border-amber-500/60"
                        aria-label="Risk percent of account"
                      />
                      <span>% risk</span>
                      <span className="text-zinc-700 ml-1">|</span>
                      {/* Phemex has no $-collateral floor — the binding minimum
                          is the contract qty (0.001 BTC, 0.01 ETH), enforced
                          server-side. So we drop the "min $" knob and just
                          show the leverage cap. Collateral is whatever the
                          notional / maxLev produces. */}
                      <span title="Max leverage you'll use">max</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={1}
                        max={200}
                        step={1}
                        value={maxLeverageText}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setMaxLeverageText(raw);
                          const v = Number(raw);
                          if (Number.isFinite(v) && v >= 1) setMaxLeverage(Math.round(v));
                        }}
                        onBlur={() => setMaxLeverageText(String(maxLeverage))}
                        className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-right tabular-nums text-zinc-100 focus:outline-none focus:border-amber-500/60"
                        aria-label="Max leverage"
                      />
                      <span>x lev</span>
                    </>
                  )}
                </div>
              </div>
              <div className="rounded-lg overflow-hidden border border-zinc-800 divide-y divide-zinc-800/60 bg-[#111]">
                <div className="flex justify-between items-center px-3 py-2.5 gap-2 min-w-0 bg-amber-950/10">
                  <span className="text-xs text-amber-400/80 flex items-center gap-1.5 truncate">
                    <Wallet className="w-3 h-3 shrink-0" />
                    Risk per trade
                  </span>
                  <span className="font-bold text-sm tabular-nums shrink-0 text-amber-300">
                    {isMT5 && data.positionSizing.mt5
                      ? `$${Math.abs(data.positionSizing.mt5.pnlAtSL).toFixed(2)} (${data.positionSizing.mt5.riskPctOfAccount.toFixed(2)}% acct)`
                      : isCoinbaseSpot && data.positionSizing.spotToken
                        ? `$${data.positionSizing.spotToken.riskAmount.toFixed(2)} (${data.positionSizing.spotToken.riskPct.toFixed(2)}% acct)`
                        : `$${data.positionSizing.riskAmount.toFixed(2)}`}
                  </span>
                </div>
                {isMT5 && data.positionSizing.mt5 ? (
                  <>
                    {/* MT5: show the contract sizing the trader actually places.
                        Notional / position size derive from chosen lots, not a
                        risk budget — riskPct is a PHEMEX concept here. */}
                    <Row
                      label="Position size"
                      value={`${formatPositionSize(data.positionSizing.mt5.positionSize, data.positionSizing.positionSizeUnit)} ${data.positionSizing.positionSizeUnit}`}
                      valueClass="text-zinc-100"
                    />
                    <Row
                      label="Notional value"
                      value={`$${formatNotional(data.positionSizing.mt5.notional)}`}
                      labelClass="text-zinc-500"
                    />
                    <Row
                      label="Contract size"
                      value={`1 lot = ${data.positionSizing.mt5.contractSize.toLocaleString()} ${data.positionSizing.positionSizeUnit}`}
                      labelClass="text-zinc-500"
                    />
                  </>
                ) : isCoinbaseSpot && data.positionSizing.spotToken ? (
                  <>
                    {/* Coinbase spot: whole-token count, notional, no leverage */}
                    <Row
                      label="Buy"
                      value={`${data.positionSizing.spotToken.tokenCount.toLocaleString()} ${data.positionSizing.spotToken.tokenSymbol}`}
                      valueClass="text-zinc-100 font-bold"
                    />
                    <Row
                      label="Notional value"
                      value={`$${formatNotional(data.positionSizing.spotToken.notional)}`}
                      labelClass="text-zinc-500"
                    />
                  </>
                ) : (
                  <>
                    <Row
                      label="Position size"
                      value={`${formatPositionSize(data.positionSizing.positionSize, data.positionSizing.positionSizeUnit)} ${data.positionSizing.positionSizeUnit}`}
                      valueClass="text-zinc-100"
                    />
                    <Row
                      label="Notional value"
                      value={`$${formatNotional(data.positionSizing.notional)}`}
                      labelClass="text-zinc-500"
                    />
                    {data.positionSizing.leverage !== undefined && (
                      <div className="flex flex-col gap-1 px-3 py-2.5 bg-zinc-950/60">
                        <div className="flex justify-between items-center gap-2">
                          <span className="text-xs text-zinc-400">Min leverage</span>
                          <span
                            className={cn(
                              "font-bold text-base tabular-nums shrink-0",
                              data.positionSizing.leverage > 15
                                ? "text-red-400"
                                : data.positionSizing.leverage > 10
                                  ? "text-amber-400"
                                  : "text-emerald-400",
                            )}
                          >
                            {data.positionSizing.leverage}x
                          </span>
                        </div>
                        {data.positionSizing.leverageNote && (
                          <p className="text-[10px] text-zinc-500 leading-snug">
                            {data.positionSizing.leverageNote}
                          </p>
                        )}
                      </div>
                    )}
                    {data.positionSizing.lots && (
                      <div className="flex flex-col gap-1 px-3 py-2.5 bg-zinc-950/60">
                        <span className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold">
                          LOTS
                        </span>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <LotCell label="Standard" value={data.positionSizing.lots.standard} />
                          <LotCell label="Mini" value={data.positionSizing.lots.mini} />
                          <LotCell label="Micro" value={data.positionSizing.lots.micro} />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* ── Risk oversize warning ────────────────────────────────── */}
              {isMT5 && data.positionSizing.mt5 &&
                data.positionSizing.mt5.riskPctOfAccount > 5 && (
                <div className="mt-2 rounded-lg border border-red-500/50 bg-red-950/40 px-3 py-2.5 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-red-300 leading-snug">
                    <span className="font-bold text-red-200">Oversized: </span>
                    {data.positionSizing.mt5.riskPctOfAccount.toFixed(1)}% of account at risk
                    per trade — professional max is 1–2%. Use the{" "}
                    <span className="font-bold text-amber-300">
                      ≈ {data.positionSizing.mt5.recommendedLots} lots
                    </span>{" "}
                    button above to auto-size correctly.
                  </div>
                </div>
              )}

              {/* ── EXACT EXCHANGE SETUP ─────────────────────────────────── */}
              {/* Two parallel renderings: PHEMEX (BTC/ETH) shows COLLATERAL/LEVERAGE/POSITION,
                  MT5 (forex/metals) shows LOTS/POSITION/NOTIONAL. The IF SL/TP1/TP2
                  P&L row is identical in shape but always sources from the venue's
                  projection block (mt5 vs achievable) so the dollars never lie about
                  which exchange they came from. */}
              {isMT5 && data.positionSizing.mt5 ? (
                <div className="mt-3 rounded-lg overflow-hidden border-2 border-amber-500/40 bg-gradient-to-br from-amber-950/20 to-zinc-900">
                  <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2">
                    <span className="text-[10px] text-amber-300 font-sans font-bold tracking-widest">
                      EXACT TRADE TO PLACE · MT5
                    </span>
                    <span className="ml-auto text-[9px] text-zinc-500 font-mono">
                      {meta.short}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-px bg-zinc-800 text-center">
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        LOTS
                      </div>
                      <div className="text-base font-bold text-amber-200 tabular-nums mt-0.5">
                        {data.positionSizing.mt5.lots.toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        POSITION
                      </div>
                      <div className="text-base font-bold text-amber-200 tabular-nums mt-0.5 truncate">
                        {formatPositionSize(data.positionSizing.mt5.positionSize, data.positionSizing.positionSizeUnit)}
                      </div>
                    </div>
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        NOTIONAL
                      </div>
                      <div className="text-base font-bold text-amber-200 tabular-nums mt-0.5 truncate">
                        ${formatNotional(data.positionSizing.mt5.notional)}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-px bg-zinc-800 text-center border-t border-zinc-800">
                    <div className="bg-red-950/20 px-2 py-2">
                      <div className="text-[8px] text-red-400/70 font-sans font-semibold tracking-widest">
                        IF SL HIT
                      </div>
                      <div className="text-sm font-bold text-red-300 tabular-nums mt-0.5">
                        −${Math.abs(data.positionSizing.mt5.pnlAtSL).toFixed(2)}
                      </div>
                      <div className="text-[8px] text-red-400/60 mt-0.5">
                        −{data.positionSizing.mt5.riskPctOfAccount.toFixed(2)}% acct
                      </div>
                    </div>
                    <div className="bg-emerald-950/20 px-2 py-2">
                      <div className="text-[8px] text-emerald-400/70 font-sans font-semibold tracking-widest">
                        IF TP1 HIT
                      </div>
                      <div className="text-sm font-bold text-emerald-300 tabular-nums mt-0.5">
                        +${data.positionSizing.mt5.pnlAtTP1.toFixed(2)}
                      </div>
                      <div className="text-[8px] text-emerald-400/60 mt-0.5">
                        +{((data.positionSizing.mt5.pnlAtTP1 / data.positionSizing.accountSize) * 100).toFixed(2)}% acct
                      </div>
                    </div>
                    <div className="bg-emerald-900/30 px-2 py-2">
                      <div className="text-[8px] text-emerald-300/80 font-sans font-semibold tracking-widest">
                        IF TP2 HIT
                      </div>
                      <div className="text-sm font-bold text-emerald-200 tabular-nums mt-0.5">
                        +${data.positionSizing.mt5.pnlAtTP2.toFixed(2)}
                      </div>
                      <div className="text-[8px] text-emerald-300/70 mt-0.5">
                        +{((data.positionSizing.mt5.pnlAtTP2 / data.positionSizing.accountSize) * 100).toFixed(2)}% acct
                      </div>
                    </div>
                  </div>
                </div>
              ) : data.positionSizing.achievable ? (
                <div className="mt-3 rounded-lg overflow-hidden border-2 border-amber-500/40 bg-gradient-to-br from-amber-950/20 to-zinc-900">
                  <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2">
                    <span className="text-[10px] text-amber-300 font-sans font-bold tracking-widest">
                      EXACT TRADE TO PLACE · PHEMEX
                    </span>
                    {data.positionSizing.achievable.belowMinimum && (
                      <span className="ml-auto text-[9px] text-amber-400 font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40">
                        OVER-SIZED
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-px bg-zinc-800 text-center">
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        MARGIN
                      </div>
                      <div className="text-base font-bold text-amber-200 tabular-nums mt-0.5">
                        ${data.positionSizing.achievable.collateral.toFixed(2)}
                      </div>
                      <div className="text-[8px] text-zinc-600 mt-0.5">locked on exch</div>
                    </div>
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        LEVERAGE
                      </div>
                      <div className="text-base font-bold text-amber-200 tabular-nums mt-0.5">
                        {data.positionSizing.achievable.leverage.toFixed(1)}x
                      </div>
                    </div>
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        POSITION
                      </div>
                      <div className="text-base font-bold text-amber-200 tabular-nums mt-0.5 truncate">
                        {formatPositionSize(data.positionSizing.achievable.positionSize, data.positionSizing.positionSizeUnit)}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-px bg-zinc-800 text-center border-t border-zinc-800">
                    <div className="bg-red-950/20 px-2 py-2">
                      <div className="text-[8px] text-red-400/70 font-sans font-semibold tracking-widest">
                        IF SL HIT
                      </div>
                      <div className="text-sm font-bold text-red-300 tabular-nums mt-0.5">
                        −${Math.abs(data.positionSizing.achievable.pnlAtSL).toFixed(2)}
                      </div>
                      <div className="text-[8px] text-red-400/60 mt-0.5">
                        −{data.positionSizing.achievable.actualRiskPct.toFixed(2)}% acct
                      </div>
                    </div>
                    <div className="bg-emerald-950/20 px-2 py-2">
                      <div className="text-[8px] text-emerald-400/70 font-sans font-semibold tracking-widest">
                        IF TP1 HIT
                      </div>
                      <div className="text-sm font-bold text-emerald-300 tabular-nums mt-0.5">
                        +${data.positionSizing.achievable.pnlAtTP1.toFixed(2)}
                      </div>
                      <div className="text-[8px] text-emerald-400/60 mt-0.5">
                        +{((data.positionSizing.achievable.pnlAtTP1 / data.positionSizing.accountSize) * 100).toFixed(2)}% acct
                      </div>
                    </div>
                    <div className="bg-emerald-900/30 px-2 py-2">
                      <div className="text-[8px] text-emerald-300/80 font-sans font-semibold tracking-widest">
                        IF TP2 HIT
                      </div>
                      <div className="text-sm font-bold text-emerald-200 tabular-nums mt-0.5">
                        +${data.positionSizing.achievable.pnlAtTP2.toFixed(2)}
                      </div>
                      <div className="text-[8px] text-emerald-300/70 mt-0.5">
                        +{((data.positionSizing.achievable.pnlAtTP2 / data.positionSizing.accountSize) * 100).toFixed(2)}% acct
                      </div>
                    </div>
                  </div>
                  {data.positionSizing.achievable.warning && (
                    <div className="px-3 py-2 bg-amber-950/30 border-t border-amber-500/20">
                      <p className="text-[10px] text-amber-300/90 leading-snug">
                        ⚠ {data.positionSizing.achievable.warning}
                      </p>
                    </div>
                  )}
                </div>
              ) : isCoinbaseSpot && data.positionSizing.spotToken ? (
                <div className="mt-3 rounded-lg overflow-hidden border-2 border-sky-500/40 bg-gradient-to-br from-sky-950/20 to-zinc-900">
                  <div className="px-3 py-1.5 bg-sky-500/10 border-b border-sky-500/30 flex items-center gap-2">
                    <span className="text-[10px] text-sky-300 font-sans font-bold tracking-widest">
                      EXACT TRADE TO PLACE · PHEMEX
                    </span>
                    <span className="ml-auto text-[9px] text-zinc-500 font-mono">
                      {data.positionSizing.spotToken.tokenSymbol}/USDT · spot
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-px bg-zinc-800 text-center">
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        BUY
                      </div>
                      <div className="text-base font-bold text-sky-200 tabular-nums mt-0.5">
                        {data.positionSizing.spotToken.tokenCount.toLocaleString()} {data.positionSizing.spotToken.tokenSymbol}
                      </div>
                    </div>
                    <div className="bg-[#0a0a0a]/50 px-2 py-2">
                      <div className="text-[8px] text-zinc-500 font-sans font-semibold tracking-widest">
                        NOTIONAL
                      </div>
                      <div className="text-base font-bold text-sky-200 tabular-nums mt-0.5">
                        ${formatNotional(data.positionSizing.spotToken.notional)}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-px bg-zinc-800 text-center border-t border-zinc-800">
                    <div className="bg-red-950/20 px-2 py-2">
                      <div className="text-[8px] text-red-400/70 font-sans font-semibold tracking-widest">
                        IF SL HIT
                      </div>
                      <div className="text-sm font-bold text-red-300 tabular-nums mt-0.5">
                        −${Math.abs(data.positionSizing.spotToken.pnlAtSL).toFixed(2)}
                      </div>
                      <div className="text-[8px] text-red-400/60 mt-0.5">
                        −{data.positionSizing.spotToken.riskPct.toFixed(2)}% acct
                      </div>
                    </div>
                    <div className="bg-emerald-950/20 px-2 py-2">
                      <div className="text-[8px] text-emerald-400/70 font-sans font-semibold tracking-widest">
                        IF TP1 HIT
                      </div>
                      <div className="text-sm font-bold text-emerald-300 tabular-nums mt-0.5">
                        +${data.positionSizing.spotToken.pnlAtTP1.toFixed(2)}
                      </div>
                      <div className="text-[8px] text-emerald-400/60 mt-0.5">
                        +{((data.positionSizing.spotToken.pnlAtTP1 / data.positionSizing.accountSize) * 100).toFixed(2)}% acct
                      </div>
                    </div>
                    <div className="bg-emerald-900/30 px-2 py-2">
                      <div className="text-[8px] text-emerald-300/80 font-sans font-semibold tracking-widest">
                        IF TP2 HIT
                      </div>
                      <div className="text-sm font-bold text-emerald-200 tabular-nums mt-0.5">
                        +${data.positionSizing.spotToken.pnlAtTP2.toFixed(2)}
                      </div>
                      <div className="text-[8px] text-emerald-300/70 mt-0.5">
                        +{((data.positionSizing.spotToken.pnlAtTP2 / data.positionSizing.accountSize) * 100).toFixed(2)}% acct
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* ── 4.5b. Risk-free runner (SL trailed to break-even, positionSizing unavailable) ── */}
          {!data.positionSizing && (data.tradeState === "FILLED_TP1" || data.tradeState === "FILLED_TP2") && (
            <div>
              <div className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold mb-2 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
                POSITION SIZE
              </div>
              <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-4 py-3 flex items-center gap-3">
                <span className="text-emerald-400 text-lg">🛡</span>
                <div>
                  <div className="text-[11px] font-semibold text-emerald-400 font-mono">Risk-free runner</div>
                  <div className="text-[10px] text-zinc-400 mt-0.5">
                    {data.tradeState === "FILLED_TP1" ? "TP1 hit — SL trailed to break-even." : "TP2 hit — position closed."}
                    {" "}No capital at risk. Let it run.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── 5. Market Structure ─────────────────────────────────────── */}
          <div>
            <div className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold mb-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
              MARKET STRUCTURE
            </div>
            <div className="rounded-lg overflow-hidden border border-zinc-800 bg-[#111] divide-y divide-zinc-800/60">
              {/* Trend row */}
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2">
                  {data.trend === "UPTREND" && <TrendingUp className="text-[#00c950] w-4 h-4" />}
                  {data.trend === "DOWNTREND" && <TrendingDown className="text-[#e53e3e] w-4 h-4" />}
                  {data.trend === "RANGING" && <ArrowRight className="text-amber-500 w-4 h-4" />}
                  <span className={cn(
                    "font-bold text-sm tracking-wider",
                    data.trend === "UPTREND" ? "text-[#00c950]" :
                    data.trend === "DOWNTREND" ? "text-[#e53e3e]" : "text-amber-500"
                  )}>
                    {data.trend}
                  </span>
                </div>
                <div className="flex items-center gap-2 w-28">
                  <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-500",
                        data.trend === "UPTREND" ? "bg-[#00c950]" :
                        data.trend === "DOWNTREND" ? "bg-[#e53e3e]" : "bg-amber-500"
                      )}
                      style={{ width: `${data.trendStrength}%` }}
                    />
                  </div>
                  <span className="text-xs font-bold text-zinc-400 w-5 text-right">
                    {data.trendStrength}
                  </span>
                </div>
              </div>

              {/* RSI-14 row */}
              {data.rsi != null && (() => {
                const rsiVal = data.rsi!;
                const rsiZone =
                  rsiVal <= 30 ? "OVERSOLD"
                  : rsiVal <= 40 ? "BUY ZONE"
                  : rsiVal >= 70 ? "OVERBOUGHT"
                  : rsiVal >= 60 ? "SELL ZONE"
                  : "NEUTRAL";
                const rsiColor =
                  rsiVal <= 40 ? "#00c950"
                  : rsiVal >= 60 ? "#e53e3e"
                  : "#a1a1aa";
                const rsiBarColor =
                  rsiVal <= 40 ? "bg-[#00c950]"
                  : rsiVal >= 60 ? "bg-[#e53e3e]"
                  : "bg-zinc-500";
                return (
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-sans font-semibold text-zinc-400">RSI-14</span>
                      <span
                        className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded"
                        style={{ color: rsiColor, backgroundColor: `${rsiColor}18` }}
                      >
                        {rsiZone}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 w-28">
                      <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all duration-500", rsiBarColor)}
                          style={{ width: `${rsiVal}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold w-7 text-right tabular-nums" style={{ color: rsiColor }}>
                        {rsiVal.toFixed(1)}
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* ADX-14 row */}
              {data.adx != null && (() => {
                const adxVal = data.adx!;
                const adxLabel = adxVal < 25 ? "RANGING" : adxVal < 50 ? "TRENDING" : "STRONG";
                const adxColor = adxVal < 25 ? "#f59e0b" : adxVal < 50 ? "#e53e3e" : "#ff2244";
                const adxBarColor = adxVal < 25 ? "bg-amber-500" : adxVal < 50 ? "bg-[#e53e3e]" : "bg-[#ff2244]";
                return (
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-sans font-semibold text-zinc-400">ADX-14</span>
                      <span
                        className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded"
                        style={{ color: adxColor, backgroundColor: `${adxColor}18` }}
                      >
                        {adxLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 w-28">
                      <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all duration-500", adxBarColor)}
                          style={{ width: `${Math.min(adxVal, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold w-7 text-right tabular-nums" style={{ color: adxColor }}>
                        {adxVal.toFixed(1)}
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Choppiness Index row */}
              {data.choppiness != null && (() => {
                const ci = data.choppiness!;
                const ciLabel = ci > 61.8 ? "THICK" : ci > 38.2 ? "MIXED" : "THIN";
                // Thick (>61.8) = ranging = green (good for pivot). Thin (<38.2) = directional = red.
                const ciColor = ci > 61.8 ? "#00c950" : ci > 38.2 ? "#f59e0b" : "#e53e3e";
                const ciBarColor = ci > 61.8 ? "bg-[#00c950]" : ci > 38.2 ? "bg-amber-500" : "bg-[#e53e3e]";
                return (
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-sans font-semibold text-zinc-400">CHOPPINESS</span>
                      <span
                        className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded"
                        style={{ color: ciColor, backgroundColor: `${ciColor}18` }}
                      >
                        {ciLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 w-28">
                      <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all duration-500", ciBarColor)}
                          style={{ width: `${ci}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold w-7 text-right tabular-nums" style={{ color: ciColor }}>
                        {ci.toFixed(1)}
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Swing Rhythm row */}
              {data.swingRhythm != null && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-xs font-sans font-semibold text-zinc-400">RHYTHM</span>
                  <div className="flex items-center gap-3 text-xs tabular-nums">
                    <span className="text-zinc-300 font-bold">
                      {data.swingRhythm.avgBarsPerSwing}
                      <span className="text-zinc-500 font-normal ml-0.5">bars</span>
                    </span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-zinc-300 font-bold">
                      {data.swingRhythm.avgPricePerSwing}
                      <span className="text-zinc-500 font-normal ml-0.5">×ATR</span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>}

      {/* ── Footer: last updated + refresh ──────────────────────────────── */}
      <div className="px-4 py-2.5 border-t border-zinc-800 bg-[#060606] flex items-center justify-between text-xs text-zinc-500 shrink-0">
        <div className="flex items-center gap-2 font-sans">
          <span className={cn(
            "w-2 h-2 rounded-full",
            isFetching ? "bg-zinc-500" : "bg-[#00c950] shadow-[0_0_6px_rgba(0,201,80,0.5)]"
          )} />
          {format(lastRefreshed, "HH:mm:ss")}
        </div>
        <button
          onClick={handleRefresh}
          disabled={isFetching}
          className="flex items-center gap-1.5 hover:text-zinc-300 transition-colors disabled:opacity-40 font-sans font-medium px-2 py-1 rounded hover:bg-white/5"
        >
          <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  labelClass = "text-zinc-400",
  valueClass = "text-zinc-100",
  bg = "",
}: {
  label: string;
  value: string;
  labelClass?: string;
  valueClass?: string;
  bg?: string;
}) {
  return (
    <div className={cn("flex justify-between items-center px-3 py-2.5 gap-2 min-w-0", bg)}>
      <span className={cn("text-xs truncate", labelClass)}>{label}</span>
      <span className={cn("font-bold text-sm tabular-nums shrink-0", valueClass)}>{value}</span>
    </div>
  );
}

function TradeRow({
  label,
  value,
  pnl,
  rMultiple,
  labelClass = "text-zinc-400",
  valueClass = "text-zinc-100",
  bg = "",
}: {
  label: string;
  value: string;
  pnl: number | null;
  rMultiple: number | null;
  labelClass?: string;
  valueClass?: string;
  bg?: string;
}) {
  const isLoss = pnl !== null && pnl < 0;
  const pnlText =
    pnl === null
      ? null
      : `${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`;
  const rText = rMultiple != null ? `${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(1)}R` : null;
  return (
    <div className={cn("flex justify-between items-center px-3 py-2 gap-2 min-w-0", bg)}>
      <span className={cn("text-xs truncate shrink-0", labelClass)}>{label}</span>
      <div className="flex flex-col items-end shrink-0 leading-tight">
        <span className={cn("font-bold text-sm tabular-nums", valueClass)}>{value}</span>
        {pnlText && (
          <span
            className={cn(
              "tabular-nums text-[11px] font-semibold whitespace-nowrap mt-0.5",
              isLoss ? "text-red-300" : "text-emerald-300",
            )}
          >
            {pnlText}
            <span className="ml-1 text-[9px] opacity-70 font-normal">
              {rText}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function computeR(entry: number, stopLoss: number, target: number): number {
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return 0;
  // Sign reflects whether target is in the trade's favour. Floor enforcement
  // already guarantees positive for TP1/TP2; SL passes -1 directly.
  const dir = target >= entry ? 1 : -1;
  return (dir * Math.abs(target - entry)) / risk;
}

function LotCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5 bg-[#0a0a0a]/50 rounded px-1.5 py-1.5 border border-zinc-800/60">
      <span className="text-[8px] tracking-widest text-zinc-500 font-sans font-semibold">
        {label}
      </span>
      <span className="text-xs font-bold text-zinc-200 tabular-nums">
        {value < 0.001 ? value.toExponential(1) : value.toFixed(value < 1 ? 3 : 2)}
      </span>
    </div>
  );
}

function formatPositionSize(size: number, unit: string): string {
  if (unit === "BTC" || unit === "ETH") {
    return size.toFixed(size < 0.01 ? 6 : 4);
  }
  if (unit === "oz") {
    return size.toFixed(size < 10 ? 2 : 1);
  }
  // Small fractional sizes are crypto coins (e.g. ZEC at 0.15) — show decimals.
  // Large sizes are forex base-currency notional (e.g. 100,000 EUR) — show as integer.
  if (size < 1) return size.toFixed(4);
  if (size < 100) return size.toFixed(2);
  return Math.round(size).toLocaleString("en-US");
}

function formatNotional(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toFixed(2);
}

function ZoneRow({
  symbol,
  side,
  sideLabel,
  zoneLabel,
  price,
  zoneLow,
  zoneHigh,
  isActive,
}: {
  symbol: string;
  side: "LONG" | "SHORT";
  sideLabel?: string;
  zoneLabel: string;
  price: number;
  zoneLow: number;
  zoneHigh: number;
  isActive: boolean;
}) {
  const isLong = side === "LONG";
  const sideColor = isLong ? "text-[#00c950]" : "text-[#e53e3e]";
  const sideBg = isLong ? "bg-emerald-950/20" : "bg-red-950/20";

  // Compute distance + status
  const inZone = price >= zoneLow && price <= zoneHigh;
  let distance: number;
  let status: string;
  if (inZone) {
    distance = 0;
    status = "IN ZONE";
  } else if (isLong) {
    distance = price - zoneHigh;
    const zm = getSymbolMeta(symbol);
    status = distance > 0
      ? `${fmtPriceCompactMeta(zm, distance, 1)} above`
      : `${fmtPriceCompactMeta(zm, Math.abs(distance), 1)} below`;
  } else {
    const zm = getSymbolMeta(symbol);
    distance = zoneLow - price;
    status = distance > 0
      ? `${fmtPriceCompactMeta(zm, distance, 1)} below`
      : `${fmtPriceCompactMeta(zm, Math.abs(distance), 1)} above`;
  }

  const glow = isActive || inZone;
  const glowShadow = isLong
    ? "shadow-[inset_0_0_18px_rgba(0,201,80,0.45)] ring-1 ring-emerald-400/40"
    : "shadow-[inset_0_0_18px_rgba(229,62,62,0.45)] ring-1 ring-red-400/40";

  return (
    <div
      className={cn(
        "px-3 py-2.5 flex flex-col gap-1 min-w-0 transition-all",
        glow ? `${sideBg} ${glowShadow}` : "",
      )}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {isLong ? (
            <TrendingUp className={cn("w-3 h-3 shrink-0", sideColor)} />
          ) : (
            <TrendingDown className={cn("w-3 h-3 shrink-0", sideColor)} />
          )}
          <span className={cn("text-[11px] font-bold tracking-wider", sideColor)}>
            {sideLabel ?? side}
          </span>
          {isActive && (
            <span
              className={cn(
                "text-[8px] font-bold tracking-widest px-1 py-0.5 rounded shrink-0",
                isLong
                  ? "bg-emerald-500/30 text-emerald-300"
                  : "bg-red-500/30 text-red-300",
              )}
            >
              ACTIVE
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-[10px] font-bold text-zinc-100 tabular-nums truncate">
          {zoneLabel}
        </span>
        <span
          className={cn(
            "text-[10px] tabular-nums shrink-0",
            inZone ? sideColor : "text-zinc-500",
          )}
        >
          {inZone ? "● IN" : status}
        </span>
      </div>
    </div>
  );
}
