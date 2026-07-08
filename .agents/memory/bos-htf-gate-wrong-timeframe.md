---
name: BOS daily signal must gate off daily MACD, not shared HTF variable
description: BOS_BUY/BOS_SELL are daily-only signals; do not gate them with higherTfAllowsBuy/Sell.
---

`higherTfAllowsBuy`/`higherTfAllowsSell` are shared gate variables whose meaning changes with `timeframe`:
for `1h`/`4h` they check daily MACD, but for `1d` they check WEEKLY MACD (and the daily-candle series
those checks would need isn't even fetched when timeframe is `1d`).

**Why:** BOS_BUY/BOS_SELL run only on `timeframe === "1d"` and the user's explicit spec was "daily macd
must be red for sells" (green for buys) — i.e. gate off the SAME daily candles the signal itself uses,
not weekly. Reusing the shared HTF variable silently gated BOS off weekly MACD instead, which can be
flat/ranging (ADX ~5) while the daily trend is actively reversing — letting bad signals through with no
error or warning.

**How to apply:** any new daily-only signal that needs an MACD confirmation gate should compute it
directly from that signal's own `candles`/`bosCompleted` slice (see BOS_BUY/BOS_SELL blocks in
`signals.ts`), never from `higherTfAllowsBuy`/`higherTfAllowsSell` when `timeframe === "1d"`.
