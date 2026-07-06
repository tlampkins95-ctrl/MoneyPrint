---
name: DUMP_RECOVERY SELL — 2-bar MACD confirmation
description: drSellMacd gate tightened from 1 bar to 2 consecutive bars of decline from positive
---

## Rule
DUMP_RECOVERY SELL requires 2 consecutive completed bars of declining positive MACD histogram before firing: `histPrev3 > histPrev2 > histPrev1`, all > 0.

**Why:** A single-bar dip (e.g. METUSDT 0.0032→0.0017 while up 8.85% on the day) is MACD noise on a coin still actively pumping. Two confirmed declining bars establishes genuine exhaustion before entering a short.

**How to apply:** Never revert to 1-bar `drSellMacd = histPrev1 < histPrev2 && histPrev2 > 0`. This pattern caused a losing METUSDT short that entered during a continued pump.
