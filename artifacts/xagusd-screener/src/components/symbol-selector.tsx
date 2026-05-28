import { useEffect, useRef, useState } from "react";
import { ChevronDown, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOREX_SYMBOLS, CRYPTO_SYMBOLS, SYMBOLS, getSymbolMeta, type Symbol } from "@/lib/symbols";

interface TrendingItem {
  symbolKey: string;
  baseAsset: string;
  priceChange24h: number;
  rank: number;
}

function useTrendingSymbols(): TrendingItem[] {
  const [items, setItems] = useState<TrendingItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}api/trending-symbols`)
      .then((r) => r.json())
      .then((data: { symbols: TrendingItem[] }) => {
        if (!cancelled) setItems(data.symbols ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return items;
}

function useSymbolChanges(): Record<string, number | null> {
  const [changes, setChanges] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}api/symbol-changes`)
      .then((r) => r.json())
      .then((data: { changes: Record<string, number | null> }) => {
        if (!cancelled) setChanges(data.changes ?? {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return changes;
}

const WATCHLIST_SYMBOLS = new Set(["USDCHF", "ZECUSD"]);

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 py-1.5 border-t border-border/60 first:border-t-0 text-[10px] font-bold tracking-widest text-muted-foreground">
      {label}
    </div>
  );
}

function SignalDot() {
  return (
    <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 shadow-[0_0_5px_rgba(251,191,36,0.9)]" />
  );
}

function SymbolRow({
  sym,
  isActive,
  change,
  hasSignal,
  onClick,
}: {
  sym: Symbol;
  isActive: boolean;
  change?: number | null;
  hasSignal?: boolean;
  onClick: () => void;
}) {
  const m = SYMBOLS[sym];
  const showChange = WATCHLIST_SYMBOLS.has(sym) && change != null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
        isActive ? "bg-primary/15 text-foreground" : "hover:bg-muted/40 text-foreground/90",
      )}
    >
      {/* Badge icon with optional signal ring */}
      <span className="relative shrink-0">
        <span
          className={cn(
            "w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-black",
            isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          {m.badge}
        </span>
        {hasSignal && (
          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-card shadow-[0_0_5px_rgba(251,191,36,0.9)]" />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold tracking-wider" style={{ fontFamily: "var(--app-font-display)" }}>
          {m.short}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">{m.long}</div>
      </div>
      {showChange ? (
        <span className={cn(
          "text-[10px] font-mono font-bold shrink-0",
          (change ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400",
        )}>
          {(change ?? 0) >= 0 ? "+" : ""}{(change ?? 0).toFixed(1)}%
        </span>
      ) : isActive ? (
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
      ) : hasSignal ? (
        <SignalDot />
      ) : null}
    </button>
  );
}

export function SymbolSelector({
  value,
  onChange,
  signalSymbols,
}: {
  value: string;
  onChange: (s: string) => void;
  signalSymbols?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trending = useTrendingSymbols();
  const symbolChanges = useSymbolChanges();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const meta = getSymbolMeta(value);
  const currentHasSignal = signalSymbols?.has(value) ?? false;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "h-8 inline-flex items-center gap-2 px-2.5 rounded-md border border-primary/40 bg-card",
          "hover:bg-primary/10 hover:border-primary/60 transition-colors text-xs font-bold",
        )}
      >
        {/* Badge with signal dot */}
        <span className="relative">
          <span
            className="w-5 h-5 rounded bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-black"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            {meta.badge}
          </span>
          {currentHasSignal && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400 border border-card shadow-[0_0_5px_rgba(251,191,36,0.9)]" />
          )}
        </span>
        <span
          className="text-foreground tracking-widest"
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          {meta.short}
        </span>
        <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 mt-1.5 w-64 z-[100] bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
          <div className="px-3 py-2 border-b border-border/60 text-[10px] font-bold tracking-widest text-muted-foreground">
            INSTRUMENT
          </div>
          <div className="max-h-96 overflow-y-auto">
            {/* ── FOREX ── */}
            <SectionHeader label="FOREX" />
            {FOREX_SYMBOLS.map((sym) => (
              <SymbolRow
                key={sym}
                sym={sym}
                isActive={sym === value}
                change={symbolChanges[sym]}
                hasSignal={signalSymbols?.has(sym)}
                onClick={() => { onChange(sym); setOpen(false); }}
              />
            ))}

            {/* ── CRYPTO ── */}
            <SectionHeader label="CRYPTO" />
            {CRYPTO_SYMBOLS.map((sym) => (
              <SymbolRow
                key={sym}
                sym={sym}
                isActive={sym === value}
                change={symbolChanges[sym]}
                hasSignal={signalSymbols?.has(sym)}
                onClick={() => { onChange(sym); setOpen(false); }}
              />
            ))}

            {/* ── TRENDING ── */}
            {trending.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border/60 text-[10px] font-bold tracking-widest text-amber-400/80">
                  <Flame className="w-3 h-3" />
                  TRENDING · 24H GAINERS
                </div>
                {trending.map((t) => {
                  const isActive = t.symbolKey === value;
                  const m = getSymbolMeta(t.symbolKey);
                  const hasSignal = signalSymbols?.has(t.symbolKey) ?? false;
                  const changeStr = t.priceChange24h > 0
                    ? `+${t.priceChange24h.toFixed(1)}%`
                    : `${t.priceChange24h.toFixed(1)}%`;
                  return (
                    <button
                      key={t.symbolKey}
                      type="button"
                      onClick={() => { onChange(t.symbolKey); setOpen(false); }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                        isActive ? "bg-amber-500/15 text-foreground" : "hover:bg-muted/40 text-foreground/90",
                      )}
                    >
                      <span className="relative shrink-0">
                        <span
                          className={cn(
                            "w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-black",
                            isActive ? "bg-amber-500 text-black" : "bg-amber-500/20 text-amber-400",
                          )}
                          style={{ fontFamily: "var(--app-font-display)" }}
                        >
                          {m.badge}
                        </span>
                        {hasSignal && (
                          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-card shadow-[0_0_5px_rgba(251,191,36,0.9)]" />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold tracking-wider" style={{ fontFamily: "var(--app-font-display)" }}>
                          {m.short}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          Trending #{t.rank}
                        </div>
                      </div>
                      <span className={cn(
                        "text-[10px] font-mono font-bold shrink-0",
                        t.priceChange24h >= 0 ? "text-emerald-400" : "text-rose-400",
                      )}>
                        {changeStr}
                      </span>
                      {hasSignal && <SignalDot />}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
