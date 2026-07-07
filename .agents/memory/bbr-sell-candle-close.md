---
name: BB_REJECTION SELL — candle-close requirement
description: BB_REJECTION SELL must wait for the last completed candle to CLOSE at or above the upper BB30, not just tick near it mid-candle.
---

# BB_REJECTION SELL — candle-close + red MACD requirements

## The rule
`closedAtUpperBand = bbrCompleted[last].close >= bb30r.upper`

The old check used `Math.abs(currentPrice - bb30r.upper) <= 0.5 * atr` which fires on any live tick near the band — including mid-candle ticks that close back inside the band. This caused CHIPUSDT 1h SELL to be placed when the candle was still forming inside the BB.

`bbrSellMacd` requires `histPrev1 < 0` (red histogram). A PREVIOUS version (commit 5c4bb03, 14:47 UTC Jul 7 2026) only required declining histogram WITHOUT histPrev1 < 0 — that caused the green-MACD short on CHIP at 15:07 UTC.

## Why
- Candle must CLOSE outside the band to confirm the rejection — a wick that didn't close there is not a setup.
- MACD histogram must already be RED (negative) — "declining but still green" is not a flip, it's a pump fading. Never short on green histogram.

## How to apply
Both conditions live in the BB_REJECTION SELL block in signals.ts. If either is changed, ensure:
- `closedAtUpperBand` uses `bbrCompleted[last].close` (not currentPrice)
- `bbrSellMacd` retains `histPrev1 < 0` (not just histPrev1 < histPrev2)
