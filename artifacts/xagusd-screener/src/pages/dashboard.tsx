import { TradingViewChart } from "@/components/trading-view-chart";
import { SignalPanel } from "@/components/signal-panel";
import { BacktestPanel } from "@/components/backtest-panel";

export default function Dashboard() {
  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col">
      {/* Top Navbar */}
      <header className="h-12 border-b bg-card flex items-center px-4 shrink-0 justify-between">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold text-xs">
            Ag
          </div>
          <h1 className="font-semibold text-sm tracking-widest text-foreground">
            XAGUSD <span className="text-muted-foreground font-normal">SILVER TERMINAL</span>
          </h1>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-muted-foreground">LIVE</span>
          </div>
          <span className="text-muted-foreground border-l pl-4 border-border/50 hidden sm:inline-block">
            OANDA:XAGUSD
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-2 md:p-3 flex flex-col gap-2 md:gap-3">
        {/* Top row: chart + signal panel */}
        <div className="flex flex-col lg:flex-row gap-2 md:gap-3 lg:h-[640px]">
          <div className="flex-1 lg:w-[65%] min-h-[400px] lg:min-h-0">
            <TradingViewChart />
          </div>
          <div className="lg:w-[35%] w-full h-[480px] lg:h-auto min-h-0">
            <SignalPanel />
          </div>
        </div>

        {/* Backtest section */}
        <BacktestPanel />
      </main>
    </div>
  );
}
