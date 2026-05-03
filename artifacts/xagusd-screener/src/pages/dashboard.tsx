import { useEffect, useState } from "react";
import { TradingViewChart } from "@/components/trading-view-chart";
import { SignalPanel } from "@/components/signal-panel";
import { BacktestPanel } from "@/components/backtest-panel";
import { EdgeLeaderboard } from "@/components/edge-leaderboard";
import { ActiveSignalsOverview } from "@/components/active-signals-overview";
import {
  TimeframeSelector,
  type Timeframe,
} from "@/components/timeframe-selector";
import { SymbolSelector } from "@/components/symbol-selector";
import { PushNotificationsToggle } from "@/components/push-notifications-toggle";
import { SYMBOLS, type Symbol } from "@/lib/symbols";

const VALID_TIMEFRAMES: readonly Timeframe[] = ["15m", "30m", "1h", "1d"];

// Read ?symbol=…&timeframe=… so notification links and shared URLs deep-link
// straight to the right chart.
function readInitial(): { symbol: Symbol; timeframe: Timeframe } {
  if (typeof window === "undefined") {
    return { symbol: "XAGUSD", timeframe: "1d" };
  }
  const params = new URLSearchParams(window.location.search);
  const s = params.get("symbol");
  const t = params.get("timeframe");
  return {
    symbol: s && s in SYMBOLS ? (s as Symbol) : "XAGUSD",
    timeframe:
      t && (VALID_TIMEFRAMES as readonly string[]).includes(t)
        ? (t as Timeframe)
        : "1d",
  };
}

export default function Dashboard() {
  const initial = readInitial();
  const [symbol, setSymbol] = useState<Symbol>(initial.symbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(initial.timeframe);

  // Keep the URL in sync so the current view is always shareable / bookmarkable.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.set("symbol", symbol);
    params.set("timeframe", timeframe);
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }, [symbol, timeframe]);

  return (
    <div
      className="min-h-[100dvh] w-full bg-background flex flex-col bg-cover bg-center bg-fixed bg-no-repeat"
      style={{
        backgroundImage: `linear-gradient(rgba(10,10,10,0.30), rgba(10,10,10,0.40)), url(${import.meta.env.BASE_URL}terminal-bg.png)`,
      }}
    >
      {/* Top Navbar — relative + high z-index creates a stacking context that
          sits above the TradingView iframe in <main>, so the symbol dropdown
          isn't covered by the chart. */}
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
          <SymbolSelector value={symbol} onChange={setSymbol} />
          <TimeframeSelector value={timeframe} onChange={setTimeframe} />
          <PushNotificationsToggle />
          <div className="hidden sm:flex items-center gap-1.5 border-l pl-3 border-border/50">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-muted-foreground">LIVE</span>
          </div>
          <span className="text-muted-foreground border-l pl-3 border-border/50 hidden md:inline-block">
            {SYMBOLS[symbol].tv}
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-2 md:p-3 flex flex-col gap-2 md:gap-3">
        {/* Top row: chart + signal panel.
            Mobile: explicit chart/panel heights so flex-1 inside <main> doesn't
            balloon the chart to fill the whole viewport. Desktop (lg+): the
            row grows to 900px so the panel's WAIT card + trade ticket + zone
            watch + position-sizing controls + EXACT TRADE block all fit on
            BUY/SELL without internal scroll. Panel widened to 42% (chart 58%)
            so trade-ticket rows and PHEMEX collateral×lev grid don't truncate
            on the right edge. Mobile panel height bumped to match. */}
        <div className="flex flex-col lg:flex-row gap-2 md:gap-3 lg:h-[1080px]">
          <div className="w-full h-[420px] md:h-[480px] lg:w-[58%] lg:h-auto lg:flex-1 lg:min-h-0">
            <TradingViewChart symbol={symbol} timeframe={timeframe} />
          </div>
          <div className="w-full h-[920px] lg:w-[42%] lg:h-auto lg:min-h-0">
            <SignalPanel symbol={symbol} timeframe={timeframe} />
          </div>
        </div>

        {/* Active signals overview — every live BUY/SELL across symbols × timeframes */}
        <ActiveSignalsOverview
          selectedSymbol={symbol}
          selectedTimeframe={timeframe}
          onSelect={(s, t) => {
            setSymbol(s);
            setTimeframe(t);
          }}
        />

        {/* Edge leaderboard — best win rate across all symbol × timeframe combos */}
        <EdgeLeaderboard
          selectedSymbol={symbol}
          selectedTimeframe={timeframe}
          onSelect={(s, t) => {
            setSymbol(s);
            setTimeframe(t);
          }}
        />

        {/* Backtest section */}
        <BacktestPanel symbol={symbol} timeframe={timeframe} />
      </main>
    </div>
  );
}
