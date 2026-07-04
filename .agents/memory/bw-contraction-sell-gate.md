---
name: BB bandwidth contraction gate for SELL signals
description: SELL signals must require bandwidth flat or contracting. Expanding bandwidth (bw1>bw2>bw3) means the pump is accelerating — shorting into it produces losses.
---

## Rule
`bwContractingForSell`: compute BB(30,2) bandwidth for the last 3 completed bars. If all three are increasing (bw1 > bw2 > bw3), block SELL signals. Applied to FIB50_SWING, BB_REJECTION, DUMP_RECOVERY pump-fade, and BB_OVEREXTENSION SELL gates.

## Why
User strategy: "Don't short trending coins when the market is pumping." Expanding BB bandwidth = volatility increasing = pump accelerating. Mean-reversion shorts against expanding bands get stopped out as the trend continues. Bandwidth contracting (or flat) signals the pump is losing steam — the right time to enter a fade.

## How to apply
Compute `bwContractingForSell` once per symbol/TF after the `higherTfAllowsSell/Buy` block. Use `candles.slice(0,-1)` (completed bars). Falls open (true) when fewer than 33 candles. Add to every SELL gate condition.
