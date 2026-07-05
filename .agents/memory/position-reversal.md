---
name: Position reversal on direction flip
description: When the signal flips direction on a symbol+timeframe that already has an open Phemex position, the system now reverses rather than blocking.
---

## Rule
Same symbol+timeframe direction flip (BUY→SELL while Long open, or SELL→BUY while Short open) → REVERSE:
1. cancelExistingStopOrders (oppositeSide)
2. cancelExistingTpOrders (oppositeSide)
3. placeMarketClose (reduceOnly Market IOC, oppositeSide qty)
4. clearActiveTrade + openPhemexOrders.delete(k)
5. Fall through to open the new side normally

Cross-TF same-phemexSymbol conflict → still BLOCK (self-hedge guard unchanged).

**Why:** Coins can pump then dump. Holding a Long while a SELL fires means missing the short leg. With reversal, the system closes the loser and opens the winner in one step.

**How to apply:** Implemented in executePhemexTrade in notifier.ts, at the opposite-side position check block. isSameTfReversal = ownTrackedEntry?.posSide === oppositeSideForCheck.

**Key function:** placeMarketClose() in phemex-trader.ts — reduceOnly Market IOC, uses posSide in hedge mode.
