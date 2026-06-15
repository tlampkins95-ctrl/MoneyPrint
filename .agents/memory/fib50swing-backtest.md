---
name: FIB50_SWING backtest parity
description: Lessons about keeping the FIB50_SWING backtest engine in sync with the live signal, and why 1D shows sparse trades.
---

## The gap pattern to watch for

When the live strategy changes (new gates, new signal type), the backtest route's dispatch chain must be updated to match. The dispatch at the bottom of backtest.ts is:

```
signalType === "FIB50_SWING" → runFib50SwingBacktest(candles, dailyCandles, tf, sym)
signalType === "BREAKOUT"    → runBreakoutBacktest(...)
signalType === "FIB_BOUNCE"  → runFibBacktest(...)
default                      → runBacktest(...)  ← PIVOT_BOUNCE
```

A missing case silently falls through to PIVOT_BOUNCE and shows completely wrong stats in the Edge Matrix. Always verify the dispatch chain after adding a new signal type.

## Daily-candle requirement for weekly trend gate

Any TF that needs the weekly SMA-30 gate but isn't "1d" must fetch a parallel "1d" candle series. This applies in three places:
1. `runFib50SwingBacktest` (backtest.ts) — fetches "1d" when timeframe === "1h"
2. `checkTrendingSymbol` (notifier.ts) — fetches "1d" when timeframe === "1h"  
3. Dynamic symbol branch in levels.ts single-symbol endpoint — fetches "1d" when timeframe === "1h"

**Why:** `computeLevelsStable` param 11 is `dailyCandlesForWeekly?`. Omitting it leaves weeklyTrend = NEUTRAL, which blocks ALL FIB50_SWING signals (NEUTRAL is fail-closed since the NEUTRAL → no-trade fix).

## 1D FIB50_SWING backtest sparsity is expected

With ~500 daily bars (2 years of data):
- First ~150 bars: NEUTRAL (weekly SMA-30 needs 30 completed weekly closes = ~30 weeks)
- Remaining ~350 bars: qualifiable
- Strategy fire-rate ≈ 0.12% (based on 1H calibration: 17 trades / 13,725 bars)
- Expected 1D trades: 350 × 0.12% ≈ 0.4 → getting 0 is statistically normal

**Why:** FIB50_SWING is high-selectivity: three gates must align simultaneously AND price must be within ±0.5 ATR of an exact fib level. On daily bars, this is rare.
