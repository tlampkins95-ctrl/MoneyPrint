import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ALL_SYMBOLS, SYMBOLS, type Symbol } from "@/lib/symbols";

export function SymbolSelector({
  value,
  onChange,
}: {
  value: Symbol;
  onChange: (s: Symbol) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const meta = SYMBOLS[value];

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
        <span
          className="w-5 h-5 rounded bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-black"
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          {meta.badge}
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
        <div className="absolute left-0 mt-1.5 w-60 z-[100] bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
          <div className="px-3 py-2 border-b border-border/60 text-[10px] font-bold tracking-widest text-muted-foreground">
            INSTRUMENT
          </div>
          <div className="max-h-80 overflow-y-auto">
            {ALL_SYMBOLS.map((sym) => {
              const m = SYMBOLS[sym];
              const isActive = sym === value;
              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => { onChange(sym); setOpen(false); }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                    isActive
                      ? "bg-primary/15 text-foreground"
                      : "hover:bg-muted/40 text-foreground/90",
                  )}
                >
                  <span
                    className={cn(
                      "w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-black shrink-0",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                    style={{ fontFamily: "var(--app-font-display)" }}
                  >
                    {m.badge}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-xs font-bold tracking-wider"
                      style={{ fontFamily: "var(--app-font-display)" }}
                    >
                      {m.short}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {m.long}
                    </div>
                  </div>
                  {isActive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
