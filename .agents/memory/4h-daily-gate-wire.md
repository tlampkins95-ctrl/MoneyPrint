---
name: 4h daily MACD gate wiring
description: dailyCandlesForWeekly was never populated for 4h — the gate silently failed open for every 4h signal
---

## Rule
In `checkSymbol` and `checkTrendingSymbol`, set `dailyForWeekly` to `higherCandles` when `timeframe === "4h"`. Do NOT add an extra fetch — `higherCandles` for 4h are already daily candles (`HIGHER_TIMEFRAME["4h"] = "1d"`).

## Why
`needDailyForWeekly = timeframe === "1h"` only. For 4h, `rawDailyForWeekly` resolved to `[]`, so `dailyCandlesForWeekly` was `undefined` in `computeLevels`. The gate `&& dailyCandlesForWeekly && dailyCandlesForWeekly.length >= 35` never passed → `higherTfAllowsBuy/Sell` defaulted to `true` → every 4h signal fired with no daily MACD check regardless of what the daily MACD was doing.

## How to apply
```typescript
const dailyForWeekly =
  timeframe === "4h" && higherCandles.length > 0 ? higherCandles :
  rawDailyForWeekly.length > 0 ? rawDailyForWeekly : undefined;
```
Apply this pattern to BOTH `checkSymbol` and `checkTrendingSymbol`.
