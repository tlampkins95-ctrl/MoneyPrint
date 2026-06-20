---
name: Same-bar re-staging cooldown
description: After any trade closes, lastClosedBarTs prevents re-staging on the same bar for ALL timeframes — was producing 68 SL hits in a single 1h bar.
---

**The problem:** After a trade closed (SL/TP/REVERSED), the next poll immediately re-staged a new trade on the same still-forming bar. This produced:
- 68 SL hits inside a single 1h bar (Jun 19 17:00 UTC)
- 400+ 1D SL hits over 2 days
- 15% win rate on 1h, 0% on 1D

**Root cause:** `computeLevelsStable` had no guard against re-staging after a close. `fresh` (with signal=BUY/SELL) was computed from the still-live bar, and with no `activeTrades` entry, it staged immediately on every poll until the bar closed.

**Fix:** `lastClosedBarTs: Map<string, number>` (in-memory, keyed by trade key). After any trade close, records `getBarOpenTs(candles)` = `Date.parse(candles[last].date)` — the bar's open timestamp in ms. At staging, if `lastClosedBarTs.get(k) >= getBarOpenTs(candles)`, staging is suppressed and `fresh` is returned without calling `activeTrades.set`. Signal stays visible as PENDING in UI but no trade is frozen until the next bar opens.

**Applies to ALL timeframes** (1h, 4h, 1d, 1w) — not just daily. Re-entering on the same bar that just stopped you out is never valid strategy regardless of timeframe.

**Which close paths record to the map:** all four —
1. `isInvalidated` (SL/TP2 via live spot check)
2. Direction flip → REVERSED
3. Candle wick scan → hitTp2
4. Candle wick scan → hitSl

**Map is in-memory only** — resets on restart. First poll after restart can stage freely, which is acceptable since restarts are rare vs the intraday loop.

**Notifier cooldown (separate):** `MIN_FLIP_COOLDOWN_MS` in `notifier.ts` throttles Telegram/Push alert frequency on direction flips. Different layer — controls notifications, not trade staging. Both coexist.
