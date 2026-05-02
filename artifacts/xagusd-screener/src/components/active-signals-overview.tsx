import { useEffect, useState } from "react";
import { useGetActiveSignals, getGetActiveSignalsQueryKey } from "@workspace/api-client-react";
import type { LevelsDataTradeState } from "@workspace/api-client-react";
import { TrendingUp, TrendingDown, RefreshCw, AlertTriangle, Target, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { SYMBOLS, fmtPrice, type Symbol } from "@/lib/symbols";
import type { Timeframe } from "@/components/timeframe-selector";

const TF_LABEL: Record<Timeframe, string> = {
  "15m": "15M",
  "30m": "30M",
  "1h": "1H",
  "1d": "1D",
};

const TF_ORDER: Record<Timeframe, number> = {
  "1d": 0,
  "1h": 1,
  "30m": 2,
  "15m": 3,
};

// Group signals by typed lifecycle state (server-authoritative). NEVER parse
// signalReason text — that's coupled to describeFrozenTrade's wording and
// breaks silently when the prose changes. See LevelsData.tradeState.
const FILLED_STATES: LevelsDataTradeState[] = [
  "FILLED_PROFIT",
  "FILLED_DRAWDOWN",
  "FILLED_TP1",
  "FILLED_TP2",
  "FILLED_SL",
];
function isFilled(state: LevelsDataTradeState): boolean {
  return FILLED_STATES.includes(state);
}
function isPending(state: LevelsDataTradeState): boolean {
  return state === "PENDING";
}

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fmtUsd(n: number, sign = true): string {
  const abs = Math.abs(n);
  const s = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  if (!sign) return `$${s}`;
  return n >= 0 ? `+$${s}` : `-$${s}`;
}

interface RowProps {
  symbol: Symbol;
  timeframe: Timeframe;
  signal: "BUY" | "SELL";
  signalReason: string;
  currentPrice: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardRatio: number;
  // Venue-tagged P&L: pnls are sourced from the venue's projection block on
  // the server (achievable for JUP, mt5 for MT5) so the dollar figures here
  // always match what the SignalPanel shows for the same symbol/timeframe.
  venue: "JUP" | "MT5";
  pnlAtSL: number | null;
  pnlAtTP1: number | null;
  pnlAtTP2: number | null;
  // JUP-only fields (null for MT5 venue)
  collateral: number | null;
  leverage: number | null;
  // MT5-only fields (null for JUP venue)
  mt5Lots: number | null;
  onClick: () => void;
  highlighted: boolean;
}

// Pull the venue + projection fields off a server signal in one place so the
// three SignalRow call sites (filled/pending/other) stay in lockstep. If a
// new venue/field gets added, only this helper changes — no risk of the three
// blocks drifting apart.
function toRowSizing(ps: {
  venue?: "JUP" | "MT5";
  achievable?: { pnlAtSL: number; pnlAtTP1: number; pnlAtTP2: number; collateral: number; leverage: number } | null;
  mt5?: { pnlAtSL: number; pnlAtTP1: number; pnlAtTP2: number; lots: number } | null;
} | undefined | null) {
  const venue: "JUP" | "MT5" = ps?.venue ?? "JUP";
  if (venue === "MT5") {
    const m = ps?.mt5;
    return {
      venue,
      pnlAtSL: m?.pnlAtSL ?? null,
      pnlAtTP1: m?.pnlAtTP1 ?? null,
      pnlAtTP2: m?.pnlAtTP2 ?? null,
      collateral: null,
      leverage: null,
      mt5Lots: m?.lots ?? null,
    };
  }
  const a = ps?.achievable;
  return {
    venue,
    pnlAtSL: a?.pnlAtSL ?? null,
    pnlAtTP1: a?.pnlAtTP1 ?? null,
    pnlAtTP2: a?.pnlAtTP2 ?? null,
    collateral: a?.collateral ?? null,
    leverage: a?.leverage ?? null,
    mt5Lots: null,
  };
}

function SignalRow(p: RowProps) {
  const meta = SYMBOLS[p.symbol];
  const isBuy = p.signal === "BUY";
  const Arrow = isBuy ? TrendingUp : TrendingDown;
  const sideColor = isBuy ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" : "bg-rose-500/15 text-rose-400 border-rose-500/40";
  const sideBar = isBuy ? "bg-emerald-500" : "bg-rose-500";

  return (
    <button
      onClick={p.onClick}
      className={cn(
        "group relative w-full text-left rounded-lg border bg-[#0a0a0a]/65 hover:bg-white/[0.025] transition-colors",
        "flex flex-col gap-2 p-3 cursor-pointer",
        p.highlighted ? "border-primary/60 ring-1 ring-primary/30" : "border-zinc-800 hover:border-zinc-700",
      )}
      data-testid={`active-signal-${p.symbol}-${p.timeframe}`}
    >
      <div className={cn("absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full", sideBar)} />

      {/* Top row: symbol / TF / side / current vs entry */}
      <div className="flex items-center gap-2 pl-2">
        <div
          className="h-7 w-7 shrink-0 rounded-md bg-zinc-900 border border-zinc-700 flex items-center justify-center text-[10px] font-black text-primary"
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          {meta.badge}
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-xs font-mono font-semibold text-zinc-100 truncate">{meta.short}</span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">{meta.long}</span>
        </div>
        <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold border border-zinc-700 bg-zinc-900 text-zinc-300">
          {TF_LABEL[p.timeframe]}
        </span>
        <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono font-bold", sideColor)}>
          <Arrow className="w-3 h-3" />
          {p.signal}
        </span>
      </div>

      {/* State line — the dynamic signalReason from describeFrozenTrade */}
      <div className="text-[11px] leading-snug text-zinc-300 font-mono pl-2">
        {p.signalReason}
      </div>

      {/* Price quartet */}
      <div className="grid grid-cols-4 gap-1 pl-2 font-mono text-[10px]">
        <div className="rounded border border-zinc-800 bg-zinc-900/60 px-1.5 py-1">
          <div className="text-zinc-500 text-[9px] uppercase tracking-wider">Now</div>
          <div className="text-zinc-100 font-semibold">{fmtPrice(p.symbol, p.currentPrice)}</div>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-900/60 px-1.5 py-1">
          <div className="text-zinc-500 text-[9px] uppercase tracking-wider">Entry</div>
          <div className="text-zinc-100 font-semibold">{fmtPrice(p.symbol, p.entryPrice)}</div>
        </div>
        <div className="rounded border border-rose-500/20 bg-rose-500/5 px-1.5 py-1">
          <div className="text-rose-400/70 text-[9px] uppercase tracking-wider">SL</div>
          <div className="text-rose-300 font-semibold">{fmtPrice(p.symbol, p.stopLoss)}</div>
        </div>
        <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-1.5 py-1">
          <div className="text-emerald-400/70 text-[9px] uppercase tracking-wider flex items-center gap-1">
            <Target className="w-2.5 h-2.5" />TP1
          </div>
          <div className="text-emerald-300 font-semibold">{fmtPrice(p.symbol, p.takeProfit1)}</div>
        </div>
      </div>

      {/* Per-venue $PnL projection — ground-truth dollar outcomes per leg.
          JUP shows $col×lev, MT5 shows the lot size — never mix them, since
          each badge is a promise about which exchange the dollars came from. */}
      {p.pnlAtSL !== null && p.pnlAtTP1 !== null && p.pnlAtTP2 !== null && (
        <div className="flex items-center gap-2 pl-2 text-[10px] font-mono">
          {p.venue === "MT5" && p.mt5Lots !== null ? (
            <>
              <span className="text-zinc-500">MT5</span>
              <span className="text-zinc-300">{p.mt5Lots.toFixed(2)} lot</span>
            </>
          ) : p.collateral !== null && p.leverage !== null ? (
            <>
              <span className="text-zinc-500">JUP</span>
              <span className="text-zinc-300">${p.collateral.toFixed(0)}×{p.leverage.toFixed(0)}</span>
            </>
          ) : null}
          <span className="text-zinc-600">→</span>
          <span className="text-rose-400">SL {fmtUsd(p.pnlAtSL)}</span>
          <span className="text-zinc-600">·</span>
          <span className="text-emerald-400">TP1 {fmtUsd(p.pnlAtTP1)}</span>
          <span className="text-zinc-600">·</span>
          <span className="text-emerald-400">TP2 {fmtUsd(p.pnlAtTP2)}</span>
          <span className="ml-auto text-zinc-500">R:R {p.riskRewardRatio.toFixed(2)}</span>
        </div>
      )}
    </button>
  );
}

export function ActiveSignalsOverview({
  selectedSymbol,
  selectedTimeframe,
  onSelect,
}: {
  selectedSymbol: Symbol;
  selectedTimeframe: Timeframe;
  onSelect: (s: Symbol, t: Timeframe) => void;
}) {
  const [lastFetched, setLastFetched] = useState<Date>(new Date());

  // Collapsed state persists per-section so the trader's choice survives reloads.
  // Default open — the overview is the most decision-critical block on the page.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("screener.activeSignals.collapsed") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("screener.activeSignals.collapsed", collapsed ? "1" : "0");
    }
  }, [collapsed]);

  // Read the SAME localStorage keys the SignalPanel writes to so the overview's
  // Jupiter $P&L / collateral / leverage match what the trader sees in the
  // main panel. Keys defined in components/signal-panel.tsx — keep in sync.
  const accountSize = readNumber("screener.accountSize", 500);
  const riskPct = readNumber("screener.riskPct", 1);
  const minCollateral = readNumber("screener.minCollateral", 10);
  const maxLeverage = readNumber("screener.maxLeverage", 50);
  // MT5 lot size for forex/metals projections — paired with the SignalPanel's
  // mt5Lots input. BTC/ETH ignore this and stay on the JUP $col×lev model.
  const mt5Lots = readNumber("screener.mt5Lots", 0.01);

  const params = { accountSize, riskPct, minCollateral, maxLeverage, mt5Lots };
  const { data, isLoading, isError, refetch, isFetching } = useGetActiveSignals(params, {
    query: {
      queryKey: getGetActiveSignalsQueryKey(params),
      refetchInterval: 60000,
    },
  });

  useEffect(() => {
    if (data?.lastUpdated) setLastFetched(new Date(data.lastUpdated));
  }, [data?.lastUpdated]);

  const signals = data?.signals ?? [];
  const coverage = data?.coverage;
  const sortByTfThenSymbol = (a: { symbol: string; timeframe: string }, b: { symbol: string; timeframe: string }) =>
    TF_ORDER[a.timeframe as Timeframe] - TF_ORDER[b.timeframe as Timeframe] || a.symbol.localeCompare(b.symbol);
  const filled = signals.filter((s) => isFilled(s.levels.tradeState)).sort(sortByTfThenSymbol);
  const pending = signals.filter((s) => isPending(s.levels.tradeState)).sort(sortByTfThenSymbol);
  const other = signals
    .filter((s) => !isFilled(s.levels.tradeState) && !isPending(s.levels.tradeState))
    .sort(sortByTfThenSymbol);

  return (
    <section
      className="rounded-xl border border-zinc-800 bg-[#0a0a0a]/65 backdrop-blur-md overflow-hidden"
      data-testid="active-signals-overview"
    >
      <div
        className={cn(
          "flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/30",
          collapsed && "border-b-0",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2.5 -my-1 -mx-2 px-2 py-1 rounded hover:bg-white/5 transition-colors"
          aria-expanded={!collapsed}
          aria-controls="active-signals-body"
          data-testid="active-signals-toggle"
        >
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
          )}
          <h2
            className="text-xs font-bold tracking-[0.18em] text-zinc-100"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            ACTIVE SIGNALS
          </h2>
          <span className="text-[10px] font-mono text-zinc-500">
            {signals.length} live · {filled.length} filled · {pending.length} pending
          </span>
        </button>
        <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-500">
          <span className="hidden sm:inline">{lastFetched.toLocaleTimeString()}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              refetch();
            }}
            disabled={isFetching}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 hover:bg-white/5 disabled:opacity-50 transition-colors"
            data-testid="active-signals-refresh"
          >
            <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
          </button>
        </div>
      </div>

      {!collapsed && (
      <div id="active-signals-body" className="p-3">
        {/* Partial-feed-failure banner — distinguishes "no signals" from
            "data feed degraded" so a missing OANDA/OKX call can't masquerade
            as a quiet market. */}
        {coverage && coverage.failed > 0 && (
          <div
            className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-mono text-amber-300"
            data-testid="active-signals-coverage-warning"
          >
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Data feed degraded: {coverage.failed} of {coverage.total} combos failed
              {coverage.failedSymbols.length > 0 && <> ({coverage.failedSymbols.join(", ")})</>}.
              The signals shown below are still valid, but some symbols may be missing.
            </span>
          </div>
        )}

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 rounded-lg bg-white/[0.03] border border-zinc-800 animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <div className="flex items-center gap-2 text-xs text-rose-400 font-mono p-3">
            <AlertTriangle className="w-4 h-4" />
            <span>Failed to load active signals.</span>
            <button onClick={() => refetch()} className="underline ml-auto">retry</button>
          </div>
        )}

        {!isLoading && !isError && signals.length === 0 && (
          <div className="text-center py-8 text-xs font-mono text-zinc-500">
            No active signals — all symbols × timeframes in WAIT. Check back when the next setup approaches its zone.
          </div>
        )}

        {!isLoading && !isError && signals.length > 0 && (
          <div className="space-y-3">
            {filled.length > 0 && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-400/80 mb-1.5 px-1">
                  Filled positions ({filled.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {filled.map((s) => (
                    <SignalRow
                      key={`${s.symbol}-${s.timeframe}`}
                      symbol={s.symbol as Symbol}
                      timeframe={s.timeframe as Timeframe}
                      signal={s.levels.signal as "BUY" | "SELL"}
                      signalReason={s.levels.signalReason}
                      currentPrice={s.levels.currentPrice}
                      entryPrice={s.levels.entryPrice}
                      stopLoss={s.levels.stopLoss}
                      takeProfit1={s.levels.takeProfit1}
                      takeProfit2={s.levels.takeProfit2}
                      riskRewardRatio={s.levels.riskRewardRatio}
                      {...toRowSizing(s.levels.positionSizing)}
                      onClick={() => onSelect(s.symbol as Symbol, s.timeframe as Timeframe)}
                      highlighted={s.symbol === selectedSymbol && s.timeframe === selectedTimeframe}
                    />
                  ))}
                </div>
              </div>
            )}

            {pending.length > 0 && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-amber-400/80 mb-1.5 px-1">
                  Pending limits ({pending.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {pending.map((s) => (
                    <SignalRow
                      key={`${s.symbol}-${s.timeframe}`}
                      symbol={s.symbol as Symbol}
                      timeframe={s.timeframe as Timeframe}
                      signal={s.levels.signal as "BUY" | "SELL"}
                      signalReason={s.levels.signalReason}
                      currentPrice={s.levels.currentPrice}
                      entryPrice={s.levels.entryPrice}
                      stopLoss={s.levels.stopLoss}
                      takeProfit1={s.levels.takeProfit1}
                      takeProfit2={s.levels.takeProfit2}
                      riskRewardRatio={s.levels.riskRewardRatio}
                      {...toRowSizing(s.levels.positionSizing)}
                      onClick={() => onSelect(s.symbol as Symbol, s.timeframe as Timeframe)}
                      highlighted={s.symbol === selectedSymbol && s.timeframe === selectedTimeframe}
                    />
                  ))}
                </div>
              </div>
            )}

            {other.length > 0 && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5 px-1">
                  Other ({other.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {other.map((s) => (
                    <SignalRow
                      key={`${s.symbol}-${s.timeframe}`}
                      symbol={s.symbol as Symbol}
                      timeframe={s.timeframe as Timeframe}
                      signal={s.levels.signal as "BUY" | "SELL"}
                      signalReason={s.levels.signalReason}
                      currentPrice={s.levels.currentPrice}
                      entryPrice={s.levels.entryPrice}
                      stopLoss={s.levels.stopLoss}
                      takeProfit1={s.levels.takeProfit1}
                      takeProfit2={s.levels.takeProfit2}
                      riskRewardRatio={s.levels.riskRewardRatio}
                      {...toRowSizing(s.levels.positionSizing)}
                      onClick={() => onSelect(s.symbol as Symbol, s.timeframe as Timeframe)}
                      highlighted={s.symbol === selectedSymbol && s.timeframe === selectedTimeframe}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </section>
  );
}
