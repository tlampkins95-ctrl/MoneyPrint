---
name: Phemex activeList field names
description: Correct field names in /g-orders/activeList response rows for USDT-perpetuals
---

The `/g-orders/activeList` per-symbol response uses different field names than the order placement body.

| Concept | Placement body field | activeList response field |
|---|---|---|
| Order type | `ordType: "Stop"` | `orderType: "Stop"` |
| Reduce-only flag | `execInst: "ReduceOnly"` | `execInst: "ReduceOnly"` (same) |
| Position side | `posSide: "Long"/"Short"` | **Not present** |
| Order side | `side: "Buy"/"Sell"` | `side: "Buy"/"Sell"` |
| Order ID | — | `orderID` |

**Deriving posSide from order rows:**
- `side === "Buy"` → closes a Short position → `posSide = "Short"`
- `side === "Sell"` → closes a Long position → `posSide = "Long"`

**Why:** The cancel endpoint (`DELETE /g-orders/cancel`) requires `posSide` as a query param in hedge mode; without it you get error 10500. Since activeList rows have no `posSide`, you must derive it from `side`.

**How to apply:** Any code that filters or cancels stop orders from activeList must use `o.orderType` and `o.execInst`, and must compute `posSide` as `o.side === "Buy" ? "Short" : "Long"`.
