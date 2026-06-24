---
name: XAGUSDT Phemex minPriceRp constraint
description: Phemex XAGUSDT perpetual contract rejects all orders with code 39999 when silver price is below $100
---

## The constraint

From Phemex public products API (`/public/products` → `perpProductsV2`):
```json
{ "symbol": "XAGUSDT", "minPriceRp": "100.0", "tickSize": "0.01" }
```

`minPriceRp` is the minimum allowed order price. Silver at ~$61 (June 2026) means every limit order at entry price is rejected — Phemex returns code 39999 "Error in place order" with no further detail.

## Why this matters

Code 39999 is a generic catch-all. Without reading the contract spec from the products API, the root cause is invisible from logs alone. Every debugging attempt at the order body (removing slOrdPxRp, tpOrdPxRp, triggerType) failed because the actual rejection reason was the entry price floor.

## How to apply

Before adding/debugging a Phemex auto-trade symbol: fetch `/public/products` and check `minPriceRp` against the current market price. If price < minPriceRp, orders will never go through regardless of order body format. XAGUSDT will remain untradeable until silver exceeds $100.

To check programmatically:
```bash
curl -s "https://api.phemex.com/public/products" | python3 -c "
import json,sys; v2=json.load(sys.stdin)['data']['perpProductsV2']
p=next((x for x in v2 if x['symbol']=='XAGUSDT'),None)
print(p.get('minPriceRp'), p.get('tickSize'), p.get('qtyStepSize'))
"
```
