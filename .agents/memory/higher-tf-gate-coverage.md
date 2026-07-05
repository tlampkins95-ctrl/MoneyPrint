---
name: Higher-TF gate coverage — all signal paths
description: Every SELL and BUY assignment in signals.ts now requires higherTfAllowsSell/Buy; which were missing and how to verify.
---

## Rule
Every `signal = "SELL"` assignment must be inside a condition that includes `higherTfAllowsSell`.
Every `signal = "BUY"` assignment must be inside a condition that includes `higherTfAllowsBuy`.

**Why:** Without the gate, signals fire against the higher-TF trend (e.g. shorting while daily MACD is green), producing a 65-86% SL rate. Real Phemex data confirmed ZEC was shorted 4+ times while daily MACD was positive, causing the majority of losses.

## Complete verified map (as of this session)
SELL assignments (6):
- Line ~1835: FIB50_SWING SELL — `weeklyAllowsSell && higherTfAllowsSell`
- Line ~1878: DOUBLE_TOP — `!isLongOnly && higherTfAllowsSell` ← was MISSING, added
- Line ~1997: BB_REJECTION SELL — `higherTfAllowsSell` ← already present
- Line ~2133: BB_OVEREXTENSION — `macdWarm && higherTfAllowsSell` ← was bypassed, added
- Line ~2186: PATTERN_BREAKOUT chart — `!isLongOnly && higherTfAllowsSell` ← already present
- Line ~2211: PATTERN_BREAKOUT candlestick — `higherTfAllowsSell` ← already present

BUY assignments (5):
- Line ~1703: FIB50_SWING BUY — `weeklyAllowsBuy && higherTfAllowsBuy` ← was MISSING, added
- Line ~1902: DOUBLE_BOTTOM — `higherTfAllowsBuy` ← already present
- Line ~2024: BB_REJECTION BUY — `higherTfAllowsBuy` ← already present
- Line ~2169: PATTERN_BREAKOUT chart — `higherTfAllowsBuy` ← already present
- Line ~2231: PATTERN_BREAKOUT candlestick — `higherTfAllowsBuy` ← already present

## How to verify after any future signal change
```bash
grep -n 'signal\s*=\s*"SELL"' artifacts/api-server/src/lib/signals.ts
grep -n 'signal\s*=\s*"BUY"'  artifacts/api-server/src/lib/signals.ts
```
For each line, read ~20 lines of context above and confirm `higherTfAllowsSell/Buy` appears in the enclosing `if`.

## higherTfAllowsSell/Buy definition
Declared BEFORE the FIB50_SWING block (TS2448 fires if declared after):
- 1h SELL: `dHist[dHist.length-2] <= 0` (last completed daily MACD bar ≤ 0)
- 1d SELL: `wHist[wHist.length-2] <= 0` (last completed weekly MACD bar ≤ 0)
- 1h BUY: `dHist[dHist.length-2] >= 0`
- 1d BUY: `wHist[wHist.length-2] >= 0`

## HIGHER_TIMEFRAME chain (notifier.ts)
`1h → 4h → 1d → 1w`
Changed from `1h → 1d` to `1h → 4h` so a 1h BUY is suppressed when 4h
is actively SELL (and vice versa). Daily candles still fetched separately
via `needDailyForWeekly` for the internal MACD gate — unaffected.
