import { useCallback, useEffect, useState } from "react";
import {
  useGetActiveSignals, getGetActiveSignalsQueryKey,
  useGetTradeHistory, getGetTradeHistoryQueryKey,
} from "@workspace/api-client-react";
import type { LevelsDataTradeState, ClosedTrade } from "@workspace/api-client-react";
import {
  TrendingUp, TrendingDown, RefreshCw, AlertTriangle,
  DollarSign, TrendingUp as UpIcon, Wallet,
  CheckCircle2, XCircle, MinusCircle, Trophy, Zap, ZapOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getSymbolMeta } from "@/lib/symbols";
import type { Timeframe } from "@/components/timeframe-selector";

// ── helpers ───────────────────────────────────────────────────────────────────

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fmtUsd(n: number, sign = false): string {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? abs.toFixed(0) : abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  const formatted = `$${s}`;
  if (!sign) return formatted;
  return n >= 0 ? `+${formatted}` : `-${formatted}`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const FILLED_STATES: LevelsDataTradeState[] = [
  "FILLED_PROFIT", "FILLED_DRAWDOWN", "FILLED_TP1", "FILLED_TP2", "FILLED_SL",
];
function isFilled(s: LevelsDataTradeState) { return FILLED_STATES.includes(s); }
function isPending(s: LevelsDataTradeState) { return s === "PENDING"; }

function stateLabel(s: LevelsDataTradeState): { label: string; color: string } {
  if (s === "FILLED_PROFIT")   return { label: "In profit",   color: "text-emerald-400" };
  if (s === "FILLED_DRAWDOWN") return { label: "In drawdown", color: "text-rose-400"    };
  if (s === "FILLED_TP1")      return { label: "At TP1",      color: "text-emerald-300" };
  if (s === "FILLED_TP2")      return { label: "At TP2",      color: "text-emerald-300" };
  if (s === "FILLED_SL")       return { label: "At SL",       color: "text-rose-300"    };
  if (s === "PENDING")         return { label: "Pending",     color: "text-amber-400"   };
  return { label: "Watching", color: "text-zinc-500" };
}

function calcLivePnl(
  signal: "BUY" | "SELL",
  currentPrice: number,
  entryPrice: number,
  stopLoss: number,
  pnlAtSL: number | null,
): number | null {
  if (pnlAtSL === null || entryPrice === 0) return null;
  const slDist = Math.abs(entryPrice - stopLoss);
  if (slDist === 0) return null;
  const dollarsPerPoint = Math.abs(pnlAtSL) / slDist;
  const priceDelta = signal === "BUY" ? currentPrice - entryPrice : entryPrice - currentPrice;
  return priceDelta * dollarsPerPoint;
}

function extractSizing(ps: {
  venue?: "PHEMEX" | "MT5" | "PHEMEX_SPOT";
  achievable?: { pnlAtSL: number; pnlAtTP1: number; pnlAtTP2: number; collateral: number; leverage: number } | null;
  mt5?: { pnlAtSL: number; pnlAtTP1: number; pnlAtTP2: number; lots: number } | null;
  spotToken?: { pnlAtSL: number; pnlAtTP1: number; pnlAtTP2: number; tokenCount: number; tokenSymbol: string } | null;
} | undefined | null) {
  const venue = ps?.venue ?? "PHEMEX";
  if (venue === "MT5") {
    const m = ps?.mt5;
    return { venue, pnlAtSL: m?.pnlAtSL ?? null, pnlAtTP1: m?.pnlAtTP1 ?? null, collateral: null, leverage: null };
  }
  if (venue === "PHEMEX_SPOT") {
    const st = ps?.spotToken;
    return { venue, pnlAtSL: st?.pnlAtSL ?? null, pnlAtTP1: st?.pnlAtTP1 ?? null, collateral: null, leverage: null };
  }
  const a = ps?.achievable;
  return { venue, pnlAtSL: a?.pnlAtSL ?? null, pnlAtTP1: a?.pnlAtTP1 ?? null, collateral: a?.collateral ?? null, leverage: a?.leverage ?? null };
}

// ── outcome badge ─────────────────────────────────────────────────────────────

function OutcomeBadge({ outcome, tp1Hit }: { outcome: ClosedTrade["outcome"]; tp1Hit: boolean }) {
  if (outcome === "TP2") return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
      <Trophy className="w-2.5 h-2.5" /> TP2
    </span>
  );
  if (outcome === "BE_TRAIL") return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-sky-500/15 text-sky-300 border border-sky-500/30">
      <MinusCircle className="w-2.5 h-2.5" /> BE{tp1Hit ? "+TP1" : ""}
    </span>
  );
  if (outcome === "SL") return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-rose-500/15 text-rose-300 border border-rose-500/30">
      <XCircle className="w-2.5 h-2.5" /> SL
    </span>
  );
  if (outcome === "REVERSED") return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-amber-500/15 text-amber-300 border border-amber-500/30">
      <CheckCircle2 className="w-2.5 h-2.5" /> REV
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-zinc-800 text-zinc-500 border border-zinc-700">
      MISS
    </span>
  );
}

// ── summary card ──────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon, label, value, sub, valueColor,
}: {
  icon: React.ElementType; label: string; value: string; sub?: string; valueColor?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-zinc-500 uppercase">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className={cn("text-2xl font-bold font-mono", valueColor ?? "text-zinc-100")}>
        {value}
      </div>
      {sub && <div className="text-[10px] font-mono text-zinc-600">{sub}</div>}
    </div>
  );
}

// ── unrealized row ────────────────────────────────────────────────────────────

const TF_LABEL: Record<string, string> = { "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };
const TF_ORDER: Record<string, number>  = { "1h": 0, "4h": 1, "1d": 2, "1w": 3 };

interface PnlRow {
  symbol: string;
  timeframe: string;
  signal: "BUY" | "SELL";
  tradeState: LevelsDataTradeState;
  currentPrice: number;
  entryPrice: number;
  stopLoss: number;
  pnlAtSL: number | null;
  pnlAtTP1: number | null;
  collateral: number | null;
  leverage: number | null;
  venue: "PHEMEX" | "MT5" | "PHEMEX_SPOT";
  openedAt?: number;
}

function SignalPnlRow({ r, onClick }: { r: PnlRow; onClick: () => void }) {
  const meta = getSymbolMeta(r.symbol);
  const isBuy = r.signal === "BUY";
  const filled = isFilled(r.tradeState);
  const { label: stLabel, color: stColor } = stateLabel(r.tradeState);

  const livePnl = filled
    ? calcLivePnl(r.signal, r.currentPrice, r.entryPrice, r.stopLoss, r.pnlAtSL)
    : null;

  const risk = r.pnlAtSL !== null ? Math.abs(r.pnlAtSL) : null;
  const tp1  = r.pnlAtTP1 ?? null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-lg border border-zinc-800/70 bg-zinc-900/30 hover:bg-white/[0.04] transition-colors px-3 py-2.5 flex items-center gap-3"
    >
      <div className={cn("w-0.5 self-stretch rounded-full shrink-0", isBuy ? "bg-emerald-500" : "bg-rose-500")} />
      <div className="flex flex-col gap-0.5 min-w-[80px]">
        <span className="text-[12px] font-bold text-zinc-100 leading-none">{meta.short ?? r.symbol}</span>
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-mono text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded">
            {TF_LABEL[r.timeframe] ?? r.timeframe}
          </span>
          <span className={cn("text-[9px] font-bold", isBuy ? "text-emerald-400" : "text-rose-400")}>
            {r.signal}
          </span>
        </div>
      </div>
      <div className={cn("text-[10px] font-mono min-w-[72px]", stColor)}>{stLabel}</div>
      <div className="flex flex-col gap-0.5 min-w-[72px]">
        {r.collateral !== null ? (
          <span className="text-[11px] font-mono text-zinc-300">
            ${r.collateral.toFixed(0)}
            {r.leverage !== null && <span className="text-zinc-500">×{r.leverage.toFixed(0)}</span>}
          </span>
        ) : (
          <span className="text-[10px] font-mono text-zinc-600">{r.venue}</span>
        )}
        {risk !== null && (
          <span className="text-[9px] font-mono text-zinc-500">risk ${risk.toFixed(2)}</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 ml-auto text-right">
        {livePnl !== null ? (
          <span className={cn("text-[13px] font-bold font-mono", livePnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
            {fmtUsd(livePnl, true)}
          </span>
        ) : (
          <span className="text-[11px] font-mono text-zinc-600">—</span>
        )}
        {tp1 !== null && (
          <span className="text-[9px] font-mono text-zinc-500">TP1 {fmtUsd(tp1, true)}</span>
        )}
        {r.openedAt != null && (
          <span className="text-[9px] font-mono text-zinc-600">
            {fmtDate(r.openedAt)} {new Date(r.openedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    </button>
  );
}

// ── realized row ──────────────────────────────────────────────────────────────

function RealizedRow({ trade, dollarRisk }: { trade: ClosedTrade; dollarRisk: number }) {
  const meta = getSymbolMeta(trade.symbol);
  const isBuy = trade.signal === "BUY";
  const isReal = trade.outcome !== "MISSED" && trade.outcome !== "REVERSED";
  const pnl = isReal ? trade.rMultiple * dollarRisk : null;
  const tfLabel = TF_LABEL[trade.timeframe] ?? trade.timeframe;

  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2.5 flex items-center gap-3">
      <div className={cn("w-0.5 self-stretch rounded-full shrink-0", isBuy ? "bg-emerald-500" : "bg-rose-500")} />

      {/* symbol + TF */}
      <div className="flex flex-col gap-0.5 min-w-[80px]">
        <span className="text-[12px] font-bold text-zinc-100 leading-none">{meta.short ?? trade.symbol}</span>
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-mono text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded">{tfLabel}</span>
          <span className={cn("text-[9px] font-bold", isBuy ? "text-emerald-400" : "text-rose-400")}>
            {trade.signal}
          </span>
        </div>
      </div>

      {/* outcome badge */}
      <OutcomeBadge outcome={trade.outcome} tp1Hit={trade.tp1Hit} />

      {/* R multiple */}
      <span className={cn(
        "text-[11px] font-mono min-w-[48px]",
        isReal
          ? trade.rMultiple >= 0 ? "text-emerald-400" : "text-rose-400"
          : "text-zinc-500",
      )}>
        {isReal ? `${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R` : "—"}
      </span>

      {/* date */}
      <span className="text-[9px] font-mono text-zinc-600 hidden sm:block">
        {fmtDate(trade.closedAt)}
      </span>

      {/* dollar P&L */}
      <div className="ml-auto text-right">
        {pnl !== null ? (
          <span className={cn("text-[13px] font-bold font-mono", pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
            {fmtUsd(pnl, true)}
          </span>
        ) : (
          <span className="text-[11px] font-mono text-zinc-600">—</span>
        )}
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function PnlTab({ onSelect }: { onSelect: (s: string, t: Timeframe) => void }) {
  const accountSize = readNumber("screener.accountSize", 500);
  const riskPct     = readNumber("screener.riskPct",     1);
  const maxLeverage = readNumber("screener.maxLeverage", 100);
  const mt5Lots     = readNumber("screener.mt5Lots",     0.01);

  // Dollar risk per trade (approximate — used for realized P&L estimation)
  const dollarRisk = accountSize * (riskPct / 100);

  const params = { accountSize, riskPct, maxLeverage, mt5Lots };
  const {
    data, isLoading, isError, refetch, isFetching,
  } = useGetActiveSignals(params, {
    query: {
      queryKey: getGetActiveSignalsQueryKey(params),
      refetchInterval: 15_000,
    },
  });

  const {
    data: histData, isLoading: histLoading,
  } = useGetTradeHistory(
    { limit: 50 },
    {
      query: {
        queryKey: getGetTradeHistoryQueryKey({ limit: 50 }),
        staleTime: 2 * 60_000,
        refetchInterval: 5 * 60_000,
      },
    },
  );

  const [lastFetched, setLastFetched] = useState<Date>(new Date());
  useEffect(() => {
    if (data?.lastUpdated) setLastFetched(new Date(data.lastUpdated));
  }, [data?.lastUpdated]);

  // ── Phemex auto-trader status ────────────────────────────────────────────
  interface PhemexStatus { keysPresent: boolean; enabled: boolean; usdtBalance: number | null; testnet: boolean }
  const [phemex, setPhemex] = useState<PhemexStatus | null>(null);
  const [phemexToggling, setPhemexToggling] = useState(false);

  const fetchPhemexStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/phemex/status");
      if (r.ok) setPhemex(await r.json() as PhemexStatus);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void fetchPhemexStatus(); }, [fetchPhemexStatus]);

  const togglePhemex = useCallback(async () => {
    if (!phemex || phemexToggling) return;
    setPhemexToggling(true);
    try {
      const r = await fetch("/api/phemex/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !phemex.enabled }),
      });
      if (r.ok) await fetchPhemexStatus();
    } finally {
      setPhemexToggling(false);
    }
  }, [phemex, phemexToggling, fetchPhemexStatus]);

  const signals = data?.signals ?? [];
  const rows: PnlRow[] = signals
    .filter((s) => s.levels.signal === "BUY" || s.levels.signal === "SELL")
    .map((s) => {
      const sizing = extractSizing(s.levels.positionSizing);
      return {
        symbol:       s.symbol,
        timeframe:    s.timeframe,
        signal:       s.levels.signal as "BUY" | "SELL",
        tradeState:   s.levels.tradeState,
        currentPrice: s.levels.currentPrice,
        entryPrice:   s.levels.entryPrice,
        stopLoss:     s.levels.stopLoss,
        pnlAtSL:      sizing.pnlAtSL,
        pnlAtTP1:     sizing.pnlAtTP1,
        collateral:   sizing.collateral,
        leverage:     sizing.leverage,
        venue:        sizing.venue,
        openedAt:     s.levels.openedAt ?? undefined,
      };
    })
    .sort((a, b) => {
      const rankA = isFilled(a.tradeState) ? 0 : isPending(a.tradeState) ? 1 : 2;
      const rankB = isFilled(b.tradeState) ? 0 : isPending(b.tradeState) ? 1 : 2;
      if (rankA !== rankB) return rankA - rankB;
      return (TF_ORDER[a.timeframe] ?? 9) - (TF_ORDER[b.timeframe] ?? 9) || a.symbol.localeCompare(b.symbol);
    });

  const filledRows  = rows.filter((r) => isFilled(r.tradeState));
  const pendingRows = rows.filter((r) => isPending(r.tradeState));

  // Unrealized aggregates
  const totalRisk = rows.reduce((acc, r) => acc + (r.pnlAtSL !== null ? Math.abs(r.pnlAtSL) : 0), 0);
  const totalCollateral = rows.reduce((acc, r) => acc + (r.collateral ?? 0), 0);
  const totalUnrealised = filledRows.reduce((acc, r) => {
    const lp = calcLivePnl(r.signal, r.currentPrice, r.entryPrice, r.stopLoss, r.pnlAtSL);
    return acc + (lp ?? 0);
  }, 0);
  const potentialTP1 = rows.reduce((acc, r) => acc + (r.pnlAtTP1 ?? 0), 0);

  // Realized aggregates from trade history
  const closedTrades = histData?.trades ?? [];
  const realTrades   = closedTrades.filter((t) => t.outcome !== "MISSED" && t.outcome !== "REVERSED");
  const realizedPnl  = realTrades.reduce((sum, t) => sum + t.rMultiple * dollarRisk, 0);
  const winCount     = histData?.winCount ?? 0;
  const lossCount    = histData?.lossCount ?? 0;
  const totalClosed  = winCount + lossCount;
  const winRate      = totalClosed > 0 ? (winCount / totalClosed) * 100 : null;

  // Per-timeframe breakdown
  const TF_LIST = ["1h", "4h", "1d", "1w"] as const;
  const tfStats = TF_LIST.map((tf) => {
    const tfTrades = realTrades.filter((t) => t.timeframe === tf);
    const wins  = tfTrades.filter((t) => t.outcome === "TP2" || t.outcome === "BE_TRAIL").length;
    const losses = tfTrades.filter((t) => t.outcome === "SL").length;
    const totalR = tfTrades.reduce((s, t) => s + t.rMultiple, 0);
    const pnl    = tfTrades.reduce((s, t) => s + t.rMultiple * dollarRisk, 0);
    return { tf, trades: tfTrades.length, wins, losses, totalR, pnl };
  }).filter((s) => s.trades > 0);

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full pb-6">

      {/* ── PHEMEX AUTO-TRADER ──────────────────────────────────────── */}
      {phemex?.keysPresent && (
        <div className={cn(
          "rounded-xl border px-4 py-3 flex items-center gap-3 transition-colors",
          phemex.enabled
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-zinc-700/60 bg-zinc-900/40",
        )}>
          {phemex.enabled
            ? <Zap className="w-4 h-4 text-emerald-400 shrink-0" />
            : <ZapOff className="w-4 h-4 text-zinc-500 shrink-0" />
          }
          <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <span className={cn(
              "text-[11px] font-bold tracking-wider",
              phemex.enabled ? "text-emerald-300" : "text-zinc-400",
            )}>
              PHEMEX AUTO-TRADER {phemex.enabled ? "ON" : "OFF"}
              {phemex.testnet && <span className="ml-1.5 text-amber-400">TESTNET</span>}
            </span>
            <span className="text-[10px] font-mono text-zinc-500 truncate">
              {phemex.enabled
                ? "Placing live orders on BUY/SELL signals · trending markets only"
                : "No orders will be placed until enabled"}
              {phemex.usdtBalance !== null && (
                <span className="ml-2 text-zinc-400">${phemex.usdtBalance.toFixed(2)} USDT available</span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void togglePhemex()}
            disabled={phemexToggling}
            className={cn(
              "shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-bold tracking-wider transition-colors disabled:opacity-50",
              phemex.enabled
                ? "bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25"
                : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25",
            )}
          >
            {phemexToggling ? "..." : phemex.enabled ? "DISABLE" : "ENABLE"}
          </button>
        </div>
      )}

      {/* ── UNREALIZED ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2
            className="text-xs font-bold tracking-[0.18em] text-zinc-300"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            UNREALIZED P&L
          </h2>
          <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-600">
            <span>{lastFetched.toLocaleTimeString()}</span>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 hover:bg-white/5 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <StatCard
            icon={Wallet}
            label="Total wagered"
            value={totalCollateral > 0 ? fmtUsd(totalCollateral) : fmtUsd(totalRisk)}
            sub={totalCollateral > 0 ? `${fmtUsd(totalRisk)} at risk` : `across ${rows.length} signals`}
          />
          <StatCard
            icon={DollarSign}
            label="Unrealised P&L"
            value={filledRows.length > 0 ? fmtUsd(totalUnrealised, true) : "—"}
            sub={filledRows.length > 0 ? `${filledRows.length} filled` : "no filled positions"}
            valueColor={
              filledRows.length === 0 ? "text-zinc-500"
              : totalUnrealised >= 0  ? "text-emerald-400"
              : "text-rose-400"
            }
          />
          <StatCard
            icon={UpIcon}
            label="Potential at TP1"
            value={potentialTP1 > 0 ? fmtUsd(potentialTP1, true) : "—"}
            sub={`if all ${rows.length} signal${rows.length !== 1 ? "s" : ""} hit TP1`}
            valueColor={potentialTP1 > 0 ? "text-emerald-400" : "text-zinc-500"}
          />
        </div>

        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-white/[0.03] border border-zinc-800 animate-pulse" />
            ))}
          </div>
        )}
        {isError && (
          <div className="flex items-center gap-2 text-xs text-rose-400 font-mono p-4 rounded-lg border border-rose-500/20 bg-rose-500/5">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Failed to load signals.</span>
            <button onClick={() => refetch()} className="underline ml-auto">retry</button>
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="text-center py-8 text-xs font-mono text-zinc-500">
            No active signals — all symbols in WAIT.
          </div>
        )}
        {!isLoading && !isError && rows.length > 0 && (
          <div className="space-y-4">
            {filledRows.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-400/80 px-1">
                  Filled positions ({filledRows.length})
                </div>
                {filledRows.map((r) => (
                  <SignalPnlRow key={`${r.symbol}-${r.timeframe}`} r={r} onClick={() => onSelect(r.symbol, r.timeframe as Timeframe)} />
                ))}
              </div>
            )}
            {pendingRows.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-amber-400/80 px-1">
                  Pending limits ({pendingRows.length})
                </div>
                {pendingRows.map((r) => (
                  <SignalPnlRow key={`${r.symbol}-${r.timeframe}`} r={r} onClick={() => onSelect(r.symbol, r.timeframe as Timeframe)} />
                ))}
              </div>
            )}
            {rows.filter((r) => !isFilled(r.tradeState) && !isPending(r.tradeState)).length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-1">
                  Other ({rows.filter((r) => !isFilled(r.tradeState) && !isPending(r.tradeState)).length})
                </div>
                {rows.filter((r) => !isFilled(r.tradeState) && !isPending(r.tradeState)).map((r) => (
                  <SignalPnlRow key={`${r.symbol}-${r.timeframe}`} r={r} onClick={() => onSelect(r.symbol, r.timeframe as Timeframe)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── REALIZED ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2
            className="text-xs font-bold tracking-[0.18em] text-zinc-300"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            REALIZED P&L
          </h2>
          <span className="text-[10px] font-mono text-zinc-600">
            last {closedTrades.length} closed · est. at {riskPct}% risk
          </span>
        </div>

        {/* realized summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <StatCard
            icon={DollarSign}
            label="Realized P&L"
            value={realTrades.length > 0 ? fmtUsd(realizedPnl, true) : "—"}
            sub={realTrades.length > 0 ? `${realTrades.length} closed trade${realTrades.length !== 1 ? "s" : ""}` : "no closed trades yet"}
            valueColor={
              realTrades.length === 0 ? "text-zinc-500"
              : realizedPnl >= 0      ? "text-emerald-400"
              : "text-rose-400"
            }
          />
          <StatCard
            icon={Trophy}
            label="Win rate"
            value={winRate !== null ? `${winRate.toFixed(0)}%` : "—"}
            sub={totalClosed > 0 ? `${winCount}W / ${lossCount}L` : "no completed trades"}
            valueColor={
              winRate === null  ? "text-zinc-500"
              : winRate >= 50   ? "text-emerald-400"
              : winRate >= 40   ? "text-amber-400"
              : "text-rose-400"
            }
          />
          <StatCard
            icon={TrendingUp}
            label="Total R"
            value={histData ? `${histData.totalR >= 0 ? "+" : ""}${histData.totalR.toFixed(2)}R` : "—"}
            sub={dollarRisk > 0 ? `${fmtUsd(dollarRisk)} per 1R` : undefined}
            valueColor={
              !histData           ? "text-zinc-500"
              : histData.totalR >= 0 ? "text-emerald-400"
              : "text-rose-400"
            }
          />
        </div>

        {/* per-timeframe breakdown */}
        {tfStats.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {tfStats.map(({ tf, wins, losses, totalR, pnl }) => {
              const wr = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
              const positive = totalR >= 0;
              return (
                <div
                  key={tf}
                  className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2.5 flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono font-bold text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">
                      {TF_LABEL[tf] ?? tf.toUpperCase()}
                    </span>
                    <span className={cn("text-[12px] font-bold font-mono", positive ? "text-emerald-400" : "text-rose-400")}>
                      {positive ? "+" : ""}{totalR.toFixed(2)}R
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-zinc-500">
                      {wins}W / {losses}L{wr !== null ? ` · ${wr}%` : ""}
                    </span>
                    <span className={cn("text-[11px] font-mono font-semibold", positive ? "text-emerald-400" : "text-rose-400")}>
                      {fmtUsd(pnl, true)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* closed trade list */}
        {histLoading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 rounded-lg bg-white/[0.03] border border-zinc-800 animate-pulse" />
            ))}
          </div>
        )}
        {!histLoading && closedTrades.length === 0 && (
          <div className="text-center py-8 text-xs font-mono text-zinc-500">
            No closed trades yet — they appear here once signals exit via TP or SL.
          </div>
        )}
        {!histLoading && closedTrades.length > 0 && (
          <div className="space-y-1.5">
            {closedTrades.map((t) => (
              <RealizedRow key={t.id} trade={t} dollarRisk={dollarRisk} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
