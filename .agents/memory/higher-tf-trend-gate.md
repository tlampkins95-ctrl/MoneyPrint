---
name: Higher-TF trend gate
description: How higherTfAllowsSell and higherTfAllowsBuy work — uses daily MACD histogram, not EMAs.
---

## Rule
`higherTfAllowsSell` and `higherTfAllowsBuy` gate all non-reversal signal types using the MACD histogram on the higher timeframe — NOT EMA crossovers.

- **1h signals**: reads the last completed bar of the daily MACD histogram (`dailyCandlesForWeekly`)
- **1d signals**: reads the last completed bar of the weekly MACD histogram (`weeklyCandlesForDaily`)

`higherTfAllowsSell = false` when histogram > 0 (daily MACD green = bullish trend = no shorts).  
`higherTfAllowsBuy = false` when histogram < 0 (daily MACD red = bearish trend = no momentum longs).

Falls back to `true` when fewer than 35 candles are available (MACD not warm).

## Which signals are gated
All SELL paths: FIB50_SWING (`weeklyAllowsSell`), DOUBLE_TOP, BB_REJECTION, PATTERN_BREAKOUT, Candlestick.  
BUY paths gated: PATTERN_BREAKOUT, Candlestick (momentum signals only).  
BUY paths NOT gated: DOUBLE_BOTTOM, BB_REJECTION BUY — these are reversal signals designed to fire against the trend.

## Why
User's strategy is Bollinger Bands + MACD only. No EMAs are part of the strategy. Using EMA21/50 crossover as a gate was adding a foreign indicator and misread bullish GRASS daily as bearish (EMA21 < EMA50 lagged), causing losing shorts into green MACD.

## DOUBLE_TOP additional gate
`DOUBLE_TOP` also requires `dtResult.confirmed === true`. Forming patterns (neckline not broken) are never traded.
