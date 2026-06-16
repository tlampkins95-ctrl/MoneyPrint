---
name: 1h daily trend gate
description: 1h FIB50_SWING signals must be blocked when the daily EMA trend opposes them. Active-signals route must fetch daily candles for trending coin 1h combos.
---

## Rule

For `timeframe === "1h"`, compute the daily EMA21/50 trend from `dailyCandlesForWeekly` and apply it as an additional gate:
- `weeklyAllowsBuy  = trend === "UPTREND"  && dailyEMATrend !== "DOWNTREND"`
- `weeklyAllowsSell = trend === "DOWNTREND" && dailyEMATrend !== "UPTREND"`

Gate only activates when `dailyCandlesForWeekly` has ≥ 50 bars. Falls back to local-trend-only if candles unavailable.

**Why:** Without this gate, a 1h BUY can fire when the daily is DOWNTREND, and a 1d SELL can fire at the same price — producing contradictory signals at the same price zone. SPACE/USDT: 1h BUY at $0.00759, 1d SELL at $0.00749 with a filled 1h trade in drawdown.

## Callers must provide daily candles for 1h

The notifier's `checkTrendingSymbol` already fetches daily candles when `timeframe === "1h"`.
The `/api/active-signals` route for dynamic combos must also fetch daily candles for 1h — otherwise the gate silently falls back to local-trend-only.

**How to apply:** When adding a new caller of `computeLevelsStable` for `1h` trending coins, always fetch `fetchCandlesForDynamic(okxPerp, "1d")` and pass it as `dailyForWeekly`.

## BTC suppression log dedup

`TrackedState.btcSuppressed?: boolean` tracks whether the BTC macro gate is actively suppressing. Log "BUY suppressed" only when `!prev?.btcSuppressed` — prevents per-poll log flooding when BTC stays in DOWNTREND for hours. Flag set to `true` in stateMap.set during suppression.
