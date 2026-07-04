---
name: FIB50_SWING steals BB_REJECTION slot at upper band
description: When 50% fib ≈ upper BB, FIB50_SWING (runs first in cascade) wins the signal slot, labels it FIB50_SWING, and the catch-up guard allows re-entry — but it should be BB_REJECTION (no re-entry).
---

## Rule
`fibSellBbOk` in FIB50_SWING SELL must cap at `pctB30 < 0.85`. Price within the top 15% of the BB range (near upper band) belongs exclusively to BB_REJECTION. FIB50_SWING handles mid-range fib setups only.

## Why
BB_REJECTION is correctly excluded from catch-up re-entry (non-zone-based, price-pinned signal). FIB50_SWING is zone-based and catch-up is allowed. When both fire simultaneously (50% fib ≈ upper BB), FIB50_SWING wins the cascade (runs first), the signal gets stored as FIB50_SWING, the catch-up guard sees FIB50_SWING and proceeds — placing an order at the wrong price after a restart instead of skipping.

## How to apply
In `fibSellBbOk`: change `pctB30 <= 1.0` to `pctB30 < 0.85`. This reserve pctB30 ∈ [0.85, 1.0] for BB_REJECTION. Do the same for FIB50_SWING BUY if a symmetric `pctB30 > 0.15` guard is needed (lower band zone reserved for BB_REJECTION BUY).
