import { cn } from "@/lib/utils";

type SignalValue = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL" | "buy" | "sell" | "neutral";

interface SignalBadgeProps {
  signal: SignalValue;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function SignalBadge({ signal, className, size = "sm" }: SignalBadgeProps) {
  const normalizedSignal = signal.toUpperCase() as "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
  
  const getBadgeColor = (s: string) => {
    if (s.includes("BUY")) return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
    if (s.includes("SELL")) return "bg-rose-500/15 text-rose-500 border-rose-500/30";
    return "bg-slate-500/15 text-slate-400 border-slate-500/30";
  };

  const getLabel = (s: string) => {
    return s.replace("_", " ");
  };

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-[2px] border font-mono font-medium",
        size === "sm" && "px-1.5 py-0.5 text-[10px]",
        size === "md" && "px-2 py-1 text-xs",
        size === "lg" && "px-3 py-1.5 text-sm",
        getBadgeColor(normalizedSignal),
        className
      )}
    >
      {getLabel(normalizedSignal)}
    </div>
  );
}