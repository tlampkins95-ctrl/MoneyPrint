---
name: Orphaned coin polling
description: Coins that fall out of trending discovery but still have active BUY/SELL trade records are now polled each tick via a DB fallback lookup.
---

## Rule

In `tick()` (notifier.ts), after the main trending loop, call `getAllActiveTradeSymbols()` from signals.ts to get every symbol/timeframe pair with a live BUY or SELL record. For any that are NOT already in `getTrendingSymbols()` and NOT in `ALL_SYMBOLS` (static), attempt `findTrendingSymbolByKey(symbolKey)` (queries the DB for recently-expired rows, not just the live cache). If metadata is found, push `checkTrendingSymbol(symbolKey, timeframe)` into the tasks array.

**Why:** Trending coin discovery refreshes every 8 hours. Coins that were trending when a signal fired but have since fallen off the list are silently orphaned — their active trade records persist in the UI as "filled" indefinitely, catch-up auto-trading never runs for them, and the signal system never evaluates whether to re-enter or close them.

**How to apply:**
- `getAllActiveTradeSymbols()` is exported from signals.ts and iterates the in-memory `activeTrades` Map.
- `findTrendingSymbolByKey()` is exported from trending-discovery.ts and has a DB fallback for recently-expired rows — this is what makes orphaned coins findable even after their live cache entry expires.
- `checkTrendingSymbol` will return early (`if (!tMeta) return`) if metadata is truly unrecoverable, so the fallback is safe to call speculatively.
