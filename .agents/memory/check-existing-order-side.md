---
name: checkExistingOrder side field mismatch
description: Phemex /g-orders/activeList returns side="Buy"/"Sell" not "Long"/"Short"; old code compared directly and always returned null, so the duplicate-entry guard never worked.
---

## Rule
In `checkExistingOrder` (phemex-trader.ts), derive the position side from the `side` field before comparing:

```typescript
const derivedSide = o.posSide ?? (o.side === "Buy" ? "Long" : "Short");
return ... && derivedSide === posSide && ...
```

**Why:**
Phemex's `/g-orders/activeList` endpoint (hedge mode) does NOT include a `posSide` field. The code previously did `(o.posSide ?? o.side) === posSide`, which compared `"Sell"` against `"Short"` — always false. The function always returned null, meaning the duplicate-entry guard (which calls `checkExistingOrder` before placing a new limit) never actually blocked anything.

This caused a real production incident: the TP retry logic cleared the `openPhemexOrders` tracker when TPs failed (TE_REDUCE_ONLY_ABORT on unfilled limit), the catch-up fired again, `checkExistingOrder` returned null, and a second limit order was placed on top of the first → 2× position size → 4% risk instead of 2%.

**How to apply:**
Any code that reads from `/g-orders/activeList` and needs to derive a Long/Short side must map `side: "Buy"→"Long"` and `side: "Sell"→"Short"` explicitly. Do not rely on `posSide` being present in that endpoint's response.
