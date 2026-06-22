---
name: FIB50_SWING validity guards
description: Two guards that prevent FIB50_SWING from firing in ranging environments or at exhausted levels.
---

## Guard 1 — Resistance/Support exhaustion (wicks)
After swingB forms, count candles that wicked within 0.5 ATR of swingB level but closed on the wrong side. If `touches >= 2`, skip to next swing pair.

**BUY:** `c.high >= swingBHigh - 0.5 * atr && c.close < swingBHigh`
**SELL:** `c.low <= swingBLow + 0.5 * atr && c.close > swingBLow`

## Guard 2 — Trend structure (higher-high / lower-low, PRIMARY)
This is the more fundamental guard. FIB50_SWING only works in trending markets. Check that swingB is a genuine new extreme relative to the swing extremes that existed BEFORE swingA.

**BUY:** `swingBHigh > max(priorSwingHighsBeforeSwingA) + 0.25 * atr` — new high confirms uptrend impulse.
**SELL:** `swingBLow < min(priorSwingLowsBeforeSwingA) - 0.25 * atr` — new low confirms downtrend impulse.

If no prior swing exists in the lookback, the guard is skipped (can't determine ranging vs trending, allow signal).

**Why:** If swingB is at the same level as a previous swing high/low, price is ranging — same ceiling/floor being tested repeatedly. There's no directional impulse and FIB50_SWING entries in this context have no edge (confirmed by DB: -141R, 1.3% WR over 180 trades). This guard was the original design intent of the strategy: trending markets only.

**Tolerance 0.25 ATR:** tight enough to block clear range-tops, loose enough to allow marginal new-high breakouts where measurement noise could cause false rejection.

**How to apply:** Both guards live in the buySearch / sellSearch loops in `computeLevelsStable`, after the fib-violation check and before the FIB50_TOLERANCE_ATR proximity check.
