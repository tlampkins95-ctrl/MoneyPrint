---
name: 1h/1d higher-timeframe trend gates
description: 1h signals gate on daily EMA21/50; 1d signals gate on weekly EMA21/50. All three callers (routes/levels single, routes/levels active-signals, notifier) must pass higher-TF candles.
---

## Rules

**1h gate:** block 1h BUY when daily EMA21 < EMA50 (DOWNTREND), block 1h SELL when daily EMA21 > EMA50.  
**1d gate:** block 1d SELL when weekly EMA21 > EMA50 (UPTREND), block 1d BUY when weekly EMA21 < EMA50.  
Both gates require >= 50 bars of the higher-TF candles. Falls back to no gate if insufficient data.

**Why:** Without these gates, a 1h BUY fires against a daily DOWNTREND, or a 1d SELL fires against a weekly UPTREND — producing conflicting filled positions on the same asset (e.g. XAUUSD 1d SELL + 1w BUY both in drawdown simultaneously).

## Parameters

`computeLevels` / `computeLevelsStable` accept two optional trailing candle args:
- `dailyCandlesForWeekly?: CandleRaw[]` — daily candles for the 1h gate
- `weeklyCandlesForDaily?: CandleRaw[]` — actual weekly candles for the 1d gate

## All callers must pass the right candles

Three call sites exist. All three must be kept in sync:
1. **`/api/levels` route** — fetches daily (for 1h) or weekly (for 1d) in parallel alongside primary candles. The weekly is already in `higherTfMap.get("1w")` for 1d requests.
2. **`/api/active-signals` route (static)** — fetches daily or weekly as a 3rd element of `fetches[]`, keyed by timeframe.
3. **`notifier.ts` `checkSymbol` / `checkTrendingSymbol`** — for 1h: `rawDailyForWeekly` fetched separately. For 1d: `higherCandles` IS the weekly data, passed as `weeklyCandlesForDaily`.

If a future caller is added for 1d signals, it must also fetch and pass weekly candles or the gate silently falls back to no gate.

## Existing filled trades

The gate only prevents NEW signal generation. Existing `activeTrades` entries (FILLED_DRAWDOWN etc.) are preserved by `computeLevelsStable` regardless of what the gate says. Conflicting filled trades opened before the gate was added must close naturally via SL/TP.
