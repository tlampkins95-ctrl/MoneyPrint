---
name: BB_REJECTION counter-trend gate removal
description: BB_REJECTION SELL must not use higherTfAllowsSell, weeklyAllowsBbrSell, or daily MACD gate — kills valid bull-market shorts
---

## Rule
BB_REJECTION SELL must NOT require `higherTfAllowsSell`, `weeklyAllowsBbrSell`, or the trending-coin daily MACD gate (`isReversalSignalType` must include it). Its own gates are sufficient:
- `bbrSellMacd`: 2 consecutive completed bars of declining positive MACD histogram
- `bwContractingForSell`: BB bandwidth contracting (not expanding pump)
- `volFading`: last bar volume < prior bar volume

**Why:** BB_REJECTION is a counter-trend signal — it fires specifically when the higher TF is still bullish (pump not over) but 1h/4h shows exhaustion at the upper band. Adding any daily MACD gate blocks every valid short in bull markets. When LAB pumped to $18, the daily MACD was still green — the gate suppressed the BB_REJECTION SELL entirely, causing a missed $18→$3 dump.

**How to apply:** Never re-add `higherTfAllowsSell`, `weeklyAllowsBbrSell`, or daily MACD direction checks to BB_REJECTION SELL. In `checkTrendingSymbol`, BB_REJECTION must be in `isReversalSignalType` alongside DOUBLE_TOP/BOTTOM so it bypasses the `!isReversalSignalType` daily MACD guard. The 3 existing guards prevent BB-walk false signals because a walking coin has rising MACD + expanding bandwidth + increasing volume — it cannot pass all three.
