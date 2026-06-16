---
name: DOUBLE_BOTTOM signal type
description: DOUBLE_BOTTOM pattern detection is live; adding new signalTypes requires 5 parallel changes
---

## Rule
When adding a new `signalType` value, update ALL of these in lockstep:
1. `signalType` local variable union in `computeLevels` (signals.ts)
2. `signalType?:` field in `ActiveTrade` interface (signals.ts)
3. `syncFromDb` whitelist check (signals.ts)
4. `loadActiveTradesFromDisk` whitelist check (signals.ts)
5. `RowProps.signalType` union + badge display in `active-signals-overview.tsx`

`seedActiveTrades` has NO whitelist — it trusts the caller.

## Why
Missing any of these causes: silent trade drops on restart (whitelist), TS errors (type), or wrong badge in UI.

## How to apply
`detectDoubleBottom` is already exported from patterns.ts and used in signals.ts.
Detection fires when `signal === "WAIT"` and price is within ±0.5 ATR of the avgBot support.
No daily/weekly trend gate — the double bottom IS the reversal signal.

## Also note
Stale PENDING trades with old signalType persist in DB and JSON.
`computeLevelsStable` returns existing trade data without re-detecting.
If signalType on an existing PENDING trade is wrong, must delete from both DB (`active_trades` table) AND `.runtime/active-trades.json`, then restart.
