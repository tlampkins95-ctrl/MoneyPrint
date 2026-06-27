---
name: User strategy indicators
description: What indicators the user's strategy actually uses — critical constraint for any signal logic work.
---

## Rule
The user's trading strategy uses **Bollinger Bands** and **MACD** only.

**Never add EMA crossovers** (EMA21, EMA50, EMA200, etc.) as gates, filters, or trend checks. The user has explicitly stated EMAs are not part of their strategy and was frustrated when EMA-based gates were silently added.

## Why
EMA-based trend gates were added as "higher-TF trend alignment" without being asked. They used EMA21/EMA50 crossover, which the user never mentioned. The user noticed after a losing trade and said "I never built EMAs in my strategy. I only use bollinger bands."

## How to apply
- For any "is the trend bullish/bearish?" check on a higher timeframe: use the MACD histogram (`calcMACDHist`).
  - Positive histogram = bullish (green MACD).
  - Negative histogram = bearish (red MACD).
- For mean-reversion zone checks: use Bollinger Bands (`calcBollingerBands`).
- Do not introduce EMA-based filters even if the user asks for "trend confirmation" — ask which indicator they want to use.
