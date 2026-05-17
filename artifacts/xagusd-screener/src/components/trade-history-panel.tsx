import { useState } from "react";
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus, Clock } from "lucide-react";
import { useGetTradeHistory, getGetTradeHistoryQueryKey } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const TIMEFRAME_LABELS: Record<string, string> = {
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "1d": "1D",
};

type Outcome = "SL" | "BE_TRAIL" | "TP2" | "REVERSED" | "MISSED";

function outcomeLabel(outcome: Outcome): string {
  switch (outcome) {
    case "TP2": return "TP2";
    case "BE_TRAIL": return "BE";
    case "SL": return "SL";
    case "REVERSED": return "REV";
    case "MISSED": return "MISS";
  }
}

function outcomeBadgeClass(outcome: Outcome): string {
  switch (outcome) {
    case "TP2": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "BE_TRAIL": return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "SL": return "bg-rose-500/15 text-rose-400 border-rose-500/30";
    case "REVERSED":
    case "MISSED": return "bg-zinc-700/30 text-zinc-400 border-zinc-600/30";
  }
}

function rMultipleClass(r: number, outcome: Outcome): string {
  if (outcome === "REVERSED" || outcome === "MISSED") return "text-zinc-500";
  if (r > 0) return "text-emerald-400";
  if (r < 0) return "text-rose-400";
  return "text-amber-400";
}

function formatR(r: number, outcome: Outcome): string {
  if (outcome === "MISSED") return "—";
  if (outcome === "REVERSED") return `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
  return `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
}

function formatTs(ts: number | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface Props {
  selectedSymbol?: string;
  onSelect?: (symbol: string) => void;
}

export function TradeHistoryPanel({ selectedSymbol, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return window.localStorage.getItem("screener.tradeHistory.collapsed") === "1";
    }
    return false;
  });
  const [filterSymbol, setFilterSymbol] = useState<string>("");

  const effectiveSymbol = filterSymbol.trim() || undefined;

  const { data, isLoading, isError, refetch, isFetching } = useGetTradeHistory(
    { symbol: effectiveSymbol, limit: 200 },
    {
      query: {
        queryKey: getGetTradeHistoryQueryKey({ symbol: effectiveSymbol, limit: 200 }),
        refetchInterval: 30000,
      },
    },
  );

  const trades = data?.trades ?? [];
  const totalR = data?.totalR ?? 0;
  const winCount = data?.winCount ?? 0;
  const lossCount = data?.lossCount ?? 0;
  const totalTrades = data?.totalTrades ?? 0;

  const actionableTrades = trades.filter((t) => t.outcome !== "MISSED" && t.outcome !== "REVERSED");

  const handleToggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("screener.tradeHistory.collapsed", next ? "1" : "0");
    }
  };

  return (
    <section
      className="rounded-xl border border-zinc-800 bg-[#0a0a0a]/50 backdrop-blur-md overflow-hidden"
      data-testid="trade-history-panel"
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/30",
          collapsed && "border-b-0",
        )}
      >
        <button
          type="button"
          onClick={handleToggle}
          className="flex items-center gap-2.5 -my-1 -mx-2 px-2 py-1 rounded hover:bg-white/5 transition-colors"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
          )}
          <h2
            className="text-xs font-bold tracking-[0.18em] text-zinc-100"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            TRADE JOURNAL
          </h2>
          <span className="text-[10px] font-mono text-zinc-500">
            {totalTrades} closed
          </span>
        </button>

        {/* Summary stats */}
        {!collapsed && (
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className={cn("font-bold", totalR > 0 ? "text-emerald-400" : totalR < 0 ? "text-rose-400" : "text-zinc-400")}>
              {totalR >= 0 ? "+" : ""}{totalR.toFixed(2)}R
            </span>
            <span className="text-zinc-500">
              <span className="text-emerald-400">{winCount}W</span>
              {" / "}
              <span className="text-rose-400">{lossCount}L</span>
              {actionableTrades.length > 0 && (
                <span className="text-zinc-500 ml-1">
                  ({Math.round((winCount / Math.max(winCount + lossCount, 1)) * 100)}% WR)
                </span>
              )}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); refetch(); }}
              disabled={isFetching}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 hover:bg-white/5 disabled:opacity-50 transition-colors text-zinc-400"
            >
              <Clock className="w-3 h-3" />
              <span>Refresh</span>
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="p-2 md:p-3">
          {/* Symbol filter */}
          <div className="mb-2 flex gap-2">
            <input
              type="text"
              placeholder="Filter by symbol (e.g. XAGUSD)…"
              value={filterSymbol}
              onChange={(e) => setFilterSymbol(e.target.value)}
              className="flex-1 max-w-xs px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900/50 text-xs font-mono text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
            />
            {selectedSymbol && filterSymbol !== selectedSymbol && (
              <button
                type="button"
                onClick={() => setFilterSymbol(selectedSymbol)}
                className="px-2 py-1 rounded border border-zinc-700 text-[10px] font-mono text-zinc-400 hover:bg-white/5 transition-colors"
              >
                Show {selectedSymbol}
              </button>
            )}
            {filterSymbol && (
              <button
                type="button"
                onClick={() => setFilterSymbol("")}
                className="px-2 py-1 rounded border border-zinc-700 text-[10px] font-mono text-zinc-400 hover:bg-white/5 transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {isLoading && (
            <div className="text-center py-8 text-zinc-500 text-xs font-mono">Loading trade history…</div>
          )}
          {isError && (
            <div className="text-center py-8 text-rose-400 text-xs font-mono">Failed to load trade history.</div>
          )}

          {!isLoading && !isError && trades.length === 0 && (
            <div className="text-center py-10 text-zinc-500 text-xs font-mono">
              No closed trades yet. Trades are recorded when signals close via SL, TP2, or BE trail.
            </div>
          )}

          {!isLoading && !isError && trades.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] font-mono border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="text-left py-1.5 px-2 text-zinc-500 font-medium">Symbol</th>
                    <th className="text-left py-1.5 px-2 text-zinc-500 font-medium">TF</th>
                    <th className="text-left py-1.5 px-2 text-zinc-500 font-medium">Dir</th>
                    <th className="text-left py-1.5 px-2 text-zinc-500 font-medium">Type</th>
                    <th className="text-right py-1.5 px-2 text-zinc-500 font-medium">Entry</th>
                    <th className="text-right py-1.5 px-2 text-zinc-500 font-medium">Exit</th>
                    <th className="text-center py-1.5 px-2 text-zinc-500 font-medium">Outcome</th>
                    <th className="text-right py-1.5 px-2 text-zinc-500 font-medium">R</th>
                    <th className="text-right py-1.5 px-2 text-zinc-500 font-medium hidden md:table-cell">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade, idx) => {
                    const prevR = trades
                      .slice(idx + 1)
                      .filter((t) => t.outcome !== "MISSED" && t.outcome !== "REVERSED")
                      .reduce((s, t) => s + t.rMultiple, 0);
                    const runningR = trades
                      .slice(idx)
                      .filter((t) => t.outcome !== "MISSED" && t.outcome !== "REVERSED")
                      .reduce((s, t) => s + t.rMultiple, 0);
                    void prevR;
                    void runningR;

                    return (
                      <tr
                        key={trade.id}
                        className={cn(
                          "border-b border-zinc-800/50 hover:bg-white/[0.02] transition-colors",
                          onSelect && "cursor-pointer",
                        )}
                        onClick={() => onSelect?.(trade.symbol)}
                      >
                        <td className="py-1.5 px-2 text-zinc-200 font-semibold">{trade.symbol}</td>
                        <td className="py-1.5 px-2 text-zinc-400">
                          {TIMEFRAME_LABELS[trade.timeframe] ?? trade.timeframe}
                        </td>
                        <td className="py-1.5 px-2">
                          {trade.signal === "BUY" ? (
                            <span className="flex items-center gap-1 text-emerald-400">
                              <TrendingUp className="w-3 h-3" />
                              BUY
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-rose-400">
                              <TrendingDown className="w-3 h-3" />
                              SELL
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-zinc-500">
                          {trade.signalType === "PIVOT_BOUNCE" ? "PVT" : trade.signalType === "DAGGER" ? "DAG" : trade.signalType === "PATTERN_BREAKOUT" ? "PAT" : "BKO"}
                        </td>
                        <td className="py-1.5 px-2 text-right text-zinc-300">
                          {trade.entryPrice.toFixed(trade.entryPrice > 100 ? 2 : trade.entryPrice > 1 ? 4 : 5)}
                        </td>
                        <td className="py-1.5 px-2 text-right text-zinc-300">
                          {trade.exitPrice.toFixed(trade.exitPrice > 100 ? 2 : trade.exitPrice > 1 ? 4 : 5)}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          <span className={cn(
                            "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] border font-bold",
                            outcomeBadgeClass(trade.outcome as Outcome),
                          )}>
                            {trade.tp1Hit && trade.outcome === "SL" && (
                              <span title="TP1 was hit before SL" className="opacity-70">★</span>
                            )}
                            {outcomeLabel(trade.outcome as Outcome)}
                          </span>
                        </td>
                        <td className={cn(
                          "py-1.5 px-2 text-right font-bold",
                          rMultipleClass(trade.rMultiple, trade.outcome as Outcome),
                        )}>
                          {formatR(trade.rMultiple, trade.outcome as Outcome)}
                        </td>
                        <td className="py-1.5 px-2 text-right text-zinc-500 hidden md:table-cell">
                          {formatTs(trade.closedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Running R equity curve summary */}
              {actionableTrades.length > 0 && (
                <div className="mt-3 pt-3 border-t border-zinc-800 flex items-center gap-4 text-[10px] font-mono text-zinc-500">
                  <span>
                    <span className="text-zinc-400">{actionableTrades.length}</span> filled trades
                  </span>
                  <span>
                    Net: <span className={cn("font-bold", totalR > 0 ? "text-emerald-400" : totalR < 0 ? "text-rose-400" : "text-zinc-400")}>
                      {totalR >= 0 ? "+" : ""}{totalR.toFixed(2)}R
                    </span>
                  </span>
                  <span>
                    Avg: <span className="text-zinc-300">
                      {actionableTrades.length > 0
                        ? `${(totalR / actionableTrades.length >= 0 ? "+" : "")}${(totalR / actionableTrades.length).toFixed(2)}R`
                        : "—"}
                    </span>
                  </span>
                  <span className="text-zinc-600 flex items-center gap-1">
                    <Minus className="w-3 h-3" />
                    MISSED/REVERSED excluded from R totals
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
