import { useEffect, useState } from "react";
import { useGetLevels } from "@workspace/api-client-react";
import { format } from "date-fns";
import { RefreshCw, TrendingUp, TrendingDown, ArrowRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Timeframe } from "@/components/timeframe-selector";

const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "1m": "1m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "1d": "Daily",
};

export function SignalPanel({ timeframe }: { timeframe: Timeframe }) {
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const { data, isLoading, isError, error, refetch, isFetching } = useGetLevels(
    { timeframe },
    { query: { refetchInterval: 60000 } },
  );

  const handleRefresh = async () => {
    await refetch();
    setLastRefreshed(new Date());
  };

  useEffect(() => {
    if (data?.lastUpdated) setLastRefreshed(new Date(data.lastUpdated));
  }, [data?.lastUpdated]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-[#0a0a0a] rounded-xl border border-zinc-800 p-5 animate-pulse space-y-4">
        <div className="h-36 bg-white/5 rounded-lg" />
        <div className="h-12 bg-white/5 rounded-lg" />
        <div className="h-48 bg-white/5 rounded-lg" />
        <div className="h-16 bg-white/5 rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0a0a0a] rounded-xl border border-red-500/20 p-6 text-center">
        <AlertTriangle className="w-8 h-8 text-red-500 mb-3" />
        <div className="text-red-500 mb-2 font-bold">Signal data unavailable</div>
        <p className="text-sm text-zinc-400 mb-6">
          {error?.message ?? "Connection to trading terminal lost."}
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

  const signalBg = data.signal === "BUY"
    ? "bg-[#00c950]"
    : data.signal === "SELL"
    ? "bg-[#e53e3e]"
    : "bg-[#b45309]";

  const signalTextColor = data.signal === "BUY" ? "text-black" : "text-white";

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] text-zinc-100 rounded-xl border border-zinc-800 overflow-hidden font-mono shadow-2xl">

      {/* ── 1. Signal Hero ─────────────────────────────────────────────── */}
      <div className={cn("px-5 py-5 flex flex-col items-center text-center shrink-0 relative", signalBg, signalTextColor)}>
        <span className="absolute top-2 right-3 text-[10px] tracking-widest font-bold opacity-80 bg-black/30 rounded px-2 py-0.5">
          {TIMEFRAME_LABEL[timeframe]}
        </span>
        <div className="text-[72px] leading-none font-black tracking-tighter">
          {data.signal}
        </div>
        <p className="mt-2 text-sm font-medium leading-snug max-w-xs bg-black/20 rounded-lg px-3 py-2">
          {data.signalReason}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-4 space-y-5">

          {/* ── 2. Price bar ────────────────────────────────────────────── */}
          <div className="flex items-baseline justify-between bg-zinc-900/60 rounded-lg px-4 py-3 border border-zinc-800/50">
            <div>
              <div className="text-[10px] text-zinc-500 font-sans font-semibold tracking-widest mb-0.5">
                XAGUSD
              </div>
              <div className="text-3xl font-bold tracking-tight">
                ${data.currentPrice.toFixed(3)}
              </div>
            </div>
            <div className={cn("text-right", isPositive ? "text-[#00c950]" : "text-[#e53e3e]")}>
              <div className="text-lg font-bold flex items-center justify-end gap-1">
                {isPositive ? "+" : ""}
                {data.priceChange.toFixed(3)}
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
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
                TRADE TICKET
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
                <Row label="Entry" value={`$${data.entryPrice.toFixed(3)}`} />
                <Row label="Stop Loss" value={`$${data.stopLoss.toFixed(3)}`} valueClass="text-[#e53e3e]" labelClass="text-[#e53e3e]" bg="bg-red-950/10" />
                <Row label="Take Profit 1" value={`$${data.takeProfit1.toFixed(3)}`} valueClass="text-[#4ade80]" labelClass="text-[#4ade80]" bg="bg-emerald-950/10" />
                <Row label="Take Profit 2" value={`$${data.takeProfit2.toFixed(3)}`} valueClass="text-[#86efac]" labelClass="text-[#86efac]" bg="bg-emerald-900/10" />
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
              <div className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold mb-2 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
                ZONE WATCH
              </div>
              <div className="rounded-lg overflow-hidden border border-zinc-800 divide-y divide-zinc-800/60 bg-[#111]">
                <ZoneRow
                  side="LONG"
                  zoneLabel={`${data.buyZone.low.toFixed(2)}–${data.buyZone.high.toFixed(2)}`}
                  price={data.currentPrice}
                  zoneLow={data.buyZone.low}
                  zoneHigh={data.buyZone.high}
                  isActive={data.signal === "BUY"}
                />
                <ZoneRow
                  side="SHORT"
                  zoneLabel={`${data.sellZone.low.toFixed(2)}–${data.sellZone.high.toFixed(2)}`}
                  price={data.currentPrice}
                  zoneLow={data.sellZone.low}
                  zoneHigh={data.sellZone.high}
                  isActive={data.signal === "SELL"}
                />
              </div>
            </div>
          </div>

          {/* ── 5. Market Structure ─────────────────────────────────────── */}
          <div>
            <div className="text-[10px] text-zinc-500 tracking-widest font-sans font-semibold mb-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" />
              MARKET STRUCTURE
            </div>
            <div className="flex items-center justify-between bg-[#111] border border-zinc-800 rounded-lg px-4 py-3">
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
          </div>

        </div>
      </div>

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

function ZoneRow({
  side,
  zoneLabel,
  price,
  zoneLow,
  zoneHigh,
  isActive,
}: {
  side: "LONG" | "SHORT";
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
    // Long: zone is below price ideal entry below current
    distance = price - zoneHigh;
    status = distance > 0 ? `${distance.toFixed(2)} above` : `${Math.abs(distance).toFixed(2)} below`;
  } else {
    // Short: zone is above price ideal entry above current
    distance = zoneLow - price;
    status = distance > 0 ? `${distance.toFixed(2)} below` : `${Math.abs(distance).toFixed(2)} above`;
  }

  return (
    <div
      className={cn(
        "px-3 py-2.5 flex flex-col gap-1 min-w-0",
        isActive ? sideBg : "",
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
            {side}
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
          ${zoneLabel}
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
