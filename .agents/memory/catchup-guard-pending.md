---
name: Catch-up externally-closed guard scope
description: The externally-closed guard in executePhemexTrade must only fire for FILLED_PROFIT, not PENDING, or all orders are blocked after restart.
---

## Rule
`if (isCatchUp && levels.tradeState === "FILLED_PROFIT")` — not `if (isCatchUp)`.

## Why
FILLED_PROFIT means a position actually existed and was subsequently closed (manually or by SL/TP). That is a genuine externally-closed scenario — do not re-enter.

PENDING means the entry limit order was stale-cancelled or never filled. There was no position. Blocking catch-up re-entry here means the system places zero orders after every restart, silently doing nothing while DB shows triggered=true signals.

## How to apply
Any time the externally-closed guard is touched, verify the condition includes `levels.tradeState === "FILLED_PROFIT"`. The PENDING path must fall through to the self-hedge check, duplicate-order check, and order placement.
