---
name: Production startup race condition — active trades wiped on restart
description: syncFromDb was fire-and-forget; notifier started before DB loaded, causing cleanup DELETE to wipe all production:: rows on every restart.
---

## Rule
`syncFromDb` must be **awaited before** `startSignalNotifier()` starts. The notifier's first poll can seed new trades and call `persistActiveTrades()` — which runs a cleanup DELETE that removes all `production::` rows not in the current in-memory snapshot. If `syncFromDb` hasn't finished, those rows aren't in memory yet and get deleted.

## Why
- `.runtime/active-trades.json` is gitignored — never deployed to production
- On every restart, `loadActiveTradesFromDisk()` returns empty (no file)
- `syncFromDb` was fired with `void` (fire-and-forget) at module load
- `startSignalNotifier()` ran immediately after `app.listen()`
- First notifier poll fired before `syncFromDb` completed → seeded 1–2 new trades → `persistActiveTrades()` deleted all other `production::` rows

## How to apply
`index.ts`: inside `app.listen()` callback, `await syncFromDb()` BEFORE calling `startSignalNotifier()` or `startTrendingDiscovery()`. Already fixed as of this session — do not revert to `void syncFromDb()` at module load.

## Consequence of the bug
Every redeploy reset all active trade entry prices to current market prices, destroying accumulated unrealized P&L. The user lost a $90+ unrealized P&L position.
