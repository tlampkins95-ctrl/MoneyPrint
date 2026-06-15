---
name: Duplicate seed alerts on restart
description: Why identical alerts fire multiple times in a session and how the persistence fix works.
---

## The bug

`stateMap` in `notifier.ts` is purely in-memory. On every server restart it is wiped. The seed logic fires for any still-pending BUY/SELL signal on the very first post-restart poll (`isSeedSnapshot = !prev && ALERT_SEED_TIMEFRAMES.has(tf) && signal ∈ {BUY,SELL} && tradeState ∈ {WAIT,PENDING}`). Three server crashes within 20 minutes produced three identical "SELL FIB50 EUR/USD 1H" notifications at the same entry price.

## The fix

`persistAlertEntry(k, signal, lastAlertAt)` — writes to `.runtime/notifier-alert-state.json` immediately after every alert dispatch (both `checkSymbol` and `checkTrendingSymbol` paths).

`loadPersistedAlertState()` — called in `startSignalNotifier()` before the first `tick()`. Pre-populates `stateMap` with `{signal, lastAlertAt, lastAlertSignal}` from the file. The existing direction-aware cooldown (3h for 1H) then blocks re-alerts across restarts.

`persistAlertEntry(k, "WAIT", 0)` — called in the `onTradeClosed` TP2/BE_TRAIL path to remove the key, ensuring a genuine new signal after a positive close is never blocked by a stale persisted entry.

**Why:** The cooldown (`now - prev.lastAlertAt < effectiveCooldownMs && prev.lastAlertSignal === levels.signal`) is correct logic but depends entirely on `prev` being non-null. Without persistence, `prev` is always null on restart, so the cooldown never fires for seed transitions.

**How to apply:** Any future in-memory guard (e.g. `gateBlockedSince`, `consecutiveSls`) that should survive restarts must be either (a) added to `PersistedAlertEntry` and the load/persist helpers, or (b) re-derived from durable sources (active trades file, DB) on startup.
