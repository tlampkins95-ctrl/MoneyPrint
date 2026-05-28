---
name: 4h timeframe data routing
description: How 4h candles are sourced — three-way routing by symbol type; metals not on Twelve Data free tier
---

## Rule
4h candle routing in `doFetch` (yahoo-fetch.ts) follows this priority:
1. **OKX perp** (`okxPerp` field set) → OKX via `PERP_TIMEFRAME_MAP["4h"]` (bar: "4H")
2. **Gate.io spot** (`gateioSpot` field set) → Gate.io (interval "4h" supported)
3. **Twelve Data** (`twelveData` field set) → `fetchTwelveDataCandles()` — for forex: EUR/USD, GBP/USD, AUD/USD, USD/CHF
4. **Yahoo 1h aggregation** (fallback) → `aggregate1hTo4h(fetchCandlesForTimeframe(symbol, "1h"))` — for metals: XAG/USD, XAU/USD

## Why
Twelve Data's free tier (800 credits/day) covers forex pairs but **not** precious metals (XAG/USD, XAU/USD) — those require the Grow/Venture paid plan. Yahoo Finance provides 1h bars freely for SI=F and GC=F; grouping 4×1h into one 4h UTC block is accurate enough.

## How to apply
- New forex symbol → add `twelveData: "SYM/USD"` to SymbolMeta in symbols.ts
- New metal/commodity → leave `twelveData` unset; fallback aggregation kicks in automatically
- New crypto → set `okxPerp`; OKX handles all timeframes including 4h natively
- Twelve Data datetime format is `"2026-05-29 03:00:00"` UTC → convert with `.replace(" ", "T") + "Z"`
- Do NOT use `encodeURIComponent()` on the Twelve Data symbol string in the URL — the API rejects `%2F` for the slash in "EUR/USD"
