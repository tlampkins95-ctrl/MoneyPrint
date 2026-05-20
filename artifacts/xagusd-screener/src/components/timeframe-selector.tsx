import { cn } from "@/lib/utils";

export type Timeframe = "15m" | "30m" | "1h" | "1d";

const OPTIONS: { value: Timeframe; label: string }[] = [
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "1d", label: "D" },
];

export function TimeframeSelector({
  value,
  onChange,
  signalTimeframes,
}: {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
  signalTimeframes?: ReadonlySet<string>;
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[10px] tracking-widest text-muted-foreground font-bold hidden sm:inline">
        TIMEFRAME
      </span>
      <div className="inline-flex items-center gap-1 bg-card border border-primary/40 rounded-md p-0.5 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
        {OPTIONS.map((opt) => {
          const active = opt.value === value;
          const hasSignal = signalTimeframes?.has(opt.value) ?? false;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                "relative px-2.5 py-1 text-xs font-mono font-bold rounded transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
              )}
            >
              {opt.label}
              {hasSignal && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.8)]" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
