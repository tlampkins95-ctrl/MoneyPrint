import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { RefreshCw, Activity, ArrowUpRight, ArrowDownRight, Minus, Zap } from "lucide-react";
import { 
  useGetSignals, 
  useGetSignalSummary, 
  getGetSignalsQueryKey, 
  getGetSignalSummaryQueryKey 
} from "@workspace/api-client-react";
import { SignalBadge } from "./signal-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

export function SignalPanel() {
  const queryClient = useQueryClient();
  const { data: summary, isLoading: isLoadingSummary, isError: isErrorSummary, refetch: refetchSummary } = useGetSignalSummary();
  const { data: signals, isLoading: isLoadingSignals, isError: isErrorSignals, refetch: refetchSignals } = useGetSignals();

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refetchSummary();
      refetchSignals();
    }, 60000);
    return () => clearInterval(interval);
  }, [refetchSummary, refetchSignals]);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetSignalSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetSignalsQueryKey() });
  };

  if (isErrorSummary || isErrorSignals) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-card border rounded-sm p-6 text-center">
        <Zap className="h-8 w-8 text-destructive mb-3" />
        <h3 className="font-medium text-foreground mb-1">Connection Failed</h3>
        <p className="text-sm text-muted-foreground mb-4">Unable to fetch terminal data.</p>
        <Button onClick={handleRefresh} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" /> Retry Connection
        </Button>
      </div>
    );
  }

  const formatPrice = (p: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 3 }).format(p);

  return (
    <div className="h-full flex flex-col bg-card border rounded-sm overflow-hidden font-sans">
      {/* Header / Price section */}
      <div className="p-4 border-b bg-muted/20">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground tracking-wider uppercase">Terminal Signal</h2>
          </div>
          <div className="flex items-center gap-2">
            {summary && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {format(new Date(summary.lastUpdated), "HH:mm:ss")}
              </span>
            )}
            <button 
              onClick={handleRefresh}
              className="text-muted-foreground hover:text-foreground transition-colors p-1"
              title="Refresh Data"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", (isLoadingSummary || isLoadingSignals) && "animate-spin")} />
            </button>
          </div>
        </div>

        {isLoadingSummary ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
        ) : summary ? (
          <div>
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-mono tracking-tight text-foreground">
                {formatPrice(summary.currentPrice).replace("$", "")}
              </span>
              <span className="text-muted-foreground font-mono text-sm">USD</span>
            </div>
            <div className={cn(
              "flex items-center gap-1.5 font-mono text-sm mt-1",
              summary.priceChange >= 0 ? "text-emerald-500" : "text-rose-500"
            )}>
              {summary.priceChange >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              <span>{summary.priceChange >= 0 ? "+" : ""}{summary.priceChange.toFixed(3)}</span>
              <span>({summary.priceChangePct >= 0 ? "+" : ""}{summary.priceChangePct.toFixed(2)}%)</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Summary Stats */}
      <div className="p-4 border-b">
        {isLoadingSummary ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : summary ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Recommendation</span>
              <SignalBadge signal={summary.overallSignal} size="lg" />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-muted-foreground">Confidence</span>
                <span className="text-foreground">{summary.confidence.toFixed(1)}%</span>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden flex">
                <div 
                  className={cn(
                    "h-full transition-all duration-500",
                    summary.overallSignal.includes("BUY") ? "bg-emerald-500" : 
                    summary.overallSignal.includes("SELL") ? "bg-rose-500" : "bg-slate-400"
                  )}
                  style={{ width: `${summary.confidence}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded p-2 text-center">
                <div className="text-[10px] text-emerald-500 font-medium mb-1">BUY</div>
                <div className="text-lg font-mono text-emerald-400">{summary.buyCount}</div>
              </div>
              <div className="bg-slate-500/10 border border-slate-500/20 rounded p-2 text-center">
                <div className="text-[10px] text-slate-400 font-medium mb-1">NEUTRAL</div>
                <div className="text-lg font-mono text-slate-300">{summary.neutralCount}</div>
              </div>
              <div className="bg-rose-500/10 border border-rose-500/20 rounded p-2 text-center">
                <div className="text-[10px] text-rose-500 font-medium mb-1">SELL</div>
                <div className="text-lg font-mono text-rose-400">{summary.sellCount}</div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Indicators List */}
      <div className="flex-1 overflow-auto bg-card">
        <div className="px-4 py-3 border-b sticky top-0 bg-card/95 backdrop-blur-sm z-10">
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Technical Indicators</span>
        </div>
        
        {isLoadingSignals ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : signals ? (
          <div className="divide-y divide-border/50">
            {signals.indicators.map((ind, i) => (
              <div key={i} className="p-3 hover:bg-muted/30 transition-colors flex items-center justify-between group">
                <div className="flex-1 pr-3">
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-sm font-medium text-foreground">{ind.name}</span>
                    <span className="text-xs font-mono text-muted-foreground">{ind.value.toFixed(2)}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground line-clamp-1">{ind.description}</p>
                </div>
                <SignalBadge signal={ind.signal} className="shrink-0" />
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No indicator data available
          </div>
        )}
      </div>
    </div>
  );
}