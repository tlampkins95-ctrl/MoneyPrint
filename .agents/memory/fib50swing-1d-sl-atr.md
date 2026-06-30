---
name: FIB50_SWING 1d SL — ATR minimum
description: 1d SL formula produces ~1 ATR distance which gets clipped by daily candle noise; fix enforces 1.5 ATR minimum.
---

## Rule
For FIB50_SWING on 1d timeframe, the SL must be at least 1.5 × daily ATR from entry.

**Why:** The formula `SL = ep ± 0.5 × TP1_dist` produces ~0.143 × swingRange ≈ 1 ATR on a typical 1d swing. A single daily candle can span 1 ATR (wick), so the SL gets hit by normal candle noise before price moves to TP. Real example: TAOUSDT 1d SELL, SL $13.46 from entry at $244 (~1 ATR), stopped out by one daily candle wick.

**How to apply:** In the FIB50_SWING SELL block:
```javascript
const slFormula = ep + 0.5 * (ep - tp1);
const sl = round(timeframe === "1d"
  ? Math.max(slFormula, ep + 1.5 * swingAtr)
  : slFormula);
```
In the FIB50_SWING BUY block:
```javascript
const slFormula = ep - 0.5 * (tp1 - ep);
const sl = round(timeframe === "1d"
  ? Math.min(slFormula, ep - 1.5 * swingAtr)
  : slFormula);
```

Other timeframes (1h, 4h): keep strict 2:1 R:R formula unchanged.

## Position sizing note
This uses margin-based sizing (margin = 2% balance, leverage = 20×). A wider SL does NOT reduce position size — it increases the dollar loss if SL hits. Tradeoff: fewer SL hits, larger loss when SL hits. Acceptable because 1d signals with proper gates should have high win rates.
