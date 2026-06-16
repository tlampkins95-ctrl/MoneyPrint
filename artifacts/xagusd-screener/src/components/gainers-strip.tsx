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

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-md overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 shrink-0">
        <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
        <span
          className="text-[11px] font-bold tracking-[0.15em] text-foreground"
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          TOP GAINERS · 24H
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
              return (
                <button
                  key={g.symbol}
                  type="button"
                  onClick={() => onSelect(symKey, "1h")}
                  className={cn(
                    "flex-shrink-0 flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-all text-left",
                    isSelected
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
                    <span className="text-[10px] font-bold text-emerald-400">
                      +{g.priceChange24h.toFixed(1)}%
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
