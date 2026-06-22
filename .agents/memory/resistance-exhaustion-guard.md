---
name: Resistance/Support exhaustion guard
description: FIB50_SWING invalidation when swingB level has been wicked ≥2 times without a clean break — prevents perpetual re-staging at proven resistance/support.
---

## Rule
After `swingBHighIdx` (BUY) or `swingBLowIdx` (SELL), count candles where the wick reached within 0.5 ATR of the swingB level but the close stayed on the wrong side. If `touches >= 2`, `continue` to the next swing pair — the level is exhausted as a trading catalyst.

**BUY:** `c.high >= swingBHigh - 0.5 * swingAtr && c.close < swingBHigh`
**SELL:** `c.low <= swingBLow + 0.5 * swingAtr && c.close > swingBLow`

**Why:** Price repeatedly testing a level without breaking through means the level is proven resistance/support. After 2 touches, a fib-bounce entry in the same direction has no statistical edge — each test consumes buying/selling pressure. Threshold = 2 (not 3) so the signal dies before a 3rd failed attempt, not after.

**How to apply:** The guard sits after `fibViolated` check and before the `FIB50_TOLERANCE_ATR` proximity check in both BUY and SELL search loops in `computeLevelsStable` (`signals.ts`).
