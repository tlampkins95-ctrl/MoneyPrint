import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetLevels, getGetLevelsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { RefreshCw, TrendingUp, TrendingDown, ArrowRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export function SignalPanel() {
  const queryClient = useQueryClient();
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  
  const { data, isLoading, isError, error, refetch, isFetching } = useGetLevels({
    query: {
      refetchInterval: 60000,
    }
  });

  const handleRefresh = async () => {
    await refetch();
    setLastRefreshed(new Date());
  };

  useEffect(() => {
    if (data?.lastUpdated) {
      setLastRefreshed(new Date(data.lastUpdated));
    }
  }, [data?.lastUpdated]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-[#0a0a0a] rounded-xl border border-white/10 p-6 animate-pulse">
        <div className="h-32 bg-white/5 rounded-lg mb-6"></div>
        <div className="h-12 bg-white/5 rounded-lg mb-6"></div>
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 bg-white/5 rounded-md"></div>
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0a0a0a] rounded-xl border border-red-500/20 p-6 text-center">
        <AlertTriangle className="w-8 h-8 text-red-500 mb-3" />
        <div className="text-red-500 mb-2 font-bold">Failed to load signal data</div>
        <p className="text-sm text-zinc-400 mb-6">{error?.message || "Connection to trading terminal lost."}</p>
        <button 
          onClick={handleRefresh}
          className="px-6 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md transition-colors text-sm font-mono flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Retry Connection
        </button>
      </div>
    );
  }

  const signalColor = {
    BUY: "bg-[#00E676] text-black",
    SELL: "bg-[#FF3B30] text-white",
    WAIT: "bg-[#F5A623] text-black"
  }[data.signal];

  const signalText = data.signal;
  const isPositive = data.priceChange >= 0;

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] text-zinc-100 rounded-xl border border-zinc-800 overflow-hidden font-mono shadow-2xl">
      {/* 1. Signal Hero */}
      <div className={cn("p-6 text-center flex flex-col items-center justify-center min-h-[180px] transition-colors duration-500", signalColor)}>
        <h2 className="text-7xl md:text-8xl font-black tracking-tighter uppercase mb-3 drop-shadow-md">
          {signalText}
        </h2>
        <p className={cn("text-sm md:text-base font-bold max-w-md px-4 py-1.5 rounded-full bg-black/20 backdrop-blur-sm")}>
          {data.signalReason}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="p-4 md:p-5 space-y-6">
          
          {/* 2. Price bar */}
          <div className="flex items-baseline justify-between bg-zinc-900/50 p-4 rounded-lg border border-zinc-800/50">
            <div>
              <div className="text-xs text-zinc-500 mb-1 font-sans font-semibold tracking-widest">XAGUSD</div>
              <div className="text-4xl font-bold tracking-tighter">${data.currentPrice.toFixed(3)}</div>
            </div>
            <div className={cn("text-right font-medium", isPositive ? "text-[#00E676]" : "text-[#FF3B30]")}>
              <div className="text-xl flex items-center justify-end gap-1 font-bold">
                {isPositive ? "+" : ""}{data.priceChange.toFixed(3)}
                {isPositive ? <TrendingUp className="w-5 h-5 ml-1" /> : <TrendingDown className="w-5 h-5 ml-1" />}
              </div>
              <div className="text-sm font-semibold opacity-90">
                {isPositive ? "+" : ""}{data.priceChangePct.toFixed(2)}%
              </div>
            </div>
          </div>

          {/* 3. Trade Setup block */}
          <div>
            <div className="text-xs text-zinc-500 mb-2 tracking-wider font-sans font-semibold flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
              TRADE TICKET
            </div>
            <div className="bg-[#111] border border-zinc-800 rounded-lg overflow-hidden divide-y divide-zinc-800/50">
              <div className="flex justify-between items-center p-3.5">
                <span className="text-zinc-400">Entry</span>
                <span className="font-bold text-lg">${data.entryPrice.toFixed(3)}</span>
              </div>
              <div className="flex justify-between items-center p-3.5 bg-red-950/10">
                <span className="text-red-400">Stop Loss</span>
                <span className="font-bold text-red-400 text-lg">${data.stopLoss.toFixed(3)}</span>
              </div>
              <div className="flex justify-between items-center p-3.5 bg-emerald-950/10">
                <span className="text-[#00E676]">Take Profit 1</span>
                <span className="font-bold text-[#00E676] text-lg">${data.takeProfit1.toFixed(3)}</span>
              </div>
              <div className="flex justify-between items-center p-3.5 bg-emerald-900/20">
                <span className="text-[#69FFB4] font-medium">Take Profit 2</span>
                <span className="font-bold text-[#69FFB4] text-lg">${data.takeProfit2.toFixed(3)}</span>
              </div>
              <div className="flex justify-between items-center p-3.5 bg-zinc-950">
                <span className="text-zinc-500 font-sans text-xs font-semibold tracking-wider">RISK / REWARD</span>
                <span className="font-bold text-white text-xl">1:{data.riskRewardRatio.toFixed(1)}</span>
              </div>
            </div>
          </div>

          {/* 4. Zones */}
          <div>
            <div className="text-xs text-zinc-500 mb-3 tracking-wider font-sans font-semibold flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
              MARKET ZONES
            </div>
            <div className="space-y-5">
              <div className="relative">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-red-400 font-bold uppercase">{data.sellZone.label}</span>
                  <span className="text-red-400/80 font-medium">${data.sellZone.low.toFixed(2)} - ${data.sellZone.high.toFixed(2)}</span>
                </div>
                <div className="h-2.5 w-full bg-zinc-900 rounded-full overflow-hidden border border-red-500/10">
                  <div className="h-full bg-red-500/60 w-full" />
                </div>
              </div>
              <div className="relative">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-[#00E676] font-bold uppercase">{data.buyZone.label}</span>
                  <span className="text-[#00E676]/80 font-medium">${data.buyZone.low.toFixed(2)} - ${data.buyZone.high.toFixed(2)}</span>
                </div>
                <div className="h-2.5 w-full bg-zinc-900 rounded-full overflow-hidden border border-emerald-500/10">
                  <div className="h-full bg-[#00E676]/60 w-full" />
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
             {/* 6. Market Structure */}
            <div className="col-span-2">
              <div className="text-xs text-zinc-500 mb-2 tracking-wider font-sans font-semibold flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
                STRUCTURE
              </div>
              <div className="flex items-center justify-between bg-[#111] border border-zinc-800 rounded-lg p-4">
                <div className="flex items-center gap-2.5">
                  {data.trend === "UPTREND" && <TrendingUp className="text-[#00E676] w-5 h-5" />}
                  {data.trend === "DOWNTREND" && <TrendingDown className="text-red-400 w-5 h-5" />}
                  {data.trend === "RANGING" && <ArrowRight className="text-[#F5A623] w-5 h-5" />}
                  <span className={cn(
                    "font-bold tracking-wider",
                    data.trend === "UPTREND" ? "text-[#00E676]" :
                    data.trend === "DOWNTREND" ? "text-red-400" : "text-[#F5A623]"
                  )}>{data.trend}</span>
                </div>
                <div className="flex items-center gap-3 w-32">
                  <div className="flex-1 h-2 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                    <div 
                      className={cn(
                        "h-full rounded-full",
                        data.trend === "UPTREND" ? "bg-[#00E676]" :
                        data.trend === "DOWNTREND" ? "bg-red-400" : "bg-[#F5A623]"
                      )}
                      style={{ width: `${data.trendStrength}%` }}
                    />
                  </div>
                  <span className="text-sm font-bold text-white w-6 text-right">{data.trendStrength}</span>
                </div>
              </div>
            </div>

            {/* 5. Key Levels */}
            <div className="col-span-2">
              <div className="text-xs text-zinc-500 mb-2 tracking-wider font-sans font-semibold flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
                KEY LEVELS
              </div>
              <div className="bg-[#111] border border-zinc-800 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-zinc-800/50">
                    {data.levels.map((level, idx) => (
                      <tr key={idx} className={cn(
                        "hover:bg-zinc-800/50 transition-colors",
                        level.price === data.pivot && "bg-blue-900/10"
                      )}>
                        <td className="p-2.5 pl-4">
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded font-bold mr-3",
                            level.type === 'resistance' ? "bg-red-500/20 text-red-400" :
                            level.type === 'support' ? "bg-emerald-500/20 text-[#00E676]" :
                            "bg-blue-500/20 text-blue-400"
                          )}>
                            {level.type === 'resistance' ? 'R' : level.type === 'support' ? 'S' : 'P'}
                          </span>
                          <span className="text-zinc-300 font-sans text-xs font-medium">{level.label}</span>
                        </td>
                        <td className="p-2.5 pr-4 text-right font-bold text-zinc-200">
                          ${level.price.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 7. Refresh Controls */}
      <div className="p-3 border-t border-zinc-800 bg-[#050505] flex items-center justify-between text-xs text-zinc-500 shrink-0">
        <div className="font-sans flex items-center gap-2">
          <div className={cn("w-2 h-2 rounded-full", isFetching ? "bg-zinc-500" : "bg-[#00E676] shadow-[0_0_8px_rgba(0,230,118,0.5)]")} />
          Last updated: {format(lastRefreshed, "HH:mm:ss")}
        </div>
        <button 
          onClick={handleRefresh}
          disabled={isFetching}
          className="flex items-center gap-1.5 hover:text-zinc-300 transition-colors disabled:opacity-50 font-sans font-medium px-2 py-1 rounded hover:bg-white/5"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          <span>Refresh</span>
        </button>
      </div>
    </div>
  );
}
