---
name: PRICE_ACTION_SR signal (dashboard-only, no auto-trade)
description: Second signal engine (pure price action, 4H→1H→15m) running alongside BB+MACD; on-demand only, not polled, not in Phemex allowlist.
---

PRICE_ACTION_SR is a second, independent signal engine (4H structure → 1H S/R zone → 15m trigger) added alongside the existing BB+MACD cascade. It only runs on the "15m" timeframe and is computed on-demand inside `/levels`, `/price-history`, and `/active-signals` — it is deliberately NOT added to `TRACKED_TIMEFRAMES` in notifier.ts (no background polling) and NOT added to the Phemex auto-trader allowlist (dashboard-only per explicit requirement, since real money is on the line and the strategy has no backtest yet).

**Why:** the spec called for a fully separate strategy to run in parallel for observation, without touching the live-money auto-trader path or existing BB+MACD signal computation.

**How to apply:** any route that computes multi-timeframe levels (dailyForWeekly-style side-channel candle fetch pattern) must also conditionally fetch 4H+1H candles when timeframe==="15m" and pass them through `computeLevelsStable`'s extra params. If adding more consumers of computeLevels/computeLevelsStable in the future, follow this same fetch-and-passthrough pattern rather than trying to compute 15m signals from 15m candles alone.
