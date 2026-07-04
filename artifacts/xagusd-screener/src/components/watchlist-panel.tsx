import { useState, useRef } from "react";
import { useGetTrendingSymbols, getGetTrendingSymbolsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Pin, X, Plus, Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

function formatChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

interface WatchlistPanelProps {
  selectedSymbol: string;
  onSelect: (symbol: string, timeframe: string) => void;
}

export function WatchlistPanel({ selectedSymbol, onSelect }: WatchlistPanelProps) {
  const queryClient = useQueryClient();
  const [ticker, setTicker] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, refetch } = useGetTrendingSymbols({
    query: {
      queryKey: getGetTrendingSymbolsQueryKey(),
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });

  const symbols = data?.symbols ?? [];
  const pinned = symbols.filter((s) => s.pinned);
  const auto = symbols.filter((s) => !s.pinned);

  async function handleAdd() {
    const t = ticker.trim();
    if (!t) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: t }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setAddError(json.error ?? "Unknown error");
      } else {
        setTicker("");
        void refetch();
        void queryClient.invalidateQueries({ queryKey: getGetTrendingSymbolsQueryKey() });
      }
    } catch {
      setAddError("Network error");
    } finally {
      setAdding(false);
      inputRef.current?.focus();
    }
  }

  async function handleRemove(symbolKey: string) {
    setRemovingKey(symbolKey);
    try {
      const res = await fetch(`/api/watchlist/${encodeURIComponent(symbolKey)}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (json.ok) {
        void refetch();
        void queryClient.invalidateQueries({ queryKey: getGetTrendingSymbolsQueryKey() });
      }
    } catch { /* swallow */ } finally {
      setRemovingKey(null);
    }
  }

  if (!isLoading && symbols.length === 0 && pinned.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-md overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40">
        <Pin className="w-3.5 h-3.5 text-primary" />
        <span
          className="text-[11px] font-bold tracking-[0.15em] text-foreground"
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          WATCHLIST
        </span>
        {pinned.length > 0 && (
          <span className="text-[10px] font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
            {pinned.length} pinned
          </span>
        )}
        <span className="text-[10px] font-mono text-muted-foreground ml-auto">
          {auto.length} auto-discovered
        </span>
      </div>

      {/* Add coin input */}
      <div className="px-3 py-2 border-b border-border/30 bg-black/20">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={ticker}
            onChange={(e) => {
              setTicker(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
            }}
            placeholder="Add ticker (e.g. LAB, PEPE)"
            className={cn(
              "flex-1 text-[11px] font-mono bg-zinc-900/80 border rounded px-2.5 py-1.5 text-zinc-100",
              "placeholder:text-zinc-600 outline-none transition-colors",
              addError
                ? "border-rose-500/60 focus:border-rose-400"
                : "border-zinc-700 focus:border-primary/60",
            )}
          />
          <button
            onClick={() => void handleAdd()}
            disabled={adding || !ticker.trim()}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-[11px] font-bold transition-colors",
              "bg-primary/10 border-primary/40 text-primary hover:bg-primary/20",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            {adding ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Plus className="w-3 h-3" />
            )}
            Add
          </button>
        </div>
        {addError && (
          <p className="mt-1.5 text-[10px] font-mono text-rose-400">{addError}</p>
        )}
      </div>

      {/* Coin list */}
      <div className="flex gap-2 px-3 py-2.5 overflow-x-auto scrollbar-none">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-[110px] h-[70px] rounded-lg bg-muted/20 animate-pulse" />
            ))
          : symbols.length === 0
          ? (
              <p className="text-[11px] font-mono text-zinc-500 py-1">
                No coins yet — add a ticker above to get started
              </p>
            )
          : symbols.map((s) => {
              const symKey = s.symbolKey;
              const isSelected = selectedSymbol === symKey;
              const pct = s.priceChange24h;
              const isPositive = pct >= 0;
              const pctColor = isPositive ? "text-emerald-400" : "text-rose-400";
              const Arrow = isPositive ? TrendingUp : TrendingDown;
              return (
                <div key={symKey} className="relative flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => onSelect(symKey, "1h")}
                    className={cn(
                      "flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-all text-left",
                      "w-[118px]",
                      isSelected
                        ? "border-primary/60 bg-primary/10"
                        : s.pinned
                        ? "border-primary/25 bg-primary/5 hover:border-primary/40 hover:bg-primary/10"
                        : "border-border/40 bg-card/40 hover:border-emerald-500/30 hover:bg-emerald-500/5",
                    )}
                  >
                    <div className="flex items-center gap-1.5 w-full pr-3">
                      {s.pinned && (
                        <Pin className="w-2.5 h-2.5 text-primary/70 shrink-0" />
                      )}
                      <span className="text-[11px] font-bold text-foreground truncate">{s.baseAsset}</span>
                      <Arrow className={cn("w-3 h-3 shrink-0 ml-auto", pctColor)} />
                    </div>
                    <span className={cn("text-[11px] font-mono font-bold", pctColor)}>
                      {formatChange(pct)}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground/50 truncate w-full">
                      {s.pinned ? "📌 pinned" : `rank #${s.rank}`}
                    </span>
                  </button>
                  {/* Remove button — only shown for pinned coins */}
                  {s.pinned && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemove(symKey);
                      }}
                      disabled={removingKey === symKey}
                      title={`Remove ${s.baseAsset} from watchlist`}
                      className={cn(
                        "absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center",
                        "bg-zinc-800 border border-zinc-600 hover:bg-rose-900/60 hover:border-rose-500/60",
                        "text-zinc-400 hover:text-rose-300 transition-colors",
                        "disabled:opacity-50",
                      )}
                    >
                      {removingKey === symKey ? (
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      ) : (
                        <X className="w-2.5 h-2.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}
