---
name: Trending notifier bootstrap — PENDING active trades block alert on restart
description: checkTrendingSymbol bootstrap was blocked by PENDING active trades loaded from JSON snapshot on restart; fix uses triggered===true to distinguish filled vs unfilled.
---

## Rule
In `checkTrendingSymbol`, the bootstrap condition that seeds `stateMap` to WAIT (so the first tick fires an alert) must only be blocked by **filled** (triggered) active trades, not PENDING ones.

**Why:**
The `active-trades.json` snapshot persists every computed signal — including ones that never triggered (limit never hit). On restart, `getActiveTrade()` returns these stale PENDING records, so `activeTradeBeforeCompute` is non-null. The old condition `!activeTradeBeforeCompute` blocked the bootstrap entirely, meaning any coin with a PENDING trade in the snapshot silently never alerted after restart, no matter how long the signal had been valid.

**How to apply:**
Use `ActiveTrade.triggered === true` as the "filled" test, not `activeTradeBeforeCompute != null`:

```typescript
const activeTradeIsFilled =
  activeTradeBeforeCompute != null && activeTradeBeforeCompute.triggered === true;
if (!stateMap.has(k) && !isSeedSnapshot && !activeTradeIsFilled && ...) {
  stateMap.set(k, { signal: "WAIT", lastAlertAt: 0 });
}
```

PENDING trades (`triggered === false/undefined`) are stale snapshots — allow bootstrap through.
Triggered trades (`triggered === true`) are real open positions — block bootstrap (restart recovery path).

**Diagnosis clue:**
If a trending coin appears in `active-trades.json` with `tradeState: undefined` (i.e. `triggered: false`) but never alerts after restart, this is the root cause. Check `notifier-alert-state.json` — the coin will be absent entirely (bootstrap never seeded it).
