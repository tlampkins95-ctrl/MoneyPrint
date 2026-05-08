export function PivotFormula() {
  const H = 112.40;
  const L = 109.80;
  const C = 111.60;
  const PP = (H + L + C) / 3;
  const R1 = 2 * PP - L;
  const R2 = PP + (H - L);
  const S1 = 2 * PP - H;
  const S2 = PP - (H - L);

  const fmt = (n: number) => n.toFixed(2);

  return (
    <div className="font-mono space-y-4">
      <div className="text-center mb-6">
        <h2 className="text-white text-lg font-bold tracking-wider uppercase">Fig 1 — Pivot Point Formula</h2>
        <p className="text-[#8b949e] text-xs mt-1">Anchored to previous day's High / Low / Close</p>
      </div>

      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
        <div className="text-[#8b949e] text-xs uppercase tracking-widest mb-3">Previous Day's Bar</div>
        <div className="flex items-center gap-8">
          <svg width="80" height="140" viewBox="0 0 80 140">
            <line x1="40" y1="4" x2="40" y2="136" stroke="#4CAF50" strokeWidth="1.5"/>
            <rect x="24" y="34" width="32" height="60" fill="#1a3a2a" stroke="#4CAF50" strokeWidth="1.5" rx="2"/>
            <line x1="40" y1="4" x2="58" y2="4" stroke="#ef5350" strokeWidth="1" strokeDasharray="3,2"/>
            <text x="61" y="8" fill="#ef5350" fontSize="10" fontFamily="monospace">H</text>
            <line x1="40" y1="136" x2="58" y2="136" stroke="#26a69a" strokeWidth="1" strokeDasharray="3,2"/>
            <text x="61" y="140" fill="#26a69a" fontSize="10" fontFamily="monospace">L</text>
            <line x1="40" y1="64" x2="58" y2="64" stroke="#ffd54f" strokeWidth="1" strokeDasharray="3,2"/>
            <text x="61" y="68" fill="#ffd54f" fontSize="10" fontFamily="monospace">C</text>
          </svg>

          <div className="flex-1 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-[#ef5350] text-sm">High (H)</span>
              <span className="text-white text-sm">{fmt(H)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[#ffd54f] text-sm">Close (C)</span>
              <span className="text-white text-sm">{fmt(C)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[#26a69a] text-sm">Low (L)</span>
              <span className="text-white text-sm">{fmt(L)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-[#161b22] border border-[#58a6ff] rounded-lg p-4">
        <div className="text-[#58a6ff] text-xs uppercase tracking-widest mb-3">Pivot Point</div>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-[#e6edf3] text-base">PP = (H + L + C) ÷ 3</span>
          <span className="text-white font-bold text-base">= {fmt(PP)}</span>
        </div>
        <div className="text-[#8b949e] text-xs mt-1">= ({fmt(H)} + {fmt(L)} + {fmt(C)}) ÷ 3</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <div className="text-[#ef5350] text-xs uppercase tracking-widest">Resistance</div>
          <div className="bg-[#1a1f26] border border-[#ef5350]/30 rounded p-3 space-y-2">
            <div>
              <div className="text-[#8b949e] text-xs">R1 = 2×PP − L</div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[#ef5350] text-sm font-medium">R1</span>
                <span className="text-white text-sm">{fmt(R1)}</span>
              </div>
            </div>
            <div className="border-t border-[#30363d]"/>
            <div>
              <div className="text-[#8b949e] text-xs">R2 = PP + (H − L)</div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[#ef5350] text-sm font-medium">R2</span>
                <span className="text-white text-sm">{fmt(R2)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[#26a69a] text-xs uppercase tracking-widest">Support</div>
          <div className="bg-[#1a1f26] border border-[#26a69a]/30 rounded p-3 space-y-2">
            <div>
              <div className="text-[#8b949e] text-xs">S1 = 2×PP − H</div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[#26a69a] text-sm font-medium">S1</span>
                <span className="text-white text-sm">{fmt(S1)}</span>
              </div>
            </div>
            <div className="border-t border-[#30363d]"/>
            <div>
              <div className="text-[#8b949e] text-xs">S2 = PP − (H − L)</div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[#26a69a] text-sm font-medium">S2</span>
                <span className="text-white text-sm">{fmt(S2)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
