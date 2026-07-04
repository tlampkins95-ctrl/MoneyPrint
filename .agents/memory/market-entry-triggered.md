---
name: Market entry triggered flag in computeLevelsStable
description: isMarketEntry was hardcoded false — market-entry signals (BB_WALK, BB_BREAKOUT, DUMP_RECOVERY) randomly showed as PENDING based on rounding
---

## Rule
In `computeLevelsStable` (signals.ts), compute `isMarketEntry` based on `fresh.signalType`:
```typescript
const isMarketEntry = (
  fresh.signalType === "BB_WALK" ||
  fresh.signalType === "BB_BREAKOUT" ||
  fresh.signalType === "DUMP_RECOVERY"
);
```

## Why
These signals set `entryPrice = round(currentPrice)`. The `triggered` check was `currentPrice < entryPrice` for BUY. Due to rounding, whether `currentPrice < round(currentPrice)` was true or false depended on which way the rounding went — 50/50. So these trades randomly appeared as PENDING or FILLED_PROFIT on each signal fire, and could cause the auto-trader to re-place a limit at currentPrice instead of recognising it as already filled.

## How to apply
FIB50_SWING, DOUBLE_TOP/BOTTOM, BB_REJECTION, BB_OVEREXTENSION are all limit entries — leave their triggered computation as-is. Only the three market-entry signal types need `isMarketEntry = true`.
