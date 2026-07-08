---
name: FIB50_SWING price-action MACD alternative
description: Why FIB50_SWING BUY/SELL momentum gates accept 2 consecutive higher/lower closes as an alternative to the MACD histogram sign-flip.
---

FIB50_SWING BUY required `macdBuyOk` (histogram already positive AND rising) and SELL required `histPrev1 < histPrev2` (declining). On a fast V-shaped bounce off the golden pocket, MACD is a lagging indicator — the histogram often doesn't confirm the reversal until several bars after price has already left the fib zone, causing the setup to be silently skipped even though a clean bounce/rejection occurred at the level.

Fix: added `twoConsecutiveHigherCloses` / `twoConsecutiveLowerCloses` (price only, no MACD) as an OR alternative alongside the existing MACD condition on both the BUY and SELL FIB50_SWING gates. Either condition alone is sufficient — this only adds coverage, it never removes a previously-valid entry.

**Why:** confirmed via real OKX candle data on UNIUSDT (2026-07-08): dump candle closed at 3.168 (golden pocket) with MACD hist -0.0032; next two candles closed higher (3.190, 3.211) while histogram was still negative; MACD didn't turn positive until price was already at 3.328, well outside the entry zone.

**How to apply:** if diagnosing another "missed" FIB50_SWING entry, check whether price gave 2 consecutive closes in the setup's favor before concluding it's a new bug — this class of miss is now handled.
