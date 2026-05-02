import { useGetBacktest } from "@workspace/api-client-react";
import { TrendingUp, TrendingDown, Target, AlertTriangle } from "lucide-react";

function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-rose-400"
        : tone === "warn"
          ? "text-amber-400"
          : "text-foreground";
  return (
    <div className="bg-card/60 border border-border/50 rounded-md p-3 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">
        {label}
      </span>
      <span className={`text-xl font-bold font-mono ${toneClass}`}>{value}</span>
      {sub ? (
        <span className="text-[10px] text-muted-foreground font-mono">{sub}</span>
      ) : null}
    </div>
  );
}

export function BacktestPanel() {
  const { data, isLoading, error } = useGetBacktest();

  if (isLoading) {
    return (
      <div className="border border-border rounded-lg p-6 bg-card flex items-center justify-center text-muted-foreground text-sm font-mono">
        Running backtest…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="border border-rose-500/40 rounded-lg p-6 bg-rose-950/20 text-rose-300 text-sm font-mono">
        Backtest failed to load.
      </div>
    );
  }

  const profitable = data.totalReturnR > 0;
  const winRateOk = data.winRate >= 50;
  const pfOk = data.profitFactor >= 1.5;
  const ddOk = Math.abs(data.maxDrawdownR) < Math.abs(data.totalReturnR);

  return (
    <div className="border border-border rounded-lg bg-card flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-widest font-mono">
            STRATEGY BACKTEST
          </h2>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">
          {data.startDate} → {data.endDate} · {data.totalBars} bars
        </span>
      </div>

      {/* Verdict banner */}
      <div
        className={`px-4 py-3 border-b border-border/50 flex items-center gap-3 ${
          profitable ? "bg-emerald-950/20" : "bg-rose-950/20"
        }`}
      >
        {profitable ? (
          <TrendingUp className="w-5 h-5 text-emerald-400" />
        ) : (
          <TrendingDown className="w-5 h-5 text-rose-400" />
        )}
        <div className="flex-1">
          <div
            className={`text-sm font-bold font-mono ${
              profitable ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {profitable ? "PROFITABLE EDGE" : "NEGATIVE EDGE"} ·{" "}
            {data.totalReturnR > 0 ? "+" : ""}
            {data.totalReturnR}R over {data.totalTrades} trades
          </div>
          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {winRateOk && pfOk && ddOk
              ? "All key metrics passing — viable for live trading at small size."
              : `Caveats: ${[
                  !winRateOk && "win rate <50%",
                  !pfOk && "profit factor <1.5",
                  !ddOk && "drawdown ≥ total return",
                ]
                  .filter(Boolean)
                  .join(", ")}.`}
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-3">
        <StatCard
          label="Win Rate"
          value={`${data.winRate}%`}
          sub={`${data.winningTrades}W / ${data.losingTrades}L`}
          tone={winRateOk ? "good" : "bad"}
        />
        <StatCard
          label="Total Return"
          value={`${data.totalReturnR > 0 ? "+" : ""}${data.totalReturnR}R`}
          sub={`avg ${data.avgReturnR > 0 ? "+" : ""}${data.avgReturnR}R / trade`}
          tone={profitable ? "good" : "bad"}
        />
        <StatCard
          label="Profit Factor"
          value={data.profitFactor.toString()}
          sub="gross win ÷ gross loss"
          tone={pfOk ? "good" : data.profitFactor >= 1 ? "warn" : "bad"}
        />
        <StatCard
          label="Max Drawdown"
          value={`-${data.maxDrawdownR}R`}
          sub="peak-to-trough"
          tone={ddOk ? "neutral" : "warn"}
        />
        <StatCard
          label="BUY Trades"
          value={`${data.buyTrades}`}
          sub={`${data.buyWinRate}% win rate`}
          tone={data.buyWinRate >= 50 ? "good" : "bad"}
        />
        <StatCard
          label="SELL Trades"
          value={`${data.sellTrades}`}
          sub={`${data.sellWinRate}% win rate`}
          tone={data.sellWinRate >= 50 ? "good" : "bad"}
        />
        <StatCard
          label="TP1 / TP2 Hits"
          value={`${data.tp1Hits} / ${data.tp2Hits}`}
          sub={`${data.slHits} stops hit`}
        />
        <StatCard
          label="Avg Hold"
          value={`${data.avgBarsHeld}`}
          sub="bars per trade"
        />
      </div>

      {/* Recent trades */}
      <div className="border-t border-border/50">
        <div className="px-4 py-2 text-[10px] uppercase tracking-widest text-muted-foreground font-mono flex items-center justify-between">
          <span>Recent Trades (last {Math.min(data.trades.length, 50)})</span>
          <span>R-Multiple</span>
        </div>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-card border-b border-border/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left px-3 py-1.5 font-normal">Date</th>
                <th className="text-left px-2 py-1.5 font-normal">Side</th>
                <th className="text-right px-2 py-1.5 font-normal">Entry</th>
                <th className="text-right px-2 py-1.5 font-normal">Exit</th>
                <th className="text-center px-2 py-1.5 font-normal">Outcome</th>
                <th className="text-right px-2 py-1.5 font-normal">Bars</th>
                <th className="text-right px-3 py-1.5 font-normal">R</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.map((t, idx) => {
                const isWin = t.rMultiple > 0;
                const sideColor =
                  t.direction === "BUY" ? "text-emerald-400" : "text-rose-400";
                const outcomeColor =
                  t.outcome === "TP2"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : t.outcome === "TP1"
                      ? "bg-emerald-500/10 text-emerald-300"
                      : t.outcome === "SL"
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-amber-500/20 text-amber-300";
                return (
                  <tr
                    key={`${t.entryDate}-${idx}`}
                    className="border-b border-border/30 hover:bg-muted/20"
                  >
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {t.entryDate}
                    </td>
                    <td className={`px-2 py-1.5 font-bold ${sideColor}`}>
                      {t.direction}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      ${t.entry.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      ${t.exitPrice.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] ${outcomeColor}`}
                      >
                        {t.outcome}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {t.barsHeld}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-bold ${
                        isWin ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {isWin ? "+" : ""}
                      {t.rMultiple.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="px-4 py-2.5 border-t border-border/50 bg-muted/10 flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">
          Backtest assumes worst-case intrabar fill order (SL before TP when both
          could fill same day). Uses Yahoo Finance SI=F daily candles as proxy for
          OANDA spot. Past performance does not guarantee future results.
        </p>
      </div>
    </div>
  );
}
