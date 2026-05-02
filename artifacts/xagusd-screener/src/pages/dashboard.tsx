import { useState } from "react";
import { TradingViewChart } from "@/components/trading-view-chart";
import { SignalPanel } from "@/components/signal-panel";
import { BacktestPanel } from "@/components/backtest-panel";
import {
  TimeframeSelector,
  type Timeframe,
} from "@/components/timeframe-selector";
import { SymbolSelector } from "@/components/symbol-selector";
import { SYMBOLS, type Symbol } from "@/lib/symbols";

export default function Dashboard() {
  const [symbol, setSymbol] = useState<Symbol>("XAGUSD");
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");

  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col">
      {/* Top Navbar */}
      <header className="h-12 border-b bg-card flex items-center px-4 shrink-0 justify-between">
        <div className="flex items-center gap-3">
          <div
            className="h-7 w-7 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-black text-xs shadow-[0_0_16px_rgba(251,191,36,0.35)]"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            Ag
          </div>
          <h1
            className="font-bold text-sm tracking-[0.18em] text-foreground hidden sm:flex items-baseline gap-1"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            <span>FOREX</span>
            <span className="text-primary">.</span>
            <span className="text-muted-foreground font-medium">TERMINAL</span>
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono">
          <SymbolSelector value={symbol} onChange={setSymbol} />
          <TimeframeSelector value={timeframe} onChange={setTimeframe} />
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
        {/* Top row: chart + signal panel */}
        <div className="flex flex-col lg:flex-row gap-2 md:gap-3 lg:h-[640px]">
          <div className="flex-1 lg:w-[65%] min-h-[400px] lg:min-h-0">
            <TradingViewChart symbol={symbol} timeframe={timeframe} />
          </div>
          <div className="lg:w-[35%] w-full h-[480px] lg:h-auto min-h-0">
            <SignalPanel symbol={symbol} timeframe={timeframe} />
          </div>
        </div>

        {/* Backtest section */}
        <BacktestPanel symbol={symbol} timeframe={timeframe} />
      </main>
    </div>
  );
}
