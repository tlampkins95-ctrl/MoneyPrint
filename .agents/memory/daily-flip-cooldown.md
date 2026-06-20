---
name: Daily flip cooldown
description: 1D/1W trades must not re-stage on the same live bar after closing — lastClosedBarTs map guards this in computeLevelsStable.
---

**The problem:** The 1D timeframe was producing 400+ SL hits per 2-day window. A daily trade closes (SL), the next poll immediately re-stages a new trade on the same still-forming daily candle, that trade fills, gets stopped again, repeat — all within the same calendar day.

**Root cause:** `computeLevelsStable` had no guard against re-staging after a close on a live bar. Daily candles are incomplete intraday; the signal, entry, and SL levels all shift as the live bar forms, producing setup→SL→setup→SL loops.

**Fix implemented:** `lastClosedBarTs: Map<string, number>` (in-memory, keyed by trade key) records the bar-open timestamp (ms) of the candle on which each 1D/1W trade closed. At staging time, if `lastClosedBarTs.get(k) >= getBarOpenTs(candles)`, staging is suppressed and `fresh` is returned without calling `activeTrades.set` — signal remains visible in UI as PENDING but no trade is frozen until the next bar opens.

**Which close paths record to the map:** all four — isInvalidated (SL/TP2 via live spot), REVERSED (direction flip), wick scan hitTp2, wick scan hitSl.

**Why:** `closedBarTs >= currentBarTs` — if the bar open timestamp hasn't advanced, we're still on the same forming bar.

**How to apply:** Only applies to `timeframe === "1d" || timeframe === "1w"`. The map is in-memory only — on restart it's empty and the first poll can stage freely, which is acceptable (restarts are rare vs the intraday loop problem).

**Notifier cooldown (separate, older):** `MIN_FLIP_COOLDOWN_MS` in `notifier.ts` throttles direction-flip *alerts* on 4h/1d. This is a different layer — it controls Telegram/Push notification frequency, not trade staging. Both guards coexist.
