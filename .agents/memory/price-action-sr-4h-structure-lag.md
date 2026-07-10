---
name: PRICE_ACTION_SR 4H structure confirmation lag
description: Why detectMarketStructure can return null/WAIT even when price has clearly broken out on the chart (e.g. above 20 EMA)
---

`detectMarketStructure` (price-action-sr.ts) classifies 4H bias purely from swing
highs/lows (fractal, strength=2 → needs 2 candles on each side to confirm a swing
point). This means the most recent confirmed swing high/low always lags the live
candle by at least 2 bars (8h on the 4H TF).

During a strong, fresh breakout, the last *confirmed* swing high can still be a
lower-high (from before the pump) while the last confirmed swing low is also
still a lower-low — giving a "mixed" (null → WAIT, logged as "no clear 4H market
structure") result, even though price has already broken cleanly above the 20
EMA / prior resistance on the visible chart.

**Why:** avoids repainting/false swings from an unconfirmed, still-forming pivot.

**How to apply:** this is expected, conservative behavior, not a bug — confirmed
via live debug logging on OPNUSDT (2026-07-10): swing highs/lows both still
classified as "down" step while price had already broken out; structure flips
to "up" ~2 candles after the breakout confirms. If the user wants faster
reaction, the fix is an explicit EMA20/EMA200-based override or relaxation at
the 4H tier — do not silently add this; confirm with the user first since
PRICE_ACTION_SR feeds live notifications (see price-action-sr-signal.md for the
overall architecture and the auto-trader allowlist invariant that must never
include PRICE_ACTION_SR).
