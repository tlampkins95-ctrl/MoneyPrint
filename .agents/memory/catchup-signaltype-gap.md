---
name: Catch-up block signalType gap
description: Catch-up auto-trade blocks lacked signalType gate; PATTERN_BREAKOUT (display-only) could place real orders on restart. Trending coins also needed a minimum swing size guard.
---

## The rule
Both catch-up blocks (`checkSymbol` and `checkTrendingSymbol`) must gate on `signalType` before calling `executePhemexTrade`.

Allowed for auto-trade: `FIB50_SWING`, `DOUBLE_TOP`, `DOUBLE_BOTTOM`.
NOT allowed: `PATTERN_BREAKOUT`, `BB_REJECTION` (display-only signals).

Additionally, `executePhemexTrade` rejects trending coin orders when the reward distance (|entryPrice − takeProfit1| / entryPrice) is < 5%. A sub-5% swing means the coin is ranging, not trending, and the signal is noise.

`executePhemexTrade` also accepts `candleRange { low, high }` (computed from the signal's candle dataset) and rejects trades where TP1 is outside that range — prevents PATTERN_BREAKOUT measured moves from targeting prices the coin has never traded at.

**Why:**
The live transition block (line ~649 for static, line ~990 for trending) returns early if signalType is not allowed, so the auto-trade below it is protected. But catch-up blocks are separate code paths that bypass the transition block entirely. PENGU was shorted at the literal bottom of its range because a PATTERN_BREAKOUT SELL with a ~3% reward distance survived the catch-up block and reached `executePhemexTrade`.

**How to apply:**
Any time a new catch-up block is added, it must include a `signalType` gate (`FIB50_SWING || DOUBLE_TOP || DOUBLE_BOTTOM`) before calling `executePhemexTrade`. The `MIN_REWARD_PCT = 0.05` constant lives inside `executePhemexTrade` and only applies when `trendingMeta` is present.
