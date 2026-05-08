export function ZoneDiagram() {
  const W = 640, H = 380;
  const padL = 58, padR = 20, padT = 20, padB = 20;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const priceMin = 108.0;
  const priceMax = 115.5;
  const range = priceMax - priceMin;

  const toY = (p: number) => padT + chartH - ((p - priceMin) / range) * chartH;

  const PP = 111.27;
  const R1 = 112.73;
  const R2 = 113.87;
  const S1 = 109.80;
  const S2 = 108.67;

  const zoneGap = R1 - S1;
  const hw = zoneGap * 0.20;
  const buyZoneHigh = S1 + hw;
  const buyZoneLow  = S1 - hw;
  const sellZoneHigh = R1 + hw;
  const sellZoneLow  = R1 - hw;

  const pricePath: [number, number][] = [
    [0, 113.4], [40, 113.1], [80, 112.8], [110, 113.2],
    [140, 112.5], [170, 112.0], [200, 111.6], [230, 111.3],
    [260, 110.8], [290, 110.2], [320, 109.95], [350, 109.78],
    [370, 109.85], [390, 110.3], [420, 110.9], [450, 111.4],
    [480, 111.8], [510, 112.3], [540, 112.7], [570, 113.0],
    [chartW, 112.8],
  ];

  const pathD = pricePath
    .map(([x, p], i) => `${i === 0 ? "M" : "L"}${(padL + x).toFixed(1)},${toY(p).toFixed(1)}`)
    .join(" ");

  return (
    <div className="font-mono space-y-3">
      <div className="text-center mb-4">
        <h2 className="text-white text-lg font-bold tracking-wider uppercase">Fig 2 — Buy / Sell Zone Construction</h2>
        <p className="text-[#8b949e] text-xs mt-1">Zone width = ±20% of (R1 − S1) gap around each level</p>
      </div>

      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
          <rect x={padL} y={toY(sellZoneHigh)} width={chartW} height={toY(sellZoneLow) - toY(sellZoneHigh)} fill="#ef5350" fillOpacity="0.10"/>
          <rect x={padL} y={toY(buyZoneHigh)}  width={chartW} height={toY(buyZoneLow)  - toY(buyZoneHigh)}  fill="#26a69a" fillOpacity="0.10"/>

          {([
            [R2, "#ef5350", "0.4", "R2"],
            [R1, "#ef5350", "0.9", "R1  ← sell zone centre"],
            [PP, "#90caf9", "0.7", "PP"],
            [S1, "#26a69a", "0.9", "S1  ← buy zone centre"],
            [S2, "#26a69a", "0.4", "S2"],
          ] as [number, string, string, string][]).map(([price, color, opacity, tag]) => (
            <g key={tag}>
              <line
                x1={padL} y1={toY(price)} x2={padL + chartW} y2={toY(price)}
                stroke={color} strokeWidth="1" strokeOpacity={opacity}
                strokeDasharray={tag.startsWith("R1") || tag.startsWith("S1") ? "none" : "4,3"}
              />
              <text x={padL - 4} y={toY(price) + 4} fill={color} fontSize="10" fontFamily="monospace" textAnchor="end">
                {tag.split(" ")[0]}
              </text>
            </g>
          ))}

          <text x={padL + chartW + 4} y={toY(sellZoneLow) + 4} fill="#ef5350" fontSize="9" fontFamily="monospace" fillOpacity="0.7">SELL ZONE</text>
          <text x={padL + chartW + 4} y={toY(buyZoneHigh) + 4} fill="#26a69a" fontSize="9" fontFamily="monospace" fillOpacity="0.7">BUY ZONE</text>

          <line x1={padL + chartW - 6} y1={toY(buyZoneHigh)} x2={padL + chartW - 6} y2={toY(buyZoneLow)} stroke="#26a69a" strokeWidth="1.5" strokeOpacity="0.5"/>
          <text x={padL + chartW - 10} y={(toY(buyZoneHigh) + toY(buyZoneLow)) / 2 + 3} fill="#26a69a" fontSize="8" fontFamily="monospace" textAnchor="middle" transform={`rotate(-90, ${padL + chartW - 10}, ${(toY(buyZoneHigh) + toY(buyZoneLow)) / 2 + 3})`}>±20%</text>

          <path d={pathD} fill="none" stroke="#ffd54f" strokeWidth="1.5"/>

          <circle cx={padL + 360} cy={toY(109.78)} r="4" fill="none" stroke="#26a69a" strokeWidth="1.5"/>
          <line x1={padL + 360} y1={toY(109.78) - 6} x2={padL + 360} y2={toY(109.78) - 26} stroke="#26a69a" strokeWidth="1" strokeDasharray="3,2"/>
          <text x={padL + 360} y={toY(109.78) - 30} fill="#26a69a" fontSize="9" fontFamily="monospace" textAnchor="middle">bounce</text>
        </svg>
      </div>

      <div className="flex gap-4 text-xs text-[#8b949e] justify-center flex-wrap">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-1 bg-[#ffd54f] rounded"/><span>Price</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 bg-[#26a69a]/20 border border-[#26a69a]/40 rounded"/><span>Buy zone (±20% of gap around S1)</span></span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 bg-[#ef5350]/20 border border-[#ef5350]/40 rounded"/><span>Sell zone (±20% around R1)</span></span>
      </div>
    </div>
  );
}
