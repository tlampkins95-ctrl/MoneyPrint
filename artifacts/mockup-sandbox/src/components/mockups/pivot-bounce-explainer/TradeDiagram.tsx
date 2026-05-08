export function TradeDiagram() {
  const W = 640, H = 340;
  const padL = 14, padR = 160, padT = 18, padB = 18;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const priceMin = 108.8;
  const priceMax = 113.2;
  const pRange = priceMax - priceMin;

  const toY = (p: number) => padT + chartH - ((p - priceMin) / pRange) * chartH;

  // Levels
  const entry = 109.80;  // S1
  const sl    = 109.10;  // buyZoneLow - 0.5×ATR
  const tp1   = 111.27;  // PP
  const tp2   = 112.50;  // sell zone low
  const buyZoneHigh = 110.14;
  const buyZoneLow  = 109.46;

  // Risk/reward
  const risk   = entry - sl;
  const rr1    = (tp1 - entry) / risk;
  const rr2    = (tp2 - entry) / risk;

  // Price path: approaches zone, dips, bounces
  const pts: [number, number][] = [
    [0,        112.4],
    [50,       112.0],
    [100,      111.5],
    [150,      111.0],
    [200,      110.4],
    [240,      110.0],
    [270,      109.85],
    [290,      109.80], // entry
    [310,      109.60],
    [325,      109.52],
    [340,      109.72], // bounce
    [370,      110.2],
    [410,      110.8],
    [450,      111.27], // tp1
    [490,      111.8],
    [530,      112.3],
    [chartW,   112.5], // tp2
  ];

  const pathD = pts
    .map(([x, p], i) => `${i === 0 ? "M" : "L"}${(padL + x).toFixed(1)},${toY(p).toFixed(1)}`)
    .join(" ");

  const labelX = padL + chartW + 10;

  const HLine = ({ price, color, dash, label, value }: { price: number; color: string; dash?: boolean; label: string; value: string }) => (
    <g>
      <line
        x1={padL} y1={toY(price)} x2={padL + chartW + 4} y2={toY(price)}
        stroke={color} strokeWidth={dash ? 1 : 1.5}
        strokeDasharray={dash ? "5,3" : undefined}
        strokeOpacity={dash ? 0.5 : 0.9}
      />
      <text x={labelX} y={toY(price) + 4} fill={color} fontSize="10" fontFamily="monospace">{label}</text>
      <text x={labelX + 32} y={toY(price) + 4} fill="#8b949e" fontSize="10" fontFamily="monospace">{value}</text>
    </g>
  );

  const entryX = padL + 290;
  const bounceX = padL + 340;

  return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-6 font-mono">
      <div className="w-full max-w-[680px] space-y-3">
        <div className="text-center mb-4">
          <h2 className="text-white text-lg font-bold tracking-wider uppercase">Fig 4 — Entry / SL / TP Setup</h2>
          <p className="text-[#8b949e] text-xs mt-1">Mean-reversion from S1 zone toward R1 zone</p>
        </div>

        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3">
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
            {/* Buy zone shading */}
            <rect
              x={padL} y={toY(buyZoneHigh)}
              width={chartW} height={toY(buyZoneLow) - toY(buyZoneHigh)}
              fill="#26a69a" fillOpacity="0.10"
            />

            {/* Risk shading (entry → SL) */}
            <rect
              x={padL} y={toY(entry)}
              width={chartW} height={toY(sl) - toY(entry)}
              fill="#ef5350" fillOpacity="0.06"
            />

            {/* Reward shading (entry → TP2) */}
            <rect
              x={padL} y={toY(tp2)}
              width={chartW} height={toY(entry) - toY(tp2)}
              fill="#26a69a" fillOpacity="0.06"
            />

            {/* Level lines */}
            <HLine price={tp2}   color="#4caf50"  label="TP2" value="112.50" />
            <HLine price={tp1}   color="#81c784"  dash  label="TP1" value="111.27" />
            <HLine price={entry} color="#26a69a"       label="Entry" value="109.80" />
            <HLine price={sl}    color="#ef5350"       label="SL"    value="109.10" />

            {/* Price path */}
            <path d={pathD} fill="none" stroke="#ffd54f" strokeWidth="1.5"/>

            {/* Entry marker */}
            <circle cx={entryX} cy={toY(entry)} r="4" fill="#26a69a"/>
            <line x1={entryX} y1={toY(entry)} x2={entryX} y2={toY(entry) - 22} stroke="#26a69a" strokeWidth="1" strokeDasharray="3,2"/>
            <text x={entryX} y={toY(entry) - 26} fill="#26a69a" fontSize="8.5" fontFamily="monospace" textAnchor="middle">LIMIT ENTRY</text>

            {/* TP1 hit marker */}
            <circle cx={padL + 450} cy={toY(tp1)} r="4" fill="#81c784" fillOpacity="0.8"/>

            {/* TP2 hit marker */}
            <circle cx={padL + chartW} cy={toY(tp2)} r="4" fill="#4caf50"/>

            {/* R:R annotations */}
            <line x1={padL + chartW - 20} y1={toY(entry)} x2={padL + chartW - 20} y2={toY(sl)}
                  stroke="#ef5350" strokeWidth="1.5" strokeOpacity="0.6"/>
            <line x1={padL + chartW - 26} y1={toY(entry)} x2={padL + chartW - 14} y2={toY(entry)} stroke="#ef5350" strokeWidth="1"/>
            <line x1={padL + chartW - 26} y1={toY(sl)}    x2={padL + chartW - 14} y2={toY(sl)}    stroke="#ef5350" strokeWidth="1"/>
            <text x={padL + chartW - 22} y={(toY(entry) + toY(sl)) / 2 + 3} fill="#ef5350" fontSize="8" fontFamily="monospace" textAnchor="end">1R</text>

            <line x1={padL + chartW - 20} y1={toY(entry)} x2={padL + chartW - 20} y2={toY(tp2)}
                  stroke="#4caf50" strokeWidth="1.5" strokeOpacity="0.6"/>
            <text x={padL + chartW - 22} y={(toY(entry) + toY(tp2)) / 2 + 3} fill="#4caf50" fontSize="8" fontFamily="monospace" textAnchor="end">{rr2.toFixed(1)}R</text>
          </svg>
        </div>

        {/* Entry row */}
        <div className="bg-[#1a1f26] border border-[#26a69a]/40 rounded p-3 flex items-start gap-4">
          <div className="shrink-0">
            <div className="text-[#26a69a] font-bold text-sm">ENTRY</div>
            <div className="text-[#8b949e] text-xs mt-0.5">limit order</div>
          </div>
          <div className="flex-1 space-y-1 text-xs">
            <div className="text-white font-medium">min(S1, currentPrice)</div>
            <div className="text-[#8b949e] leading-relaxed">
              Staged at S1 when price approaches from above. If price has already dipped to or through S1, entry clamps to the live print — avoids a limit sitting above market that would only fill on a reversal already in drawdown.
            </div>
          </div>
        </div>

        {/* SL / TP row */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="bg-[#1a1f26] border border-[#ef5350]/30 rounded p-3 text-center">
            <div className="text-[#ef5350] font-bold text-sm">SL</div>
            <div className="text-white mt-0.5">buyZoneLow − 0.5×ATR</div>
            <div className="text-[#8b949e] mt-1">just below zone floor</div>
          </div>
          <div className="bg-[#1a1f26] border border-[#81c784]/30 rounded p-3 text-center">
            <div className="text-[#81c784] font-bold text-sm">TP1</div>
            <div className="text-white mt-0.5">at Pivot Point (PP)</div>
            <div className="text-[#8b949e] mt-1">≥ 1:1 R:R floor</div>
          </div>
          <div className="bg-[#1a1f26] border border-[#4caf50]/30 rounded p-3 text-center">
            <div className="text-[#4caf50] font-bold text-sm">TP2</div>
            <div className="text-white mt-0.5">at sell zone low (R1−)</div>
            <div className="text-[#8b949e] mt-1">≥ 1.5:1 R:R floor · {rr2.toFixed(1)}R here</div>
          </div>
        </div>
      </div>
    </div>
  );
}
