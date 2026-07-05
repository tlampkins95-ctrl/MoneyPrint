---
name: phemexOrderPlaced flag
description: ActiveTrade.phemexOrderPlaced distinguishes "was on Phemex" from "signal-tracking only"; governs externally-closed guard behavior on restart.
---

## Rule

`ActiveTrade.phemexOrderPlaced?: boolean` is stamped `true` by `setPhemexOrderPlaced()` (called from `notifier.ts`) immediately after a Phemex entry order is confirmed and tracked in `openPhemexOrders`.

Records **without** this flag (loaded from `.runtime/active-trades.json` before auto-trading was enabled, or from sessions where no order was placed) were **never on Phemex**. For those records, the externally-closed guard in `executePhemexTrade` must NOT fire — the guard clears the stale record and falls through to place a fresh order.

Records **with** `phemexOrderPlaced=true` went through the full order-placement path. If the position is gone on restart with no Phemex position found, the stale/isNewSetup thresholds decide whether to treat it as externally-closed or re-enter.

**Why:** Before this flag existed, `triggered=true` on an active trade record only meant "price entered the signal zone" — not that an actual Phemex order was placed. The externally-closed guard was blocking re-entry for every pure signal-tracking record after restart, because it couldn't tell the difference.

**How to apply:** 
- `setPhemexOrderPlaced(symbol, timeframe)` is called once per successful order, right after `openPhemexOrders.set(k, { orderId, ... })`.
- In the guard: `if (!existingActiveTrade.phemexOrderPlaced)` → clear record, fall through. `if (phemexOrderPlaced)` → apply stale/isNewSetup check as before.
