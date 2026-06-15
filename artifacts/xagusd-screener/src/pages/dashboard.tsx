import { useEffect, useMemo, useState } from "react";
import { LevelsChart } from "@/components/levels-chart";
import { SignalPanel } from "@/components/signal-panel";
import { ActiveSignalsOverview } from "@/components/active-signals-overview";
import { TradeHistoryPanel } from "@/components/trade-history-panel";
import { LearnTab } from "@/components/learn/learn-tab";
import {
  TimeframeSelector,
  type Timeframe,
} from "@/components/timeframe-selector";
import { SymbolSelector } from "@/components/symbol-selector";
import { PushNotificationsToggle } from "@/components/push-notifications-toggle";
import { getSymbolMeta } from "@/lib/symbols";
import { cn } from "@/lib/utils";
import { useGetActiveSignals, getGetActiveSignalsQueryKey } from "@workspace/api-client-react";

const VALID_TIMEFRAMES: readonly Timeframe[] = ["1h", "4h", "1d", "1w"];
type Tab = "signals" | "journal" | "learn";

function readInitial(): { symbol: string; timeframe: Timeframe; tab: Tab } {
  if (typeof window === "undefined") {
    return { symbol: "XAGUSD", timeframe: "1d", tab: "signals" };
  }
  const params = new URLSearchParams(window.location.search);
  const s = params.get("symbol");
  const t = params.get("timeframe");
  const tab = params.get("tab");
  return {
    symbol: s && s.trim().length > 0 ? s.trim() : "XAGUSD",
    timeframe:
      t && (VALID_TIMEFRAMES as readonly string[]).includes(t)
        ? (t as Timeframe)
        : "1d",
    tab: tab === "journal" ? "journal" : tab === "learn" ? "learn" : "signals",
  };
}

const LS_EXPANDED = "screener.signalExpanded";

export default function Dashboard() {
  const initial = readInitial();
  const [symbol, setSymbol] = useState<string>(initial.symbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(initial.timeframe);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [signalExpanded, setSignalExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(LS_EXPANDED) !== "0";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LS_EXPANDED, signalExpanded ? "1" : "0");
    }
  }, [signalExpanded]);

  // Active signals — used to show signal dots on the symbol dropdown + timeframe buttons.
  const { data: activeSignalsData } = useGetActiveSignals(
    {},
    { query: { queryKey: getGetActiveSignalsQueryKey({}), refetchInterval: 30_000, staleTime: 20_000 } },
  );

  // Build two derived sets from the active signals response:
  //   signalSymbols    — all symbols that currently have a BUY or SELL signal
  //   signalsBySymbol  — maps each symbol → set of timeframes with signals
  const { signalSymbols, signalsBySymbol } = useMemo(() => {
    const bySymbol = new Map<string, Set<string>>();
    for (const entry of activeSignalsData?.signals ?? []) {
      if (!bySymbol.has(entry.symbol)) bySymbol.set(entry.symbol, new Set());
      bySymbol.get(entry.symbol)!.add(entry.timeframe);
    }
    return { signalSymbols: new Set(bySymbol.keys()), signalsBySymbol: bySymbol };
  }, [activeSignalsData]);

  const signalTimeframes = signalsBySymbol.get(symbol) ?? new Set<string>();

  // Keep the URL in sync so the current view is always shareable / bookmarkable.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.set("symbol", symbol);
    params.set("timeframe", timeframe);
    params.set("tab", tab);
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }, [symbol, timeframe, tab]);

  return (
    <div
      className="min-h-[100dvh] w-full bg-background flex flex-col bg-cover bg-center bg-fixed bg-no-repeat"
      style={{
        backgroundImage: `linear-gradient(rgba(10,10,10,0.30), rgba(10,10,10,0.40)), url(${import.meta.env.BASE_URL}terminal-bg.png)`,
      }}
    >
      {/* Top Navbar */}
      <header className="relative z-[60] h-12 border-b border-border/60 bg-card/60 backdrop-blur-md flex items-center px-4 shrink-0 justify-between">
        <div className="flex items-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="MONEY.PRINT"
            className="h-7 w-7 rounded-lg shadow-[0_0_16px_rgba(251,191,36,0.35)] object-cover"
          />
          <h1
            className="font-bold text-sm tracking-[0.18em] text-foreground hidden sm:flex items-baseline gap-1"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            <span>MONEY</span>
            <span className="text-primary">.</span>
            <span className="text-muted-foreground font-medium">PRINT</span>
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono">
          {tab === "signals" && (
            <>
              <SymbolSelector value={symbol} onChange={setSymbol} signalSymbols={signalSymbols} />
              <TimeframeSelector value={timeframe} onChange={setTimeframe} signalTimeframes={signalTimeframes} />
            </>
          )}
          {tab === "journal" && (
            <SymbolSelector value={symbol} onChange={setSymbol} signalSymbols={signalSymbols} />
          )}
          <PushNotificationsToggle />
          <div className="hidden sm:flex items-center gap-1.5 border-l pl-3 border-border/50">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-muted-foreground">LIVE</span>
          </div>
          {tab === "signals" && (
            <span className="text-muted-foreground border-l pl-3 border-border/50 hidden md:inline-block">
              {getSymbolMeta(symbol).tv}
            </span>
          )}

        </div>
      </header>

      {/* Tab bar */}
      <nav className="relative z-[59] shrink-0 flex items-center gap-0 border-b border-border/60 bg-card/40 backdrop-blur-md px-4">
        {(["signals", "journal", "learn"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "relative px-4 py-2.5 text-[11px] font-bold tracking-[0.18em] transition-colors",
              tab === t
                ? "text-foreground"
                : "text-zinc-500 hover:text-zinc-300",
            )}
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            {t === "signals" ? "SIGNALS" : t === "journal" ? "JOURNAL" : "LEARN"}
            {tab === t && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t-full" />
            )}
          </button>
        ))}
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 p-2 md:p-3 flex flex-col gap-2 md:gap-3">
        {tab === "signals" && (
          <>
            {/* Chart + signal panel */}
            <div className="flex flex-col lg:flex-row gap-2 md:gap-3 lg:h-[1080px]">
              <div className="w-full h-[420px] md:h-[480px] lg:w-[58%] lg:h-auto lg:flex-1 lg:min-h-0">
                <LevelsChart symbol={symbol} timeframe={timeframe} />
              </div>
              <div className={cn(
                "w-full lg:w-[42%] lg:h-auto lg:min-h-0",
                signalExpanded ? "h-[920px]" : "h-auto",
              )}>
                <SignalPanel
                  symbol={symbol}
                  timeframe={timeframe}
                  expanded={signalExpanded}
                  onExpandedChange={setSignalExpanded}
                />
              </div>
            </div>

            {/* Active signals overview */}
            <ActiveSignalsOverview
              selectedSymbol={symbol}
              selectedTimeframe={timeframe}
              onSelect={(s, t) => {
                setSymbol(s);
                setTimeframe(t);
              }}
            />

          </>
        )}

        {tab === "journal" && (
          <TradeHistoryPanel
            selectedSymbol={symbol}
            onSelect={(s) => setSymbol(s)}
          />
        )}

        {tab === "learn" && <LearnTab />}
      </main>
    </div>
  );
}
