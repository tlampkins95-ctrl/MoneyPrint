---
name: FIB50_SWING swing selection
description: Swing detection must use structural points most-recent-first, not the absolute min/max. BB30 gate removed from FIB50_SWING.
---

## Rule

BUY block: iterate `findSwingLows(completed, 3, SWING_LOOKBACK)` from most-recent to oldest; pick the first swing low where the 50% fib is within `±FIB50_TOLERANCE_ATR × ATR` of current price.

SELL block: iterate `findSwingHighs(completed, 3, SWING_LOOKBACK)` from most-recent to oldest; same first-match logic.

Do NOT use an absolute `min/max` scan over the lookback window. That finds the deepest/highest extreme, which can be a much older swing that masks the relevant recent structure.

**Why:** SOL had a swing high at $87.97 (May 2026) and an older extreme at $98.36. The absolute-max scan picked $98.36 and placed the 50% fib at $79.19 — price was already at $73, the signal was missed entirely. Iterating most-recent-first correctly found $87.97 and produced entry $74.00.

## BB30 gate removed

`const bbOk = !bb30 || fib50Sell >= bb30.middle` was blocking valid SELL setups. When price trends down from a high range, the 30-day SMA is dragged above the 50% fib of the recent swing for several weeks, silently gating out valid structural trades.

**How to apply:** FIB50_SWING's own filters are sufficient: trend gate (`trend === "DOWNTREND"` for SELL), `MIN_SWING_ATR` minimum swing size, and `FIB50_TOLERANCE_ATR` price-proximity gate. Do not re-add a BB midline gate to FIB50_SWING — it is incompatible with trending markets.
