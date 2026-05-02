import { cn } from "@/lib/utils";

export type Timeframe = "1m" | "15m" | "30m" | "1h" | "1d";

const OPTIONS: { value: Timeframe; label: string }[] = [
  { value: "1m", label: "1m" },
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "1d", label: "D" },
];

export function TimeframeSelector({
  value,
  onChange,
}: {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[10px] tracking-widest text-muted-foreground font-bold hidden sm:inline">
        TIMEFRAME
      </span>
      <div className="inline-flex items-center gap-1 bg-card border border-primary/40 rounded-md p-0.5 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
        {OPTIONS.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                "px-2.5 py-1 text-xs font-mono font-bold rounded transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
