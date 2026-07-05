---
name: Market IOC BUY re-anchor
description: When signal entry < minPriceRp for a BUY, the limit is clamped to minPriceRp and fills at market — TPs and SL must be re-anchored to currentPrice to preserve designed R:R.
---

## Rule

Phemex has a per-symbol `minPriceRp` floor (e.g. LITUSDT = $10). When a signal's entry price is below this floor, `placeOrder` clamps the limit price to `minPriceRp`, causing immediate market fill at the current ask.

The signal's SL and TPs were calculated relative to the original signal entry (e.g. a fib support at $2.17). If the actual fill is at $2.41, those targets are completely wrong — TP1 might be only 3% away while SL is 19% away, giving near-zero R:R.

**Fix:** mirror the SELL re-anchor logic for BUY:
```
risk    = entryPrice - stopLoss          // positive for BUY
reward  = takeProfit1 - entryPrice
reward2 = takeProfit2 - entryPrice
ref     = levels.currentPrice

effectiveSL  = ref - risk
effectiveTP  = ref + reward
effectiveTP2 = ref + reward2
```

**Why:** Preserves the designed risk-reward ratio (e.g. 1.5:1, 2.5:1) from the actual fill price instead of from the stale signal entry. Without this, every market-fill BUY has its TPs nearly unreachable and its SL far too wide.

**How to apply:** `isMarketIocBuy = side === "Buy" && minPx > 0 && levels.entryPrice < minPx` in `executePhemexTrade` in notifier.ts, before `setSymbolLeverage`. The SELL path (`isMarketIocSell`) already existed; BUY was missing.
