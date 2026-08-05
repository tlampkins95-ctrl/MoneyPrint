import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw, AlertTriangle, DollarSign, Trophy, TrendingUp,
  CheckCircle2, XCircle, MinusCircle, Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getSymbolMeta } from "@/lib/symbols";

// Alert-only FIB786 strategy — no real orders placed, so this never shows up
// in the Phemex/MT5-backed "Filled Positions"/"Pending Limits" panel on the
// P&L tab. This panel reads the same /api/fib786-history endpoint directly
// (not the generated api-client, since fib786-history isn't in api-spec yet)
// so real (non-backtest) FIB786 performance is actually visible somewhere.

interface Fib786ActiveAlert {
  symbolKey: string;
  entryPrice: number;
  stopLoss: number;
  initialSl: number;
  tp1: number;
  tp2: number;
  tp1Filled: boolean;
  tp2Filled: boolean;
  firedAt: number;
  lastUpdateAt: number;
}

interface Fib786ClosedTrade {
  id: number;
  key: string;
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp1Filled: boolean;
  tp2Filled: boolean;
  exitPrice: number;
  outcome: "FULL_SL" | "BE_AFTER_TP1" | "TRAIL_STOP" | "MANUAL";
  rMultiple: number;
  firedAt: number;
  closedAt: number;
}

interface Fib786HistoryResponse {
  closedTrades: Fib786ClosedTrade[];
  activeAlerts: Fib786ActiveAlert[];
  stats: { totalClosed: number; wins: number; losses: number; totalR: number; winRate: number };
  note?: string;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function StatCard({
  icon: Icon, label, value, sub, valueColor,
}: { icon: React.ElementType; label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-zinc-500 uppercase">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className={cn("text-2xl font-bold font-mono", valueColor ?? "text-zinc-100")}>{value}</div>
      {sub && <div className="text-[10px] font-mono text-zinc-600">{sub}</div>}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: Fib786ClosedTrade["outcome"] }) {
  if (outcome === "TRAIL_STOP" || outcome === "BE_AFTER_TP1") return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-sky-500/15 text-sky-300 border border-sky-500/30">
      <MinusCircle className="w-2.5 h-2.5" /> {outcome === "TRAIL_STOP" ? "TRAIL" : "BE+TP1"}
    </span>
  );
  if (outcome === "FULL_SL") return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-rose-500/15 text-rose-300 border border-rose-500/30">
      <XCircle className="w-2.5 h-2.5" /> SL
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-zinc-800 text-zinc-500 border border-zinc-700">
      <CheckCircle2 className="w-2.5 h-2.5" /> MANUAL
    </span>
  );
}

function progressLabel(a: Fib786ActiveAlert): { label: string; color: string } {
  if (a.tp2Filled) return { label: "TP2 filled — trailing runner", color: "text-emerald-300" };
  if (a.tp1Filled) return { label: "TP1 filled — stop at breakeven", color: "text-sky-300" };
  return { label: "Open — awaiting TP1/SL", color: "text-amber-400" };
}

function ActiveAlertRow({ a }: { a: Fib786ActiveAlert }) {
  const meta = getSymbolMeta(a.symbolKey);
  const { label, color } = progressLabel(a);
  const riskDist = a.entryPrice - a.initialSl;
  const stopPct = riskDist > 0 ? ((a.stopLoss - a.initialSl) / riskDist) * 100 : 0;

  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2.5 flex items-center gap-3">
      <div className="w-0.5 self-stretch rounded-full shrink-0 bg-emerald-500" />
      <div className="flex flex-col gap-0.5 min-w-[90px]">
        <span className="text-[12px] font-bold text-zinc-100 leading-none">{meta.short ?? a.symbolKey}</span>
        <span className="text-[9px] font-mono text-zinc-500">
          fired {fmtDate(a.firedAt)} {fmtTime(a.firedAt)}
        </span>
      </div>
      <div className={cn("text-[10px] font-mono min-w-[168px]", color)}>{label}</div>
      <div className="flex flex-col gap-0.5 min-w-[100px] font-mono text-[10px] text-zinc-500">
        <span>entry {a.entryPrice}</span>
        <span>stop {a.stopLoss}{stopPct > 0.5 ? <span className="text-emerald-500"> (+{stopPct.toFixed(0)}%R)</span> : null}</span>
      </div>
      <div className="ml-auto flex flex-col gap-0.5 text-right font-mono text-[10px]">
        <span className={cn(a.tp1Filled ? "text-emerald-400" : "text-zinc-600")}>TP1 {a.tp1}{a.tp1Filled ? " ✓" : ""}</span>
        <span className={cn(a.tp2Filled ? "text-emerald-400" : "text-zinc-600")}>TP2 {a.tp2}{a.tp2Filled ? " ✓" : ""}</span>
      </div>
    </div>
  );
}

function ClosedTradeRow({ t }: { t: Fib786ClosedTrade }) {
  const meta = getSymbolMeta(t.symbol);
  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2.5 flex items-center gap-3">
      <div className={cn("w-0.5 self-stretch rounded-full shrink-0", t.rMultiple >= 0 ? "bg-emerald-500" : "bg-rose-500")} />
      <div className="flex flex-col gap-0.5 min-w-[90px]">
        <span className="text-[12px] font-bold text-zinc-100 leading-none">{meta.short ?? t.symbol}</span>
        <span className="text-[9px] font-mono text-zinc-500">{fmtDate(t.closedAt)}</span>
      </div>
      <OutcomeBadge outcome={t.outcome} />
      <span className={cn("text-[11px] font-mono min-w-[48px]", t.rMultiple >= 0 ? "text-emerald-400" : "text-rose-400")}>
        {t.rMultiple >= 0 ? "+" : ""}{t.rMultiple.toFixed(2)}R
      </span>
      <span className="ml-auto text-[10px] font-mono text-zinc-600">
        {t.entryPrice} → {t.exitPrice}
      </span>
    </div>
  );
}

export function Fib786Panel() {
  const [data, setData] = useState<Fib786HistoryResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/fib786-history?limit=100");
      if (!r.ok) throw new Error(String(r.status));
      const json = await r.json() as Fib786HistoryResponse;
      setData(json);
      setError(false);
      setLastFetched(new Date());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const activeAlerts = data?.activeAlerts ?? [];
  const closedTrades = data?.closedTrades ?? [];
  const stats = data?.stats;

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full pb-6">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 flex items-center gap-3">
        <Radio className="w-4 h-4 text-emerald-400 shrink-0" />
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[11px] font-bold tracking-wider text-emerald-300">FIB786 — ALERT ONLY</span>
          <span className="text-[10px] font-mono text-zinc-500">
            No real orders placed. Entries here are Telegram/push alerts for manual execution — this is why they never appear in the P&amp;L tab's Filled Positions/Pending Limits (that panel only reflects real Phemex/MT5 fills).
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold tracking-[0.18em] text-zinc-300" style={{ fontFamily: "var(--app-font-display)" }}>
            REAL PERFORMANCE
          </h2>
          <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-600">
            {lastFetched && <span>{lastFetched.toLocaleTimeString()}</span>}
            <button
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 hover:bg-white/5 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <StatCard
            icon={DollarSign}
            label="Total R"
            value={stats ? `${stats.totalR >= 0 ? "+" : ""}${stats.totalR.toFixed(2)}R` : "—"}
            sub={stats ? `${stats.totalClosed} closed trade${stats.totalClosed !== 1 ? "s" : ""}` : undefined}
            valueColor={!stats || stats.totalClosed === 0 ? "text-zinc-500" : stats.totalR >= 0 ? "text-emerald-400" : "text-rose-400"}
          />
          <StatCard
            icon={Trophy}
            label="Win rate"
            value={stats && stats.totalClosed > 0 ? `${stats.winRate.toFixed(0)}%` : "—"}
            sub={stats && stats.totalClosed > 0 ? `${stats.wins}W / ${stats.losses}L` : "no closed trades yet"}
            valueColor={
              !stats || stats.totalClosed === 0 ? "text-zinc-500"
              : stats.winRate >= 50 ? "text-emerald-400"
              : stats.winRate >= 40 ? "text-amber-400"
              : "text-rose-400"
            }
          />
          <StatCard
            icon={TrendingUp}
            label="Open alerts"
            value={String(activeAlerts.length)}
            sub={activeAlerts.filter((a) => a.tp1Filled).length > 0 ? `${activeAlerts.filter((a) => a.tp1Filled).length} past TP1` : "tracking entries"}
          />
        </div>

        {stats && stats.totalClosed > 0 && stats.totalClosed < 10 && (
          <div className="flex items-center gap-2 text-[10px] font-mono text-amber-400/90 px-1">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            Small sample ({stats.totalClosed} closed) — not enough data yet to compare against the 69.5% backtest win rate.
          </div>
        )}

        {loading && !data && (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-white/[0.03] border border-zinc-800 animate-pulse" />
            ))}
          </div>
        )}
        {error && !data && (
          <div className="flex items-center gap-2 text-xs text-rose-400 font-mono p-4 rounded-lg border border-rose-500/20 bg-rose-500/5">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Failed to load FIB786 history.</span>
            <button onClick={() => void load()} className="underline ml-auto">retry</button>
          </div>
        )}
        {data?.note && (
          <div className="text-[10px] font-mono text-zinc-500 px-1">{data.note}</div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-xs font-bold tracking-[0.18em] text-zinc-300" style={{ fontFamily: "var(--app-font-display)" }}>
          OPEN ALERTS ({activeAlerts.length})
        </h2>
        {!loading && activeAlerts.length === 0 && (
          <div className="text-center py-6 text-xs font-mono text-zinc-500">
            No open FIB786 alerts right now.
          </div>
        )}
        {activeAlerts.length > 0 && (
          <div className="space-y-1.5">
            {activeAlerts
              .slice()
              .sort((a, b) => b.firedAt - a.firedAt)
              .map((a) => <ActiveAlertRow key={a.symbolKey} a={a} />)}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-xs font-bold tracking-[0.18em] text-zinc-300" style={{ fontFamily: "var(--app-font-display)" }}>
          CLOSED TRADES ({closedTrades.length})
        </h2>
        {!loading && closedTrades.length === 0 && (
          <div className="text-center py-6 text-xs font-mono text-zinc-500">
            No closed FIB786 trades yet — they appear here once an alert hits stop or trails out.
          </div>
        )}
        {closedTrades.length > 0 && (
          <div className="space-y-1.5">
            {closedTrades.map((t) => <ClosedTradeRow key={t.id} t={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}
