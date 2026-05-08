export function GatesChecklist() {
  return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-6 font-mono">
      <div className="w-full max-w-[680px] space-y-4">
        <div className="text-center mb-4">
          <h2 className="text-white text-lg font-bold tracking-wider uppercase">Fig 3 — Confirmation Gates</h2>
          <p className="text-[#8b949e] text-xs mt-1">All three must pass before a signal fires</p>
        </div>

        {/* Gate table */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-3 border-b border-[#30363d]">
            <div className="px-4 py-2.5 text-[#8b949e] text-xs uppercase tracking-widest">Gate</div>
            <div className="px-4 py-2.5 text-[#26a69a] text-xs uppercase tracking-widest border-l border-[#30363d]">BUY condition</div>
            <div className="px-4 py-2.5 text-[#ef5350] text-xs uppercase tracking-widest border-l border-[#30363d]">SELL condition</div>
          </div>

          {/* RSI */}
          <div className="grid grid-cols-3 border-b border-[#30363d]">
            <div className="px-4 py-4 space-y-1">
              <div className="text-white text-sm font-medium">RSI-14</div>
              <div className="text-[#8b949e] text-xs leading-relaxed">Wilder-smoothed 14-bar momentum oscillator. Confirms exhaustion at the zone — selling pressure cooling for BUY, buying pressure cooling for SELL.</div>
            </div>
            <div className="px-4 py-4 border-l border-[#30363d] flex flex-col justify-center">
              <div className="bg-[#1a3a2a] border border-[#26a69a]/40 rounded px-3 py-2 text-center">
                <div className="text-[#26a69a] text-base font-bold">≤ 45</div>
                <div className="text-[#8b949e] text-xs mt-1">oversold range</div>
              </div>
            </div>
            <div className="px-4 py-4 border-l border-[#30363d] flex flex-col justify-center">
              <div className="bg-[#3a1a1a] border border-[#ef5350]/40 rounded px-3 py-2 text-center">
                <div className="text-[#ef5350] text-base font-bold">≥ 55</div>
                <div className="text-[#8b949e] text-xs mt-1">overbought range</div>
              </div>
            </div>
          </div>

          {/* MACD */}
          <div className="grid grid-cols-3 border-b border-[#30363d]">
            <div className="px-4 py-4 space-y-1">
              <div className="text-white text-sm font-medium">MACD Histogram</div>
              <div className="text-[#8b949e] text-xs leading-relaxed">MACD(12,26,9). Checks the last two completed bars. Filters fades into continuation moves — the biggest category of losing pivot trades.</div>
            </div>
            <div className="px-4 py-4 border-l border-[#30363d] flex flex-col justify-center gap-2">
              <div className="bg-[#1a3a2a] border border-[#26a69a]/40 rounded px-3 py-2">
                <div className="flex items-center gap-2">
                  {/* Mini histogram ticking up */}
                  <svg width="40" height="28" viewBox="0 0 40 28">
                    <rect x="2" y="18" width="7" height="8" fill="#ef535066" rx="1"/>
                    <rect x="11" y="14" width="7" height="12" fill="#ef535044" rx="1"/>
                    <rect x="20" y="12" width="7" height="14" fill="#26a69a88" rx="1"/>
                    <rect x="29" y="6" width="7" height="20" fill="#26a69a" rx="1"/>
                  </svg>
                  <div>
                    <div className="text-[#26a69a] text-xs font-bold">Ticking UP</div>
                    <div className="text-[#8b949e] text-xs">hist[−1] &gt; hist[−2]</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="px-4 py-4 border-l border-[#30363d] flex flex-col justify-center gap-2">
              <div className="bg-[#3a1a1a] border border-[#ef5350]/40 rounded px-3 py-2">
                <div className="flex items-center gap-2">
                  {/* Mini histogram ticking down */}
                  <svg width="40" height="28" viewBox="0 0 40 28">
                    <rect x="2" y="2" width="7" height="20" fill="#26a69a" rx="1"/>
                    <rect x="11" y="8" width="7" height="14" fill="#26a69a88" rx="1"/>
                    <rect x="20" y="12" width="7" height="12" fill="#ef535044" rx="1"/>
                    <rect x="29" y="14" width="7" height="12" fill="#ef535066" rx="1"/>
                  </svg>
                  <div>
                    <div className="text-[#ef5350] text-xs font-bold">Ticking DOWN</div>
                    <div className="text-[#8b949e] text-xs">hist[−1] &lt; hist[−2]</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* EMA200 */}
          <div className="grid grid-cols-3">
            <div className="px-4 py-4 space-y-1">
              <div className="text-white text-sm font-medium">EMA-200 Regime</div>
              <div className="text-[#8b949e] text-xs leading-relaxed">Institutional trend bias. Skipped on 1d timeframe (insufficient history). Uses previous bar's close (not live tick) to avoid contamination.</div>
            </div>
            <div className="px-4 py-4 border-l border-[#30363d] flex flex-col justify-center">
              <div className="bg-[#1a3a2a] border border-[#26a69a]/40 rounded px-3 py-2 text-center">
                <div className="text-[#26a69a] text-sm font-bold">Price &gt; EMA200</div>
                <div className="text-[#8b949e] text-xs mt-1">bull regime — fade support only</div>
              </div>
            </div>
            <div className="px-4 py-4 border-l border-[#30363d] flex flex-col justify-center">
              <div className="bg-[#3a1a1a] border border-[#ef5350]/40 rounded px-3 py-2 text-center">
                <div className="text-[#ef5350] text-sm font-bold">Price &lt; EMA200</div>
                <div className="text-[#8b949e] text-xs mt-1">bear regime — fade resistance only</div>
              </div>
            </div>
          </div>
        </div>

        {/* Note about EMA21/50 */}
        <div className="bg-[#1c2128] border border-[#ffd54f]/20 rounded-lg px-4 py-3 flex gap-3 items-start">
          <span className="text-[#ffd54f] text-sm mt-0.5">⚠</span>
          <p className="text-[#8b949e] text-xs leading-relaxed">
            <span className="text-[#ffd54f]">EMA21/50 trend direction is NOT a gate here.</span> When price pumps into the sell zone, EMA21 &gt; EMA50 as a direct result of that pump — using it as a gate suppresses the exact reversal setup we want. MACD and EMA200 don't react this fast.
          </p>
        </div>
      </div>
    </div>
  );
}
