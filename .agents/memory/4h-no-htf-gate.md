---
name: 4h timeframe missing higherTfAllowsSell gate
description: The 4h timeframe case fell through to true in higherTfAllowsSell — all 4h SELLs fired with no daily MACD check.
---

## Rule
`higherTfAllowsSell` and `higherTfAllowsBuy` must cover `timeframe === "4h"` with the daily MACD check — same as `1h`. The `else if (timeframe === "1d")` branch for weekly must remain separate.

## Why
The original implementation only had `if (timeframe === "1h")` and `else if (timeframe === "1d")`. The `4h` case was never matched, so `higherTfAllowsSell` defaulted to `true` for every 4h signal. This caused DOGE/SOL/ADA/ETH 4h SELL signals to fire while BTC and the broader market were pumping (daily MACD rising), producing losing mean-reversion shorts into trend.

## How to apply
Condition: `if ((timeframe === "1h" || timeframe === "4h") && dailyCandlesForWeekly...)` for the daily MACD check. The `_checkDailyMacd()` helper extracts this logic so it is not duplicated for buy and sell gates.
