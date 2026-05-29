---
name: Daily flip cooldown
description: The 1d candle is live/incomplete intraday; direction-flip bypass produces SELL→BUY noise within minutes on Gold; MIN_FLIP_COOLDOWN_MS added per timeframe.
---

The notifier's direction-flip logic bypasses the per-direction cooldown entirely (SELL→BUY is treated as a new setup). For intraday TFs this is correct. For 4h and 1d, the current candle is incomplete during the session — a $50 Gold move intraday tips the pivot calculation from SELL → BUY zone and can produce a SELL→BUY flip within 20 minutes of the original SELL alert.

**Why:** The BUY alert firing 20 minutes after the SELL was not a genuine daily structure change — it was the live candle's close price oscillating inside the session.

**How to apply:** `MIN_FLIP_COOLDOWN_MS` constant in `notifier.ts` defines per-TF minimum between direction flips:
- 15m, 30m, 1h: 0 (no minimum — intraday flips are genuine)
- 4h: 1 hour
- 1d: 4 hours
Both `checkSymbol` and `checkTrendingSymbol` enforce this. Filled trades are always exempt.
