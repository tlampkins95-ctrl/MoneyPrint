import { useGetNews, getGetNewsQueryKey } from "@workspace/api-client-react";
import { TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

function formatPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toPrecision(4)}`;
}

interface GainersStripProps {
  selectedSymbol: string;
  onSelect: (symbol: string, timeframe: string) => void;
}

export function GainersStrip({ selectedSymbol, onSelect }: GainersStripProps) {
  const { data, isLoading } = useGetNews({
    query: {
      queryKey: getGetNewsQueryKey(),
      staleTime: 5 * 60_000,
      refetchInterval: 10 * 60_000,
    },
  });

  const gainers = data?.gainers ?? [];
  if (!isLoading && gainers.length === 0) return null;

  const allNegative = gainers.length > 0 && gainers.every((g) => g.priceChange24h < 0);
  const stripLabel = allNegative ? "TOP MOVERS · 24H" : "TOP GAINERS · 24H";

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-md overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 shrink-0">
        <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
        <span
          className="text-[11px] font-bold tracking-[0.15em] text-foreground"
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          {stripLabel}
        </span>
      </div>

      <div className="flex gap-2 px-3 py-2.5 overflow-x-auto scrollbar-none">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex-shrink-0 w-[110px] h-[70px] rounded-lg bg-muted/20 animate-pulse"
              />
            ))
          : gainers.map((g) => {
              const symKey = `${g.symbol}USDT`;
              const isSelected = selectedSymbol === symKey;
              const isPositive = g.priceChange24h >= 0;
              const pctColor = isPositive ? "text-emerald-400" : "text-rose-400";
              const pctLabel = `${isPositive ? "+" : ""}${g.priceChange24h.toFixed(1)}%`;
              const hasData = g.hasSignalData;
              return (
                <button
                  key={g.symbol}
                  type="button"
                  onClick={hasData ? () => onSelect(symKey, "1h") : undefined}
                  disabled={!hasData}
                  title={hasData ? undefined : "No signal data available yet"}
                  className={cn(
                    "flex-shrink-0 flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-all text-left",
                    !hasData
                      ? "border-border/20 bg-card/20 opacity-40 cursor-not-allowed"
                      : isSelected
                        ? "border-emerald-500/60 bg-emerald-500/10"
                        : "border-border/40 bg-card/40 hover:border-emerald-500/30 hover:bg-emerald-500/5",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {g.imageUrl && (
                      <img
                        src={g.imageUrl}
                        alt={g.symbol}
                        className="w-4 h-4 rounded-full"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    )}
                    <span className="text-[11px] font-bold text-foreground">
                      {g.symbol}
                    </span>
                    <span className={cn("text-[10px] font-bold", pctColor)}>
                      {pctLabel}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {formatPrice(g.price)}
                  </span>
                  <span className="text-[9px] text-muted-foreground/50 truncate max-w-[100px]">
                    {g.name}
                  </span>
                </button>
              );
            })}
      </div>
    </div>
  );
}
