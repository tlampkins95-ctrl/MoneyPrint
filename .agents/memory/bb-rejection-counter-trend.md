---
name: BB_REJECTION counter-trend gate removal
description: BB_REJECTION SELL must not use higherTfAllowsSell or weeklyAllowsBbrSell — kills valid bull-market shorts
---

## Rule
BB_REJECTION SELL must NOT require `higherTfAllowsSell` or `weeklyAllowsBbrSell`. Its own gates are sufficient:
- `bbrSellMacd`: 2 consecutive completed bars of declining positive MACD histogram
- `bwContractingForSell`: BB bandwidth contracting (not expanding pump)
- `volFading`: last bar volume < prior bar volume

**Why:** BB_REJECTION is a counter-trend signal — it fires specifically when the higher TF is still bullish (pump not over) but 1h/4h shows exhaustion at the upper band. Adding `higherTfAllowsSell` (4h MACD must be falling) or `weeklyAllowsBbrSell` (weekly MACD ≤ 0) blocks every valid short in bull markets. HYPE +$40, PENGU +$39, DYDX +$60 shorts were all caught before these gates existed.

**How to apply:** Never re-add `higherTfAllowsSell` or `weeklyAllowsBbrSell` to BB_REJECTION SELL. The 3 existing guards prevent BB-walk false signals because a walking coin has rising MACD + expanding bandwidth + increasing volume — it cannot pass all three.
