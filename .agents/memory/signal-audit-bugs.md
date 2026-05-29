---
name: Signal audit — bugs found and fixed
description: Four bugs found during full code audit of signals.ts / notifier.ts; three were active signal-quality issues.
---

## Bug 1 — sellAllowed included ema200SellOk + macdSellOk (CRITICAL)

**Rule:** PIVOT_BOUNCE SELL gate must NOT include ema200SellOk or macdSellOk.

**Why:** The explicit design comment said both were excluded, but the code included them. When price pumps into the sell zone, close is almost always ABOVE EMA200 (the pump is why), so ema200SellOk=false killed every mean-reversion short at resistance. At genuine tops, MACD histogram is still rising — macdSellOk=false added 1-2 bars of lag past best price. Both gates are correct for BREAKOUT/TREND_BOUNCE (momentum) but wrong for PIVOT_BOUNCE (mean-reversion fade).

**How to apply:** In `sellAllowed`, only use: RSI ≥ RSI_OVERBOUGHT + !isLongOnly + trend ≠ UPTREND + strongCloseBearish + zoneTestedSell + bbSellOk. Never add ema200SellOk or macdSellOk to PIVOT_BOUNCE SELL.

## Bug 2 — checkTrendingSymbol missing alreadyInSameDirection guard

**Rule:** `checkTrendingSymbol` must read `getActiveTrade` BEFORE `computeLevelsStable` and apply the same `alreadyInSameDirection` dedup guard as `checkSymbol`.

**Why:** When a trending coin BUY→WAIT→BUY oscillates while the original trade is open, the second BUY would re-alert a duplicate entry. checkSymbol had this guard; checkTrendingSymbol did not.

**How to apply:** Both check functions must snapshot `activeTradeBeforeCompute = getActiveTrade(...)` before the compute call, then gate on `!alreadyInSameDirection`.

## Bug 3 — signalType whitelists missing FIB_BREAK and FIB_BOUNCE

**Rule:** All three signalType validation whitelists (loadActiveTradesFromDisk, syncFromDb, seedActiveTrades) must include "FIB_BREAK" and "FIB_BOUNCE".

**Why:** A trade with signalType "FIB_BREAK" would be silently relabeled "PIVOT_BOUNCE" on server restart. The notifier allows FIB_BREAK but not PIVOT_BOUNCE — so the relabeled trade would be suppressed.

**How to apply:** Whenever a new signalType is added to the enum in computeLevels, add it to all three whitelist checks in parallel.

## Bug 4 — RowProps.signalType union stale (minor)

RowProps in active-signals-overview.tsx was missing TREND_BOUNCE, EMA_CROSS, FIB_BOUNCE. Fixed to match the full server enum.
