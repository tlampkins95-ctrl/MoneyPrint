---
name: Redeploy duplicate order guard
description: checkExistingPosition only detects filled positions; pending unfilled limit orders on Phemex survive restart but are invisible to it, causing duplicates.
---

## The rule
`executePhemexTrade` must check BOTH:
1. `checkExistingPosition(phemexSymbol, posSide)` — detects filled positions (size > 0)
2. `checkExistingOrder(phemexSymbol, posSide)` — detects pending unfilled orders via `/g-orders/activeList`

Both register a sentinel in `openPhemexOrders` and return early. Both throw on API error (safe default: skip order).

**Why:**
After a server restart `openPhemexOrders` is wiped. If a limit entry order was placed before the restart but hasn't filled yet, `checkExistingPosition` returns null (no position yet) and the catch-up block would place a duplicate order, doubling exposure.

**How to apply:**
`checkExistingOrder` call lives in `executePhemexTrade` in notifier.ts, immediately after the `checkExistingPosition` block. Any future refactor of that function must preserve both checks in sequence.
