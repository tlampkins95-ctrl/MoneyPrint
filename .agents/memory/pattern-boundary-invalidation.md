---
name: Pattern boundary invalidation
description: Flag/pennant/wedge patterns must be voided when price escapes the wrong boundary — not just when they confirm the right way
---

## Rule
Continuation patterns (bear/bull flag, bear/bull pennant, rising/falling wedge) must be invalidated — return null or `continue` — when price has escaped through the boundary opposite to the pattern's expected breakout direction.

**Why:** The old code only set `confirmed: true` when price broke the RIGHT way, but still returned the pattern as `confirmed: false` ("Forming") even when price had already broken the WRONG way and escaped. This caused "BEAR PENNANT Forming" labels on charts where price was clearly above the upper trendline.

## How to apply
For every continuation pattern, add two invalidation guards before returning:

1. **Last completed bar (n-2):** if it closed past the wrong boundary (e.g. bear pennant but `lastClose > maxH`), skip with `continue` (inside a loop) or `return null`.
2. **Live bar (n-1):** if its close is past the extrapolated trendline in the wrong direction, skip.

### Flag/pennant (detectFlagOrPennant)
```ts
// Bear pole → pattern invalid if last bar broke ABOVE channel
if (isBearPole && lastClose > maxH) continue;
if (isBearPole && liveClose > topAtLive) continue;
// Bull pole → pattern invalid if last bar broke BELOW channel
if (isBullPole && lastClose < minL) continue;
if (isBullPole && liveClose < botAtLive) continue;
```

### Wedge (detectWedgeOrTriangle)
```ts
// Rising wedge (bearish) — invalid if live bar above upper rail
if (candles[n - 1].close > evalT(n - 1)) return null;
// Falling wedge (bullish) — invalid if live bar below lower rail
if (candles[n - 1].close < evalB(n - 1)) return null;
```

## Index math for flag/pennant
- `consolSlice` has indices `0…consolLen-1`
- Bar n-2 (lastClose) is at regression index `consolLen`
- Bar n-1 (live) is at regression index `consolLen + 1`
- `topAtLive = topReg.intercept + topReg.slope * (consolLen + 1)`
- `botAtLive = botReg.intercept + botReg.slope * (consolLen + 1)`
