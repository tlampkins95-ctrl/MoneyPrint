import { useEffect, useMemo, useState } from "react";
import { useGetBacktest, type GetBacktestSymbol } from "@workspace/api-client-react";
import { ChevronDown, ChevronRight, Trophy, Loader2, AlertTriangle } from "lucide-react";
import { ALL_SYMBOLS, SYMBOLS, type Symbol } from "@/lib/symbols";
import { cn } from "@/lib/utils";

type Timeframe = "1h" | "4h" | "1d" | "1w";
const ALL_TIMEFRAMES: Timeframe[] = ["1h", "4h", "1d", "1w"];
const TF_LABEL: Record<Timeframe, string> = {
  "1h": "1h",
  "4h": "4h",
  "1d": "1D",
  "1w": "1W",
};

type SortKey = "winRate" | "totalReturnR" | "profitFactor";

interface CellStats {
  symbol: Symbol;
  timeframe: Timeframe;
  winRate: number;
  totalReturnR: number;
  profitFactor: number;
  tradeCount: number;
  loading: boolean;
  error: boolean;
}

const STALE_TIME_MS = 5 * 60 * 1000;

type SignalTypeMode = "FIB50_SWING";

function useCell(symbol: Symbol, timeframe: Timeframe, enabled: boolean, signalType: SignalTypeMode): CellStats {
  const { data, isLoading, isError } = useGetBacktest(
    { symbol: symbol as GetBacktestSymbol, timeframe, signalType },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: { enabled, staleTime: STALE_TIME_MS, refetchOnWindowFocus: false } as any,
    },
  );
  return {
    symbol,
    timeframe,
    winRate: data?.winRate ?? 0,
    totalReturnR: data?.totalReturnR ?? 0,
    profitFactor: data?.profitFactor ?? 0,
    tradeCount: data?.totalTrades ?? 0,
    loading: isLoading,
    error: isError,
  };
}

function CellLoaders({
  enabled,
  signalType,
  onCells,
}: {
  enabled: boolean;
  signalType: SignalTypeMode;
  onCells: (cells: CellStats[]) => void;
}) {
  // 50 hooks (10 symbols × 5 tfs). React requires consistent hook order so we
  // render in the same fixed order every time.
  const cells: CellStats[] = [];
  for (const s of ALL_SYMBOLS) {
    for (const t of ALL_TIMEFRAMES) {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      cells.push(useCell(s, t, enabled, signalType));
    }
  }
  // Stable signature — only re-publish when something actually changed. Avoids
  // infinite render loops since `cells` is a fresh array reference each render.
  const sig = cells
    .map((c) => `${c.symbol}|${c.timeframe}|${c.loading ? "L" : c.error ? "E" : "D"}|${c.winRate}|${c.totalReturnR}|${c.profitFactor}|${c.tradeCount}`)
    .join("\n");
  useEffect(() => {
    onCells(cells);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return null;
}

function winRateColor(wr: number, hasData: boolean): string {
  if (!hasData) return "text-zinc-600 bg-zinc-900/30 border-zinc-800/50";
  if (wr >= 55) return "text-emerald-300 bg-emerald-950/40 border-emerald-700/50";
  if (wr >= 50) return "text-amber-300 bg-amber-950/30 border-amber-700/40";
  return "text-rose-300 bg-rose-950/30 border-rose-800/40";
}

function returnColor(r: number): string {
  if (r > 0) return "text-emerald-400";
  if (r < 0) return "text-rose-400";
  return "text-zinc-500";
}

export function EdgeLeaderboard({
  selectedSymbol,
  selectedTimeframe,
  onSelect,
}: {
  selectedSymbol: string;
  selectedTimeframe: Timeframe;
  onSelect: (s: string, t: Timeframe) => void;
}) {
  const [open, setOpen] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("winRate");
  const [signalType] = useState<SignalTypeMode>("FIB50_SWING");
  const [cells, setCells] = useState<CellStats[]>([]);

  const ranked = useMemo(() => {
    const withData = cells.filter((c) => !c.loading && !c.error && c.tradeCount > 0);
    return [...withData].sort((a, b) => b[sortKey] - a[sortKey]);
  }, [cells, sortKey]);

  const top = ranked[0];
  const loadingCount = cells.filter((c) => c.loading).length;
  const totalCount = ALL_SYMBOLS.length * ALL_TIMEFRAMES.length;

  const bestPerSymbol = useMemo(() => {
    const m = new Map<string, CellStats>();
    for (const c of cells) {
      if (c.loading || c.error || c.tradeCount === 0) continue;
      const cur = m.get(c.symbol);
      if (!cur || c[sortKey] > cur[sortKey]) m.set(c.symbol, c);
    }
    return m;
  }, [cells, sortKey]);

  return (
    <div className="border border-border rounded-lg bg-card/50 backdrop-blur-md overflow-hidden">
      {open && (
        <CellLoaders enabled={open} signalType={signalType} onCells={setCells} />
      )}

      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-3 border-b border-border/50 flex items-center justify-between hover:bg-card/80 transition-colors"
      >
        <div className="flex items-center gap-2.5 text-left">
          {open ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
          <Trophy className="w-4 h-4 text-amber-400" />
          <span className="font-mono text-xs font-bold tracking-widest text-foreground">
            EDGE MATRIX
          </span>
          <span className="font-mono text-[10px] text-muted-foreground hidden sm:inline">
            · best win rate by asset × timeframe
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          {open && loadingCount > 0 && (
            <span className="text-zinc-500 flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              {totalCount - loadingCount}/{totalCount}
            </span>
          )}
          {open && top && (
            <span className="hidden md:inline text-amber-300">
              TOP: {SYMBOLS[top.symbol].short} {TF_LABEL[top.timeframe]} · {top.winRate.toFixed(1)}% WR · {top.totalReturnR > 0 ? "+" : ""}
              {top.totalReturnR.toFixed(1)}R
            </span>
          )}
        </div>
      </button>

      {open && (
        <>
          {/* Sort tabs + mode toggle */}
          <div className="px-4 py-2 border-b border-border/30 flex flex-wrap items-center gap-2 text-[10px] font-mono">
            <span className="text-muted-foreground">SORT BY:</span>
            {(
              [
                ["winRate", "Win Rate"],
                ["totalReturnR", "Total Return"],
                ["profitFactor", "Profit Factor"],
              ] as Array<[SortKey, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSortKey(key)}
                className={cn(
                  "px-2 py-0.5 rounded border transition-colors",
                  sortKey === key
                    ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                    : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border",
                )}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1">
              <span className="text-muted-foreground hidden sm:inline">MODE:</span>
              <span className="px-2 py-0.5 rounded border border-amber-500/60 bg-amber-500/10 text-amber-300">
                ◈ FIB50 Swing
              </span>
            </span>
          </div>

          {/* Matrix */}
          <div className="p-3 overflow-x-auto">
            <table className="w-full font-mono text-xs border-separate border-spacing-1">
              <thead>
                <tr>
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest font-semibold pl-1 pb-1">
                    ASSET
                  </th>
                  {ALL_TIMEFRAMES.map((tf) => (
                    <th
                      key={tf}
                      className="text-center text-[10px] text-muted-foreground tracking-widest font-semibold pb-1"
                    >
                      {TF_LABEL[tf]}
                    </th>
                  ))}
                  <th className="text-left text-[10px] text-muted-foreground tracking-widest font-semibold pl-2 pb-1">
                    BEST
                  </th>
                </tr>
              </thead>
              <tbody>
                {ALL_SYMBOLS.map((sym) => {
                  const meta = SYMBOLS[sym];
                  const best = bestPerSymbol.get(sym);
                  return (
                    <tr key={sym}>
                      <td className="pr-2">
                        <div className="flex items-center gap-2 min-w-[110px]">
                          <span
                            className="w-5 h-5 rounded bg-zinc-800 text-zinc-200 flex items-center justify-center text-[10px] font-black shrink-0"
                            style={{ fontFamily: "var(--app-font-display)" }}
                          >
                            {meta.badge}
                          </span>
                          <span className="font-bold text-foreground text-[11px]">{meta.short}</span>
                        </div>
                      </td>
                      {ALL_TIMEFRAMES.map((tf) => {
                        const cell = cells.find((c) => c.symbol === sym && c.timeframe === tf);
                        const hasData = !!cell && !cell.loading && !cell.error && cell.tradeCount > 0;
                        const isSelected = sym === selectedSymbol && tf === selectedTimeframe;
                        const isTopOverall = top && top.symbol === sym && top.timeframe === tf;
                        const isBestForSymbol = best && best.timeframe === tf;
                        return (
                          <td key={tf} className="text-center">
                            <button
                              type="button"
                              onClick={() => onSelect(sym, tf)}
                              disabled={!hasData}
                              className={cn(
                                "w-full min-w-[64px] rounded px-1.5 py-1.5 border transition-all",
                                "flex flex-col items-center gap-0.5",
                                hasData ? "cursor-pointer hover:scale-[1.04] hover:z-10 relative" : "cursor-default opacity-60",
                                winRateColor(cell?.winRate ?? 0, hasData),
                                isSelected && "ring-2 ring-primary ring-offset-1 ring-offset-card",
                                isTopOverall && "ring-2 ring-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.4)]",
                                !isTopOverall && isBestForSymbol && "border-amber-600/60",
                              )}
                              title={
                                hasData && cell
                                  ? `${meta.short} ${TF_LABEL[tf]}\nWR ${cell.winRate.toFixed(1)}% · ${cell.totalReturnR.toFixed(1)}R · PF ${cell.profitFactor.toFixed(2)} · ${cell.tradeCount} trades`
                                  : cell?.loading
                                    ? "Running backtest…"
                                    : cell?.error
                                      ? "Backtest failed"
                                      : "No data"
                              }
                            >
                              {!cell || cell.loading ? (
                                <Loader2 className="w-3 h-3 animate-spin text-zinc-600" />
                              ) : cell.error || cell.tradeCount === 0 ? (
                                <span className="text-zinc-700 text-[10px]">—</span>
                              ) : (
                                <>
                                  <div className="flex items-center gap-0.5 leading-none">
                                    {cell.winRate < 45 && cell.tradeCount >= 15 && (
                                      <AlertTriangle className="w-2.5 h-2.5 text-rose-400 shrink-0" />
                                    )}
                                    <span className="font-bold text-[12px] leading-none">
                                      {cell.winRate.toFixed(1)}%
                                    </span>
                                  </div>
                                  <span className={cn("text-[9px] leading-none", returnColor(cell.totalReturnR))}>
                                    {cell.totalReturnR > 0 ? "+" : ""}
                                    {cell.totalReturnR.toFixed(1)}R
                                  </span>
                                </>
                              )}
                            </button>
                          </td>
                        );
                      })}
                      <td className="pl-2 text-[10px]">
                        {best ? (
                          <span className="text-amber-300 font-semibold">
                            {TF_LABEL[best.timeframe]} · {best.winRate.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-zinc-700">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Legend */}
            <div className="mt-3 pt-2 border-t border-border/30 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-emerald-950/40 border border-emerald-700/50 inline-block" />
                ≥55% WR (strong edge)
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-amber-950/30 border border-amber-700/40 inline-block" />
                50–55% WR (marginal)
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-rose-950/30 border border-rose-800/40 inline-block" />
                &lt;50% WR (negative)
              </div>
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3 text-rose-400" />
                &#x25b3; = poor win rate (&lt;45%, avoid)
              </div>
              <div className="flex items-center gap-1.5">
                <Trophy className="w-3 h-3 text-amber-400" />
                gold ring = top setup overall by selected metric
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
